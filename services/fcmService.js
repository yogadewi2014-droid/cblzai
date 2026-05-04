const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const OpenAI = require('openai');
const logger = require('../utils/logger');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        realtime: {
            transport: WebSocket
        }
    }
);

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let fcmInitialized = false;

function initFCM() {
    if (fcmInitialized) return;
    try {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
                }),
            });
        }
        fcmInitialized = true;
        logger.info('FCM initialized');
    } catch (e) {
        logger.error('FCM init failed:', e.message);
    }
}

async function generateAIFollowup(userId, days) {
    try {
        const [{ data: user }, { data: chats }, { data: summary }] = await Promise.all([
            supabase.from('users').select('total_chats').eq('id', userId).single(),
            supabase.from('conversations')
                .select('content, role')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(3),
            supabase.from('summaries')
                .select('summary')
                .eq('user_id', userId)
                .maybeSingle()
        ]);

        const recent = (chats || [])
            .filter(c => c.role === 'user')
            .map(c => c.content)
            .slice(0, 2)
            .join(' | ');

        const prompt = `
Kamu adalah Yenni, asisten belajar.

Buat 1 kalimat singkat, hangat, tidak kaku.

User tidak aktif ${days} hari.
Topik terakhir: ${recent}
Ringkasan: ${summary?.summary || ''}
Total chat: ${user?.total_chats || 0}

Tujuan: ajak belajar lagi secara personal.
`;

        const res = await ai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
        });

        return res.choices?.[0]?.message?.content?.trim();

    } catch (e) {
        logger.error('AI error:', e.message);
        return null;
    }
}

async function registerDevice(userId, token, platform = 'unknown') {
    try {
        await supabase.rpc('register_device', {
            uid: userId,
            fcm_token: token,
            platform
        });
        logger.info(`Device registered: ${userId}`);
    } catch (error) {
        logger.error('registerDevice error:', error);
    }
}

async function sendNotification(userId, title, body, data = {}) {
    initFCM();
    if (!fcmInitialized) return;

    try {
        const { data: tokens } = await supabase
            .from('device_tokens')
            .select('token')
            .eq('user_id', userId);

        if (!tokens || tokens.length === 0) return;

        const tokenList = tokens.map(t => t.token);

        const response = await admin.messaging().sendEachForMulticast({
            tokens: tokenList,
            notification: { title, body },
            data
        });

        if (response.responses) {
            for (let i = 0; i < response.responses.length; i++) {
                if (!response.responses[i].success) {
                    const badToken = tokenList[i];
                    await supabase.rpc('delete_device_token', { tok: badToken });
                }
            }
        }

    } catch (error) {
        logger.error('sendNotification error:', error);
    }
}

async function sendInactiveReminder(userId, days) {
    const fallback = {
        1: '📚 Yenni merindukanmu! Yuk lanjut belajar lagi 🚀',
        7: '💤 Sudah seminggu nih… Materi baru sudah menunggu! 📖'
    };

    const { data: lastLog } = await supabase
        .from('activity_logs')
        .select('created_at')
        .eq('user_id', userId)
        .eq('event_type', `reminder_${days}d`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (lastLog) {
        const diffHours = (new Date() - new Date(lastLog.created_at)) / 36e5;
        if ((days === 1 && diffHours < 24) || (days === 7 && diffHours < 168)) return;
    }

    let body = await generateAIFollowup(userId, days);
    if (!body) body = fallback[days] || fallback[1];

    await sendNotification(userId, 'Yenni AI', body, {
        type: 'reminder',
        days: String(days)
    });

    await supabase.from('activity_logs').insert({
        user_id: userId,
        event_type: `reminder_${days}d`,
        metadata: { ai: !!body }
    });
}

async function processInactiveUsers() {
    try {
        const now = new Date();

        const { data: users } = await supabase
            .from('users')
            .select('id, last_active_at')
            .not('last_active_at', 'is', null);

        if (!users) return;

        for (const user of users) {
            const diffHours = (now - new Date(user.last_active_at)) / 36e5;

            if (diffHours >= 24 && diffHours < 48) {
                await sendInactiveReminder(user.id, 1);
            }

            if (diffHours >= 168) {
                await sendInactiveReminder(user.id, 7);
            }
        }

    } catch (e) {
        logger.error('processInactiveUsers error:', e);
    }
}

module.exports = {
    initFCM,
    registerDevice,
    sendNotification,
    processInactiveUsers
};
