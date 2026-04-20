// ai-cache.js
const crypto = require('crypto');

// =========================
// KONFIGURASI (env)
// =========================
const MAX_MEMORY_ITEMS = parseInt(process.env.MAX_MEMORY_ITEMS || '2000');    // lebih kecil karena Redis diprioritaskan
const MAX_VECTOR_ITEMS = parseInt(process.env.MAX_VECTOR_ITEMS || '1500');
const DEFAULT_TTL = parseInt(process.env.DEFAULT_TTL || '3600');
const SEMANTIC_THRESHOLD = parseFloat(process.env.SEMANTIC_THRESHOLD || '0.92');
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '120000');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// =========================
// LOGGER
// =========================
const log = (level, message, data = null) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  if (levels[level] <= levels[LOG_LEVEL]) {
    const emoji = { error: '❌', warn: '⚠️', info: 'ℹ️', debug: '🔍', hit: '⚡', semantic: '🧠' };
    console.log(`${emoji[level] || '📦'} [${level.toUpperCase()}] ${message}`, data ? JSON.stringify(data) : '');
  }
};

// =========================
// UTILS
// =========================
function safeParse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

function normalizePrompt(text = '') {
  return text.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function createCacheKey({ prompt, model }) {
  const normalized = normalizePrompt(prompt);
  return crypto.createHash('sha256').update(`${model}:${normalized}`).digest('hex');
}

function validateEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('Invalid embedding');
  return true;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] ** 2;
    magB += b[i] ** 2;
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  return magA && magB ? dot / (magA * magB) : 0;
}

// =========================
// MEMORY CACHE (fallback)
// =========================
class MemoryCache {
  constructor(maxItems = MAX_MEMORY_ITEMS) {
    this.cache = new Map();
    this.maxItems = maxItems;
    this.interval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  _evictLRU() {
    if (this.cache.size < this.maxItems) return;
    let oldestKey = null, oldestTime = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  async get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    entry.lastAccessed = Date.now();
    return entry.value;
  }

  async set(key, value, ttl = DEFAULT_TTL) {
    this._evictLRU();
    this.cache.set(key, { value, expiry: Date.now() + ttl * 1000, lastAccessed: Date.now() });
  }

  async delete(key) { this.cache.delete(key); }
  async clear() { this.cache.clear(); }
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) this.cache.delete(key);
    }
  }
  async quit() { clearInterval(this.interval); this.cache.clear(); }
}

// =========================
// VECTOR STORE (in-memory)
// =========================
class VectorStore {
  constructor(maxItems = MAX_VECTOR_ITEMS) {
    this.items = [];
    this.maxItems = maxItems;
  }

  async search(queryVector, threshold = SEMANTIC_THRESHOLD) {
    let best = null;
    for (const item of this.items) {
      const score = cosineSimilarity(queryVector, item.embedding);
      if (score >= threshold && (!best || score > best.score)) {
        best = { ...item, score };
      }
    }
    return best;
  }

  async insert(data) {
    this.items.push(data);
    if (this.items.length > this.maxItems) {
      this.items.splice(0, Math.floor(this.maxItems * 0.1));
    }
  }

  async clear() { this.items = []; }
  size() { return this.items.length; }
}

// =========================
// REDIS WRAPPER (dengan reconnect & fallback)
// =========================
function createRedisWrapper(redisClient) {
  return {
    get: async (key) => {
      const data = await redisClient.get(key);
      return data ? safeParse(data) : null;
    },
    set: async (key, value, ttl = DEFAULT_TTL) => {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
    },
    delete: async (key) => { await redisClient.del(key); },
    quit: async () => { await redisClient.quit(); },
  };
}

// =========================
// CACHE ORCHESTRATOR
// =========================
class AICache {
  constructor(options) {
    this.cache = options.cache;           // Redis wrapper atau MemoryCache
    this.vectorStore = options.vectorStore || new VectorStore();
    this.embeddingFn = options.embeddingFn || null;
    this.ttl = options.ttl || DEFAULT_TTL;
    this.semanticThreshold = options.semanticThreshold || SEMANTIC_THRESHOLD;
    this.slidingTtl = options.slidingTtl || false;
  }

  async get(prompt, model, callLLM) {
    const key = createCacheKey({ prompt, model });

    // L1: Exact cache
    const exact = await this.cache.get(key);
    if (exact) {
      log('hit', `Exact cache hit for ${model}`, { promptPreview: prompt.slice(0, 50) });
      if (this.slidingTtl) await this.cache.set(key, exact, this.ttl);
      return exact;
    }

    // L2: Semantic cache
    let embedding = null;
    if (this.embeddingFn) {
      try {
        embedding = await this.embeddingFn(prompt);
        validateEmbedding(embedding);
        const similar = await this.vectorStore.search(embedding, this.semanticThreshold);
        if (similar) {
          log('semantic', 'Semantic cache hit', { score: similar.score, original: similar.prompt.slice(0, 50) });
          // Simpan ke exact cache untuk next time
          await this.cache.set(key, similar.response, this.ttl);
          return similar.response;
        }
      } catch (err) {
        log('warn', 'Embedding error, skip semantic', err.message);
      }
    }

    // L3: LLM call
    log('info', `Cache miss → calling LLM (${model})`);
    const response = await callLLM(prompt);

    // Simpan ke exact cache
    await this.cache.set(key, response, this.ttl);

    // Simpan ke vector store jika embedding tersedia
    if (embedding) {
      await this.vectorStore.insert({ embedding, response, prompt, model, timestamp: Date.now() });
    }

    return response;
  }

  async stats() {
    let cacheSize = 0;
    if (this.cache.cache && this.cache.cache instanceof Map) cacheSize = this.cache.cache.size;
    else if (typeof this.cache.size === 'function') cacheSize = await this.cache.size();
    return {
      cacheType: this.cache.constructor.name,
      vectorSize: this.vectorStore.size(),
      exactSize: cacheSize,
    };
  }

  async quit() {
    if (this.cache.quit) await this.cache.quit();
    await this.vectorStore.clear();
  }
}

// =========================
// INISIALISASI UTAMA (dengan Redis prioritas)
// =========================
let globalCacheInstance = null;

async function initCache(options = {}) {
  if (globalCacheInstance) return globalCacheInstance;

  const {
    redisUrl = process.env.REDIS_URL,
    embeddingFn = null,
    ttl = DEFAULT_TTL,
    semanticThreshold = SEMANTIC_THRESHOLD,
    slidingTtl = false,
  } = options;

  let cache = null;

  // 1. Coba Redis jika URL ada
  if (redisUrl) {
    try {
      const { createClient } = require('redis');
      const redisClient = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 3) {
              log('warn', 'Redis reconnect failed after 3 attempts, fallback to memory');
              return new Error('Stop reconnecting');
            }
            return Math.min(retries * 100, 3000);
          },
        },
      });

      redisClient.on('error', (err) => log('warn', 'Redis error', err.message));
      
      await redisClient.connect();
      log('info', '✅ Redis connected, using Redis as primary cache');
      cache = createRedisWrapper(redisClient);
    } catch (err) {
      log('warn', 'Redis connection failed, falling back to memory cache', err.message);
    }
  }

  // 2. Fallback ke memory cache
  if (!cache) {
    log('info', '📦 Using in-memory cache (Railway free safe)');
    cache = new MemoryCache(MAX_MEMORY_ITEMS);
  }

  const vectorStore = new VectorStore(MAX_VECTOR_ITEMS);

  globalCacheInstance = new AICache({
    cache,
    vectorStore,
    embeddingFn,
    ttl,
    semanticThreshold,
    slidingTtl,
  });

  return globalCacheInstance;
}

module.exports = { initCache, AICache, MemoryCache, VectorStore, createCacheKey, cosineSimilarity };
