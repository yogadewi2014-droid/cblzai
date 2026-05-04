const logger = require('../utils/logger');

function _ruleBasedDetection(text, topic = '', previousMessages = []) {
    const lower = (text + ' ' + topic).toLowerCase();
    const length = text.length;

    // 🎧 Voice (lebih lengkap)
    const voiceStrong = /pelafalan|pengucapan|intonasi|listening|pronunciation/i.test(lower);
    const voiceSoft = /bacakan|baca|dengarkan/i.test(lower);
    const voiceRequest = /tolong bacakan|suarakan|bacakan dong|coba jelaskan lagi dengan suara/i.test(lower);

    // 🎬 Video (lebih lengkap)
    const videoStrong = /diagram|grafik|bagan|peta|siklus|flowchart/i.test(lower);
    const videoSoft = /proses|alur|visual/i.test(lower);
    const videoRequest = /gambarkan|ilustrasikan|buatkan gambar|visualisasikan/i.test(lower);
    const videoTopic = /sistem tata surya|siklus hidup|proses terjadinya|rantai makanan|cara kerja/i.test(lower);

    let voiceRecommended = false;
    let videoRecommended = false;

    // 🎧 aturan suara
    if (voiceStrong || voiceRequest) {
        voiceRecommended = true;
    } else if (voiceSoft && length > 120) {
        voiceRecommended = true;
    }

    // 🎬 aturan video
    if (videoStrong || videoRequest || videoTopic) {
        videoRecommended = true;
    } else if (videoSoft && /cara|tahapan|langkah/i.test(lower)) {
        videoRecommended = true;
    }

    // ⚖️ Prioritas: jangan dua-duanya
    if (voiceRecommended && videoRecommended) {
        if (videoStrong || videoRequest || videoTopic) {
            voiceRecommended = false;
        } else {
            videoRecommended = false;
        }
    }

    return { voiceRecommended, videoRecommended };
}

/**
 * Deteksi intent: apakah penjelasan perlu voice dan/atau video?
 */
async function detectIntent(explanationText, topic = '', previousMessages = []) {
    const result = _ruleBasedDetection(explanationText, topic, previousMessages);
    logger.info('Intent detected (rule):', result);
    return result;
}

module.exports = { detectIntent };
