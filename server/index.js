require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

// ── Global crash prevention ───────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[uncaughtException]', e.message));
process.on('unhandledRejection', r => console.error('[unhandledRejection]', r));

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
  windowMs: 10 * 60 * 1000, max: 30,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many searches — wait a few minutes and try again.' }
});
app.use('/api/discover', limiter);
app.use(express.static(path.join(__dirname, '../public')));

// ── Safe fetch ────────────────────────────────────────────────────────────────
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    return res;
  } catch (e) {
    console.warn('[safeFetch] failed:', url.slice(0, 80), '→', e.message);
    return null;
  }
}

// ── String matching ───────────────────────────────────────────────────────────
const norm = s => String(s || '')
  .toLowerCase()
  .replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

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
// SUPABASE — ratings storage + intelligence layer
// ═════════════════════════════════════════════════════════════════════════════
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const supaEnabled = !!(SUPA_URL && SUPA_KEY);

const supaHeaders = () => ({
  'Content-Type':  'application/json',
  'apikey':        SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Prefer':        'return=minimal'
});

// Save a single rating
async function saveRating({ searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating }) {
  if (!supaEnabled) return;
  try {
    await safeFetch(`${SUPA_URL}/rest/v1/ratings`, {
      method: 'POST',
      headers: supaHeaders(),
      body: JSON.stringify({
        song:        searchSong,
        rec_title:   recTitle,
        rec_artist:  recArtist,
        genre_tags:  genreTags  || [],
        match_attrs: matchAttrs || [],
        popularity:  popularity || 'unknown',
        rating:      rating  // 1 = helpful, -1 = not helpful
      })
    });
    console.log(`[Supabase] saved rating: "${recTitle}" → ${rating > 0 ? '👍' : '👎'}`);
  } catch (e) {
    console.warn('[Supabase] saveRating failed:', e.message);
  }
}

// Fetch recent ratings and distil into intelligence for Groq prompt
async function getRatingIntelligence(searchSong) {
  if (!supaEnabled) return null;
  try {
    // Get last 500 ratings across all searches
    const res = await safeFetch(
      `${SUPA_URL}/rest/v1/ratings?select=song,rec_title,rec_artist,genre_tags,match_attrs,popularity,rating&order=created_at.desc&limit=500`,
      { headers: { ...supaHeaders(), 'Prefer': '' } }
    );
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return null;

    // Analyse patterns
    const genreScore   = {};  // genre_tag  → { up, down }
    const artistScore  = {};  // artist     → { up, down }
    const attrScore    = {};  // match_attr → { up, down }
    const popScore     = {};  // popularity → { up, down }

    for (const row of rows) {
      const r = row.rating;
      const bump = (map, key) => {
        if (!key) return;
        if (!map[key]) map[key] = { up: 0, down: 0 };
        r > 0 ? map[key].up++ : map[key].down++;
      };
      (row.genre_tags  || []).forEach(g => bump(genreScore,  g));
      (row.match_attrs || []).forEach(a => bump(attrScore,   a));
      bump(artistScore, row.rec_artist);
      bump(popScore,    row.popularity);
    }

    // Build lists of consistently liked / disliked items
    const liked   = (map, minVotes = 3) => Object.entries(map)
      .filter(([, v]) => (v.up + v.down) >= minVotes && v.up / (v.up + v.down) >= 0.7)
      .sort((a, b) => b[1].up - a[1].up).slice(0, 5).map(([k]) => k);

    const disliked = (map, minVotes = 3) => Object.entries(map)
      .filter(([, v]) => (v.up + v.down) >= minVotes && v.down / (v.up + v.down) >= 0.7)
      .sort((a, b) => b[1].down - a[1].down).slice(0, 5).map(([k]) => k);

    const likedGenres    = liked(genreScore);
    const dislikedGenres = disliked(genreScore);
    const likedArtists   = liked(artistScore);
    const dislikedArtists= disliked(artistScore);
    const likedPop       = liked(popScore, 5);
    const dislikedPop    = disliked(popScore, 5);

    // Only return intelligence if there's enough signal
    const hasSignal = likedGenres.length || dislikedGenres.length ||
                      likedArtists.length || dislikedArtists.length;
    if (!hasSignal) return null;

    let intel = '\n\nUSER TASTE INTELLIGENCE (learned from real ratings — follow these signals):\n';
    if (likedGenres.length)     intel += `- Users consistently rate HIGHER: genres [${likedGenres.join(', ')}]\n`;
    if (dislikedGenres.length)  intel += `- Users consistently rate LOWER: genres [${dislikedGenres.join(', ')}] — avoid these\n`;
    if (likedArtists.length)    intel += `- Artists users love: [${likedArtists.join(', ')}] — recommend similar artists\n`;
    if (dislikedArtists.length) intel += `- Artists users dislike: [${dislikedArtists.join(', ')}] — do NOT recommend these\n`;
    if (likedPop.length)        intel += `- Users prefer ${likedPop[0]} artists\n`;
    if (dislikedPop.length)     intel += `- Users dislike ${dislikedPop[0]} artists — avoid\n`;

    console.log('[Supabase] intelligence loaded:', intel.replace(/\n/g, ' | '));
    return intel;

  } catch (e) {
    console.warn('[Supabase] getRatingIntelligence failed:', e.message);
    return null;
  }
}

// Get aggregate stats for the stats endpoint
async function getStats() {
  if (!supaEnabled) return null;
  try {
    const res = await safeFetch(
      `${SUPA_URL}/rest/v1/ratings?select=rating,genre_tags,popularity&limit=1000`,
      { headers: { ...supaHeaders(), 'Prefer': '' } }
    );
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return { total: 0 };

    const total   = rows.length;
    const helpful = rows.filter(r => r.rating > 0).length;
    const genres  = {};
    rows.forEach(r => (r.genre_tags || []).forEach(g => {
      genres[g] = (genres[g] || 0) + 1;
    }));
    const topGenres = Object.entries(genres)
      .sort((a,b) => b[1]-a[1]).slice(0, 5).map(([g]) => g);

    return { total, helpful, helpfulPct: Math.round(helpful/total*100), topGenres };
  } catch (e) {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SPOTIFY
// ═════════════════════════════════════════════════════════════════════════════
let _spotifyToken = null, _spotifyExpiry = 0;

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
  } catch (e) { return null; }
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
    let best = null, bestScore = 0;
    for (const q of queries) {
      const res = await safeFetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res) continue;
      let d; try { d = await res.json(); } catch (e) { continue; }
      for (const track of (d?.tracks?.items || [])) {
        const ts = matchScore(track.name, title);
        const as = Math.max(...(track.artists||[]).map(a => matchScore(a.name, artist)));
        const score = (ts * 0.6) + (as * 0.4);
        if (score > bestScore) { bestScore = score; best = track; }
      }
      if (bestScore >= 0.85) break;
    }
    if (!best || bestScore < 0.5) return null;
    return {
      url:      best.external_urls?.spotify || null,
      preview:  best.preview_url || null,
      image:    best.album?.images?.[1]?.url || best.album?.images?.[0]?.url || null,
      matchScore: bestScore,
      verified: bestScore >= 0.85
    };
  } catch (e) { console.warn('[Spotify] crashed:', e.message); return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// YOUTUBE — quota-safe with search link fallback
// ═════════════════════════════════════════════════════════════════════════════
const ytCache = new Map();

async function youtubeSearch(title, artist) {
  try {
    const cacheKey = `${norm(title)}|||${norm(artist)}`;
    if (ytCache.has(cacheKey)) return ytCache.get(cacheKey);

    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
      const q   = encodeURIComponent(`${title} ${artist} official audio`);
      const res = await safeFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=3&key=${key}`
      );
      if (res) {
        let d; try { d = await res.json(); } catch (e) { d = null; }
        if (d && !d.error && d.items?.length) {
          const item  = d.items[0];
          const score = (matchScore(item.snippet?.title || '', title) * 0.6) +
                        (matchScore(item.snippet?.channelTitle || '', artist) * 0.4);
          if (score >= 0.4) {
            const result = {
              url:       `https://www.youtube.com/watch?v=${item.id.videoId}`,
              videoId:   item.id.videoId,
              thumbnail: item.snippet?.thumbnails?.medium?.url || null,
              matchScore: score, verified: score >= 0.75, viaApi: true
            };
            ytCache.set(cacheKey, result);
            return result;
          }
        }
        if (d?.error) console.warn('[YouTube] API error:', d.error.message, '— using search fallback');
      }
    }

    // Fallback: search link — always works, zero quota
    const result = {
      url:      `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`,
      videoId:  null, thumbnail: null, matchScore: 0.6, verified: false, viaApi: false
    };
    ytCache.set(cacheKey, result);
    return result;
  } catch (e) {
    return {
      url:     `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`,
      videoId: null, thumbnail: null, matchScore: 0.5, verified: false, viaApi: false
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
    const spotifyOk = !!spotify?.verified;
    const youtubeOk = !!youtube?.verified;
    const anyFound  = !!(spotify || youtube?.url);

    let confidence;
    if      (spotifyOk && youtubeOk) confidence = 'high';
    else if (spotifyOk)              confidence = 'high';
    else if (youtubeOk)              confidence = 'medium';
    else if (anyFound)               confidence = 'low';
    else { console.log(`  [cross-check] DROPPED: "${rec.title}"`); return null; }

    console.log(`  [cross-check] "${rec.title}" → ${confidence}`);
    return { ...rec, spotify, youtube, confidence };
  } catch (e) {
    console.warn('[crossCheck] crashed:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GROQ
// ═════════════════════════════════════════════════════════════════════════════
function extractJSON(raw) {
  let text = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found');
  text = text.slice(start, end + 1);
  try { return JSON.parse(text); } catch (_) {}
  return JSON.parse(text.replace(/[\x00-\x1F\x7F]/g, ' '));
}

async function groqRecommend(song, attrList, count = 12, exclude = [], intelligence = null) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY missing');

  const excludeNote = exclude.length
    ? `\nDo NOT include: ${exclude.map(e => `"${e.title}" by ${e.artist}`).join(', ')}.` : '';

  const intelNote = intelligence || '';

  const res = await safeFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', temperature: 0.4, max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a music recommendation engine. Respond with valid JSON only. Every song must be real and verifiable on Spotify and YouTube.' },
        { role: 'user', content:
          `Find ${count} real songs similar to "${song}" based on: ${attrList}.${excludeNote}${intelNote}

RULES: Use EXACT titles and artist names as on Spotify. At least 60% underground/emerging artists.
Return ONLY: {"song":{"title":"","artist":"","attributes":{"bpm":"","key":"","energy":0.7,"danceability":0.6,"mood":"","genre_tags":[]}},"recommendations":[{"title":"","artist":"","year":"","popularity":"underground|emerging|mainstream","match_attributes":[],"similarity_score":0.9,"why":"","genre_tags":[]}]}`
        }
      ]
    })
  });

  if (!res) throw new Error('Groq unreachable');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  let data; try { data = await res.json(); } catch (e) { throw new Error('Groq bad response'); }
  return extractJSON(data.choices?.[0]?.message?.content || '');
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE
// ═════════════════════════════════════════════════════════════════════════════
async function discoverPipeline(song, attrList) {
  const TARGET   = 8;
  const verified = [], excluded = [];
  let songMeta   = null;

  // Load user taste intelligence from Supabase
  const intelligence = await getRatingIntelligence(song);

  for (let round = 1; round <= 3 && verified.length < TARGET; round++) {
    const needed = TARGET - verified.length;
    console.log(`\n[pipeline] round ${round} — need ${needed}`);

    let groqResult;
    try {
      groqResult = await groqRecommend(song, attrList, needed + 5, excluded, intelligence);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') throw e;
      console.warn('[pipeline] Groq failed:', e.message);
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

// Main discovery
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
    console.error('[/api/discover]', err.message);
    if (err.message === 'RATE_LIMIT')
      return res.status(429).json({ error: 'AI service busy — wait a moment and try again.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// Save rating from frontend
app.post('/api/rate', async (req, res) => {
  try {
    const { searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating } = req.body;
    if (!searchSong || !recTitle || !recArtist || ![1, -1].includes(rating))
      return res.status(400).json({ error: 'Invalid rating data.' });
    await saveRating({ searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save rating.' });
  }
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  const stats = await getStats();
  return res.json(stats || { total: 0 });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:   'ok',
    groq:     !!process.env.GROQ_API_KEY,
    spotify:  !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    youtube:  !!process.env.YOUTUBE_API_KEY,
    supabase: supaEnabled,
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  Music Discovery Engine`);
  console.log(`    Port:     ${PORT}`);
  console.log(`    Groq:     ${process.env.GROQ_API_KEY          ? '✓' : '✗ MISSING'}`);
  console.log(`    Spotify:  ${process.env.SPOTIFY_CLIENT_ID     ? '✓' : '✗ disabled'}`);
  console.log(`    YouTube:  ${process.env.YOUTUBE_API_KEY       ? '✓' : '✗ disabled'}`);
  console.log(`    Supabase: ${supaEnabled                       ? '✓ learning enabled' : '✗ disabled (ratings not saved)'}\n`);

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
