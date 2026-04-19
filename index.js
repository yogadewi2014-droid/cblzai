// ============================================
// INDEX.JS - YENNI AI BACKEND v3.0
// MULTI PLATFORM: TELEGRAM + WHATSAPP + WEB
// ============================================

require('dotenv').config();
const express = require('express');
const cron = require('nrequire('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const Queue = require('bull');
const Redis = require('ioredis');

// Services
const { initSupabase } = require('./modules/database');

// Controllers
const { telegramController } = require('./modules/telegram');
const { whatsappController } = require('./modules/whatsapp');

// API
const { setupWebAPI } = require('./modules/web-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================
// LOGGER
// ==========================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  console.log(JSON.stringify({
    level, message, ...meta,
    time: new Date().toISOString(),
    service: 'yenni'
  }));
}

function logWebhook(level, message, req, meta = {}) {
  const base = {
    platform: req.path.includes('telegram') ? 'telegram' : 'whatsapp',
    userId: req.body?.message?.from?.id || req.body?.sender,
    updateId: req.body?.update_id || req.body?.id,
    ip: req.ip,
    requestId: req.id
  };
  log(level, message, { ...base, ...meta });
}

// ==========================
// REDIS CONNECTION (POOL)
// ==========================
const redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

redisClient.on('error', (err) => log('error', 'Redis error', { error: err.message }));
redisClient.on('connect', () => log('info', 'Redis connected'));

// ==========================
// QUEUE SETUP
// ==========================
const telegramQueue = new Queue('telegram', { createClient: () => redisClient });
const whatsappQueue = new Queue('whatsapp', { createClient: () => redisClient });

// Konfigurasi queue
telegramQueue.process(20, async (job) => {  // 20 job concurrently
  const { payload, requestId } = job.data;
  const fakeReq = {
    body: payload,
    id: requestId,
    container: { db: container.db, cache: container.cache } // pass global container
  };
  await telegramController(fakeReq, null);
});

whatsappQueue.process(20, async (job) => {
  const { payload, requestId } = job.data;
  const fakeReq = {
    body: payload,
    id: requestId,
    container: { db: container.db, cache: container.cache }
  };
  await whatsappController(fakeReq, null);
});

// Event monitoring
telegramQueue.on('failed', (job, err) => {
  log('error', 'Telegram job failed', { jobId: job.id, error: err.message });
});
whatsappQueue.on('failed', (job, err) => {
  log('error', 'WhatsApp job failed', { jobId: job.id, error: err.message });
});

// ==========================
// MIDDLEWARE
// ==========================
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" }, contentSecurityPolicy: false }));
app.use(compression({ level: 6, threshold: '1kb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Container global (read-only)
const container = { cache: null, db: null, ready: false, shuttingDown: false };
app.use((req, res, next) => {
  req.container = container;
  if (container.shuttingDown) return res.status(503).json({ error: 'Shutting down' });
  next();
});

// ==========================
// RATE LIMITER (GLOBAL + PER USER)
// ==========================
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 500, // maks 500 request per menit dari semua user
  keyGenerator: () => 'global',
  standardHeaders: true
});

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: async (req) => req.path.includes('/telegram') ? 300 : 200,
  keyGenerator: (req) => req.body?.message?.from?.id ? `tg:${req.body.message.from.id}` : (req.body?.sender ? `wa:${req.body.sender}` : req.ip),
  standardHeaders: true
});

// ==========================
// IDEMPOTENSI (REDIS)
// ==========================
async function isDuplicate(req, ttlSeconds = 120) {
  let id = req.body?.update_id || req.body?.id || req.body?.message_id;
  if (!id) {
    const hash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
    id = hash;
  }
  const key = `webhook:dup:${req.path}:${id}`;
  const processed = await redisClient.get(key);
  if (processed) return true;
  await redisClient.setex(key, ttlSeconds, '1');
  return false;
}

// ==========================
// VERIFIKASI
// ==========================
function verifyTelegram(req, res, next) {
  const token = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (token && req.headers['x-telegram-bot-api-secret-token'] !== token) {
    logWebhook('warn', 'Invalid Telegram token', req);
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

function verifyWhatsApp(req, res, next) {
  const key = process.env.FONNTE_API_KEY;
  if (key && req.headers.authorization !== `Bearer ${key}`) {
    logWebhook('warn', 'Invalid WhatsApp key', req);
    return res.status(403).json({ error: 'Invalid key' });
  }
  next();
}

// ==========================
// QUEUE HANDLER (RESPONSE CEPAT)
// ==========================
async function queueHandler(req, res, queue) {
  // Cek duplikat sebelum masuk queue
  if (await isDuplicate(req)) {
    logWebhook('debug', 'Duplicate ignored', req);
    return res.status(200).json({ status: 'duplicate' });
  }

  // Ambil hanya field yang diperlukan (hemat memory)
  const importantFields = ['update_id', 'message', 'sender', 'id', 'message_id', 'callback_query', 'from'];
  const payload = {};
  for (const field of importantFields) {
    if (req.body[field] !== undefined) payload[field] = req.body[field];
  }
  // Juga sertakan nested yang umum
  if (req.body.message?.text) payload.message = { text: req.body.message.text, from: req.body.message.from, chat: req.body.message.chat };
  if (req.body.sender) payload.sender = req.body.sender;
  if (req.body.id) payload.id = req.body.id;

  // Tambahkan ke queue
  await queue.add({ payload, requestId: req.id }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  });

  logWebhook('info', 'Queued', req);
  res.status(200).json({ status: 'queued', requestId: req.id });
}

// ==========================
// ROUTES
// ==========================
app.post('/webhook/telegram', globalLimiter, webhookLimiter, verifyTelegram, (req, res) => queueHandler(req, res, telegramQueue));
app.post('/webhook/whatsapp', globalLimiter, webhookLimiter, verifyWhatsApp, (req, res) => queueHandler(req, res, whatsappQueue));
app.post('/webhook/fonnte', globalLimiter, webhookLimiter, verifyWhatsApp, (req, res) => queueHandler(req, res, whatsappQueue));

setupWebAPI(app);

// ==========================
// HEALTH CHECK
// ==========================
app.get('/health', async (req, res) => {
  const redisStatus = redisClient.status === 'ready' ? 'up' : 'down';
  const tgQueueCount = await telegramQueue.count();
  const waQueueCount = await whatsappQueue.count();
  res.json({
    status: container.ready ? 'OK' : 'INIT',
    uptime: process.uptime(),
    redis: redisStatus,
    queues: { telegram: tgQueueCount, whatsapp: waQueueCount },
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
  });
});

// ==========================
// FALLBACK SERVICES
// ==========================
function createMemoryCache() { /* sama seperti sebelumnya */ }
function createDummyDb() { /* sama */ }

async function initServices() {
  try {
    // Cache: gunakan redisClient langsung, atau memory fallback
    if (redisClient.status === 'ready') {
      container.cache = {
        get: async (key) => redisClient.get(key),
        set: async (key, val, ttl) => redisClient.setex(key, ttl, val),
        cleanup: async () => {},
        quit: async () => redisClient.quit()
      };
      log('info', 'Redis cache ready');
    } else {
      throw new Error('Redis not ready');
    }
  } catch (err) {
    log('warn', 'Redis fallback to memory', { error: err.message });
    container.cache = createMemoryCache();
  }

  try {
    container.db = initSupabase();
    log('info', 'Database ready');
  } catch (err) {
    log('error', 'DB fallback to dummy', { error: err.message });
    container.db = createDummyDb();
  }

  container.ready = true;
}

// ==========================
// CRON & SHUTDOWN
// ==========================
let cleanupJob = cron.schedule('0 * * * *', async () => {
  log('info', 'Running cleanup');
  if (container.cache?.cleanup) await container.cache.cleanup();
});

async function shutdown(signal) {
  if (container.shuttingDown) return;
  container.shuttingDown = true;
  log('warn', `${signal} received, shutting down`);

  cleanupJob.stop();
  await telegramQueue.close();
  await whatsappQueue.close();
  await redisClient.quit();

  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('error', 'Unhandled rejection', { error: err.message }));
process.on('uncaughtException', (err) => {
  log('fatal', 'Uncaught exception', { error: err.message });
  shutdown('uncaughtException');
});

// ==========================
// START
// ==========================
let server;
async function start() {
  await initServices();
  server = app.listen(PORT, () => log('info', `Server started on port ${PORT}`));
}
start();ode-cron');

// Import semua module
const { initRedis } = require('./modules/cache');
const { initSupabase } = require('./modules/database');
const { handleTelegramWebhook } = require('./modules/telegram');
const { handleWhatsAppWebhook } = require('./modules/whatsapp');  // ✅ WA MODULE
const { setupWebAPI } = require('./modules/web-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logger sederhana untuk debug
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// INISIALISASI SERVICE
// ============================================
async function init() {
  try {
    await initRedis();        // Cache (Redis/Memory)
    console.log('✅ Redis/Cache initialized');
  } catch (err) {
    console.warn('⚠️ Redis init warning:', err.message);
  }
  
  try {
    initSupabase();           // Database Supabase
    console.log('✅ Supabase initialized');
  } catch (err) {
    console.warn('⚠️ Supabase init warning:', err.message);
  }
}

init();

// ============================================
// WEBHOOK UNTUK TELEGRAM
// ============================================
app.post('/webhook/telegram', (req, res) => {
  console.log('📨 [TELEGRAM] Webhook received');
  handleTelegramWebhook(req, res);
});

// ============================================
// WEBHOOK UNTUK WHATSAPP
// ============================================
app.post('/webhook/whatsapp', (req, res) => {
  console.log('📨 [WHATSAPP] Webhook received');
  handleWhatsAppWebhook(req, res);
});

// ============================================
// WEBHOOK UNTUK WHATSAPP (Fonnte Format Khusus)
// ============================================
app.post('/webhook/fonnte', (req, res) => {
  console.log('📨 [FONNTE] Webhook received');
  handleWhatsAppWebhook(req, res);
});

// ============================================
// SETUP SEMUA API ENDPOINTS
// (chat, level, health, dll)
// ============================================
setupWebAPI(app);

// ============================================
// ROOT ENDPOINT (Info Server)
// ============================================
app.get('/', (req, res) => {
  res.json({
    name: 'Yenni - Sahabat AI Anda',
    version: '3.0.0',
    status: 'running',
    platforms: {
      telegram: process.env.TELEGRAM_BOT_TOKEN ? '✅ Active' : '❌ Not configured',
      whatsapp: (process.env.FONNTE_API_KEY || process.env.WATI_API_KEY) ? '✅ Active' : '❌ Not configured',
      web: '✅ Active'
    },
    endpoints: {
      telegram: '/webhook/telegram',
      whatsapp: '/webhook/whatsapp',
      fonnte: '/webhook/fonnte',
      api: '/api/chat',
      levels: '/api/levels',
      health: '/health'
    }
  });
});

// ============================================
// HEALTH CHECK (Untuk Railway & Monitoring)
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    platforms: {
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      whatsapp: !!(process.env.FONNTE_API_KEY || process.env.WATI_API_KEY),
      supabase: true
    }
  });
});

// ============================================
// PING ENDPOINT (Untuk keep-alive)
// ============================================
app.get('/ping', (req, res) => {
  res.send('pong');
});

// ============================================
// ENDPOINT TEST UNTUK WEBHOOK (Debug)
// ============================================
app.post('/test/telegram', (req, res) => {
  console.log('🧪 [TEST] Telegram webhook test:', req.body);
  res.json({ received: true, body: req.body });
});

app.post('/test/whatsapp', (req, res) => {
  console.log('🧪 [TEST] WhatsApp webhook test:', req.body);
  res.json({ received: true, body: req.body });
});

// ============================================
// CLEANUP CRON JOB (Setiap jam)
// ============================================
cron.schedule('0 * * * *', async () => {
  console.log('🧹 Running cleanup cron job...');
  // Cleanup logic bisa ditambahkan di sini jika perlu
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                         🤖 YENNI - SAHABAT AI ANDA 🤖                         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  ✅ Server running on port: ${PORT}                                               ║
║  ✅ Status: ONLINE                                                            ║
║                                                                              ║
║  📱 PLATFORMS:                                                                ║
║     ├─ Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? '🟢 ACTIVE' : '🔴 INACTIVE (no token)'}        ║
║     ├─ WhatsApp Bot: ${(process.env.FONNTE_API_KEY || process.env.WATI_API_KEY) ? '🟢 ACTIVE' : '🔴 INACTIVE (no API key)'}        ║
║     └─ Web API:       🟢 ACTIVE                                              ║
║                                                                              ║
║  🔗 ENDPOINTS:                                                                ║
║     ├─ GET  /              → Info server                                      ║
║     ├─ GET  /health        → Health check                                    ║
║     ├─ GET  /ping          → Keep-alive                                      ║
║     ├─ POST /api/chat      → Chat API                                        ║
║     ├─ GET  /api/levels    → Daftar level                                    ║
║     ├─ POST /api/level     → Set level user                                  ║
║     ├─ POST /webhook/telegram → Telegram webhook                             ║
║     ├─ POST /webhook/whatsapp → WhatsApp webhook (Fonnte/WATI)               ║
║     └─ POST /webhook/fonnte   → Fonnte webhook (alternatif)                  ║
║                                                                              ║
║  🚀 YENNI SIAP MEMBANTU!                                                      ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
  `);
});

// ============================================
// GRACEFUL SHUTDOWN (Penanganan mati server)
// ============================================
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

module.exports = app;
