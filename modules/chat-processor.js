// modules/chat-processor.js (versi lengkap dengan perbaikan)
const { callWithFallback } = require('./ai-model');
const { processImageInput } = require('./ocr');
const { getGreetingResponse } = require('./greetings');
const { SerperIntegration } = require('./serper-integration');
const { MemoryCache } = require('./cache');

// ==========================
// SINGLETON CACHE (global)
// ==========================
const globalCache = new MemoryCache(1000);

// ==========================
// RATE LIMITING
// ==========================
const userRateLimit = new Map();

function checkRateLimit(userId, isPremium = false) {
  const limit = isPremium ? 100 : 20;
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
// DETEKSI INTENT (opsional: bisa pakai dari ai-model atau tetap sendiri)
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
  const startTime = Date.now();

  // Rate limiting
  const isPremium = false;
  if (!checkRateLimit(userId, isPremium)) {
    return {
      success: true,
      content: "Batas permintaan per jam tercapai (20 untuk free, 100 untuk premium). Silakan coba lagi nanti.",
      model: 'system'
    };
  }

  // Handle gambar/PDF
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

  // Handle sapaan
  const greetingResponse = getGreetingResponse(message, level);
  if (greetingResponse) return { success: true, content: greetingResponse, model: 'system' };

  try {
    // Cache exact match (global)
    const cacheKey = `chat:${level}:${message}`;
    const cached = globalCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE] Hit untuk key: ${cacheKey}`);
      return cached;
    }

    // Ambil history dari database
    const history = await db.getChatHistory(userId, platform, 5);
    const messages = [];
    for (const h of history) {
      messages.push({ role: h.role, content: h.content.substring(0, 500) });
    }
    messages.push({ role: 'user', content: message });

    const intent = detectIntent(messages);
    let mode = determineMode(level, message);
    const isFree = true;

    // Serper integration
    const serper = new SerperIntegration(process.env.SERPER_API_KEY);
    let webContext = null;
    const needSerper = serper.shouldUseSerper(intent, mode, message);
    if (needSerper) {
      webContext = await serper.fetchAndFormat(intent, message);
    }

    // Panggil AI
    const result = await callWithFallback({
      messages,
      level: mapLevel(level),
      mode,
      isPremium,
      isFree,
      webContext
    });

    // Simpan ke cache dan database
    if (result.success && message.length > 3 && result.content && result.content.length > 10) {
      globalCache.set(cacheKey, result, 3600);
      await db.saveChatMessage(userId, platform, 'user', message.substring(0, 500), 'unknown');
      await db.saveChatMessage(userId, platform, 'assistant', result.content.substring(0, 1000), result.model || 'unknown');
    }

    console.log(`[INFO] ✅ Completed in ${Date.now() - startTime}ms`);
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
