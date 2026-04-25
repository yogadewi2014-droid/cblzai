const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const logger = require('../utils/logger');

function setupTelegramHandler(bot) {
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

    session = session || { level: user.level, subLevel: user.sub_level, history: [] };
    await saveSession(userId, session);
    const levelText = getUserLevelText(user.level, user.sub_level);
    await ctx.reply(`Halo lagi, Kak ${ctx.from.first_name || ''}! 👋\nKamu terdaftar sebagai siswa ${levelText}. Ada yang bisa Yenni bantu?`);
  });

  bot.on('text', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const message = ctx.message.text;
    let session = await getSession(userId);
    let user = await getUser(userId);

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

    try {
      await ctx.sendChatAction('typing');
    } catch (actionErr) {
      logger.warn('Failed to send typing action:', actionErr);
    }

    try {
      const result = await processMessage(userId, message, session, 'telegram');

      // Kirim teks (potong jika panjang)
      if (result.text.length > 4000) {
        const chunks = splitMessage(result.text, 4000);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(result.text, { parse_mode: 'HTML' });
      }

      // Kirim gambar visualisasi
      for (const imageUrl of result.images) {
        await ctx.replyWithPhoto(imageUrl);
      }
    } catch (error) {
      logger.error('Telegram process error:', error);
      await ctx.reply('😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.');
    }
  });

  // Handle foto (OCR)
  bot.on('photo', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const session = await getSession(userId);
    if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');

    try {
      await ctx.sendChatAction('upload_photo');
    } catch {
      await ctx.sendChatAction('typing');
    }

    try {
      const photo = ctx.message.photo.pop();
      if (!photo) throw new Error('No photo object');

      const fileId = photo.file_id;
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      if (!fileUrl || !fileUrl.href) throw new Error('Invalid file URL');

      const caption = ctx.message.caption || 'Jelaskan gambar ini.';
      const escapedCaption = caption.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      logger.info(`Processing image for user ${userId}, url: ${fileUrl.href}`);

      const result = await processMessage(userId, `[IMAGE]${fileUrl.href}\n${escapedCaption}`, session, 'telegram');

      const safeText = result.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (safeText.length > 4000) {
        const chunks = splitMessage(safeText, 4000);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(safeText, { parse_mode: 'HTML' });
      }

      for (const imageUrl of result.images) {
        await ctx.replyWithPhoto(imageUrl);
      }
    } catch (error) {
      logger.error('Telegram photo process error:', { message: error.message, stack: error.stack });
      let userMessage = '😔 Maaf, gambar tidak bisa diproses. ';
      if (error.message.includes('DOWNLOAD_FAILED')) {
        userMessage += 'Gagal mengunduh gambar. Coba kirim ulang ya.';
      } else if (error.message.includes('OCR_FAILED')) {
        userMessage += 'Tulisan di gambar kurang jelas, bisa difoto lebih dekat?';
      } else {
        userMessage += 'Coba lagi nanti ya.';
      }
      await ctx.reply(userMessage);
    }
  });
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let current = '';
  const words = text.split(' ');
  for (const word of words) {
    if ((current + ' ' + word).length > maxLength) {
      chunks.push(current.trim());
      current = word;
    } else {
      current += (current ? ' ' : '') + word;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
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
