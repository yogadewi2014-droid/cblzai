// ============================================
// INDEX.JS - YENNI AI BACKEND v3.0
// MULTI PLATFORM: TELEGRAM + WHATSAPP + WEB
// ============================================

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

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
