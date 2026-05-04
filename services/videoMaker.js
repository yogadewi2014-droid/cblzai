const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getMediaCache, setMediaCache } = require('./mediaCache');

// ================== HELPERS ==================
const hash = (str) => crypto.createHash('md5').update(str).digest('hex');

// ================== DOWNLOAD ==================
async function download(url, ext) {
    const axios = require('axios');
    const file = path.join(os.tmpdir(), `tmp-${Date.now()}.${ext}`);
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    fs.writeFileSync(file, res.data);
    return file;
}

// ================== VIDEO ==================
async function createFakeVideo(imagePath, audioPath) {
    const out = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(imagePath)
            .input(audioPath)
            .outputOptions([
                '-c:v libx264',
                '-preset ultrafast',
                '-tune stillimage',
                '-c:a aac',
                '-b:a 64k',
                '-pix_fmt yuv420p',
                '-shortest',
                '-vf',
                'scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2'
            ])
            .output(out)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });

    return out;
}

// ================== MAIN PIPELINE ==================
async function buildMedia(text, imageUrl) {
    const key = `video:${hash(text + '|' + imageUrl)}`;

    // Cek cache
    const cached = await getMediaCache('video', key);
    if (cached) return cached;

    // Generate suara via voiceOutput.js
    const { generateVoice, detectLanguage, selectVoice } = require('./voiceOutput');
    const lang = detectLanguage(text);
    const voice = selectVoice(lang);
    const audioBuffer = await generateVoice(text, lang, voice);
    
    const tmpAudio = path.join(os.tmpdir(), `audio-${Date.now()}.mp3`);
    fs.writeFileSync(tmpAudio, audioBuffer);

    // Download gambar
    const tmpImage = await download(imageUrl, 'jpg');

    // Buat video
    const videoPath = await createFakeVideo(tmpImage, tmpAudio);

    // Simpan ke cache (path lokal untuk sementara)
    await setMediaCache('video', key, videoPath, 86400 * 2); // 2 hari

    // Bersihkan file sementara (kecuali video yang masih dipakai)
    fs.unlink(tmpAudio, () => {});
    fs.unlink(tmpImage, () => {});

    return videoPath;
}

module.exports = { buildMedia, createFakeVideo };
