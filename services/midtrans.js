const midtransClient = require('midtrans-client');
const logger = require('../utils/logger');

// Snap digunakan untuk membuat payment link
const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Core API untuk verifikasi status transaksi
const core = new midtransClient.CoreApi({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Paket harga
const PACKAGES = {
    weekly: {
        name: 'Mingguan',
        amount: 15000,
        durationDays: 7
    },
    monthly: {
        name: 'Bulanan',
        amount: 35000,
        durationDays: 30
    }
};

/**
 * Membuat payment link menggunakan Snap (mendukung QRIS dan semua metode)
 * @param {string} userId - ID pengguna Yenni
 * @param {string} packageKey - 'weekly' atau 'monthly'
 * @param {string} customerName - Nama pelanggan (opsional)
 * @returns {Promise<{payment_link_url: string, order_id: string}>}
 */
async function createPaymentLink(userId, packageKey, customerName = '') {
    const pkg = PACKAGES[packageKey];
    if (!pkg) throw new Error('Paket tidak ditemukan');

    // Buat order ID unik
    const orderId = `yenni-${packageKey}-${userId}-${Date.now()}`;

    const parameter = {
        transaction_details: {
            order_id: orderId,
            gross_amount: pkg.amount
        },
        item_details: [{
            id: `yenni-premium-${packageKey}`,
            price: pkg.amount,
            quantity: 1,
            name: `Yenni Premium - Paket ${pkg.name} (${pkg.durationDays} hari)`
        }],
        customer_details: {
            first_name: customerName || 'Pelanggan',
            last_name: 'Yenni',
            email: `${userId}@yenni.user`  // email placeholder
        },
        callbacks: {
            finish: 'https://t.me/YenniAsistenBot'  // redirect setelah pembayaran
        },
        metadata: {
            user_id: userId,
            package: packageKey
        }
    };

    try {
        const transaction = await snap.createTransaction(parameter);
        logger.info(`Midtrans transaction created: ${orderId}`);

        return {
            payment_link_url: transaction.redirect_url,
            order_id: orderId
        };
    } catch (error) {
        logger.error('Midtrans createTransaction error:', error.message);
        throw error;
    }
}

/**
 * Verifikasi status transaksi dari Midtrans (digunakan webhook)
 * @param {string} orderId
 * @returns {Promise<object>} Status transaksi
 */
async function getTransactionStatus(orderId) {
    try {
        const status = await core.transaction.status(orderId);
        return {
            order_id: status.order_id,
            transaction_status: status.transaction_status,
            fraud_status: status.fraud_status,
            payment_type: status.payment_type,
            gross_amount: status.gross_amount
        };
    } catch (error) {
        logger.error('Midtrans getTransactionStatus error:', error.message);
        throw error;
    }
}

module.exports = {
    createPaymentLink,
    getTransactionStatus,
    PACKAGES
};
