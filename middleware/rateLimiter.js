const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Redis } = require('@upstash/redis');
const config = require('../config');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

const ipLimiter = rateLimit({
    windowMs: config.rateLimit.ip.windowMs,
    max: config.rateLimit.ip.max,
    standardHeaders: true,
    message: '⏳ Mohon tunggu sebentar ya, Kak. Yenni lagi bantu banyak teman belajar nih.',
    skipFailedRequests: true,
});

async function userRateLimit(userId) {
    if (!redis) return true;
    const key = `rate:user:${userId}`;
    const current = await redis.incr(key);
    if (current === 1) {
        await redis.expire(key, Math.ceil(config.rateLimit.user.windowMs / 1000));
    }
    return current <= config.rateLimit.user.max;
}

async function checkTokenQuota(userId, tokensToAdd) {
    if (!redis) return true;
    const today = new Date().toISOString().slice(0, 10);
    const key = `quota:${userId}:${today}`;
    const used = parseInt(await redis.get(key)) || 0;
    if (used + tokensToAdd > config.rateLimit.dailyTokenQuota) {
        return false;
    }
    await redis.incrby(key, tokensToAdd);
    await redis.expire(key, 86400);
    return true;
}

async function isDuplicateRequest(userId, message) {
    if (!redis) return false;
    const hash = crypto.createHash('md5').update(message).digest('hex').slice(0, 12);
    const key = `dedup:${userId}:${hash}`;
    const exists = await redis.get(key);
    if (exists) return true;
    await redis.set(key, '1', { ex: 5 });
    return false;
}

module.exports = { ipLimiter, userRateLimit, checkTokenQuota, isDuplicateRequest };
