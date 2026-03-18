require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

// ── Global crash prevention ───────────────────────────────────────────────────
process.on('uncaughtException',      e => console.error('[uncaughtException]', e.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many searches — wait a few minutes and try again.' }
});
app.use('/api/discover', limiter);
app.use(express.static(path.join(__dirname, '../public')));

// ── Safe fetch wrapper — NEVER throws, always returns null on failure ─────────
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    return res;
  } catch (e) {
    console.warn('[safeFetch] failed:', url.slice(0, 80), '→', e.message);
    return null;
  }
}

// ── String normaliser for matching ────────────────────────────────────────────
const norm = s => String(s || '')
  .toLowerCase()
  .replace(/\(.*?\)/g, '')
  .replace(/\[.*?\]/g, '')
  .replace(/[^a-z0-9\s]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function matchScore(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const overlap = [...wa].filter(w => wb.has(w) && w.length > 2).length;
  return overlap / Math.max(wa.size, wb.size);
}

// ═════════════════════════════════════════════════════════════════════════════
// SPOTIFY
// ═════════════════════════════════════════════════════════════════════════════
let _spotifyToken = null;
let _spotifyExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return null;

  const res = await safeFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!res) return null;

  try {
    const d = await res.json();
    if (!d.access_token) return null;
    _spotifyToken  = d.access_token;
    _spotifyExpiry = Date.now() + (d.expires_in - 60) * 1000;
    return _spotifyToken;
  } catch (e) {
    console.warn('[Spotify] token parse error:', e.message);
    return null;
  }
}

async function spotifySearch(title, artist) {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;

    const queries = [
      `track:${title} artist:${artist}`,
      `${title} ${artist}`,
      `${title} ${artist.split(' ')[0]}`
    ];

    let bestResult = null;
    let bestScore  = 0;

    for (const q of queries) {
      const res = await safeFetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res) continue;

      let d;
      try { d = await res.json(); } catch (e) { continue; }

      const items = d?.tracks?.items || [];
      for (const track of items) {
        const ts = matchScore(track.name, title);
        const as = Math.max(...(track.artists || []).map(a => matchScore(a.name, artist)));
        const score = (ts * 0.6) + (as * 0.4);
        if (score > bestScore) { bestScore = score; bestResult = track; }
      }
      if (bestScore >= 0.85) break;
    }

    if (!bestResult || bestScore < 0.5) return null;

    return {
      url:        bestResult.external_urls?.spotify || null,
      preview:    bestResult.preview_url || null,
      image:      bestResult.album?.images?.[1]?.url || bestResult.album?.images?.[0]?.url || null,
      matchScore: bestScore,
      verified:   bestScore >= 0.85
    };
  } catch (e) {
    console.warn('[Spotify] search crashed:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// YOUTUBE — search link only (no API quota used)
// Builds a direct YouTube search URL so users land on the right results
// instantly with zero API calls. YouTube API used only if key + quota available.
// ═════════════════════════════════════════════════════════════════════════════

// In-memory cache: "title|||artist" -> result (lives for process lifetime)
const ytCache = new Map();

async function youtubeSearch(title, artist) {
  try {
    const cacheKey = `${title.toLowerCase()}|||${artist.toLowerCase()}`;

    // Return cached result if available
    if (ytCache.has(cacheKey)) {
      console.log(`  [YouTube] cache hit: "${title}"`);
      return ytCache.get(cacheKey);
    }

    const key = process.env.YOUTUBE_API_KEY;

    // If API key available — try API first, fall back to search link on any error
    if (key) {
      const q   = encodeURIComponent(`${title} ${artist} official audio`);
      const res = await safeFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=3&key=${key}`
      );

      if (res) {
        let d;
        try { d = await res.json(); } catch (e) { d = null; }

        if (d && !d.error && d.items?.length) {
          const item  = d.items[0];
          const score = (matchScore(item.snippet?.title || '', title) * 0.6) +
                        (matchScore(item.snippet?.channelTitle || '', artist) * 0.4);

          if (score >= 0.4) {
            const result = {
              url:       `https://www.youtube.com/watch?v=${item.id.videoId}`,
              videoId:   item.id.videoId,
              thumbnail: item.snippet?.thumbnails?.medium?.url || null,
              matchScore: score,
              verified:  score >= 0.75,
              viaApi:    true
            };
            ytCache.set(cacheKey, result);
            return result;
          }
        }

        if (d?.error) {
          console.warn(`[YouTube] API error: ${d.error.message} — falling back to search link`);
        }
      }
    }

    // Fallback: direct YouTube search URL — always works, zero quota
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`;
    const result = {
      url:       searchUrl,
      videoId:   null,
      thumbnail: null,
      matchScore: 0.6,
      verified:  false,
      viaApi:    false
    };
    ytCache.set(cacheKey, result);
    return result;

  } catch (e) {
    console.warn('[YouTube] crashed:', e.message);
    // Still return a search link — never return null for YouTube
    return {
      url:      `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`,
      videoId:  null,
      thumbnail: null,
      matchScore: 0.5,
      verified: false,
      viaApi:   false
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CROSS CHECK
// ═════════════════════════════════════════════════════════════════════════════
async function crossCheck(rec) {
  try {
    const [spotify, youtube] = await Promise.all([
      spotifySearch(rec.title, rec.artist),
      youtubeSearch(rec.title, rec.artist)
    ]);

    const spotifyOk    = !!spotify?.verified;
    const youtubeOk    = !!youtube?.verified;
    const spotifyFound = !!spotify;
    const youtubeFound = !!youtube;

    let confidence;
    if      (spotifyOk && youtubeOk)           confidence = 'high';
    else if (spotifyOk || youtubeOk)           confidence = 'medium';
    else if (spotifyFound || youtubeFound)     confidence = 'low';
    else { console.log(`  [cross-check] DROPPED: "${rec.title}" — not found`); return null; }

    console.log(`  [cross-check] "${rec.title}" → ${confidence}`);
    return { ...rec, spotify, youtube, confidence };
  } catch (e) {
    console.warn('[crossCheck] crashed for', rec.title, ':', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GROQ
// ═════════════════════════════════════════════════════════════════════════════
function extractJSON(raw) {
  let text = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found');
  text = text.slice(start, end + 1);
  try { return JSON.parse(text); } catch (_) {}
  return JSON.parse(text.replace(/[\x00-\x1F\x7F]/g, ' '));
}

async function groqRecommend(song, attrList, count = 12, exclude = []) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY missing');

  const excludeNote = exclude.length
    ? `Do NOT include: ${exclude.map(e => `"${e.title}" by ${e.artist}`).join(', ')}.`
    : '';

  const res = await safeFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model:           'llama-3.3-70b-versatile',
      temperature:     0.4,
      max_tokens:      2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a music recommendation engine. Respond with valid JSON only. Every song must be real and verifiable on Spotify and YouTube.' },
        { role: 'user',   content:
          `Find ${count} real songs similar to "${song}" based on: ${attrList}. ${excludeNote}
Use EXACT titles and artist names as they appear on Spotify. At least 60% underground/emerging artists.
Return ONLY: {"song":{"title":"","artist":"","attributes":{"bpm":"","key":"","energy":0.7,"danceability":0.6,"mood":"","genre_tags":[]}},"recommendations":[{"title":"","artist":"","year":"","popularity":"underground|emerging|mainstream","match_attributes":[],"similarity_score":0.9,"why":"","genre_tags":[]}]}`
        }
      ]
    })
  });

  if (!res) throw new Error('Groq unreachable');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error(`Groq error ${res.status}`);

  let data;
  try { data = await res.json(); } catch (e) { throw new Error('Groq bad response'); }

  return extractJSON(data.choices?.[0]?.message?.content || '');
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE
// ═════════════════════════════════════════════════════════════════════════════
async function discoverPipeline(song, attrList) {
  const TARGET     = 8;
  const verified   = [];
  const excluded   = [];
  let   songMeta   = null;

  for (let round = 1; round <= 3 && verified.length < TARGET; round++) {
    const needed = TARGET - verified.length;
    console.log(`\n[pipeline] round ${round} — need ${needed} more`);

    let groqResult;
    try {
      groqResult = await groqRecommend(song, attrList, needed + 5, excluded);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') throw e;
      console.warn('[pipeline] Groq failed round', round, ':', e.message);
      break;
    }

    if (!songMeta && groqResult?.song) songMeta = groqResult.song;
    const candidates = (groqResult?.recommendations || []).slice(0, needed + 5);
    excluded.push(...candidates.map(r => ({ title: r.title, artist: r.artist })));

    const results = await Promise.all(candidates.map(c => crossCheck(c)));
    const passed  = results.filter(Boolean);
    console.log(`[pipeline] round ${round}: ${passed.length}/${candidates.length} passed`);
    verified.push(...passed.slice(0, needed));
  }

  return { song: songMeta, recommendations: verified };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/discover', async (req, res) => {
  try {
    const { song, attributes } = req.body;

    if (!song || typeof song !== 'string' || song.trim().length < 2)
      return res.status(400).json({ error: 'Please provide a song name.' });

    const ALLOWED = ['tempo','melody','rhythm','lyrics','vibe','production'];
    const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
    if (!attrs.length)
      return res.status(400).json({ error: 'Select at least one attribute.' });

    const result = await discoverPipeline(song.trim(), attrs.join(', '));

    if (!result.recommendations?.length)
      return res.status(502).json({ error: 'Could not verify any recommendations — try a different song.' });

    return res.json(result);

  } catch (err) {
    console.error('[/api/discover] error:', err.message);
    if (err.message === 'RATE_LIMIT')
      return res.status(429).json({ error: 'AI service busy — wait a moment and try again.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status:   'ok',
    groq:     !!process.env.GROQ_API_KEY,
    spotify:  !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    youtube:  !!process.env.YOUTUBE_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  Music Discovery Engine`);
  console.log(`    Port:    ${PORT}`);
  console.log(`    Groq:    ${process.env.GROQ_API_KEY          ? '✓' : '✗ MISSING'}`);
  console.log(`    Spotify: ${process.env.SPOTIFY_CLIENT_ID     ? '✓' : '✗ disabled'}`);
  console.log(`    YouTube: ${process.env.YOUTUBE_API_KEY       ? '✓' : '✗ disabled'}\n`);

  const publicURL =
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` :
    process.env.RENDER_EXTERNAL_URL   ? process.env.RENDER_EXTERNAL_URL : null;

  if (publicURL) {
    setInterval(async () => {
      try { await safeFetch(`${publicURL}/api/health`); }
      catch (e) { console.warn('[keep-alive] failed:', e.message); }
    }, 14 * 60 * 1000);
  }
});
