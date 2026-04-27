require('dotenv').config();

module.exports = {
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    googleVisionKeyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    serperApiKey: process.env.SERPER_API_KEY,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    whatsappEnabled: process.env.WHATSAPP_ENABLED === 'true',

    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,

    upstashRedisUrl: process.env.UPSTASH_REDIS_URL,
    upstashRedisToken: process.env.UPSTASH_REDIS_TOKEN,

    geminiModel: 'gemini-2.5-flash-lite',
    openaiModel: 'gpt-4o-mini',
    openaiNanoModel: 'gpt-4o-mini',
    deepseekModel: 'deepseek-reasoner',

    wordLimits: {
        'sd-1-3': { default: 100, detail: 150, article: 200 },
        'sd-4-6': { default: 150, detail: 250, article: 300 },
        'smp':    { default: 200, detail: 350, article: 400 },
        'sma':    { default: 300, detail: 500, article: 600 },
        'smk':    { default: 300, detail: 500, article: 600 }
    },

    summaryThreshold: 3000,
    maxContextTokens: 6000,

    cacheTTL: {
        session: 86400,
        search: 3600,
        ocr: 86400,
        exactMatch: 300,
        semantic: 1800
    },

    rateLimit: {
        ip: { windowMs: 15 * 60 * 1000, max: 20 },
        user: { windowMs: 60 * 60 * 1000, max: 50 },
        dailyTokenQuota: 10000
    },

    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    semanticSimilarityThreshold: 0.88
};
