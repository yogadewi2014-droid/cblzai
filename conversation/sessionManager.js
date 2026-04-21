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
        logger.warn('No Redis config, using in-memory Map fallback');
        global.sessionStore = new Map();
    }
}

async function getSession(userId) {
    if (redis) {
        const data = await redis.get(`session:${userId}`);
        return data ? JSON.parse(data) : null;
    }
    return global.sessionStore?.get(userId) || null;
}

async function saveSession(userId, sessionData, ttlSeconds = 86400) {
    if (redis) {
        await redis.set(`session:${userId}`, JSON.stringify(sessionData), { ex: ttlSeconds });
    } else {
        global.sessionStore?.set(userId, sessionData);
    }
}

async function closeRedis() {
    if (redis) {
        // Upstash Redis tidak memerlukan quit() karena REST API
        logger.info('Redis connection closed (no-op for REST)');
    }
}

module.exports = {
    initRedis,
    getSession,
    saveSession,
    closeRedis
};
