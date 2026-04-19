// index.js - FILE UTAMA UNTUK RAILWAY
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { initRedis } = require('./modules/cache');
const { initSupabase } = require('./modules/database');
const { handleTelegramWebhook } = require('./modules/telegram');
const { setupWebAPI } = require('./modules/web-api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Inisialisasi semua service saat server start
async function init() {
  await initRedis();      // Koneksi ke Redis (cache)
  initSupabase();         // Koneksi ke Supabase (database)
}
init();

// Setup semua API endpoints (chat, level, dll)
setupWebAPI(app);

// Webhook untuk Telegram Bot
app.post('/webhook/telegram', handleTelegramWebhook);

// Root endpoint untuk cek status
app.get('/', (req, res) => {
  res.json({ 
    name: 'Yenni - Sahabat AI Anda', 
    version: '3.0.0', 
    status: 'running' 
  });
});

// Health check untuk Railway
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                 🤖 YENNI - SAHABAT AI ANDA 🤖                       ║
╠════════════════════════════════════════════════════════════════════╣
║  ✅ Server running on port ${PORT}                                      ║
║  ✅ YENNI siap membantu! 🚀                                         ║
║  ✅ MODULAR CODE - SEMUA FILE SUDAH DIPISAH                        ║
╚════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
