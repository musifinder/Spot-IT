require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

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

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTIFY
// ═══════════════════════════════════════════════════════════════════════════════
let _spotifyToken = null;
let _spotifyExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return null;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    const d = await res.json();
    _spotifyToken  = d.access_token;
    _spotifyExpiry = Date.now() + (d.expires_in - 60) * 1000;
    return _spotifyToken;
  } catch (e) {
    console.warn('[Spotify] token error:', e.message);
    return null;
  }
}

async function spotifySearch(title, artist) {
  const token = await getSpotifyToken();
  if (!token) return null;
  try {
    const q   = encodeURIComponent(`track:${title} artist:${artist}`);
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${q}&type=track&limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d     = await res.json();
    const items = d?.tracks?.items || [];
    if (!items.length) return null;

    // Pick best match — prefer exact title+artist match
    const norm  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nt    = norm(title);
    const na    = norm(artist);
    const exact = items.find(t =>
      norm(t.name) === nt &&
      t.artists.some(a => norm(a.name) === na)
    ) || items[0];

    return {
      url:      exact.external_urls.spotify,
      uri:      exact.uri,
      preview:  exact.preview_url || null,
      image:    exact.album?.images?.[1]?.url || exact.album?.images?.[0]?.url || null,
      verified: true,
      exactMatch: !!(
        norm(exact.name) === nt &&
        exact.artists.some(a => norm(a.name) === na)
      )
    };
  } catch (e) {
    console.warn('[Spotify] search error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// YOUTUBE
// ═══════════════════════════════════════════════════════════════════════════════
async function youtubeSearch(title, artist) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const q   = encodeURIComponent(`${title} ${artist} official audio`);
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=3&key=${key}`
    );
    const d     = await res.json();
    const items = d?.items || [];
    if (!items.length) return null;

    // Pick result whose title contains both song and artist name
    const norm  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nt    = norm(title);
    const na    = norm(artist);
    const best  = items.find(v => {
      const vt = norm(v.snippet.title);
      return vt.includes(nt) && vt.includes(na);
    }) || items[0];

    return {
      url:       `https://www.youtube.com/watch?v=${best.id.videoId}`,
      videoId:   best.id.videoId,
      thumbnail: best.snippet?.thumbnails?.medium?.url || null,
      verified:  true,
      exactMatch: !!(
        norm(best.snippet.title).includes(nt) &&
        norm(best.snippet.title).includes(na)
      )
    };
  } catch (e) {
    console.warn('[YouTube] search error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-CHECK: verify a single recommendation against both platforms
// Returns enriched rec, or null if unverifiable
// ═══════════════════════════════════════════════════════════════════════════════
async function crossCheck(rec) {
  const [spotify, youtube] = await Promise.all([
    spotifySearch(rec.title, rec.artist),
    youtubeSearch(rec.title, rec.artist)
  ]);

  const hasSpotify = !!spotify;
  const hasYoutube = !!youtube;
  const spotifyExact = spotify?.exactMatch;
  const youtubeExact = youtube?.exactMatch;

  // Confidence scoring:
  // Both exact  → verified ✓✓
  // One exact   → verified ✓
  // Both fuzzy  → uncertain (still include but flag)
  // Neither     → drop the track
  if (!hasSpotify && !hasYoutube) {
    console.log(`[cross-check] DROPPED: "${rec.title}" by ${rec.artist} — not found on either platform`);
    return null;
  }

  let confidence = 'low';
  if (spotifyExact && youtubeExact) confidence = 'high';
  else if (spotifyExact || youtubeExact) confidence = 'medium';
  else if (hasSpotify && hasYoutube) confidence = 'low';

  console.log(`[cross-check] "${rec.title}" by ${rec.artist} — Spotify:${hasSpotify}(exact:${spotifyExact}) YT:${hasYoutube}(exact:${youtubeExact}) → ${confidence}`);

  return { ...rec, spotify, youtube, confidence };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ: generate recommendations
// ═══════════════════════════════════════════════════════════════════════════════
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

async function groqRecommend(song, attrList, count = 10, exclude = []) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY missing');

  const excludeNote = exclude.length
    ? `Do NOT include these tracks (already used): ${exclude.map(e => `"${e.title}" by ${e.artist}`).join(', ')}.`
    : '';

  const systemPrompt = `You are a music recommendation engine. Respond with valid JSON only — no markdown, no fences, no text outside the JSON.`;

  const userPrompt = `Find ${count} songs similar to "${song}" based on: ${attrList}.
${excludeNote}

RULES:
- Only recommend songs that VERIFIABLY EXIST on Spotify and YouTube
- At least 60% must be underground or emerging artists
- Diverse eras, genres, global artists welcome
- Be specific: exact song titles and artist names as they appear on streaming platforms

Respond ONLY with this JSON:
{"song":{"title":"string","artist":"string","attributes":{"bpm":"string","key":"string","energy":0.7,"danceability":0.6,"mood":"string","genre_tags":["string"]}},"recommendations":[{"title":"string","artist":"string","year":"string","popularity":"underground|emerging|mainstream","match_attributes":["string"],"similarity_score":0.9,"why":"string","genre_tags":["string"]}]}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model:           'llama-3.3-70b-versatile',
      temperature:     0.5,
      max_tokens:      2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(err.error?.message || `Groq error ${res.status}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '';
  return extractJSON(raw);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE: Groq → Cross-check → Refill if needed → Return 8 verified
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverPipeline(song, attrList) {
  const TARGET = 8;
  const verified = [];
  const excluded = [];
  let songMeta   = null;
  let round      = 0;
  const MAX_ROUNDS = 3;

  while (verified.length < TARGET && round < MAX_ROUNDS) {
    round++;
    const needed = TARGET - verified.length;
    // Ask for more than needed to account for drop-offs
    const askFor = Math.min(needed + 4, 12);

    console.log(`\n[pipeline] Round ${round} — need ${needed} more, asking Groq for ${askFor}`);
    const groqResult = await groqRecommend(song, attrList, askFor, excluded);

    if (!songMeta && groqResult.song) songMeta = groqResult.song;

    const candidates = (groqResult.recommendations || []).slice(0, askFor);
    excluded.push(...candidates.map(r => ({ title: r.title, artist: r.artist })));

    // Cross-check all candidates in parallel
    const results = await Promise.all(candidates.map(c => crossCheck(c)));
    const passed  = results.filter(Boolean);

    console.log(`[pipeline] Round ${round} — ${passed.length}/${candidates.length} passed cross-check`);
    verified.push(...passed.slice(0, needed));
  }

  console.log(`[pipeline] Final: ${verified.length} verified tracks\n`);
  return { song: songMeta, recommendations: verified };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/discover', async (req, res) => {
  const { song, attributes } = req.body;

  if (!song || typeof song !== 'string' || song.trim().length < 2)
    return res.status(400).json({ error: 'Please provide a song name.' });

  const ALLOWED = ['tempo', 'melody', 'rhythm', 'lyrics', 'vibe', 'production'];
  const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
  if (!attrs.length)
    return res.status(400).json({ error: 'Select at least one attribute.' });

  try {
    const result = await discoverPipeline(song.trim(), attrs.join(', '));

    if (!result.recommendations.length)
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
  console.log(`\n🎵  Music Discovery Engine — v8`);
  console.log(`    Port:    ${PORT}`);
  console.log(`    Groq:    ${process.env.GROQ_API_KEY          ? '✓' : '✗ MISSING'}`);
  console.log(`    Spotify: ${process.env.SPOTIFY_CLIENT_ID     ? '✓' : '✗ links disabled'}`);
  console.log(`    YouTube: ${process.env.YOUTUBE_API_KEY       ? '✓' : '✗ links disabled'}\n`);

  const publicURL =
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` :
    process.env.RENDER_EXTERNAL_URL   ? process.env.RENDER_EXTERNAL_URL : null;

  if (publicURL) {
    setInterval(async () => {
      try { await fetch(`${publicURL}/api/health`); }
      catch (e) { console.warn('[keep-alive] failed:', e.message); }
    }, 14 * 60 * 1000);
  }
});
