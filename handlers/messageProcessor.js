const { callGemini } = require('../services/gemini');
const { callOpenAI } = require('../services/openai');
const { callDeepSeek } = require('../services/deepseek');
const { searchAndSummarize } = require('../services/serper');
const { extractTextFromImage } = require('../services/vision');
const { downloadFile } = require('../utils/downloader');
const { compressImage, extractTextFromPDF } = require('../utils/imageProcessor');
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

/**
 * Proses pesan dari pengguna
 * @param {string} userId - ID pengguna
 * @param {string} message - Isi pesan
 * @param {object} session - Data sesi pengguna
 * @param {string} platform - 'telegram' atau 'whatsapp'
 * @param {Buffer} [imageBuffer] - Buffer gambar (opsional, untuk WhatsApp)
 * @returns {Promise<{text: string, images: string[]}>}
 */
async function processMessage(userId, message, session, platform, imageBuffer = null) {
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
            message = '[User setuju untuk penjelasan lebih lanjut tentang materi sebelumnya]';
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

    // ==================== OCR (Gambar dari URL - Telegram) ====================
    let extractedText = '';
    if (message.startsWith('[IMAGE]') && !message.startsWith('[IMAGE_BUFFER]')) {
        const imagePart = message.substring(7);
        const newlineIndex = imagePart.indexOf('\n');
        const imageUrl = newlineIndex > -1 ? imagePart.substring(0, newlineIndex).trim() : imagePart.trim();
        const caption = newlineIndex > -1 ? imagePart.substring(newlineIndex + 1).trim() : '';

        let buffer;
        try {
            buffer = await downloadFile(imageUrl);
        } catch (downloadError) {
            logger.error('Download image failed:', downloadError);
            throw new Error('DOWNLOAD_FAILED: ' + downloadError.message);
        }

        try {
            buffer = await compressImage(buffer, { maxWidth: 1024, quality: 80 });
        } catch (compressError) {
            logger.warn('Compression failed, using original:', compressError);
        }

        try {
            extractedText = await extractTextFromImage(buffer);
        } catch (ocrError) {
            logger.error('OCR failed:', ocrError);
            throw new Error('OCR_FAILED: ' + ocrError.message);
        }
        message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${caption || 'Jelaskan gambar ini.'}`;
    }

    // ==================== OCR dari Buffer (WhatsApp) ====================
    if (message.startsWith('[IMAGE_BUFFER]')) {
        const caption = message.substring(13).trim() || 'Jelaskan gambar ini.';
        if (!imageBuffer) throw new Error('No image buffer provided');

        let compressedBuffer;
        try {
            compressedBuffer = await compressImage(imageBuffer, { maxWidth: 1024, quality: 80 });
        } catch (compressError) {
            logger.warn('Compression failed, using original:', compressError);
            compressedBuffer = imageBuffer;
        }

        try {
            extractedText = await extractTextFromImage(compressedBuffer);
        } catch (ocrError) {
            logger.error('OCR failed:', ocrError);
            throw new Error('OCR_FAILED: ' + ocrError.message);
        }
        message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${caption}`;
    }

    // ==================== PDF (Telegram) ====================
    if (message.startsWith('[PDF]')) {
        const pdfPart = message.substring(5);
        const newlineIndex = pdfPart.indexOf('\n');
        const pdfUrl = newlineIndex > -1 ? pdfPart.substring(0, newlineIndex).trim() : pdfPart.trim();
        const caption = newlineIndex > -1 ? pdfPart.substring(newlineIndex + 1).trim() : '';

        let pdfBuffer;
        try {
            pdfBuffer = await downloadFile(pdfUrl);
        } catch (downloadError) {
            logger.error('Download PDF failed:', downloadError);
            throw new Error('DOWNLOAD_FAILED: ' + downloadError.message);
        }

        let pdfText;
        try {
            pdfText = await extractTextFromPDF(pdfBuffer);
        } catch (pdfError) {
            logger.error('PDF extraction failed:', pdfError);
            throw new Error('PDF_EXTRACT_FAILED: ' + pdfError.message);
        }

        if (!pdfText || pdfText.trim().length === 0) {
            return {
                text: '📄 PDF ini sepertinya hasil scan (gambar). Untuk saat ini, Yenni belum bisa membaca tulisan di PDF scan. Kakak bisa kirim fotonya langsung sebagai gambar ya. 😊',
                images: []
            };
        }

        message = `[Isi PDF]:\n${pdfText}\n\nPertanyaan pengguna: ${caption || 'Jelaskan isi PDF ini.'}`;
    }

    // ==================== PDF Teks (WhatsApp) ====================
    if (message.startsWith('[PDF_TEXT]')) {
        const pdfPart = message.substring(9);
        const newlineIndex = pdfPart.indexOf('\n');
        const caption = newlineIndex > -1 ? pdfPart.substring(0, newlineIndex).trim() : 'Jelaskan isi PDF ini.';
        const pdfText = newlineIndex > -1 ? pdfPart.substring(newlineIndex + 1).trim() : pdfPart.trim();

        if (!pdfText || pdfText.trim().length === 0) {
            return { text: '📄 Tidak ada teks yang ditemukan di PDF ini.', images: [] };
        }

        message = `[Isi PDF]:\n${pdfText}\n\nPertanyaan pengguna: ${caption}`;
    }

    // ==================== Search ====================
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
    const isMathOrReasoning = /hitung|kpk|fpb|kelipatan|faktor|luas|volume|kecepatan|matematika|soal cerita|jam|menit|detik|grafik|fungsi|turunan|integral|aljabar/i.test(originalMessage);

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
                responseText = responseText.replace(vizRegex, '📊 *Lihat gambar visualisasi di bawah ini.*');
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
