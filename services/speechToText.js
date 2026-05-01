const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Transkripsi audio menggunakan Gemini 2.5 Flash Lite (multimodal)
 * Model ini bisa langsung memproses audio dan mengembalikan teks.
 * Biaya dihitung per token input audio, bukan per menit.
 * @param {Buffer} audioBuffer - Buffer audio (ogg/mp3/wav/webm)
 * @param {string} mimeType - MIME type audio (contoh: 'audio/ogg')
 * @returns {Promise<string>} Teks hasil transkripsi
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
    try {
        // Konversi buffer ke base64
        const base64Audio = audioBuffer.toString('base64');

        // Siapkan model Gemini multimodal
        const model = genAI.getGenerativeModel({
            model: config.geminiModel, // 'gemini-2.5-flash-lite'
        });

        // Kirim audio + prompt transkripsi
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Audio,
                },
            },
            {
                text: 'Tolong transkripsi audio ini ke teks. Jika audio kosong atau hanya berisi noise, jawab dengan "[AUDIO_KOSONG]".',
            },
        ]);

        const response = result.response;
        const text = response.text().trim();

        // Deteksi audio kosong
        if (!text || text === '[AUDIO_KOSONG]' || text.length === 0) {
            logger.info('Gemini returned empty transcription (silent/noise audio)');
            return ''; // Kembalikan string kosong
        }

        logger.info(`Gemini transcribed: "${text.substring(0, 50)}..."`);
        return text;

    } catch (error) {
        logger.error('Gemini transcribe error:', error);
        throw new Error('TRANSCRIBE_FAILED: ' + error.message);
    }
}

module.exports = { transcribeAudio };
