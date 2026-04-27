const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

const LIMITS = {
    text: 10,
    image: 3,
    voice: 5
};

async function isPremium(userId) {
    if (!redis) return false;
    const status = await redis.get(`premium:${userId}`);
    return status === 'active';
}

async function activatePremium(userId, durationDays = 30) {
    if (!redis) return;
    await redis.set(`premium:${userId}`, 'active', { ex: durationDays * 86400 });
    logger.info(`Premium activated for ${userId}, ${durationDays} days`);
}

function getQuotaKey(userId, type) {
    const today = new Date().toISOString().slice(0, 10);
    return `quota:${userId}:${type}:${today}`;
}

async function checkTypeQuota(userId, type) {
    if (!redis) return { allowed: true, remaining: -1, isPremium: false };
    const premium = await isPremium(userId);
    if (premium) return { allowed: true, remaining: -1, isPremium: true };
    const limit = LIMITS[type] || 10;
    const key = getQuotaKey(userId, type);
    const count = parseInt(await redis.get(key)) || 0;
    return {
        allowed: count < limit,
        remaining: Math.max(0, limit - count),
        isPremium: false,
        limit
    };
}

async function incrementTypeQuota(userId, type) {
    if (!redis) return;
    const premium = await isPremium(userId);
    if (premium) return;
    const key = getQuotaKey(userId, type);
    const count = await redis.incr(key);
    if (count === 1) {
        const now = new Date();
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const ttl = Math.floor((endOfDay - now) / 1000);
        await redis.expire(key, ttl);
    }
}

async function getAllRemaining(userId) {
    if (!redis) return { text: LIMITS.text, image: LIMITS.image, voice: LIMITS.voice };
    const premium = await isPremium(userId);
    if (premium) return { text: -1, image: -1, voice: -1 };
    const result = {};
    for (const t of Object.keys(LIMITS)) {
        const key = getQuotaKey(userId, t);
        const count = parseInt(await redis.get(key)) || 0;
        result[t] = Math.max(0, LIMITS[t] - count);
    }
    return result;
}

module.exports = { isPremium, activatePremium, checkTypeQuota, incrementTypeQuota, getAllRemaining, LIMITS };
