const { callGemini } = require('./gemini');
const { callOpenAI } = require('./openai');
const { callDeepSeek } = require('./deepseek');
const { getUserTier } = require('./quotaManager');
const { isSimpleMath, isMediumMath, isHardReasoning } = require('../utils/router');
const logger = require('../utils/logger');

/**
 * Cek confidence dari respons model (berdasarkan indikator umum)
 * Confidence rendah jika: respons mengandung "maaf", "tidak tahu", terlalu pendek, atau format salah
 */
function isConfident(response) {
    if (!response || response.length < 20) return false;
    const lowConfidencePatterns = [
        /maaf.*tidak.*tahu/i, /tidak.*yakin/i, /mungkin.*salah/i,
        /saya tidak bisa/i, /tidak dapat menjawab/i,
    ];
    return !lowConfidencePatterns.some(p => p.test(response));
}

/**
 * Router model AI berdasarkan tier dan tingkat kesulitan
 * @param {string} userId
 * @param {string} prompt - full prompt
 * @param {string} originalMessage - pesan asli user (untuk deteksi kesulitan)
 * @returns {Promise<string>}
 */
async function routeModel(userId, prompt, originalMessage = '') {
    const tier = await getUserTier(userId);
    const isHard = isHardReasoning(originalMessage);
    const isMedium = isMediumMath(originalMessage);

    logger.info(`Model routing: tier=${tier}, hard=${isHard}, medium=${isMedium}`);

    switch (tier) {
        case 'free':
            // Free: Gemini 2.5 Flash-Lite utama, sulit → Mini, jika tidak confident → DeepSeek
            if (isHard) {
                try {
                    const response = await callOpenAI(prompt, { model: 'gpt-4o-mini' });
                    if (isConfident(response)) return response;
                    logger.info('Free: GPT-4o Mini not confident, trying DeepSeek');
                    return await callDeepSeek(prompt);
                } catch {
                    return await callDeepSeek(prompt);
                }
            }
            // Default: Gemini
            try {
                const response = await callGemini(prompt);
                if (isConfident(response)) return response;
                logger.info('Free: Gemini not confident, trying GPT-4o Mini');
                return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
            } catch {
                return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
            }

        case 'go':
            // GO: GPT-4o Mini utama, sulit → DeepSeek, jika tidak confident → Mini lagi
            if (isHard) {
                try {
                    const response = await callDeepSeek(prompt);
                    if (isConfident(response)) return response;
                    return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
                } catch {
                    return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
                }
            }
            try {
                return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
            } catch {
                return await callGemini(prompt);
            }

        case 'pro':
            // PRO: GPT-4o Mini utama, sulit → DeepSeek, jika ragu → Gemini 2.5 Flash
            if (isHard) {
                try {
                    const response = await callDeepSeek(prompt);
                    if (isConfident(response)) return response;
                    logger.info('PRO: DeepSeek not confident, trying Gemini Flash');
                    return await callGemini(prompt);
                } catch {
                    return await callGemini(prompt);
                }
            }
            try {
                return await callOpenAI(prompt, { model: 'gpt-4o-mini' });
            } catch {
                return await callGemini(prompt);
            }

        default:
            return await callGemini(prompt);
    }
}

module.exports = { routeModel, isConfident };
