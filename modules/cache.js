// modules/cache.js
const { createClient: createRedisClient } = require('redis');

let redisClient = null;
let redisConnected = false;
const memoryCache = new Map();

async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.log('Redis not configured, using memory cache');
    return;
  }
  try {
    redisClient = createRedisClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.warn('Redis error:', err.message));
    await redisClient.connect();
    redisConnected = true;
    console.log('Redis connected');
  } catch (err) {
    console.warn('Redis failed, using memory cache');
    redisConnected = false;
  }
}

async function getCache(key) {
  if (redisConnected && redisClient) {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  }
  const cached = memoryCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.data;
  return null;
}

async function setCache(key, data, ttlSeconds = 3600) {
  if (redisConnected && redisClient) {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(data));
  } else {
    memoryCache.set(key, { data, expiry: Date.now() + (ttlSeconds * 1000) });
  }
}

async function setUserSession(userId, platform, level) {
  await setCache(`session:${userId}:${platform}`, { level, lastActive: Date.now() }, 86400);
}

async function getUserSession(userId, platform) {
  const session = await getCache(`session:${userId}:${platform}`);
  return session ? session.level : null;
}

module.exports = { initRedis, getCache, setCache, setUserSession, getUserSession, redisConnected };
