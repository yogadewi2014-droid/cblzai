const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { generateEmbedding, cosineSimilarity } = require('../services/embedding');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

// ==================== SEARCH CACHE ====================
async function getCachedSearchResult(query) {
    if (!redis) return null;
    const key = `search:${crypto.createHash('md5').update(query).digest('hex')}`;
    return await redis.get(key);
}

async function cacheSearchResult(query, result) {
    if (!redis) return;
    const key = `search:${crypto.createHash('md5').update(query).digest('hex')}`;
    await redis.set(key, result, { ex: config.cacheTTL.search });
}

// ==================== EXACT MATCH CACHE ====================
async function getExactMatchCache(question, level, subLevel) {
    if (!redis) return null;
    const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
    const cached = await redis.get(`exact:${hash}`);
    if (cached) {
        logger.info('Exact cache HIT');
        return (typeof cached === 'object') ? cached : JSON.parse(cached);
    }
    return null;
}

async function setExactMatchCache(question, level, subLevel, response) {
    if (!redis) return;
    if (response.includes('gangguan teknis') || response.includes('Maaf')) return;
    const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
    await redis.set(`exact:${hash}`, JSON.stringify(response), { ex: config.cacheTTL.exactMatch });
}

// ==================== SEMANTIC CACHE ====================
async function getSemanticCache(question, level, subLevel) {
    if (!redis) return null;
    try {
        const emb = await generateEmbedding(question);
        if (!emb) {
            logger.warn('Embedding generation failed, skipping semantic cache');
            return null;
        }

        const pattern = `semantic:${level}:${subLevel}:*`;
        const keys = await redis.keys(pattern);
        let bestMatch = null;
        let highestSimilarity = 0;

        for (const key of keys) {
            const data = await redis.get(key);
            if (!data) continue;
            let cached;
            try {
                cached = (typeof data === 'object') ? data : JSON.parse(data);
            } catch {
                continue;
            }
            if (!cached.embedding) continue;

            const similarity = cosineSimilarity(emb, cached.embedding);
            if (similarity > config.semanticSimilarityThreshold && similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = cached.response;
            }
        }

        if (bestMatch) {
            logger.info(`Semantic cache HIT (similarity: ${highestSimilarity.toFixed(3)})`);
            return bestMatch;
        }
    } catch (err) {
        logger.error('Semantic cache error:', err);
    }
    return null;
}

async function setSemanticCache(question, level, subLevel, response) {
    if (!redis) return;
    if (response.includes('gangguan teknis') || response.includes('Maaf')) return;
    try {
        const emb = await generateEmbedding(question);
        if (!emb) {
            logger.warn('Embedding generation failed, skipping save to semantic cache');
            return;
        }

        const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
        const key = `semantic:${level}:${subLevel}:${hash}`;
        await redis.set(key, JSON.stringify({ question, response, embedding: emb }), { ex: config.cacheTTL.semantic });
    } catch (err) {
        logger.error('Failed to set semantic cache:', err);
    }
}

// ==================== OCR CACHE ====================
async function getCachedOCR(imageHash) {
    if (!redis) return null;
    return await redis.get(`ocr:${imageHash}`);
}

async function setCachedOCR(imageHash, text) {
    if (!redis) return;
    await redis.set(`ocr:${imageHash}`, text, { ex: config.cacheTTL.ocr });
}

module.exports = {
    getCachedSearchResult,
    cacheSearchResult,
    getExactMatchCache,
    setExactMatchCache,
    getSemanticCache,
    setSemanticCache,
    getCachedOCR,
    setCachedOCR
};
