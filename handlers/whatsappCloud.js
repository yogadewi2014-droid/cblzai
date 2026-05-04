const { getSession, saveSession } = require('../conversation/sessionManager');
const { getUser, createUser, updateUserLevel } = require('../services/supabase');
const { processMessage } = require('./messageProcessor');
const { transcribeAudio } = require('../services/speechToText');
const { getUserTier, checkTypeQuota, incrementTypeQuota, getAllRemaining } = require('../services/quotaManager');
const { createPaymentLink, PACKAGES } = require('../services/midtrans');
const axios = require('axios');
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
                `👋 Halo! Aku Yenni, asisten belajar AI.\nPilih jenjang pendidikanmu dulu yuk:\n\n` +
                `1️⃣ SD Kelas 1-3\n2️⃣ SD Kelas 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK\n\n` +
                `Balas dengan angka pilihanmu ya.`
            );
        }
        session = session || { level: user.level, subLevel: user.sub_level, history: [] };
        delete session.upgrade_pending;
        await saveSession(userId, session);
        const levelText = getUserLevelText(user.level, user.sub_level);
        await ctx.reply(`Halo lagi, Kak ${ctx.from.first_name || ''}! 👋\nKamu terdaftar sebagai siswa ${levelText}. Ada yang bisa Yenni bantu?`);
    });

    bot.command('ganti_level', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        const user = await getUser(userId);
        if (!user) return ctx.reply('Kakak belum terdaftar. Ketik /start dulu ya.');
        session.level = null; session.subLevel = null;
        delete session.upgrade_pending;
        await saveSession(userId, session);
        return ctx.reply(`🔁 Kakak mau pindah ke jenjang mana nih?\n\n1️⃣ SD 1-3\n2️⃣ SD 4-6\n3️⃣ SMP\n4️⃣ SMA\n5️⃣ SMK`);
    });

    bot.command('upgrade', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const user = await getUser(userId);
        if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');
        const tier = await getUserTier(userId);
        if (tier === 'pro') return ctx.reply('✨ Kakak sudah menjadi member Yenni PRO! Akses semua fitur tanpa batas.');
        if (tier === 'go') {
            // Tawarkan upgrade ke PRO
            let session = await getSession(userId);
            session.upgrade_pending = true;
            session.upgrade_from = 'go';
            await saveSession(userId, session);
            return ctx.reply(
                `🚀 *Upgrade ke PRO*\n\n` +
                `Kakak saat ini di paket GO. Upgrade ke PRO untuk dapatkan:\n` +
                `✅ Teks 150/hari + Voice 50/hari + Video 30/hari\n` +
                `✅ Model AI reasoning (DeepSeek)\n` +
                `✅ Progress tracking\n\n` +
                `Harga: Rp75.000/bulan\n\n` +
                `Balas *2* untuk upgrade ke PRO ya~`
            );
        }

        let session = await getSession(userId);
        session.upgrade_pending = true;
        session.upgrade_from = 'free';
        await saveSession(userId, session);

        return ctx.reply(
            `🚀 *Pilih Paket Premium*\n\n` +
            `1️⃣ GO — Rp35.000/bulan\n   ✅ Teks 75/hari + Voice 20/hari + Video 10/hari\n` +
            `   ✅ Input: Teks, Suara, OCR\n` +
            `   ✅ Output: Teks, Suara, Video\n\n` +
            `2️⃣ PRO — Rp75.000/bulan\n   ✅ Teks 150/hari + Voice 50/hari + Video 30/hari\n` +
            `   ✅ Semua fitur GO +\n` +
            `   ✅ Model AI reasoning (DeepSeek)\n\n` +
            `Balas dengan angka *1* (GO) atau *2* (PRO) ya, Kak~`
        );
    });

    bot.command('bayar', async (ctx) => {
        const payload = ctx.message.text.split(' ')[1];
        if (!payload) return ctx.reply('Ketik /bayar go atau /bayar pro.');
        const pkg = (payload === 'pro' || payload === 'PRO') ? 'pro' : 'go';
        await handlePayment(ctx, pkg);
    });

    bot.command('status', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const tier = await getUserTier(userId);
        const r = await getAllRemaining(userId);
        const tierName = tier === 'free' ? 'Free' : tier.toUpperCase();
        return ctx.reply(`📊 *Status Yenni*\n\nTier: ${tierName}\nKuota hari ini:\n- Teks: ${r.text}\n- Gambar: ${r.image}\n- Voice: ${r.voice}\n- Video: ${r.ffmpeg || 0}`);
    });

    // Handler teks utama
    bot.on('text', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const message = ctx.message.text;
        let session = await getSession(userId);
        let user = await getUser(userId);

        if (session?.upgrade_pending) {
            const choice = message.trim();
            if (choice === '1' || choice === '2') {
                let pkg;
                if (session.upgrade_from === 'go' && choice === '2') pkg = 'pro';
                else if (choice === '1') pkg = 'go';
                else pkg = 'pro';
                delete session.upgrade_pending;
                delete session.upgrade_from;
                await saveSession(userId, session);
                return await handlePayment(ctx, pkg);
            } else if (choice.startsWith('/')) {
                delete session.upgrade_pending;
                delete session.upgrade_from;
                await saveSession(userId, session);
            } else {
                return ctx.reply('Silakan pilih *1* untuk GO atau *2* untuk PRO ya, Kak.');
            }
        }

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
            await sendLongText(ctx, result.text);
            for (const url of result.images) { try { await ctx.replyWithPhoto(url); } catch (e) {} }
        } catch (error) {
            logger.error('Telegram process error:', error);
            await ctx.reply('😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.');
        }
    });

    // Handler foto, dokumen, voice
    bot.on('photo', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
        const tier = await getUserTier(userId);
        if (tier === 'free') return ctx.reply('📷 OCR hanya tersedia untuk paket GO dan PRO. Ketik /upgrade untuk upgrade ya~');
        try { await ctx.sendChatAction('upload_photo'); } catch { await ctx.sendChatAction('typing'); }
        try {
            const photo = ctx.message.photo.pop();
            const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
            const cleanUrl = fileUrl.href.split('\n')[0].trim();
            const caption = escapeHtml(ctx.message.caption || 'Jelaskan gambar ini.');
            const result = await processMessage(userId, `[IMAGE]${cleanUrl}\n${caption}`, session, 'telegram');
            await sendLongText(ctx, result.text);
            for (const url of result.images) { try { await ctx.replyWithPhoto(url); } catch (e) {} }
        } catch (error) {
            logger.error('Photo error:', error);
            await ctx.reply('😔 Gambar tidak bisa diproses. Coba lagi ya.');
        }
    });

    bot.on('document', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
        const tier = await getUserTier(userId);
        if (tier === 'free') return ctx.reply('📄 PDF hanya tersedia untuk paket GO dan PRO. Ketik /upgrade untuk upgrade ya~');
        const doc = ctx.message.document;
        if (!(doc.file_name || '').toLowerCase().endsWith('.pdf')) return ctx.reply('📎 Yenni hanya bisa membaca PDF.');
        try { await ctx.sendChatAction('upload_document'); } catch { await ctx.sendChatAction('typing'); }
        try {
            const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
            const cleanUrl = fileUrl.href.split('\n')[0].trim();
            const caption = escapeHtml(ctx.message.caption || 'Jelaskan isi PDF ini.');
            const result = await processMessage(userId, `[PDF]${cleanUrl}\n${caption}`, session, 'telegram');
            await sendLongText(ctx, result.text);
            for (const url of result.images) { try { await ctx.replyWithPhoto(url); } catch (e) {} }
        } catch (error) {
            logger.error('PDF error:', error);
            await ctx.reply('😔 PDF tidak bisa diproses. Coba lagi ya.');
        }
    });

    bot.on('voice', async (ctx) => {
        const userId = `telegram:${ctx.from.id}`;
        const session = await getSession(userId);
        if (!session?.level) return ctx.reply('Pilih jenjang dulu dengan /start ya.');
        const tier = await getUserTier(userId);
        if (tier === 'free') return ctx.reply('🎤 Voice note hanya tersedia untuk paket GO dan PRO. Ketik /upgrade untuk upgrade ya~');

        const voiceQuota = await checkTypeQuota(userId, 'voice');
        if (!voiceQuota.allowed) return ctx.reply('🎤 Kuota voice note Kakak sudah habis hari ini!');

        try { await ctx.sendChatAction('record_voice'); } catch (e) {}
        try {
            const voice = ctx.message.voice;
            if (voice.duration > 120) return ctx.reply('🎤 Maaf, maksimal 2 menit per voice note.');
            const fileUrl = await ctx.telegram.getFileLink(voice.file_id);
            const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
            const audioBuffer = Buffer.from(response.data);
            await ctx.reply('🎤 Yenni dengerin suara Kakak dulu ya...');
            const transcribed = await transcribeAudio(audioBuffer, 'audio/ogg');
            if (!transcribed || transcribed.trim().length === 0) return ctx.reply('🎤 Maaf, Yenni tidak bisa mendengar.');
            await ctx.reply(`📝 Yenni dengar: "${transcribed}"`);
            await incrementTypeQuota(userId, 'voice');
            const result = await processMessage(userId, transcribed, session, 'telegram');
            await sendLongText(ctx, result.text);
            for (const url of result.images) { try { await ctx.replyWithPhoto(url); } catch (e) {} }
        } catch (error) {
            logger.error('Voice error:', error);
            await ctx.reply('🎤 Suara tidak bisa diproses.');
        }
    });
}

async function handlePayment(ctx, pkg) {
    const userId = `telegram:${ctx.from.id}`;
    const user = await getUser(userId);
    if (!user) return ctx.reply('Ketik /start dulu ya, Kak.');
    try {
        const invoice = await createPaymentLink(userId, pkg, ctx.from.first_name);
        return ctx.reply(
            `💳 *Pembayaran Yenni ${PACKAGES[pkg].name}*\n\n` +
            `Klik link berikut:\n${invoice.payment_link_url}\n\n` +
            `QRIS & semua metode tersedia. Link berlaku 24 jam.\n` +
            `Premium aktif otomatis setelah pembayaran.\n\nCek status: /status`
        );
    } catch (error) {
        logger.error('Payment error:', error);
        return ctx.reply('😔 Gangguan pembayaran. Coba lagi nanti.');
    }
}

async function sendLongText(ctx, text) {
    if (text.length > 4000) {
        for (const chunk of splitMessage(text, 4000)) await ctx.reply(chunk, { parse_mode: 'HTML' });
    } else await ctx.reply(text, { parse_mode: 'HTML' });
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
