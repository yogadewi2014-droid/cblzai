const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { generateEmbedding, cosineSimilarity } = require('../services/embedding');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
  redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

/**
 * Layer 1: Exact Match Cache (berdasarkan hash pertanyaan + jenjang)
 */
async function getExactMatchCache(question, level, subLevel) {
  if (!redis) return null;
  const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
  const cached = await redis.get(`exact:${hash}`);
  if (cached) {
    logger.info('Exact cache HIT');
    return JSON.parse(cached);
  }
  return null;
}

async function setExactMatchCache(question, level, subLevel, response) {
  if (!redis) return;
  const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
  await redis.set(`exact:${hash}`, JSON.stringify(response), { ex: config.cacheTTL.exactMatch });
}

/**
 * Layer 2: Semantic Vector Cache (berdasarkan cosine similarity embedding)
 */
async function getSemanticCache(question, level, subLevel) {
  if (!redis) return null;
  try {
    const emb = await generateEmbedding(question);
    // Ambil semua kunci semantic cache untuk jenjang ini (dalam praktik bisa pakai Redis Search)
    const keys = await redis.keys(`semantic:${level}:${subLevel}:*`);
    if (keys.length === 0) return null;

    let bestMatch = null;
    let highestSimilarity = 0;
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const cached = JSON.parse(data);
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
  try {
    const emb = await generateEmbedding(question);
    const hash = crypto.createHash('md5').update(`${question}|${level}|${subLevel}`).digest('hex');
    const key = `semantic:${level}:${subLevel}:${hash}`;
    await redis.set(key, JSON.stringify({ question, response, embedding: emb }), { ex: config.cacheTTL.semantic });
  } catch (err) {
    logger.error('Failed to set semantic cache:', err);
  }
}

module.exports = {
  getExactMatchCache,
  setExactMatchCache,
  getSemanticCache,
  setSemanticCache
};
