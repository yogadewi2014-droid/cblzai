const { getMediaCache, setMediaCache } = require('./mediaCache');
const axios = require('axios');

function normalizeQuery(q) {
  return q.toLowerCase().trim();
}

// mapping keyword biar hasil lebih akurat
function enrichQuery(q) {
  const map = {
    balok: 'rectangular prism diagram',
    kubus: 'cube geometry diagram',
    segitiga: 'triangle diagram',
    lingkaran: 'circle diagram'
  };

  return map[q] || `${q} illustration`;
}

async function searchWikimedia(query) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=imageinfo&iiprop=url&format=json&origin=*`;

    const res = await axios.get(url, { timeout: 2000 });
    const pages = res.data?.query?.pages;

    if (!pages) return null;

    const first = Object.values(pages)[0];
    return first?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
}

async function searchPexels(query) {
  if (!process.env.PEXELS_API_KEY) return null;

  try {
    const res = await axios.get('https://api.pexels.com/v1/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query, per_page: 1 },
      timeout: 2000
    });

    return res.data?.photos?.[0]?.src?.medium || null;
  } catch {
    return null;
  }
}

async function getImageUrl(query) {
  const normalized = normalizeQuery(query);

  // 🔁 cek cache
  const cached = await getMediaCache('image', normalized);
  if (cached) return cached;

  const enriched = enrichQuery(normalized);

  // 🔥 prioritas Wikimedia dulu (edukasi)
  let result = await searchWikimedia(enriched);

  // fallback ke Pexels
  if (!result) {
    result = await searchPexels(enriched);
  }

  if (result) {
    await setMediaCache('image', normalized, result, 86400 * 3); // 3 hari
    return result;
  }

  return '/app/assets/learning-bg.png';
}

module.exports = { getImageUrl };
