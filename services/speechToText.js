const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.openaiApiKey });

async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
    try {
        const extension = mimeType.includes('ogg') ? 'ogg' :
                         mimeType.includes('mp3') ? 'mp3' :
                         mimeType.includes('wav') ? 'wav' : 'ogg';
        const file = new File([audioBuffer], `audio.${extension}`, { type: mimeType });

        const transcription = await openai.audio.transcriptions.create({
            model: 'gpt-4o-mini-transcribe',
            file,
            language: 'id'
        });

        logger.info(`Transcribed: "${transcription.text.substring(0, 50)}..."`);
        return transcription.text;
    } catch (error) {
        logger.error('Transcribe error:', error);
        throw new Error('TRANSCRIBE_FAILED: ' + error.message);
    }
}

module.exports = { transcribeAudio };
