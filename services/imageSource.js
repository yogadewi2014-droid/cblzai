const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Cari gambar dari Pexels (gratis 200 req/jam, 20.000/bulan).
 * @param {string} query - Kata kunci pencarian.
 * @param {number} timeout - Batas waktu dalam ms (default 3000).
 * @returns {Promise<string|null>} URL gambar atau null jika tidak ditemukan/gagal.
 */
async function searchPexels(query, timeout = 3000) {
    if (!process.env.PEXELS_API_KEY) {
        logger.warn('PEXELS_API_KEY tidak diset. Pexels dilewati.');
        return null;
    }
    try {
        const resp = await axios.get('https://api.pexels.com/v1/search', {
            headers: { Authorization: process.env.PEXELS_API_KEY },
            params: { query, per_page: 1, orientation: 'landscape' },
            timeout: timeout
        });
        const photos = resp.data?.photos;
        if (photos && photos.length > 0) {
            logger.info(`Pexels image ditemukan: ${photos[0].src.large}`);
            return photos[0].src.large;
        }
        return null;
    } catch (error) {
        logger.error('Pexels search error:', error.message);
        return null;
    }
}

/**
 * Cari gambar dari Wikimedia Commons (gratis, tanpa API key).
 * @param {string} query - Kata kunci pencarian.
 * @param {number} timeout - Batas waktu dalam ms (default 3000).
 * @returns {Promise<string|null>} URL gambar atau null.
 */
async function searchWikimedia(query, timeout = 3000) {
    try {
        const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&format=json&origin=*`;
        const resp = await axios.get(url, { timeout: timeout });
        const results = resp.data?.query?.search;
        if (results && results.length > 0) {
            const title = results[0].title.replace(/^File:/, '');
            const imageUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`;
            logger.info(`Wikimedia image: ${imageUrl}`);
            return imageUrl;
        }
        return null;
    } catch (error) {
        logger.error('Wikimedia search error:', error.message);
        return null;
    }
}

/**
 * Balapan kedua API; kembalikan URL dari yang pertama berhasil.
 * @param {string} query - Kata kunci topik.
 * @param {number} timeout - Batas waktu per API (default 3000 ms).
 * @returns {Promise<string>} URL gambar, fallback ke gambar default jika semuanya gagal.
 */
async function getImageUrl(query, timeout = 3000) {
    const [pexelResult, wikimediaResult] = await Promise.allSettled([
        searchPexels(query, timeout),
        searchWikimedia(query, timeout)
    ]);

    // Ambil hasil pertama yang berhasil
    if (pexelResult.status === 'fulfilled' && pexelResult.value) {
        return pexelResult.value;
    }
    if (wikimediaResult.status === 'fulfilled' && wikimediaResult.value) {
        return wikimediaResult.value;
    }

    // Fallback ke gambar default
    logger.warn(`Tidak ada gambar ditemukan untuk "${query}", pakai default.`);
    return '/app/assets/learning-bg.png';
}

module.exports = { getImageUrl, buildImageCacheKey };
