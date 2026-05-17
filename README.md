# Secret Messaging App

A web app disguised as ChatGPT. Real conversations are routed through Telegram
bots and gated behind a hidden gesture sequence. See `SPEC.md` for the full
design.

---

## What's in the box

```
index.html                    Static entry, deployable to GitHub Pages
styles/main.css               ChatGPT-clone styling
scripts/
  app.js                      Main controller + state machine
  konami.js                   Konami code detector
  hotspot.js                  Safe-zone hover detector
  crypto.js                   PBKDF2 + AES-GCM wrappers
  cover-engine.js             Scripted cover-response engine
  api.js                      Worker client (with mock mode)
data/cover-corpus.json        50 pre-written "AI" Q&A pairs
worker/
  src/index.js                Cloudflare Worker (Telegram bridge)
  wrangler.toml               Worker config
  package.json
SPEC.md                       Full design document
```

---

## Quick local test (no Telegram, no Worker)

The frontend has a built-in mock mode so you can test everything except real
network delivery.

```bash
cd /mnt/c/SecretMessagingApp
python3 -m http.server 8080
```

Open `http://localhost:8080` in a browser. Then:

1. **Cover mode** is the default. Type anything in the composer and you'll get
   a scripted response that looks like ChatGPT. Click around the sidebar — the
   chats there are seeded from the corpus.

2. **Unlock**: press the Konami code with the browser tab focused:
   `Up Up Down Down Left Right Left Right B A`. A "Custom Instructions" modal
   appears (this is the PIN entry, themed to look like ChatGPT settings).

3. **First-time PIN**: type any password (e.g. `test1234`) and click Save.
   This creates an empty encrypted store. Subsequent unlocks require the same
   password.

4. **Hover the hotspot**: there's an invisible 84x84 region just left of the
   composer. While your cursor is inside it (or hovering the send button or
   model picker), real conversations are visible. Move out of the safe zone
   and cover view returns within ~180ms.

5. **Send a real message** (in unlocked-visible state): pick a model from the
   dropdown (now showing real recipient names), type in the composer, press
   Enter. The message is logged to console and a fake reply arrives after
   1-5 seconds (mock mode).

6. **Panic**: triple-tap Escape, or switch tabs / Alt-Tab — instant lock.
   Decryption key wipes from memory; you'll need PIN + Konami again.

To see the hotspot during development, uncomment the debug rule in
`styles/main.css` (search for "DEBUG: uncomment").

---

## Deploying the frontend to GitHub Pages

1. Create a private repo with this folder's contents.
2. In the repo settings: Pages -> Source: deploy from branch -> main / root.
3. Wait ~1 min. The site goes live at `https://<your-username>.github.io/<repo-name>`.

Use a non-obvious repo name like `notes` or `dev-tools`.

---

## Setting up the Telegram backend (when you're ready to leave mock mode)

### 1. Create the bot

1. Open Telegram and chat with `@BotFather`.
2. Send `/newbot`. Pick a name (e.g. "Notes Helper") and a username ending in `_bot`.
3. Copy the bot token BotFather gives you. You'll need it as a Worker secret.
4. (Optional) `/setdescription` and `/setabouttext` to make the bot look innocuous
   if a recipient ever clicks the bot's profile.

### 2. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login

# Create a KV namespace and paste the returned id into wrangler.toml
npx wrangler kv namespace create KV

# Set secrets (you'll be prompted for each value)
npx wrangler secret put TELEGRAM_BOT_TOKEN        # paste BotFather token
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
npx wrangler secret put SHARED_SECRET             # any long random string

npx wrangler deploy
```

Note the Worker URL it prints, e.g. `https://secret-messaging-worker.youraccount.workers.dev`.

### 3. Register the Telegram webhook

```bash
curl -X POST https://YOUR-WORKER.workers.dev/admin/setwebhook \
  -H "Authorization: Bearer YOUR_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"worker_url":"https://YOUR-WORKER.workers.dev"}'
```

You should see `{ "ok": true, "telegram": { "ok": true, ... } }`.

### 4. Onboard recipients

Tell each coworker the bot's `@username` and which slot they should claim. Slots
match the model IDs in `scripts/app.js`: `alex`, `sam`, `jordan`, `taylor`,
`morgan` (rename them as you like in `DEFAULT_MODELS_REAL`).

Each coworker:

1. Opens Telegram, searches for `@your_bot_name`.
2. Sends `/start alex` (or their assigned slot).
3. The bot replies confirming the link.

You can verify joins by hitting:

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

Re-deploy GitHub Pages (push to main).

---

## Customization

- **Cover content**: edit `data/cover-corpus.json`. Each entry needs
  `keywords`, `title`, `user_prompt`, and `response`. The engine matches by
  keyword overlap, falling back to a random entry if nothing scores.
- **Model names + recipient slots**: edit `DEFAULT_MODELS_REAL` in
  `scripts/app.js`. Slot names are arbitrary strings used as `recipient_id`
  in the Worker; they must match what users `/start <slot>` with.
- **Unlock gesture**: change `SEQUENCE` in `scripts/konami.js`.
- **Hotspot position**: change the `.hotspot` rule in `styles/main.css`.
- **PIN strength**: bump `PBKDF2_ITERATIONS` in `scripts/crypto.js` for
  longer derivation time (slower unlock).

---

## Operational notes

- The app **wipes the decryption key on tab blur, page reload, and triple-Esc**.
  You will need to re-enter the PIN each time. This is by design.
- Mock-mode replies are stored in JS memory only and disappear on reload.
- Real messages are encrypted at rest with AES-GCM, key derived via PBKDF2-SHA256
  with 250k iterations. Storage is per-browser-per-origin.
- The Worker's inbox entries auto-expire after 7 days via KV TTL.
- Recipients reply through normal Telegram. Anyone with their phone unlocked
  can read the conversation.

---

## Risks (read this)

- The frontend visually clones ChatGPT. Don't deploy it under a name that
  could mislead a stranger; keep the repo private.
- Routing personal traffic through your employer's network is something they
  can in principle inspect. This app defends against a glance, not a network
  audit.
- If a coworker discovers the bot in their Telegram list, the cover is partly
  broken. Pick a boring bot name and tell them to mute/archive the chat after
  the conversation cools down.

---

## Debug

In the browser console:

```js
__sma.state()             // current state: 'cover' | 'prompt' | 'hidden' | 'visible'
__sma.isMock()            // true while in mock mode
__sma.setUseMock(false)   // switch to real Worker
__sma.panic()             // force lock
```

To inspect localStorage:

```js
localStorage.getItem('sma_cover')        // plaintext cover chats
localStorage.getItem('sma_real_blob')    // ciphertext (base64)
localStorage.getItem('sma_real_iv')      // IV (base64)
localStorage.getItem('sma_salt')         // PBKDF2 salt (base64)
```

To wipe everything and start fresh:

```js
['sma_cover','sma_real_blob','sma_real_iv','sma_salt'].forEach(k => localStorage.removeItem(k))
location.reload()
```
