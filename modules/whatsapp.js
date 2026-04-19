// modules/whatsapp.js - MODUL WHATSAPP LENGKAP
const axios = require('axios');
const { CONFIG } = require('../config');
const { getUserSession, setUserSession } = require('./cache');
const { getLevelInfoText } = require('./greetings');
const { processChat } = require('./chat-processor');

// Memory storage untuk user level (sementara)
const userLevels = new Map();
const userHasChosen = new Map();

// ============================================
// FUNGSI MANAJEMEN LEVEL USER
// ============================================
async function getUserLevel(userId, platform) {
  const sessionLevel = await getUserSession(userId, platform);
  if (sessionLevel) return sessionLevel;
  return userLevels.get(`${userId}:${platform}`) || 'sd_smp';
}

async function setUserLevel(userId, platform, level) {
  await setUserSession(userId, platform, level);
  userLevels.set(`${userId}:${platform}`, level);
  console.log(`[WA] Level user ${userId}: ${level}`);
}

async function hasUserChosenLevel(userId, platform) {
  const session = await getUserSession(userId, platform);
  if (session) return true;
  return userHasChosen.get(`${userId}:${platform}`) || false;
}

async function setUserChosenLevel(userId, platform, chosen = true) {
  userHasChosen.set(`${userId}:${platform}`, chosen);
}

// ============================================
// FUNGSI KIRIM PESAN KE WHATSAPP
// ============================================
async function sendWhatsAppMessage(to, text, apiKey) {
  // Ini adalah TEMPLATE - sesuaikan dengan provider WhatsApp yang Anda pakai
  // Provider yang umum digunakan:
  // 1. Fonnte (https://fonnte.com)
  // 2. WATI (https://wati.io)
  // 3. Twilio (https://twilio.com)
  // 4. Baileys (library Node.js gratis)
  
  console.log(`[WA] Mengirim pesan ke ${to}: ${text.substring(0, 100)}...`);
  
  // Contoh untuk FONNTE
  if (process.env.FONNTE_API_KEY) {
    try {
      await axios.post('https://api.fonnte.com/send', {
        target: to,
        message: text.substring(0, 4096),
      }, {
        headers: {
          'Authorization': process.env.FONNTE_API_KEY
        }
      });
      console.log(`[WA] Pesan terkirim ke ${to}`);
    } catch (err) {
      console.error(`[WA] Gagal kirim pesan: ${err.message}`);
    }
  }
  
  // Contoh untuk WATI
  if (process.env.WATI_API_KEY) {
    try {
      await axios.post('https://api.wati.io/api/v1/sendSessionMessage/' + to, {
        text: text.substring(0, 4096)
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.WATI_API_KEY}`
        }
      });
      console.log(`[WA] Pesan terkirim ke ${to} via WATI`);
    } catch (err) {
      console.error(`[WA] Gagal kirim via WATI: ${err.message}`);
    }
  }
}

// ============================================
// HANDLER WEBHOOK WHATSAPP (PENERIMA PESAN)
// ============================================
function handleWhatsAppWebhook(req, res) {
  // Langsung response 200 ke WhatsApp (biar tidak timeout)
  res.status(200).send('OK');
  
  // Proses pesan secara async
  (async () => {
    try {
      // Data masuk dari WhatsApp (format tergantung provider)
      let from, message, imageUrl, isPDF, pageCount;
      
      // ========== FONNTE FORMAT ==========
      if (req.body.sender && req.body.message) {
        from = req.body.sender;
        message = req.body.message;
        imageUrl = req.body.image_url || null;
        isPDF = req.body.is_pdf || false;
        pageCount = parseInt(req.body.page_count) || 1;
      }
      
      // ========== WATI FORMAT ==========
      else if (req.body.from && req.body.body) {
        from = req.body.from;
        message = req.body.body;
        imageUrl = req.body.media_url || null;
        isPDF = req.body.is_pdf || false;
      }
      
      // ========== TWILIO FORMAT ==========
      else if (req.body.From && req.body.Body) {
        from = req.body.From;
        message = req.body.Body;
      }
      
      // ========== BAILEYS FORMAT (Webhook sendiri) ==========
      else if (req.body.senderId && req.body.text) {
        from = req.body.senderId;
        message = req.body.text;
      }
      
      if (!from || !message) {
        console.log('[WA] Format pesan tidak dikenal:', req.body);
        return;
      }
      
      const userId = from.toString();
      const platform = 'whatsapp';
      
      // ========== HANDLE COMMAND LEVEL ==========
      let level = null;
      if (message === '/level_sd' || message === '/levelsdsmp') level = 'sd_smp';
      else if (message === '/level_sma' || message === '/levelsma') level = 'sma';
      else if (message === '/level_mahasiswa' || message === '/levelmahasiswa') level = 'mahasiswa';
      else if (message === '/level_dosen' || message === '/leveldosen') level = 'dosen_politikus';
      else if (message === '/level') {
        // Tampilkan level saat ini
        const currentLevel = await getUserLevel(userId, platform);
        await sendWhatsAppMessage(from, `📊 *Level Anda saat ini:* ${CONFIG.levelNames[currentLevel]}\n\n${getLevelInfoText()}`, null);
        return;
      }
      else if (message === '/start' || message === '/menu') {
        await sendWhatsAppMessage(from, getLevelInfoText(), null);
        return;
      }
      
      if (level) {
        await setUserLevel(userId, platform, level);
        await setUserChosenLevel(userId, platform, true);
        await sendWhatsAppMessage(from, `✅ *Level berhasil diubah!*\n\n📚 *${CONFIG.levelNames[level]}*\n💰 ${CONFIG.levelPrices[level]}\n\nSekarang kirim pertanyaan kamu! 🚀`, null);
        return;
      }
      
      // ========== CEK APAKAH SUDAH PILIH LEVEL ==========
      if (!await hasUserChosenLevel(userId, platform)) {
        await sendWhatsAppMessage(from, `👋 *Halo! Selamat datang di YENNI AI!*\n\n${getLevelInfoText()}`, null);
        return;
      }
      
      // ========== PROSES CHAT ==========
      console.log(`[WA] Pesan dari ${from}: ${message.substring(0, 100)}`);
      
      const userLevel = await getUserLevel(userId, platform);
      const result = await processChat(userId, platform, userLevel, message, imageUrl, isPDF, pageCount);
      
      // Kirim balasan
      await sendWhatsAppMessage(from, result.content, null);
      console.log(`[WA] Balasan ke ${from}: ${result.content.substring(0, 100)}...`);
      
    } catch (err) {
      console.error('[WA] Error processing webhook:', err);
    }
  })();
}

// ============================================
// FUNGSI SEND MESSAGE (UNTUK DIPANGGIL MODUL LAIN)
// ============================================
async function sendMessage(to, text) {
  return await sendWhatsAppMessage(to, text, null);
}

// ============================================
// EXPORT MODUL
// ============================================
module.exports = { 
  handleWhatsAppWebhook, 
  sendWhatsAppMessage,
  sendMessage,
  getUserLevel,
  setUserLevel
};
