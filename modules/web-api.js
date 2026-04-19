// modules/web-api.js
const { CONFIG } = require('../config');
const { getUserSession, setUserSession } = require('./cache');
const { supabase } = require('./database');
const { processChat } = require('./chat-processor');

const userLevels = new Map();
const userHasChosen = new Map();

async function getUserLevel(userId, platform) {
  const sessionLevel = await getUserSession(userId, platform);
  if (sessionLevel) return sessionLevel;
  return userLevels.get(`${userId}:${platform}`) || 'sd_smp';
}

async function setUserLevel(userId, platform, level) {
  await setUserSession(userId, platform, level);
  userLevels.set(`${userId}:${platform}`, level);
}

async function hasUserChosenLevel(userId, platform) {
  const session = await getUserSession(userId, platform);
  if (session) return true;
  return userHasChosen.get(`${userId}:${platform}`) || false;
}

function setupWebAPI(app) {
  // Get all levels
  app.get('/api/levels', (req, res) => {
    res.json({
      levels: [
        { id: 'sd_smp', name: CONFIG.levelNames.sd_smp, price: CONFIG.levelPrices.sd_smp },
        { id: 'sma', name: CONFIG.levelNames.sma, price: CONFIG.levelPrices.sma },
        { id: 'mahasiswa', name: CONFIG.levelNames.mahasiswa, price: CONFIG.levelPrices.mahasiswa },
        { id: 'dosen_politikus', name: CONFIG.levelNames.dosen_politikus, price: CONFIG.levelPrices.dosen_politikus }
      ]
    });
  });
  
  // Get user level status
  app.get('/api/level/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const { platform = 'website' } = req.query;
    res.json({
      userId,
      platform,
      hasChosen: await hasUserChosenLevel(userId, platform),
      level: await getUserLevel(userId, platform)
    });
  });
  
  // Set user level
  app.post('/api/level', async (req, res) => {
    const { userId, level, platform = 'website' } = req.body;
    const validLevels = ['sd_smp', 'sma', 'mahasiswa', 'dosen_politikus'];
    if (!userId || !level || !validLevels.includes(level)) {
      return res.status(400).json({ error: 'userId dan level required' });
    }
    await setUserLevel(userId, platform, level);
    res.json({ success: true, message: `Level changed to ${level}` });
  });
  
  // Chat endpoint
  app.post('/api/chat', async (req, res) => {
    const { message, userId, level, platform = 'website', imageUrl, isPDF, pageCount } = req.body;
    if (!message || !userId) return res.status(400).json({ error: 'message dan userId required' });
    
    let userLevel = level;
    if (!userLevel) {
      if (!await hasUserChosenLevel(userId, platform)) {
        return res.status(400).json({ error: 'Belum pilih level' });
      }
      userLevel = await getUserLevel(userId, platform);
    }
    
    const result = await processChat(userId, platform, userLevel, message, imageUrl, isPDF, pageCount);
    res.json({ reply: result.content, model: result.model });
  });
  
  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', supabase: !!supabase });
  });
}

module.exports = { setupWebAPI };
