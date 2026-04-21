const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

async function getUser(userId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();
    if (error && error.code !== 'PGRST116') {
        logger.error('Supabase getUser error:', error);
        return null;
    }
    return data;
}

async function createUser(userId, platform, level, subLevel) {
    const { data, error } = await supabase
        .from('users')
        .insert({ id: userId, platform, level, sub_level: subLevel })
        .select()
        .single();
    if (error) {
        logger.error('Supabase createUser error:', error);
        throw error;
    }
    return data;
}

async function updateUserLevel(userId, level, subLevel) {
    const { error } = await supabase
        .from('users')
        .update({ level, sub_level: subLevel, updated_at: new Date() })
        .eq('id', userId);
    if (error) logger.error('Supabase updateUserLevel error:', error);
}

async function saveConversation(userId, role, content) {
    const { error } = await supabase
        .from('conversations')
        .insert({ user_id: userId, role, content });
    if (error) logger.error('Supabase saveConversation error:', error);
}

async function getSummary(userId) {
    const { data, error } = await supabase
        .from('summaries')
        .select('summary')
        .eq('user_id', userId)
        .single();
    if (error && error.code !== 'PGRST116') return null;
    return data?.summary || null;
}

async function saveSummary(userId, summary) {
    const { error } = await supabase
        .from('summaries')
        .upsert({ user_id: userId, summary, updated_at: new Date() });
    if (error) logger.error('Supabase saveSummary error:', error);
}

module.exports = {
    getUser,
    createUser,
    updateUserLevel,
    saveConversation,
    getSummary,
    saveSummary
};
