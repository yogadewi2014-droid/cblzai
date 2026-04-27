const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { compressImage, extractTextFromPDF } = require('../utils/imageProcessor');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { isPremium, getRemainingChats } = require('../services/quotaManager');
const { createSubscription } = require('../services/xendit');
const axios = require('axios');
const logger = require('../utils/logger');

const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WA_API_VERSION = 'v22.0';
const WA_API_URL = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

function verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
        logger.info('WhatsApp webhook verified');
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
}

async function handleWebhook(req, res) {
    try {
        const body = req.body;
        if (!body.object || !body.entry) return res.sendStatus(400);

        for (const entry of body.entry) {
            for (const change of entry.changes || []) {
                if (change.field !== 'messages') continue;
                const value = change.value || {};
                const messages = value.messages || [];
                for (const msg of messages) {
                    await processIncomingMessage(msg);
                }
            }
        }
        return res.sendStatus(200);
    } catch (error) {
        logger.error('WhatsApp webhook error:', error);
        return res.sendStatus(500);
    }
}

async function processIncomingMessage(msg) {
    const from = msg.from;
    const userId = `whatsapp:${from}`;
    const msgType = msg.type;

    let session = await getSession(userId);
    let user = await getUser(userId);

    // ===== TEXT =====
    if (msgType === 'text') {
        const messageText = msg.text?.body || '';
        const lowerText = messageText.toLowerCase().trim();

        // Perintah khusus
        if (lowerText === 'ganti level' || lowerText === '/ganti_level') {
            if (!user) return sendTextMessage(from, 'Ketik "halo" dulu ya, Kak.');
            session.level = null; session.subLevel = null;
            await saveSession(userId, session);
            return sendTextMessage(from, `🔁 Kakak mau pindah ke jenjang mana?\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\nBalas dengan angka ya.`);
        }

        if (lowerText === 'upgrade' || lowerText === '/upgrade') {
            if (!user) return sendTextMessage(from, 'Ketik "halo" dulu ya, Kak.');
            const premium = await isPremium(userId);
            if (premium) return sendTextMessage(from, '✨ Kakak sudah premium!');
            return sendTextMessage(from, `🚀 *Yenni Premium*\n- Mingguan: Rp12.000/7 hari\n- Bulanan: Rp35.000/30 hari\nKetik "bayar mingguan" atau "bayar bulanan" untuk lanjut.`);
        }

        if (lowerText === 'bayar mingguan' || lowerText === 'bayar bulanan') {
            if (!user) return sendTextMessage(from, 'Ketik "halo" dulu ya, Kak.');
            const premium = await isPremium(userId);
            if (premium) return sendTextMessage(from, '✨ Kakak sudah premium!');
            const pkgKey = lowerText.includes('mingguan') ? 'weekly' : 'monthly';
            try {
                const invoice = await createSubscription(userId, pkgKey, '');
                return sendTextMessage(from, `💳 Bayar via link ini:\n${invoice.payment_link_url}\n\nSetelah bayar, premium otomatis aktif.`);
            } catch (e) {
                logger.error('Payment error:', e);
                return sendTextMessage(from, '😔 Gagal membuat pembayaran. Coba lagi nanti.');
            }
        }

        if (lowerText === 'status' || lowerText === '/status') {
            if (!user) return sendTextMessage(from, 'Ketik "halo" dulu ya, Kak.');
            const premium = await isPremium(userId);
            const remaining = await getRemainingChats(userId);
            let txt = `📊 *Status Akun*\nJenjang: ${getUserLevelText(user.level, user.sub_level)}\nStatus: ${premium ? '✨ Premium' : '🆓 Gratis'}\n`;
            if (!premium) txt += `Chat gratis hari ini: ${remaining}/10\n`;
            return sendTextMessage(from, txt);
        }

        // Onboarding
        if (!user || !session?.level) {
            if (!session) session = { level: null, subLevel: null, history: [] };
            const choice = messageText.trim();
            if (['1','2','3','4','5'].includes(choice)) {
                let level, subLevel;
                if (choice === '1') { level = 'sd-smp'; subLevel = 'sd-1-3'; }
                else if (choice === '2') { level = 'sd-smp'; subLevel = 'sd-4-6'; }
                else if (choice === '3') { level = 'sd-smp'; subLevel = 'smp'; }
                else if (choice === '4') { level = 'sma-smk'; subLevel = 'sma'; }
                else if (choice === '5') { level = 'sma-smk'; subLevel = 'smk'; }

                if (!user) await createUser(userId, 'whatsapp', level, subLevel);
                else await updateUserLevel(userId, level, subLevel);
                session = { level, subLevel, history: [] };
                await saveSession(userId, session);
                return sendTextMessage(from, `✅ Terdaftar sebagai ${getUserLevelText(level, subLevel)}. Tanya apa saja!`);
            }
            return sendTextMessage(from, `👋 Halo! Aku Yenni. Pilih jenjang:\n1️⃣ SD 1-3\n2️⃣ SD 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK`);
        }

        // Proses pesan biasa
        try {
            const result = await processMessage(userId, messageText, session, 'whatsapp');
            await sendTextAndImages(from, result);
        } catch (error) {
            logger.error('WA text error:', error);
            await sendTextMessage(from, '😔 Maaf, ada gangguan.');
        }
    }

    // ===== IMAGE =====
    else if (msgType === 'image') {
        if (!user || !session?.level) return sendTextMessage(from, 'Pilih jenjang dulu ya.');
        try {
            const image = msg.image || {};
            const imageId = image.id;
            const caption = image.caption || 'Jelaskan gambar ini.';
            const imageUrl = await getMediaUrl(imageId);
            const imageBuffer = await downloadFile(imageUrl);

            let compressed;
            try { compressed = await compressImage(imageBuffer, { maxWidth: 1024, quality: 80 }); }
            catch { compressed = imageBuffer; }

            const result = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', compressed);
            await sendTextAndImages(from, result);
        } catch (error) {
            logger.error('WA image error:', error);
            await sendTextMessage(from, '😔 Gagal memproses gambar.');
        }
    }

    // ===== VOICE =====
    else if (msgType === 'audio' || msgType === 'voice') {
        if (!user || !session?.level) return sendTextMessage(from, 'Pilih jenjang dulu ya.');
        try {
            const audio = msg.audio || msg.voice || {};
            const audioId = audio.id;
            const audioUrl = await getMediaUrl(audioId);
            const resp = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            const audioBuffer = Buffer.from(resp.data);

            await sendTextMessage(from, '🎤 Yenni dengerin...');
            const transcribed = await transcribeAudio(audioBuffer, 'audio/ogg');
            if (!transcribed) return sendTextMessage(from, '🎤 Tidak terdengar. Ulangi lagi ya.');

            await sendTextMessage(from, `📝 Yenni dengar: "${transcribed}"`);
            const result = await processMessage(userId, transcribed, session, 'whatsapp');
            await sendTextAndImages(from, result);
        } catch (error) {
            logger.error('WA voice error:', error);
            await sendTextMessage(from, '🎤 Gagal memproses suara.');
        }
    }

    // ===== DOCUMENT (PDF) =====
    else if (msgType === 'document') {
        if (!user || !session?.level) return sendTextMessage(from, 'Pilih jenjang dulu ya.');
        try {
            const doc = msg.document || {};
            const docId = doc.id;
            const filename = doc.filename || '';
            if (!filename.toLowerCase().endsWith('.pdf')) {
                return sendTextMessage(from, '📎 Hanya file PDF yang bisa dibaca.');
            }
            const docUrl = await getMediaUrl(docId);
            const docBuffer = await downloadFile(docUrl);
            const pdfText = await extractTextFromPDF(docBuffer);
            if (!pdfText) return sendTextMessage(from, '📄 PDF ini hasil scan, kirim sebagai gambar saja ya.');
            const caption = doc.caption || 'Jelaskan isi PDF ini.';
            const result = await processMessage(userId, `[PDF_TEXT]${caption}\n${pdfText}`, session, 'whatsapp');
            await sendTextAndImages(from, result);
        } catch (error) {
            logger.error('WA doc error:', error);
            await sendTextMessage(from, '😔 Gagal memproses dokumen.');
        }
    }
}

async function sendTextAndImages(to, result) {
    if (result.text) {
        if (result.text.length > 1500) {
            const chunks = splitMessage(result.text, 1500);
            for (const chunk of chunks) await sendTextMessage(to, chunk);
        } else {
            await sendTextMessage(to, result.text);
        }
    }
    for (const url of result.images || []) {
        try { await sendImageMessage(to, url); } catch {}
    }
}

async function sendTextMessage(to, text) {
    try {
        await axios.post(WA_API_URL, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: text, preview_url: false }
        }, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) {
        logger.error('Send WA text error:', error.response?.data || error.message);
    }
}

async function sendImageMessage(to, imageUrl) {
    try {
        await axios.post(WA_API_URL, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'image',
            image: { link: imageUrl }
        }, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) {
        logger.error('Send WA image error:', error.response?.data || error.message);
    }
}

async function getMediaUrl(mediaId) {
    const resp = await axios.get(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
        headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` }
    });
    return resp.data.url;
}

function splitMessage(text, maxLength) {
    const chunks = [];
    let current = '';
    const words = text.split(' ');
    for (const word of words) {
        if ((current + ' ' + word).length > maxLength) {
            chunks.push(current.trim());
            current = word;
        } else {
            current += (current ? ' ' : '') + word;
        }
    }
    if (current) chunks.push(current.trim());
    return chunks;
}

function getUserLevelText(level, subLevel) {
    const map = {
        'sd-1-3': 'SD Kelas 1-3',
        'sd-4-6': 'SD Kelas 4-6',
        'smp': 'SMP',
        'sma': 'SMA',
        'smk': 'SMK'
    };
    return map[subLevel] || level;
}

module.exports = { verifyWebhook, handleWebhook };
