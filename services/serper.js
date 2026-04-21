const axios = require('axios');
const config = require('../config');
const { callGemini } = require('./gemini');
const { getCachedSearchResult, cacheSearchResult } = require('../middleware/cacheHandler');
const logger = require('../utils/logger');

async function searchAndSummarize(query) {
    const cached = await getCachedSearchResult(query);
    if (cached) return cached;

    try {
        const response = await axios.post('https://google.serper.dev/search',
            { q: query },
            { headers: { 'X-API-KEY': config.serperApiKey } }
        );
        const results = response.data.organic || [];
        const snippets = results.slice(0, 3).map(r => `${r.title}\n${r.snippet}`).join('\n\n');
        const summaryPrompt = `Ringkas informasi berikut dalam 3-5 kalimat mudah dipahami:\n${snippets}`;
        const summary = await callGemini(summaryPrompt);
        await cacheSearchResult(query, summary);
        return summary;
    } catch (error) {
        logger.error('Serper error:', error);
        return 'Maaf, tidak bisa mencari informasi saat ini.';
    }
}

module.exports = { searchAndSummarize };
