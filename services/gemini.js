const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const { callOpenAI } = require('./openai');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

async function callGemini(prompt, options = {}) {
    const model = genAI.getGenerativeModel({ model: config.geminiModel });
    try {
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        logger.warn('Gemini error, fallback to GPT-5.4 Mini:', error.message);
        return callOpenAI(prompt, { model: config.openaiModel, ...options });
    }
}

module.exports = { callGemini };
