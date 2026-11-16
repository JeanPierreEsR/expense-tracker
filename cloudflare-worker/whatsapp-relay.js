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
 *        message from a number in WA_ALLOWED_FROM, forwards { whatsapp: {id, from, text, timestamp}, relay_secret } to Apps
 *        Script and sends back on WhatsApp the short reply Apps Script wrote. Messages from any other number are dropped
 *        without an answer.
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

function allowedNumbers(env) {
  return String(env.WA_ALLOWED_FROM || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
}

async function askAppsScript(payload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
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
  if (!res.ok) console.error('WhatsApp reply failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

async function handleMessage(env, msg) {
  const payload = {
    whatsapp: { id: msg.id, from: msg.from, text: msg.type === 'text' && msg.text ? msg.text.body : '', timestamp: msg.timestamp },
    relay_secret: env.WA_RELAY_SECRET
  };
  let reply = FALLBACK_REPLY;
  try {
    const answer = await askAppsScript(payload);
    if (answer && answer.ok && answer.data && answer.data.reply) reply = answer.data.reply;
    else if (answer && answer.reply) reply = answer.reply;
    else console.error('Apps Script refused: ' + JSON.stringify(answer).slice(0, 300));
  } catch (err) {
    console.error('Apps Script unreachable: ' + err);
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

    const raw = await request.text();
    if (!(await signatureOk(env, request, raw))) return new Response('Bad signature', { status: 401 });

    let update;
    try { update = JSON.parse(raw); } catch (err) { return new Response('ok', { status: 200 }); }

    const allowed = allowedNumbers(env);
    const messages = [];
    for (const entry of update.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (env.WA_PHONE_NUMBER_ID && value.metadata && String(value.metadata.phone_number_id) !== String(env.WA_PHONE_NUMBER_ID)) continue;
        for (const msg of value.messages || []) {
          if (allowed.includes(String(msg.from || '').replace(/\D/g, ''))) messages.push(msg);
        }
      }
    }
    // Answer Meta at once (it retries anything slow); the saving and the reply run after.
    if (messages.length) ctx.waitUntil(Promise.all(messages.map((m) => handleMessage(env, m))));
    return new Response('ok', { status: 200 });
  }
};
