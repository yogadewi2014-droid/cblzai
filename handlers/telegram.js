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
const { userRateLimit, isDuplicateRequest } = require('../middleware/rateLimiter');
const { generateLatexUrl, generateChartUrl } = require('../services/visualization');
const { countTokens } = require('../utils/tokenCounter');
const { isSimpleMath, isMediumMath, isHardReasoning } = require('../utils/router');
const { consumeQuota, getAllRemaining, getUserTier, checkMediaQuota } = require('../services/quotaManager');
const { routeModel } = require('../services/modelRouter');
const { detectIntent } = require('../services/intentDetector');
const { generateVoice, detectLanguage, selectVoice } = require('../services/voiceOutput');
const { buildMedia } = require('../services/videoMaker');
const { getImageUrl } = require('../services/imageSource');
const logger = require('../utils/logger');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function processMessage(userId, message, session, platform, imageBuffer = null) {
    const originalMessage = message;

    // 1. Rate limit & deduplikasi
    const allowed = await userRateLimit(userId);
    if (!allowed) return { text: '⏳ Kakak sudah banyak bertanya. Yuk istirahat sebentar! 😊', images: [] };
    const isDup = await isDuplicateRequest(userId, message);
    if (isDup) return { text: '🐢 Kakak sudah kirim pertanyaan yang sama. Yenni sedang memproses...', images: [] };

    const subLevel = session.subLevel || (session.level === 'sd-smp' ? 'smp' : 'sma');

    // 2. Tentukan jenis kuota dan konsumsi langsung (atomic)
    let quotaType = 'text';
    if (message.startsWith('[IMAGE]') || message.startsWith('[IMAGE_BUFFER]')) {
        quotaType = 'image';
    }

    const quota = await consumeQuota(userId, quotaType);
    if (!quota.allowed) {
        const tierName = quota.tier === 'free' ? 'gratis' : quota.tier.toUpperCase();
        return {
            text: `📊 *Kuota harian ${quotaType} Kakak sudah habis!*\n\n` +
                  `Tier saat ini: ${tierName}\n` +
                  `Yuk upgrade ke paket yang lebih tinggi supaya bisa belajar sepuasnya! 🚀\n\n` +
                  `Ketik */upgrade* untuk lihat pilihan paket.`,
            images: []
        };
    }

    // 3. Cek cache
    const isMediaMessage = message.startsWith('[IMAGE]') || message.startsWith('[IMAGE_BUFFER]') ||
                           message.startsWith('[PDF]') || message.startsWith('[PDF_TEXT]');

    const exactCached = await getExactMatchCache(message, session.level, subLevel);
    if (exactCached) {
        await saveConversation(userId, 'user', message);
        await saveConversation(userId, 'assistant', exactCached);
        return { text: exactCached, images: [] };
    }

    if (!isMediaMessage) {
        const semanticCached = await getSemanticCache(message, session.level, subLevel);
        if (semanticCached) {
            await saveConversation(userId, 'user', message);
            await saveConversation(userId, 'assistant', semanticCached);
            return { text: semanticCached, images: [] };
        }
    }

    // 4. Follow-up singkat
    if (message.match(/^(mau|ya|lanjut|oke|sip|yes|lanjutkan|boleh)$/i)) {
        const lastAssistantMsg = session.history?.filter(m => m.role === 'assistant').pop();
        if (lastAssistantMsg?.content) {
            message = `[User setuju dengan tawaran: "${lastAssistantMsg.content}"]`;
        }
    }

    // 5. Artikel
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

    // 6. OCR & PDF
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

    // 7. Search
    const searchMatch = message.match(/cari(?:kan)?\s+(?:tentang\s+)?(.+)/i);
    if (searchMatch) {
        const query = searchMatch[1];
        const searchSummary = await searchAndSummarize(query);
        message = `Informasi dari pencarian web:\n${searchSummary}\n\nPertanyaan pengguna: ${message}`;
    }

    // 8. Bangun prompt
    const systemPrompt = buildSystemPrompt(session);
    const context = await manageContext(userId, session, message);
    const fullPrompt = `${systemPrompt}\n\n${context}\n\nUser: ${message}`;

    // 9. Router pemilihan model (TIER-BASED)
    let response;
    try {
        if (isSimpleMath(originalMessage)) {
            try {
                const result = Function(`"use strict"; return (${originalMessage})`)();
                response = `✨ Hasil dari \`${originalMessage}\` adalah *${result}*`;
                logger.info('Simple math evaluated locally');
            } catch {
                response = await routeModel(userId, fullPrompt, originalMessage);
            }
        } else {
            response = await routeModel(userId, fullPrompt, originalMessage);
        }
    } catch (error) {
        logger.error('LLM error:', error);
        return { text: '😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.', images: [] };
    }

    // 10. Visualisasi
    let responseText = response;
    let images = [];
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

    // 11. Filter output untuk Free tier
    const userTier = await getUserTier(userId);
    if (userTier === 'free') {
        images = [];
        responseText = responseText.replace(/📊.*Lihat gambar.*/g, '');
    }

    // 12. Cache
    if (!responseText.includes('gangguan teknis') && !responseText.includes('Maaf')) {
        await setExactMatchCache(originalMessage, session.level, subLevel, responseText);
        if (!isMediaMessage) {
            await setSemanticCache(originalMessage, session.level, subLevel, responseText);
        }
    }

    // 13. Simpan history
    session.history = session.history || [];
    session.history.push({ role: 'user', content: originalMessage });
    session.history.push({ role: 'assistant', content: responseText });
    await saveSession(userId, session);
    await saveConversation(userId, 'user', originalMessage);
    await saveConversation(userId, 'assistant', responseText);

    // 14. DETEKSI INTENT UNTUK VOICE & VIDEO (GO/PRO)
    let voicePath = null;
    let videoPath = null;

    if (userTier !== 'free' && responseText.length > 100) {
        const topic = originalMessage.substring(0, 40);
        const intent = await detectIntent(responseText, topic, session.history || []);

        if (intent.voiceRecommended) {
            const voiceQuota = await checkMediaQuota(userId, 'ffmpeg');
            if (voiceQuota.allowed) {
                try {
                    const lang = detectLanguage(responseText);
                    const voice = selectVoice(lang);
                    const audioBuffer = await generateVoice(responseText, lang, voice);
                    voicePath = path.join(os.tmpdir(), `yenni-voice-${Date.now()}.mp3`);
                    fs.writeFileSync(voicePath, audioBuffer);
                    await consumeQuota(userId, 'ffmpeg');
                    logger.info('Voice auto-generated by intent');
                } catch (e) {
                    logger.error('Auto-voice generation failed:', e);
                }
            }
        }

        if (intent.videoRecommended) {
            const videoQuota = await checkMediaQuota(userId, 'ffmpeg');
            if (videoQuota.allowed) {
                try {
                    const imageUrl = await getImageUrl(topic);
                    videoPath = await buildMedia(responseText, imageUrl);
                    await consumeQuota(userId, 'ffmpeg');
                    logger.info('Video auto-generated by intent');
                } catch (e) {
                    logger.error('Auto-video generation failed:', e);
                }
            }
        }
    }

    // 15. Reminder upgrade (hanya free)
    if (userTier === 'free') {
        const remaining = await getAllRemaining(userId);
        if (remaining.text === 0 && remaining.image === 0 && remaining.voice === 0) {
            responseText += '\n\n⚠️ *Semua kuota gratis hari ini sudah habis!* Yuk upgrade ke Yenni GO atau PRO. Ketik /upgrade ~';
        } else if (remaining.text <= 3) {
            responseText += `\n\n💡 Sisa ${remaining.text} teks. Ketik /upgrade untuk langganan biar unlimited~`;
        }
    }

    return { text: responseText, images, voicePath, videoPath };
}

module.exports = { processMessage };
