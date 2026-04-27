const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const XENDIT_API_KEY = process.env.XENDIT_API_KEY;
const XENDIT_CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN;
const XENDIT_API_URL = 'https://api.xendit.co';
const API_VERSION = '2026-01-01'; // Versi terbaru untuk Subscriptions

// === PAKET PREMIUM ===
const PACKAGES = {
    'weekly': {
        name: 'Mingguan',
        amount: 12000,
        interval: 'WEEK',
        intervalCount: 1,
        durationDays: 7,
        description: 'Yenni Premium - Paket Mingguan (7 hari)'
    },
    'monthly': {
        name: 'Bulanan',
        amount: 35000,
        interval: 'MONTH',
        intervalCount: 1,
        durationDays: 30,
        description: 'Yenni Premium - Paket Bulanan (30 hari)'
    }
};

/**
 * Membuat recurring plan di Xendit (Subscription API baru)
 * @returns {Object} { plan_id, payment_link_url }
 */
async function createSubscription(userId, packageKey, userName = '') {
    const pkg = PACKAGES[packageKey];
    if (!pkg) throw new Error('Paket tidak ditemukan');

    try {
        // 1. Buat Customer dulu (atau pakai existing customer ID)
        const customerId = await getOrCreateCustomer(userId, userName);

        // 2. Buat Subscription Plan
        const planResponse = await axios.post(
            `${XENDIT_API_URL}/recurring/plans`,
            {
                reference_id: `${packageKey}-${userId}-${Date.now()}`,
                customer_id: customerId,
                currency: 'IDR',
                amount: pkg.amount,
                schedule: {
                    interval: pkg.interval,
                    interval_count: pkg.intervalCount,
                    anchor_date: new Date().toISOString(),
                    total_recurrence: (packageKey === 'weekly') ? 52 : 12, // 1 tahun maks
                    retry_interval: 'DAY',
                    retry_interval_count: 1,
                    total_retry: 3,
                    failed_attempt_notifications: [1, 3]
                },
                payment_tokens: [], // Akan diisi oleh customer saat halaman pembayaran
                immediate_payment: true, // Langsung charge di awal
                failed_cycle_action: 'STOP',
                notification_channels: ['WHATSAPP'],
                locale: 'id',
                payment_link_for_failed_attempt: true,
                metadata: {
                    user_id: userId,
                    package: packageKey,
                    platform: 'yenni-ai'
                },
                description: pkg.description
            },
            {
                auth: { username: XENDIT_API_KEY, password: '' },
                headers: {
                    'Content-Type': 'application/json',
                    'api-version': API_VERSION
                }
            }
        );

        // 3. Buat Payment Session untuk mengumpulkan payment method
        const sessionResponse = await axios.post(
            `${XENDIT_API_URL}/sessions`,
            {
                session_type: 'SUBSCRIPTION',
                plan_id: planResponse.data.id,
                customer_id: customerId,
                success_return_url: 'https://t.me/YenniAsistenBot',
                failure_return_url: 'https://t.me/YenniAsistenBot',
                metadata: {
                    user_id: userId,
                    package: packageKey
                }
            },
            {
                auth: { username: XENDIT_API_KEY, password: '' },
                headers: {
                    'Content-Type': 'application/json',
                    'api-version': API_VERSION
                }
            }
        );

        logger.info(`Subscription created for ${userId}: ${planResponse.data.id}`);

        return {
            plan_id: planResponse.data.id,
            payment_link_url: sessionResponse.data.payment_link_url,
            // QR code bisa di-generate dari payment_link_url
            qr_code_url: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(sessionResponse.data.payment_link_url)}`
        };

    } catch (error) {
        logger.error('Xendit subscription error:', error.response?.data || error.message);
        throw error;
    }
}
