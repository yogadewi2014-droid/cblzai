// modules/whatsapp/index.js
const axios = require('axios');
const { CONFIG } = require('../../config');
const { getLevelInfoText } = require('../greetings');
const { processChat } = require('../chat-processor');

// Helper functions menggunakan container.cache
async function getUserLevel(userId, platform, cache) {
  const session = await cache.get(`session:${userId}:${platform}`);
  return session?.level || 'sd_smp';
}

async function setUserLevel(userId, platform, level, cache) {
  await cache.set(`session:${userId}:${platform}`, { level, lastActive: Date.now() }, 86400);
}

async function hasUserChosenLevel(userId, platform, cache) {
  const session = await cache.get(`session:${userId}:${platform}`);
  return !!session;
}

async function sendWhatsAppMessage(to, text) {
  // Contoh untuk Fonnte
  const apiKey = process.env.FONNTE_API_KEY;
  if (apiKey) {
    try {
      await axios.post('https://api.fonnte.com/send', {
        target: to,
        message: text.substring(0, 4096),
      }, {
        headers: { 'Authorization': apiKey }
      });
    } catch (err) {
      console.error('WhatsApp send error:', err.message);
    }
  } else {
    console.log(`[WA] Pesan ke ${to}: ${text.substring(0, 100)}...`);
  }
}

// Controller utama
async function whatsappController(req, res) {
  const { container } = req;
  const payload = req.body;
  
  // Deteksi format provider (Fonnte, Wati, dll)
  let from, message, imageUrl, isPDF = false, pageCount = 1;
  
  if (payload.sender && payload.message) {
    from = payload.sender;
    message = payload.message;
    imageUrl = payload.image_url || null;
    isPDF = payload.is_pdf || false;
    pageCount = parseInt(payload.page_count) || 1;
  } else if (payload.from && payload.body) {
    from = payload.from;
    message = payload.body;
    imageUrl = payload.media_url || null;
  } else if (payload.From && payload.Body) {
    from = payload.From;
    message = payload.Body;
  } else if (payload.senderId && payload.text) {
    from = payload.senderId;
    message = payload.text;
  } else {
    console.log('[WA] Unknown format:', payload);
    return;
  }
  
  if (!from || !message) return;
  
  const userId = from.toString();
  const platform = 'whatsapp';
  
  // Handle command level
  let level = null;
  if (message === '/level_sd' || message === '/levelsdsmp') level = 'sd_smp';
  else if (message === '/level_sma' || message === '/levelsma') level = 'sma';
  else if (message === '/level_mahasiswa' || message === '/levelmahasiswa') level = 'mahasiswa';
  else if (message === '/level_dosen' || message === '/leveldosen') level = 'dosen_politikus';
  else if (message === '/level') {
    const currentLevel = await getUserLevel(userId, platform, container.cache);
    await sendWhatsAppMessage(from, `📊 *Level Anda saat ini:* ${CONFIG.levelNames?.[currentLevel] || currentLevel}\n\n${getLevelInfoText()}`);
    return;
  } else if (message === '/start' || message === '/menu') {
    await sendWhatsAppMessage(from, getLevelInfoText());
    return;
  }
  
  if (level) {
    await setUserLevel(userId, platform, level, container.cache);
    await sendWhatsAppMessage(from, `✅ *Level berhasil diubah!*\n\n📚 *${CONFIG.levelNames?.[level] || level}*\n💰 ${CONFIG.levelPrices?.[level] || ''}\n\nSekarang kirim pertanyaan kamu! 🚀`);
    return;
  }
  
  // Cek apakah user sudah pilih level
  if (!await hasUserChosenLevel(userId, platform, container.cache)) {
    await sendWhatsAppMessage(from, `👋 *Halo! Selamat datang di YENNI AI!*\n\n${getLevelInfoText()}`);
    return;
  }
  
  const userLevel = await getUserLevel(userId, platform, container.cache);
  const result = await processChat(
    userId, platform, userLevel, message, imageUrl, isPDF, pageCount,
    container.cache,
    container.db
  );
  
  await sendWhatsAppMessage(from, result.content);
}

module.exports = { whatsappController };
