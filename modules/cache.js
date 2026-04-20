// ai-cache.js
const crypto = require('crypto');

// =========================
// CONFIGURATION (via env)
// =========================
const MAX_MEMORY_ITEMS = parseInt(process.env.MAX_MEMORY_ITEMS || '5000');
const MAX_VECTOR_ITEMS = parseInt(process.env.MAX_VECTOR_ITEMS || '2000');
const DEFAULT_TTL = parseInt(process.env.DEFAULT_TTL || '3600');
const SEMANTIC_THRESHOLD = parseFloat(process.env.SEMANTIC_THRESHOLD || '0.92');
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '60000');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// =========================
// SIMPLE LOGGER
// =========================
const LOG_PREFIX = {
  error: '❌',
  warn: '⚠️',
  info: 'ℹ️',
  debug: '🐛',
  hit: '⚡',
  semantic: '🧠',
};

function log(level, message, meta = '') {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  if (levels[level] <= levels[LOG_LEVEL]) {
    const prefix = LOG_PREFIX[level] || LOG_PREFIX.info;
    console.log(`${prefix} [${level.toUpperCase()}] ${message}`, meta ? JSON.stringify(meta) : '');
  }
}

// =========================
// UTILS
// =========================
function safeParse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function normalizePrompt(text = '') {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

function createCacheKey({ prompt, model }) {
  const normalized = normalizePrompt(prompt);
  return crypto
    .createHash('sha256')
    .update(`${model}:${normalized}`)
    .digest('hex');
}

// Validasi vektor embedding
function validateEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding must be a non-empty array');
  }
  // Opsional: cek semua number
  for (const v of embedding) {
    if (typeof v !== 'number') throw new Error('Embedding must contain numbers');
  }
  return true;
}

// Cosine similarity dengan normalisasi otomatis
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
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// =========================
// IN-MEMORY CACHE (LRU + TTL)
// =========================
class MemoryCache {
  constructor(maxItems = MAX_MEMORY_ITEMS) {
    this.cache = new Map(); // key -> { value, expiry, lastAccessed }
    this.maxItems = maxItems;
    this.interval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  _removeLeastRecentlyUsed() {
    if (this.cache.size < this.maxItems) return;
    let oldestKey = null;
    let oldestTime = Date.now();
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
    this._removeLeastRecentlyUsed();
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl * 1000,
      lastAccessed: Date.now(),
    });
  }

  async delete(key) {
    this.cache.delete(key);
  }

  async clear() {
    this.cache.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) this.cache.delete(key);
    }
  }

  async quit() {
    clearInterval(this.interval);
    this.cache.clear();
  }
}

// =========================
// VECTOR STORE (LRU + TTL sederhana)
// =========================
class VectorStore {
  constructor(maxItems = MAX_VECTOR_ITEMS) {
    this.items = []; // akan di-maintain sebagai array dengan maxItems
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
      // Hapus 10% paling lama (bisa pakai FIFO sederhana)
      const removeCount = Math.floor(this.maxItems * 0.1);
      this.items.splice(0, removeCount);
    }
  }

  async clear() {
    this.items = [];
  }

  size() {
    return this.items.length;
  }
}

// =========================
// REDIS WRAPPER (optional)
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
    delete: async (key) => {
      await redisClient.del(key);
    },
    quit: async () => {
      await redisClient.quit();
    },
  };
}

// =========================
// CACHE ORCHESTRATOR (MAIN)
// =========================
class AICache {
  constructor(options = {}) {
    this.cache = options.cache; // harus sudah diinisialisasi
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
      log('hit', 'Exact cache hit', { prompt: prompt.slice(0, 50) });
      if (this.slidingTtl) {
        await this.cache.set(key, exact, this.ttl);
      }
      return exact;
    }

    // L2: Semantic cache (hanya jika embeddingFn tersedia)
    let embedding = null;
    if (this.embeddingFn) {
      try {
        embedding = await this.embeddingFn(prompt);
        validateEmbedding(embedding);
        const similar = await this.vectorStore.search(embedding, this.semanticThreshold);
        if (similar) {
          log('semantic', 'Semantic cache hit', { score: similar.score, originalPrompt: similar.prompt });
          // Opsional: simpan juga ke exact cache untuk下次
          await this.cache.set(key, similar.response, this.ttl);
          return similar.response;
        }
      } catch (err) {
        log('warn', 'Embedding failed, skipping semantic cache', err.message);
      }
    }

    // L3: Call LLM
    log('info', 'Calling LLM (cache miss)', { prompt: prompt.slice(0, 50) });
    const response = await callLLM(prompt);

    // Simpan ke exact cache
    await this.cache.set(key, response, this.ttl);

    // Simpan ke vector store jika embedding berhasil
    if (embedding) {
      await this.vectorStore.insert({
        embedding,
        response,
        prompt,
        model,
        timestamp: Date.now(),
      });
    }

    return response;
  }

  async stats() {
    let cacheSize = 0;
    if (this.cache && typeof this.cache.size === 'function') {
      cacheSize = await this.cache.size();
    } else if (this.cache && this.cache.cache && this.cache.cache instanceof Map) {
      cacheSize = this.cache.cache.size;
    }
    return {
      cacheType: this.cache.constructor.name,
      vectorStoreSize: this.vectorStore.size(),
      exactCacheSize: cacheSize,
    };
  }

  async quit() {
    if (this.cache && this.cache.quit) await this.cache.quit();
    if (this.vectorStore) await this.vectorStore.clear();
  }
}

// =========================
// INITIALIZATION (with Redis fallback)
// =========================
async function initCache(options = {}) {
  const {
    redisUrl = process.env.REDIS_URL,
    maxMemoryItems = MAX_MEMORY_ITEMS,
    maxVectorItems = MAX_VECTOR_ITEMS,
    slidingTtl = false,
  } = options;

  let cache;

  // Coba Redis jika URL tersedia
  if (redisUrl) {
    try {
      const { createClient } = require('redis');
      const redisClient = createClient({ url: redisUrl });
      redisClient.on('error', (err) => log('warn', 'Redis error', err.message));
      await redisClient.connect();
      log('info', 'Redis connected, using Redis cache');
      cache = createRedisWrapper(redisClient);
    } catch (err) {
      log('warn', 'Redis connection failed, falling back to memory cache', err.message);
    }
  }

  if (!cache) {
    log('info', 'Using in-memory cache (Railway free compatible)');
    cache = new MemoryCache(maxMemoryItems);
  }

  const vectorStore = new VectorStore(maxVectorItems);

  return new AICache({
    cache,
    vectorStore,
    embeddingFn: options.embeddingFn || null,
    ttl: options.ttl || DEFAULT_TTL,
    semanticThreshold: options.semanticThreshold || SEMANTIC_THRESHOLD,
    slidingTtl,
  });
}

// =========================
// EXPORTS
// =========================
module.exports = {
  initCache,
  AICache,
  MemoryCache,
  VectorStore,
  createCacheKey,
  normalizePrompt,
  cosineSimilarity,
};
