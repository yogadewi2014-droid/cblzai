const { callGemini } = require('../services/gemini');
const { callOpenAI } = require('../services/openai');
const { callDeepSeek } = require('../services/deepseek');
const { searchAndSummarize } = require('../services/serper');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { manageContext } = require('../conversation/contextCache');
const { saveSession } = require('../conversation/sessionManager');
const { saveConversation } = require('../services/supabase');
const { buildSystemPrompt, buildArticlePrompt } = require('../services/promptBuilder');
const { getExactMatchCache, setExactMatchCache, getSemanticCache, setSemanticCache } = require('../middleware/cacheHandler');
const { userRateLimit, checkTokenQuota, isDuplicateRequest } = require('../middleware/rateLimiter');
const { countTokens } = require('../utils/tokenCounter');
const logger = require('../utils/logger');
const config = require('../config');

async function processMessage(userId, message, session, platform) {
    const originalMessage = message;

    // Rate limit & dedup
    const allowed = await userRateLimit(userId);
    if (!allowed) return '⏳ Kakak sudah banyak bertanya. Yuk istirahat sebentar! 😊';
    const isDup = await isDuplicateRequest(userId, message);
    if (isDup) return '🐢 Kakak sudah kirim pertanyaan yang sama. Yenni sedang memproses...';

    const subLevel = session.subLevel || (session.level === 'sd-smp' ? 'smp' : 'sma');

    // Cache check
    const exactCached = await getExactMatchCache(message, session.level, subLevel);
    if (exactCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', exactCached);
        return exactCached;
    }
    const semanticCached = await getSemanticCache(message, session.level, subLevel);
    if (semanticCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', semanticCached);
        return semanticCached;
    }

    // Respons singkat follow-up
    if (message.match(/^(mau|ya|lanjut|oke|sip|yes|lanjutkan|boleh)$/i)) {
        const lastAssistantMsg = session.history?.filter(m => m.role === 'assistant').pop();
        if (lastAssistantMsg && (lastAssistantMsg.content.includes('lebih detail') || lastAssistantMsg.content.includes('lanjut'))) {
            message = `[User setuju untuk penjelasan lebih lanjut tentang materi sebelumnya]`;
        }
    }

    // Permintaan artikel
    const articleMatch = message.match(/buat(?:kan)?\s+artikel\s+(?:tentang\s+)?(.+)/i);
    if (articleMatch) {
        const topic = articleMatch[1];
        const articlePrompt = buildArticlePrompt(topic, session);
        const response = await callOpenAI(articlePrompt, { max_tokens: config.wordLimits[subLevel].article * 2 });
        await setExactMatchCache(originalMessage, session.level, subLevel, response);
        await setSemanticCache(originalMessage, session.level, subLevel, response);
        await saveConversation(userId, 'user', originalMessage);
        await saveConversation(userId, 'assistant', response);
        session.history.push({ role: 'user', content: originalMessage });
        session.history.push({ role: 'assistant', content: response });
        await saveSession(userId, session);
        return response;
    }

    // OCR
    let extractedText = '';
    if (message.startsWith('[IMAGE]')) {
        const imageUrl = message.substring(7);
        const buffer = await downloadFile(imageUrl);
        extractedText = await extractTextFromImage(buffer);
        message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${message}`;
    }

    // Search
    const searchMatch = message.match(/cari(?:kan)?\s+(?:tentang\s+)?(.+)/i);
    if (searchMatch) {
        const query = searchMatch[1];
        const searchSummary = await searchAndSummarize(query);
        message = `Informasi dari pencarian web:\n${searchSummary}\n\nPertanyaan pengguna: ${message}`;
    }

    const systemPrompt = buildSystemPrompt(session);
    const context = await manageContext(userId, session, message);
    const fullPrompt = `${systemPrompt}\n\n${context}\n\nUser: ${message}`;

    // === DETEKSI SOAL MATEMATIKA / REASONING UNTUK SD/SMP ===
    const isMathOrReasoning = /hitung|kpk|fpb|kelipatan|faktor|luas|volume|kecepatan|matematika|soal cerita|jam|menit|detik/i.test(originalMessage);

    let response;
    try {
        if (session.level === 'sd-smp' && isMathOrReasoning) {
            // Soal hitungan SD/SMP pakai DeepSeek atau fallback GPT
            try {
                response = await callDeepSeek(fullPrompt);
            } catch {
                response = await callOpenAI(fullPrompt);
            }
        } else if (session.level === 'sd-smp') {
            response = await callGemini(fullPrompt);
        } else {
            // SMA/SMK
            const needsReasoning = /analisis|matematika|hitung|kode|program|soal sulit/i.test(message);
            if (needsReasoning) {
                try {
                    response = await callDeepSeek(fullPrompt);
                } catch {
                    response = await callOpenAI(fullPrompt);
                }
            } else {
                response = await callGemini(fullPrompt);
            }
        }
    } catch (error) {
        logger.error('LLM error:', error);
        return '😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.';
    }

    // Hanya cache jika bukan error
    if (!response.includes('gangguan teknis') && !response.includes('Maaf')) {
        await setExactMatchCache(originalMessage, session.level, subLevel, response);
        await setSemanticCache(originalMessage, session.level, subLevel, response);
    }

    session.history = session.history || [];
    session.history.push({ role: 'user', content: originalMessage });
    session.history.push({ role: 'assistant', content: response });
    await saveSession(userId, session);
    await saveConversation(userId, 'user', originalMessage);
    await saveConversation(userId, 'assistant', response);

    const actualTokens = countTokens(fullPrompt + response);
    await checkTokenQuota(userId, actualTokens);

    return response;
}

module.exports = { processMessage };
