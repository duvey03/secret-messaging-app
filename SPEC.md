# Secret Messaging App - MVP Spec

A static web app disguised as ChatGPT. Coworkers select different "AI models" in
the model picker; each model is wired to a different Telegram recipient. Real
conversations are encrypted at rest and only visible while a hidden gesture is
held. Cover mode shows pre-written scripted "AI" responses so anyone glancing at
the screen sees a normal ChatGPT session.

**MVP stack: GitHub Pages (frontend) + Cloudflare Workers free tier (backend) +
Telegram Bot API (send + receive). Total cost: $0. Setup is one-time per
recipient with no expiry.**

---

## 1. Threat Model

Designed for:

- [OK] A boss or coworker glancing at your screen from across the room.
- [OK] A boss leaning over your shoulder for 5-10 seconds.
- [OK] A reviewer opening DevTools and reading `localStorage` (sees only ciphertext).
- [OK] A screenshot tool that captures the current view (captures only cover).

Not designed for:

- [ERROR] A determined IT admin with browser-level inspection, full network logs,
  or endpoint surveillance. They will see outbound HTTPS to `*.workers.dev`
  (and can reverse-engineer the page source).
- [ERROR] Telegram-side discovery. Messages arrive on recipients' real Telegram
  accounts; anyone who picks up their phone sees the conversation.
- [ERROR] Clipboard / screen-recording malware.

Implication: this is a "shoulder-surfing" defense, not an opsec tool. Treat it
that way.

---

## 2. End-to-End User Flow

### First-time setup (truly one-time per recipient, no expiry)

1. Sender (you) creates a Telegram bot via `@BotFather` -- chat with that
   bot, run `/newbot`, name it something innocuous (e.g. "Notes Helper"),
   receive a bot token.
2. Each recipient installs Telegram (if they don't have it) and sends
   `/start` to your bot once. The bot's webhook (running on Cloudflare
   Workers) captures their `chat_id` and stores it in KV against their
   model assignment.
3. Sender maps each `chat_id` to a model name in the app's encrypted
   settings (e.g. `gpt-4o` -> Alex's `chat_id`).
4. User chooses a PIN. PBKDF2 derives the AES key.

After this, recipients never need to do anything again. No re-joins, no
expirations, no business verification.

### Daily use

```
1. Open app -> ChatGPT clone, no sign of hidden features.
   Shows ~50 scripted "previous chats" in sidebar.

2. Type a message in cover mode -> scripted response appears
   after a typing-animation delay. Nothing leaves the browser.

3. Konami code:  Up Up Down Down Left Right Left Right B A
   -> a tiny "Custom Instructions" modal opens (the PIN entry,
      themed as a ChatGPT settings field).

4. Enter PIN -> real conversations decrypted into JS memory.
   View does NOT change yet. Cover view still shown.

5. Park mouse cursor in the hidden hotspot
   (invisible 80x80 region just left of the input box).
   -> real conversation appears in the message area.
      Sidebar swaps to real chat titles.
      Model dropdown swaps to recipient names.

6. While hovering, type a message and press Enter.
   -> sent to the selected model's recipient via CallMeBot.
      Appears in real chat as a "user" message.

7. Move cursor out of hotspot -> instant lock view.
   Cover sidebar + cover messages reappear in <100ms.
   Decrypted data stays in memory; re-hover restores instantly.

8. Page reload, tab blur, or panic key (Esc x3)
   -> wipes decrypted data from memory.
   Requires Konami + PIN again to re-unlock.
```

### Recipient receives

- Recipient's Telegram pings with a message from your bot.
- They reply normally in the same Telegram chat.
- Telegram posts the inbound update to the Cloudflare Worker webhook. The
  Worker stores it in KV under the recipient's `chat_id`.
- The app polls the Worker (or uses SSE) and shows the reply as a message
  from that "AI model" the next time the user is hovering the hotspot.

---

## 3. Architecture

```
                   GitHub Pages (static)
                   +-----------------------+
                   |  ChatGPT clone (HTML/ |
                   |  CSS/JS). State mgmt, |
                   |  Web Crypto, hotspot  |
                   |  detection, Konami.   |
                   +-----+------------+----+
                         |            |
                fetch()  |            | poll / SSE
                         v            v
                   +-----+------------+----+
                   |  Cloudflare Worker    |
                   |  - POST /send         |
                   |  - POST /webhook      |
                   |  - GET  /inbox        |
                   |  KV: inbox messages   |
                   +-----+------------+----+
                         |            ^
                   send  |            | inbound webhook
                         v            |
                       +-+------------+-+
                       |  Telegram Bot   |
                       |      API        |
                       +--------+--------+
                                ^
                                | both directions
                                v
                      +---------+-----------+
                      |  Recipient Telegram |
                      +---------------------+
```

---

## 4. Frontend (GitHub Pages)

### 4.1 Visual fidelity

Pixel-close clone of current ChatGPT:

- Color tokens: pull from chatgpt.com via DevTools (light + dark mode).
- Font stack: `Soehne, ui-sans-serif, system-ui, sans-serif` (Soehne is
  licensed; use fallback in MVP, optionally license later).
- Layout: collapsible left sidebar with "New chat" + chat history list,
  main pane with messages, bottom composer with model picker pill above it.
- Components to match precisely: model picker dropdown, message bubble
  styles (user vs. assistant), regenerate/copy/thumbs icons, typing dots
  animation.
- Logo: green "ChatGPT" wordmark with the OpenAI-style swirl. Use a CSS-only
  reproduction or an SVG. Do NOT distribute publicly to avoid trademark issues
  (Section 10).

### 4.2 State machine

```
States:
  COVER                  -- locked, fake data shown
  UNLOCK_PROMPT          -- Konami fired, PIN modal open
  UNLOCKED_HIDDEN        -- decrypted in memory, cursor outside hotspot
  UNLOCKED_VISIBLE       -- decrypted in memory, cursor inside hotspot

Transitions:
  COVER --(Konami code)--> UNLOCK_PROMPT
  UNLOCK_PROMPT --(PIN ok)--> UNLOCKED_HIDDEN
  UNLOCK_PROMPT --(PIN cancel)--> COVER
  UNLOCKED_HIDDEN --(cursor in hotspot)--> UNLOCKED_VISIBLE
  UNLOCKED_VISIBLE --(cursor leaves hotspot)--> UNLOCKED_HIDDEN
  ANY --(reload | tab blur | Esc Esc Esc)--> COVER
        (wipes plaintext from memory)
```

### 4.3 Hotspot detection

- Invisible 80x80 absolutely-positioned `<div>` at a fixed offset relative to
  the composer (e.g. 96px to the left of the input field).
- Listen for `mouseenter` / `mouseleave`.
- The send button (paper-plane icon) is part of the "safe zone" so the
  user can click send without relock flicker. Both elements share a single
  `data-safe-zone` attribute.
- Add a 150ms debounce on `mouseleave` to forgive jittery mouse movement.
- Mobile: not supported in MVP. Touch users can re-tap a hold-button instead
  (defer to v2).

### 4.4 Crypto

Use the Web Crypto API:

- Key derivation: `PBKDF2(pin, salt, 250_000 iters, SHA-256)` -> 256-bit AES key.
- Salt: random 16 bytes, stored in plaintext in localStorage on first PIN setup.
- Encryption: `AES-GCM` with random 12-byte IV per write.
- Storage layout (see Section 6).
- Key lives in JS memory in `UNLOCKED_*` states only. On lock-out:
  `cryptoKey = null`, `realChats = null`, `gc()`-friendly cleanup.

### 4.5 Konami detection

Standard pattern:

```js
const seq = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
             'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let i = 0;
window.addEventListener('keydown', e => {
  i = (e.key.toLowerCase() === seq[i].toLowerCase()) ? i + 1 : 0;
  if (i === seq.length) { i = 0; openPinModal(); }
});
```

PIN modal is themed as a "Custom Instructions" panel (matches ChatGPT's
existing UI), so even if it briefly appears in front of a coworker, it looks
like a legit settings dialog.

### 4.6 Cover-mode response engine

- 50 pre-written Q/A pairs in `cover-corpus.json` (you'll write the content).
- Theme: "nerdy 14-year-old who plays violin" -- questions about music theory,
  homework help, social anxiety, video games, violin practice, etc.
- Matching: when user types a prompt and sends in COVER state, the engine
  picks a response by simple keyword overlap, else random.
- Response is streamed character-by-character with a fake typing cursor to
  match ChatGPT's behavior.
- Format of corpus entries:

```json
[
  {
    "keywords": ["violin", "practice", "scales"],
    "prompt_match": "loose",
    "response": "Practicing scales feels boring but it's how you build..."
  },
  ...
]
```

---

## 5. Cloudflare Worker (Backend)

Free tier handles this comfortably (100k requests/day).

### 5.1 Endpoints

#### `POST /send`

Sender posts `{ recipient_id, message }` plus the shared-secret auth header.
Worker looks up the recipient's `chat_id` from KV, then POSTs to Telegram:

```
POST https://api.telegram.org/bot<BOT_TOKEN>/sendMessage
Content-Type: application/json

{ "chat_id": <chat_id>, "text": "<message>" }
```

Returns `{ ok: true, message_id: ... }` or `{ ok: false, error: "..." }`.

Why proxy from the Worker instead of calling Telegram directly from the
frontend? The bot token must never appear in JS source -- anyone with it can
send messages on your bot's behalf and read every inbound message.

#### `POST /webhook/telegram/<webhook-secret>`

Telegram POSTs updates here (we register the webhook URL via
`setWebhook` once at deploy time). The path includes a long random secret so
randos who guess our Worker URL can't forge inbound messages. Worker:

1. Verifies the `X-Telegram-Bot-Api-Secret-Token` header.
2. If the update is `/start`, captures the `chat_id` from `message.from.id`
   and writes to KV: `chat:<chat_id> -> { joined_at, model_id: null }`.
   Replies to the user with "You're linked. Tell <sender> your number is
   <chat_id>." (Or auto-assigns to a free slot.)
3. If the update is a regular message, looks up the `chat_id` to find the
   associated `recipient_id`, then writes to KV:
   `inbox:<recipient_id>:<timestamp> -> { body, ts }`.

#### `GET /inbox?since=<ts>`

Frontend polls every 5s while in `UNLOCKED_VISIBLE`. Returns all KV entries
with timestamps after `since`, across all recipients. Frontend merges into
the real chat history and re-encrypts to localStorage.

Optional v2: replace polling with SSE for instant delivery.

### 5.2 Configuration

Worker secrets (set via `wrangler secret put`):

- `TELEGRAM_BOT_TOKEN` -- from @BotFather, used for both sending and
  registering the webhook.
- `TELEGRAM_WEBHOOK_SECRET` -- long random string Telegram echoes back in
  the `X-Telegram-Bot-Api-Secret-Token` header so we can verify it's really
  from Telegram.
- `SHARED_SECRET` -- frontend sends this in an `Authorization` header so
  randos can't spam your `/send` from a discovered Worker URL.

Recipient `chat_id` -> model mappings live in Workers KV (set via the
`/start` flow), not in secrets, since they're discovered at recipient
onboarding time, not at deploy time.

### 5.3 Rate limits

- Telegram bots: 30 messages/second globally, ~1 per second to the same chat.
  Far more than this app will ever need.
- No 24-hour messaging windows, no message templates, no rejoin requirements.
- Telegram Bot API is officially free at any volume.

---

## 6. Data Model

### 6.1 localStorage schema

```json
{
  "salt": "<base64 16 bytes>",
  "cover": {
    "chats": [
      { "id": "c1", "title": "violin scales help",
        "messages": [{"role":"user","content":"..."}, ...] },
      ...
    ]
  },
  "real_blob": "<base64 AES-GCM ciphertext>",
  "real_iv":   "<base64 12 bytes>"
}
```

`real_blob` decrypts to:

```json
{
  "models": {
    "gpt-4o":      { "name": "GPT-4o",       "recipient_id": "alex",   "chat_id": 123456789 },
    "gpt-4o-mini": { "name": "GPT-4o mini",  "recipient_id": "sam",    "chat_id": 234567890 },
    "o1":          { "name": "o1",           "recipient_id": "jordan", "chat_id": 345678901 },
    "o1-mini":     { "name": "o1-mini",      "recipient_id": "taylor", "chat_id": 456789012 },
    "gpt-3.5":     { "name": "GPT-3.5",      "recipient_id": "morgan", "chat_id": 567890123 }
  },
  "chats": [
    { "id": "r1", "model_id": "gpt-4o",
      "messages": [
        {"role":"user","content":"lunch?","ts":1730000000},
        {"role":"assistant","content":"yeah noon","ts":1730000060}
      ]
    }
  ]
}
```

### 6.2 Workers KV schema

- `chat:<chat_id>` -> `{ "joined_at": <ts>, "recipient_id": "alex" | null }`
  Populated by the `/start` handler; `recipient_id` set by sender during
  model mapping.
- `inbox:<recipient_id>:<ts>` -> `{ "body": "...", "ts": 1730000060 }`
- TTL on inbox entries: 7 days (then cleaned up automatically).

---

## 7. Cover Content Spec

You'll write `cover-corpus.json` with 50 entries. Suggested mix:

- 12 violin/music (practice tips, theory, audition nerves, etudes)
- 10 school homework (algebra, history essays, lab reports)
- 8 video games (strategy, lore questions)
- 6 social/awkwardness (how to talk to crush, dealing with bullies)
- 6 misc nerd (anime recs, programming Hello World, chess openings)
- 8 generic "explain X" (osmosis, photosynthesis, the French Revolution)

Each entry: 100-400 words for the response, no markdown formatting that would
look unusual to a glance.

---

## 8. MVP Build Plan

### Phase 1 -- Pure cover (1-2 days)

- ChatGPT clone HTML/CSS.
- 50 scripted Q/A in `cover-corpus.json`.
- Cover-mode response engine with typing animation.
- Konami detection -> opens a non-functional PIN modal.
- Deploy to GitHub Pages. Verify it looks legit at a glance.

### Phase 2 -- Local crypto + unlock UX (1-2 days)

- PIN modal wired up: PBKDF2 -> AES-GCM.
- Hidden hotspot + state machine.
- Real chats stored encrypted, model->recipient mapping config UI.
- "Send" while unlocked-visible writes to local real history (no network yet).

### Phase 3 -- Two-way Telegram via bot (1 day)

- Create bot via @BotFather, get token.
- Cloudflare Worker: `/send`, `/webhook/telegram/<secret>`, `/inbox` endpoints.
- Register webhook via `setWebhook` once.
- Wire up frontend to POST sends and poll `/inbox`.
- Onboard one recipient (have them `/start` the bot once). Smoke-test both
  directions.

### Phase 4 -- Polish

- Esc-Esc-Esc panic key, tab-blur lock, decryption-key wipe.
- Sidebar real-chat titles, search, delete.
- Multi-device sync (out of scope for MVP, but document deferred design).

Total: ~4-7 working days for full MVP.

---

## 9. Open Issues / Decisions Still Needed

### Issue #1 -- Recipient onboarding flow

Each recipient installs Telegram (if needed) and sends `/start` to your
bot from their phone, one time. You'll need to share the bot's @username
with your coworkers somehow without leaving an obvious paper trail
(personal text, in person, or a written sticky note -- not work Slack).

Suggested bot name: something innocuous like `@notes_helper_bot` or
`@meeting_summary_bot` so even if a recipient's phone is glanced at, the
bot's name doesn't raise questions.

### Issue #2 -- Hotspot discoverability

If a coworker sees you constantly resting your mouse in a specific spot,
they may notice. Counter: also accept hover on the model picker pill as
"safe zone" -- model picking is a natural reason to keep mouse there.

### Issue #3 -- Browser autofill / spellcheck

`<input>` and `<textarea>` may leak draft message content to browser
spellcheckers (Google) or password managers. Set:

- `spellcheck="false"`
- `autocomplete="off"`
- `data-form-type="other"`

### Issue #4 -- The "interrupted sequence" semantics

You said "if the sequence is not done or the sequence is interrupted I want
to show some generic looking discussions." This spec interprets that as:
any time the hotspot isn't held, cover shows. Confirm this is right -- the
alternative reading is that interrupting the Konami code mid-sequence
should also trigger something specific (e.g., a "decoy" lockout). Easier to
just silently reset the sequence buffer.

---

## 10. Risks and ToS Notes

- **Trademark.** Cloning ChatGPT pixel-perfectly is fine for personal use but
  do not deploy this publicly under a misleading name. Keep the GitHub Pages
  URL non-descriptive (e.g., username.github.io/notes) and the repo private.
- **Telegram ToS.** Bot API usage is explicitly allowed and free. The bot
  can only message users who have started a conversation with it -- a
  built-in opt-in.
- **Bot name visibility.** When a coworker's phone is glanced at, the bot's
  name shows in their chat list. Pick something boring (`@notes_helper_bot`,
  not `@coworker_secret_bot`).
- **Workplace policy.** This app routes around your employer's expectations.
  That's the entire point, but understand the risk -- if discovered, "I
  built a covert messaging tool to disguise as ChatGPT" reads worse than
  "I texted a friend." Use at your own discretion.

---

## 11. File Layout (proposed)

```
/mnt/c/SecretMessagingApp/
  index.html
  styles/
    chatgpt.css            # main clone styles
    chatgpt-dark.css
  scripts/
    app.js                 # state machine, view rendering
    crypto.js              # PBKDF2, AES-GCM wrappers
    hotspot.js             # mouse tracking + debounce
    konami.js              # key sequence detection
    cover-engine.js        # match prompt -> scripted response
    api.js                 # fetches to Cloudflare Worker
  data/
    cover-corpus.json      # 50 scripted Q/A pairs
  worker/
    src/index.ts           # Cloudflare Worker entry
    wrangler.toml
  README.md                # private setup notes only
  SPEC.md                  # this file
```
