// modules/ai-model.js
const axios = require('axios');
const { CONFIG } = require('../config');

// ==========================
// KONSTANTA
// ==========================
const ALLOWED_MODE_LEVEL = {
  thesis: ['mahasiswa'],
  academic: ['mahasiswa', 'sma'],
  article: ['mahasiswa', 'sma', 'smp'],
  learning: ['sd', 'smp', 'sma', 'mahasiswa']
};

const INTENT_PATTERNS = {
  thesis: /\b(skripsi|tesis|bab\s?[1-5]|metodologi)\b/i,
  journalPaper: /\b(makalah|jurnal|sinta|scopus)\b/i,
  newsOpinion: /\b(berita|opini|editorial)\b/i,
  articleStory: /\b(cerita|dongeng|artikel)\b/i,
  coding: /\b(coding|program|debug|api|javascript|python|react|error\s+code)\b/i,
  mathHard: /\b(hitung|integral|turunan|limit(?![a-z])|diferensial)\b/i
};

// ==========================
// DETEKSI INTENT
// ==========================
function detectIntent(messages = []) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return 'general';
  const text = lastUserMsg.content.toLowerCase();

  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(text)) return intent;
  }
  return 'general';
}

// ==========================
// VALIDASI MODE + LEVEL
// ==========================
function validateModeLevel(mode, level) {
  const allowed = ALLOWED_MODE_LEVEL[mode];
  if (!allowed) return `Mode '${mode}' tidak dikenal.`;
  if (!allowed.includes(level)) {
    return `Mode '${mode}' tidak tersedia untuk level '${level}'.`;
  }
  return null;
}

// ==========================
// PEMILIH MODEL & KATEGORI TOKEN
// ==========================
function getDecision({ level, intent, mode, isPremium }) {
  // Blokir jika mode tidak cocok dengan intent
  if (mode === 'thesis' && intent !== 'thesis') {
    return { blocked: true, message: "Mode skripsi hanya untuk penulisan skripsi." };
  }
  if (mode === 'academic' && intent !== 'journalPaper') {
    return { blocked: true, message: "Mode akademik hanya untuk makalah atau jurnal." };
  }
  if (mode === 'article' && !['newsOpinion', 'articleStory'].includes(intent)) {
    return { blocked: true, message: "Mode artikel hanya untuk berita atau opini." };
  }

  // Pemilihan default berdasarkan level
  let model;
  let tokenCategory = 'standard';

  if (level === 'sd' || level === 'smp') {
    model = 'geminiFlashLite';
  } else if (level === 'sma') {
    if (intent === 'mathHard' || intent === 'coding') {
      model = 'deepseekReasoning';
      tokenCategory = 'reasoning';
    } else {
      model = 'geminiFlashLite';
    }
  } else if (level === 'mahasiswa') {
    if (intent === 'mathHard' || intent === 'coding') {
      model = 'deepseekReasoning';
      tokenCategory = 'reasoning';
    } else {
      model = 'gptMini';
    }
  } else {
    model = 'gptMini';
  }

  // Override berdasarkan mode
  if (mode === 'thesis') {
    model = 'gpt5';
    tokenCategory = isPremium ? 'academic_long' : 'academic_short';
  } else if (mode === 'academic') {
    model = 'gpt5';
    tokenCategory = isPremium ? 'academic_long' : 'academic_short';
  } else if (mode === 'article') {
    model = 'gpt5';
    tokenCategory = 'article';
  }

  return { blocked: false, model, tokenCategory };
}

// ==========================
// RESOLVE MAKSIMAL TOKEN
// ==========================
function resolveMaxTokens({ level, tokenCategory, isFree, isPremium }) {
  const style = CONFIG.answerStyle[level] || CONFIG.answerStyle.sma;
  let maxTokens = style.maxTokens;

  switch (tokenCategory) {
    case 'article':
      maxTokens = style.maxTokensArticle || 1500;
      break;
    case 'academic_short':
      maxTokens = 800;
      break;
    case 'academic_long':
      maxTokens = 4000;
      break;
    case 'reasoning':
      maxTokens = Math.min(style.maxTokens, 2000);
      break;
    default:
      // standard tetap pakai style.maxTokens
      break;
  }

  // Pembatasan untuk mahasiswa free
  if (isFree && level === 'mahasiswa') {
    const original = maxTokens;
    maxTokens = Math.min(maxTokens, 500);
    if (original > 500) {
      console.warn(`[TOKEN] Clamped from ${original} to 500 for free mahasiswa`);
    }
  }

  // Peringatan jika premium tapi token kecil
  if (isPremium && maxTokens < 1000 && tokenCategory !== 'article') {
    console.warn(`[TOKEN] Premium user but maxTokens=${maxTokens} – consider increasing`);
  }

  return maxTokens;
}

// ==========================
// INJEKSI PROMPT SISTEM (TANPA DUPLIKASI)
// ==========================
function injectPrompt(messages, mode, level, isFree) {
  let systemPrompt = '';

  if (mode === 'article') {
    systemPrompt = `Tulis artikel dengan gaya jurnalistik/opini, menarik dan natural, serta memiliki pembuka, isi, penutup. Gunakan data terkini jika tersedia.`;
  } else if (mode === 'academic') {
    systemPrompt = `Tulis secara ilmiah, formal, objektif, dengan struktur jurnal lengkap (pendahuluan, metode, hasil, kesimpulan). Siap untuk SINTA/Scopus. Jika ada data dari web, gunakan sebagai referensi.`;
  } else if (mode === 'thesis') {
    systemPrompt = `Anda adalah pembimbing skripsi. Tulis sangat terstruktur, akademik, dan berikan referensi jika diperlukan.`;
  } else {
    // default untuk learning
    systemPrompt = `Anda adalah asisten AI Indonesia yang ramah, ceria, natural, hangat, dan membantu.`;
    if (level === 'sd' || level === 'smp') {
      systemPrompt += ` Anda guru SD/SMP yang ramah dan sabar. Gunakan bahasa sederhana, kalimat pendek.`;
    } else if (level === 'sma') {
      systemPrompt += ` Anda adalah guru SMA yang jelas dan komunikatif. Berikan penjelasan runtut.`;
    } else if (level === 'mahasiswa') {
      systemPrompt += ` Anda adalah asisten akademik untuk mahasiswa. Gunakan gaya profesional.`;
    }
  }

  if (isFree && level === 'mahasiswa') {
    systemPrompt += `\nBatasi jawaban maksimal 500 token.`;
  }

  // Cegah duplikasi system prompt
  const hasSystem = messages.some(m => m.role === 'system');
  if (systemPrompt && !hasSystem) {
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }
  return messages;
}

// ==========================
// PANGGIL API AI (DENGAN TIMEOUT)
// ==========================
async function callAI(modelName, messages, maxTokens, timeoutMs = null) {
  const model = CONFIG.ai[modelName];
  if (!model || !model.key || !model.url) {
    console.error(`[AI] Model ${modelName} not configured properly`);
    return { success: false, error: `Model ${modelName} not configured` };
  }

  try {
    const res = await axios.post(
      model.url,
      {
        model: model.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      },
      {
        headers: { Authorization: `Bearer ${model.key}` },
        timeout: timeoutMs || model.timeout || 30000
      }
    );

    return {
      success: true,
      content: res.data.choices[0].message.content,
      model: modelName
    };
  } catch (err) {
    console.error(`[AI] Error (${modelName}): ${err.message}`);
    return { success: false, error: err.message, model: modelName };
  }
}

// ==========================
// FALLBACK CERDAS (JEDA + ADAPTASI TOKEN)
// ==========================
async function callWithIntelligentFallback({
  primaryModel,
  fallbackModels,
  messages,
  originalMaxTokens,
  tokenCategory,
  level,
  isFree,
  isPremium
}) {
  // Coba model utama
  let result = await callAI(primaryModel, messages, originalMaxTokens);
  if (result.success) return result;

  console.log(`[FALLBACK] Model ${primaryModel} gagal: ${result.error}. Mencoba fallback...`);

  for (let i = 0; i < fallbackModels.length; i++) {
    const modelName = fallbackModels[i];
    const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
    console.log(`[FALLBACK] Menunggu ${delay/1000} detik sebelum mencoba ${modelName}`);
    await new Promise(resolve => setTimeout(resolve, delay));

    // Adaptasi token untuk fallback
    let fallbackTokenCategory = tokenCategory;
    if (tokenCategory === 'academic_long') fallbackTokenCategory = 'academic_short';
    if (tokenCategory === 'reasoning') fallbackTokenCategory = 'standard';

    const fallbackMaxTokens = resolveMaxTokens({
      level,
      tokenCategory: fallbackTokenCategory,
      isFree,
      isPremium
    });

    console.log(`[FALLBACK] Mencoba ${modelName} dengan ${fallbackMaxTokens} token`);
    result = await callAI(modelName, messages, fallbackMaxTokens);
    if (result.success) {
      console.log(`[FALLBACK] Berhasil menggunakan ${modelName}`);
      return result;
    }
  }

  return { success: false, error: 'Semua model gagal' };
}

// ==========================
// FUNGSI UTAMA (PUBLIC) DENGAN WEB CONTEXT
// ==========================
async function callWithFallback({
  messages,
  level = 'sma',
  mode = 'learning',
  isPremium = false,
  isFree = false,
  webContext = null   // <-- PARAMETER BARU
}) {
  // 1. Validasi mode & level
  const modeLevelError = validateModeLevel(mode, level);
  if (modeLevelError) {
    return { success: true, content: modeLevelError, model: 'system' };
  }

  // 2. Deteksi intent
  const intent = detectIntent(messages);
  console.log(`[ROUTER] intent=${intent}, mode=${mode}, level=${level}, premium=${isPremium}`);

  // 3. Dapatkan keputusan model & token
  const decision = getDecision({ level, intent, mode, isPremium });
  if (decision.blocked) {
    return { success: true, content: decision.message, model: 'system' };
  }

  // 4. Hitung max tokens
  const maxTokens = resolveMaxTokens({
    level,
    tokenCategory: decision.tokenCategory,
    isFree,
    isPremium
  });
  console.log(`[ROUTER] model=${decision.model}, maxTokens=${maxTokens}`);

  // 5. Siapkan messages: sisipkan webContext ke pesan user terakhir
  let finalMessages = [...messages];
  if (webContext && webContext.trim()) {
    // Cari pesan dengan role 'user' yang terakhir (paling akhir)
    for (let i = finalMessages.length - 1; i >= 0; i--) {
      if (finalMessages[i].role === 'user') {
        finalMessages[i].content = `${finalMessages[i].content}\n\n[Data referensi terkini dari web]:\n${webContext}`;
        break;
      }
    }
    console.log(`[ROUTER] webContext disisipkan (panjang: ${webContext.length} chars)`);
  }

  // 6. Inject system prompt
  finalMessages = injectPrompt(finalMessages, mode, level, isFree);

  // 7. Siapkan fallback chain
  const fallbackModels = CONFIG.fallbackChain[decision.model] || ['gptMini'];

  // 8. Panggil dengan fallback cerdas
  const result = await callWithIntelligentFallback({
    primaryModel: decision.model,
    fallbackModels,
    messages: finalMessages,
    originalMaxTokens: maxTokens,
    tokenCategory: decision.tokenCategory,
    level,
    isFree,
    isPremium
  });

  if (result.success) return result;

  // 9. Ultimate fallback (manual)
  return {
    success: true,
    content: "Maaf, layanan sedang sibuk. Silakan coba lagi nanti.",
    model: 'system',
    isFallback: true
  };
}

// ==========================
// LEGACY SUPPORT (OPSIONAL)
// ==========================
function selectModel(level) {
  return {
    model: CONFIG.levelModelMap[level] || 'gptMini',
    reason: 'by_level'
  };
}

// ==========================
// EKSPOR MODUL
// ==========================
module.exports = {
  callAI,
  callWithFallback,
  selectModel,
  detectIntent,
  validateModeLevel,
  getDecision,
  resolveMaxTokens
};
