require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initRedis, closeRedis } = require('./conversation/sessionManager');
const { setupTelegramHandler } = require('./handlers/telegram');
const { verifyWebhook, handleWebhook } = require('./handlers/whatsappCloud');
const { getTransactionStatus } = require('./services/midtrans');
const { activatePremium } = require('./services/quotaManager');
const { ipLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(ipLimiter);

const port = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => res.status(200).send('Yenni AI OK'));

// Redis
initRedis();

// === WHATSAPP CLOUD API WEBHOOK ===
if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN) {
    app.get('/webhook/whatsapp', verifyWebhook);
    app.post('/webhook/whatsapp', handleWebhook);
    logger.info('WhatsApp Cloud API webhook registered');
}

// === MIDTRANS PAYMENT NOTIFICATION WEBHOOK ===
app.post('/webhook/midtrans', async (req, res) => {
    try {
        const notification = req.body;
        logger.info('Midtrans notification:', {
            order_id: notification.order_id,
            transaction_status: notification.transaction_status
        });

        if (notification.order_id) {
            // Verifikasi langsung ke Midtrans (hindari spoofing)
            const status = await getTransactionStatus(notification.order_id);
            logger.info('Midtrans verified status:', status);

            if (status.transaction_status === 'settlement' || status.transaction_status === 'capture') {
                // Pembayaran sukses
                const meta = notification.metadata || {};
                const userId = meta.user_id;
                const pkg = meta.package || 'monthly'; // default bulanan

                if (userId) {
                    const durationDays = pkg === 'weekly' ? 7 : 30;
                    await activatePremium(userId, durationDays);
                    logger.info(`Premium activated for ${userId}, ${durationDays}d (${pkg}) via Midtrans`);
                }
            } else if (status.transaction_status === 'expire') {
                logger.info(`Transaction ${notification.order_id} expired`);
            } else if (status.transaction_status === 'cancel') {
                logger.info(`Transaction ${notification.order_id} cancelled`);
            }
        }

        // Selalu balas 200 OK agar Midtrans tidak kirim ulang notifikasi
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        logger.error('Midtrans webhook error:', error);
        // Tetap balas 200 agar tidak terjadi retry loop
        res.status(200).json({ status: 'error', message: 'Internal Server Error' });
    }
});

// === TELEGRAM BOT ===
if (config.telegramToken) {
    const bot = new Telegraf(config.telegramToken);
    setupTelegramHandler(bot);

    if (process.env.NODE_ENV === 'production') {
        const webhookPath = `/telegram-webhook-${config.telegramToken.split(':')[0]}`;
        app.use(bot.webhookCallback(webhookPath));
        bot.telegram.setWebhook(`${config.baseUrl}${webhookPath}`);
        logger.info(`Telegram webhook set to ${config.baseUrl}${webhookPath}`);
    } else {
        bot.launch();
        logger.info('Telegram bot started (polling)');
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down...');
    await closeRedis();
    process.exit(0);
});

// Tangkap uncaught exception agar container tidak mati total
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', {
        message: error.message,
        stack: error.stack
    });
    // Jangan exit, biarkan container tetap hidup
});

// Tangkap unhandled rejection
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(port, () => {
    logger.info(`Yenni AI running on port ${port}`);
});
