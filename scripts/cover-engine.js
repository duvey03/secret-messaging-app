/*
  Cover-mode response engine.
  - Loads the scripted corpus once.
  - Picks the best response by keyword overlap with the user's prompt.
  - Streams the response character-by-character to mimic ChatGPT's typing.
*/

let corpus = null;

export async function loadCorpus(path = 'data/cover-corpus.json') {
  if (corpus) return corpus;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load corpus: ${res.status}`);
  corpus = await res.json();
  return corpus;
}

export function getCorpus() {
  return corpus || [];
}

export function pickResponse(prompt) {
  if (!corpus || corpus.length === 0) {
    return "I'm not sure how to answer that just yet.";
  }
  const tokens = tokenize(prompt);
  let best = null;
  let bestScore = 0;
  for (const entry of corpus) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (tokens.has(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (!best || bestScore === 0) {
    best = corpus[Math.floor(Math.random() * corpus.length)];
  }
  return best.response;
}

export function pickSeedChats(count = 8) {
  if (!corpus || corpus.length === 0) return [];
  const shuffled = [...corpus].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map((entry) => ({
    id: `cover-${entry.id}`,
    title: entry.title,
    messages: [
      { role: 'user', content: entry.user_prompt },
      { role: 'assistant', content: entry.response },
    ],
  }));
}

function tokenize(text) {
  const tokens = new Set();
  if (!text) return tokens;
  const words = text.toLowerCase().split(/[^a-z0-9']+/);
  for (const w of words) {
    if (w.length >= 2) tokens.add(w);
  }
  return tokens;
}

/*
  Stream a string character-by-character, calling onChunk with the new
  partial content each time. Chunks are 1-3 characters with small jitter
  in delay to feel natural. Returns a Promise resolved when complete.
  Pass an AbortSignal to interrupt early.
*/
export async function streamResponse(text, onChunk, signal) {
  let i = 0;
  while (i < text.length) {
    if (signal?.aborted) return;
    const chunkSize = 1 + Math.floor(Math.random() * 3);
    i = Math.min(i + chunkSize, text.length);
    onChunk(text.slice(0, i));
    const delay = 10 + Math.random() * 25;
    await sleep(delay);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
