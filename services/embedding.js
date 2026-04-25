const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite'; // Model gratis yang cepat dan akurat

async function generateEmbedding(text) {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
        logger.warn('No Voyage AI API key found. Semantic cache disabled.');
        return null;
    }
    try {
        const response = await axios.post(VOYAGE_API_URL, {
            input: [text],
            model: VOYAGE_MODEL
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.data[0].embedding;
    } catch (error) {
        logger.error('Voyage AI Embedding error:', error.message);
        return null;
    }
}

function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { generateEmbedding, cosineSimilarity };
