require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initRedis, closeRedis } = require('./conversation/sessionManager');
const { setupTelegramHandler } = require('./handlers/telegram');
const { verifyWebhook, handleWebhook } = require('./handlers/whatsappCloud');
const { getTransactionStatus } = require('./services/midtrans');
const { setUserTier } = require('./services/quotaManager');
const { ipLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(ipLimiter);

const port = process.env.PORT || 3000;

app.get('/health', (req, res) => res.status(200).send('Yenni AI OK'));

initRedis();

if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN) {
    app.get('/webhook/whatsapp', verifyWebhook);
    app.post('/webhook/whatsapp', handleWebhook);
    logger.info('WhatsApp Cloud API webhook registered');
}

app.post('/webhook/midtrans', async (req, res) => {
    try {
        const notification = req.body;
        if (notification.order_id) {
            const status = await getTransactionStatus(notification.order_id);
            if (status.transaction_status === 'settlement' || status.transaction_status === 'capture') {
                const meta = notification.metadata || {};
                const userId = meta.user_id;
                const tier = meta.tier || 'go';
                if (userId) {
                    await setUserTier(userId, tier, 30);
                    logger.info(`${tier.toUpperCase()} tier activated for ${userId}`);
                }
            }
        }
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        logger.error('Midtrans webhook error:', error);
        res.status(200).json({ status: 'error' });
    }
});

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

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down...');
    await closeRedis();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(port, () => {
    logger.info(`Yenni AI running on port ${port}`);
});
