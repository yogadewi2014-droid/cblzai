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
const { generateLatexUrl, generateChartUrl } = require('../services/visualization');
const { countTokens } = require('../utils/tokenCounter');
const logger = require('../utils/logger');
const config = require('../config');

async function processMessage(userId, message, session, platform) {
    const originalMessage = message;

    // Rate limit & deduplikasi
    const allowed = await userRateLimit(userId);
    if (!allowed) return { text: '⏳ Kakak sudah banyak bertanya. Yuk istirahat sebentar! 😊', images: [] };
    const isDup = await isDuplicateRequest(userId, message);
    if (isDup) return { text: '🐢 Kakak sudah kirim pertanyaan yang sama. Yenni sedang memproses...', images: [] };

    const subLevel = session.subLevel || (session.level === 'sd-smp' ? 'smp' : 'sma');

    // Cek cache
    const exactCached = await getExactMatchCache(message, session.level, subLevel);
    if (exactCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', exactCached);
        return { text: exactCached, images: [] };
    }
    const semanticCached = await getSemanticCache(message, session.level, subLevel);
    if (semanticCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', semanticCached);
        return { text: semanticCached, images: [] };
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
        const articleResponse = await callOpenAI(articlePrompt, { max_tokens: config.wordLimits[subLevel].article * 2 });
        await setExactMatchCache(originalMessage, session.level, subLevel, articleResponse);
        await setSemanticCache(originalMessage, session.level, subLevel, articleResponse);
        await saveConversation(userId, 'user', originalMessage);
        await saveConversation(userId, 'assistant', articleResponse);
        session.history.push({ role: 'user', content: originalMessage });
        session.history.push({ role: 'assistant', content: articleResponse });
        await saveSession(userId, session);
        return { text: articleResponse, images: [] };
    }

    // OCR (gambar)
    let extractedText = '';
    if (message.startsWith('[IMAGE]')) {
        const imageUrl = message.substring(7);
        let buffer;
        try {
            buffer = await downloadFile(imageUrl);
        } catch (downloadError) {
            logger.error('Download image failed:', downloadError);
            throw new Error('DOWNLOAD_FAILED: ' + downloadError.message);
        }
        try {
            extractedText = await extractTextFromImage(buffer);
        } catch (ocrError) {
            logger.error('OCR failed:', ocrError);
            throw new Error('OCR_FAILED: ' + ocrError.message);
        }
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

    // Deteksi soal matematika/reasoning
    const isMathOrReasoning = /hitung|kpk|fpb|kelipatan|faktor|luas|volume|kecepatan|matematika|soal cerita|jam|menit|detik/i.test(originalMessage);

    let response;
    try {
        if (session.level === 'sd-smp' && isMathOrReasoning) {
            try {
                response = await callDeepSeek(fullPrompt);
            } catch {
                response = await callOpenAI(fullPrompt);
            }
        } else if (session.level === 'sd-smp') {
            response = await callGemini(fullPrompt);
        } else {
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
        return { text: '😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.', images: [] };
    }

    let responseText = response;
    let images = [];

    // Deteksi blok visualisasi
    const vizRegex = /\[VISUALISASI\]([\s\S]*?)\[\/VISUALISASI\]/;
    const match = responseText.match(vizRegex);
    if (match) {
        try {
            const vizData = JSON.parse(match[1].trim());
            let imageUrl = null;
            if (vizData.type === 'latex') {
                imageUrl = generateLatexUrl(vizData.data);
            } else if (vizData.type === 'chart') {
                imageUrl = generateChartUrl(vizData.data);
            }
            if (imageUrl) {
                images.push(imageUrl);
                responseText = responseText.replace(vizRegex, '📊 Lihat gambar visualisasi di bawah ini.');
            }
        } catch (err) {
            logger.error('Failed to parse visualization block:', err);
            responseText = responseText.replace(vizRegex, '');
        }
    }

    // Cache hanya jika bukan error
    if (!responseText.includes('gangguan teknis') && !responseText.includes('Maaf')) {
        await setExactMatchCache(originalMessage, session.level, subLevel, responseText);
        await setSemanticCache(originalMessage, session.level, subLevel, responseText);
    }

    // Simpan history
    session.history = session.history || [];
    session.history.push({ role: 'user', content: originalMessage });
    session.history.push({ role: 'assistant', content: responseText });
    await saveSession(userId, session);
    await saveConversation(userId, 'user', originalMessage);
    await saveConversation(userId, 'assistant', responseText);

    const actualTokens = countTokens(fullPrompt + responseText);
    await checkTokenQuota(userId, actualTokens);

    return { text: responseText, images };
}

module.exports = { processMessage };
