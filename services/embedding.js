const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Menggunakan model ringan dari Hugging Face Inference API (gratis tier)
const HF_API_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN || null;

/**
 * Menghasilkan vektor embedding dari teks
 */
async function generateEmbedding(text) {
    if (!HF_TOKEN) {
        logger.warn('No Hugging Face token, semantic cache disabled');
        return null;
    }
    try {
        const response = await axios.post(HF_API_URL, 
            { inputs: text, options: { wait_for_model: true } },
            { headers: { Authorization: `Bearer ${HF_TOKEN}` } }
        );
        return response.data; // array of floats
    } catch (error) {
        logger.error('Embedding generation error:', error.message);
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
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { generateEmbedding, cosineSimilarity };
