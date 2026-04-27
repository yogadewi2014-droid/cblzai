const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.openaiApiKey });

/**
 * Transkripsi file audio menjadi teks menggunakan OpenAI GPT-4o Mini Transcribe
 * @param {Buffer} audioBuffer - Buffer audio (ogg/mp3/wav/webm)
 * @param {string} mimeType - MIME type audio (contoh: 'audio/ogg')
 * @returns {Promise<string>} Teks hasil transkripsi
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
    try {
        const extension = mimeType.includes('ogg') ? 'ogg' : 
                         mimeType.includes('mp3') ? 'mp3' : 
                         mimeType.includes('wav') ? 'wav' : 
                         mimeType.includes('webm') ? 'webm' : 'ogg';

        const file = new File([audioBuffer], `audio.${extension}`, { type: mimeType });

        const transcription = await openai.audio.transcriptions.create({
            model: 'gpt-4o-mini-transcribe',
            file: file,
            language: 'id',
        });

        logger.info(`Audio transcribed (GPT-4o Mini): "${transcription.text.substring(0, 50)}..."`);
        return transcription.text;

    } catch (error) {
        logger.error('GPT-4o Mini Transcribe error:', error);
        throw new Error('TRANSCRIBE_FAILED: ' + error.message);
    }
}

module.exports = { transcribeAudio };
