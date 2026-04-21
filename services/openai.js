const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.openaiApiKey });

async function callOpenAI(prompt, options = {}) {
    try {
        const completion = await openai.chat.completions.create({
            model: options.model || config.openaiModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: options.max_tokens || 500,
            temperature: options.temperature || 0.7,
        });
        return completion.choices[0].message.content;
    } catch (error) {
        logger.error('OpenAI error:', error);
        // Fallback ke Nano jika Mini gagal
        if (options.model !== config.openaiNanoModel) {
            logger.info('Trying GPT-5.4 Nano fallback...');
            return callOpenAI(prompt, { ...options, model: config.openaiNanoModel });
        }
        return 'Maaf, saat ini Yenni sedang sibuk. Coba lagi nanti ya.';
    }
}

module.exports = { callOpenAI };
