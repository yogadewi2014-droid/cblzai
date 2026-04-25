const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const logger = require('../utils/logger');

function setupWhatsAppHandler(client) {
    client.on('message', async (msg) => {
        if (msg.fromMe || msg.isGroupMsg) return;

        const userId = `whatsapp:${msg.from}`;
        let session = await getSession(userId);
        let user = await getUser(userId);

        // Onboarding
        if (!user || !session?.level) {
            if (!session) session = { level: null, subLevel: null, history: [] };
            const text = msg.body.trim();
            if (text === '1' || text === '2' || text === '3' || text === '4' || text === '5') {
                let level, subLevel;
                if (text === '1') { level = 'sd-smp'; subLevel = 'sd-1-3'; }
                else if (text === '2') { level = 'sd-smp'; subLevel = 'sd-4-6'; }
                else if (text === '3') { level = 'sd-smp'; subLevel = 'smp'; }
                else if (text === '4') { level = 'sma-smk'; subLevel = 'sma'; }
                else if (text === '5') { level = 'sma-smk'; subLevel = 'smk'; }

                if (!user) {
                    await createUser(userId, 'whatsapp', level, subLevel);
                } else {
                    await updateUserLevel(userId, level, subLevel);
                }
                session = { level, subLevel, history: [] };
                await saveSession(userId, session);
                return msg.reply(`✅ Siap! Kamu terdaftar sebagai siswa ${getUserLevelText(level, subLevel)}.\nSekarang, tanya apa saja ya! 😊`);
            } else {
                return msg.reply(`👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\nBalas dengan *angka* pilihanmu ya.`);
            }
        }

        // Tampilkan status mengetik
        client.sendPresenceUpdate('composing', msg.from);

        // Handle gambar (OCR)
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                    const buffer = Buffer.from(media.data, 'base64');
                    const caption = msg.body || 'Jelaskan gambar ini';
                    // Kirim pesan sementara
                    await msg.reply('🔍 Yenni lagi baca tulisannya ya...');

                    const result = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', buffer);
                    await msg.reply(result.text);
                    for (const imageUrl of result.images) {
                        const imageBuffer = await downloadImageBuffer(imageUrl);
                        const media = new MessageMedia('image/png', imageBuffer.toString('base64'));
                        await client.sendMessage(msg.from, media);
                    }
                    return;
                }
            } catch (err) {
                logger.error('WhatsApp media error:', err);
                return msg.reply('Maaf, gambarnya tidak bisa diproses. Coba foto yang lebih jelas ya.');
            }
        }

        // Pesan teks biasa
        const messageText = msg.body;
        if (messageText && messageText.length > 0) {
            try {
                const result = await processMessage(userId, messageText, session, 'whatsapp');
                await msg.reply(result.text);
                for (const imageUrl of result.images) {
                    const imageBuffer = await downloadImageBuffer(imageUrl);
                    const media = new MessageMedia('image/png', imageBuffer.toString('base64'));
                    await client.sendMessage(msg.from, media);
                }
            } catch (error) {
                logger.error('WhatsApp process error:', error);
                msg.reply('😔 Maaf, ada gangguan. Coba lagi ya.');
            }
        }
    });
}

async function downloadImageBuffer(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
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

module.exports = { setupWhatsAppHandler };
