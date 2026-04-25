const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { compressImage, extractTextFromPDF } = require('../utils/imageProcessor');
const { downloadFile } = require('../utils/downloader');
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

        // Handle media (gambar & dokumen)
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (!media) return msg.reply('Maaf, media tidak bisa diunduh. Coba lagi ya.');

                const isPdf = media.mimetype === 'application/pdf' || 
                              (msg._data && msg._data.caption && msg._data.caption.toLowerCase().endsWith('.pdf'));

                if (isPdf) {
                    // Proses PDF
                    await msg.reply('📄 Yenni lagi baca file PDF-nya ya...');
                    const pdfBuffer = Buffer.from(media.data, 'base64');
                    
                    let pdfText;
                    try {
                        pdfText = await extractTextFromPDF(pdfBuffer);
                    } catch (pdfError) {
                        logger.error('PDF extraction failed:', pdfError);
                        return msg.reply('Maaf, gagal membaca PDF. Pastikan PDF-nya bukan hasil scan ya.');
                    }

                    if (!pdfText) {
                        return msg.reply('📄 PDF ini sepertinya hasil scan (gambar). Yenni belum bisa baca PDF scan.\nKakak bisa kirim fotonya langsung sebagai gambar ya. 😊');
                    }

                    const caption = msg.body || 'Jelaskan isi PDF ini.';
                    const result = await processMessage(userId, `[PDF_TEXT]${caption}\n${pdfText}`, session, 'whatsapp');
                    
                    await sendTextAndImages(client, msg.from, result);
                    return;
                } else if (media.mimetype && media.mimetype.startsWith('image/')) {
                    // Proses gambar (dengan kompresi)
                    await msg.reply('🔍 Yenni lagi baca tulisannya ya...');
                    const imageBuffer = Buffer.from(media.data, 'base64');
                    
                    // Kompresi gambar sebelum OCR
                    let compressedBuffer;
                    try {
                        compressedBuffer = await compressImage(imageBuffer, { maxWidth: 1024, quality: 80 });
                    } catch (compErr) {
                        logger.warn('Compression failed, using original:', compErr);
                        compressedBuffer = imageBuffer;
                    }

                    const caption = msg.body || 'Jelaskan gambar ini.';
                    // Kirim buffer gambar melalui parameter tambahan
                    const result = await processMessage(userId, `[IMAGE_BUFFER]${caption}`, session, 'whatsapp', compressedBuffer);
                    
                    await sendTextAndImages(client, msg.from, result);
                    return;
                } else {
                    return msg.reply('📎 Untuk saat ini Yenni hanya bisa membaca gambar dan PDF ya, Kak.');
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
                await sendTextAndImages(client, msg.from, result);
            } catch (error) {
                logger.error('WhatsApp process error:', error);
                msg.reply('😔 Maaf, ada gangguan. Coba lagi ya.');
            }
        }
    });
}

/**
 * Mengirim teks dan gambar ke WhatsApp
 */
async function sendTextAndImages(client, to, result) {
    // Kirim teks (split jika panjang)
    if (result.text) {
        const maxLen = 1500;
        if (result.text.length > maxLen) {
            const chunks = splitMessage(result.text, maxLen);
            for (const chunk of chunks) {
                await client.sendMessage(to, chunk);
            }
        } else {
            await client.sendMessage(to, result.text);
        }
    }

    // Kirim gambar visualisasi
    for (const imageUrl of result.images) {
        try {
            const imageBuffer = await downloadImageBuffer(imageUrl);
            const media = new MessageMedia('image/png', imageBuffer.toString('base64'));
            await client.sendMessage(to, media);
        } catch (err) {
            logger.error('Failed to send image to WhatsApp:', err);
            await client.sendMessage(to, '📊 Maaf, gambar visualisasi gagal dikirim.');
        }
    }
}

async function downloadImageBuffer(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
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

module.exports = { setupWhatsAppHandler };
