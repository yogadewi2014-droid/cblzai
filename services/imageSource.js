const axios = require('axios');
const logger = require('../utils/logger');

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 jam

function buildImageCacheKey(query) {
    return `img:${query.toLowerCase()}`;
}

function setCache(key, value) {
    cache.set(key, {
        value,
        expires: Date.now() + CACHE_TTL
    });
}

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
        cache.delete(key);
        return null;
    }
    return item.value;
}

async function searchPexels(query, timeout = 2000) {
    if (!process.env.PEXELS_API_KEY) return null;
    try {
        const resp = await axios.get('https://api.pexels.com/v1/search', {
            headers: { Authorization: process.env.PEXELS_API_KEY },
            params: { query: `${query} illustration`, per_page: 1 },
            timeout
        });
        return resp.data?.photos?.[0]?.src?.medium || null;
    } catch {
        return null;
    }
}

async function searchWikimedia(query, timeout = 2000) {
    try {
        const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)} diagram&gsrlimit=1&prop=imageinfo&iiprop=url&format=json&origin=*`;
        const resp = await axios.get(url, { timeout });
        const pages = resp.data?.query?.pages;
        if (!pages) return null;
        const first = Object.values(pages)[0];
        return first?.imageinfo?.[0]?.url || null;
    } catch {
        return null;
    }
}

async function getImageUrl(query) {
    const key = buildImageCacheKey(query);

    // ✅ cache hit
    const cached = getCache(key);
    if (cached) return cached;

    // ✅ race (ambil tercepat)
    const result = await Promise.any([
        searchPexels(query),
        searchWikimedia(query)
    ]).catch(() => null);

    if (result) {
        setCache(key, result);
        return result;
    }

    return '/app/assets/learning-bg.png';
}

module.exports = { getImageUrl };
