const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const deepseek = new OpenAI({
    apiKey: config.deepseekApiKey,
    baseURL: 'https://api.deepseek.com/v1',
});

async function callDeepSeek(prompt) {
    try {
        const completion = await deepseek.chat.completions.create({
            model: config.deepseekModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
        });
        return completion.choices[0].message.content;
    } catch (error) {
        logger.error('DeepSeek error:', error);
        throw error;
    }
}

module.exports = { callDeepSeek };
