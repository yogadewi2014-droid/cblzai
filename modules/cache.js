// modules/chat-processor.js
const { callWithFallback } = require('./ai-model');
const { processImageInput } = require('./ocr');
const { getGreetingResponse } = require('./greetings');
const { SerperIntegration } = require('./serper-integration');
const { MemoryCache } = require('./cache'); // import MemoryCache dari cache.js

// ==========================
// RATE LIMITING (per user)
// ==========================
const userRateLimit = new Map(); // userId -> { count, resetTime }

function checkRateLimit(userId, isPremium = false) {
  const limit = isPremium ? 100 : 20; // request per jam
  const now = Date.now();
  const record = userRateLimit.get(userId);
  if (!record || now > record.resetTime) {
    userRateLimit.set(userId, { count: 1, resetTime: now + 3600000 });
    return true;
  }
  if (record.count >= limit) return false;
  record.count++;
  return true;
}

// ==========================
// DETEKSI INTENT (sederhana)
// ==========================
function detectIntent(messages) {
  const last = messages.filter(m => m.role === 'user').pop();
  const text = (last?.content || '').toLowerCase();
  if (/skripsi|tesis|bab\s?[1-5]|metodologi/.test(text)) return 'thesis';
  if (/makalah|jurnal|sinta|scopus/.test(text)) return 'journalPaper';
  if (/berita|opini|editorial/.test(text)) return 'newsOpinion';
  if (/cerita|dongeng|artikel/.test(text)) return 'articleStory';
  if (/coding|program|debug|api|javascript|python/.test(text)) return 'coding';
  if (/hitung|integral|turunan|limit/.test(text)) return 'mathHard';
  return 'general';
}

// ==========================
// TENTUKAN MODE
// ==========================
function determineMode(level, message) {
  const lowerMsg = message.toLowerCase();
  if (level === 'mahasiswa' && (lowerMsg.includes('skripsi') || lowerMsg.includes('tesis'))) return 'thesis';
  if (lowerMsg.includes('artikel') || lowerMsg.includes('tulisan') || lowerMsg.includes('cerita')) return 'article';
  if (level === 'mahasiswa' && (lowerMsg.includes('jurnal') || lowerMsg.includes('makalah'))) return 'academic';
  return 'learning';
}

function mapLevel(level) {
  if (level === 'sd_smp') return 'smp';
  return level;
}

// ==========================
// PROSES CHAT UTAMA
// ==========================
async function processChat(userId, platform, level, message, imageUrl = null, isPDF = false, pageCount = 1, db) {
  // 1. Rate limiting
  const isPremium = false; // TODO: ambil dari database berdasarkan userId
  if (!checkRateLimit(userId, isPremium)) {
    return {
      success: true,
      content: "Batas permintaan per jam tercapai (20 untuk free, 100 untuk premium). Silakan coba lagi nanti.",
      model: 'system'
    };
  }

  // 2. Handle gambar/PDF (sama seperti sebelumnya)
  if (imageUrl) {
    let targetModel = 'gptMini';
    if (level === 'sd_smp') targetModel = 'deepseekV32';
    else if (level === 'sma') targetModel = 'deepseekV32';
    else if (level === 'mahasiswa') targetModel = 'deepseekReasoning';
    else targetModel = 'gpt5';
    const imageResult = await processImageInput(imageUrl, message, targetModel, level, isPDF, pageCount);
    if (imageResult.success) return { success: true, content: imageResult.content, model: targetModel };
    return { success: true, content: imageResult.content, model: 'system', isFallback: true };
  }

  // 3. Handle sapaan
  const greetingResponse = getGreetingResponse(message, level);
  if (greetingResponse) return { success: true, content: greetingResponse, model: 'system' };

  try {
    // 4. Inisialisasi MemoryCache (exact match) dengan TTL 1 jam, max 1000 items
    const cache = new MemoryCache(1000);
    const cacheKey = `chat:${level}:${message}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE] Hit untuk key: ${cacheKey}`);
      return cached;
    }

    // 5. Ambil history dari database
    const history = await db.getChatHistory(userId, platform, 5);
    const messages = [];
    for (const h of history) {
      messages.push({ role: h.role, content: h.content.substring(0, 500) });
    }
    messages.push({ role: 'user', content: message });

    const intent = detectIntent(messages);
    let mode = determineMode(level, message);
    const isFree = true; // TODO: ambil dari database

    // 6. Serper integration (dengan cache internal)
    const serper = new SerperIntegration(process.env.SERPER_API_KEY);
    let webContext = null;
    const needSerper = serper.shouldUseSerper(intent, mode, message);
    if (needSerper) {
      webContext = await serper.fetchAndFormat(intent, message);
    }

    // 7. Panggil AI
    const result = await callWithFallback({
      messages,
      level: mapLevel(level),
      mode,
      isPremium,
      isFree,
      webContext
    });

    // 8. Simpan ke cache dan database
    if (result.success && message.length > 3 && result.content.length > 10) {
      cache.set(cacheKey, result, 3600); // TTL 1 jam
      await db.saveChatMessage(userId, platform, 'user', message.substring(0, 500), 'unknown');
      await db.saveChatMessage(userId, platform, 'assistant', result.content.substring(0, 1000), result.model || 'unknown');
    }

    return result;
  } catch (error) {
    console.error('Error proses chat:', error);
    return {
      success: true,
      content: "Maaf, terjadi kesalahan. Silakan coba lagi.",
      model: 'system'
    };
  }
}

module.exports = { processChat };
