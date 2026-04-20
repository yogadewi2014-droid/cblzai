// ocr.js - Version 9.7
// Hybrid: Vision langsung (gambar kecil) + OCR (gambar besar/dokumen)
// Default model: Gemini 2.5 Flash Lite
// Routing: DeepSeek untuk math/code/reasoning
// Fallback: GPT-5-mini (race dengan timeout 2 detik)
// Caching: OCR (7 hari) dan LLM (1 jam)
// Preprocessing: resize berdasarkan megapixel, grayscale, normalize, sharpen
// Token-efficient: relevance filtering, smart truncation, pre-summarization (jarang)

const vision = require('@google-cloud/vision');
const axios = require('axios');
const crypto = require('crypto');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const { callAI } = require('./ai-models');
const { getCache, setCache } = require('./cache');

// ========================
// KONFIGURASI
// ========================
const CONFIG = {
  // Mode Vision langsung: gambar < 800KB akan diproses tanpa OCR
  visionDirectMaxKB: 800,
  // OCR preprocessing: resize jika megapixel > 4MP
  ocrResizeThresholdMP: 4,
  // Panjang teks maksimal setelah filtering (per level)
  maxChars: { sma: 1200, mahasiswa: 1800, profesional: 3000 },
  // Pre-summarization threshold (hanya profesional)
  preSummarizeThreshold: 6000,
  // Race timeout (ms) sebelum fallback ke GPT-5-mini
  raceTimeoutMs: 2000,
  // Cache TTL (detik)
  ocrCacheTTL: 86400 * 7,   // 7 hari
  llmCacheTTL: 3600,        // 1 jam
};

// ========================
// HTTP KEEP-ALIVE
// ========================
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// ========================
// GOOGLE VISION
// ========================
const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

// ========================
// UTILITY
// ========================
const hash = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// ========================
// PREPROCESSING GAMBAR (untuk OCR)
// ========================
async function preprocessForOCR(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const pixels = meta.width * meta.height;
    if (pixels < 2_000_000) return buffer;

    let pipeline = sharp(buffer);
    if (pixels > CONFIG.ocrResizeThresholdMP * 1_000_000) {
      pipeline = pipeline.resize(1400, null, { fit: 'inside' });
    }
    return await pipeline.grayscale().normalize().sharpen().toBuffer();
  } catch (err) {
    console.warn('⚠️ Preprocess OCR gagal:', err.message);
    return buffer;
  }
}

// ========================
// CLEAN TEXT (dengan perlindungan untuk matematika)
// ========================
function cleanText(text = '', isMath = false) {
  let cleaned = text
    .replace(/([a-z])\1{2,}/gi, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!isMath) {
    cleaned = cleaned.replace(/[^\w\s.,!?;:()\-]/g, '');
  }
  return cleaned;
}

// ========================
// RELEVANCE FILTERING (berdasarkan keyword pertanyaan)
// ========================
function extractRelevant(text, question, maxChars) {
  if (!question || question.length < 5) return text.slice(0, maxChars);
  if (!text) return '';

  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const sentences = text.split(/(?<=[.!?])\s+/);
  const scored = sentences.map(s => ({
    s,
    score: keywords.reduce((acc, kw) => acc + (s.toLowerCase().includes(kw) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score);

  let result = '';
  for (const item of scored) {
    if ((result + item.s).length > maxChars) break;
    result += item.s + ' ';
  }
  result = result.trim();
  return result || text.slice(0, maxChars);
}

// ========================
// SMART TRUNCATION (60% awal + 40% akhir)
// ========================
function smartTruncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return `${head}\n...[potongan tengah dihilangkan]...\n${tail}`;
}

// ========================
// PRE-SUMMARIZATION (hanya untuk profesional & teks sangat panjang)
// ========================
async function preSummarize(text) {
  try {
    const res = await callAI(
      'gemini-2.0-flash-lite',
      [{ role: 'user', content: `Ringkas sangat padat (≤200 kata), pertahankan fakta & angka:\n\n${text}` }],
      'profesional'
    );
    return res.content;
  } catch (err) {
    console.warn('Pre-summarize gagal:', err.message);
    return text;
  }
}

// ========================
// MODEL ROUTING (DeepSeek untuk reasoning berat)
// ========================
function needsDeepSeek(question = '') {
  return /hitung|rumus|kode|algoritma|integral|matrix|debug|persamaan|turunan|statistik|probabilitas|logika|pseudocode|kompleksitas/i.test(question);
}

function selectModel(question, defaultModel = 'gemini-2.5-flash-lite') {
  return needsDeepSeek(question) ? 'deepseek-v3.2' : defaultModel;
}

// ========================
// VISION LANGSUNG (tanpa OCR) untuk gambar kecil
// ========================
async function directVision(buffer, question, level) {
  try {
    const base64 = buffer.toString('base64');
    const res = await callAI('gemini-2.5-flash-lite', [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: question || 'Jelaskan gambar ini secara singkat dan jelas.' },
        ],
      },
    ], level);
    return res.content;
  } catch (err) {
    console.warn('Direct Vision gagal:', err.message);
    return null;
  }
}

// ========================
// OCR PIPELINE
// ========================
async function runOCR(buffer) {
  const preprocessed = await preprocessForOCR(buffer);
  const [result] = await client.documentTextDetection({
    image: { content: preprocessed.toString('base64') },
  });
  return result.textAnnotations?.[0]?.description || '';
}

// ========================
// LLM CALL DENGAN RACE + CACHE + FALLBACK
// ========================
async function callLLMWithCache(model, messages, level, cacheKeyBase, question) {
  const qHash = hash(Buffer.from(question || ''));
  const cacheKey = `llm:${cacheKeyBase}:${qHash}:${model}:${level}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    console.log('⚡ LLM cache hit');
    return { content: cached, fromCache: true, modelUsed: 'cache' };
  }

  let primaryDone = false;

  const primaryPromise = (async () => {
    try {
      const res = await callAI(model, messages, level);
      primaryDone = true;
      return { content: res.content, modelUsed: model };
    } catch (err) {
      console.warn(`⚠️ Primary model ${model} error:`, err.message);
      return null;
    }
  })();

  const fallbackPromise = (async () => {
    await new Promise(r => setTimeout(r, CONFIG.raceTimeoutMs));
    if (primaryDone) return null;
    try {
      const res = await callAI('gpt-5-mini', messages, level);
      return { content: res.content, modelUsed: 'gpt-5-mini' };
    } catch (err) {
      console.warn('⚠️ Fallback GPT-5-mini error:', err.message);
      return null;
    }
  })();

  let result = await Promise.race([primaryPromise, fallbackPromise]);

  if (!result) {
    console.log('🔄 Kedua model gagal, coba primary lagi...');
    const retry = await callAI(model, messages, level);
    result = { content: retry.content, modelUsed: model };
  }

  await setCache(cacheKey, result.content, CONFIG.llmCacheTTL);
  return { content: result.content, fromCache: false, modelUsed: result.modelUsed };
}

// ========================
// FUNGSI UTAMA
// ========================
async function processImageInput(imageUrl, userQuestion, level = 'sma') {
  try {
    // 1. Validasi content-type (HEAD request)
    try {
      const head = await axios.head(imageUrl, { timeout: 5000, httpAgent, httpsAgent });
      const ct = head.headers['content-type'] || '';
      if (!ct.startsWith('image/')) {
        return { success: false, content: `❌ URL bukan gambar (${ct})` };
      }
    } catch (headErr) {
      console.warn('HEAD request gagal, lanjut fetch:', headErr.message);
    }

    // 2. Fetch gambar
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      httpAgent,
      httpsAgent,
    });
    const buffer = Buffer.from(response.data);
    const sizeKB = buffer.length / 1024;

    // ============================================
    // HYBRID MODE: Gambar kecil -> Vision langsung
    // ============================================
    if (sizeKB < CONFIG.visionDirectMaxKB) {
      console.log('📸 Mode Vision langsung (gambar kecil)');
      const visionAnswer = await directVision(buffer, userQuestion, level);
      if (visionAnswer && visionAnswer.length > 20) {
        // Jawaban Vision cukup panjang, langsung return
        return {
          success: true,
          content: visionAnswer,
          meta: { mode: 'vision_direct', sizeKB: Math.round(sizeKB) },
        };
      }
      console.log('⚠️ Vision langsung gagal/terlalu pendek, fallback ke OCR');
    }

    // ============================================
    // OCR MODE (dengan caching)
    // ============================================
    const ocrKey = hash(buffer);
    const ocrCacheKey = `ocr:${ocrKey}`;
    let ocrText = await getCache(ocrCacheKey);

    if (!ocrText) {
      console.log('🖼️ Menjalankan OCR...');
      ocrText = await runOCR(buffer);
      if (ocrText) {
        await setCache(ocrCacheKey, ocrText, CONFIG.ocrCacheTTL);
      }
    } else {
      console.log('⚡ OCR cache hit');
    }

    if (!ocrText) {
      return { success: false, content: '❌ Tidak ada teks terdeteksi pada gambar' };
    }

    // ============================================
    // TOKEN-EFFICIENT PIPELINE
    // ============================================
    const isMath = needsDeepSeek(userQuestion);
    let cleaned = cleanText(ocrText, isMath);
    let relevant = extractRelevant(cleaned, userQuestion, CONFIG.maxChars[level] || 1800);
    let finalText = smartTruncate(relevant, CONFIG.maxChars[level] || 1800);

    // Pre-summarization untuk teks sangat panjang (hanya profesional)
    if (level === 'profesional' && finalText.length > CONFIG.preSummarizeThreshold) {
      console.log('📝 Pre-summarization...');
      finalText = await preSummarize(finalText);
      finalText = smartTruncate(finalText, CONFIG.maxChars[level]);
    }

    // ============================================
    // MODEL ROUTING & LLM CALL
    // ============================================
    const model = selectModel(userQuestion, 'gemini-2.5-flash-lite');
    console.log(`🎯 Model terpilih: ${model}`);

    const messages = [
      { role: 'system', content: 'Jawab berdasarkan teks OCR berikut. Singkat, jelas, dan akurat. Jika tidak ada jawaban, katakan tidak tahu.' },
      { role: 'user', content: finalText },
      { role: 'user', content: userQuestion || 'Jelaskan isi gambar ini' },
    ];

    const llmResult = await callLLMWithCache(model, messages, level, ocrKey, userQuestion);

    return {
      success: true,
      content: llmResult.content,
      meta: {
        mode: 'ocr',
        modelUsed: llmResult.modelUsed,
        cachedLLM: llmResult.fromCache,
        textLength: finalText.length,
        originalOCRLength: ocrText.length,
      },
    };
  } catch (err) {
    console.error('❌ processImageInput error:', err.message);
    return { success: false, content: `❌ Error: ${err.message}` };
  }
}

module.exports = { processImageInput };
