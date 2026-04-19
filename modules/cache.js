// modules/cache.js
const { createClient: createRedisClient } = require('redis');

let redisClient = null;
let redisConnected = false;
const memoryStore = new Map();

// Cleanup memory cache setiap jam (untuk fallback)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (now > entry.expiry) memoryStore.delete(key);
  }
}, 60 * 60 * 1000);

async function initRedis() {
  // Jika Redis sudah terkoneksi, kembalikan objek cache yang memakai Redis
  if (redisClient && redisConnected) {
    return {
      get: async (key) => {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
      },
      set: async (key, value, ttl = 3600) => {
        await redisClient.setEx(key, ttl, JSON.stringify(value));
      },
      cleanup: async () => {
        // Redis tidak perlu cleanup manual
      },
      quit: async () => {
        if (redisClient) await redisClient.quit();
      }
    };
  }

  // Jika tidak ada konfigurasi Redis, langsung pakai memory
  if (!process.env.REDIS_URL) {
    console.log('Redis not configured, using memory cache');
    return createMemoryCache();
  }

  // Coba konek ke Redis
  try {
    redisClient = createRedisClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.warn('Redis error:', err.message));
    await redisClient.connect();
    redisConnected = true;
    console.log('Redis connected');
    return {
      get: async (key) => {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
      },
      set: async (key, value, ttl = 3600) => {
        await redisClient.setEx(key, ttl, JSON.stringify(value));
      },
      cleanup: async () => {},
      quit: async () => {
        if (redisClient) await redisClient.quit();
      }
    };
  } catch (err) {
    console.warn('Redis failed, using memory cache', err.message);
    return createMemoryCache();
  }
}

function createMemoryCache() {
  return {
    get: async (key) => {
      const entry = memoryStore.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiry) {
        memoryStore.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key, value, ttl = 3600) => {
      memoryStore.set(key, {
        value,
        expiry: Date.now() + ttl * 1000
      });
    },
    cleanup: async () => {
      const now = Date.now();
      for (const [key, entry] of memoryStore.entries()) {
        if (now > entry.expiry) memoryStore.delete(key);
      }
      console.log('Memory cache cleaned');
    },
    quit: async () => {
      memoryStore.clear();
    }
  };
}

module.exports = { initRedis };
