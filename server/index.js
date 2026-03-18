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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const norm = s => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, '')       // remove (feat. ...) etc
  .replace(/\[.*?\]/g, '')       // remove [remix] etc
  .replace(/[^a-z0-9\s]/g, '')   // strip punctuation
  .replace(/\s+/g, ' ')
  .trim();

// Score how well two strings match (0-1)
function matchScore(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // word overlap
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const overlap = [...wa].filter(w => wb.has(w) && w.length > 2).length;
  return overlap / Math.max(wa.size, wb.size);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY
// ─────────────────────────────────────────────────────────────────────────────
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
    if (!d.access_token) { console.warn('[Spotify] bad token response:', d); return null; }
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

  // Try multiple query strategies, take best match
  const queries = [
    `track:${title} artist:${artist}`,          // strict field search
    `${title} ${artist}`,                         // loose search
    `${title} ${artist.split(' ')[0]}`            // first word of artist
  ];

  let bestResult = null;
  let bestScore  = 0;

  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d     = await res.json();
      const items = d?.tracks?.items || [];

      for (const track of items) {
        const titleScore  = matchScore(track.name, title);
        const artistScore = Math.max(...(track.artists || []).map(a => matchScore(a.name, artist)));
        const combined    = (titleScore * 0.6) + (artistScore * 0.4);

        console.log(`  [Spotify] "${track.name}" by ${track.artists.map(a=>a.name).join(',')} → score ${combined.toFixed(2)}`);

        if (combined > bestScore) {
          bestScore  = combined;
          bestResult = { track, score: combined };
        }
      }

      // Good enough — stop trying more queries
      if (bestScore >= 0.85) break;

    } catch (e) {
      console.warn('[Spotify] search error:', e.message);
    }
  }

  // Reject if score too low — likely wrong track
  if (!bestResult || bestScore < 0.5) {
    console.log(`  [Spotify] no confident match for "${title}" by "${artist}" (best: ${bestScore.toFixed(2)})`);
    return null;
  }

  const t = bestResult.track;
  return {
    url:        t.external_urls.spotify,
    preview:    t.preview_url || null,
    image:      t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
    matchScore: bestScore,
    verified:   bestScore >= 0.85
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE
// ─────────────────────────────────────────────────────────────────────────────
async function youtubeSearch(title, artist) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;

  // Try multiple query strategies
  const queries = [
    `${title} ${artist} official audio`,
    `${title} ${artist} official video`,
    `${title} ${artist}`
  ];

  let bestResult = null;
  let bestScore  = 0;

  for (const q of queries) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=5&key=${key}`
      );
      const d     = await res.json();

      if (d.error) {
        console.warn('[YouTube] API error:', d.error.message);
        return null;
      }

      const items = d?.items || [];

      for (const item of items) {
        const vtitle      = item.snippet?.title || '';
        const vchannel    = item.snippet?.channelTitle || '';
        const titleScore  = matchScore(vtitle, title);
        const artistScore = Math.max(
          matchScore(vtitle, artist),
          matchScore(vchannel, artist)
        );
        const combined = (titleScore * 0.6) + (artistScore * 0.4);

        console.log(`  [YouTube] "${vtitle}" → score ${combined.toFixed(2)}`);

        if (combined > bestScore) {
          bestScore  = combined;
          bestResult = { item, score: combined };
        }
      }

      if (bestScore >= 0.75) break;

    } catch (e) {
      console.warn('[YouTube] search error:', e.message);
    }
  }

  if (!bestResult || bestScore < 0.4) {
    console.log(`  [YouTube] no confident match for "${title}" by "${artist}" (best: ${bestScore.toFixed(2)})`);
    return null;
  }

  const item = bestResult.item;
  return {
    url:        `https://www.youtube.com/watch?v=${item.id.videoId}`,
    videoId:    item.id.videoId,
    thumbnail:  item.snippet?.thumbnails?.medium?.url || null,
    matchScore: bestScore,
    verified:   bestScore >= 0.75
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function crossCheck(rec) {
  console.log(`\n[cross-check] "${rec.title}" by ${rec.artist}`);

  const [spotify, youtube] = await Promise.all([
    spotifySearch(rec.title, rec.artist),
    youtubeSearch(rec.title, rec.artist)
  ]);

  const spotifyOk = spotify?.verified;
  const youtubeOk = youtube?.verified;
  const spotifyFound = !!spotify;
  const youtubeFound = !!youtube;

  // Confidence levels
  let confidence;
  if (spotifyOk && youtubeOk)          confidence = 'high';
  else if (spotifyOk || youtubeOk)     confidence = 'medium';
  else if (spotifyFound || youtubeFound) confidence = 'low';
  else {
    console.log(`  → DROPPED (not found on either platform)`);
    return null;
  }

  console.log(`  → ${confidence.toUpperCase()} (Spotify:${spotifyOk ? '✓' : spotifyFound ? '~' : '✗'} YouTube:${youtubeOk ? '✓' : youtubeFound ? '~' : '✗'})`);
  return { ...rec, spotify, youtube, confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ
// ─────────────────────────────────────────────────────────────────────────────
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

  const prompt = `Find ${count} real songs similar to "${song}" based on: ${attrList}.
${excludeNote}

STRICT RULES:
- Every song must genuinely exist and be streamable on Spotify and YouTube right now
- Use the EXACT title and artist name as it appears on Spotify (correct capitalisation, no extra words)
- At least 60% should be underground or emerging artists
- No made-up, obscure, or AI-hallucinated tracks

Return ONLY this JSON, nothing else:
{"song":{"title":"string","artist":"string","attributes":{"bpm":"string","key":"string","energy":0.7,"danceability":0.6,"mood":"string","genre_tags":["string"]}},"recommendations":[{"title":"string","artist":"string","year":"string","popularity":"underground|emerging|mainstream","match_attributes":["string"],"similarity_score":0.9,"why":"string","genre_tags":["string"]}]}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model:           'llama-3.3-70b-versatile',
      temperature:     0.4,
      max_tokens:      2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a music recommendation engine. Respond with valid JSON only. Every song you recommend must be a real, verifiable track on Spotify and YouTube.' },
        { role: 'user',   content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(err.error?.message || `Groq error ${res.status}`);
  }

  const data = await res.json();
  return extractJSON(data.choices?.[0]?.message?.content || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
async function discoverPipeline(song, attrList) {
  const TARGET    = 8;
  const verified  = [];
  const excluded  = [];
  let   songMeta  = null;
  const MAX_ROUNDS = 3;

  for (let round = 1; round <= MAX_ROUNDS && verified.length < TARGET; round++) {
    const needed = TARGET - verified.length;
    const askFor = needed + 5;

    console.log(`\n══ Pipeline round ${round} — need ${needed}, asking for ${askFor} ══`);

    const groqResult = await groqRecommend(song, attrList, askFor, excluded);
    if (!songMeta && groqResult.song) songMeta = groqResult.song;

    const candidates = (groqResult.recommendations || []).slice(0, askFor);
    excluded.push(...candidates.map(r => ({ title: r.title, artist: r.artist })));

    const results = await Promise.all(candidates.map(c => crossCheck(c)));
    const passed  = results.filter(Boolean);

    console.log(`\n══ Round ${round} result: ${passed.length}/${candidates.length} passed ══`);
    verified.push(...passed.slice(0, needed));
  }

  console.log(`\n✓ Final: ${verified.length} verified tracks`);
  return { song: songMeta, recommendations: verified };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/discover', async (req, res) => {
  const { song, attributes } = req.body;
  if (!song || typeof song !== 'string' || song.trim().length < 2)
    return res.status(400).json({ error: 'Please provide a song name.' });

  const ALLOWED = ['tempo','melody','rhythm','lyrics','vibe','production'];
  const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
  if (!attrs.length)
    return res.status(400).json({ error: 'Select at least one attribute.' });

  try {
    const result = await discoverPipeline(song.trim(), attrs.join(', '));
    if (!result.recommendations.length)
      return res.status(502).json({ error: 'Could not verify any recommendations — try a more well-known song.' });
    return res.json(result);
  } catch (err) {
    console.error('[/api/discover]', err.message);
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
