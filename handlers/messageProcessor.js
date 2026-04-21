const { callGemini } = require('../services/gemini');
const { callOpenAI } = require('../services/openai');
const { callDeepSeek } = require('../services/deepseek');
const { searchAndSummarize } = require('../services/serper');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { manageContext } = require('../conversation/contextCache');
const { saveConversation } = require('../services/supabase');
const { buildSystemPrompt, buildArticlePrompt } = require('../services/promptBuilder');
const { getExactMatchCache, setExactMatchCache, getSemanticCache, setSemanticCache } = require('../middleware/cacheHandler');
const { userRateLimit, checkTokenQuota, isDuplicateRequest } = require('../middleware/rateLimiter');
const { countTokens } = require('../utils/tokenCounter');
const logger = require('../utils/logger');
const config = require('../config');

async function processMessage(userId, message, session, platform) {
  // 1. Rate limit check
  const allowed = await userRateLimit(userId);
  if (!allowed) {
    return '⏳ Kakak sudah banyak bertanya dalam sejam ini. Yuk istirahat sebentar, nanti lanjut lagi ya! 😊';
  }

  // 2. Duplicate request check
  const isDup = await isDuplicateRequest(userId, message);
  if (isDup) {
    return '🐢 Kakak sudah kirim pertanyaan yang sama nih. Yenni sedang memproses, tunggu sebentar ya...';
  }

  // 3. Token quota check (estimasi awal)
  const estimatedInputTokens = countTokens(message) + 500; // + system prompt
  const quotaOk = await checkTokenQuota(userId, estimatedInputTokens);
  if (!quotaOk) {
    return '🌟 Wah, kuota belajar harian Kakak sudah habis. Yuk lanjut besok ya!';
  }

  // Tentukan sub-jenjang dari session (jika tidak ada, fallback)
  const subLevel = session.subLevel || (session.level === 'sd-smp' ? 'smp' : 'sma');

  // 4. Cek Exact Match Cache (pertanyaan sama persis)
  const exactCached = await getExactMatchCache(message, session.level, subLevel);
  if (exactCached) {
    await saveConversation(userId, 'user', message);
    await saveConversation(userId, 'assistant', exactCached);
    return exactCached;
  }

  // 5. Cek Semantic Cache (pertanyaan mirip)
  const semanticCached = await getSemanticCache(message, session.level, subLevel);
  if (semanticCached) {
    await saveConversation(userId, 'user', message);
    await saveConversation(userId, 'assistant', semanticCached);
    return semanticCached;
  }

  // 6. Deteksi permintaan artikel
  const articleMatch = message.match(/buat(?:kan)?\s+artikel\s+(?:tentang\s+)?(.+)/i);
  if (articleMatch) {
    const topic = articleMatch[1];
    const articlePrompt = buildArticlePrompt(topic, session);
    const response = await callOpenAI(articlePrompt, { max_tokens: config.wordLimits[subLevel].article * 2 });
    await setExactMatchCache(message, session.level, subLevel, response);
    await setSemanticCache(message, session.level, subLevel, response);
    await saveConversation(userId, 'user', message);
    await saveConversation(userId, 'assistant', response);
    return response;
  }

  // 7. Deteksi gambar
  let extractedText = '';
  if (message.startsWith('[IMAGE]')) {
    const imageUrl = message.substring(7);
    const buffer = await downloadFile(imageUrl);
    extractedText = await extractTextFromImage(buffer);
    message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${message}`;
  }

  // 8. Deteksi pencarian web
  const searchMatch = message.match(/cari(?:kan)?\s+(?:tentang\s+)?(.+)/i);
  if (searchMatch) {
    const query = searchMatch[1];
    const searchSummary = await searchAndSummarize(query);
    message = `Informasi dari pencarian web:\n${searchSummary}\n\nPertanyaan pengguna: ${message}`;
  }

  // 9. Bangun system prompt sesuai jenjang
  const systemPrompt = buildSystemPrompt(session);

  // 10. Manajemen konteks (history + summary)
  const context = await manageContext(userId, session, message);
  const fullPrompt = `${systemPrompt}\n\n${context}\n\nUser: ${message}`;

  // 11. Pilih LLM berdasarkan jenjang dan kompleksitas
  let response;
  if (session.level === 'sd-smp') {
    response = await callGemini(fullPrompt);
  } else {
    const needsReasoning = /analisis|matematika|hitung|kode|program|soal sulit|pembuktian/i.test(message);
    if (needsReasoning) {
      try {
        response = await callDeepSeek(fullPrompt);
      } catch (error) {
        logger.warn('DeepSeek error, fallback to GPT-5.4 Mini');
        response = await callOpenAI(fullPrompt);
      }
    } else {
      response = await callGemini(fullPrompt);
    }
  }

  // 12. Hitung token aktual dan update quota
  const actualTokens = countTokens(fullPrompt + response);
  await checkTokenQuota(userId, actualTokens - estimatedInputTokens);

  // 13. Simpan ke cache
  await setExactMatchCache(message, session.level, subLevel, response);
  await setSemanticCache(message, session.level, subLevel, response);

  // 14. Simpan ke history & Supabase
  session.history = session.history || [];
  session.history.push({ role: 'user', content: message });
  session.history.push({ role: 'assistant', content: response });
  await saveConversation(userId, 'user', message);
  await saveConversation(userId, 'assistant', response);

  return response;
}

module.exports = { processMessage };
