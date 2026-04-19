// modules/telegram.js (atau modules/telegram/index.js)
const axios = require('axios');
const { CONFIG } = require('../config');
const { getLevelInfoText } = require('./greetings');
const { processChat } = require('./chat-processor');

// Helper untuk mengirim pesan Telegram
async function sendTelegramMessage(chatId, text) {
  if (!CONFIG.telegram.token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`, {
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('Send message error:', e.message);
  }
}

// Helper untuk mendapatkan file URL dari Telegram
async function getTelegramFileUrl(fileId) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${CONFIG.telegram.token}/getFile?file_id=${fileId}`);
    const filePath = response.data.result.file_path;
    return `https://api.telegram.org/file/bot${CONFIG.telegram.token}/${filePath}`;
  } catch (e) {
    console.error('Get file error:', e.message);
    return null;
  }
}

// Controller utama
async function telegramController(req, res) {
  // Ambil container dari request
  const { container } = req;
  const update = req.body;

  if (!update?.message) return;

  const chatId = update.message.chat.id;
  const userId = update.message.from.id.toString();
  const text = update.message.text || '';
  const platform = 'telegram';
  let imageUrl = null;
  let isPDF = false;
  let pageCount = 1;

  // Deteksi gambar
  if (update.message.photo && update.message.photo.length > 0) {
    const photo = update.message.photo[update.message.photo.length - 1];
    imageUrl = await getTelegramFileUrl(photo.file_id);
  }
  // TODO: deteksi dokumen (PDF) jika perlu

  // Fungsi untuk mendapatkan level user dari cache
  async function getUserLevel() {
    const session = await container.cache.get(`session:${userId}:${platform}`);
    return session?.level || 'sd_smp';
  }

  async function setUserLevel(level) {
    await container.cache.set(`session:${userId}:${platform}`, { level, lastActive: Date.now() }, 86400);
  }

  async function hasUserChosenLevel() {
    const session = await container.cache.get(`session:${userId}:${platform}`);
    return !!session;
  }

  // Handle command
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/start') {
      await sendTelegramMessage(chatId, getLevelInfoText());
      return;
    }

    let level = null;
    if (cmd === '/level_sd') level = 'sd_smp';
    else if (cmd === '/level_sma') level = 'sma';
    else if (cmd === '/level_mahasiswa') level = 'mahasiswa';
    else if (cmd === '/level_dosen') level = 'dosen_politikus';

    if (level) {
      await setUserLevel(level);
      await sendTelegramMessage(chatId, `✅ Level: ${CONFIG.levelNames?.[level] || level}\nSekarang kirim pertanyaan!`);
      return;
    }

    await sendTelegramMessage(chatId, 'Perintah tidak dikenal. Gunakan /start');
    return;
  }

  // Jika user belum pilih level
  if (!await hasUserChosenLevel()) {
    await sendTelegramMessage(chatId, getLevelInfoText());
    return;
  }

  const userLevel = await getUserLevel();
  // Panggil processChat dengan cache dan db dari container
  // Perhatikan: processChat membutuhkan db dengan method getChatHistory dan saveChatMessage
  // Kita akan membuat wrapper sederhana dari supabase yang ada di container.db
  const dbWrapper = {
    getChatHistory: async (userId, platform, limit) => {
      // container.db adalah supabase client
      const { data, error } = await container.db
        .from('chat_history')
        .select('role, content')
        .eq('user_id', userId)
        .eq('platform', platform)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return [];
      return (data || []).reverse();
    },
    saveChatMessage: async (userId, platform, role, content, modelUsed) => {
      await container.db.from('chat_history').insert({
        user_id: userId,
        platform,
        role,
        content,
        model_used: modelUsed,
        created_at: new Date()
      });
    }
  };

  const result = await processChat(
    userId, platform, userLevel, text,
    imageUrl, isPDF, pageCount,
    container.cache,
    dbWrapper
  );

  await sendTelegramMessage(chatId, result.content);
}

module.exports = { telegramController };
