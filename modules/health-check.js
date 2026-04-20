// modules/health-check.js
const { MemoryCache } = require('./cache');
const { SerperIntegration } = require('./serper-integration');
const { callWithFallback, detectIntent } = require('./ai-model');

/**
 * Cek semua modul secara inline
 * @returns {Promise<Object>} Status tiap modul
 */
async function checkAllModules() {
  const results = {
    timestamp: new Date().toISOString(),
    cache: { status: 'unknown', message: '' },
    rateLimiting: { status: 'unknown', message: '' },
    serper: { status: 'unknown', message: '' },
    aiModel: { status: 'unknown', message: '' }
  };

  // 1. Cek MemoryCache
  try {
    const cache = new MemoryCache(10);
    const testKey = 'test:key';
    const testValue = { test: 'data' };
    cache.set(testKey, testValue, 60);
    const retrieved = cache.get(testKey);
    if (retrieved && retrieved.test === 'data') {
      results.cache = { status: 'ok', message: 'MemoryCache berfungsi' };
    } else {
      results.cache = { status: 'error', message: 'Gagal get/set cache' };
    }
  } catch (err) {
    results.cache = { status: 'error', message: err.message };
  }

  // 2. Cek Rate Limiting (simulasi)
  try {
    const { checkRateLimit } = require('../chat-processor'); // sementara, nanti refactor
    // Karena checkRateLimit ada di chat-processor, kita bisa panggil dengan userId dummy
    const isAllowed = checkRateLimit('test-user', false);
    if (typeof isAllowed === 'boolean') {
      results.rateLimiting = { status: 'ok', message: 'Rate limiting berfungsi' };
    } else {
      results.rateLimiting = { status: 'error', message: 'Rate limiting tidak mengembalikan boolean' };
    }
  } catch (err) {
    results.rateLimiting = { status: 'error', message: err.message };
  }

  // 3. Cek Serper (jika API key tersedia)
  if (process.env.SERPER_API_KEY) {
    try {
      const serper = new SerperIntegration(process.env.SERPER_API_KEY);
      const testQuery = 'test';
      const result = await serper.fetchAndFormat('newsOpinion', testQuery);
      if (result && result.length > 0) {
        results.serper = { status: 'ok', message: 'Serper merespon' };
      } else {
        results.serper = { status: 'warning', message: 'Serper tidak mengembalikan data (mungkin kuota habis)' };
      }
    } catch (err) {
      results.serper = { status: 'error', message: err.message };
    }
  } else {
    results.serper = { status: 'skipped', message: 'SERPER_API_KEY tidak diset' };
  }

  // 4. Cek AI Model (panggilan dummy ringan)
  try {
    const dummyMessages = [{ role: 'user', content: 'Halo' }];
    const result = await callWithFallback({
      messages: dummyMessages,
      level: 'sma',
      mode: 'learning',
      isPremium: false,
      isFree: true,
      webContext: null
    });
    if (result.success && result.content) {
      results.aiModel = { status: 'ok', message: 'AI merespon' };
    } else {
      results.aiModel = { status: 'error', message: 'AI tidak merespon dengan sukses' };
    }
  } catch (err) {
    results.aiModel = { status: 'error', message: err.message };
  }

  return results;
}

module.exports = { checkAllModules };
