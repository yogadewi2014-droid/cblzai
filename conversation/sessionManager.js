const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

let redis;

function initRedis() {
    if (config.upstashRedisUrl && config.upstashRedisToken) {
        redis = new Redis({
            url: config.upstashRedisUrl,
            token: config.upstashRedisToken,
        });
        logger.info('Upstash Redis initialized');
    } else {
        logger.warn('No Redis config, using Map fallback');
        global.sessionStore = new Map();
    }
}

async function getSession(userId) {
    if (redis) {
        const data = await redis.get(`session:${userId}`);
        if (!data) return null;
        try {
            return (typeof data === 'object') ? data : JSON.parse(data);
        } catch {
            await redis.del(`session:${userId}`);
            return null;
        }
    }
    return global.sessionStore?.get(userId) || null;
}

async function saveSession(userId, data, ttl = 86400) {
    if (redis) {
        await redis.set(`session:${userId}`, JSON.stringify(data), { ex: ttl });
    } else {
        global.sessionStore?.set(userId, data);
    }
}

async function closeRedis() {
    if (redis) logger.info('Redis closed (no-op for REST)');
}

module.exports = { initRedis, getSession, saveSession, closeRedis };
