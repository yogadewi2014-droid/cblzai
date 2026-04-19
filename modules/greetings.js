// modules/greetings.js
const greetings = {
  islam: 'Assalamualaikum warahmatullahi wabarakatuh 🤲',
  kristen: 'Salam sejahtera untuk kita semua ✝️',
  katolik: 'Salam damai di dalam Tuhan Yesus 🕊️',
  hindu: 'Om Swastiastu 🕉️',
  buddha: 'Om Mani Padme Hum 🙏',
  konghucu: 'Wei De Dong Tian, salam kebajikan ☯️'
};

function getRandomGreeting() {
  const allGreetings = Object.values(greetings);
  return allGreetings[Math.floor(Math.random() * allGreetings.length)];
}

function getTimeOfDay() {
  const hour = new Date().getHours();
  if (hour < 12) return 'pagi';
  if (hour < 18) return 'siang';
  return 'malam';
}

function getLevelInfoText() {
  const { CONFIG } = require('../config');
  return `${getRandomGreeting()}\n\n💰 *Pilih Level Belajar Anda*:\n\n/level_sd - *SD/SMP* - ${CONFIG.levelPrices.sd_smp}\n/level_sma - *SMA* - ${CONFIG.levelPrices.sma}\n/level_mahasiswa - *Mahasiswa* - ${CONFIG.levelPrices.mahasiswa}\n/level_dosen - *Dosen/Politikus* - ${CONFIG.levelPrices.dosen_politikus}\n\n**Yenni - Sahabat AI Anda** 💙`;
}

function getGreetingResponse(text, level) {
  const lowerText = text.toLowerCase().trim();
  const greetingsList = ['hai', 'halo', 'hi', 'hey', 'assalamualaikum', 'salam'];
  const askingWho = ['siapa kamu', 'nama kamu', 'yenni'];
  
  if (greetingsList.some(g => lowerText.includes(g)) || askingWho.some(q => lowerText.includes(q))) {
    const responses = {
      sd_smp: `Hai! 👋 Aku **Yenni**, sahabat AI kamu. Ada yang bisa aku bantu? 🌟\n\n${getRandomGreeting()}`,
      sma: `Halo! 👋 **Yenni** di sini. Ada yang mau ditanyakan? 📚\n\n${getRandomGreeting()}`,
      mahasiswa: `Halo. Saya **Yenni**, asisten riset. Ada topik yang mau didiskusikan? 🎓\n\n${getRandomGreeting()}`,
      dosen_politikus: `Selamat ${getTimeOfDay()}. Saya **Yenni**, siap membantu analisis Anda. 📊\n\n${getRandomGreeting()}`
    };
    return responses[level] || responses.sma;
  }
  return null;
}

module.exports = { getRandomGreeting, getGreetingResponse, getTimeOfDay, getLevelInfoText };
