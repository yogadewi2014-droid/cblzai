const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

const FREE_CHAT_LIMIT = 10;

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

async function checkChatQuota(userId) {
    if (!redis) return { allowed: true, remaining: -1, isPremium: false };
    const premium = await isPremium(userId);
    if (premium) return { allowed: true, remaining: -1, isPremium: true };
    const today = new Date().toISOString().slice(0, 10);
    const key = `chat_count:${userId}:${today}`;
    const count = parseInt(await redis.get(key)) || 0;
    return {
        allowed: count < FREE_CHAT_LIMIT,
        remaining: Math.max(0, FREE_CHAT_LIMIT - count),
        isPremium: false
    };
}

async function incrementChatCount(userId) {
    if (!redis) return;
    const premium = await isPremium(userId);
    if (premium) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = `chat_count:${userId}:${today}`;
    const count = await redis.incr(key);
    if (count === 1) {
        const now = new Date();
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        await redis.expire(key, Math.floor((endOfDay - now) / 1000));
    }
}

async function getRemainingChats(userId) {
    if (!redis) return FREE_CHAT_LIMIT;
    const premium = await isPremium(userId);
    if (premium) return -1;
    const today = new Date().toISOString().slice(0, 10);
    const count = parseInt(await redis.get(`chat_count:${userId}:${today}`)) || 0;
    return Math.max(0, FREE_CHAT_LIMIT - count);
}

module.exports = { isPremium, activatePremium, checkChatQuota, incrementChatCount, getRemainingChats };
