/*
  Cloudflare Worker: bridge between the static frontend (GitHub Pages) and
  the Telegram Bot API.

  Endpoints:
    GET  /                              health check
    POST /send                          send message to a recipient by ID
    POST /webhook/telegram/<secret>     Telegram update webhook
    GET  /inbox?since=<unix_ts>         poll new inbound messages
    GET  /admin/joins                   list chats that have run /start (sender helper)
    POST /admin/setwebhook              one-shot: registers this Worker as the Telegram webhook
*/

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      if (method === 'GET' && path === '/') {
        return cors(text('Secret messaging worker is running.'));
      }
      if (method === 'POST' && path === '/send') {
        return cors(await handleSend(request, env));
      }
      if (method === 'POST' && path.startsWith('/webhook/telegram/')) {
        const pathSecret = path.slice('/webhook/telegram/'.length);
        return cors(await handleTelegramWebhook(request, env, pathSecret));
      }
      if (method === 'GET' && path === '/inbox') {
        return cors(await handleInbox(request, env, url));
      }
      if (method === 'GET' && path === '/admin/joins') {
        return cors(await handleAdminJoins(request, env));
      }
      if (method === 'POST' && path === '/admin/setwebhook') {
        return cors(await handleSetWebhook(request, env));
      }
      return cors(text('Not found', 404));
    } catch (err) {
      console.error('Worker error', err);
      return cors(json({ ok: false, error: String(err?.message || err) }, 500));
    }
  },
};

// ===== Helpers =====

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.SHARED_SECRET}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function text(s, status = 200) {
  return new Response(s, { status, headers: { 'Content-Type': 'text/plain' } });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

async function telegram(env, methodName, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${methodName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

async function tgReply(env, chatId, text) {
  return telegram(env, 'sendMessage', { chat_id: chatId, text });
}

// ===== Endpoints =====

async function handleSend(request, env) {
  if (!checkAuth(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const recipientId = body.recipient_id;
  const message = body.message;
  if (!recipientId || !message) {
    return json({ ok: false, error: 'missing recipient_id or message' }, 400);
  }
  const chatId = await env.KV.get(`mapping:recipient:${recipientId}`);
  if (!chatId) {
    return json(
      { ok: false, error: `recipient "${recipientId}" is not linked yet` },
      400
    );
  }
  const tg = await telegram(env, 'sendMessage', {
    chat_id: parseInt(chatId, 10),
    text: message,
  });
  if (!tg.ok) {
    return json(
      { ok: false, error: tg.description || 'telegram send failed' },
      502
    );
  }
  return json({ ok: true, message_id: tg.result?.message_id });
}

async function handleTelegramWebhook(request, env, pathSecret) {
  if (pathSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'invalid webhook path' }, 401);
  }
  const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (headerSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'invalid webhook header' }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  const message = update.message;
  if (!message?.chat?.id) {
    return json({ ok: true, skipped: 'no chat message' });
  }
  const chatId = message.chat.id;
  const text = message.text || '';

  // /start [recipient_id]
  if (text.startsWith('/start')) {
    const parts = text.trim().split(/\s+/);
    const requestedSlot = parts[1];
    const now = Math.floor(Date.now() / 1000);

    if (requestedSlot) {
      const existing = await env.KV.get(`mapping:recipient:${requestedSlot}`);
      if (existing && existing !== String(chatId)) {
        await tgReply(
          env,
          chatId,
          `Sorry, slot "${requestedSlot}" is already linked to someone else. Contact the sender to release it.`
        );
        return json({ ok: true, action: 'start-conflict' });
      }
      await env.KV.put(`mapping:recipient:${requestedSlot}`, String(chatId));
      await env.KV.put(`mapping:chat:${chatId}`, requestedSlot);
      await env.KV.put(
        `chat:${chatId}`,
        JSON.stringify({ joined_at: now, recipient_id: requestedSlot })
      );
      await tgReply(
        env,
        chatId,
        `You're linked as "${requestedSlot}". Reply normally in this chat to send messages back. Have a nice day.`
      );
      return json({ ok: true, action: 'start-linked', recipient_id: requestedSlot });
    } else {
      await env.KV.put(
        `chat:${chatId}`,
        JSON.stringify({ joined_at: now, recipient_id: null })
      );
      await tgReply(
        env,
        chatId,
        `Hi. Your chat ID is ${chatId}. The sender will tell you which slot name to use, e.g. /start alex.`
      );
      return json({ ok: true, action: 'start-noslot' });
    }
  }

  // Regular inbound: store in inbox keyed by recipient_id
  const recipientId = await env.KV.get(`mapping:chat:${chatId}`);
  if (!recipientId) {
    await tgReply(
      env,
      chatId,
      `You're not linked yet. Send /start <slot> first.`
    );
    return json({ ok: true, skipped: 'unlinked chat' });
  }
  const ts = Math.floor(Date.now() / 1000);
  const suffix = Math.random().toString(36).slice(2, 8);
  const inboxKey = `inbox:${recipientId}:${String(ts).padStart(12, '0')}:${suffix}`;
  await env.KV.put(
    inboxKey,
    JSON.stringify({ body: text, ts, recipient_id: recipientId }),
    { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
  );
  return json({ ok: true, stored: inboxKey });
}

async function handleInbox(request, env, url) {
  if (!checkAuth(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const items = [];
  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'inbox:', cursor });
    for (const k of list.keys) {
      const value = await env.KV.get(k.name);
      if (!value) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed.ts > since) items.push(parsed);
      } catch {
        // skip malformed
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  items.sort((a, b) => a.ts - b.ts);
  const latest = items.length
    ? Math.max(...items.map((x) => x.ts))
    : since;
  return json({ ok: true, items, latest });
}

async function handleAdminJoins(request, env) {
  if (!checkAuth(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const joins = [];
  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'chat:', cursor });
    for (const k of list.keys) {
      const value = await env.KV.get(k.name);
      try {
        const parsed = JSON.parse(value);
        joins.push({
          chat_id: k.name.slice('chat:'.length),
          ...parsed,
        });
      } catch {}
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return json({ ok: true, joins });
}

async function handleSetWebhook(request, env) {
  if (!checkAuth(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const workerUrl = body.worker_url; // e.g. https://your-worker.your-name.workers.dev
  if (!workerUrl) {
    return json({ ok: false, error: 'missing worker_url' }, 400);
  }
  const webhookUrl = `${workerUrl.replace(/\/$/, '')}/webhook/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`;
  const result = await telegram(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: true,
  });
  return json({ ok: result.ok, telegram: result, webhook_url: webhookUrl });
}
