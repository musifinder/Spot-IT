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

// ── Extract JSON robustly from messy AI output ────────────────────────────────
function extractJSON(raw) {
  // Strip markdown fences
  let text = raw.replace(/```json|```/g, '').trim();

  // Try parsing directly first
  try { return JSON.parse(text); } catch (_) {}

  // Find the outermost { ... } block
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');

  text = text.slice(start, end + 1);
  try { return JSON.parse(text); } catch (_) {}

  // Last resort: strip control characters and try again
  text = text.replace(/[\x00-\x1F\x7F]/g, ' ');
  return JSON.parse(text);
}

// ── /api/discover ─────────────────────────────────────────────────────────────
app.post('/api/discover', async (req, res) => {
  const { song, attributes } = req.body;

  if (!song || typeof song !== 'string' || song.trim().length < 2)
    return res.status(400).json({ error: 'Please provide a song name.' });

  const ALLOWED = ['tempo', 'melody', 'rhythm', 'lyrics', 'vibe', 'production'];
  const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
  if (!attrs.length)
    return res.status(400).json({ error: 'Select at least one attribute.' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY)
    return res.status(500).json({ error: 'Server misconfiguration — contact the admin.' });

  const attrList = attrs.join(', ');

  const systemPrompt = `You are a music recommendation engine. You MUST respond with valid JSON only — absolutely no markdown, no code fences, no explanation, no text before or after the JSON object. Any text outside the JSON will break the application.`;

  const userPrompt = `Find 8 songs similar to "${song.trim()}" based on: ${attrList}.

Bias toward underrated/underground artists (at least 5 of 8 should be lesser-known).

Respond with ONLY this JSON object, nothing else before or after it:
{"song":{"title":"string","artist":"string","attributes":{"bpm":"string","key":"string","energy":0.7,"danceability":0.6,"mood":"string","genre_tags":["string"]}},"recommendations":[{"title":"string","artist":"string","year":"string","popularity":"underground","match_attributes":["string"],"similarity_score":0.9,"why":"string","genre_tags":["string"]}]}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        temperature: 0.5,
        max_tokens:  2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ]
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      console.error('Groq error:', err);
      if (groqRes.status === 429)
        return res.status(429).json({ error: 'AI service busy — try again in a moment.' });
      return res.status(502).json({ error: 'AI service error — please try again.' });
    }

    const data  = await groqRes.json();
    const raw   = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = extractJSON(raw);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw output:', raw.slice(0, 500));
      return res.status(502).json({ error: 'AI returned malformed data — please try again.' });
    }

    // Validate minimum structure
    if (!parsed.song || !Array.isArray(parsed.recommendations)) {
      console.error('Unexpected structure:', JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({ error: 'AI returned unexpected structure — please try again.' });
    }

    return res.json(parsed);

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵  Music Discovery Engine running on port ${PORT}`);
  console.log(`    Groq key: ${process.env.GROQ_API_KEY ? 'YES ✓' : 'NO ✗'}\n`);

  const publicURL =
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` :
    process.env.RENDER_EXTERNAL_URL   ? process.env.RENDER_EXTERNAL_URL : null;

  if (publicURL) {
    setInterval(async () => {
      try { await fetch(`${publicURL}/api/health`); }
      catch (e) { console.warn(`[keep-alive] failed: ${e.message}`); }
    }, 14 * 60 * 1000);
  }
});
