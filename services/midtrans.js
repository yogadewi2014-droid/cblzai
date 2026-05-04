const midtransClient = require('midtrans-client');
const logger = require('../utils/logger');

const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const core = new midtransClient.CoreApi({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const PACKAGES = {
    go:  { name: 'GO',  amount: 35000, durationDays: 30, tier: 'go' },
    pro: { name: 'PRO', amount: 75000, durationDays: 30, tier: 'pro' }
};

async function createPaymentLink(userId, packageKey, customerName = '') {
    const pkg = PACKAGES[packageKey];
    if (!pkg) throw new Error('Paket tidak ditemukan');

    const orderId = `yenni-${packageKey}-${userId}-${Date.now()}`;

    const parameter = {
        transaction_details: {
            order_id: orderId,
            gross_amount: pkg.amount
        },
        item_details: [{
            id: `yenni-${packageKey}`,
            price: pkg.amount,
            quantity: 1,
            name: `Yenni ${pkg.name} — ${pkg.durationDays} hari akses penuh`
        }],
        customer_details: {
            first_name: customerName || 'Pelanggan',
            last_name: 'Yenni',
            email: `${userId}@yenni.user`
        },
        callbacks: {
            finish: 'https://t.me/YenniAsistenBot'
        },
        metadata: {
            user_id: userId,
            package: packageKey,
            tier: pkg.tier
        }
    };

    try {
        const transaction = await snap.createTransaction(parameter);
        logger.info(`Midtrans transaction created: ${orderId} (${pkg.name})`);
        return {
            payment_link_url: transaction.redirect_url,
            order_id: orderId
        };
    } catch (error) {
        logger.error('Midtrans createTransaction error:', error.message);
        throw error;
    }
}

async function getTransactionStatus(orderId) {
    try {
        const status = await core.transaction.status(orderId);
        return {
            order_id: status.order_id,
            transaction_status: status.transaction_status,
            fraud_status: status.fraud_status,
            payment_type: status.payment_type
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
