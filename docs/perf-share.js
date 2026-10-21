// The phone's side of "share how fast the app runs" (backend/PerfReports.gs is the receiving side).
//
// Every timed server call is also put in a small OUTBOX (localStorage, one JSON line per entry, each with a
// number `s` that only ever goes up). From time to time the app sends the oldest entries to the owner and, once the
// owner's backend says "stored up to number N", deletes exactly those from the outbox. So:
//   - nothing is sent twice (the backend also ignores any number it already holds),
//   - nothing is deleted before it is safely stored,
//   - the outbox stays small: it is emptied after every successful send, and it can never exceed MAX_CHARS
//     (when a phone has been offline for days the OLDEST lines are dropped to stay within it).
// An entry holds only timings and the name of the app action (e.g. "listEntries") — never amounts, text or names.
//
//   create(storage[, {outboxKey, seqKey}]) -> { append(entry), appendRaw(obj), status(), peek(max), ack(seq), clear() }
//   shouldSend(status, now, lastTry, lastFailed[, minBatch]) -> boolean
//   cleanLabel(text), deviceKind(userAgent, standalone)
//   SCOPE, needsAsk(state, isOwner), errorCode(err), shouldRecordError(storage, name, code, now)
//
// A second outbox (keys "betaOutbox"/"betaSeq") carries the small beta counts (a failed action's name and a short
// error code — backend/BetaEvents.gs); it works exactly like the timings one.
//
// Used by docs/app.js; also loaded by Node for tests/backend/perf-share.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PerfShare = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var OUTBOX_KEY = "perfOutbox";
  var SEQ_KEY = "perfSeq";
  var MAX_CHARS = 240000;          // about 2,000 entries; a few hundred KB at most, whatever happens
  var MIN_BATCH = 30;              // don't wake the owner's backend for a handful of entries …
  var MAX_WAIT_MS = 24 * 3600000;  // … unless the oldest one has waited this long
  var GAP_MS = 2 * 3600000;        // at least this long between sends
  var RETRY_GAP_MS = 30 * 60000;   // after a failed send

  function intOrNull(v) { return typeof v === "number" && isFinite(v) ? Math.round(v) : null; }

  // What the person agreed to share. Version 1 = app speed only; 2 = also which actions failed (name + short code).
  // A person who agreed to an older version is asked again (needsAsk) — an agreement is never widened silently.
  var SCOPE = 2;
  var MAX_REASKS = 3;               // "not now" on the new question is respected three times, then it stays at what they agreed to
  var ERR_DAY_MAX = 40;             // error entries one phone records per day …
  var ERR_PER_KIND_MAX = 5;         // … and per (action, code) per day, so one broken screen cannot flood the outbox
  var ERR_KEY = "betaErrDay";

  function create(store, opts) {
    var outboxKey = (opts && opts.outboxKey) || OUTBOX_KEY;
    var seqKey = (opts && opts.seqKey) || SEQ_KEY;
    function read() { return store.getItem(outboxKey) || ""; }

    function append(entry) {
      var s = nextSeq();
      var line = JSON.stringify({
        s: s, t: entry.t, k: entry.kind === "startup" ? "startup" : "call", n: String(entry.name || "").slice(0, 60),
        tm: intOrNull(entry.totalMs), sm: intOrNull(entry.serverMs), c: !!entry.cold,
        a: intOrNull(entry.attempts) || 1, o: entry.ok !== false
      });
      store_(line);
      return s;
    }

    function nextSeq() {
      var s = (parseInt(store.getItem(seqKey), 10) || 0) + 1;
      store.setItem(seqKey, String(s));
      return s;
    }

    function store_(line) {
      var cur = read();
      cur = cur ? cur + "\n" + line : line;
      if (cur.length > MAX_CHARS) {
        var cut = cur.indexOf("\n", Math.floor(cur.length * 0.25));
        cur = cut < 0 ? line : cur.slice(cut + 1);
      }
      store.setItem(outboxKey, cur);
    }

    // An entry made of ready-to-send short fields (the beta counts): its number goes first, as ack() expects.
    function appendRaw(obj) {
      var s = nextSeq();
      var o = { s: s };
      Object.keys(obj).forEach(function (k) { o[k] = obj[k]; });
      store_(JSON.stringify(o));
      return s;
    }

    // { count, oldestT } without parsing the whole outbox
    function status() {
      var cur = read();
      if (!cur) return { count: 0, oldestT: 0 };
      var count = 1, i = -1;
      while ((i = cur.indexOf("\n", i + 1)) !== -1) count++;
      var nl = cur.indexOf("\n");
      var first = {};
      try { first = JSON.parse(nl < 0 ? cur : cur.slice(0, nl)); } catch (e) { /* a damaged first line: treated as brand new */ }
      return { count: count, oldestT: typeof first.t === "number" ? first.t : Date.now() };
    }

    // the oldest `max` entries, in order
    function peek(max) {
      var out = [];
      var lines = read().split("\n");
      for (var i = 0; i < lines.length && out.length < max; i++) {
        if (!lines[i]) continue;
        try { out.push(JSON.parse(lines[i])); } catch (e) { /* skip a damaged line */ }
      }
      return out;
    }

    // forget every entry numbered `seq` or lower (the backend has stored them)
    function ack(seq) {
      var keep = read().split("\n").filter(function (l) {
        var m = /^\{"s":(\d+)/.exec(l);
        return m && Number(m[1]) > seq;
      });
      if (keep.length) store.setItem(outboxKey, keep.join("\n")); else store.removeItem(outboxKey);
    }

    function clear() { store.removeItem(outboxKey); }

    return { append: append, appendRaw: appendRaw, status: status, peek: peek, ack: ack, clear: clear };
  }

  // minBatch: how many entries must be waiting before the owner's backend is woken (the beta counts are rare, so they pass 1).
  function shouldSend(status, now, lastTry, lastFailed, minBatch) {
    if (!status || !status.count) return false;
    if (now - (lastTry || 0) < (lastFailed ? RETRY_GAP_MS : GAP_MS)) return false;
    return status.count >= (minBatch || MIN_BATCH) || now - status.oldestT >= MAX_WAIT_MS;
  }

  // Must a friend's phone be asked again? Yes when they agreed (on) to an older scope and did not already say "not now" three times.
  // Someone who said no is never asked again; the owner's own phone shares automatically and is never asked.
  function needsAsk(state, isOwner) {
    state = state || {};
    if (isOwner) return false;
    if (!state.asked) return true;
    return !!state.on && (state.scope || 1) < SCOPE && (state.scopeSkips || 0) < MAX_REASKS;
  }

  // The short code that goes with a failed action: the error's own code if it is a plain lower-case word, else "unknown".
  // Never the message (it could contain something the person typed).
  function errorCode(err) {
    var c = err && err.code;
    return typeof c === "string" && /^[a-z0-9_]{1,40}$/.test(c) ? c : "unknown";
  }

  // Counts today's recorded errors in `store` and says whether one more (action, code) may be recorded; if yes, counts it.
  function shouldRecordError(store, name, code, now) {
    var day = new Date(now).toISOString().slice(0, 10);
    var rec = {};
    try { rec = JSON.parse(store.getItem(ERR_KEY)) || {}; } catch (e) { rec = {}; }
    if (rec.day !== day) rec = { day: day, total: 0, per: {} };
    var key = name + ":" + code;
    if (rec.total >= ERR_DAY_MAX || (rec.per[key] || 0) >= ERR_PER_KIND_MAX) return false;
    rec.total++;
    rec.per[key] = (rec.per[key] || 0) + 1;
    try { store.setItem(ERR_KEY, JSON.stringify(rec)); } catch (e) { /* storage full: still allowed this once */ }
    return true;
  }

  // Same rule as the backend: letters, digits, spaces and . - _ ' only, starting with a letter or digit, 30 characters.
  function cleanLabel(text) {
    return String(text == null ? "" : text)
      .replace(/[^\p{L}\p{N} .\-_']/gu, "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim().slice(0, 30);
  }

  // The words the backend accepts for the phone type.
  function deviceKind(ua, standalone) {
    ua = ua || "";
    var kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
      : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
    return standalone ? kind + " (home screen)" : kind;
  }

  return {
    OUTBOX_KEY: OUTBOX_KEY, SEQ_KEY: SEQ_KEY, MAX_CHARS: MAX_CHARS, SCOPE: SCOPE, create: create, shouldSend: shouldSend,
    cleanLabel: cleanLabel, deviceKind: deviceKind, needsAsk: needsAsk, errorCode: errorCode, shouldRecordError: shouldRecordError
  };
});
