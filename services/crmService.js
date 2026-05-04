const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/**
 * Catat aktivitas pengguna dan update user stats (pakai function SQL)
 */
async function logActivity(userId, eventType, metadata = {}) {
    try {
        const { error } = await supabase.rpc('log_user_activity', {
            uid: userId,
            event: eventType,
            meta: metadata
        });
        if (error) {
            logger.error('CRM logActivity error:', error);
            return false;
        }
        logger.info(`CRM: ${eventType} | user: ${userId}`);
        return true;
    } catch (e) {
        logger.error('CRM logActivity exception:', e);
        return false;
    }
}

/**
 * Dapatkan data CRM satu user
 */
async function getUserCrm(userId) {
    try {
        const { data, error } = await supabase.rpc('get_user_crm', { uid: userId });
        if (error) {
            logger.error('CRM getUserCrm error:', error);
            return null;
        }
        return data?.[0] || null;
    } catch (e) {
        logger.error('CRM getUserCrm exception:', e);
        return null;
    }
}

/**
 * Dapatkan daftar user yang perlu follow-up (inactive 1d / 7d)
 */
async function getUsersForFollowup() {
    try {
        const { data, error } = await supabase.rpc('get_users_for_followup');
        if (error) {
            logger.error('CRM getUsersForFollowup error:', error);
            return [];
        }
        return data || [];
    } catch (e) {
        logger.error('CRM getUsersForFollowup exception:', e);
        return [];
    }
}

/**
 * Update segmentasi (bisa dipanggil berkala via cron)
 */
async function updateUserSegments() {
    try {
        const { error } = await supabase.rpc('update_user_segments');
        if (error) {
            logger.error('CRM updateUserSegments error:', error);
            return false;
        }
        logger.info('CRM: segments updated');
        return true;
    } catch (e) {
        logger.error('CRM updateUserSegments exception:', e);
        return false;
    }
}

module.exports = { logActivity, getUserCrm, getUsersForFollowup, updateUserSegments };
