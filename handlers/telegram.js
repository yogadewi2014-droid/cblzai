// handlers/telegram.js
const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { isPremium, checkTypeQuota, incrementTypeQuota } = require('../services/quotaManager');
const { createPaymentLink, PACKAGES } = require('../services/midtrans');
const axios = require('axios');
const logger = require('../utils/logger');

function setupTelegramHandler(bot) {
    // ==================== /start ====================
    bot.start(async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        let user = await getUser(userId);
        let session = await getSession(userId);
        if (!user) {
            session = { level: null, subLevel: null, history: [] };
            await saveSession(userId, session);
            return ctx.reply(
                `👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n` +
                `1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\n` +
                `Balas dengan angka pilihanmu ya.`
            );
        }
        session = session || { level: user.level, subLevel: user.sub_level, history: [] };
        await saveSession(userId, session);
        const levelText = getUserLevelText(user.level, user.sub_level);
        await ctx.reply(`Halo lagi, Kak ${ctx.from.first_name || ''}! 👋\nKamu terdaftar sebagai siswa ${levelText}. Ada yang bisa Yenni bantu?`);
    });

    // ==================== /ganti_level ====================
    bot.command('ganti_level', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        const user = await getUser(userId);
        if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');
        session.level = null; session.subLevel = null;
        await saveSession(userId, session);
        return ctx.reply(`🔁 Kakak mau pindah ke jenjang mana nih?\n\n1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\nBalas dengan angka pilihanmu ya.`);
    });

    // ==================== /upgrade ====================
    bot.command('upgrade', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const user = await getUser(userId);
        if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');
        const premium = await isPremium(userId);
        if (premium) return ctx.reply('✨ Kakak sudah menjadi member Yenni Premium!');
        return ctx.reply(
            `🚀 Upgrade ke Yenni Premium\n\n` +
            `- Mingguan: Rp${PACKAGES.weekly.amount.toLocaleString()} / ${PACKAGES.weekly.durationDays} hari\n` +
            `- Bulanan: Rp${PACKAGES.monthly.amount.toLocaleString()} / ${PACKAGES.monthly.durationDays} hari\n\n` +
            `Ketik /bayar mingguan atau /bayar bulanan untuk lanjut pembayaran~`
        );
    });

    // ==================== /bayar ====================
    bot.command('bayar', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const user = await getUser(userId);
        if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');
        const payload = ctx.message.text.split(' ')[1];
        const pkg = (payload === 'mingguan') ? 'weekly' : 'monthly';
        try {
            const invoice = await createPaymentLink(userId, pkg, ctx.from.first_name);
            await ctx.reply(
                `💳 *Pembayaran Yenni Premium*\n\n` +
                `Klik link atau scan QRIS di bawah:\n${invoice.payment_link_url}\n\n` +
                `⏰ Link berlaku 24 jam.\nSetelah bayar, premium aktif otomatis ya~`
            );
        } catch (error) {
            logger.error('Failed to create Midtrans payment:', error);
            await ctx.reply('😔 Gangguan sistem pembayaran. Coba lagi nanti ya.');
        }
    });

    // ==================== /status ====================
    bot.command('status', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const premium = await isPremium(userId);
        if (premium) return ctx.reply('✨ Kakak adalah member Yenni Premium! Chat unlimited~');
        const { getAllRemaining } = require('../services/quotaManager');
        const r = await getAllRemaining(userId);
        return ctx.reply(`📊 Kuota hari ini:\n- Chat teks: ${r.text}/10\n- Gambar: ${r.image}/3\n- Voice: ${r.voice}/5`);
    });

    // ==================== TEXT ====================
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
            else return ctx.reply('🙏 Maaf, balas dengan angka 1-5 ya.');
            if (!user) await createUser(userId, 'telegram', level, subLevel);
            else await updateUserLevel(userId, level, subLevel);
            session = { level, subLevel, history: [] };
            await saveSession(userId, session);
            return ctx.reply(`✅ Siap! Kamu terdaftar sebagai siswa ${getUserLevelText(level, subLevel)}.\nSekarang, tanya apa saja ya! 😊`);
        }
        try { await ctx.sendChatAction('typing'); } catch (e) {}
        try {
            const result = await processMessage(userId, message, session, 'telegram');
            await sendLongTextAndImages(ctx, result.text, result.images);
        } catch (error) {
            logger.error('Telegram text error:', error);
            await ctx.reply('😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.');
        }
    });

    // ==================== PHOTO (OCR) ====================
    bot.on('photo', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
        try { await ctx.sendChatAction('upload_photo'); } catch { await ctx.sendChatAction('typing'); }
        try {
            const photo = ctx.message.photo.pop();
            const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
            const cleanUrl = fileUrl.href.split('\n')[0].trim();
            const caption = escapeHtml(ctx.message.caption || 'Jelaskan gambar ini.');
            const result = await processMessage(userId, `[IMAGE]${cleanUrl}\n${caption}`, session, 'telegram');
            await sendLongTextAndImages(ctx, result.text, result.images);
        } catch (error) {
            logger.error('Telegram photo error:', error);
            await ctx.reply('😔 Gambar tidak bisa diproses. Coba lagi ya.');
        }
    });

    // ==================== DOCUMENT (PDF) ====================
    bot.on('document', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
        const doc = ctx.message.document;
        if (!(doc.file_name || '').toLowerCase().endsWith('.pdf')) return ctx.reply('📎 Yenni hanya bisa membaca PDF.');
        try { await ctx.sendChatAction('upload_document'); } catch { await ctx.sendChatAction('typing'); }
        try {
            const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
            const cleanUrl = fileUrl.href.split('\n')[0].trim();
            const caption = escapeHtml(ctx.message.caption || 'Jelaskan isi PDF ini.');
            const result = await processMessage(userId, `[PDF]${cleanUrl}\n${caption}`, session, 'telegram');
            await sendLongTextAndImages(ctx, result.text, result.images);
        } catch (error) {
            logger.error('Telegram PDF error:', error);
            await ctx.reply('😔 PDF tidak bisa diproses. Coba lagi ya.');
        }
    });

    // ==================== VOICE ====================
    bot.on('voice', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');

        // Cek kuota voice
        const voiceQuota = await checkTypeQuota(userId, 'voice');
        if (!voiceQuota.allowed && !voiceQuota.isPremium) {
            return ctx.reply('🎤 Kuota voice note Kakak sudah habis hari ini! Yuk upgrade ke Yenni Premium biar bisa kirim voice sepuasnya.');
        }

        try { await ctx.sendChatAction('record_voice'); } catch (e) {}

        try {
            const voice = ctx.message.voice;

            // Batas durasi 2 menit
            if (voice.duration > 120) {
                return ctx.reply('🎤 Maaf, voice note Kakak terlalu panjang (lebih dari 2 menit). Bisa kirim yang lebih singkat saja ya.');
            }

            const fileUrl = await ctx.telegram.getFileLink(voice.file_id);
            const resp = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
            const audioBuffer = Buffer.from(resp.data);

            await ctx.reply('🎤 Yenni dengerin suara Kakak dulu ya...');
            const transcribed = await transcribeAudio(audioBuffer, 'audio/ogg');

            if (!transcribed || transcribed.trim().length === 0) {
                return ctx.reply('🎤 Maaf, Yenni tidak bisa mendengar. Bisa ulangi lagi?');
            }

            await ctx.reply(`📝 Yenni dengar: "${transcribed}"`);
            await incrementTypeQuota(userId, 'voice');

            const result = await processMessage(userId, transcribed, session, 'telegram');
            await sendLongTextAndImages(ctx, result.text, result.images);

        } catch (error) {
            logger.error('Telegram voice error:', error);
            await ctx.reply('🎤 Suara tidak bisa diproses. Coba lagi ya.');
        }
    });
}

// ==================== HELPERS ====================
async function sendLongTextAndImages(ctx, text, images) {
    if (text.length > 4000) {
        for (const chunk of splitMessage(text, 4000)) {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
        }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML' });
    }
    for (const url of images) {
        try { await ctx.replyWithPhoto(url); } catch (e) {}
    }
}

function splitMessage(text, max) {
    const chunks = []; let cur = '';
    for (const w of text.split(' ')) {
        if ((cur + ' ' + w).length > max) { chunks.push(cur.trim()); cur = w; }
        else cur += (cur ? ' ' : '') + w;
    }
    if (cur) chunks.push(cur.trim());
    return chunks;
}

function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function getUserLevelText(level, subLevel) {
    const map = { 'sd-1-3':'SD Kelas 1-3','sd-4-6':'SD Kelas 4-6','smp':'SMP','sma':'SMA','smk':'SMK' };
    return map[subLevel] || level;
}

module.exports = { setupTelegramHandler };
