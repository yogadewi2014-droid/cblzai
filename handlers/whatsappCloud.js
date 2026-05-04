const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { compressImage, extractTextFromPDF } = require('../utils/imageProcessor');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { getUserTier, consumeQuota, getAllRemaining } = require('../services/quotaManager');
const { createPaymentLink, PACKAGES } = require('../services/midtrans');
const { logActivity } = require('../services/crmService');  // ✅ CRM
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

    // --- Pesan Teks ---
    if (msg.type === 'text') {
        const text = (msg.text?.body || '').trim();

        // 0. State upgrade_pending: menunggu pilihan 1/2
        if (session?.upgrade_pending) {
            const choice = text;
            if (choice === '1' || choice === '2') {
                let pkg;
                if (session.upgrade_from === 'go' && choice === '2') pkg = 'pro';
                else if (choice === '1') pkg = 'go';
                else pkg = 'pro';
                delete session.upgrade_pending;
                delete session.upgrade_from;
                await saveSession(userId, session);
                await logActivity(userId, 'payment_start', { package: pkg });  // ✅
                return await handlePaymentWA(from, userId, pkg);
            } else if (text.startsWith('/') || text === 'status' || text === 'ganti level' || text === 'upgrade') {
                delete session.upgrade_pending;
                delete session.upgrade_from;
                await saveSession(userId, session);
            } else {
                return sendText(from, 'Silakan pilih 1 untuk GO atau 2 untuk PRO.');
            }
        }

        // 1. Onboarding
        if (!user || !session?.level) {
            if (!session) session = { level: null, subLevel: null, history: [] };
            if (['1','2','3','4','5'].includes(text)) {
                let level, subLevel;
                if (text === '1') { level = 'sd-smp'; subLevel = 'sd-1-3'; }
                else if (text === '2') { level = 'sd-smp'; subLevel = 'sd-4-6'; }
                else if (text === '3') { level = 'sd-smp'; subLevel = 'smp'; }
                else if (text === '4') { level = 'sma-smk'; subLevel = 'sma'; }
                else if (text === '5') { level = 'sma-smk'; subLevel = 'smk'; }
                if (!user) {
                    await createUser(userId, 'whatsapp', level, subLevel);
                    await logActivity(userId, 'signup', { level, subLevel });  // ✅
                } else {
                    await updateUserLevel(userId, level, subLevel);
                    await logActivity(userId, 'change_level', { level, subLevel });  // ✅
                }
                session = { level, subLevel, history: [] };
                await saveSession(userId, session);
                return sendText(from, `✅ Siap! Kamu terdaftar sebagai siswa ${getWAlevel(level, subLevel)}.\nSekarang, tanya apa saja ya! 😊`);
            }
            return sendText(from, `👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\nBalas dengan *angka* pilihanmu ya.`);
        }

        // 2. Perintah ganti level
        if (text === 'ganti level' || text === '/ganti_level') {
            session.level = null; session.subLevel = null;
            delete session.upgrade_pending;
            await saveSession(userId, session);
            await logActivity(userId, 'change_level');  // ✅
            return sendText(from, `🔁 Kakak mau pindah ke jenjang mana?\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK`);
        }

        // 3. Perintah upgrade
        if (text === 'upgrade' || text === '/upgrade') {
            const tier = await getUserTier(userId);
            if (tier === 'pro') return sendText(from, '✨ Kakak sudah menjadi member Yenni PRO!');
            if (tier === 'go') {
                session.upgrade_pending = true;
                session.upgrade_from = 'go';
                await saveSession(userId, session);
                await logActivity(userId, 'upgrade_view', { current_tier: 'go' });  // ✅
                return sendText(from, `🚀 Upgrade ke PRO\n\nKakak saat ini di paket GO. Upgrade ke PRO untuk dapatkan:\n✅ Teks 150/hari + Voice 50/hari + Video 30/hari\n✅ Model AI reasoning\n\nHarga: Rp75.000/bulan\nBalas 2 untuk upgrade ke PRO.`);
            }
            session.upgrade_pending = true;
            session.upgrade_from = 'free';
            await saveSession(userId, session);
            await logActivity(userId, 'upgrade_view', { current_tier: 'free' });  // ✅
            return sendText(from, `🚀 Pilih Paket Premium\n\n1. GO — Rp35.000/bulan\n   ✅ Teks 75/hari + Voice 20/hari + Video 10/hari\n   ✅ Input: Teks, Suara, OCR\n2. PRO — Rp75.000/bulan\n   ✅ Semua fitur GO + lebih banyak\nBalas 1 atau 2`);
        }

        // 4. Perintah langsung bayar
        if (text.startsWith('bayar')) {
            const pkg = text.includes('pro') ? 'pro' : 'go';
            await logActivity(userId, 'payment_start', { package: pkg });  // ✅
            return await handlePaymentWA(from, userId, pkg);
        }

        // 5. Perintah status
        if (text === 'status' || text === '/status') {
            const tier = await getUserTier(userId);
            const r = await getAllRemaining(userId);
            const tierName = tier === 'free' ? 'Free' : tier.toUpperCase();
            return sendText(from, `📊 Status Yenni\n\nTier: ${tierName}\nKuota hari ini:\n- Teks: ${r.text}\n- Gambar: ${r.image}\n- Voice: ${r.voice}\n- Video: ${r.ffmpeg || 0}`);
        }

        // 6. Proses chat normal
        try {
            const result = await processMessage(userId, text, session, 'whatsapp');
            await logActivity(userId, 'chat_text', { text: text.substring(0, 100) });  // ✅
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA process error:', error);
            await sendText(from, '😔 Maaf, ada gangguan. Coba lagi ya.');
        }
    }

    // --- Gambar (hanya GO dan PRO) ---
    else if (msg.type === 'image') {
        const tier = await getUserTier(userId);
        if (tier === 'free') return sendText(from, '📷 OCR hanya tersedia untuk paket GO dan PRO. Ketik "upgrade" untuk upgrade ya~');

        const imageQuota = await consumeQuota(userId, 'image');
        if (!imageQuota.allowed) return sendText(from, '📷 Kuota gambar harian sudah habis.');

        try {
            const imageId = (msg.image || {}).id;
            const caption = (msg.image || {}).caption || 'Jelaskan gambar ini.';
            const imageUrl = await getMediaUrl(imageId);
            const imageBuffer = await downloadFile(imageUrl);
            let compressed; try { compressed = await compressImage(imageBuffer, { maxWidth: 1024, quality: 80 }); } catch { compressed = imageBuffer; }
            const result = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', compressed);
            await logActivity(userId, 'ocr_image');  // ✅
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA image error:', error);
            await sendText(from, '😔 Gambar tidak bisa diproses.');
        }
    }

    // --- Audio / Voice Note (hanya GO dan PRO) ---
    else if (msg.type === 'audio' || msg.type === 'voice') {
        const tier = await getUserTier(userId);
        if (tier === 'free') return sendText(from, '🎤 Voice note hanya tersedia untuk paket GO dan PRO. Ketik "upgrade" untuk upgrade ya~');

        const voiceQuota = await consumeQuota(userId, 'voice');
        if (!voiceQuota.allowed) return sendText(from, '🎤 Kuota voice note sudah habis hari ini!');

        try {
            const audioId = (msg.audio || msg.voice || {}).id;
            const audioUrl = await getMediaUrl(audioId);
            const resp = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            const audioBuffer = Buffer.from(resp.data);
            await sendText(from, '🎤 Yenni dengerin suara Kakak...');
            const transcribed = await transcribeAudio(audioBuffer, 'audio/ogg');
            if (!transcribed) return sendText(from, '🎤 Maaf, tidak bisa mendengar.');
            await sendText(from, `📝 Yenni dengar: "${transcribed}"`);
            const result = await processMessage(userId, transcribed, session, 'whatsapp');
            await logActivity(userId, 'voice_note', { duration: (msg.audio || msg.voice || {}).duration });  // ✅
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA voice error:', error);
            await sendText(from, '🎤 Suara tidak bisa diproses.');
        }
    }

    // --- Dokumen (PDF) (hanya GO dan PRO) ---
    else if (msg.type === 'document') {
        const tier = await getUserTier(userId);
        if (tier === 'free') return sendText(from, '📄 PDF hanya tersedia untuk paket GO dan PRO. Ketik "upgrade" untuk upgrade ya~');

        try {
            const doc = msg.document || {};
            if (!(doc.filename || '').toLowerCase().endsWith('.pdf')) return sendText(from, '📎 Yenni hanya bisa baca PDF.');
            const docUrl = await getMediaUrl(doc.id);
            const docBuffer = await downloadFile(docUrl);
            let pdfText; try { pdfText = await extractTextFromPDF(docBuffer); } catch { return sendText(from, 'Gagal membaca PDF.'); }
            if (!pdfText) return sendText(from, '📄 PDF ini hasil scan. Kirim fotonya sebagai gambar ya.');
            const result = await processMessage(userId, `[PDF_TEXT]${doc.caption || 'Jelaskan isi PDF ini.'}\n${pdfText}`, session, 'whatsapp');
            await logActivity(userId, 'pdf_read');  // ✅
            await sendLongTextWA(from, result.text, result.images);
        } catch (error) {
            logger.error('WA doc error:', error);
            await sendText(from, '😔 Dokumen tidak bisa diproses.');
        }
    }
}

// Helper: proses pembayaran WhatsApp
async function handlePaymentWA(from, userId, pkg) {
    try {
        const invoice = await createPaymentLink(userId, pkg);
        return sendText(from,
            `💳 Pembayaran Yenni ${PACKAGES[pkg].name}\n\n` +
            `Klik link untuk membayar:\n${invoice.payment_link_url}\n\n` +
            `QRIS dan semua metode pembayaran tersedia.\n` +
            `Premium aktif otomatis setelah pembayaran.`
        );
    } catch (e) {
        return sendText(from, '😔 Gangguan pembayaran. Coba lagi nanti.');
    }
}

// --- Utilitas ---
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
