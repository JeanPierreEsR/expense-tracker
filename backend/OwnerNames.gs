/**
 * Who "me" is — the person's own name(s), learned instead of typed.
 *
 * The app needs the person's own name to tell a transfer to THEMSELVES from a payment to someone else (a bank e-mail whose
 * recipient is the person's other account, a statement line "TRANSF EVA", a Yape photo of their own name). Nobody is asked:
 * each bank statement prints its holder at the top, and some bank e-mails are addressed to them by name. Every name seen is
 * remembered with WHERE it was seen (Settings `owner_names_seen`, JSON); a name only becomes the person's own once two DIFFERENT
 * documents (two accounts, or two senders) show it — one statement alone could be a joint account or someone else's.
 * The confirmed names are Settings `owner_names` (comma-separated; the same key the Yape photo reader already used). The person
 * can see, add and remove them in More → My names.
 *
 * Since slice C of the onboarding plans (2026-10-29) the person is also ASKED, on the FIRST sighting, instead of waiting for a second
 * document: Home shows "Is this you? <name> ✓ ✗" (`ownerNameAsk_`, answered by `answerOwnName`). ✓ adds the name to the confirmed ones;
 * ✗ remembers "not me" (`no: true` on the seen entry) and the name, or one that contains / is contained in it, is never asked about or
 * auto-confirmed again. A name that is the same person as a confirmed one (same words, a longer or shorter form) is never asked about.
 * A name typed in the welcome or in More → My names is confirmed at once. The two-document rule stays as the quiet path for names that
 * nobody answered.
 *
 * Names are compared as sets of words, in any order (one bank prints "SURNAME SURNAME GIVEN GIVEN", another "GIVEN GIVEN SURNAME"),
 * lower-case, without accents. Rule-based, no AI.
 */

var OWNER_NAMES_SEEN_KEY_ = 'owner_names_seen';
var OWNER_NAMES_MEMO_ = null;   // { raw, sets } — rebuilt whenever the Settings value changes

function ownerNameTokens_(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function (t) { return t.length >= 2; });
}

// A plausible person's name: 2–5 words of letters.
function ownerNameLooksReal_(name) {
  var raw = String(name || '').trim();
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/.test(raw)) return false;
  var t = ownerNameTokens_(raw);
  return t.length >= 2 && t.length <= 5;
}

// The confirmed names as lists of words.
function ownerNameSets_() {
  var raw = String(getSettingsMap().owner_names || '');
  if (OWNER_NAMES_MEMO_ && OWNER_NAMES_MEMO_.raw === raw) return OWNER_NAMES_MEMO_.sets;
  var sets = raw.split(',').map(ownerNameTokens_).filter(function (s) { return s.length >= 2; });
  OWNER_NAMES_MEMO_ = { raw: raw, sets: sets };
  return sets;
}

function ownerNamesList_() {
  return String(getSettingsMap().owner_names || '').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
}

/**
 * Is this text the person's own name? Every word of the text is a word of one of their names — so "TRANSF EVA"-style wording
 * ("EVA", "EVA CARLA") counts, and a different person who only shares one word ("EVA MARIA") does not. A single word
 * must have 3+ letters.
 */
function isOwnNameText_(text) {
  var t = ownerNameTokens_(text);
  if (!t.length || (t.length === 1 && t[0].length < 3)) return false;
  return ownerNameSets_().some(function (set) {
    return t.every(function (w) { return set.indexOf(w) !== -1; });
  });
}

/**
 * Is this (full) recipient name the person's own? Every word of one of their names is in it, so a relative who shares the
 * surname ("Ana Ramos Torres") is NOT the person.
 */
function isOwnFullName_(name) {
  var t = ownerNameTokens_(name);
  if (t.length < 2) return false;
  return ownerNameSets_().some(function (set) {
    return set.every(function (w) { return t.indexOf(w) !== -1; });
  });
}

/**
 * Like isOwnFullName_, but for a name whose LAST word is cut to an initial ("Eva Carla Ramos T." — BCP prints the second
 * surname that way). The rest of the name must match one of the person's names, with exactly that one word missing and
 * standing in for a word starting with the initial. Without a trailing initial it is just isOwnFullName_.
 */
function isOwnNameWithInitial_(name) {
  if (isOwnFullName_(name)) return true;
  var m = String(name || '').trim().match(/^(.*\S)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\.?$/);
  if (!m) return false;
  var t = ownerNameTokens_(m[1]);
  var initial = ownerNameTokens_(m[2] + m[2])[0].charAt(0);
  if (t.length < 2) return false;
  return ownerNameSets_().some(function (set) {
    var missing = set.filter(function (w) { return t.indexOf(w) === -1; });
    return missing.length === 1 && missing[0].charAt(0) === initial && t.length >= set.length - 1;
  });
}

function ownerNameKey_(tokens) { return tokens.slice().sort().join(' '); }

function ownerSeenRead_() {
  try { var o = JSON.parse(String(getSettingsMap()[OWNER_NAMES_SEEN_KEY_] || '{}')); return o && typeof o === 'object' ? o : {}; }
  catch (e) { return {}; }
}

function ownerSubset_(a, b) { return a.every(function (w) { return b.indexOf(w) !== -1; }); }

/**
 * Remembers names seen in documents: `found` is a list of { name, source } (source = which document: 'stmt:<account key>',
 * 'mail:<sender>'). A name whose words are contained in (or contain) another seen name counts as the same person, so the
 * 3-word and 4-word forms of one name support each other. Returns the names newly confirmed. Never throws.
 */
function learnOwnNames_(found) {
  try {
    var seen = ownerSeenRead_(), changed = false;
    (found || []).forEach(function (f) {
      if (!f || !ownerNameLooksReal_(f.name) || !f.source) return;
      var tokens = ownerNameTokens_(f.name), key = ownerNameKey_(tokens);
      var e = seen[key] || (seen[key] = { name: String(f.name).trim().replace(/\s+/g, ' '), sources: [] });
      if (e.sources.indexOf(f.source) === -1 && e.sources.length < 6) { e.sources.push(f.source); changed = true; }
    });
    if (!changed) return [];
    var keys = Object.keys(seen);
    if (keys.length > 40) {   // forget the oldest, but never an answered "not me"
      keys.filter(function (k) { return !seen[k].no; }).slice(0, keys.length - 40).forEach(function (k) { delete seen[k]; });
      keys = Object.keys(seen);
    }
    var current = ownerNamesList_(), added = [];
    keys.forEach(function (k) {
      var set = k.split(' '), sources = {};
      keys.forEach(function (k2) {
        var set2 = k2.split(' ');
        if (ownerSubset_(set, set2) || ownerSubset_(set2, set)) seen[k2].sources.forEach(function (s) { sources[s] = true; });
      });
      if (Object.keys(sources).length >= 2 && !ownerNameDeclined_(seen, set) && !current.some(function (n) { return ownerNameKey_(ownerNameTokens_(n)) === k; })) {
        current.push(seen[k].name); added.push(seen[k].name);
      }
    });
    setSetting_(OWNER_NAMES_SEEN_KEY_, JSON.stringify(seen));
    if (added.length) { setSetting_('owner_names', current.join(', ')); OWNER_NAMES_MEMO_ = null; }
    return added;
  } catch (err) {
    console.error('learnOwnNames_ failed: ' + err);
    return [];
  }
}

// "Eva Ramos" <a@b.c>  →  Eva Ramos (one recipient only; an address alone gives nothing).
function ownerNameFromHeader_(header) {
  var h = String(header || '').trim();
  if (!h || h.indexOf(',') !== -1 && h.indexOf('<') !== h.lastIndexOf('<')) return '';
  var m = h.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return m && ownerNameLooksReal_(m[1]) ? m[1].trim() : '';
}

// A bank e-mail addressed to the person by name teaches the app who they are (source: the bank's sender).
function learnOwnNameFromMail_(message, sender) {
  try {
    var name = ownerNameFromHeader_(message.getTo());
    if (name) learnOwnNames_([{ name: name, source: 'mail:' + String(sender || '').toLowerCase() }]);
  } catch (err) { /* learning must never stop an e-mail from being read */ }
}

// ---- "Is this you?" (Home card) ----

// Two names are the same person when the words of one are all in the other (a longer or shorter form, any order).
function ownerNameRelated_(a, b) { return ownerSubset_(a, b) || ownerSubset_(b, a); }

// Did the person answer "not me" to this name, or to one that contains / is contained in it?
function ownerNameDeclined_(seen, tokens) {
  return Object.keys(seen).some(function (k) { return seen[k].no === true && ownerNameRelated_(tokens, k.split(' ')); });
}

// Is this the same person as a name already confirmed?
function ownerNameConfirmedLike_(tokens) {
  return ownerNameSets_().some(function (set) { return ownerNameRelated_(tokens, set); });
}

/**
 * The name to ask "Is this you?" about, or ''. A seen name that looks like a person's, that is not the same person as a confirmed name and
 * was not answered "not me". Of several forms of one name (3 and 4 words) the longest is shown. Reads only Settings (cheap, in getMeta).
 */
function ownerNameAsk_() {
  var seen = ownerSeenRead_(), best = null;
  Object.keys(seen).forEach(function (k) {
    var e = seen[k], tokens = k.split(' ');
    if (e.no || !ownerNameLooksReal_(e.name) || ownerNameConfirmedLike_(tokens) || ownerNameDeclined_(seen, tokens)) return;
    if (!best) best = { tokens: tokens, name: e.name };
    else if (ownerNameRelated_(best.tokens, tokens) && tokens.length > best.tokens.length) best = { tokens: tokens, name: e.name };
  });
  return best ? best.name : '';
}

// Is this pending entry maybe a transfer to the person's own account? Only while NO name is confirmed (the app cannot tell yet): an e-mail
// expense with no category whose description is a person's full name and that carries no merchant (a transfer rule stores the recipient
// as the description; a purchase stores a merchant). The Needs review row shows a quiet "Maybe yours?".
function ownerNameMaybeOwn_(entry) {
  if (ownerNameSets_().length) return false;
  return entry.source === 'email' && entry.type === 'expense' && !entry.category_id && !entry.merchant && ownerNameLooksReal_(entry.description);
}

/** payload: { name, yes: true|false }. ✓ confirms the name now; ✗ remembers "not me". Returns the same as getOwnerNames. */
function answerOwnName(payload) {
  payload = payload || {};
  var name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  if (!ownerNameLooksReal_(name)) throw new Error(tr_('ownerNames.badName', { name: name }));
  var key = ownerNameKey_(ownerNameTokens_(name)), seen = ownerSeenRead_();
  var e = seen[key] || (seen[key] = { name: name, sources: [] });
  if (payload.yes === true) {
    delete e.no;
    var current = ownerNamesList_();
    if (!current.some(function (n) { return ownerNameKey_(ownerNameTokens_(n)) === key; })) {
      current.push(e.name);
      setSetting_('owner_names', current.join(', '));
      OWNER_NAMES_MEMO_ = null;
    }
  } else {
    e.no = true;
  }
  setSetting_(OWNER_NAMES_SEEN_KEY_, JSON.stringify(seen));
  return getOwnerNames();
}

// ---- More → My names ----

function getOwnerNames() {
  var seen = ownerSeenRead_();
  return { names: ownerNamesList_(), pending: Object.keys(seen).filter(function (k) { return !seen[k].no; }).map(function (k) { return seen[k].name; }).filter(function (n) {
    return !ownerNamesList_().some(function (c) { return ownerNameKey_(ownerNameTokens_(c)) === ownerNameKey_(ownerNameTokens_(n)); });
  }), ask: ownerNameAsk_() };
}

function saveOwnerNames(payload) {
  var names = (payload.names || []).map(function (n) { return String(n || '').trim().replace(/\s+/g, ' '); }).filter(Boolean);
  var seenKeys = {};
  names = names.filter(function (n) { var k = ownerNameKey_(ownerNameTokens_(n)); if (seenKeys[k]) return false; seenKeys[k] = true; return true; });
  var bad = names.find(function (n) { return !ownerNameLooksReal_(n); });
  if (bad) throw new Error(tr_('ownerNames.badName', { name: bad }));
  var before = ownerNamesList_();
  setSetting_('owner_names', names.join(', '));
  OWNER_NAMES_MEMO_ = null;
  // A name the person removed counts as "not me": it is not asked about or confirmed again. A name they add (or type in the welcome) is
  // confirmed at once, and clears an earlier "not me" for the same name.
  var seen = ownerSeenRead_();
  before.forEach(function (n) {
    var k = ownerNameKey_(ownerNameTokens_(n));
    if (!seenKeys[k]) { var e = seen[k] || (seen[k] = { name: n, sources: [] }); e.no = true; e.sources = []; }
  });
  Object.keys(seenKeys).forEach(function (k) { if (seen[k]) delete seen[k].no; });
  setSetting_(OWNER_NAMES_SEEN_KEY_, JSON.stringify(seen));
  return getOwnerNames();
}
