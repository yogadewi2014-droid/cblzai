// modules/database.js
const { createClient } = require('@supabase/supabase-js');
const { CONFIG } = require('../config');
const { getCache, setCache } = require('./cache');

let supabase = null;

function initSupabase() {
  if (CONFIG.supabase.url && CONFIG.supabase.key) {
    supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.key);
    console.log('Supabase connected');
  }
  return supabase;
}

async function saveChatMessage(userId, platform, role, content, modelUsed = null) {
  if (!supabase) return;
  try {
    await supabase.from('chat_history').insert({
      user_id: userId,
      platform,
      role,
      content,
      model_used: modelUsed,
      created_at: new Date()
    });
  } catch (e) {
    console.error('Save error:', e.message);
  }
}

async function getChatHistory(userId, platform, limit = 10) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, content')
    .eq('user_id', userId)
    .eq('platform', platform)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []).reverse();
}

module.exports = { initSupabase, supabase, saveChatMessage, getChatHistory };
