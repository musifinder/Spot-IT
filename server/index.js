'use strict';
require('dotenv').config();

// ── Global crash prevention — must be first ───────────────────────────────────
process.on('uncaughtException',  e => console.error('[crash] uncaughtException:', e.message, e.stack));
process.on('unhandledRejection', (r, p) => console.error('[crash] unhandledRejection:', r));

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (Railway sits behind load balancer) ───────────────────────────
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ── Rate limiter ──────────────────────────────────────────────────────────────
try {
  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false }, // suppress express-rate-limit proxy warning
    message: { error: 'Too many searches — wait a few minutes and try again.' }
  });
  app.use('/api/discover', limiter);
} catch (e) {
  console.warn('[startup] rate limiter failed to init:', e.message, '— continuing without it');
}

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Safe fetch with timeout ───────────────────────────────────────────────────
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    console.warn('[safeFetch]', url.slice(0, 60), '→', e.message);
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
// SUPABASE
// ═════════════════════════════════════════════════════════════════════════════
const SUPA_URL    = (process.env.SUPABASE_URL  || '').trim();
const SUPA_KEY    = (process.env.SUPABASE_KEY  || '').trim();
const supaEnabled = !!(SUPA_URL && SUPA_KEY);

function supaHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
    'Prefer':        'return=minimal'
  };
}

async function saveRating({ searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating }) {
  if (!supaEnabled) return;
  try {
    const res = await safeFetch(`${SUPA_URL}/rest/v1/ratings`, {
      method:  'POST',
      headers: supaHeaders(),
      body:    JSON.stringify({
        song:        String(searchSong  || '').slice(0, 200),
        rec_title:   String(recTitle    || '').slice(0, 200),
        rec_artist:  String(recArtist   || '').slice(0, 200),
        genre_tags:  Array.isArray(genreTags)  ? genreTags  : [],
        match_attrs: Array.isArray(matchAttrs) ? matchAttrs : [],
        popularity:  String(popularity  || 'unknown').slice(0, 50),
        rating:      rating > 0 ? 1 : -1
      })
    });
    if (res && res.ok) {
      console.log(`[Supabase] saved: "${recTitle}" ${rating > 0 ? '👍' : '👎'}`);
    } else {
      const body = res ? await res.text().catch(() => '') : '';
      console.warn('[Supabase] save failed:', res?.status, body.slice(0, 100));
    }
  } catch (e) {
    console.warn('[Supabase] saveRating error:', e.message);
  }
}

async function getRatingIntelligence() {
  if (!supaEnabled) return null;
  try {
    const res = await safeFetch(
      `${SUPA_URL}/rest/v1/ratings?select=rec_artist,genre_tags,match_attrs,popularity,rating&order=created_at.desc&limit=500`,
      { headers: { ...supaHeaders(), 'Prefer': 'return=representation' } }
    );
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length < 5) return null;

    const score = (map, key, r) => {
      if (!key) return;
      if (!map[key]) map[key] = { up: 0, dn: 0 };
      r > 0 ? map[key].up++ : map[key].dn++;
    };

    const genres = {}, artists = {}, pops = {};
    for (const row of rows) {
      (row.genre_tags  || []).forEach(g => score(genres,  g, row.rating));
      score(artists, row.rec_artist, row.rating);
      score(pops,    row.popularity, row.rating);
    }

    const liked = (map, min = 3) => Object.entries(map)
      .filter(([, v]) => v.up + v.dn >= min && v.up / (v.up + v.dn) >= 0.7)
      .sort((a, b) => b[1].up - a[1].up).slice(0, 5).map(([k]) => k);

    const disliked = (map, min = 3) => Object.entries(map)
      .filter(([, v]) => v.up + v.dn >= min && v.dn / (v.up + v.dn) >= 0.7)
      .sort((a, b) => b[1].dn - a[1].dn).slice(0, 5).map(([k]) => k);

    const lg = liked(genres), dg = disliked(genres);
    const la = liked(artists), da = disliked(artists);
    if (!lg.length && !dg.length && !la.length && !da.length) return null;

    let intel = '\n\nUSER TASTE SIGNALS (from real ratings — apply these):\n';
    if (lg.length) intel += `- Favour genres: [${lg.join(', ')}]\n`;
    if (dg.length) intel += `- Avoid genres: [${dg.join(', ')}]\n`;
    if (la.length) intel += `- Users love artists like: [${la.join(', ')}]\n`;
    if (da.length) intel += `- Do NOT recommend: [${da.join(', ')}]\n`;
    console.log('[Supabase] intelligence ready, rows:', rows.length);
    return intel;
  } catch (e) {
    console.warn('[Supabase] intelligence error:', e.message);
    return null;
  }
}

async function getStats() {
  if (!supaEnabled) return null;
  try {
    const res = await safeFetch(
      `${SUPA_URL}/rest/v1/ratings?select=rating,genre_tags,popularity&limit=1000`,
      { headers: { ...supaHeaders(), 'Prefer': 'return=representation' } }
    );
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return { total: 0 };
    const total   = rows.length;
    const helpful = rows.filter(r => r.rating > 0).length;
    const genres  = {};
    rows.forEach(r => (r.genre_tags || []).forEach(g => { genres[g] = (genres[g] || 0) + 1; }));
    const topGenres = Object.entries(genres).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([g])=>g);
    return { total, helpful, helpfulPct: Math.round(helpful / total * 100), topGenres };
  } catch (e) {
    console.warn('[Supabase] stats error:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SPOTIFY
// ═════════════════════════════════════════════════════════════════════════════
let _sTok = null, _sExp = 0;

async function getSpotifyToken() {
  if (_sTok && Date.now() < _sExp) return _sTok;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: sec } = process.env;
  if (!id || !sec) return null;
  const res = await safeFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!res) return null;
  try {
    const d = await res.json();
    if (!d.access_token) return null;
    _sTok = d.access_token;
    _sExp = Date.now() + (d.expires_in - 60) * 1000;
    return _sTok;
  } catch (e) { return null; }
}

async function spotifySearch(title, artist) {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;
    let best = null, bestScore = 0;
    for (const q of [`track:${title} artist:${artist}`, `${title} ${artist}`]) {
      const res = await safeFetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res) continue;
      let d; try { d = await res.json(); } catch (e) { continue; }
      for (const t of (d?.tracks?.items || [])) {
        const ts = matchScore(t.name, title);
        const as = Math.max(...(t.artists||[]).map(a => matchScore(a.name, artist)));
        const sc = ts * 0.6 + as * 0.4;
        if (sc > bestScore) { bestScore = sc; best = t; }
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
  } catch (e) { console.warn('[Spotify] error:', e.message); return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// YOUTUBE
// ═════════════════════════════════════════════════════════════════════════════
const ytCache = new Map();

async function youtubeSearch(title, artist) {
  try {
    const ck = `${norm(title)}|||${norm(artist)}`;
    if (ytCache.has(ck)) return ytCache.get(ck);
    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
      const res = await safeFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(`${title} ${artist} official audio`)}&type=video&maxResults=3&key=${key}`
      );
      if (res) {
        let d; try { d = await res.json(); } catch (e) { d = null; }
        if (d && !d.error && d.items?.length) {
          const item  = d.items[0];
          const score = matchScore(item.snippet?.title || '', title) * 0.6 +
                        matchScore(item.snippet?.channelTitle || '', artist) * 0.4;
          if (score >= 0.4) {
            const r = { url: `https://www.youtube.com/watch?v=${item.id.videoId}`, videoId: item.id.videoId, thumbnail: item.snippet?.thumbnails?.medium?.url || null, matchScore: score, verified: score >= 0.75, viaApi: true };
            ytCache.set(ck, r);
            return r;
          }
        }
        if (d?.error) console.warn('[YouTube]', d.error.message);
      }
    }
    const r = { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`, videoId: null, thumbnail: null, matchScore: 0.6, verified: false, viaApi: false };
    ytCache.set(ck, r);
    return r;
  } catch (e) {
    return { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${artist}`)}`, videoId: null, thumbnail: null, matchScore: 0.5, verified: false, viaApi: false };
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
    if (!anyFound) { console.log(`  DROPPED: "${rec.title}"`); return null; }
    const confidence = spotifyOk ? 'high' : youtubeOk ? 'medium' : 'low';
    console.log(`  "${rec.title}" → ${confidence}`);
    return { ...rec, spotify, youtube, confidence };
  } catch (e) {
    console.warn('[crossCheck] error:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GROQ
// ═════════════════════════════════════════════════════════════════════════════
function extractJSON(raw) {
  let t = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON');
  t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) {}
  return JSON.parse(t.replace(/[\x00-\x1F\x7F]/g, ' '));
}

async function groqRecommend(song, attrList, count, exclude, intelligence) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY missing');
  const excl  = exclude.length ? `\nDo NOT include: ${exclude.map(e=>`"${e.title}" by ${e.artist}`).join(', ')}.` : '';
  const intel = intelligence || '';
  const res = await safeFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', temperature: 0.4, max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a music recommendation engine. Respond with valid JSON only. Every song must exist on Spotify and YouTube.' },
        { role: 'user',   content: `Find ${count} real songs similar to "${song}" based on: ${attrList}.${excl}${intel}\nUse EXACT Spotify titles/artists. 60%+ underground/emerging.\nReturn ONLY: {"song":{"title":"","artist":"","attributes":{"bpm":"","key":"","energy":0.7,"danceability":0.6,"mood":"","genre_tags":[]}},"recommendations":[{"title":"","artist":"","year":"","popularity":"underground|emerging|mainstream","match_attributes":[],"similarity_score":0.9,"why":"","genre_tags":[]}]}` }
      ]
    })
  });
  if (!res) throw new Error('Groq unreachable');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  let d; try { d = await res.json(); } catch (e) { throw new Error('Groq bad JSON'); }
  return extractJSON(d.choices?.[0]?.message?.content || '');
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE
// ═════════════════════════════════════════════════════════════════════════════
async function discoverPipeline(song, attrList) {
  const TARGET = 8;
  const verified = [], excluded = [];
  let songMeta = null;
  const intelligence = await getRatingIntelligence();

  for (let round = 1; round <= 3 && verified.length < TARGET; round++) {
    const needed = TARGET - verified.length;
    console.log(`\n[pipeline] round ${round} — need ${needed}`);
    let gr;
    try { gr = await groqRecommend(song, attrList, needed + 5, excluded, intelligence); }
    catch (e) { if (e.message === 'RATE_LIMIT') throw e; console.warn('[pipeline] Groq error:', e.message); break; }
    if (!songMeta && gr?.song) songMeta = gr.song;
    const cands = (gr?.recommendations || []).slice(0, needed + 5);
    excluded.push(...cands.map(r => ({ title: r.title, artist: r.artist })));
    const passed = (await Promise.all(cands.map(crossCheck))).filter(Boolean);
    console.log(`[pipeline] round ${round}: ${passed.length}/${cands.length} passed`);
    verified.push(...passed.slice(0, needed));
  }
  return { song: songMeta, recommendations: verified };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/discover', async (req, res) => {
  try {
    const { song, attributes } = req.body || {};
    if (!song || typeof song !== 'string' || song.trim().length < 2)
      return res.status(400).json({ error: 'Please provide a song name.' });
    const ALLOWED = ['tempo','melody','rhythm','lyrics','vibe','production'];
    const attrs = (attributes || []).filter(a => ALLOWED.includes(a));
    if (!attrs.length) return res.status(400).json({ error: 'Select at least one attribute.' });
    const result = await discoverPipeline(song.trim(), attrs.join(', '));
    if (!result.recommendations?.length)
      return res.status(502).json({ error: 'Could not verify recommendations — try a different song.' });
    return res.json(result);
  } catch (err) {
    console.error('[/api/discover]', err.message);
    if (err.message === 'RATE_LIMIT') return res.status(429).json({ error: 'AI busy — try again shortly.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

app.post('/api/rate', async (req, res) => {
  try {
    const { searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating } = req.body || {};
    if (!searchSong || !recTitle || !recArtist || ![1, -1].includes(Number(rating)))
      return res.status(400).json({ error: 'Invalid rating data.' });
    await saveRating({ searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating: Number(rating) });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[/api/rate]', e.message);
    return res.status(500).json({ error: 'Could not save rating.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    return res.json(stats || { total: 0 });
  } catch (e) {
    return res.json({ total: 0 });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
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

// ═════════════════════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════════════════════
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  Spot-It — Music Discovery Engine`);
  console.log(`    Port:     ${PORT}`);
  console.log(`    Groq:     ${process.env.GROQ_API_KEY          ? '✓' : '✗ MISSING — set GROQ_API_KEY'}`);
  console.log(`    Spotify:  ${process.env.SPOTIFY_CLIENT_ID     ? '✓' : '✗ disabled'}`);
  console.log(`    YouTube:  ${process.env.YOUTUBE_API_KEY       ? '✓' : '✗ disabled'}`);
  console.log(`    Supabase: ${supaEnabled                       ? '✓ learning active' : '✗ set SUPABASE_URL + SUPABASE_KEY'}\n`);

  const publicURL =
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` :
    process.env.RENDER_EXTERNAL_URL   ? process.env.RENDER_EXTERNAL_URL : null;

  if (publicURL) {
    setInterval(() => safeFetch(`${publicURL}/api/health`).catch(() => {}), 14 * 60 * 1000);
  }
});

// Graceful shutdown — lets Railway restart cleanly instead of force-killing
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — closing gracefully');
  server.close(() => {
    console.log('[shutdown] closed');
    process.exit(0);
  });
});
