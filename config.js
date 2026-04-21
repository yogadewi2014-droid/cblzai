require('dotenv').config();

module.exports = {
  // API Keys
  geminiApiKey: process.env.GEMINI_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  googleVisionKeyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // path file JSON
  serperApiKey: process.env.SERPER_API_KEY,

  // Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // WhatsApp
  whatsappEnabled: process.env.WHATSAPP_ENABLED === 'true',

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,

  // Upstash Redis
  upstashRedisUrl: process.env.UPSTASH_REDIS_URL,
  upstashRedisToken: process.env.UPSTASH_REDIS_TOKEN,

  // Model LLM
  geminiModel: 'gemini-2.5-flash-lite',
  openaiModel: 'gpt-5.4-mini',    // fallback
  openaiNanoModel: 'gpt-5.4-nano', // fallback kedua
  deepseekModel: 'deepseek-reasoner',

  // Batasan Kata per Sub-Jenjang (Psikologi Perkembangan)
  wordLimits: {
    'sd-1-3': { default: 100, detail: 150, article: 200 },
    'sd-4-6': { default: 150, detail: 250, article: 300 },
    'smp':    { default: 200, detail: 350, article: 400 },
    'sma':    { default: 300, detail: 500, article: 600 },
    'smk':    { default: 300, detail: 500, article: 600 }
  },

  // Threshold token untuk summarization
  summaryThreshold: 3000,
  maxContextTokens: 6000,

  // Caching
  cacheTTL: {
    session: 86400,        // 1 hari
    search: 3600,          // 1 jam
    ocr: 86400,            // 1 hari
    exactMatch: 300,       // 5 menit
    semantic: 1800         // 30 menit
  },

  // Rate Limiting
  rateLimit: {
    ip: { windowMs: 15 * 60 * 1000, max: 20 },
    user: { windowMs: 60 * 60 * 1000, max: 50 },
    dailyTokenQuota: 10000
  },

  // Embedding model untuk semantic cache
  embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  semanticSimilarityThreshold: 0.88
};
