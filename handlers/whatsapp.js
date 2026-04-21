const { Client, LocalAuth } = require('whatsapp-web.js');
const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const logger = require('../utils/logger');

function setupWhatsAppHandler(client) {
    client.on('message', async (msg) => {
        // Hindari memproses pesan sendiri atau broadcast
        if (msg.fromMe || msg.isGroupMsg) return;

        const userId = `whatsapp:${msg.from}`;
        let session = await getSession(userId);
        let user = await getUser(userId);

        // Onboarding jika belum pilih jenjang
        if (!user || !session?.level) {
            if (!session) session = { level: null, subLevel: null, history: [] };

            // Deteksi pilihan dari pesan
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
                // Kirim pesan onboarding
                return msg.reply(`👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\nBalas dengan *angka* pilihanmu ya.`);
            }
        }

        // Handle gambar (OCR)
        let messageText = msg.body;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                    // Simpan buffer untuk diproses vision
                    const buffer = Buffer.from(media.data, 'base64');
                    // Kirim ke messageProcessor dengan prefix khusus
                    const caption = msg.body || 'Jelaskan gambar ini';
                    msg.reply('🔍 Yenni lagi baca tulisannya ya...');
                    const response = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', buffer);
                    return msg.reply(response);
                }
            } catch (err) {
                logger.error('WhatsApp media error:', err);
                return msg.reply('Maaf, gambarnya tidak bisa diproses. Coba foto yang lebih jelas ya.');
            }
        }

        // Proses pesan teks biasa
        if (messageText && messageText.length > 0) {
            client.sendPresenceAvailable();
            client.sendSeen(msg.from, msg.id._serialized);
            await new Promise(resolve => setTimeout(resolve, 500)); // simulasi membaca
            client.sendPresenceComposing(msg.from);
            
            try {
                const response = await processMessage(userId, messageText, session, 'whatsapp');
                // WhatsApp tidak mendukung format Markdown sepenuhnya, bersihkan
                const cleanResponse = response.replace(/[*_~`]/g, '');
                msg.reply(cleanResponse);
            } catch (error) {
                logger.error('WhatsApp process error:', error);
                msg.reply('😔 Maaf, ada gangguan. Coba lagi ya.');
            }
        }
    });
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
