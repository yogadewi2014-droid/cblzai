// modules/ocr.js
const axios = require('axios');
const { CONFIG } = require('../config');
const { callAI } = require('./ai-models');

async function processImageInput(imageUrl, userQuestion, targetModel, level, isPDF = false, pageCount = 1) {
  const limit = CONFIG.ocrLimits[level] || CONFIG.ocrLimits.sma;
  const maxPages = limit.maxPages;
  const maxSizeMB = limit.maxSizeMB;
  
  if (isPDF && pageCount > maxPages) {
    return {
      success: false,
      content: `❌ *PDF terlalu banyak halaman!*\n\n📄 ${pageCount} halaman (melebihi batas level ${level}: ${maxPages} halaman)`,
      model: 'system',
      isFallback: true
    };
  }
  
  if (!process.env.NOVITA_API_KEY) {
    return {
      success: false,
      content: `⚠️ *OCR tidak tersedia saat ini*`,
      model: 'system',
      isFallback: true
    };
  }
  
  try {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    
    const actualSizeMB = imageResponse.data.length / (1024 * 1024);
    if (actualSizeMB > maxSizeMB) {
      return {
        success: false,
        content: `❌ *File terlalu besar!*\n\n📦 Ukuran: ${actualSizeMB.toFixed(1)}MB (melebihi batas level ${level}: ${maxSizeMB}MB)`,
        model: 'system',
        isFallback: true
      };
    }
    
    const base64File = Buffer.from(imageResponse.data).toString('base64');
    const mimeType = isPDF ? 'application/pdf' : 'image/jpeg';
    
    const response = await axios.post(
      'https://api.novita.ai/v3/openai/v1/chat/completions',
      {
        model: 'deepseek/deepseek-ocr-2',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64File}` } },
            { type: 'text', text: userQuestion || 'Ekstrak teks dari gambar ini.' }
          ]
        }],
        max_tokens: 4096,
        temperature: 0
      },
      {
        headers: { 'Authorization': `Bearer ${process.env.NOVITA_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 90000
      }
    );
    
    const ocrResult = response.data.choices[0].message.content;
    console.log(`🖼️ [OCR] Novita AI berhasil!`);
    
    const finalMessages = [
      { role: 'system', content: `Analisis gambar: ${ocrResult.substring(0, 3000)}. Jawab pertanyaan user.` },
      { role: 'user', content: userQuestion || 'Jelaskan gambar ini.' }
    ];
    
    const finalResult = await callAI(targetModel, finalMessages, level);
    return { success: true, content: finalResult.content };
    
  } catch (err) {
    console.error(`🖼️ [OCR] ERROR: ${err.message}`);
    return { success: false, content: `❌ Gagal memproses: ${err.message}`, model: 'system', isFallback: true };
  }
}

module.exports = { processImageInput };
