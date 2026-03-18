# 🎵 Music Discovery Engine

> Find your hidden bangers. Free for everyone. No account needed.

One universal Groq API key on the server — users just open the URL and search.

---

## Deploy in 5 minutes (free forever)

### Step 1 — Get your free Groq key
1. Go to **console.groq.com** → sign up (no card needed)
2. Click **API Keys** → **Create API Key**
3. Copy it — looks like `gsk_...`

### Step 2 — Put this on GitHub
1. Go to **github.com** → click **+** → **New repository**
2. Name it `music-discovery`, keep it public
3. Upload all these files (drag and drop works)
4. Click **Commit changes**

### Step 3 — Deploy on Railway (free)
1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo**
2. Select your `music-discovery` repo
3. Click **Variables** tab → **Add Variable**:
   ```
   Name:  GROQ_API_KEY
   Value: gsk_your_actual_key_here
   ```
4. Railway auto-deploys. Takes about 60 seconds.
5. Click **Settings** → **Networking** → **Generate Domain**
6. Share that URL with the world. Anyone can use it, no setup needed.

---

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env — paste your Groq key
npm start
# Open http://localhost:3000
```

---

## Project structure

```
music-discovery/
├── server/index.js      ← Node/Express backend + Groq proxy
├── public/index.html    ← Full frontend (no framework)
├── .env.example         ← Copy to .env, add your key
├── package.json
└── railway.toml         ← Auto-deploy config
```

## How it works

```
User's browser  →  your server (key hidden)  →  Groq AI  →  results
```

The Groq key never touches the browser. Rate limiting built in (20 searches per IP per 10 min) to protect your free quota.

---

## Groq free tier limits
- **6,000 requests/day** on free plan
- **131,072 tokens/minute**
- No credit card, no expiry

More than enough for a side project. If you blow past it, upgrading is cheap.
