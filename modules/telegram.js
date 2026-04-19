// modules/telegram.js
const axios = require('axios');
const { CONFIG } = require('../config');
const { getUserSession, setUserSession } = require('./cache');
const { getLevelInfoText } = require('./greetings');
const { processChat } = require('./chat-processor');

const userLevels = new Map();
const userHasChosen = new Map();

async function getUserLevel(userId, platform) {
  const sessionLevel = await getUserSession(userId, platform);
  if (sessionLevel) return sessionLevel;
  return userLevels.get(`${userId}:${platform}`) || 'sd_smp';
}

async function setUserLevel(userId, platform, level) {
  await setUserSession(userId, platform, level);
  userLevels.set(`${userId}:${platform}`, level);
}

async function hasUserChosenLevel(userId, platform) {
  const session = await getUserSession(userId, platform);
  if (session) return true;
  return userHasChosen.get(`${userId}:${platform}`) || false;
}

async function sendTelegramMessage(chatId, text) {
  if (!CONFIG.telegram.token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`, {
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: 'Markdown'
    });
  } catch (e) {}
}

function handleTelegramWebhook(req, res) {
  res.status(200).send('OK');
  
  (async () => {
    try {
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
        const fileInfo = await axios.get(`https://api.telegram.org/bot${CONFIG.telegram.token}/getFile?file_id=${photo.file_id}`);
        imageUrl = `https://api.telegram.org/file/bot${CONFIG.telegram.token}/${fileInfo.data.result.file_path}`;
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
          await setUserLevel(userId, platform, level);
          await sendTelegramMessage(chatId, `✅ Level: ${CONFIG.levelNames[level]}\nSekarang kirim pertanyaan!`);
          return;
        }
        
        await sendTelegramMessage(chatId, 'Perintah tidak dikenal. Gunakan /start');
        return;
      }
      
      if (!await hasUserChosenLevel(userId, platform)) {
        await sendTelegramMessage(chatId, getLevelInfoText());
        return;
      }
      
      const userLevel = await getUserLevel(userId, platform);
      const result = await processChat(userId, platform, userLevel, text, imageUrl, isPDF, pageCount);
      await sendTelegramMessage(chatId, result.content);
      
    } catch (err) {
      console.error('Telegram error:', err);
    }
  })();
}

module.exports = { handleTelegramWebhook };
