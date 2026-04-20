// modules/database.js
const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function initSupabase() {
  // Ambil dari environment variables Railway
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY; // atau SUPABASE_SERVICE_ROLE_KEY jika perlu bypass RLS

  if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase connected');
  } else {
    console.warn('⚠️ Supabase credentials not set in environment variables');
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

// Inisialisasi segera saat modul dimuat
initSupabase();

module.exports = { initSupabase, supabase, saveChatMessage, getChatHistory };
