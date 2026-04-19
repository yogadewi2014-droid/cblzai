require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const redis = require('redis');

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
// REDIS CONNECTION
// ==========================
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});

redisClient.on('error', (err) => log('error', 'Redis error', { error: err.message }));
redisClient.on('connect', () => log('info', 'Redis connected'));

// Koneksi ke Redis (async)
(async () => {
  await redisClient.connect();
})();

// ==========================
// SIMPLE QUEUE (MANUAL)
// ==========================
const QUEUE_KEYS = {
  telegram: 'queue:telegram',
  whatsapp: 'queue:whatsapp'
};

// Menambahkan job ke antrian
async function enqueue(platform, payload, requestId) {
  const job = {
    id: `${Date.now()}:${requestId}`,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0
  };
  await redisClient.lPush(QUEUE_KEYS[platform], JSON.stringify(job));
  log('debug', `Enqueued ${platform} job`, { jobId: job.id });
}

// Worker: proses antrian (jalan terus di background)
async function processQueue(platform, handler) {
  while (true) {
    try {
      const jobStr = await redisClient.rPop(QUEUE_KEYS[platform]);
      if (!jobStr) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      const job = JSON.parse(jobStr);
      log('info', `Processing ${platform} job`, { jobId: job.id });
      
      const fakeReq = {
        body: job.payload,
        id: job.id,
        container: { db: container.db, cache: container.cache },
        path: `/${platform}`
      };
      
      await handler(fakeReq, null);
      log('info', `Job ${platform} completed`, { jobId: job.id });
    } catch (err) {
      log('error', `Worker error for ${platform}`, { error: err.message });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

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

const container = { cache: null, db: null, ready: false, shuttingDown: false };
app.use((req, res, next) => {
  req.container = container;
  if (container.shuttingDown) return res.status(503).json({ error: 'Shutting down' });
  next();
});

// ==========================
// RATE LIMITER
// ==========================
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
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
// IDEMPOTENSI
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
  await redisClient.setEx(key, ttlSeconds, '1');
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
// WEBHOOK HANDLER
// ==========================
async function handleWebhook(req, res, platform) {
  if (await isDuplicate(req)) {
    logWebhook('debug', 'Duplicate ignored', req);
    return res.status(200).json({ status: 'duplicate' });
  }

  const payload = {
    update_id: req.body.update_id,
    message: req.body.message,
    sender: req.body.sender,
    id: req.body.id,
    message_id: req.body.message_id,
    callback_query: req.body.callback_query,
    from: req.body.from
  };

  await enqueue(platform, payload, req.id);
  logWebhook('info', 'Queued', req);
  res.status(200).json({ status: 'queued', requestId: req.id });
}

app.post('/webhook/telegram', globalLimiter, webhookLimiter, verifyTelegram, (req, res) => handleWebhook(req, res, 'telegram'));
app.post('/webhook/whatsapp', globalLimiter, webhookLimiter, verifyWhatsApp, (req, res) => handleWebhook(req, res, 'whatsapp'));
app.post('/webhook/fonnte', globalLimiter, webhookLimiter, verifyWhatsApp, (req, res) => handleWebhook(req, res, 'whatsapp'));

setupWebAPI(app);

// ==========================
// HEALTH CHECK
// ==========================
app.get('/health', async (req, res) => {
  const redisStatus = redisClient.isOpen ? 'up' : 'down';
  const tgQueueLen = await redisClient.lLen(QUEUE_KEYS.telegram).catch(() => 0);
  const waQueueLen = await redisClient.lLen(QUEUE_KEYS.whatsapp).catch(() => 0);
  res.json({
    status: container.ready ? 'OK' : 'INIT',
    uptime: process.uptime(),
    redis: redisStatus,
    queues: { telegram: tgQueueLen, whatsapp: waQueueLen },
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
  });
});

// ==========================
// FALLBACK SERVICES
// ==========================
function createMemoryCache() {
  const store = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now > entry.expiry) store.delete(key);
    }
  }, 60 * 60 * 1000);
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttl = 3600) {
      store.set(key, { value, expiry: Date.now() + ttl * 1000 });
    },
    async cleanup() {
      const now = Date.now();
      for (const [k, v] of store.entries()) {
        if (now > v.expiry) store.delete(k);
      }
    },
    async quit() { store.clear(); }
  };
}

function createDummyDb() {
  return {
    from: (table) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      insert: async (data) => ({ data: null, error: null }),
      update: async (data) => ({ data: null, error: null }),
      delete: () => ({ eq: () => ({ error: null }) })
    })
  };
}

async function initServices() {
  try {
    if (redisClient.isOpen) {
      container.cache = {
        get: async (key) => redisClient.get(key),
        set: async (key, val, ttl) => redisClient.setEx(key, ttl, val),
        cleanup: async () => {},
        quit: async () => redisClient.quit()
      };
      log('info', 'Redis cache ready');
    } else {
      throw new Error('Redis not open');
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
// START WORKER
// ==========================
let workerTelegram, workerWhatsapp;

function startWorkers() {
  workerTelegram = processQueue('telegram', telegramController);
  workerWhatsapp = processQueue('whatsapp', whatsappController);
  log('info', 'Queue workers started');
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
  if (container.cache?.quit) await container.cache.quit();
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
// START SERVER
// ==========================
let server;
async function start() {
  await initServices();
  startWorkers();
  server = app.listen(PORT, () => log('info', `Server started on port ${PORT}`));
}
start();
