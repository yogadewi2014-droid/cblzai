const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

let fcmInitialized = false;

/**
 * Inisialisasi Firebase Admin SDK
 */
function initFCM() {
  if (fcmInitialized) return;
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    fcmInitialized = true;
    logger.info('FCM initialized');
  } catch (e) {
    logger.error('FCM init failed:', e.message);
  }
}

/**
 * Daftarkan device token pengguna
 */
async function registerDevice(userId, token, platform = 'telegram') {
  try {
    await supabase.from('device_tokens').upsert({
      user_id: userId,
      token,
      platform,
      updated_at: new Date().toISOString()
    });
    logger.info(`Device registered: ${userId} (${platform})`);
  } catch (error) {
    logger.error('FCM registerDevice error:', error);
  }
}

/**
 * Kirim notifikasi ke pengguna tertentu
 */
async function sendNotification(userId, title, body, data = {}) {
  initFCM();
  if (!fcmInitialized) return;

  try {
    const { data: tokens } = await supabase.from('device_tokens')
      .select('token')
      .eq('user_id', userId);

    if (!tokens || tokens.length === 0) return;

    const message = {
      notification: { title, body },
      data
    };

    for (const t of tokens) {
      try {
        await admin.messaging().send({ ...message, token: t.token });
        logger.info(`Notification sent to ${userId}`);
      } catch (e) {
        // Jika token invalid, hapus dari database
        if (e.code === 'messaging/registration-token-not-registered') {
          await supabase.from('device_tokens').delete().eq('token', t.token);
          logger.info(`Invalid token removed for ${userId}`);
        }
      }
    }
  } catch (error) {
    logger.error('FCM sendNotification error:', error);
  }
}

/**
 * Kirim pengingat untuk pengguna tidak aktif
 */
async function sendInactiveReminder(userId, daysInactive = 1) {
  const messages = {
    1: { title: '📚 Yenni Merindukanmu!', body: 'Sudah 24 jam nih kita nggak belajar bareng. Yuk, lanjut lagi! 🚀' },
    7: { title: '💤 Udah Seminggu Nih...', body: 'Kamu udah 7 hari nggak mampir. Materi baru udah nungguin, lho! 📖' }
  };

  const { title, body } = messages[daysInactive] || messages[1];
  await sendNotification(userId, title, body, {
    type: 'inactive_reminder',
    days_inactive: daysInactive.toString()
  });
}

/**
 * Jalankan pengecekan pengguna tidak aktif (via cron job)
 */
async function processInactiveUsers() {
  try {
    const { data: users } = await supabase.from('users')
      .select('id, last_active_at, tier')
      .not('last_active_at', 'is', null);

    if (!users) return;

    const now = new Date();
    for (const user of users) {
      const lastActive = new Date(user.last_active_at);
      const diffHours = (now - lastActive) / (1000 * 60 * 60);

      if (diffHours >= 24 && diffHours < 48) {
        await sendInactiveReminder(user.id, 1);
      } else if (diffHours >= 168) {
        // 7 hari tidak aktif, kirim pengingat untuk semua tier
        await sendInactiveReminder(user.id, 7);
      }
    }
    logger.info('Inactive user processing completed');
  } catch (error) {
    logger.error('FCM processInactiveUsers error:', error);
  }
}

module.exports = {
  registerDevice,
  sendNotification,
  sendInactiveReminder,
  processInactiveUsers,
  initFCM
};
