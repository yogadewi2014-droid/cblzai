const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({
        url: config.upstashRedisUrl,
        token: config.upstashRedisToken
    });
}

// ======================
// LIMIT CONFIG
// ======================
const LIMITS = {
    free: { text: 10, image: 0, voice: 0, ffmpeg: 0 },
    go:   { text: 75, image: 5, voice: 20, ffmpeg: 10 },
    pro:  { text: 150, image: 10, voice: 50, ffmpeg: 30 }
};

// ======================
// HELPER: LOCAL DATE (BALI)
// ======================
function getLocalDate() {
    return new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Makassar'
    });
}

// ======================
// USER TIER
// ======================
async function getUserTier(userId) {
    if (!redis) return 'free';
    const tier = await redis.get(`tier:${userId}`);
    return tier || 'free';
}

async function setUserTier(userId, tier, durationDays = 30) {
    if (!redis) return;

    await redis.set(`tier:${userId}`, tier, {
        ex: durationDays * 86400
    });

    logger.info(`Tier ${tier} activated for ${userId}, ${durationDays}d`);
}

// ======================
// ATOMIC QUOTA CONSUME (ANTI JEBOL)
// ======================
async function consumeQuota(userId, type) {
    if (!redis) {
        return {
            allowed: false,
            remaining: 0,
            tier: 'free',
            error: 'redis_down'
        };
    }

    const tier = await getUserTier(userId);
    const limit = (LIMITS[tier] || LIMITS['free'])[type] || 0;

    if (limit === 0) {
        return { allowed: false, remaining: 0, tier, limit };
    }

    const today = getLocalDate();
    const key = `quota:${userId}:${type}:${today}`;

    // atomic increment
    const count = await redis.incr(key);

    // set TTL saat pertama kali
    if (count === 1) {
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setHours(24, 0, 0, 0);

        const ttl = Math.floor((endOfDay - now) / 1000);
        await redis.expire(key, ttl);
    }

    if (count > limit) {
        return {
            allowed: false,
            remaining: 0,
            tier,
            limit
        };
    }

    return {
        allowed: true,
        remaining: limit - count,
        tier,
        limit
    };
}

// ======================
// CHECK ONLY (OPTIONAL)
// ======================
async function checkQuota(userId, type) {
    if (!redis) {
        return { allowed: false, remaining: 0, tier: 'free' };
    }

    const tier = await getUserTier(userId);
    const limit = (LIMITS[tier] || LIMITS['free'])[type] || 0;

    if (limit === 0) {
        return { allowed: false, remaining: 0, tier, limit };
    }

    const today = getLocalDate();
    const count = parseInt(
        await redis.get(`quota:${userId}:${type}:${today}`)
    ) || 0;

    return {
        allowed: count < limit,
        remaining: Math.max(0, limit - count),
        tier,
        limit
    };
}

// ======================
// GET ALL REMAINING
// ======================
async function getAllRemaining(userId) {
    if (!redis) {
        return LIMITS.free;
    }

    const tier = await getUserTier(userId);
    const limits = LIMITS[tier] || LIMITS.free;

    const today = getLocalDate();
    const result = {};

    for (const type of Object.keys(limits)) {
        const count = parseInt(
            await redis.get(`quota:${userId}:${type}:${today}`)
        ) || 0;

        result[type] = Math.max(0, limits[type] - count);
    }

    return result;
}

// ======================
// EXPORT
// ======================
module.exports = {
    LIMITS,

    getUserTier,
    setUserTier,

    consumeQuota,     // 🔥 utama (pakai ini)
    checkQuota,       // opsional

    getAllRemaining,

    isPremium: async (userId) =>
        (await getUserTier(userId)) !== 'free',

    activatePremium: (userId, days = 30) =>
        setUserTier(userId, 'go', days)
};
