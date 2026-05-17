/*
  Main app controller.
  - Manages the four-state machine (cover, pin prompt, unlocked-hidden, unlocked-visible)
  - Renders sidebar, messages, model picker for whichever state is active
  - Wires up Konami, hotspot, panic key, blur, send button
  - Persists cover data plaintext + real data AES-GCM encrypted in localStorage
*/

import { watchKonami } from './konami.js';
import { watchSafeZone } from './hotspot.js';
import * as cryptoMod from './crypto.js';
import * as api from './api.js';
import {
  loadCorpus,
  pickResponse,
  streamResponse,
  pickSeedChats,
} from './cover-engine.js';

// === Constants ===

const STATE = {
  COVER: 'cover',
  PROMPT: 'prompt',
  HIDDEN: 'hidden',
  VISIBLE: 'visible',
};

const DEFAULT_MODELS_REAL = {
  'gpt-4o':      { name: 'GPT-4o',      desc: 'Great for most tasks',     recipient_id: 'alex',   chat_id: null },
  'gpt-4o-mini': { name: 'GPT-4o mini', desc: 'Faster for everyday',      recipient_id: 'sam',    chat_id: null },
  'o1':          { name: 'o1',          desc: 'Uses advanced reasoning',  recipient_id: 'jordan', chat_id: null },
  'o1-mini':     { name: 'o1-mini',     desc: 'Faster reasoning',         recipient_id: 'taylor', chat_id: null },
  'gpt-3.5':     { name: 'GPT-3.5',     desc: 'Legacy fast model',        recipient_id: 'morgan', chat_id: null },
};

const COVER_MODELS = [
  { id: 'gpt-4o',      name: 'ChatGPT 4o',     desc: 'Great for most tasks' },
  { id: 'gpt-4o-mini', name: 'ChatGPT 4o mini',desc: 'Faster for everyday' },
  { id: 'o1',          name: 'ChatGPT o1',     desc: 'Uses advanced reasoning' },
];

const STORAGE_KEYS = {
  SALT: 'sma_salt',
  COVER: 'sma_cover',
  REAL_BLOB: 'sma_real_blob',
  REAL_IV: 'sma_real_iv',
  WALKTHROUGH_DONE: 'sma_walkthrough_done',
};

const WALKTHROUGH_STEPS = [
  {
    title: 'You found it',
    text:
`Hi. This isn't really ChatGPT.

It's a covert messaging app disguised as the ChatGPT web app. The Konami code you just entered is the secret entry. The person who sent you this link wanted you to discover the trick on your own first.

Let me walk you through how it works.`,
  },
  {
    title: 'The cover',
    text:
`The chat you were typing into before is fake. The "AI" answered with one of 50 pre-written responses from a small corpus. Nothing you typed left your browser.

To anyone watching, this looks like a normal ChatGPT session. Same layout, same model picker, same streaming-text animation.`,
  },
  {
    title: 'The real messaging',
    text:
`Each "AI model" in the picker (GPT-4o, GPT-4o mini, o1, etc.) is secretly mapped to a different real person on Telegram.

Switch the model in the dropdown to switch who you're chatting with. Type a message, press Enter. It arrives on their phone as a normal Telegram message. They reply on Telegram and the reply shows up here as that "model's" response.`,
  },
  {
    title: 'Set your PIN',
    text:
`Real conversations are encrypted at rest with a password you set right now.

There is no recovery. If you forget the PIN, the encrypted store is unreadable forever. Pick something you'll remember.`,
    pinInput: true,
  },
  {
    title: 'The hotspot',
    text:
`You're unlocked, but the screen is still showing the cover.

To see real chat content, hover your mouse on the Share button in the top right of the page. Real conversations appear. Move the cursor away and cover view returns immediately.

This is the "keep doing something to stay unlocked" gesture. Pause and the app re-locks the view.`,
  },
  {
    title: "Panic, and you're done",
    text:
`If you need to lock fast: triple-tap Escape. Or Alt-Tab to another window. Or reload the page. Any of those wipe the decryption key from memory immediately.

To come back: Konami code, then your PIN.

That's everything. Hover Share now to see your inbox.`,
  },
];

// === Module state ===

let appState = STATE.COVER;
let cryptoKey = null;
let realData = null;       // decrypted; null when locked
let coverData = null;
let activeCoverChatId = null;
let activeRealModelId = null;   // when viewing real chat, this is the model whose thread is shown
let activeCoverModelId = 'gpt-4o'; // model picker label in cover mode
let dropdownOpen = false;
let lastPollTs = 0;
let pollInterval = null;
let streamAbortController = null;
let walkthroughStep = 0;
let walkthroughPinAccepted = false;

// === Boot ===

async function init() {
  await loadCorpus();
  loadOrSeedCover();
  ensureSalt();
  setState(STATE.COVER);
  wireEvents();
  render();
}

function loadOrSeedCover() {
  const stored = localStorage.getItem(STORAGE_KEYS.COVER);
  if (stored) {
    try {
      coverData = JSON.parse(stored);
      if (!coverData?.chats) throw new Error('bad shape');
      return;
    } catch {
      // fall through to seed
    }
  }
  coverData = { chats: pickSeedChats(8) };
  if (coverData.chats.length > 0) {
    activeCoverChatId = null; // start with empty state
  }
  saveCover();
}

function saveCover() {
  localStorage.setItem(STORAGE_KEYS.COVER, JSON.stringify(coverData));
}

function ensureSalt() {
  if (!localStorage.getItem(STORAGE_KEYS.SALT)) {
    localStorage.setItem(STORAGE_KEYS.SALT, cryptoMod.newSalt());
  }
}

async function saveReal() {
  if (!cryptoKey || !realData) return;
  const { iv, blob } = await cryptoMod.encrypt(cryptoKey, realData);
  localStorage.setItem(STORAGE_KEYS.REAL_BLOB, blob);
  localStorage.setItem(STORAGE_KEYS.REAL_IV, iv);
}

// === State transitions ===

function setState(next) {
  appState = next;
  document.documentElement.dataset.appState = next;
  document.body.dataset.appState = next;

  // Polling lifecycle
  const shouldPoll = next === STATE.HIDDEN || next === STATE.VISIBLE;
  if (shouldPoll && !pollInterval) {
    pollInterval = setInterval(pollInboxLoop, 5000);
    pollInboxLoop();
  }
  if (!shouldPoll && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function panicLock() {
  if (streamAbortController) {
    streamAbortController.abort();
    streamAbortController = null;
  }
  cryptoKey = null;
  realData = null;
  activeRealModelId = null;
  closePinModal();
  // Tear down walkthrough without marking it done -- user can restart it.
  document.getElementById('walkthrough-modal').classList.add('hidden');
  walkthroughStep = 0;
  walkthroughPinAccepted = false;
  closeDropdown();
  setState(STATE.COVER);
  render();
}

// === Event wiring ===

function wireEvents() {
  watchKonami(() => {
    if (appState !== STATE.COVER) return;
    if (!localStorage.getItem(STORAGE_KEYS.WALKTHROUGH_DONE)) {
      openWalkthrough();
    } else {
      openPinModal();
    }
  });

  // The Share button is the primary unlock-hold target. The Send button and
  // Model picker are also safe zones so the user can click them without
  // relock flicker mid-action.
  const shareBtn = document.getElementById('share-btn');
  const sendBtn = document.getElementById('send-btn');
  const modelPicker = document.getElementById('model-picker');
  watchSafeZone(
    [shareBtn, sendBtn, modelPicker],
    onSafeEnter,
    onSafeLeave,
  );

  // Fake share action: copies a plausible-looking ChatGPT share URL to
  // clipboard and toasts. Fires in any state -- a real share click should
  // never reveal anything sensitive.
  shareBtn.addEventListener('click', onFakeShareClick);

  // Composer
  const input = document.getElementById('composer-input');
  input.addEventListener('input', onComposerInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  sendBtn.addEventListener('click', onSend);

  // Sidebar
  document.getElementById('new-chat-btn').addEventListener('click', onNewChat);

  // Model picker
  modelPicker.addEventListener('click', toggleDropdown);
  document.addEventListener('click', (e) => {
    if (!dropdownOpen) return;
    if (e.target.closest('#model-dropdown') || e.target.closest('#model-picker')) return;
    closeDropdown();
  });

  // PIN modal
  document.getElementById('pin-ok').addEventListener('click', onPinSubmit);
  document.getElementById('pin-cancel').addEventListener('click', closePinModal);
  document.getElementById('pin-cancel-2').addEventListener('click', closePinModal);
  document.getElementById('pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onPinSubmit();
    }
  });

  // Walkthrough modal
  document.getElementById('walk-next').addEventListener('click', onWalkNext);
  document.getElementById('walk-back').addEventListener('click', onWalkBack);
  document.getElementById('walk-skip').addEventListener('click', onWalkSkip);
  document.getElementById('walk-pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onWalkNext();
    }
  });

  // Panic key: triple Esc within 1.2s. While a modal is open, Esc closes it
  // instead of counting toward panic-lock.
  let escCount = 0;
  let escTimer = null;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pinOpen = !document.getElementById('pin-modal').classList.contains('hidden');
    const walkOpen = !document.getElementById('walkthrough-modal').classList.contains('hidden');
    if (pinOpen) {
      closePinModal();
      return;
    }
    if (walkOpen) {
      // Esc during walkthrough = skip (but don't lose the encrypted store).
      onWalkSkip();
      return;
    }
    escCount++;
    if (escTimer) clearTimeout(escTimer);
    escTimer = setTimeout(() => { escCount = 0; }, 1200);
    if (escCount >= 3) {
      escCount = 0;
      if (appState !== STATE.COVER) {
        panicLock();
        showToast('Locked');
      }
    }
  });

  // Tab blur lock
  window.addEventListener('blur', () => {
    if (appState !== STATE.COVER) panicLock();
  });

  // Visibility change (e.g. browser hidden via OS tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && appState !== STATE.COVER) panicLock();
  });
}

// === Safe-zone handlers ===

function onSafeEnter() {
  if (appState === STATE.HIDDEN) {
    setState(STATE.VISIBLE);
    render();
  }
}

function onSafeLeave() {
  if (appState === STATE.VISIBLE) {
    setState(STATE.HIDDEN);
    render();
  }
}

// === PIN modal ===

function openPinModal() {
  const overlay = document.getElementById('pin-modal');
  const input = document.getElementById('pin-input');
  const hint = document.getElementById('pin-hint');
  const isFirstTime = !localStorage.getItem(STORAGE_KEYS.REAL_BLOB);
  hint.textContent = isFirstTime
    ? 'First time: set your custom prompt. Save to continue.'
    : 'Enter your custom prompt to continue.';
  input.value = '';
  overlay.classList.remove('hidden');
  setTimeout(() => input.focus(), 30);
  setState(STATE.PROMPT);
}

function closePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
  if (appState === STATE.PROMPT) {
    setState(STATE.COVER);
  }
}

async function onPinSubmit() {
  const input = document.getElementById('pin-input');
  const ok = await acceptPin(input.value, input);
  if (!ok) return;
  document.getElementById('pin-modal').classList.add('hidden');
  showToast('Unlocked. Hover the Share button to view.');
}

// Shared logic: derives key from PIN, decrypts existing store (or creates a
// fresh empty one), promotes app into HIDDEN state. Returns true on success,
// false on failure (with input flashed). Both the PIN modal and the
// walkthrough's PIN step call this.
async function acceptPin(pin, inputForFlash) {
  if (!pin) {
    if (inputForFlash) flashInputError(inputForFlash);
    return false;
  }
  const salt = localStorage.getItem(STORAGE_KEYS.SALT);
  try {
    const key = await cryptoMod.deriveKey(pin, salt);
    const blob = localStorage.getItem(STORAGE_KEYS.REAL_BLOB);
    const iv = localStorage.getItem(STORAGE_KEYS.REAL_IV);
    if (blob && iv) {
      try {
        realData = await cryptoMod.decrypt(key, iv, blob);
      } catch {
        if (inputForFlash) flashInputError(inputForFlash);
        return false;
      }
    } else {
      realData = {
        models: structuredClone(DEFAULT_MODELS_REAL),
        chats: [],
        last_poll: 0,
      };
    }
    cryptoKey = key;
    lastPollTs = realData.last_poll || 0;
    await saveReal();
    activeRealModelId = activeRealModelId || Object.keys(realData.models)[0];
    setState(STATE.HIDDEN);
    render();
    return true;
  } catch (err) {
    console.error('PIN derive failed', err);
    if (inputForFlash) flashInputError(inputForFlash);
    return false;
  }
}

// === Walkthrough ===

function openWalkthrough() {
  walkthroughStep = 0;
  walkthroughPinAccepted = false;
  setState(STATE.PROMPT);
  document.getElementById('walkthrough-modal').classList.remove('hidden');
  renderWalkthrough();
}

function closeWalkthrough(markDone = true) {
  if (markDone) localStorage.setItem(STORAGE_KEYS.WALKTHROUGH_DONE, '1');
  document.getElementById('walkthrough-modal').classList.add('hidden');
  // If they made it past PIN, leave them in HIDDEN. Otherwise, drop back to COVER.
  if (!walkthroughPinAccepted && appState === STATE.PROMPT) {
    setState(STATE.COVER);
  }
}

function renderWalkthrough() {
  const step = WALKTHROUGH_STEPS[walkthroughStep];
  document.getElementById('walk-title').textContent = step.title;
  document.getElementById('walk-progress').textContent =
    `${walkthroughStep + 1} / ${WALKTHROUGH_STEPS.length}`;
  document.getElementById('walk-text').textContent = step.text;

  const pinWrap = document.getElementById('walk-pin-wrap');
  const pinInput = document.getElementById('walk-pin-input');
  const showPin = !!step.pinInput && !walkthroughPinAccepted;
  pinWrap.classList.toggle('hidden', !showPin);
  if (showPin) {
    pinInput.value = '';
    setTimeout(() => pinInput.focus(), 50);
  }

  const backBtn = document.getElementById('walk-back');
  const nextBtn = document.getElementById('walk-next');
  const skipBtn = document.getElementById('walk-skip');

  backBtn.disabled = walkthroughStep === 0 || walkthroughPinAccepted;
  // Once they've committed a PIN, no more skipping the walkthrough.
  skipBtn.disabled = walkthroughPinAccepted;
  skipBtn.style.display = walkthroughPinAccepted ? 'none' : '';

  const isLast = walkthroughStep === WALKTHROUGH_STEPS.length - 1;
  nextBtn.textContent = isLast ? 'Done' : (showPin ? 'Save PIN' : 'Next');
}

async function onWalkNext() {
  const step = WALKTHROUGH_STEPS[walkthroughStep];
  if (step.pinInput && !walkthroughPinAccepted) {
    const input = document.getElementById('walk-pin-input');
    const ok = await acceptPin(input.value, input);
    if (!ok) return;
    walkthroughPinAccepted = true;
  }
  if (walkthroughStep === WALKTHROUGH_STEPS.length - 1) {
    closeWalkthrough(true);
    showToast('Hover the Share button (top right) to view.');
    return;
  }
  walkthroughStep++;
  renderWalkthrough();
}

function onWalkBack() {
  if (walkthroughStep === 0 || walkthroughPinAccepted) return;
  walkthroughStep--;
  renderWalkthrough();
}

function onWalkSkip() {
  // User dismissed the walkthrough before setting a PIN. Treat as cancel:
  // mark walkthrough_done so they don't see it again, drop back to cover.
  closeWalkthrough(true);
}

function flashInputError(input) {
  input.classList.add('error');
  setTimeout(() => input.classList.remove('error'), 400);
}

// === Composer ===

function onComposerInput() {
  const input = document.getElementById('composer-input');
  const sendBtn = document.getElementById('send-btn');
  // auto-grow
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  sendBtn.classList.toggle('has-text', input.value.trim().length > 0);
}

async function onSend() {
  const input = document.getElementById('composer-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  onComposerInput();

  if (appState === STATE.VISIBLE && realData) {
    await sendReal(text);
  } else {
    await sendCover(text);
  }
}

// === Cover send (scripted) ===

async function sendCover(text) {
  let chat;
  if (activeCoverChatId) {
    chat = coverData.chats.find((c) => c.id === activeCoverChatId);
  }
  if (!chat) {
    chat = {
      id: 'cover-new-' + Date.now(),
      title: truncate(text, 40),
      messages: [],
    };
    coverData.chats.unshift(chat);
    activeCoverChatId = chat.id;
  }
  chat.messages.push({ role: 'user', content: text });
  render();
  saveCover();

  const reply = pickResponse(text);
  const assistantMsg = { role: 'assistant', content: '' };
  chat.messages.push(assistantMsg);
  render();

  streamAbortController = new AbortController();
  try {
    await streamResponse(reply, (partial) => {
      assistantMsg.content = partial;
      updateLastAssistantInDom(partial, true);
    }, streamAbortController.signal);
  } finally {
    streamAbortController = null;
    updateLastAssistantInDom(assistantMsg.content, false);
    saveCover();
  }
}

// === Real send (Telegram) ===

async function sendReal(text) {
  const modelId = activeRealModelId || Object.keys(realData.models)[0];
  const model = realData.models[modelId];
  if (!model) return;

  let chat = realData.chats.find((c) => c.model_id === modelId);
  if (!chat) {
    chat = {
      id: 'real-' + modelId,
      model_id: modelId,
      title: model.name,
      messages: [],
    };
    realData.chats.unshift(chat);
  }
  chat.messages.push({
    role: 'user',
    content: text,
    ts: Math.floor(Date.now() / 1000),
  });
  render();
  await saveReal();

  const result = await api.sendMessage(model.recipient_id, text);
  if (!result.ok) {
    showToast(`Send failed: ${result.error || 'unknown'}`);
    chat.messages.push({
      role: 'system',
      content: `[send failed: ${result.error || 'unknown'}]`,
      ts: Math.floor(Date.now() / 1000),
    });
    render();
    await saveReal();
  }
}

// === Inbox polling ===

async function pollInboxLoop() {
  if (!realData) return;
  const result = await api.pollInbox(lastPollTs);
  if (!result.ok || !result.items?.length) return;

  for (const item of result.items) {
    const modelEntry = Object.entries(realData.models).find(
      ([, m]) => m.recipient_id === item.recipient_id
    );
    if (!modelEntry) continue;
    const [modelId, model] = modelEntry;
    let chat = realData.chats.find((c) => c.model_id === modelId);
    if (!chat) {
      chat = {
        id: 'real-' + modelId,
        model_id: modelId,
        title: model.name,
        messages: [],
      };
      realData.chats.unshift(chat);
    }
    chat.messages.push({
      role: 'assistant',
      content: item.body,
      ts: item.ts,
    });
  }
  lastPollTs = result.latest || lastPollTs;
  realData.last_poll = lastPollTs;
  await saveReal();
  if (appState === STATE.VISIBLE) render();
}

// === Model picker dropdown ===

function toggleDropdown() {
  if (dropdownOpen) closeDropdown();
  else openDropdown();
}

function openDropdown() {
  dropdownOpen = true;
  const dd = document.getElementById('model-dropdown');
  dd.classList.remove('hidden');
  renderDropdown();
}

function closeDropdown() {
  dropdownOpen = false;
  document.getElementById('model-dropdown').classList.add('hidden');
}

function renderDropdown() {
  const dd = document.getElementById('model-dropdown');
  dd.innerHTML = '';
  const visibleReal = appState === STATE.VISIBLE && realData;
  const items = visibleReal
    ? Object.entries(realData.models).map(([id, m]) => ({
        id, name: m.name, desc: m.desc || `to ${m.recipient_id}`,
      }))
    : COVER_MODELS;
  const activeId = visibleReal ? activeRealModelId : activeCoverModelId;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'model-option' + (item.id === activeId ? ' selected' : '');
    btn.innerHTML = `
      <div class="model-meta">
        <span class="model-name"></span>
        <span class="model-desc"></span>
      </div>
      <span class="check">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    btn.querySelector('.model-name').textContent = item.name;
    btn.querySelector('.model-desc').textContent = item.desc;
    btn.addEventListener('click', () => {
      if (visibleReal) {
        activeRealModelId = item.id;
      } else {
        activeCoverModelId = item.id;
      }
      closeDropdown();
      render();
    });
    dd.appendChild(btn);
  }
}

// === Rendering ===

function render() {
  renderModelLabel();
  renderSidebar();
  renderMessages();
  renderEmptyState();
  if (dropdownOpen) renderDropdown();
}

function renderModelLabel() {
  const label = document.getElementById('current-model-label');
  if (appState === STATE.VISIBLE && realData) {
    const m = realData.models[activeRealModelId];
    label.textContent = m ? m.name : 'ChatGPT';
  } else {
    const m = COVER_MODELS.find((x) => x.id === activeCoverModelId) || COVER_MODELS[0];
    label.textContent = m.name;
  }
}

function renderSidebar() {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  const showingReal = appState === STATE.VISIBLE && realData;
  const chats = showingReal ? realData.chats : coverData.chats;
  for (const chat of chats) {
    const a = document.createElement('button');
    a.className = 'chat-item';
    a.textContent = chat.title || truncate(chat.messages[0]?.content || '(empty)', 40);
    const active = showingReal
      ? activeRealModelId === chat.model_id
      : activeCoverChatId === chat.id;
    if (active) a.classList.add('active');
    a.addEventListener('click', () => {
      if (showingReal) {
        activeRealModelId = chat.model_id;
      } else {
        activeCoverChatId = chat.id;
      }
      render();
    });
    list.appendChild(a);
  }
}

function renderMessages() {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  const chat = getActiveChat();
  if (!chat) return;
  for (const msg of chat.messages) {
    messagesEl.appendChild(renderMessageEl(msg));
  }
  // Scroll to bottom
  const wrap = document.getElementById('messages-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

function renderEmptyState() {
  const empty = document.getElementById('empty-state');
  const chat = getActiveChat();
  const hasContent = chat && chat.messages.length > 0;
  empty.style.display = hasContent ? 'none' : 'flex';
}

function getActiveChat() {
  if (appState === STATE.VISIBLE && realData) {
    return realData.chats.find((c) => c.model_id === activeRealModelId);
  }
  return coverData.chats.find((c) => c.id === activeCoverChatId);
}

function renderMessageEl(msg) {
  const div = document.createElement('div');
  div.className = `msg msg-${msg.role}`;
  if (msg.role === 'user') {
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = msg.content;
    div.appendChild(body);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"/></svg>`;
    div.appendChild(avatar);
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = msg.content;
    div.appendChild(body);
  }
  return div;
}

function updateLastAssistantInDom(text, withCursor) {
  const messagesEl = document.getElementById('messages');
  const last = messagesEl.querySelector('.msg-assistant:last-child .msg-body');
  if (!last) return;
  last.textContent = text;
  if (withCursor) {
    const cur = document.createElement('span');
    cur.className = 'cursor';
    last.appendChild(cur);
  }
  const wrap = document.getElementById('messages-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

function onNewChat() {
  if (appState === STATE.VISIBLE && realData) {
    // For real mode, "new chat" doesn't really make sense -- threads are per-model.
    // Just clear the active selection so the empty state shows.
    activeRealModelId = Object.keys(realData.models)[0];
  } else {
    activeCoverChatId = null;
  }
  document.getElementById('composer-input').focus();
  render();
}

// === Helpers ===

function truncate(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

async function onFakeShareClick() {
  const url = `https://chatgpt.com/share/${fakeShareUuid()}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link to chat copied');
  } catch {
    // Clipboard write requires user activation + a secure context. The
    // click satisfies activation; non-HTTPS or older browsers may still
    // reject. Fall back to the toast alone so the cover behavior holds.
    showToast('Link to chat copied');
  }
}

function fakeShareUuid() {
  const hex = (n) => Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
  return `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
}

function showToast(msg, ms = 2500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 200);
  }, ms);
}

// === Boot ===

init().catch((err) => {
  console.error('Init failed', err);
});

// Expose a tiny debug surface so the user can flip mock mode from devtools
// after the worker is deployed.
window.__sma = {
  setUseMock: api.setUseMock,
  isMock: api.isMock,
  state: () => appState,
  panic: panicLock,
};
