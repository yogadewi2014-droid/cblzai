const textToSpeech = require('@google-cloud/text-to-speech');
const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

const client = new textToSpeech.TextToSpeechClient();

// Redis cache client
let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

function buildCacheKey(text, languageCode, voiceName) {
    return `tts:${Buffer.from(`${text}|${languageCode}|${voiceName}`).toString('base64')}`;
}

async function getCachedVoice(key) {
    if (!redis) return null;
    try {
        const cached = await redis.get(key);
        if (cached) {
            logger.info('TTS cache HIT');
            return Buffer.from(cached, 'base64');
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function setCachedVoice(key, buffer, ttl = 86400) {
    if (!redis) return;
    try {
        await redis.set(key, buffer.toString('base64'), { ex: ttl });
        logger.info('TTS cached');
    } catch (e) {}
}

async function generateVoice(text, languageCode = 'id-ID', voiceName = 'id-ID-Standard-A') {
    const cacheKey = buildCacheKey(text, languageCode, voiceName);
    const cached = await getCachedVoice(cacheKey);
    if (cached) return cached;

    const request = {
        input: { text: text },
        voice: { languageCode: languageCode, name: voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 },
    };

    try {
        const [response] = await client.synthesizeSpeech(request);
        await setCachedVoice(cacheKey, response.audioContent, 86400);
        return response.audioContent;
    } catch (error) {
        logger.error('Google TTS error:', error);
        throw error;
    }
}

function detectLanguage(text) {
    const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
    const totalChars = text.length || 1;
    return (latinChars / totalChars) > 0.7 ? 'en-US' : 'id-ID';
}

function selectVoice(languageCode) {
    if (languageCode === 'en-US') return 'en-US-Standard-B';
    return 'id-ID-Standard-A';
}

module.exports = { generateVoice, detectLanguage, selectVoice };
