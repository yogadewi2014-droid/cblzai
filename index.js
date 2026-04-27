require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { initRedis, closeRedis } = require('./conversation/sessionManager');
const { setupTelegramHandler } = require('./handlers/telegram');
const { verifyWebhook, handleWebhook } = require('./handlers/whatsappCloud');
const { verifyCallbackToken } = require('./services/xendit');
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

// === XENDIT PAYMENT WEBHOOK ===
app.post('/webhook/xendit', async (req, res) => {
    try {
        const token = req.headers['x-callback-token'];
        if (token !== process.env.XENDIT_CALLBACK_TOKEN) {
            logger.warn('Xendit webhook: invalid token');
            return res.status(403).json({ error: 'Forbidden' });
        }

        const event = req.body;
        logger.info('Xendit event:', event.event);

        if (event.event === 'subscription.succeeded' || event.event === 'recurring_plan.activated') {
            const meta = event.data?.metadata;
            const userId = meta?.user_id;
            const pkg = meta?.package;
            if (userId) {
                const durationDays = pkg === 'weekly' ? 7 : 30;
                await activatePremium(userId, durationDays);
                logger.info(`Premium activated for ${userId}, ${durationDays}d`);
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        logger.error('Xendit webhook error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
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

app.listen(port, () => logger.info(`Yenni AI running on port ${port}`));
