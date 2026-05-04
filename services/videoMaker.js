const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Redis } = require('@upstash/redis');
const config = require('../config');
const logger = require('../utils/logger');

// Redis cache client
let redis;
if (config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
}

function buildVideoCacheKey(text, imageUrl) {
    return `video:${Buffer.from(`${text}|${imageUrl}`).toString('base64')}`;
}

async function getCachedVideo(key) {
    if (!redis) return null;
    try {
        const cached = await redis.get(key);
        if (cached) {
            logger.info('Video cache HIT');
            return cached;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function setCachedVideo(key, filePath, ttl = 172800) {
    if (!redis) return;
    try {
        await redis.set(key, filePath, { ex: ttl });
        logger.info('Video cached');
    } catch (e) {}
}

async function createFakeVideo(imagePath, audioPath, cacheKey = null) {
    const outputDir = os.tmpdir();
    const outputPath = path.join(outputDir, `yenni-video-${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(imagePath)
            .input(audioPath)
            .outputOptions([
                '-c:v libx264',
                '-tune stillimage',
                '-c:a aac',
                '-b:a 192k',
                '-pix_fmt yuv420p',
                '-shortest',
                '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'
            ])
            .output(outputPath)
            .on('end', async () => {
                logger.info(`Video created: ${outputPath}`);
                if (cacheKey) await setCachedVideo(cacheKey, outputPath, 172800);
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error('FFmpeg error:', err);
                reject(err);
            })
            .run();
    });
}

module.exports = { createFakeVideo, buildVideoCacheKey, getCachedVideo };
