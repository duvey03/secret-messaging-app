/*
  Network client for the Cloudflare Worker.

  Includes a MOCK mode (USE_MOCK=true by default) that simulates outbound
  sends and inbound replies entirely in-browser so the app is fully
  testable before the Worker is deployed. Flip USE_MOCK to false (or call
  setUseMock(false)) once your Worker URL and shared secret are filled in.
*/

// === User-configurable placeholders ===
// Set these once the Cloudflare Worker is deployed.
export const WORKER_URL = 'https://YOUR-WORKER.workers.dev';
export const SHARED_SECRET = 'PLACEHOLDER_SHARED_SECRET_CHANGE_ME';

// Flip to false to use the real Worker.
let USE_MOCK = true;

export function setUseMock(value) { USE_MOCK = !!value; }
export function isMock() { return USE_MOCK; }

// === Mock state ===
// Stored in memory only; tab refresh clears mock inbox.
const mockInbox = [];

const MOCK_REPLIES = [
  "got it",
  "lol",
  "for sure",
  "yeah me too",
  "lunch sounds good",
  "ok i'll bring it",
  "haha",
  "where are you",
  "running 5 late",
  "down for that",
  "what time",
  "see you then",
  "all good here",
  "did you see the email from earlier",
  "ya",
];

function scheduleMockReply(recipientId) {
  const delay = 1500 + Math.random() * 3500;
  const body = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
  setTimeout(() => {
    mockInbox.push({
      recipient_id: recipientId,
      body,
      ts: Math.floor(Date.now() / 1000),
    });
  }, delay);
}

// === Public API ===

export async function sendMessage(recipientId, message) {
  if (USE_MOCK) {
    console.log(`[MOCK SEND -> ${recipientId}] ${message}`);
    scheduleMockReply(recipientId);
    return { ok: true, mock: true };
  }
  try {
    const res = await fetch(`${WORKER_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SHARED_SECRET}`,
      },
      body: JSON.stringify({ recipient_id: recipientId, message }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function pollInbox(sinceTs) {
  if (USE_MOCK) {
    const items = mockInbox.filter((m) => m.ts > sinceTs);
    const latest = items.length
      ? Math.max(...items.map((m) => m.ts))
      : sinceTs;
    return { ok: true, items, latest, mock: true };
  }
  try {
    const res = await fetch(`${WORKER_URL}/inbox?since=${sinceTs}`, {
      headers: { 'Authorization': `Bearer ${SHARED_SECRET}` },
    });
    if (!res.ok) return { ok: false, items: [], latest: sinceTs };
    return await res.json();
  } catch (err) {
    return { ok: false, items: [], latest: sinceTs, error: String(err) };
  }
}
