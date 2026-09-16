/**
 * Telegram → Apps Script relay.
 *
 * Why this exists: Telegram's webhook delivery requires the webhook URL to
 * answer directly with a plain 200 response. Google Apps Script Web Apps
 * can't do that — every /exec call (GET or POST) answers with a 302
 * redirect to a one-time script.googleusercontent.com URL that holds the
 * real response; a normal browser or HTTP client follows that invisibly,
 * but Telegram's webhook client does not, so it always saw the bare 302
 * and silently dropped the update. This Worker sits in between: it takes
 * Telegram's POST, does the two-hop fetch against Apps Script itself
 * (which it can do transparently, the same way a browser does), and hands
 * Telegram back the final response directly — see CLAUDE.md's "Incident —
 * webhook silently dropping edits" note for the full diagnosis.
 *
 * Deploy: paste this file's contents into a Cloudflare Worker (Workers &
 * Pages → Create → paste over the template's default code) and set
 * APPS_SCRIPT_URL below to the same URL docs/app.js's API_URL uses. Then
 * point Telegram's webhook at *this Worker's* URL instead of the Apps
 * Script URL directly (admin_setTelegramWebhook in Api.gs would need its
 * WEB_APP_URL constant changed to the Worker URL — see CLAUDE.md).
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec';

// The echo redirect Apps Script issues turned out to be intermittently
// flaky when tested directly (occasional 404 or a hang on the follow-up
// fetch, not just the expected 302 → 200) — a couple of retries with a
// short backoff absorbs that without making Telegram wait too long.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;

async function fetchAppsScript(body) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow' // default, but explicit: this is what actually does the 302 → 200 hop
      });
      const text = await res.text();
      // Apps Script's own doPost always returns valid JSON with an "ok"
      // field, even for an internal error (see Api.gs) — anything else
      // (an HTML error page, an empty body) means the echo hop itself
      // failed, not the app logic, so treat it as a retryable failure.
      JSON.parse(text);
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Telegram relay is up.', { status: 200 });
    }

    const body = await request.text();

    try {
      const resultText = await fetchAppsScript(body);
      return new Response(resultText, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      // Telegram only cares that it got SOME 200 back — returning one
      // here (instead of a 5xx) stops Telegram from marking the webhook
      // itself as broken and backing off future deliveries, even on a
      // request the relay couldn't get through this time. The real
      // owner-facing entry still sits in the review queue / as pending,
      // same as it would if this request had never arrived at all.
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
