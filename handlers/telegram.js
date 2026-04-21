const { Telegraf } = require('telegraf');
const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const logger = require('../utils/logger');

function setupTelegramHandler(bot) {
  // /start command
  bot.start(async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    let user = await getUser(userId);
    let session = await getSession(userId);

    if (!user) {
      session = { level: null, subLevel: null, history: [] };
      await saveSession(userId, session);
      return ctx.reply(
        `👋 Halo! Aku Yenni, asisten belajar AI.\n` +
        `Pilih jenjang pendidikanmu dulu yuk:\n\n` +
        `1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\n` +
        `Balas dengan angka pilihanmu ya.`
      );
    }

    // User sudah terdaftar
    session = session || { level: user.level, subLevel: user.sub_level, history: [] };
    await saveSession(userId, session);
    const levelText = getUserLevelText(user.level, user.sub_level);
    ctx.reply(`Halo lagi, Kak ${ctx.from.first_name || ''}! 👋\nKamu terdaftar sebagai siswa ${levelText}. Ada yang bisa Yenni bantu?`);
  });

  // Handle text messages
  bot.on('text', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const message = ctx.message.text;
    let session = await getSession(userId);
    let user = await getUser(userId);

    // Jika belum pilih jenjang
    if (!user || !session?.level) {
      const choice = message.trim();
      let level, subLevel;
      if (choice === '1') { level = 'sd-smp'; subLevel = 'sd-1-3'; }
      else if (choice === '2') { level = 'sd-smp'; subLevel = 'sd-4-6'; }
      else if (choice === '3') { level = 'sd-smp'; subLevel = 'smp'; }
      else if (choice === '4') { level = 'sma-smk'; subLevel = 'sma'; }
      else if (choice === '5') { level = 'sma-smk'; subLevel = 'smk'; }
      else {
        return ctx.reply('🙏 Maaf, balas dengan angka 1,2,3,4, atau 5 ya.');
      }

      if (!user) {
        await createUser(userId, 'telegram', level, subLevel);
      } else {
        await updateUserLevel(userId, level, subLevel);
      }
      session = { level, subLevel, history: [] };
      await saveSession(userId, session);
      return ctx.reply(`✅ Siap! Kamu terdaftar sebagai siswa ${getUserLevelText(level, subLevel)}.\nSekarang, tanya apa saja ya! 😊`);
    }

    // Proses pesan normal
    ctx.sendChatAction('typing');
    try {
      const response = await processMessage(userId, message, session, 'telegram');
      // Pisahkan jika terlalu panjang untuk Telegram (batas 4096 karakter)
      if (response.length > 4000) {
        const chunks = response.match(/[\s\S]{1,4000}/g) || [];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } else {
        await ctx.reply(response, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error('Telegram process error:', error);
      ctx.reply('😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.');
    }
  });

  // Handle photo (OCR)
  bot.on('photo', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const session = await getSession(userId);
    if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
    
    ctx.sendChatAction('typing');
    const fileId = ctx.message.photo.pop().file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const caption = ctx.message.caption || 'Jelaskan gambar ini.';
    const response = await processMessage(userId, `[IMAGE]${fileUrl.href}\n${caption}`, session, 'telegram');
    ctx.reply(response);
  });
}

function getUserLevelText(level, subLevel) {
  const map = {
    'sd-1-3': 'SD Kelas 1-3',
    'sd-4-6': 'SD Kelas 4-6',
    'smp': 'SMP',
    'sma': 'SMA',
    'smk': 'SMK'
  };
  return map[subLevel] || level;
}

module.exports = { setupTelegramHandler };
