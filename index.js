require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { initRedis, closeRedis } = require('./conversation/sessionManager');
const { setupTelegramHandler } = require('./handlers/telegram');
const { setupWhatsAppHandler } = require('./handlers/whatsapp');
const { ipLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// Middleware global
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(ipLimiter);

app.get('/health', (req, res) => res.status(200).send('Yenni AI OK'));

// Inisialisasi Redis (sinkron)
initRedis();

// --- Telegram Bot ---
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

// --- WhatsApp Client ---
if (config.whatsappEnabled) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    logger.info('WhatsApp QR ready. Scan with phone.');
  });

  client.on('ready', () => logger.info('WhatsApp client ready'));
  setupWhatsAppHandler(client);
  client.initialize();
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down...');
  await closeRedis();
  process.exit(0);
});

app.listen(port, () => logger.info(`Yenni AI running on port ${port}`));
