// modules/cache.js
const crypto = require('crypto');

// =========================
// CONFIG
// =========================
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL || '3600'); // detik
const MAX_ITEMS = parseInt(process.env.CACHE_MAX_ITEMS || '2000');
const SEMANTIC_THRESHOLD = parseFloat(process.env.SEMANTIC_THRESHOLD || '0.92');
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL || '120000');
const MAX_VECTOR_ITEMS = parseInt(process.env.MAX_VECTOR_ITEMS || '1000');

// =========================
// UTILS
// =========================
function normalize(text = '') {
  return text.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function createKey({ prompt, model, intent = 'text' }) {
  const base = `${intent}:${model}:${normalize(prompt)}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] ** 2;
    magB += b[i] ** 2;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

// =========================
// MEMORY CACHE (LRU + TTL + SUMMARY)
// =========================
class MemoryCache {
  constructor(max = MAX_ITEMS) {
    this.store = new Map();
    this.max = max;
    this.hits = 0;
    this.misses = 0;

    setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  _evictLRU() {
    if (this.store.size < this.max) return;
    let oldestKey = null;
    let oldestTime = Date.now();

    for (const [k, v] of this.store.entries()) {
      if (v.lastAccess < oldestTime) {
        oldestTime = v.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey) this.store.delete(oldestKey);
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) {
      this.misses++;
      return null;
    }

    if (Date.now() > item.expiry) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    item.lastAccess = Date.now();
    return item.value;
  }

  set(key, value, ttl = DEFAULT_TTL) {
    this._evictLRU();
    this.store.set(key, {
      value,
      expiry: Date.now() + ttl * 1000,
      lastAccess: Date.now()
    });
  }

  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (now > v.expiry) this.store.delete(k);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      items: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? (this.hits / total * 100).toFixed(1) : 0
    };
  }

  // ========== MEMORY SUMMARY (HEMAT) ==========
  getMemorySummary() {
    const now = Date.now();
    let totalKeyBytes = 0;
    let totalValueBytes = 0;
    let validItems = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now <= entry.expiry) validItems++;
      totalKeyBytes += Buffer.byteLength(key, 'utf8');
      // Perkiraan size value: JSON string dari 'value' field
      const valueStr = JSON.stringify(entry.value);
      totalValueBytes += Buffer.byteLength(valueStr, 'utf8');
    }
    // Overhead per entry: Map + object (estimasi 48 byte)
    const overheadBytes = this.store.size * 48;
    const totalBytes = totalKeyBytes + totalValueBytes + overheadBytes;

    return {
      type: 'MemoryCache',
      maxItems: this.max,
      currentItems: this.store.size,
      validItems,
      expiredItems: this.store.size - validItems,
      estimatedMemoryKB: Math.round(totalBytes / 1024),
      utilizationPercent: Math.round((this.store.size / this.max) * 100),
      ...this.stats() // sertakan hit/miss
    };
  }
}

// =========================
// VECTOR STORE (SEMANTIC CACHE)
// =========================
class VectorStore {
  constructor(max = MAX_VECTOR_ITEMS) {
    this.items = [];
    this.max = max;
    this.hits = 0;
    this.misses = 0;
  }

  insert(item) {
    this.items.push(item);
    if (this.items.length > this.max) {
      // Hapus 10% tertua
      this.items.splice(0, Math.floor(this.max * 0.1));
    }
  }

  search(vec, threshold) {
    let best = null;

    for (const item of this.items) {
      const score = cosineSimilarity(vec, item.embedding);
      if (score >= threshold && (!best || score > best.score)) {
        best = { ...item, score };
      }
    }
    if (best) this.hits++;
    else this.misses++;
    return best;
  }

  getMemorySummary() {
    let totalBytes = 0;
    for (const item of this.items) {
      // Estimasi embedding (array of floats)
      totalBytes += Buffer.byteLength(JSON.stringify(item.embedding), 'utf8');
      totalBytes += Buffer.byteLength(item.prompt || '', 'utf8');
      totalBytes += Buffer.byteLength(JSON.stringify(item.response), 'utf8');
    }
    const totalKB = Math.round(totalBytes / 1024);
    const total = this.hits + this.misses;
    return {
      type: 'VectorStore',
      maxItems: this.max,
      currentItems: this.items.length,
      estimatedMemoryKB: totalKB,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? (this.hits / total * 100).toFixed(1) : 0
    };
  }
}

// =========================
// MAIN CACHE ORCHESTRATOR
// =========================
class AICache {
  constructor({
    embeddingFn = null,
    ttl = DEFAULT_TTL,
    semanticThreshold = SEMANTIC_THRESHOLD
  } = {}) {
    this.cache = new MemoryCache();
    this.vector = new VectorStore();
    this.embeddingFn = embeddingFn;
    this.ttl = ttl;
    this.semanticThreshold = semanticThreshold;

    this.stats = {
      total: 0,
      exactHits: 0,
      semanticHits: 0,
      llmCalls: 0
    };
  }

  async get({
    prompt,
    model,
    intent = 'text'
  }, callLLM) {

    this.stats.total++;

    const key = createKey({ prompt, model, intent });

    // L1 EXACT CACHE
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.exactHits++;
      return cached;
    }

    // L2 SEMANTIC (hanya untuk text, prompt cukup panjang)
    if (intent === 'text' && this.embeddingFn && prompt.length > 20) {
      try {
        const emb = await this.embeddingFn(prompt);
        const similar = this.vector.search(emb, this.semanticThreshold);
        if (similar) {
          this.stats.semanticHits++;
          // simpan ke exact cache agar next time langsung hit
          this.cache.set(key, similar.response, this.ttl);
          return similar.response;
        }
      } catch (e) {
        // skip silently
      }
    }

    // L3 LLM CALL
    this.stats.llmCalls++;
    const result = await callLLM();

    // normalisasi response
    const normalized = {
      type: 'text',
      content: result.content || result
    };

    // cost-aware TTL
    let finalTtl = this.ttl;
    if (model === 'gpt5') finalTtl *= 3;
    if (intent !== 'text') finalTtl = 300;

    this.cache.set(key, normalized, finalTtl);

    // simpan ke vector store jika memungkinkan
    if (this.embeddingFn && intent === 'text' && prompt.length > 20) {
      try {
        const emb = await this.embeddingFn(prompt);
        this.vector.insert({
          embedding: emb,
          response: normalized,
          prompt,
          model
        });
      } catch {}
    }

    return normalized;
  }

  getStats() {
    const total = this.stats.total;
    return {
      ...this.stats,
      hitRate: total
        ? ((this.stats.exactHits + this.stats.semanticHits) / total * 100).toFixed(1)
        : 0,
      memory: this.cache.stats()
    };
  }

  // ========== MEMORY SUMMARY LENGKAP ==========
  async getMemorySummary() {
    const cacheSummary = this.cache.getMemorySummary();
    const vectorSummary = this.vector.getMemorySummary();

    const totalMemoryKB = (cacheSummary.estimatedMemoryKB || 0) + (vectorSummary.estimatedMemoryKB || 0);
    const totalRequests = this.stats.total;
    const totalHits = this.stats.exactHits + this.stats.semanticHits;

    return {
      timestamp: new Date().toISOString(),
      totalEstimatedMemoryKB: totalMemoryKB,
      totalEstimatedMemoryMB: (totalMemoryKB / 1024).toFixed(2),
      cache: cacheSummary,
      vectorStore: vectorSummary,
      performance: {
        totalRequests,
        exactHits: this.stats.exactHits,
        semanticHits: this.stats.semanticHits,
        llmCalls: this.stats.llmCalls,
        effectiveHitRate: totalRequests
          ? ((totalHits / totalRequests) * 100).toFixed(1)
          : 0
      }
    };
  }
}

// =========================
// EXPORT SINGLETON
// =========================
let instance = null;

function initCache(opts = {}) {
  if (!instance) {
    instance = new AICache(opts);
  }
  return instance;
}

module.exports = { initCache };
