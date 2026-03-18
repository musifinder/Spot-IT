require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "fonts.gstatic.com"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", "data:"],
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// ── Rate limiting: 20 searches per IP per 10 minutes ─────────────────────────
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches — wait a few minutes and try again.' }
});
app.use('/api/', limiter);

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── /api/discover ─────────────────────────────────────────────────────────────
app.post('/api/discover', async (req, res) => {
  const { song, attributes } = req.body;

  // Validate input
  if (!song || typeof song !== 'string' || song.trim().length < 2)
    return res.status(400).json({ error: 'Please provide a song name.' });

  const ALLOWED = ['tempo','melody','rhythm','lyrics','vibe','production'];
  const attrs   = (attributes || []).filter(a => ALLOWED.includes(a));
  if (!attrs.length)
    return res.status(400).json({ error: 'Select at least one attribute.' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY)
    return res.status(500).json({ error: 'Server misconfiguration — contact the admin.' });

  const attrList = attrs.join(', ');

  const systemPrompt = `You are an expert music analyst and recommendation engine with encyclopedic knowledge of music theory, production techniques, lyrical styles, and artists from the most obscure underground to mainstream across every genre and era. Always respond with valid JSON only — no markdown, no backticks, no preamble.`;

  const userPrompt = `Analyze the song "${song.trim()}" and find 8 similar songs based on these attributes: ${attrList}.

CRITICAL: At least 5 of the 8 must be lesser-known, underrated, or underground artists — hidden gems most people haven't heard. Include diverse eras and genres.

Return ONLY raw JSON, no fences, no extra text:
{"song":{"title":"exact title","artist":"artist name","attributes":{"bpm":"BPM estimate","key":"musical key","energy":0.7,"danceability":0.6,"mood":"mood description","genre_tags":["tag1","tag2"]}},"recommendations":[{"title":"song title","artist":"artist name","year":"year","popularity":"underground|emerging|mainstream","match_attributes":["attr1","attr2"],"similarity_score":0.92,"why":"2 sentences on the specific musical elements that make this a match","genre_tags":["tag1","tag2"]}]}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens:  2000,
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
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.json(parsed);

  } catch (err) {
    console.error('Server error:', err.message);
    if (err instanceof SyntaxError)
      return res.status(502).json({ error: 'AI returned unexpected data — try again.' });
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Catch-all → frontend ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎵  Music Discovery Engine`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Groq key loaded: ${process.env.GROQ_API_KEY ? 'YES ✓' : 'NO ✗ — add GROQ_API_KEY to .env'}\n`);
});
