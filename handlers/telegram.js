const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { isPremium, getRemainingChats } = require('../services/quotaManager');
const { createSubscription } = require('../services/xendit');
const axios = require('axios');
const logger = require('../utils/logger');

function setupTelegramHandler(bot) {
  // ==================== /START ====================
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

  // ==================== /GANTI_LEVEL ====================
  bot.command('ganti_level', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const user = await getUser(userId);
    if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');

    // Reset level di session
    const session = await getSession(userId);
    session.level = null;
    session.subLevel = null;
    await saveSession(userId, session);

    return ctx.reply(
      `🔁 Kakak mau pindah ke jenjang mana nih?\n\n` +
      `1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\n` +
      `Balas dengan angka pilihanmu ya.`
    );
  });

  // ==================== /UPGRADE ====================
  bot.command('upgrade', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const user = await getUser(userId);
    if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');

    const premium = await isPremium(userId);
    if (premium) {
      return ctx.reply('✨ Kakak sudah menjadi member **Yenni Premium**! Belajar sepuasnya tanpa batas~');
    }

    const level = user.level || 'sd-smp';
    const p = getPricingText(level);

    return ctx.reply(
      `🚀 *Upgrade ke Yenni Premium*\n\n` +
      `Dapatkan akses *unlimited chat* untuk belajar sepuasnya!\n\n` +
      `📋 *Pilihan Paket:*\n` +
      `- Mingguan: *Rp12.000* / 7 hari\n` +
      `- Bulanan: *Rp35.000* / 30 hari\n\n` +
      `Ketik */bayar mingguan* atau */bayar bulanan* untuk lanjut ke pembayaran ya~ 💳\n\n` +
      `Pembayaran bisa via *QRIS*, GoPay, Dana, ShopeePay, dll.`
    );
  });

  // ==================== /BAYAR ====================
  bot.command('bayar', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const user = await getUser(userId);
    if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');

    const premium = await isPremium(userId);
    if (premium) {
      return ctx.reply('✨ Kakak sudah premium! Tidak perlu bayar lagi~');
    }

    const args = ctx.message.text.split(' ');
    const packageKey = args[1]; // 'mingguan' atau 'bulanan'

    if (!packageKey || !['mingguan', 'bulanan'].includes(packageKey)) {
      return ctx.reply('Ketik */bayar mingguan* atau */bayar bulanan* ya, Kak.');
    }

    try {
      await ctx.reply('⏳ Yenni lagi buatkan link pembayaran...');
      const invoice = await createSubscription(userId, packageKey === 'mingguan' ? 'weekly' : 'monthly', ctx.from.first_name);

      await ctx.reply(
        `💳 *Pembayaran Yenni Premium - Paket ${packageKey === 'mingguan' ? 'Mingguan (Rp12.000)' : 'Bulanan (Rp35.000)'}*\n\n` +
        `Klik link atau scan QR code di bawah untuk bayar:\n` +
        `${invoice.payment_link_url}\n\n` +
        `⏰ Link berlaku 24 jam.\n` +
        `Setelah bayar, premium otomatis aktif ya, Kak~`
      );

      // Kirim QR code sebagai gambar
      if (invoice.qr_code_url) {
        await ctx.replyWithPhoto(invoice.qr_code_url, { caption: '📱 Scan QRIS di atas pakai HP Kakak~' });
      }
    } catch (error) {
      logger.error('Payment error:', error);
      await ctx.reply('😔 Maaf, ada gangguan di sistem pembayaran. Coba lagi nanti ya, Kak.');
    }
  });

  // ==================== /STATUS ====================
  bot.command('status', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const user = await getUser(userId);
    if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');

    const premium = await isPremium(userId);
    const remaining = await getRemainingChats(userId);

    let statusText = `📊 *Status Akun Yenni*\n\n`;
    statusText += `Jenjang: ${getUserLevelText(user.level, user.sub_level)}\n`;
    statusText += `Status: ${premium ? '✨ Premium (Unlimited)' : '🆓 Gratis'}\n`;

    if (!premium) {
      statusText += `Chat gratis hari ini: *${remaining}/10*\n`;
    }

    if (!premium) {
      statusText += `\nKetik */upgrade* buat langganan Premium~`;
    }

    await ctx.reply(statusText, { parse_mode: 'Markdown' });
  });

  // ==================== HANDLE TEXT MESSAGES ====================
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

    // Tampilkan indikator mengetik
    try {
      await ctx.sendChatAction('typing');
    } catch (actionErr) {
      logger.warn('Failed to send typing action:', actionErr);
    }

    try {
      const result = await processMessage(userId, message, session, 'telegram');

      // Kirim teks (split jika terlalu panjang)
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
        try {
          await ctx.replyWithPhoto(imageUrl);
        } catch (imgErr) {
          logger.error('Failed to send visualization image:', imgErr);
          await ctx.reply('📊 Maaf, gambar visualisasi gagal dikirim.');
        }
      }
    } catch (error) {
      logger.error('Telegram process error:', error);
      await ctx.reply('😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.');
    }
  });

  // ==================== HANDLE PHOTO (OCR) ====================
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

      const cleanUrl = fileUrl.href.split('\n')[0].trim();
      const caption = ctx.message.caption || 'Jelaskan gambar ini.';
      const escapedCaption = escapeHtml(caption);

      logger.info(`Processing image for user ${userId}, url: ${cleanUrl}`);

      const result = await processMessage(userId, `[IMAGE]${cleanUrl}\n${escapedCaption}`, session, 'telegram');

      const safeText = escapeHtml(result.text);
      if (safeText.length > 4000) {
        const chunks = splitMessage(safeText, 4000);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(safeText, { parse_mode: 'HTML' });
      }

      for (const imageUrl of result.images) {
        try {
          await ctx.replyWithPhoto(imageUrl);
        } catch (imgErr) {
          logger.error('Failed to send visualization image:', imgErr);
          await ctx.reply('📊 Maaf, gambar visualisasi gagal dikirim.');
        }
      }
    } catch (error) {
      logger.error('Telegram photo process error:', { message: error.message, stack: error.stack });
      let userMessage = '😔 Maaf, gambar tidak bisa diproses. ';
      if (error.message.includes('DOWNLOAD_FAILED') || error.message.includes('404')) {
        userMessage += 'Gagal mengunduh gambar. Coba kirim ulang ya.';
      } else if (error.message.includes('OCR_FAILED')) {
        userMessage += 'Tulisan di gambar kurang jelas, bisa difoto lebih dekat?';
      } else {
        userMessage += 'Coba lagi nanti ya.';
      }
      await ctx.reply(userMessage);
    }
  });

  // ==================== HANDLE DOCUMENT (PDF) ====================
  bot.on('document', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const session = await getSession(userId);
    if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');

    const doc = ctx.message.document;
    const fileName = doc.file_name || '';

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return ctx.reply('📎 Untuk saat ini Yenni hanya bisa membaca file PDF. Kirim sebagai gambar kalau mau tanya soal ya.');
    }

    try {
      await ctx.sendChatAction('upload_document');
    } catch {
      await ctx.sendChatAction('typing');
    }

    try {
      const fileId = doc.file_id;
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      if (!fileUrl || !fileUrl.href) throw new Error('Invalid file URL');

      const cleanUrl = fileUrl.href.split('\n')[0].trim();
      const caption = ctx.message.caption || 'Jelaskan isi PDF ini.';
      const escapedCaption = escapeHtml(caption);

      logger.info(`Processing PDF for user ${userId}, url: ${cleanUrl}`);

      const result = await processMessage(userId, `[PDF]${cleanUrl}\n${escapedCaption}`, session, 'telegram');

      const safeText = escapeHtml(result.text);
      if (safeText.length > 4000) {
        const chunks = splitMessage(safeText, 4000);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(safeText, { parse_mode: 'HTML' });
      }

      for (const imageUrl of result.images) {
        try {
          await ctx.replyWithPhoto(imageUrl);
        } catch (imgErr) {
          logger.error('Failed to send visualization image:', imgErr);
          await ctx.reply('📊 Maaf, gambar visualisasi gagal dikirim.');
        }
      }
    } catch (error) {
      logger.error('PDF process error:', { message: error.message, stack: error.stack });
      let userMessage = '😔 Maaf, file PDF tidak bisa diproses. ';
      if (error.message.includes('DOWNLOAD_FAILED')) {
        userMessage += 'Gagal mengunduh file. Coba kirim ulang ya.';
      } else if (error.message.includes('PDF_EXTRACT_FAILED')) {
        userMessage += 'Gagal membaca teks dari PDF. Pastikan PDF-nya bukan hasil scan.';
      } else {
        userMessage += 'Coba lagi nanti ya.';
      }
      await ctx.reply(userMessage);
    }
  });

  // ==================== HANDLE VOICE MESSAGE ====================
  bot.on('voice', async (ctx) => {
    const userId = `telegram:${ctx.from.id}`;
    const session = await getSession(userId);
    if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');

    try {
      await ctx.sendChatAction('record_voice');
    } catch (actionErr) {
      logger.warn('Failed to send record_voice action:', actionErr);
    }

    try {
      const voice = ctx.message.voice;
      if (!voice) throw new Error('No voice object');

      const fileId = voice.file_id;
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      if (!fileUrl || !fileUrl.href) throw new Error('Invalid voice file URL');

      logger.info(`Processing voice for user ${userId}, duration: ${voice.duration}s`);

      const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
      const audioBuffer = Buffer.from(response.data);

      await ctx.reply('🎤 Yenni dengerin suara Kakak dulu ya...');
      const transcribedText = await transcribeAudio(audioBuffer, 'audio/ogg');

      if (!transcribedText || transcribedText.trim().length === 0) {
        return ctx.reply('🎤 Maaf Kak, Yenni tidak bisa mendengar apa yang Kakak katakan. Bisa ulangi lagi?');
      }

      await ctx.reply(`📝 Yenni dengar: "${transcribedText}"`);

      const result = await processMessage(userId, transcribedText, session, 'telegram');

      if (result.text.length > 4000) {
        const chunks = splitMessage(result.text, 4000);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(result.text, { parse_mode: 'HTML' });
      }

      for (const imageUrl of result.images) {
        try {
          await ctx.replyWithPhoto(imageUrl);
        } catch (imgErr) {
          logger.error('Failed to send visualization:', imgErr);
        }
      }
    } catch (error) {
      logger.error('Voice processing error:', { message: error.message, stack: error.stack });
      let userMessage = '🎤 Maaf, suara Kakak tidak bisa diproses. ';
      if (error.message.includes('TRANSCRIBE_FAILED')) {
        userMessage += 'Ada kendala dengan layanan transkripsi. Coba lagi nanti ya.';
      } else {
        userMessage += 'Coba kirim ulang pesan suaranya atau ketik pertanyaanmu ya.';
      }
      await ctx.reply(userMessage);
    }
  });
}

// ==================== HELPER FUNCTIONS ====================
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

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function getPricingText(level) {
  // Tidak digunakan langsung, tapi untuk konsistensi
  return {
    'sd-smp': { weekly: 12000, monthly: 35000 },
    'sma-smk': { weekly: 12000, monthly: 35000 }
  }[level] || { weekly: 12000, monthly: 35000 };
}

module.exports = { setupTelegramHandler };
