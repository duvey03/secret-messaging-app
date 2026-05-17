# Secret Messaging App

A boss-key chat client. Looks like ChatGPT, actually messages your coworkers.

Disguised as the ChatGPT web app. The model picker secretly routes messages to
different Telegram recipients. Real conversations are encrypted at rest and only
visible while you hold a hidden mouse gesture. Cover mode shows a plausible feed
of scripted "AI" responses to anyone glancing at your screen.

Built as a static frontend (GitHub Pages) + Cloudflare Worker + Telegram Bot
API. All on free tiers. Total cost: $0.

## Live demo

[duvey03.github.io/secret-messaging-app](https://duvey03.github.io/secret-messaging-app/)

The live demo runs in mock mode. You can fully exercise unlock, send, and reply
flows without any backend. Real sends are simulated and fake replies arrive
after 1-5 seconds.

## Try it locally

```bash
git clone git@github.com:duvey03/secret-messaging-app.git
cd secret-messaging-app
python3 run.py
```

Open `http://localhost:8080`. The app loads in cover mode.

### The unlock dance

1. Type anything in the composer. You get a scripted response from the 50-entry
   cover corpus, streamed character-by-character to match ChatGPT's typing
   animation.
2. Press the Konami code with the tab focused:
   `Up Up Down Down Left Right Left Right B A`.
3. A "Custom Instructions" modal opens. This is the PIN entry, themed to match
   ChatGPT's real settings dialog. Type any password (first time creates the
   PIN; subsequent unlocks require the same one). Enter to save.
4. The app is unlocked, but cover view is still showing.
5. Hover the **Share button** in the top-right of the page. Real
   conversations appear. Move the cursor away and cover returns within
   180ms. The Share button is the unlock-hold target; the Send button and
   Model picker are also safe zones so you can click them mid-action
   without flicker.
6. While hovering, type a message, press Enter. Mock send. Reply arrives in
   1-5 seconds.
7. Triple-tap Escape, or Alt-Tab away from the window. Instant panic lock.
   Decryption key is wiped from memory; PIN required again to unlock.

## How it works

```
Browser (GitHub Pages, static)
  Cover view (default)            Scripted Q&A from corpus
  Konami code + PIN to unlock     PBKDF2 + AES-GCM (Web Crypto)
  Hotspot hover to reveal         Mouse-position state machine
        |
        | HTTPS, Bearer auth
        v
Cloudflare Worker (free tier)
  POST /send                      Proxies to Telegram sendMessage
  POST /webhook/telegram/...      Receives Telegram bot updates
  GET  /inbox?since=...           Polled by frontend every 5s
  KV namespace                    inbox messages + chat_id mapping
        |
        | HTTPS, bot token
        v
Telegram Bot API
        |
        v
Recipients (real Telegram chats with your bot)
```

Each "AI model" in the picker maps to one recipient. Selecting "GPT-4o" sends
to Alex, "GPT-4o mini" to Sam, and so on. Recipients see a normal Telegram
message from the bot and reply normally. Replies route back into the app as
"AI responses" in the matching model's chat thread.

## Features

- Pixel-close visual clone of ChatGPT (dark theme).
- 50 scripted Q&A pairs in the cover corpus, themed around a nerdy
  14-year-old violinist (configurable). Keyword-matched to user prompts.
- Continuous-unlock hotspot bound to the Share button: real chat is
  visible only while the cursor is on Share (or another safe-zone
  element). Pause the gesture and the screen relocks.
- Konami code + PIN to access the encrypted store.
- AES-GCM at-rest encryption, PBKDF2-derived 256-bit key (250k iterations).
  DevTools shows only ciphertext blobs.
- Panic key (triple-Escape), tab-blur lock, page-reload lock. All wipe the
  decryption key from JS memory.
- Telegram Bot API for both directions. One-time `/start` setup per
  recipient, no expiry, no rejoin requirement.
- Mock mode for development without any backend.

## Project layout

```
index.html                Static entry, deployable to GitHub Pages
styles/main.css           ChatGPT-clone styles
scripts/
  app.js                  Main controller + state machine
  konami.js               Konami code detection
  hotspot.js              Safe-zone hover detection (with debounce)
  crypto.js               PBKDF2 + AES-GCM wrappers
  cover-engine.js         Scripted response matching + streaming
  api.js                  Worker client with built-in mock mode
data/cover-corpus.json    50 pre-written Q&A pairs
worker/
  src/index.js            Cloudflare Worker (Telegram bridge)
  wrangler.toml           Worker config
  package.json
SPEC.md                   Full design document
README.md                 This file
run.py                    Local dev server (Python 3, stdlib only)
```

## Setting up the Telegram backend

Mock mode is on by default. When you're ready for real delivery:

### 1. Create a bot

Open Telegram, message `@BotFather`, send `/newbot`. Pick a name (something
boring works best, e.g. "Notes Helper") and a username ending in `_bot`.
Copy the token.

### 2. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login

# Create a KV namespace and paste the returned id into wrangler.toml
npx wrangler kv namespace create KV

# Three secrets, prompted one at a time:
npx wrangler secret put TELEGRAM_BOT_TOKEN        # paste BotFather token
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
npx wrangler secret put SHARED_SECRET             # any long random string

npx wrangler deploy
```

Note the Worker URL it prints, e.g. `https://secret-messaging-worker.your-account.workers.dev`.

### 3. Register the webhook with Telegram

```bash
curl -X POST https://YOUR-WORKER.workers.dev/admin/setwebhook \
  -H "Authorization: Bearer YOUR_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"worker_url":"https://YOUR-WORKER.workers.dev"}'
```

You should see `{"ok": true, "telegram": {"ok": true, ...}}`.

### 4. Onboard recipients

Tell each recipient your bot's `@username` and which slot to claim. Slots are
arbitrary strings; defaults are `alex`, `sam`, `jordan`, `taylor`, `morgan`.

Each recipient:

1. Opens Telegram, searches for `@your_bot_name`.
2. Sends `/start alex` (or whichever slot you assigned them).
3. Bot confirms the link.

Verify joins:

```bash
curl https://YOUR-WORKER.workers.dev/admin/joins \
  -H "Authorization: Bearer YOUR_SHARED_SECRET"
```

### 5. Point the frontend at the Worker

Edit `scripts/api.js`:

```js
export const WORKER_URL = 'https://YOUR-WORKER.workers.dev';
export const SHARED_SECRET = 'YOUR_SHARED_SECRET';

let USE_MOCK = false;   // flip from true to false
```

Commit and push. GitHub Pages rebuilds in 30-90s.

## Customization

- **Cover corpus:** `data/cover-corpus.json`. Each entry has `keywords`,
  `title`, `user_prompt`, and `response`. The engine matches by keyword
  overlap; nonsense input falls back to a random entry. Swap the theme to
  whatever fits your actual context (work prompts, language learning, etc.).
- **Model names and recipient slots:** `DEFAULT_MODELS_REAL` in
  `scripts/app.js`. The display name (`GPT-4o` etc.) and the `recipient_id`
  slot are independent; you can keep ChatGPT-looking model names while the
  underlying slots are real coworker handles.
- **Unlock gesture:** `SEQUENCE` in `scripts/konami.js`.
- **Hotspot target:** the safe-zone elements are configured in
  `wireEvents()` in `scripts/app.js` (default: Share button, Send button,
  Model picker). Swap to other elements to change which UI element triggers
  unlock-visible.
- **PIN derivation strength:** `PBKDF2_ITERATIONS` in `scripts/crypto.js`.

## What this does NOT protect against

This is a shoulder-surfing defense, not an opsec tool.

Designed for:

- A boss glancing at your screen from across the room.
- A coworker leaning over your shoulder for a few seconds.
- A reviewer opening DevTools and reading `localStorage` (sees only
  ciphertext).
- A screenshot capturing the current view (captures only cover).

NOT designed for:

- A determined IT admin with browser-level inspection or full network logs.
  They will see outbound HTTPS to `*.workers.dev` and can reverse-engineer
  the page source.
- Telegram-side discovery. Messages arrive on recipients' real Telegram
  accounts; anyone with their phone unlocked can read the conversation.
- Clipboard or screen-recording malware.
- Routing personal traffic through your employer's network. They can in
  principle inspect or log it.

## Debug from the devtools console

```js
__sma.state()                // 'cover' | 'prompt' | 'hidden' | 'visible'
__sma.isMock()
__sma.setUseMock(false)      // switch to the real Worker
__sma.panic()                // force lock

// Wipe everything and start fresh
['sma_cover','sma_real_blob','sma_real_iv','sma_salt']
  .forEach(k => localStorage.removeItem(k));
location.reload();
```

## Notes

- The app wipes the decryption key on tab blur, page reload, and triple-Esc.
  You will need to re-enter the PIN each time. This is by design.
- Mock-mode replies live in JS memory only and disappear on reload.
- Real messages are encrypted at rest with AES-GCM. Storage is
  per-browser-per-origin.
- The Worker's inbox entries auto-expire after 7 days via KV TTL.
- The Worker's `SHARED_SECRET` lives in the static JS bundle when not in
  mock mode. It prevents casual abuse of the Worker but is not a real
  authentication mechanism. Don't rely on it.

## Trademarks

This project visually clones the ChatGPT web app for the "boss key" effect.
"ChatGPT" and the OpenAI logo are trademarks of OpenAI. This is a personal
project not affiliated with or endorsed by OpenAI. Do not deploy it under a
misleading name or pass it off as an official ChatGPT product.

## See also

- [SPEC.md](SPEC.md) for the full design document: threat model, state
  machine, data schemas, build plan, and open issues.

## License

MIT.
