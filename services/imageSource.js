const { getMediaCache, setMediaCache } = require('./mediaCache');
const axios = require('axios');
const logger = require('../utils/logger');

function normalizeQuery(q) {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, '')   // hapus tanda baca
    .replace(/\s+/g, ' ')
    .trim();
}

function enrichQuery(q) {
  const map = {
    balok: 'rectangular prism diagram',
    kubus: 'cube geometry diagram',
    segitiga: 'triangle diagram',
    lingkaran: 'circle diagram',
    'rumus luas': 'area formula diagram',
    'rumus volume': 'volume formula diagram',
    fotosintesis: 'photosynthesis diagram labeled',
    'sistem pencernaan': 'human digestive system diagram labeled',
    'sistem peredaran darah': 'circulatory system diagram labeled',
    peta: 'indonesia map',
    grafik: 'chart graph'
  };
  return map[q] || `${q} illustration`;
}

// 🔎 deteksi apakah lebih cocok Wikimedia
function isDiagramQuery(q) {
  return /(diagram|rumus|formula|sistem|grafik|peta|geometri|volume|luas)/i.test(q);
}

async function searchWikimedia(query) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=imageinfo&iiprop=url|mime&format=json&origin=*`;

    const res = await axios.get(url, { timeout: 2000 });
    const pages = res.data?.query?.pages;
    if (!pages) return null;

    const first = Object.values(pages)[0];
    const info = first?.imageinfo?.[0];

    // ✅ filter hanya gambar raster
    if (!info?.url || !info.mime?.startsWith('image/')) return null;
    if (info.mime === 'image/svg+xml') return null;

    return info.url;
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

  // 🔁 cache hit
  const cached = await getMediaCache('image', normalized);
  if (cached) {
    logger.info(`Image cache HIT: ${normalized}`);
    return cached;
  }

  const enriched = enrichQuery(normalized);

  const safe = (p) =>
    p.then(res => {
      if (!res) throw new Error('empty');
      return res;
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 2500)
  );

  let result = null;

  try {
    if (isDiagramQuery(normalized)) {
      // 🔥 prioritaskan Wikimedia dulu (lebih relevan)
      result = await Promise.race([
        safe(searchWikimedia(enriched)),
        timeoutPromise
      ]);
    } else {
      // 🔥 race normal
      result = await Promise.race([
        Promise.any([
          safe(searchWikimedia(enriched)),
          safe(searchPexels(enriched))
        ]),
        timeoutPromise
      ]);
    }
  } catch {
    result = null;
  }

  if (result) {
    await setMediaCache('image', normalized, result, 86400 * 3);
    return result;
  }

  // ❌ negative cache (hemat request gagal)
  await setMediaCache('image', normalized, '/app/assets/learning-bg.png', 3600);

  return '/app/assets/learning-bg.png';
}

module.exports = { getImageUrl };
