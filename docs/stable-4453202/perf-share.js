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
//   stateFromSignin(share, current, isOwner)             the choice made on the setup page, as this phone's saved choice (or null)
//   bankSlug(name), queueEvents(entry, fields, bank)     what the person did with one pending entry (names only)
//   weekKey(ms), screenName(id), recordScreen(storage, name, now) -> entries of a finished week   screen-use counts
//   cleanFeedback(text)                                   the text of a feedback note, as it will be sent
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

  // What the person agreed to share. Version 1 = app speed only; 2 = also which actions failed (name + short code);
  // 3 = also what they did with each pending entry (confirmed / edited / discarded, and which field — never its content)
  // and how often they open each screen. A person who agreed to an older version is asked again (needsAsk) — an agreement
  // is never widened silently. Each kind is recorded only from the version that announced it (errors from 2, the rest from 3).
  var SCOPE = 3;
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

  // Is the "Help me improve the app" row in More shown? Only for a friend who has NOT agreed to what the app shares today:
  // never asked, said no, or agreed to an older version. A friend who agreed changes the choice from More → Privacy instead,
  // so the same thing is not offered twice next to "Send feedback to JP". The owner's own phone never shows it.
  function showImproveRow(state, isOwner) {
    state = state || {};
    if (isOwner) return false;
    return !(state.asked && state.on && (state.scope || 1) >= SCOPE);
  }

  // The choice made on the setup page (carried in the sign-in text, signin-link.js) becomes this phone's saved choice, so the app does not
  // ask the same question again. Returns the state to save, or null when nothing should change: no choice came along, it is the owner's phone,
  // or the person already made a choice here (an agreement is never overwritten or widened by a link). The scope is the consent version the
  // setup page SHOWED, capped at today's; an older one is asked again by needsAsk, with the "new since" note, like any older agreement.
  function stateFromSignin(share, current, isOwner) {
    if (!share || typeof share.on !== "boolean" || isOwner) return null;
    if (current && current.asked) return null;
    var scope = Math.min(Math.max(Math.floor(Number(share.scope)) || 1, 1), SCOPE);
    return { on: share.on, label: share.on ? cleanLabel(share.label) : "", asked: true, owner: false, scope: scope };
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

  // The same rule as backend/BetaEvents.gs betaSlug_: lower case, no accents, anything else becomes "_", at most 30 characters.
  function bankSlug(name) {
    var s = String(name == null ? "" : name).toLowerCase();
    if (s.normalize) s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  }

  // What the person did with ONE pending entry of the review queue, as the entries the beta outbox takes:
  //   one "queue" (confirmed = nothing changed, edited = something changed, discarded) + one "queue_edit" per changed field.
  // Names only — never the amount, text or account. `entry` is the pending entry as it was (the parser's work), `fields` what
  // was submitted on Confirm (null for a discard), `bank` the slug of where it came from.
  function num2(v) { return Math.round(Math.abs(Number(v)) * 100) / 100; }
  function queueEvents(entry, fields, bank) {
    entry = entry || {};
    if (!fields) return [{ k: "queue", n: "discarded", d: bank, v: 1 }];
    var edits = [];
    if (fields.category_id !== undefined && fields.category_id !== "") {
      if (!entry.category_id) edits.push("category_filled");
      else if (fields.category_id !== entry.category_id) edits.push("category");
    }
    if (fields.amount !== undefined && num2(fields.amount) !== num2(entry.amount)) edits.push("amount");
    if (fields.description !== undefined && String(fields.description || "").trim() !== String(entry.description || "").trim()) edits.push("description");
    ["payment_method_id", "to_payment_method_id"].some(function (f) {
      return fields[f] !== undefined && String(fields[f] || "") !== String(entry[f] || "");
    }) && edits.push("account");
    var out = [{ k: "queue", n: edits.length ? "edited" : "confirmed", d: bank, v: 1 }];
    edits.forEach(function (f) { out.push({ k: "queue_edit", n: f, d: bank, v: 1 }); });
    return out;
  }

  // ISO week ("w2026_43") of a moment, by the phone's own calendar; the week starts on Monday.
  function weekKey(ms) {
    var d = new Date(ms);
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);                       // the Thursday of this week decides the year
    var year = t.getUTCFullYear();
    var week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return "w" + year + "_" + (week < 10 ? "0" : "") + week;
  }
  function screenName(id) { return String(id || "").replace(/^screen-/, "").replace(/-/g, "_"); }

  // Counts one opening of a screen in this week's tally (kept in `store`). Returns the entries of the week that just ended,
  // when there is one: the app puts them in the beta outbox. Call with name = null just to close a finished week (at startup).
  var SCREEN_KEY = "betaScreens";
  function recordScreen(store, name, now) {
    var wk = weekKey(now);
    var rec = {};
    try { rec = JSON.parse(store.getItem(SCREEN_KEY)) || {}; } catch (e) { rec = {}; }
    var out = [];
    if (rec.week && rec.week !== wk) {
      Object.keys(rec.counts || {}).forEach(function (n) { if (rec.counts[n] > 0) out.push({ t: now, k: "screen", n: n, d: rec.week, v: Math.min(rec.counts[n], 100000) }); });
      rec = {};
    }
    if (!rec.week) rec = { week: wk, counts: {} };
    if (name) rec.counts[name] = (rec.counts[name] || 0) + 1;
    try { store.setItem(SCREEN_KEY, JSON.stringify(rec)); } catch (e) { /* storage full: the count is lost, nothing else */ }
    return out;
  }

  // The text of a feedback note exactly as it will be sent (the person sees this before Send; backend/Feedback.gs does it again):
  // e-mail addresses and long runs of digits are hidden, at most 1,000 characters.
  function cleanFeedback(text) {
    return String(text == null ? "" : text).replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, "[email]")
      .replace(/\d(?:[\s.\-]?\d){7,}/g, "[number]")
      .trim().slice(0, 1000);
  }

  return {
    bankSlug: bankSlug, queueEvents: queueEvents, weekKey: weekKey, screenName: screenName, recordScreen: recordScreen, cleanFeedback: cleanFeedback,
    OUTBOX_KEY: OUTBOX_KEY, SEQ_KEY: SEQ_KEY, MAX_CHARS: MAX_CHARS, SCOPE: SCOPE, create: create, shouldSend: shouldSend,
    cleanLabel: cleanLabel, deviceKind: deviceKind, needsAsk: needsAsk, stateFromSignin: stateFromSignin, showImproveRow: showImproveRow, errorCode: errorCode, shouldRecordError: shouldRecordError
  };
});
