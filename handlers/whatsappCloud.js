const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { compressImage, extractTextFromPDF } = require('../utils/imageProcessor');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { isPremium, checkTypeQuota, incrementTypeQuota, getAllRemaining } = require('../services/quotaManager');
const { createPaymentLink, PACKAGES } = require('../services/midtrans');
const axios = require('axios');
const logger = require('../utils/logger');

const WA_API_URL = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

function verifyWebhook(req, res) {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
}

async function handleWebhook(req, res) {
    try {
        const body = req.body;
        if (!body.object || !body.entry) return res.sendStatus(400);
        for (const entry of body.entry) {
            for (const change of entry.changes || []) {
                if (change.field !== 'messages') continue;
                for (const msg of (change.value || {}).messages || []) await processIncomingMessage(msg);
            }
        }
        return res.sendStatus(200);
    } catch (error) {
        logger.error('WA webhook error:', error);
        return res.sendStatus(500);
    }
}

async function processIncomingMessage(msg) {
    const from = msg.from;
    const userId = `whatsapp:${from}`;
    let session = await getSession(userId);
    let user = await getUser(userId);

    if (msg.type === 'text') {
        const text = (msg.text?.body || '').trim();
        if (!user || !session?.level) {
            if (!session) session = { level: null, subLevel: null, history: [] };
            if (['1','2','3','4','5'].includes(text)) {
                let level, subLevel;
                if (text==='1') { level='sd-smp'; subLevel='sd-1-3'; }
                else if (text==='2') { level='sd-smp'; subLevel='sd-4-6'; }
                else if (text==='3') { level='sd-smp'; subLevel='smp'; }
                else if (text==='4') { level='sma-smk'; subLevel='sma'; }
                else { level='sma-smk'; subLevel='smk'; }
                if (!user) await createUser(userId,'whatsapp',level,subLevel);
                else await updateUserLevel(userId,level,subLevel);
                session = { level, subLevel, history: [] };
                await saveSession(userId, session);
                return sendText(from, `✅ Siap! Kamu terdaftar sebagai siswa ${getWAlevel(level,subLevel)}.\nSekarang, tanya apa saja ya! 😊`);
            }
            return sendText(from, `👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\nBalas dengan *angka* pilihanmu ya.`);
        }

        if (text === 'ganti level') {
            session.level = null; session.subLevel = null;
            await saveSession(userId, session);
            return sendText(from, `🔁 Pilih jenjang baru:\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK`);
        }
        if (text === 'upgrade') {
            const premium = await isPremium(userId);
            if (premium) return sendText(from, '✨ Kamu sudah member Premium!');
            return sendText(from, `🚀 Upgrade Yenni Premium\nMingguan Rp12.000 / 7 hari\nBulanan Rp35.000 / 30 hari\nBalas "bayar mingguan" atau "bayar bulanan"`);
        }
        if (text.startsWith('bayar')) {
            const pkg = text.includes('mingguan') ? 'weekly' : 'monthly';
            try {
                const invoice = await createPaymentLink(userId, pkg);
                return sendText(from,
                    `💳 Pembayaran Yenni Premium (${PACKAGES[pkg].name})\n\n` +
                    `Klik link untuk membayar:\n${invoice.payment_link_url}\n\n` +
                    `QRIS dan semua metode pembayaran tersedia.\n` +
                    `Premium aktif otomatis setelah pembayaran.`
                );
            } catch (e) { return sendText(from, '😔 Gangguan pembayaran. Coba lagi nanti.'); }
        }
        if (text === 'status') {
            const premium = await isPremium(userId);
            if (premium) return sendText(from, '✨ Member Premium! Unlimited.');
            const r = await getAllRemaining(userId);
            return sendText(from, `📊 Kuota hari ini:\n- Teks: ${r.text}/10\n- Gambar: ${r.image}/3\n- Voice: ${r.voice}/5`);
        }

        try {
            const result = await processMessage(userId, text, session, 'whatsapp');
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA process error:', error);
            await sendText(from, '😔 Maaf, ada gangguan. Coba lagi ya.');
        }
    }
    else if (msg.type === 'image') {
        try {
            const imageId = (msg.image || {}).id;
            const caption = (msg.image || {}).caption || 'Jelaskan gambar ini.';
            const imageUrl = await getMediaUrl(imageId);
            const imageBuffer = await downloadFile(imageUrl);
            let compressed; try { compressed = await compressImage(imageBuffer,{maxWidth:1024,quality:80}); } catch { compressed = imageBuffer; }
            const extractedText = await extractTextFromImage(compressed);
            const result = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', compressed);
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA image error:', error);
            await sendText(from, '😔 Gambar tidak bisa diproses.');
        }
    }
    else if (msg.type === 'audio' || msg.type === 'voice') {
        const voiceQuota = await checkTypeQuota(userId, 'voice');
        if (!voiceQuota.allowed && !voiceQuota.isPremium) {
            return sendText(from, '🎤 Kuota voice note sudah habis hari ini! Upgrade ke Premium biar unlimited.');
        }
        try {
            const audioId = (msg.audio || msg.voice || {}).id;
            const audioUrl = await getMediaUrl(audioId);
            const resp = await axios.get(audioUrl,{responseType:'arraybuffer'});
            const audioBuffer = Buffer.from(resp.data);
            await sendText(from, '🎤 Yenni dengerin suara Kakak...');
            const transcribed = await transcribeAudio(audioBuffer,'audio/ogg');
            if (!transcribed) return sendText(from, '🎤 Maaf, tidak bisa mendengar.');
            await sendText(from, `📝 Yenni dengar: "${transcribed}"`);
            await incrementTypeQuota(userId, 'voice');
            const result = await processMessage(userId, transcribed, session, 'whatsapp');
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA voice error:', error);
            await sendText(from, '🎤 Suara tidak bisa diproses.');
        }
    }
    else if (msg.type === 'document') {
        try {
            const doc = msg.document || {};
            if (!(doc.filename||'').toLowerCase().endsWith('.pdf')) return sendText(from, '📎 Yenni hanya bisa baca PDF.');
            const docUrl = await getMediaUrl(doc.id);
            const docBuffer = await downloadFile(docUrl);
            let pdfText; try { pdfText = await extractTextFromPDF(docBuffer); } catch { return sendText(from, 'Gagal membaca PDF.'); }
            if (!pdfText) return sendText(from, '📄 PDF ini hasil scan. Kirim fotonya sebagai gambar ya.');
            const result = await processMessage(userId, `[PDF_TEXT]${doc.caption||'Jelaskan isi PDF ini.'}\n${pdfText}`, session, 'whatsapp');
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA doc error:', error);
            await sendText(from, '😔 Dokumen tidak bisa diproses.');
        }
    }
}

async function sendText(to, text) {
    try {
        await axios.post(WA_API_URL, {
            messaging_product: 'whatsapp', to, type: 'text',
            text: { body: text, preview_url: false }
        }, { headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) { logger.error('WA sendText error:', error.response?.data || error.message); }
}

async function sendImage(to, url) {
    try {
        await axios.post(WA_API_URL, {
            messaging_product: 'whatsapp', to, type: 'image',
            image: { link: url, caption: '📊 Visualisasi' }
        }, { headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) { logger.error('WA sendImage error:', error.response?.data || error.message); }
}

async function sendLongTextWA(to, text, images) {
    if (text.length > 1500) {
        for (const chunk of splitWA(text, 1500)) await sendText(to, chunk);
    } else await sendText(to, text);
    for (const url of images) { try { await sendImage(to, url); } catch (e) {} }
}

async function getMediaUrl(mediaId) {
    const resp = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}` }
    });
    return resp.data.url;
}

function splitWA(text, max) {
    const chunks = []; let cur = '';
    for (const w of text.split(' ')) {
        if ((cur + ' ' + w).length > max) { chunks.push(cur.trim()); cur = w; }
        else cur += (cur ? ' ' : '') + w;
    }
    if (cur) chunks.push(cur.trim());
    return chunks;
}

function getWAlevel(level, subLevel) {
    const map = { 'sd-1-3':'SD Kelas 1-3','sd-4-6':'SD Kelas 4-6','smp':'SMP','sma':'SMA','smk':'SMK' };
    return map[subLevel] || level;
}

module.exports = { verifyWebhook, handleWebhook };
