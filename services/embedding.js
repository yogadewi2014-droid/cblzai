const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../utils/logger');

// Gunakan API key yang sama dengan Gemini
const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Menghasilkan embedding vector dari teks menggunakan model embedding Google
 * Model: 'embedding-001' (gratis, 1.500 request per menit, input hingga 2.048 token)
 */
async function generateEmbedding(text) {
    if (!config.geminiApiKey) {
        logger.warn('No Gemini API key, semantic cache disabled');
        return null;
    }
    try {
        const model = genAI.getGenerativeModel({ model: 'embedding-001' });
        const result = await model.embedContent(text);
        return result.embedding.values; // array of floats
    } catch (error) {
        logger.error('Google Embedding error:', error.message);
        return null;
    }
}

/**
 * Menghitung cosine similarity antara dua vektor
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecB[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { generateEmbedding, cosineSimilarity };
