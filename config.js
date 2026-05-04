require('dotenv').config();

module.exports = {
    // ========================
    // API KEYS
    // ========================
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    googleVisionKeyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // untuk OCR (Vision)
    serperApiKey: process.env.SERPER_API_KEY,

    // ========================
    // TELEGRAM
    // ========================
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',

    // ========================
    // WHATSAPP CLOUD API
    // ========================
    whatsappEnabled: process.env.WHATSAPP_ENABLED === 'true', // sudah tidak dipakai, tapi simpan untuk kompatibilitas

    // ========================
    // SUPABASE
    // ========================
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,

    // ========================
    // UPSTASH REDIS
    // ========================
    upstashRedisUrl: process.env.UPSTASH_REDIS_URL,
    upstashRedisToken: process.env.UPSTASH_REDIS_TOKEN,

    // ========================
    // MODEL LLM
    // ========================
    geminiModel: 'gemini-2.5-flash-lite',
    openaiModel: 'gpt-4o-mini',
    openaiNanoModel: 'gpt-4o-mini',
    deepseekModel: 'deepseek-reasoner',

    // ========================
    // BATASAN KATA PER JENJANG
    // ========================
    wordLimits: {
        'sd-1-3': { default: 100, detail: 150, article: 200 },
        'sd-4-6': { default: 150, detail: 250, article: 300 },
        'smp':    { default: 200, detail: 350, article: 400 },
        'sma':    { default: 300, detail: 500, article: 600 },
        'smk':    { default: 300, detail: 500, article: 600 }
    },

    // ========================
    // THRESHOLD TOKEN UNTUK SUMMARIZATION
    // ========================
    summaryThreshold: 3000,
    maxContextTokens: 6000,

    // ========================
    // CACHE TTL (DALAM DETIK)
    // ========================
    cacheTTL: {
        session: 86400,      // 1 hari
        search: 3600,        // 1 jam
        ocr: 86400,          // 1 hari
        exactMatch: 300,     // 5 menit
        semantic: 1800       // 30 menit
    },

    // ========================
    // RATE LIMITING
    // ========================
    rateLimit: {
        ip: { windowMs: 15 * 60 * 1000, max: 20 },
        user: { windowMs: 60 * 60 * 1000, max: 50 },
        dailyTokenQuota: 10000
    },

    // ========================
    // EMBEDDING
    // ========================
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2', // tidak dipakai langsung, tapi untuk referensi
    semanticSimilarityThreshold: 0.88,

    // ========================
    // GOOGLE CLOUD TTS (VOICE OUTPUT)
    // ========================
    googleCloudTtsConfig: {
        useStandard: true,          // gratis 4M karakter/bulan
        defaultLanguage: 'id-ID',
        defaultVoice: 'id-ID-Standard-A',
        fallbackVoice: 'en-US-Standard-B',
        speakingRate: 1.0,
        pitch: 0.0,
        audioEncoding: 'MP3'
    },

    // ========================
    // PEXELS API (UNTUK GAMBAR VIDEO)
    // ========================
    pexelsApiKey: process.env.PEXELS_API_KEY || null,

    // ========================
    // WIKIMEDIA (TIDAK PERLU API KEY)
    // ========================
    wikimediaTimeout: 2000,         // ms

    // ========================
    // TIMEOUT GLOBAL UNTUK PENCARIAN GAMBAR
    // ========================
    imageSearchTimeout: 2500,       // ms

    // ========================
    // VIDEO MAKER (FFMPEG)
    // ========================
    videoMaker: {
        outputFormat: 'mp4',
        codecVideo: 'libx264',
        preset: 'ultrafast',
        tune: 'stillimage',
        codecAudio: 'aac',
        audioBitrate: '64k',
        pixelFormat: 'yuv420p',
        resolution: '720:720'      // scale & pad
    },

    // ========================
    // MEDIA CACHE (REDIS) TTL
    // ========================
    mediaCacheTTL: {
        image: 86400 * 3,           // 3 hari
        voice: 86400,               // 1 hari
        video: 86400 * 2           // 2 hari
    }
};
