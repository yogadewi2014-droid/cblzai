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
const { checkTypeQuota, incrementTypeQuota, getAllRemaining } = require('../services/quotaManager');

async function processMessage(userId, message, session, platform, imageBuffer = null) {
    const originalMessage = message;

    // 1. Rate limit & deduplikasi
    const allowed = await userRateLimit(userId);
    if (!allowed) return { text: '⏳ Kakak sudah banyak bertanya. Yuk istirahat sebentar! 😊', images: [] };
    const isDup = await isDuplicateRequest(userId, message);
    if (isDup) return { text: '🐢 Kakak sudah kirim pertanyaan yang sama. Yenni sedang memproses...', images: [] };

    // Tentukan sub-jenjang
    const subLevel = session.subLevel || (session.level === 'sd-smp' ? 'smp' : 'sma');

    // 2. Tentukan jenis input untuk kuota
    let quotaType = 'text';
    if (message.startsWith('[IMAGE]') || message.startsWith('[IMAGE_BUFFER]')) {
        quotaType = 'image';
    }
    // Voice sudah ditangani di handler terpisah, jadi di sini hanya teks dan gambar

    const quota = await checkTypeQuota(userId, quotaType);
    if (!quota.allowed && !quota.isPremium) {
        const typeName = quotaType === 'image' ? 'gambar' : 'teks';
        return {
            text: `📊 *Kuota harian ${typeName} Kakak sudah habis!*\n\nYuk upgrade ke *Yenni Premium* supaya bisa belajar sepuasnya tanpa batas! 🚀\n\nKetik */upgrade* untuk lihat pilihan langganan.`,
            images: []
        };
    }

    // 3. Tentukan apakah ini media (gambar/PDF) untuk skip semantic cache
    const isMediaMessage = message.startsWith('[IMAGE]') || 
                           message.startsWith('[IMAGE_BUFFER]') ||
                           message.startsWith('[PDF]') || 
                           message.startsWith('[PDF_TEXT]');

    // 4. Exact match cache (selalu)
    const exactCached = await getExactMatchCache(message, session.level, subLevel);
    if (exactCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', exactCached);
        await incrementTypeQuota(userId, quotaType);
        return { text: exactCached, images: [] };
    }

    // 5. Semantic cache hanya untuk teks biasa
    if (!isMediaMessage) {
        const semanticCached = await getSemanticCache(message, session.level, subLevel);
        if (semanticCached) {
            await saveConversation(userId, 'user', message);
            await saveConversation(userId, 'assistant', semanticCached);
            await incrementTypeQuota(userId, quotaType);
            return { text: semanticCached, images: [] };
        }
    }

    // 6. Respons singkat follow-up dengan konteks spesifik
    if (message.match(/^(mau|ya|lanjut|oke|sip|yes|lanjutkan|boleh)$/i)) {
        const lastAssistantMsg = session.history?.filter(m => m.role === 'assistant').pop();
        if (lastAssistantMsg?.content) {
            message = `[User setuju dengan tawaran: "${lastAssistantMsg.content}"]`;
        }
    }

    // 7. Permintaan artikel
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
        await incrementTypeQuota(userId, quotaType);
        return { text: articleResponse, images: [] };
    }

    // 8. OCR Gambar (Telegram URL)
    let extractedText = '';
    if (message.startsWith('[IMAGE]') && !message.startsWith('[IMAGE_BUFFER]')) {
        const imagePart = message.substring(7);
        const newlineIndex = imagePart.indexOf('\n');
        const imageUrl = newlineIndex > -1 ? imagePart.substring(0, newlineIndex).trim() : imagePart.trim();
        const caption = newlineIndex > -1 ? imagePart.substring(newlineIndex + 1).trim() : '';

        let buffer;
        try { buffer = await downloadFile(imageUrl); } 
        catch (e) { logger.error('Download image failed:', e); throw new Error('DOWNLOAD_FAILED: ' + e.message); }
        try { buffer = await compressImage(buffer, { maxWidth: 1024, quality: 80 }); } 
        catch (e) { logger.warn('Compression failed, using original:', e); }
        try { extractedText = await extractTextFromImage(buffer); } 
        catch (e) { logger.error('OCR failed:', e); throw new Error('OCR_FAILED: ' + e.message); }
        message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${caption || 'Jelaskan gambar ini.'}`;
    }

    // 9. OCR Gambar (WhatsApp buffer)
    if (message.startsWith('[IMAGE_BUFFER]')) {
        const caption = message.substring(13).trim() || 'Jelaskan gambar ini.';
        if (!imageBuffer) throw new Error('No image buffer provided');
        let compressedBuffer;
        try { compressedBuffer = await compressImage(imageBuffer, { maxWidth: 1024, quality: 80 }); } 
        catch (e) { logger.warn('Compression failed, using original:', e); compressedBuffer = imageBuffer; }
        try { extractedText = await extractTextFromImage(compressedBuffer); } 
        catch (e) { logger.error('OCR failed:', e); throw new Error('OCR_FAILED: ' + e.message); }
        message = `[Hasil OCR Gambar]:\n${extractedText}\n\nPertanyaan pengguna: ${caption}`;
    }

    // 10. PDF (Telegram)
    if (message.startsWith('[PDF]')) {
        const pdfPart = message.substring(5);
        const newlineIndex = pdfPart.indexOf('\n');
        const pdfUrl = newlineIndex > -1 ? pdfPart.substring(0, newlineIndex).trim() : pdfPart.trim();
        const caption = newlineIndex > -1 ? pdfPart.substring(newlineIndex + 1).trim() : '';
        let pdfBuffer;
        try { pdfBuffer = await downloadFile(pdfUrl); } 
        catch (e) { logger.error('Download PDF failed:', e); throw new Error('DOWNLOAD_FAILED: ' + e.message); }
        let pdfText;
        try { pdfText = await extractTextFromPDF(pdfBuffer); } 
        catch (e) { logger.error('PDF extraction failed:', e); throw new Error('PDF_EXTRACT_FAILED: ' + e.message); }
        if (!pdfText || pdfText.trim().length === 0) {
            return { text: '📄 PDF ini sepertinya hasil scan. Kirim fotonya sebagai gambar ya. 😊', images: [] };
        }
        message = `[Isi PDF]:\n${pdfText}\n\nPertanyaan pengguna: ${caption || 'Jelaskan isi PDF ini.'}`;
    }

    // 11. PDF Teks (WhatsApp)
    if (message.startsWith('[PDF_TEXT]')) {
        const pdfPart = message.substring(9);
        const newlineIndex = pdfPart.indexOf('\n');
        const caption = newlineIndex > -1 ? pdfPart.substring(0, newlineIndex).trim() : 'Jelaskan isi PDF ini.';
        const pdfText = newlineIndex > -1 ? pdfPart.substring(newlineIndex + 1).trim() : pdfPart.trim();
        if (!pdfText || pdfText.trim().length === 0) {
            return { text: '📄 Tidak ada teks di PDF ini.', images: [] };
        }
        message = `[Isi PDF]:\n${pdfText}\n\nPertanyaan pengguna: ${caption}`;
    }

    // 12. Search
    const searchMatch = message.match(/cari(?:kan)?\s+(?:tentang\s+)?(.+)/i);
    if (searchMatch) {
        const query = searchMatch[1];
        const searchSummary = await searchAndSummarize(query);
        message = `Informasi dari pencarian web:\n${searchSummary}\n\nPertanyaan pengguna: ${message}`;
    }

    // 13. Bangun prompt & pilih LLM
    const systemPrompt = buildSystemPrompt(session);
    const context = await manageContext(userId, session, message);
    const fullPrompt = `${systemPrompt}\n\n${context}\n\nUser: ${message}`;

    const isMathOrReasoning = /hitung|kpk|fpb|kelipatan|faktor|luas|volume|kecepatan|matematika|soal cerita|jam|menit|detik|grafik|fungsi|turunan|integral|aljabar/i.test(originalMessage);

    let response;
    try {
        if (session.level === 'sd-smp' && isMathOrReasoning) {
            try { response = await callDeepSeek(fullPrompt); } 
            catch { response = await callOpenAI(fullPrompt); }
        } else if (session.level === 'sd-smp') {
            response = await callGemini(fullPrompt);
        } else {
            const needsReasoning = /analisis|matematika|hitung|kode|program|soal sulit/i.test(message);
            if (needsReasoning) {
                try { response = await callDeepSeek(fullPrompt); } 
                catch { response = await callOpenAI(fullPrompt); }
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

    // 14. Deteksi blok visualisasi
    const vizRegex = /\[VISUALISASI\]([\s\S]*?)\[\/VISUALISASI\]/;
    const match = responseText.match(vizRegex);
    if (match) {
        try {
            const vizData = JSON.parse(match[1].trim());
            let imageUrl = null;
            if (vizData.type === 'latex') imageUrl = generateLatexUrl(vizData.data);
            else if (vizData.type === 'chart') imageUrl = generateChartUrl(vizData.data);
            if (imageUrl) {
                images.push(imageUrl);
                responseText = responseText.replace(vizRegex, '📊 *Lihat gambar visualisasi di bawah ini.*');
            }
        } catch (err) {
            logger.error('Failed to parse visualization block:', err);
            responseText = responseText.replace(vizRegex, '');
        }
    }

    // 15. Simpan cache (error TIDAK disimpan)
    if (!responseText.includes('gangguan teknis') && !responseText.includes('Maaf')) {
        await setExactMatchCache(originalMessage, session.level, subLevel, responseText);
        if (!isMediaMessage) {
            await setSemanticCache(originalMessage, session.level, subLevel, responseText);
        }
    }

    // 16. Simpan history
    session.history = session.history || [];
    session.history.push({ role: 'user', content: originalMessage });
    session.history.push({ role: 'assistant', content: responseText });
    await saveSession(userId, session);
    await saveConversation(userId, 'user', originalMessage);
    await saveConversation(userId, 'assistant', responseText);

    // 17. Increment kuota
    await incrementTypeQuota(userId, quotaType);

    // 18. Reminder upgrade
   if (!quota.isPremium) {
        const remaining = await getAllRemaining(userId);
        const totalRemaining = remaining.text + remaining.image + remaining.voice;

        // Hanya tampilkan jika total sisa kuota ≤ 3 (hampir habis)
        if (totalRemaining <= 3) {
            if (totalRemaining === 0) {
                responseText += '\n\n⚠️ *Semua kuota gratis hari ini sudah habis!* Yuk upgrade ke Yenni Premium biar unlimited. Ketik /upgrade atau /bayar ~';
            } else {
                const parts = [];
                if (remaining.text > 0) parts.push(`${remaining.text} teks`);
                if (remaining.image > 0) parts.push(`${remaining.image} gambar`);
                if (remaining.voice > 0) parts.push(`${remaining.voice} voice`);
                responseText += `\n\n💡 Kuota hampir habis: ${parts.join(', ')}. Ketik /upgrade untuk langganan biar unlimited~`;
            }
        }
    }
    return { text: responseText, images };
}

module.exports = { processMessage };
