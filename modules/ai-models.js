// modules/ai-models.js
const axios = require('axios');
const { CONFIG } = require('../config');

async function callAI(modelName, messages, level = 'sma', timeoutMs = null, isArticle = false) {
  const model = CONFIG.ai[modelName];
  if (!model || !model.key) {
    return { success: false, error: `Model ${modelName} not configured` };
  }
  
  const style = CONFIG.answerStyle[level] || CONFIG.answerStyle.sma;
  let maxTokens = style.maxTokens;
  if (isArticle && style.maxTokensArticle) maxTokens = style.maxTokensArticle;
  
  try {
    const response = await axios.post(
      model.url,
      {
        model: model.model,
        messages,
        temperature: style.temperature,
        max_tokens: maxTokens
      },
      {
        headers: { 'Authorization': `Bearer ${model.key}` },
        timeout: timeoutMs || model.timeout || 30000
      }
    );
    
    return {
      success: true,
      content: response.data.choices[0].message.content,
      model: modelName
    };
  } catch (err) {
    console.error(`AI Error (${modelName}):`, err.message);
    return { success: false, error: err.message, model: modelName };
  }
}

async function callWithFallback(modelName, messages, level, isArticle = false) {
  const chain = [modelName, ...(CONFIG.fallbackChain[modelName] || [])];
  
  for (const attempt of chain) {
    const result = await callAI(attempt, messages, level, null, isArticle);
    if (result.success) {
      if (attempt !== modelName) {
        console.log(`Fallback: ${modelName} → ${attempt}`);
      }
      return result;
    }
  }
  
  return {
    success: true,
    content: "Maaf, layanan sedang sibuk. Silakan coba lagi nanti.",
    model: 'system',
    isFallback: true
  };
}

function selectModel(level) {
  return {
    model: CONFIG.levelModelMap[level] || 'gptMini',
    reason: 'by_level'
  };
}

module.exports = { callAI, callWithFallback, selectModel };
