const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
  redis = new Redis({
    url: config.upstashRedisUrl,
    token: config.upstashRedisToken
  });
}

// 🔑 biar key pendek & konsisten
function normalizeKey(key) {
  return key
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashKey(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

function buildCacheKey(type, key) {
  const normalized = normalizeKey(key);
  return `media:${type}:${hashKey(normalized)}`;
}

async function getMediaCache(type, key) {
  if (!redis) return null;

  const cacheKey = buildCacheKey(type, key);

  try {
    const cached = await redis.get(cacheKey);
    if (!cached) return null;

    try {
      const parsed = JSON.parse(cached);
      logger.info(`✅ Cache HIT: ${type}`);
      return parsed;
    } catch (err) {
      // 🔥 auto-clean kalau corrupt
      await redis.del(cacheKey);
      logger.warn(`⚠️ Cache corrupt, deleted: ${cacheKey}`);
      return null;
    }
  } catch (err) {
    logger.error('Redis GET error:', err.message);
    return null;
  }
}

async function setMediaCache(type, key, data, ttl = 86400) {
  if (!redis) return;

  const cacheKey = buildCacheKey(type, key);

  try {
    await redis.set(cacheKey, JSON.stringify(data), { ex: ttl });
    logger.info(`💾 Cache SET: ${type}`);
  } catch (err) {
    logger.error('Redis SET error:', err.message);
  }
}

module.exports = {
  getMediaCache,
  setMediaCache,
  buildCacheKey
};
