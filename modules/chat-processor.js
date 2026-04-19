// modules/chat-processor.js
const { CONFIG } = require('../config');
const { getCache, setCache } = require('./cache');
const { getChatHistory, saveChatMessage } = require('./database');
const { selectModel, callWithFallback } = require('./ai-models');
const { processImageInput } = require('./ocr');
const { getGreetingResponse } = require('./greetings');

const STATIC_PREFIX = `Anda adalah YENNI, asisten AI Indonesia yang ramah, ceria, natural, hangat, dan membantu.`;

const basePrompts = {
  sd_smp: `${STATIC_PREFIX}\n\nAnda guru SD/SMP yang ramah dan sabar. Gunakan bahasa sederhana, kalimat pendek.`,
  sma: `${STATIC_PREFIX}\n\nAnda adalah guru SMA yang jelas dan komunikatif. Berikan penjelasan runtut.`,
  mahasiswa: `${STATIC_PREFIX}\n\nAnda adalah asisten akademik untuk mahasiswa. Gunakan gaya profesional.`,
  dosen_politikus: `${STATIC_PREFIX}\n\nAnda adalah analis kebijakan yang tajam dan objektif. Fokus pada data.`
};

async function buildSystemPrompt(level, userId, userMessage) {
  let prompt = basePrompts[level] || basePrompts.sma;
  prompt += `\n\nJangan berhalusinasi. Jika tidak tahu, katakan "Saya tidak tahu".`;
  return prompt;
}

async function processChat(userId, platform, level, message, imageUrl = null, isPDF = false, pageCount = 1) {
  const startTime = Date.now();
  
  // Handle gambar/PDF
  if (imageUrl) {
    let targetModel = level === 'sd_smp' ? 'deepseekV32' : (level === 'sma' ? 'deepseekV32' : (level === 'mahasiswa' ? 'deepseekReasoning' : 'gpt5'));
    const imageResult = await processImageInput(imageUrl, message, targetModel, level, isPDF, pageCount);
    if (imageResult.success) return { success: true, content: imageResult.content, model: targetModel };
    return { success: true, content: imageResult.content, model: 'system', isFallback: true };
  }
  
  // Handle sapaan
  const greetingResponse = getGreetingResponse(message, level);
  if (greetingResponse) return { success: true, content: greetingResponse, model: 'system' };
  
  try {
    const cacheKey = `chat:${level}:${message}`;
    const cached = await getCache(cacheKey);
    if (cached) return cached;
    
    const { model: selectedModel } = selectModel(level);
    const history = await getChatHistory(userId, platform, 5);
    const systemPrompt = await buildSystemPrompt(level, userId, message);
    const messages = [{ role: 'system', content: systemPrompt }];
    
    for (const h of history) {
      messages.push({ role: h.role, content: h.content.substring(0, 500) });
    }
    messages.push({ role: 'user', content: message });
    
    const isArticle = (level === 'sd_smp' || level === 'sma') && 
      (message.toLowerCase().includes('artikel') || message.toLowerCase().includes('tulisan'));
    
    const result = await callWithFallback(selectedModel, messages, level, isArticle);
    
    if (message.length > 3 && result.content.length > 10) {
      await saveChatMessage(userId, platform, 'user', message.substring(0, 500), selectedModel);
      await saveChatMessage(userId, platform, 'assistant', result.content.substring(0, 1000), result.model);
    }
    
    await setCache(cacheKey, result, 3600);
    console.log(`✅ Completed in ${Date.now() - startTime}ms`);
    return result;
  } catch (error) {
    console.error('Process error:', error);
    return { success: true, content: "Maaf, terjadi kesalahan. Silakan coba lagi.", model: 'system' };
  }
}

module.exports = { processChat };
