'use strict';
require('dotenv').config();

process.on('uncaughtException',  e => console.error('[crash]', e.message));
process.on('unhandledRejection', r => console.error('[crash]', r));

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
  next();
});

try {
  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    validate: { trustProxy: false },
    message: { error: 'Too many requests — wait a few minutes.' }
  });
  app.use('/api/discover', limiter);
} catch (e) { console.warn('[startup] rate limiter failed:', e.message); }

app.use(express.static(path.join(__dirname, '../public')));

// ── Safe fetch ────────────────────────────────────────────────────────────────
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    console.warn('[safeFetch]', url.slice(0, 60), e.message);
    return null;
  }
}

// ── String matching ───────────────────────────────────────────────────────────
const norm = s => String(s || '').toLowerCase()
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

// ═══════════════════════════════════════════════════════════════════════════════
// GENRE FAMILY — used to reject obvious mismatches AFTER Spotify verifies genres
// ═══════════════════════════════════════════════════════════════════════════════
const GENRE_FAMILIES = {
  'hip-hop':      ['hip hop','hip-hop','rap','trap','drill','grime','boom bap','conscious hip hop',
                   'gangsta rap','cloud rap','phonk','memphis rap','crunk','jersey club','plugg'],
  'rnb-soul':     ['r&b','rnb','soul','neo soul','motown','funk','quiet storm','contemporary r&b',
                   'new jack swing','indie r&b','alternative r&b','gospel','blues'],
  'rock':         ['rock','alternative','punk','metal','grunge','indie rock','hard rock','classic rock',
                   'post-rock','emo','pop punk','garage rock','psychedelic rock','progressive rock'],
  'folk-country': ['folk','country','americana','bluegrass','singer-songwriter','acoustic','alt-country',
                   'indie folk','contemporary folk','roots','western','appalachian'],
  'pop':          ['pop','synth pop','electropop','indie pop','dream pop','chamber pop','power pop','hyperpop'],
  'electronic':   ['electronic','edm','techno','house','trance','dubstep','drum and bass','ambient',
                   'chillwave','vaporwave','lo-fi','trip hop','downtempo','idm','synthwave'],
  'jazz':         ['jazz','bebop','jazz fusion','smooth jazz','nu jazz','afrobeat','bossa nova'],
  'classical':    ['classical','orchestral','opera','chamber music'],
  'latin':        ['latin','reggaeton','salsa','cumbia','bachata','latin pop','latin trap'],
  'reggae':       ['reggae','dancehall','ska','dub']
};

const COMPATIBLE = {
  'hip-hop':      ['rnb-soul', 'electronic'],
  'rnb-soul':     ['hip-hop', 'pop', 'jazz'],
  'rock':         ['folk-country', 'pop'],
  'folk-country': ['rock', 'pop'],
  'pop':          ['rock', 'rnb-soul', 'electronic', 'folk-country'],
  'electronic':   ['hip-hop', 'pop'],
  'jazz':         ['rnb-soul', 'electronic'],
  'classical':    ['jazz'],
  'latin':        ['pop', 'rnb-soul'],
  'reggae':       ['hip-hop', 'electronic']
};

function getGenreFamily(genres) {
  if (!genres || !genres.length) return null;
  const joined = genres.join(' ').toLowerCase();
  for (const [family, keywords] of Object.entries(GENRE_FAMILIES)) {
    if (keywords.some(k => joined.includes(k))) return family;
  }
  return null;
}

function genreCompatible(seedFamily, recGenres) {
  if (!seedFamily) return true;
  if (!recGenres || !recGenres.length) return true;
  const recFamily = getGenreFamily(recGenres);
  if (!recFamily) return true;
  if (recFamily === seedFamily) return true;
  return (COMPATIBLE[seedFamily] || []).includes(recFamily);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE — ratings only (NO longer fed into Groq prompt)
// ═══════════════════════════════════════════════════════════════════════════════
const SUPA_URL    = (process.env.SUPABASE_URL  || '').trim();
const SUPA_KEY    = (process.env.SUPABASE_KEY  || '').trim();
const supaEnabled = !!(SUPA_URL && SUPA_KEY);

function supaHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
    'Prefer':        'return=representation'
  };
}

async function saveRating({ userId, searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating }) {
  if (!supaEnabled) return;
  try {
    await safeFetch(`${SUPA_URL}/rest/v1/ratings`, {
      method: 'POST',
      headers: { ...supaHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id:     userId || null,
        song:        String(searchSong  || '').slice(0, 200),
        rec_title:   String(recTitle    || '').slice(0, 200),
        rec_artist:  String(recArtist   || '').slice(0, 200),
        genre_tags:  Array.isArray(genreTags)  ? genreTags  : [],
        match_attrs: Array.isArray(matchAttrs) ? matchAttrs : [],
        popularity:  String(popularity  || 'unknown').slice(0, 50),
        rating:      rating > 0 ? 1 : -1
      })
    });
  } catch (e) { console.warn('[Supabase] saveRating:', e.message); }
}

async function getStats() {
  if (!supaEnabled) return null;
  try {
    const res = await safeFetch(
      `${SUPA_URL}/rest/v1/ratings?select=rating,genre_tags&limit=1000`,
      { headers: supaHeaders() }
    );
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return { total: 0 };
    const total   = rows.length;
    const helpful = rows.filter(r => r.rating > 0).length;
    const genres  = {};
    rows.forEach(r => (r.genre_tags || []).forEach(g => { genres[g] = (genres[g] || 0) + 1; }));
    const topGenres = Object.entries(genres).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([g])=>g);
    return { total, helpful, helpfulPct: Math.round(helpful/total*100), topGenres };
  } catch (e) { return null; }
}

// Auth stubs (kept for future use)
async function verifyUser(token) { return null; }
async function getProfile(userId) { return null; }
async function checkAndIncrementQuota(userId) { return { allowed: true, remaining: 999, tier: 'free' }; }

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT RESULTS CACHE — prevents same songs on back-to-back searches
// ═══════════════════════════════════════════════════════════════════════════════
const recentResults = new Map(); // key: normalized seed → [{ title, artist }]
const RECENT_TTL = 30 * 60 * 1000; // 30 min

function getRecentExclusions(seed) {
  const key = seed.toLowerCase().trim();
  const entry = recentResults.get(key);
  if (!entry) return [];
  if (Date.now() - entry.ts > RECENT_TTL) { recentResults.delete(key); return []; }
  return entry.items;
}

function saveRecentResults(seed, recs) {
  const key = seed.toLowerCase().trim();
  const existing = getRecentExclusions(seed);
  const items = [...existing, ...recs.map(r => ({ title: r.title, artist: r.artist }))].slice(-60);
  recentResults.set(key, { ts: Date.now(), items });
  // Prune old entries
  if (recentResults.size > 200) {
    const oldest = [...recentResults.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) recentResults.delete(oldest[0]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTIFY
// ═══════════════════════════════════════════════════════════════════════════════
let _sTok = null, _sExp = 0;

async function getSpotifyToken() {
  if (_sTok && Date.now() < _sExp) return _sTok;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: sec } = process.env;
  if (!id || !sec) { console.warn('[spotify] missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET'); return null; }
  const res = await safeFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!res) { console.warn('[spotify] token endpoint unreachable'); return null; }
  if (!res.ok) { console.warn('[spotify] token endpoint returned', res.status); return null; }
  try {
    const d = await res.json();
    if (!d.access_token) { console.warn('[spotify] no access_token in response:', JSON.stringify(d).slice(0, 200)); return null; }
    _sTok = d.access_token;
    _sExp = Date.now() + (d.expires_in - 60) * 1000;
    console.log('[spotify] token refreshed, expires in', d.expires_in, 's');
    return _sTok;
  } catch (e) { console.warn('[spotify] token parse error:', e.message); return null; }
}

// Based on artist follower count — much more accurate than track popularity score
// Lil Baby has 20M followers = well-known regardless of which track is searched
function getStreamTier(followers) {
  if (followers >= 5000000)  return 'well-known';    // 5M+ = genuinely mainstream
  if (followers >= 500000)   return 'known';    // 500K–5M = growing/recognised
  return 'underrated';                // under 500K = underground
}

// ── Get full seed data from Spotify for the input song ───────────────────────
async function getSpotifySeed(title, artist) {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;

    const q   = `track:${title}${artist ? ' artist:' + artist : ''}`;
    const res = await safeFetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res || !res.ok) return null;
    const d     = await res.json();
    const track = d?.tracks?.items?.[0];
    if (!track) return null;
    // Ensure track has a usable Spotify URL
    if (track.external_urls && !track.external_urls.spotify && track.id) {
      track.external_urls.spotify = `https://open.spotify.com/track/${track.id}`;
    }

    const artistId = track.artists?.[0]?.id;
    const trackId  = track.id;

    const [featRes, artistRes, relatedRes] = await Promise.all([
      safeFetch(`https://api.spotify.com/v1/audio-features/${trackId}`,
        { headers: { Authorization: `Bearer ${token}` } }),
      artistId ? safeFetch(`https://api.spotify.com/v1/artists/${artistId}`,
        { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null),
      artistId ? safeFetch(`https://api.spotify.com/v1/artists/${artistId}/related-artists`,
        { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null)
    ]);

    const keyNames  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const modeNames = { 0:'minor', 1:'major' };
    let features = null, genres = [], relatedArtists = [];

    if (featRes && featRes.ok) {
      const f = await featRes.json();
      features = {
        bpm:              Math.round(f.tempo),
        key:              f.key >= 0 ? keyNames[f.key] + ' ' + (modeNames[f.mode] || '') : 'unknown',
        energy:           Math.round(f.energy * 100),
        danceability:     Math.round(f.danceability * 100),
        valence:          Math.round(f.valence * 100),
        acousticness:     Math.round(f.acousticness * 100),
        instrumentalness: Math.round(f.instrumentalness * 100),
        speechiness:      Math.round(f.speechiness * 100),
        loudness:         Math.round(f.loudness * 10) / 10,
        timeSignature:    f.time_signature
      };
    } else if (featRes) {
      console.warn('[seed] audio-features returned', featRes.status, '(likely deprecated)');
    }

    if (artistRes && artistRes.ok) {
      const a = await artistRes.json();
      genres  = (a.genres || []).slice(0, 5);
    }

    if (relatedRes && relatedRes.ok) {
      const r = await relatedRes.json();
      relatedArtists = (r.artists || []).slice(0, 6).map(a => a.name);
    } else if (relatedRes) {
      console.warn('[seed] related-artists returned', relatedRes.status, '(likely deprecated)');
    }

    console.log(`[seed] "${track.name}" | BPM:${features?.bpm} | Genres:[${genres.join(',')}] | Related:[${relatedArtists.slice(0,3).join(',')}]`);

    return {
      trackName:      track.name,
      artistName:     track.artists?.[0]?.name || artist,
      albumName:      track.album?.name || '',
      releaseYear:    (track.album?.release_date || '').slice(0, 4),
      popularity:     track.popularity || 0,
      features,
      genres,
      relatedArtists,
      image:          track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null
    };
  } catch (e) {
    console.warn('[seed] error:', e.message);
    return null;
  }
}

// ── Verify a single result track on Spotify, get real genres ─────────────────
async function spotifySearch(title, artist) {
  try {
    let token = await getSpotifyToken();
    if (!token) return null;
    let best = null, bestScore = 0;
    for (const q of [`track:${title} artist:${artist}`, `${title} ${artist}`]) {
      const res = await safeFetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res) continue;
      // Token expired — force refresh and retry once
      if (res.status === 401) {
        _sTok = null; _sExp = 0;
        token = await getSpotifyToken();
        if (!token) return null;
        const retry = await safeFetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!retry || !retry.ok) continue;
        let rd; try { rd = await retry.json(); } catch (e) { continue; }
        for (const t of (rd?.tracks?.items || [])) {
          const arts = (t.artists || []).map(a => matchScore(a.name, artist));
          const ts = matchScore(t.name, title);
          const as = arts.length ? Math.max(...arts) : 0;
          const sc = ts * 0.6 + as * 0.4;
          if (sc > bestScore) { bestScore = sc; best = t; }
        }
        if (bestScore >= 0.85) break;
        continue;
      }
      let d; try { d = await res.json(); } catch (e) { continue; }
      for (const t of (d?.tracks?.items || [])) {
        const arts = (t.artists || []).map(a => matchScore(a.name, artist));
        const ts = matchScore(t.name, title);
        const as = arts.length ? Math.max(...arts) : 0;
        const sc = ts * 0.6 + as * 0.4;
        if (sc > bestScore) { bestScore = sc; best = t; }
      }
      if (bestScore >= 0.85) break;
    }
    if (!best || bestScore < 0.5) return null;

    // Fetch real artist genres + follower count
    let realGenres = [], artistFollowers = 0;
    const artistId = best.artists?.[0]?.id;
    if (artistId) {
      try {
        const ar = await safeFetch(`https://api.spotify.com/v1/artists/${artistId}`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (ar && ar.ok) {
          const ad = await ar.json();
          realGenres    = (ad.genres || []).slice(0, 3);
          artistFollowers = ad.followers?.total || 0;
        } else if (ar) {
          console.warn('[spotifySearch] artist fetch returned', ar.status);
        }
      } catch (e) { console.warn('[spotifySearch] artist fetch failed:', e.message); }
    }

    // Determine stream tier: use followers if available, else fall back to track popularity score
    let streamTier;
    if (artistFollowers > 0) {
      streamTier = getStreamTier(artistFollowers);
    } else {
      // Track popularity 0-100 from Spotify search results
      const pop = best.popularity || 0;
      streamTier = pop >= 70 ? 'well-known' : pop >= 40 ? 'known' : 'underrated';
    }

    // Always construct a direct Spotify URL from track ID as fallback
    const trackId  = best.id;
    const spotUrl  = best.external_urls?.spotify || (trackId ? `https://open.spotify.com/track/${trackId}` : null);

    return {
      url:             spotUrl,
      trackId:         trackId || null,
      preview:         best.preview_url || null,
      image:           best.album?.images?.[1]?.url || best.album?.images?.[0]?.url || null,
      matchScore:      bestScore,
      verified:        bestScore >= 0.85,
      streamTier,
      followers:       artistFollowers,
      realGenres,
      realTitle:       best.name,
      realArtist:      best.artists?.[0]?.name || artist
    };
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// YOUTUBE
// ═══════════════════════════════════════════════════════════════════════════════
const ytCache = new Map();

async function youtubeSearch(title, artist) {
  try {
    const ck  = `${norm(title)}|||${norm(artist)}`;
    if (ytCache.has(ck)) return ytCache.get(ck);
    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
      const res = await safeFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(title + ' ' + artist + ' official audio')}&type=video&maxResults=3&key=${key}`
      );
      if (res) {
        let d; try { d = await res.json(); } catch (e) { d = null; }
        if (d && !d.error && d.items?.length) {
          const item  = d.items[0];
          const score = matchScore(item.snippet?.title || '', title) * 0.6 +
                        matchScore(item.snippet?.channelTitle || '', artist) * 0.4;
          if (score >= 0.4) {
            const r = {
              url:       `https://www.youtube.com/watch?v=${item.id.videoId}`,
              videoId:   item.id.videoId,
              thumbnail: item.snippet?.thumbnails?.medium?.url || null,
              matchScore: score,
              verified:  score >= 0.75,
              viaApi:    true
            };
            ytCache.set(ck, r); return r;
          }
        }
        if (d?.error) console.warn('[YouTube]', d.error.message);
      }
    }
    const r = {
      url:      `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + artist)}`,
      videoId:  null, thumbnail: null, matchScore: 0.6, verified: false, viaApi: false
    };
    ytCache.set(ck, r); return r;
  } catch (e) {
    return {
      url:     `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' ' + artist)}`,
      videoId: null, thumbnail: null, matchScore: 0.5, verified: false, viaApi: false
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLE MUSIC
// ═══════════════════════════════════════════════════════════════════════════════
const appleCache = new Map();

async function appleMusicSearch(title, artist) {
  try {
    const ck = `${norm(title)}|||${norm(artist)}`;
    if (appleCache.has(ck)) return appleCache.get(ck);
    const q   = encodeURIComponent(`${title} ${artist}`);
    const res = await safeFetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=5`);
    if (res) {
      let d; try { d = await res.json(); } catch (e) { d = null; }
      if (d?.results?.length) {
        let best = null, bestScore = 0;
        for (const item of d.results) {
          const ts = matchScore(item.trackName || '', title);
          const as = matchScore(item.artistName || '', artist);
          const sc = ts * 0.6 + as * 0.4;
          if (sc > bestScore) { bestScore = sc; best = item; }
        }
        if (best && bestScore >= 0.4) {
          const r = {
            url:       best.trackViewUrl || `https://music.apple.com/search?term=${q}`,
            image:     best.artworkUrl100?.replace('100x100', '300x300') || null,
            viaApi:    true, verified: bestScore >= 0.75, matchScore: bestScore
          };
          appleCache.set(ck, r); return r;
        }
      }
    }
    const r = { url: `https://music.apple.com/search?term=${q}`, viaApi: false };
    appleCache.set(ck, r); return r;
  } catch (e) {
    return { url: `https://music.apple.com/search?term=${encodeURIComponent(title + ' ' + artist)}`, viaApi: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAST.FM
// ═══════════════════════════════════════════════════════════════════════════════
async function getLastFmSimilar(title, artist) {
  try {
    const key = process.env.LASTFM_API_KEY;
    if (!key) return null;
    const res = await safeFetch(
      `https://ws.audioscrobbler.com/2.0/?method=track.getSimilar&track=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&limit=10&autocorrect=1&api_key=${key}&format=json`
    );
    if (!res) return null;
    let d; try { d = await res.json(); } catch (e) { return null; }
    const tracks = d?.similartracks?.track;
    if (!tracks || !tracks.length) return null;
    const list = (Array.isArray(tracks) ? tracks : [tracks])
      .slice(0, 8)
      .map(t => '"' + t.name + '" by ' + (t.artist?.name || ''))
      .filter(Boolean);
    if (!list.length) return null;
    return '\n\nLAST.FM SIMILAR TRACKS (human-curated listener data):\n' +
      list.map((t, i) => (i + 1) + '. ' + t).join('\n') +
      '\nUse these as style anchors — recommend tracks in the same sonic territory.';
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS CHECK — Spotify verifies existence + gets real genres, YT + Apple add links
// ═══════════════════════════════════════════════════════════════════════════════
// Batch cross-checks to avoid Spotify rate limits (5 at a time)
async function batchCrossCheck(cands) {
  const results = [];
  for (let i = 0; i < cands.length; i += 5) {
    const batch = cands.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(crossCheck));
    results.push(...batchResults);
  }
  return results.filter(Boolean);
}

async function crossCheck(rec) {
  try {
    const [spotify, youtube, apple] = await Promise.all([
      spotifySearch(rec.title, rec.artist),
      youtubeSearch(rec.title, rec.artist),
      appleMusicSearch(rec.title, rec.artist)
    ]);

    const sScore = spotify?.matchScore || 0;
    const yScore = youtube?.matchScore || 0;
    const aScore = apple?.matchScore  || 0;

    console.log('  CHECK:', rec.title, 'by', rec.artist, '| sp:', sScore.toFixed(2), 'yt:', yScore.toFixed(2), 'am:', aScore.toFixed(2));

    // GATE: At least one platform must find the track with decent confidence
    const platformHits = (sScore >= 0.5 ? 1 : 0) + (yScore >= 0.5 ? 1 : 0) + (aScore >= 0.5 ? 1 : 0);
    if (platformHits < 1) {
      console.log('  DROPPED:', rec.title);
      return null;
    }

    // Use real Spotify genres, fall back to Groq tags
    const realGenres = spotify?.realGenres || [];
    const genreTags  = realGenres.length ? realGenres : (rec.genre_tags || []);

    const confidence = platformHits >= 3 ? 'high' : platformHits >= 2 ? 'medium' : 'low';

    // Overwrite Groq's title/artist with verified Spotify names to prevent mislabeling
    const correctedTitle  = (sScore >= 0.6 && spotify?.realTitle)  ? spotify.realTitle  : rec.title;
    const correctedArtist = (sScore >= 0.6 && spotify?.realArtist) ? spotify.realArtist : rec.artist;

    // Stream tier: use Spotify data if available, else map Groq's popularity hint
    const groqPop = (rec.popularity || '').toLowerCase();
    const groqTier = groqPop.includes('mainstream') ? 'well-known' : groqPop.includes('emerging') ? 'known' : 'underrated';
    const finalTier = spotify?.streamTier || groqTier;

    return { ...rec, title: correctedTitle, artist: correctedArtist, genre_tags: genreTags, spotify, youtube, apple, confidence, platformHits, streamTier: finalTier };
  } catch (e) { console.warn('  crossCheck error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ — clean prompt, Spotify data as single source of truth
// ═══════════════════════════════════════════════════════════════════════════════
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',                     // best quality
  'meta-llama/llama-4-scout-17b-16e-instruct',   // fast, separate rate pool
  'qwen/qwen3-32b',                              // good quality, separate pool
  'llama-3.1-8b-instant'                          // fastest, rarely limited
];

async function groqFetch(messages, { temperature = 0.6, max_tokens = 2500 } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY missing');

  for (let m = 0; m < GROQ_MODELS.length; m++) {
    const model = GROQ_MODELS[m];
    const isQwen = model.includes('qwen');

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        const wait = 1500 * Math.pow(2, attempt) + Math.random() * 1000;
        console.log('[groq] waiting', Math.round(wait) + 'ms before retry...');
        await new Promise(r => setTimeout(r, wait));
      }

      try {
        const body = {
          model, temperature, max_tokens,
          response_format: { type: 'json_object' },
          messages
        };
        if (isQwen) body.reasoning_format = 'hidden';

        const res = await safeFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify(body)
        });

        if (!res) { console.warn('[groq]', model, 'unreachable'); continue; }

        if (res.status === 429) {
          const retryAfter = res.headers?.get?.('retry-after');
          console.warn('[groq] 429 on', model, retryAfter ? '(retry-after: ' + retryAfter + 's)' : '');
          if (retryAfter && Number(retryAfter) > 30) break;
          continue;
        }

        if (res.status === 503 || res.status === 500) {
          console.warn('[groq]', model, res.status, '— retrying');
          continue;
        }

        if (!res.ok) {
          console.warn('[groq]', model, 'returned', res.status);
          break;
        }

        let d; try { d = await res.json(); } catch (e) { continue; }
        const raw = d.choices?.[0]?.message?.content || '';
        if (!raw) continue;
        console.log('[groq] ✓', model, '(' + raw.length + ' chars)');
        return extractJSON(raw);
      } catch (e) {
        console.warn('[groq]', model, 'error:', e.message);
        continue;
      }
    }
    console.warn('[groq]', model, 'exhausted → next model');
  }

  throw new Error('RATE_LIMIT');
}

function extractJSON(raw) {
  let t = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON');
  t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) {}
  return JSON.parse(t.replace(/[\x00-\x1F\x7F]/g, ' '));
}

async function groqRecommend({ song, seedData, attrList, count, exclude, era, energy, lastfmNote, isPro }) {
  const exclNote = exclude.length
    ? '\nDo NOT include: ' + exclude.map(e => '"' + e.title + '" by ' + e.artist).join(', ') + '.'
    : '';

  const proNote = isPro ? '\nPro search: provide extra variety and deeper underground cuts.' : '';

  const eraMap   = { '70s':'the 1970s','80s':'the 1980s','90s':'the 1990s','2000s':'the 2000s','2010s':'the 2010s','2020s':'the 2020s' };
  const eraNote  = era !== 'any' ? '\nERA: Only songs from ' + (eraMap[era] || era) + '.' : '';

  const energyDescriptions = {
    chill: 'low energy, mellow, laid-back — nothing intense or hype',
    mid:   'moderate energy, not too chill and not too intense',
    hype:  'high energy, upbeat, intense — nothing slow or mellow'
  };
  const energyNote = energy !== 'any' ? '\nENERGY: Only ' + (energyDescriptions[energy] || energy) + '.' : '';

  // Build seed context from verified Spotify data
  let seedContext = '';
  if (seedData) {
    const f = seedData.features;
    const nl = '\n';
    seedContext = nl + nl + '=== VERIFIED SPOTIFY DATA FOR SEED TRACK ===';
    seedContext += nl + 'Track: "' + seedData.trackName + '" by ' + seedData.artistName;
    if (seedData.genres && seedData.genres.length) {
      seedContext += nl + 'Genres: ' + seedData.genres.join(', ');
      seedContext += nl + 'CRITICAL: Only recommend songs in these exact genres or close sub-genres. Do NOT recommend songs from completely different genre families.';
    }
    if (seedData.relatedArtists && seedData.relatedArtists.length) {
      seedContext += nl + 'Spotify Related Artists: ' + seedData.relatedArtists.join(', ');
      seedContext += nl + 'Prioritise artists and sounds similar to these related artists.';
    }
    if (f) {
      seedContext += nl + 'Audio Profile (match these closely):';
      seedContext += nl + '  BPM: ' + f.bpm + ' — recommend songs within ' + (f.bpm - 12) + ' to ' + (f.bpm + 12) + ' BPM';
      seedContext += nl + '  Key: ' + f.key;
      seedContext += nl + '  Energy: ' + f.energy + '/100';
      seedContext += nl + '  Danceability: ' + f.danceability + '/100';
      seedContext += nl + '  Valence (mood): ' + f.valence + '/100 — ' + (f.valence >= 60 ? 'positive/upbeat mood' : f.valence >= 35 ? 'neutral mood' : 'melancholic/dark mood');
      seedContext += nl + '  Acousticness: ' + f.acousticness + '/100';
      seedContext += nl + '  Speechiness: ' + f.speechiness + '/100 — ' + (f.speechiness >= 66 ? 'rap/spoken word dominant' : f.speechiness >= 33 ? 'rhythmic speech elements' : 'melodic/sung');
    }
    seedContext += nl + '=== END SEED DATA ===';
  }

  const systemPrompt =
    'You are a music recommendation engine specialising in underground and emerging artists. ' +
    'ABSOLUTE RULES you must never violate: ' +
    '(1) Stay within the same genre family as the seed track. ' +
    '(2) Match BPM within 12 beats and match energy level. ' +
    '(3) ARTIST DIVERSITY: Never recommend the same artist more than once per search. Never recommend the seed track artist. ' +
    '(4) UNDERGROUND BIAS — this is critical: At least 80% of results MUST be artists with under 500,000 Spotify followers. ' +
    '    Do NOT recommend: Drake, Kendrick Lamar, J. Cole, Travis Scott, Post Malone, The Weeknd, Billie Eilish, Taylor Swift, ' +
    '    Ariana Grande, Ed Sheeran, Bad Bunny, Beyonce, Jay-Z, Eminem, Kanye West, Lil Baby, Lil Uzi Vert, Future, 21 Savage, ' +
    '    or any other artist with more than 5 million Spotify followers. ' +
    '(5) Every song must exist on Spotify today. ' +
    '(6) Respond with valid JSON only.';

  const userPrompt =
    'Find ' + count + ' songs sonically similar to "' + song + '" based on: ' + attrList + '.' +
    exclNote + proNote + eraNote + energyNote + seedContext + (lastfmNote || '') +
    '\nVARIETY: Surprise me — pick different artists and tracks than you normally would. Avoid obvious or popular choices. ' +
    'Each search should feel fresh with new discoveries.' +
    '\nEach recommendation must be a DIFFERENT artist. ' +
    'Use EXACT Spotify song titles and artist names.' +
    '\nCRITICAL: Every song MUST be a real track currently available on Spotify. ' +
    'Do NOT invent song titles. If you are not certain a song exists, do NOT include it.' +
    '\nPOPULARITY: Be accurate — "underground" means truly unknown artists (<500K followers), ' +
    '"emerging" means growing (500K-5M), "mainstream" means well-known (5M+). ' +
    'Do NOT label well-known artists as underground.' +
    '\nReturn ONLY this JSON: {"song":{"title":"","artist":"","attributes":{"bpm":"","key":"","energy":0.7,"danceability":0.6,"mood":"","genre_tags":[]}},"recommendations":[{"title":"","artist":"","year":"","popularity":"underground|emerging|mainstream","match_attributes":[],"similarity_score":0.9,"why":"","genre_tags":[]}]}';

  return await groqFetch([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt   }
  ], { temperature: 0.85, max_tokens: 2500 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE — Spotify first → Groq → cross-check → genre filter
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverPipeline(song, attrList, isPro, era, energy, popFilter) {
  const TARGET   = isPro ? 15 : 10;
  const verified = [];
  let   songMeta = null;

  // Seed exclusions with recently shown results for this song
  const recentExcl = getRecentExclusions(song);
  const excluded = [...recentExcl];
  if (recentExcl.length > 0) console.log('[pipeline] excluding', recentExcl.length, 'recent results');

  // Parse "Title – Artist" or "Title by Artist"
  let seedTitle = song, seedArtist = '';
  const dm = song.match(/^(.+?)\s*[–-]\s*(.+)$/);
  const bm = song.match(/^(.+?)\s+by\s+(.+)$/i);
  if (dm) { seedTitle = dm[1].trim(); seedArtist = dm[2].trim(); }
  else if (bm) { seedTitle = bm[1].trim(); seedArtist = bm[2].trim(); }

  // STEP 1: Spotify + Last.fm in parallel
  console.log('\n[pipeline] step 1 — enrichment');
  const [spotifySeed, lastfmNote] = await Promise.all([
    getSpotifySeed(seedTitle, seedArtist),
    getLastFmSimilar(seedTitle, seedArtist)
  ]);

  // Use verified Spotify name if found
  const verifiedSong = spotifySeed
    ? spotifySeed.trackName + ' by ' + spotifySeed.artistName
    : song;

  // Seed genre family for post-verification filtering
  const seedFamily = spotifySeed ? getGenreFamily(spotifySeed.genres) : null;
  console.log('[pipeline] seed family:', seedFamily || 'unknown', '| BPM:', spotifySeed?.features?.bpm || 'unknown');

  // Build song meta for UI from Spotify data
  if (spotifySeed) {
    songMeta = {
      title:  spotifySeed.trackName,
      artist: spotifySeed.artistName,
      attributes: {
        bpm:          String(spotifySeed.features?.bpm || ''),
        key:          spotifySeed.features?.key || '',
        energy:       (spotifySeed.features?.energy || 0) / 100,
        danceability: (spotifySeed.features?.danceability || 0) / 100,
        mood:         spotifySeed.features?.valence >= 60 ? 'positive' : spotifySeed.features?.valence >= 35 ? 'neutral' : 'melancholic',
        genre_tags:   spotifySeed.genres
      },
      image: spotifySeed.image
    };
  }

  // STEP 2: Groq generates → cross-check → filter (up to 3 rounds)
  for (let round = 1; round <= 3 && verified.length < TARGET; round++) {
    const needed = TARGET - verified.length;
    console.log('[pipeline] round', round, '— need', needed, 'more');

    let gr;
    try {
      gr = await groqRecommend({
        song: verifiedSong, seedData: spotifySeed,
        attrList, count: needed + 14,
        exclude: excluded, era, energy,
        lastfmNote: lastfmNote || '', isPro
      });
    } catch (e) {
      if (e.message === 'RATE_LIMIT') throw e;
      console.warn('[pipeline] Groq error:', e.message);
      break;
    }

    if (!songMeta && gr?.song) songMeta = gr.song;
    const cands = (gr?.recommendations || []).slice(0, needed + 14);
    console.log('[pipeline] Groq returned', cands.length, 'candidates:', cands.slice(0, 3).map(c => c.title + ' - ' + c.artist).join(', '), cands.length > 3 ? '...' : '');
    excluded.push(...cands.map(r => ({ title: r.title, artist: r.artist })));

    // Cross-check: Spotify verifies + gets real genres, YT + Apple add links
    console.log('[pipeline] cross-checking', cands.length, 'candidates...');
    let passed = await batchCrossCheck(cands);

    // Drop any result by the seed artist
    const seedArtistName = spotifySeed?.artistName || seedArtist || '';
    if (seedArtistName) {
      const seedNorm = seedArtistName.toLowerCase().replace(/[^a-z0-9]/g,'');
      passed = passed.filter(function(r) {
        const rNorm = (r.artist||'').toLowerCase().replace(/[^a-z0-9]/g,'');
        return rNorm !== seedNorm;
      });
    }

    // Genre filter using REAL Spotify genres — only apply if it leaves enough
    if (seedFamily && passed.length > 5) {
      const compatible = passed.filter(r => genreCompatible(seedFamily, r.genre_tags || []));
      const dropped    = passed.length - compatible.length;
      if (compatible.length >= 5) {
        if (dropped > 0) console.log('[pipeline] genre filter dropped', dropped, 'mismatches');
        passed = compatible;
      } else {
        console.log('[pipeline] genre filter too strict, keeping all', passed.length);
      }
    }

    // Pop tier filter — only apply if it leaves enough
    if (popFilter && popFilter !== 'any') {
      const tierFiltered = passed.filter(r => r.streamTier === popFilter);
      if (tierFiltered.length >= 5) passed = tierFiltered;
    }

    console.log('[pipeline] round', round, ':', passed.length + '/' + cands.length, 'passed');

    // Deduplicate: skip artists already in verified results
    const seenArtists = new Set(verified.map(v => (v.artist||'').toLowerCase().replace(/[^a-z0-9]/g,'')));
    passed = passed.filter(r => {
      const norm = (r.artist||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      if (seenArtists.has(norm)) return false;
      seenArtists.add(norm);
      return true;
    });

    verified.push(...passed.slice(0, needed));
  }

  // Cache these results so next search for same song gets different tracks
  if (verified.length > 0) saveRecentResults(song, verified);

  return { song: songMeta, recommendations: verified };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE (lightweight — no quota enforcement yet)
// ═══════════════════════════════════════════════════════════════════════════════
async function authMiddleware(req, res, next) {
  req.user  = null;
  req.isPro = false;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LINK RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/resolve-link', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL provided.' });
  let clean = url.trim();

  // Handle spotify.link short URLs — follow redirect to get real URL
  if (clean.includes('spotify.link')) {
    try {
      console.log('[resolve] following spotify.link redirect...');
      const r = await safeFetch(clean, { redirect: 'follow' });
      if (r && r.url) {
        clean = r.url.split('?')[0].split('#')[0];
        console.log('[resolve] redirected to:', clean);
      } else if (r && r.headers) {
        const loc = r.headers.get('location');
        if (loc) { clean = loc.split('?')[0].split('#')[0]; console.log('[resolve] location header:', clean); }
        else return res.status(400).json({ error: 'Could not follow Spotify short link. Paste the full link instead.' });
      } else {
        return res.status(400).json({ error: 'Could not follow Spotify short link. Paste the full link instead.' });
      }
    } catch (e) {
      console.warn('[resolve] spotify.link redirect failed:', e.message);
      return res.status(400).json({ error: 'Could not follow Spotify short link. Paste the full link instead.' });
    }
  }

  // Strip query params
  const cleanUrl = clean.split('?')[0].split('#')[0];
  const spotifyMatch = cleanUrl.match(/spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (spotifyMatch) {
    const token = await getSpotifyToken();
    if (!token) {
      console.warn('[resolve] Spotify token unavailable — check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET');
      return res.status(502).json({ error: 'Spotify unavailable — API credentials may be invalid.' });
    }
    const trackIdFromUrl = spotifyMatch[1];
    console.log('[resolve] fetching Spotify track:', trackIdFromUrl);

    // Try direct track endpoint first
    const r = await safeFetch(`https://api.spotify.com/v1/tracks/${trackIdFromUrl}`,
      { headers: { Authorization: `Bearer ${token}` } });

    if (r && r.ok) {
      try {
        const d = await r.json();
        const directUrl = d.external_urls?.spotify || `https://open.spotify.com/track/${trackIdFromUrl}`;
        return res.json({
          title:        d.name,
          artist:       d.artists?.[0]?.name || '',
          image:        d.album?.images?.[1]?.url || d.album?.images?.[0]?.url || null,
          source:       'spotify',
          spotifyUrl:   directUrl,
          searchString: d.name + ' – ' + (d.artists?.[0]?.name || '')
        });
      } catch (e) { /* fall through to search */ }
    }

    if (r && r.status === 401) { _sTok = null; _sExp = 0; }

    // Fallback: use oEmbed endpoint (public, no auth needed, always works)
    console.log('[resolve] direct fetch failed (' + (r?.status || 'no response') + '), trying oEmbed...');
    const oembedRes = await safeFetch(
      `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackIdFromUrl}`
    );
    if (oembedRes && oembedRes.ok) {
      try {
        const od = await oembedRes.json();
        // oEmbed title format: "Song Name" by "Artist Name"
        const raw = od.title || '';
        const byMatch = raw.match(/^(.+?)\s+by\s+(.+)$/i);
        const title = byMatch ? byMatch[1].trim() : raw;
        const artist = byMatch ? byMatch[2].trim() : '';
        return res.json({
          title, artist,
          image:        od.thumbnail_url || null,
          source:       'spotify',
          spotifyUrl:   `https://open.spotify.com/track/${trackIdFromUrl}`,
          searchString: title + (artist ? ' – ' + artist : '')
        });
      } catch (e) { /* fall through */ }
    }

    return res.status(502).json({ error: 'Could not resolve Spotify track. Try typing the song name instead.' });
  }

  const ytMatch = clean.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (ytMatch) {
    const ytKey = process.env.YOUTUBE_API_KEY;
    if (!ytKey) return res.status(502).json({ error: 'YouTube API not configured.' });
    const r = await safeFetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ytMatch[1]}&key=${ytKey}`);
    if (!r || !r.ok) return res.status(502).json({ error: 'Could not fetch video.' });
    try {
      const d = await r.json();
      const sn = d.items?.[0]?.snippet;
      if (!sn) return res.status(404).json({ error: 'Video not found.' });
      const vtitle   = sn.title || '';
      const channel  = (sn.channelTitle || '').replace(/\s*-\s*Topic$/, '').trim();
      const dashParse = vtitle.match(/^(.+?)\s*[-–]\s*(.+?)(?:\s*[\(\[].*[\)\]])?$/);
      let title = vtitle, artist = channel;
      if (dashParse) { artist = dashParse[1].trim(); title = dashParse[2].trim().replace(/\s*[\(\[].*(official|lyrics|video|audio|ft\.|feat\.).*[\)\]]/gi, '').trim(); }
      return res.json({ title, artist, image: sn.thumbnails?.medium?.url || null, source: 'youtube', searchString: title + ' – ' + artist });
    } catch (e) { return res.status(502).json({ error: 'Parse error.' }); }
  }

  const appleMatch = clean.match(/music\.apple\.com\/[a-z]{2}\/(?:album|song)\/[^\/]+\/(\d+)(?:\?i=(\d+))?/);
  if (appleMatch) {
    const lookupId = appleMatch[2] || appleMatch[1];
    const r = await safeFetch(`https://itunes.apple.com/lookup?id=${lookupId}&entity=song&limit=1`);
    if (!r || !r.ok) return res.status(502).json({ error: 'Could not fetch from Apple Music.' });
    try {
      const d    = await r.json();
      const item = d.results?.find(x => x.wrapperType === 'track') || d.results?.[0];
      if (!item) return res.status(404).json({ error: 'Track not found.' });
      return res.json({ title: item.trackName || '', artist: item.artistName || '', image: item.artworkUrl100?.replace('100x100', '300x300') || null, source: 'apple', searchString: (item.trackName || '') + ' – ' + (item.artistName || '') });
    } catch (e) { return res.status(502).json({ error: 'Parse error.' }); }
  }

  return res.status(400).json({ error: 'Link not recognised. Paste a Spotify, YouTube, or Apple Music link.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// GENRE PIPELINE — no seed song, pure genre + filters → Groq → cross-check
// ═══════════════════════════════════════════════════════════════════════════════
async function genrePipeline(genre, subgenre, era, energy, popFilter, isPro) {
  const TARGET   = isPro ? 15 : 10;
  const verified = [];
  const cacheKey = genre + (subgenre || '') + era + energy;
  const recentExcl = getRecentExclusions(cacheKey);
  const excluded = [...recentExcl];
  if (recentExcl.length > 0) console.log('[genre] excluding', recentExcl.length, 'recent results');

  // Build a rich genre prompt — no Spotify seed, genre is the anchor
  const eraMap = { '70s':'the 1970s','80s':'the 1980s','90s':'the 1990s','2000s':'the 2000s','2010s':'the 2010s','2020s':'the 2020s' };
  const energyDescriptions = {
    chill: 'low energy, mellow, laid-back — nothing intense or hype',
    mid:   'moderate energy',
    hype:  'high energy, upbeat, intense — nothing slow'
  };

  const eraNote    = era    !== 'any' ? ' from ' + (eraMap[era] || era) : '';
  const energyNote = energy !== 'any' ? ', ' + (energyDescriptions[energy] || energy) : '';
  const subNote    = subgenre ? ' (' + subgenre + ')' : '';
  const searchLabel = genre + subNote + eraNote + (energy !== 'any' ? ', ' + energy + ' energy' : '');

  const systemPrompt =
    'You are a music recommendation engine. ' +
    'Find real, lesser-known tracks within a specific genre. ' +
    'RULES: (1) Stay strictly within the genre requested — no genre mixing. ' +
    '(2) Every song must exist on Spotify today. ' +
    '(3) Prioritise underground and emerging artists — avoid obvious mainstream picks. ' +
    '(4) Respond with valid JSON only.';

  for (let round = 1; round <= 3 && verified.length < TARGET; round++) {
    const needed   = TARGET - verified.length;
    const nl       = '\n';
    const exclNote = excluded.length
      ? nl + 'Do NOT include: ' + excluded.map(function(e){ return '"' + e.title + '" by ' + e.artist; }).join(', ') + '.'
      : '';
    const proNote  = isPro ? nl + 'Pro: extra variety, deeper underground cuts.' : '';

    const userPrompt =
      'Find ' + (needed + 14) + ' real ' + genre + subNote + ' songs' + eraNote + energyNote + '.' +
      exclNote + proNote +
      nl + '60%+ should be niche or underground artists. Use EXACT Spotify titles and artist names.' +
      nl + 'CRITICAL: Every song MUST be a real track currently on Spotify. Do NOT invent titles. If unsure, skip it.' +
      nl + 'Return ONLY: {"recommendations":[{"title":"","artist":"","year":"","popularity":"underground|emerging|mainstream","match_attributes":[],"similarity_score":0.9,"why":"","genre_tags":[]}]}';

    let gr;
    try {
      gr = await groqFetch([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ], { temperature: 0.8, max_tokens: 2000 });
    } catch (e) {
      if (e.message === 'RATE_LIMIT') throw e;
      console.warn('[genre pipeline] Groq error:', e.message);
      break;
    }

    const cands = (gr?.recommendations || []).slice(0, needed + 14);
    excluded.push(...cands.map(r => ({ title: r.title, artist: r.artist })));

    let passed = await batchCrossCheck(cands);

    // Pop filter — only apply if it leaves enough
    if (popFilter && popFilter !== 'any') {
      const tf = passed.filter(r => r.streamTier === popFilter);
      if (tf.length >= 5) passed = tf;
    }

    console.log('[genre pipeline] round', round + ':', passed.length + '/' + cands.length, 'passed');
    verified.push(...passed.slice(0, needed));
  }

  if (verified.length > 0) saveRecentResults(cacheKey, verified);

  return {
    genreSearch: true,
    genre:       searchLabel,
    recommendations: verified
  };
}

app.post('/api/genre', authMiddleware, async (req, res) => {
  try {
    const { genre, subgenre } = req.body || {};
    if (!genre || typeof genre !== 'string')
      return res.status(400).json({ error: 'Please select a genre.' });

    const ALLOWED_ERAS   = ['70s','80s','90s','2000s','2010s','2020s','any'];
    const ALLOWED_ENERGY = ['chill','mid','hype','any'];
    const ALLOWED_POP    = ['underrated','known','well-known','any'];
    const era       = ALLOWED_ERAS.includes(req.body.era)       ? req.body.era       : 'any';
    const energy    = ALLOWED_ENERGY.includes(req.body.energy)  ? req.body.energy    : 'any';
    const popFilter = ALLOWED_POP.includes(req.body.popFilter)  ? req.body.popFilter : 'any';

    const result = await genrePipeline(genre, subgenre || '', era, energy, popFilter, req.isPro || false);
    if (!result.recommendations?.length)
      return res.status(502).json({ error: 'Could not find verified tracks — try different filters.' });

    return res.json(result);
  } catch (err) {
    console.error('[/api/genre]', err.message);
    if (err.message === 'RATE_LIMIT') return res.status(429).json({ error: 'AI busy — try again shortly.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

app.post('/api/discover', authMiddleware, async (req, res) => {
  try {
    const { song, attributes } = req.body || {};
    if (!song || typeof song !== 'string' || song.trim().length < 2)
      return res.status(400).json({ error: 'Please provide a song name.' });
    const ALLOWED = ['tempo', 'melody', 'rhythm', 'lyrics'];
    const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
    if (!attrs.length) return res.status(400).json({ error: 'Select at least one attribute.' });

    const ALLOWED_ERAS    = ['70s','80s','90s','2000s','2010s','2020s','any'];
    const ALLOWED_ENERGY  = ['chill','mid','hype','any'];
    const ALLOWED_POP     = ['underrated','known','well-known','any'];
    const era       = ALLOWED_ERAS.includes(req.body.era)       ? req.body.era       : 'any';
    const energy    = ALLOWED_ENERGY.includes(req.body.energy)  ? req.body.energy    : 'any';
    const popFilter = ALLOWED_POP.includes(req.body.popFilter)  ? req.body.popFilter : 'any';

    const result = await discoverPipeline(song.trim(), attrs.join(', '), req.isPro, era, energy, popFilter);
    if (!result.recommendations?.length)
      return res.status(502).json({ error: 'Could not find verified recommendations — try a different song.' });

    return res.json(result);
  } catch (err) {
    console.error('[/api/discover]', err.message);
    if (err.message === 'RATE_LIMIT') return res.status(429).json({ error: 'AI busy — try again shortly.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

app.post('/api/rate', authMiddleware, async (req, res) => {
  try {
    const { searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating } = req.body || {};
    if (!searchSong || !recTitle || !recArtist || ![1,-1].includes(Number(rating)))
      return res.status(400).json({ error: 'Invalid rating data.' });
    await saveRating({ userId: req.user?.id || null, searchSong, recTitle, recArtist, genreTags, matchAttrs, popularity, rating: Number(rating) });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: 'Could not save rating.' }); }
});

app.get('/api/stats', async (req, res) => {
  try { return res.json(await getStats() || { total: 0 }); }
  catch (e) { return res.json({ total: 0 }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status:'ok', groq:!!process.env.GROQ_API_KEY, spotify:!!(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET), youtube:!!process.env.YOUTUBE_API_KEY, supabase:supaEnabled, timestamp:new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEO — robots.txt, sitemap.xml, og-image
// ═══════════════════════════════════════════════════════════════════════════════
const SITE_URL = 'https://unearthed.up.railway.app';

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /api/\n\n' +
    'Sitemap: ' + SITE_URL + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  const now = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url>\n' +
    '    <loc>' + SITE_URL + '</loc>\n' +
    '    <lastmod>' + now + '</lastmod>\n' +
    '    <changefreq>weekly</changefreq>\n' +
    '    <priority>1.0</priority>\n' +
    '  </url>\n' +
    '</urlset>\n'
  );
});

// OG image — serve static SVG (works on most platforms)
app.get('/og-image.png', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/og-image.svg'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎵  Unearthed');
  console.log('    Port:    ', PORT);
  console.log('    Groq:    ', process.env.GROQ_API_KEY          ? '✓' : '✗ MISSING');
  console.log('    Spotify: ', process.env.SPOTIFY_CLIENT_ID     ? '✓' : '✗ disabled');
  console.log('    YouTube: ', process.env.YOUTUBE_API_KEY       ? '✓' : '✗ disabled');
  console.log('    Supabase:', supaEnabled                       ? '✓' : '✗ ratings disabled');
  console.log('    Last.fm: ', process.env.LASTFM_API_KEY        ? '✓' : '✗ disabled\n');

  const publicURL =
    process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN :
    process.env.RENDER_EXTERNAL_URL   ? process.env.RENDER_EXTERNAL_URL : null;
  if (publicURL) setInterval(() => safeFetch(publicURL + '/api/health').catch(()=>{}), 14*60*1000);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM — closing');
  server.close(() => { console.log('[shutdown] done'); process.exit(0); });
});
