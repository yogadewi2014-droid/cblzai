const midtransClient = require('midtrans-client');
const logger = require('../utils/logger');

// Konfigurasi Midtrans
const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Konfigurasi Core API
const core = new midtransClient.CoreApi({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Paket harga
const PACKAGES = {
    weekly: {
        name: 'Mingguan',
        amount: 12000,
        durationDays: 7
    },
    monthly: {
        name: 'Bulanan',
        amount: 35000,
        durationDays: 30
    }
};

/**
 * Membuat payment link menggunakan Snap (mendukung QRIS otomatis)
 * @param {string} orderId - ID unik pesanan (contoh: yenni-sub-{userId}-{timestamp})
 * @param {string} packageKey - 'weekly' atau 'monthly'
 * @param {string} customerName - nama pelanggan
 * @param {string} customerEmail - email pelanggan
 * @param {string} customerPhone - nomor telepon pelanggan
 * @returns {object} { payment_link_url, order_id }
 */
async function createPaymentLink(userId, packageKey, customerName = '', customerEmail = '', customerPhone = '') {
    const pkg = PACKAGES[packageKey];
    if (!pkg) throw new Error('Paket tidak ditemukan');

    const orderId = `yenni-${packageKey}-${userId}-${Date.now()}`;

    const parameter = {
        transaction_details: {
            order_id: orderId,
            gross_amount: pkg.amount
        },
        credit_card: { secure: true },
        item_details: [{
            id: `yenni-premium-${packageKey}`,
            price: pkg.amount,
            quantity: 1,
            name: `Yenni Premium - Paket ${pkg.name} (${pkg.durationDays} hari)`
        }],
        customer_details: {
            first_name: customerName || 'Pelanggan',
            last_name: 'Yenni',
            email: customerEmail || `${userId}@yenni.user`,
            phone: customerPhone || ''
        },
        callbacks: {
            finish: 'https://t.me/YenniAsistenBot'  // Redirect setelah pembayaran
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
 * Mendapatkan status transaksi dari Midtrans
 * @param {string} orderId
 * @returns {object} status transaksi
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
