/**
 * WhatsApp Cloud API → Apps Script relay (backend/WhatsApp.gs; specs/review-telegram-email.md § WhatsApp capture).
 *
 * Why a Worker: Meta's webhook needs an address that answers its verification check directly (GET with hub.challenge) and
 * a quick 200 to every message. Apps Script answers with a 302 redirect and cannot read request headers (Meta's signature is
 * in a header), the same reasons the Telegram relay exists. A Worker is free, has a fixed *.workers.dev address and does
 * not depend on the Mac being on.
 *
 * What it does:
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → the challenge, only when the token is WA_VERIFY_TOKEN.
 *   POST (a message)  → checks Meta's X-Hub-Signature-256 (when WA_APP_SECRET is set), answers 200 at once, then, for each
 *        message from a number that has a ROUTE, forwards { whatsapp: {id, from, timestamp, type, text, reply_id,
 *        reply_title, context_id}, relay_secret: <that route's key> } to THAT route's copy of the app. While WhatsApp is the
 *        review bot (backend/WhatsAppBot.gs) the copy sends its own messages and answers { handled: true }; otherwise the
 *        Worker sends back the short reply it wrote. Messages from a number with no route are dropped without an answer.
 *   POST /media → a copy downloads a photo the person sent (receipt reading, backend/PhotoCapture.gs): header X-Relay-Secret
 *        = a copy's key, body { id: <WhatsApp media id> }; answers { mime, base64 }. The id only ever reaches the copy the
 *        person's messages are routed to.
 *   POST /send  → a copy's own sending door: header X-Relay-Secret = that copy's key, body { message: <WhatsApp message> };
 *        sent with WA_ACCESS_TOKEN only when its "to" is a number routed to THAT key (a copy can only write to its own person).
 *
 * Routes, one per person (owner's plan "WhatsApp bot for friends", 2026-11-16): each person's messages go to their OWN copy.
 *   - The owner's: every number in WA_ALLOWED_FROM → APPS_SCRIPT_URL with WA_RELAY_SECRET (as before; nothing to change).
 *   - Friends': the secret WA_ROUTES, one line per person, exactly the code their app shows in More → My profile →
 *     WhatsApp bot:  WA1 <number> <their copy's address> <their key>
 * Logs never hold message text (only codes and lengths).
 *
 * Deploy (pasted by hand, like the Telegram relay): Cloudflare → Workers & Pages → Create → Worker, name it
 * "whatsapp-relay", paste this file over the template, Deploy. Then Settings → Variables and Secrets, add as SECRETS
 * (values in the private secrets file, never in this repo):
 *   WA_VERIFY_TOKEN, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_ALLOWED_FROM (digits only, country code first; several
 *   separated by commas), WA_RELAY_SECRET (the same value as the sheet menu "34. Set the WhatsApp relay key"),
 *   WA_APP_SECRET (Meta app → App settings → Basic → App secret; recommended).
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec';
const GRAPH_URL = 'https://graph.facebook.com/v24.0';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
// Said when Apps Script could not be reached at all (its own answers come in the person's language).
const FALLBACK_REPLY = 'No se pudo guardar / Not saved. Inténtalo de nuevo o agrégalo en la app.';

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signatureOk(env, request, raw) {
  if (!env.WA_APP_SECRET) return true;   // not set up: rely on the sender check and the relay secret
  const got = request.headers.get('X-Hub-Signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WA_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return sameText(got, 'sha256=' + hex(mac));
}

// { number: { url, key } } — the owner's numbers (WA_ALLOWED_FROM) plus every "WA1 <number> <url> <key>" line of WA_ROUTES.
function routes(env) {
  const out = {};
  String(env.WA_ALLOWED_FROM || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean).forEach((n) => {
    if (env.WA_RELAY_SECRET) out[n] = { url: APPS_SCRIPT_URL, key: env.WA_RELAY_SECRET };
  });
  String(env.WA_ROUTES || '').split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^WA1\s+(\d{6,15})\s+(https:\/\/script\.google\.com\/\S+\/exec)\s+(\S{24,})$/);
    if (m) out[m[1]] = { url: m[2], key: m[3] };
  });
  return out;
}

async function askAppsScript(url, payload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
      return JSON.parse(await res.text());
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function sendReply(env, to, text, replyTo) {
  const body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 4000) } };
  if (replyTo) body.context = { message_id: replyTo };
  const res = await fetch(`${GRAPH_URL}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) console.error('WhatsApp reply failed: HTTP ' + res.status);   // never the message text
}

async function sendForApp(env, request) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const given = request.headers.get('X-Relay-Secret') || '';
  const all = routes(env);
  const mine = Object.keys(all).filter((n) => sameText(given, all[n].key));   // the numbers this copy may write to
  if (!given || !mine.length) return json({ error: { message: 'forbidden' } }, 403);
  let body;
  try { body = await request.json(); } catch (err) { return json({ error: { message: 'bad body' } }, 400); }
  const message = body && body.message;
  const to = String((message && message.to) || '').replace(/\D/g, '');
  if (!message || !mine.includes(to)) return json({ error: { message: 'recipient not allowed' } }, 403);
  message.messaging_product = 'whatsapp';
  message.to = to;
  const res = await fetch(`${GRAPH_URL}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function mediaForApp(env, request) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const given = request.headers.get('X-Relay-Secret') || '';
  const all = routes(env);
  if (!given || !Object.keys(all).some((n) => sameText(given, all[n].key))) return json({ error: { message: 'forbidden' } }, 403);
  let body;
  try { body = await request.json(); } catch (err) { return json({ error: { message: 'bad body' } }, 400); }
  const id = String((body && body.id) || '');
  if (!/^\d{5,30}$/.test(id)) return json({ error: { message: 'bad id' } }, 400);
  const auth = { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` };
  const info = await fetch(`${GRAPH_URL}/${id}`, { headers: auth });
  if (!info.ok) return json({ error: { message: 'media not found' } }, 404);
  const meta = await info.json();
  if (!meta || !meta.url) return json({ error: { message: 'media not found' } }, 404);
  const file = await fetch(meta.url, { headers: auth });
  if (!file.ok) return json({ error: { message: 'media download failed' } }, 502);
  return json({ mime: meta.mime_type || file.headers.get('Content-Type') || '', base64: toBase64(await file.arrayBuffer()) }, 200);
}

// What Apps Script needs from a message: its text, which button or list row was tapped, and which bot message it answers.
function describe(msg) {
  const out = { id: msg.id, from: msg.from, timestamp: msg.timestamp, type: msg.type, text: '' };
  if (msg.type === 'text' && msg.text) out.text = msg.text.body;
  if (msg.type === 'interactive' && msg.interactive) {
    const r = msg.interactive.button_reply || msg.interactive.list_reply;
    if (r) { out.reply_id = r.id; out.reply_title = r.title; }
  }
  if (msg.type === 'button' && msg.button) { out.reply_id = msg.button.payload; out.reply_title = msg.button.text; }
  // A photo (receipt reading): its media id; the copy downloads it through /media when its reader is ready.
  if (msg.type === 'image' && msg.image) { out.media_id = msg.image.id; out.mime = msg.image.mime_type || ''; out.text = msg.image.caption || ''; }
  if (msg.type === 'document' && msg.document && /^image\//i.test(msg.document.mime_type || '')) {
    out.type = 'image'; out.media_id = msg.document.id; out.mime = msg.document.mime_type; out.text = msg.document.caption || '';
  }
  if (msg.context && msg.context.id) out.context_id = msg.context.id;
  return out;
}

async function handleMessage(env, msg, route) {
  const payload = { whatsapp: describe(msg), relay_secret: route.key };
  let reply = FALLBACK_REPLY;
  try {
    const answer = await askAppsScript(route.url, payload);
    // While WhatsApp is the review bot, Apps Script sends its own messages (cards, lists) and asks for nothing here.
    if (answer && answer.ok && answer.data && answer.data.handled) return;
    if (answer && answer.ok && answer.data && answer.data.reply) reply = answer.data.reply;
    else if (answer && answer.reply) reply = answer.reply;
    else console.error('Apps Script refused: ok=' + !!(answer && answer.ok));   // never the message text
  } catch (err) {
    console.error('Apps Script unreachable: ' + (err && err.name));
  }
  await sendReply(env, msg.from, reply, msg.id);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      // Meta's "Verify and save" check.
      if (url.searchParams.get('hub.mode') === 'subscribe') {
        const ok = env.WA_VERIFY_TOKEN && sameText(url.searchParams.get('hub.verify_token') || '', env.WA_VERIFY_TOKEN);
        return ok
          ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
          : new Response('Forbidden', { status: 403 });
      }
      return new Response('WhatsApp relay is up.', { status: 200 });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // A copy's own sending door (backend/WhatsAppBot.gs): the copy holds no WhatsApp token, it asks here with its key, and
    // can only write to the number(s) routed to that key — a leaked key can message nobody else.
    if (url.pathname === '/send') return sendForApp(env, request);
    if (url.pathname === '/media') return mediaForApp(env, request);

    const raw = await request.text();
    if (!(await signatureOk(env, request, raw))) return new Response('Bad signature', { status: 401 });

    let update;
    try { update = JSON.parse(raw); } catch (err) { return new Response('ok', { status: 200 }); }

    const all = routes(env);
    const messages = [];
    for (const entry of update.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (env.WA_PHONE_NUMBER_ID && value.metadata && String(value.metadata.phone_number_id) !== String(env.WA_PHONE_NUMBER_ID)) continue;
        for (const msg of value.messages || []) {
          const route = all[String(msg.from || '').replace(/\D/g, '')];
          if (route) messages.push([msg, route]);
        }
      }
    }
    // Answer Meta at once (it retries anything slow); the saving and the reply run after.
    if (messages.length) ctx.waitUntil(Promise.all(messages.map(([m, route]) => handleMessage(env, m, route))));
    return new Response('ok', { status: 200 });
  }
};
