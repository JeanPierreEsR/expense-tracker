/**
 * Rule pack: simple bank e-mail rules kept as DATA in a public file (docs/setup/rules.json for friends, docs/rules/email-rules.json for the
 * owner's copy) instead of code, so a new bank reaches every copy without an "Update my app".
 *
 * How it travels: the PHONE reads the public file (it already reads setup/pin.json the same way) and hands it to the person's OWN backend
 * through `setRulePack`; the backend checks it and keeps it in the Setting `rule_pack`. No outside-connection permission is needed.
 * `emailRules_()` is then "the rules written in code (EMAIL_RULES, always first) + the pack's rules".
 *
 * A pack can only DESCRIBE what a bank prints, never run anything: words the subject/body must contain, labels printed in front of values,
 * the kind of entry. There are no regular expressions and no code, so a file from the internet can neither hang a scan nor do anything but
 * read an e-mail. Complex rules (Yape, exchange houses) stay in EMAIL_RULES.
 *
 * The pack is public: it must hold nothing private. Validation refuses digit runs, e-mail addresses (except the bank's own `sender`) and links,
 * in EVERY string of the file, known field or not. A mistake in a known field refuses the WHOLE file and the last good pack stays; a rule that
 * uses a field this backend does not know yet (written for a newer backend) is skipped on its own and listed in the status, so a schema growing
 * later never blocks the other rules on a copy that has not updated.
 *
 * Moving a bank from code to the pack (specs/review-telegram-email.md § Rule pack, "Migration"): the pack rule is a TWIN of a code rule
 * (`replaces` = that rule's label). While it is a plain twin it only runs behind the code rules; `first: true` puts it in front, the code rule
 * stays behind it as the fallback. The scan tries the next matching rule when one cannot read an e-mail (readEmailWithRules_), so neither
 * order can lose an e-mail. `rulePackTwinCheck_` (owner's copy only) compares a twin with its code rule on the real mailbox.
 */

var RULE_PACK_SETTING_ = 'rule_pack';
var RULE_PACK_STATUS_SETTING_ = 'rule_pack_status';
var RULE_PACK_MAX_CHARS_ = 40000;       // a Settings cell holds 50,000
var RULE_PACK_MAX_RULES_ = 150;
var RULE_PACK_MAX_TEXT_ = 120;
var RULE_PACK_TYPES_ = ['expense', 'income', 'transfer', 'transferIfOwn'];
var RULE_PACK_RULE_KEYS_ = ['id', 'bank', 'sender', 'label', 'skip', 'cardIsDestination', 'accountByCurrency', 'first', 'replaces', 'type', 'subjectHas', 'subjectHasAny',
  'subjectEndsWith', 'subjectIs', 'bodyHas', 'bodyHasAny', 'amount', 'merchant', 'recipient', 'description', 'last4', 'externalId'];
var RULE_PACK_ADDRESS_ = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function rulePackEscape_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Lower case without accents and with every run of spaces/line breaks as one space, so "débito" and "debito" are the same word and a
// phrase that wraps over two lines is still found. Used only for the "must contain" tests.
function rulePackFold_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' '); }

// ---- validation ----

function rulePackText_(v, what, errors, opts) {
  opts = opts || {};
  if (typeof v !== 'string' || !v.trim()) { errors.push(what + ': needs text'); return false; }
  if (v.length > RULE_PACK_MAX_TEXT_) { errors.push(what + ': too long'); return false; }
  if (/[\u0000-\u001f]/.test(v)) { errors.push(what + ': control characters'); return false; }
  if (/\d{5,}/.test(v)) { errors.push(what + ': a long number (the file is public: words only)'); return false; }
  if (/@|:\/\/|https?:|www\./i.test(v) && !opts.address) { errors.push(what + ': an address or link (the file is public)'); return false; }
  return true;
}

function rulePackWords_(list, what, errors, max) {
  if (!Array.isArray(list) || !list.length || list.length > (max || 6)) { errors.push(what + ': a short list of words is needed'); return; }
  list.forEach(function (w, i) { rulePackText_(w, what + '[' + i + ']', errors); });
}

function rulePackLabel_(spec, what, errors) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push(what + ': needs {label}'); return; }
  Object.keys(spec).forEach(function (k) { if (k !== 'label') errors.push(what + ': unknown field ' + k); });
  rulePackText_(spec.label, what + '.label', errors);
}

function rulePackCheckRule_(r, where, errors, strict) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(where + ': not a rule'); return; }
  if (strict) Object.keys(r).forEach(function (k) { if (RULE_PACK_RULE_KEYS_.indexOf(k) === -1) errors.push(where + ': unknown field ' + k); });
  rulePackText_(r.id, where + '.id', errors);
  rulePackText_(r.bank, where + '.bank', errors);
  rulePackText_(r.label, where + '.label', errors);
  if (rulePackText_(r.sender, where + '.sender', errors, { address: true }) && !RULE_PACK_ADDRESS_.test(String(r.sender))) errors.push(where + '.sender: not an e-mail address in lower case');
  if (r.replaces !== undefined) rulePackText_(r.replaces, where + '.replaces', errors);
  if (r.subjectIs !== undefined) rulePackText_(r.subjectIs, where + '.subjectIs', errors);
  ['skip', 'cardIsDestination', 'first', 'accountByCurrency'].forEach(function (k) { if (r[k] !== undefined && typeof r[k] !== 'boolean') errors.push(where + '.' + k + ': true or false'); });
  ['subjectHas', 'subjectHasAny', 'bodyHas', 'bodyHasAny'].forEach(function (k) { if (r[k] !== undefined) rulePackWords_(r[k], where + '.' + k, errors); });
  if (r.subjectEndsWith !== undefined) rulePackText_(r.subjectEndsWith, where + '.subjectEndsWith', errors);
  // A rule in front of the code rules with no words to match would take EVERY e-mail from its sender, including the kinds other rules read.
  if (r.first === true && !(r.subjectHas || r.subjectHasAny || r.subjectEndsWith || r.subjectIs || r.bodyHas || r.bodyHasAny)) errors.push(where + '.first: needs words to match');
  if (r.skip === true) return;   // an ignore rule needs only its match words

  if (RULE_PACK_TYPES_.indexOf(r.type) === -1) errors.push(where + '.type: one of ' + RULE_PACK_TYPES_.join(', '));
  if (r.type === 'transferIfOwn' && !r.recipient) errors.push(where + ': transferIfOwn needs a recipient label');
  if (r.amount !== undefined) {
    if (!r.amount || typeof r.amount !== 'object') errors.push(where + '.amount: needs {label} or {from}');
    else {
      Object.keys(r.amount).forEach(function (k) { if (k !== 'label' && k !== 'from') errors.push(where + '.amount: unknown field ' + k); });
      if (r.amount.label !== undefined) rulePackText_(r.amount.label, where + '.amount.label', errors);
      if (r.amount.from !== undefined && ['body', 'subject'].indexOf(r.amount.from) === -1) errors.push(where + '.amount.from: body or subject');
    }
  }
  if (r.merchant !== undefined) {
    var m = r.merchant;
    if (!m || typeof m !== 'object') errors.push(where + '.merchant: needs {label} or {between}');
    else {
      Object.keys(m).forEach(function (k) { if (k !== 'label' && k !== 'between') errors.push(where + '.merchant: unknown field ' + k); });
      if (m.label !== undefined) rulePackText_(m.label, where + '.merchant.label', errors);
      if (m.between !== undefined) {
        if (!Array.isArray(m.between) || m.between.length !== 2) errors.push(where + '.merchant.between: [start, end]');
        else m.between.forEach(function (w, i) { rulePackText_(w, where + '.merchant.between[' + i + ']', errors); });
      }
    }
  }
  if (r.recipient !== undefined) rulePackLabel_(r.recipient, where + '.recipient', errors);
  if (r.externalId !== undefined) rulePackLabel_(r.externalId, where + '.externalId', errors);
  if (r.description !== undefined) {
    var d = r.description;
    if (!d || typeof d !== 'object') errors.push(where + '.description: needs {labels}');
    else {
      Object.keys(d).forEach(function (k) { if (k !== 'labels' && k !== 'prefix' && k !== 'text') errors.push(where + '.description: unknown field ' + k); });
      if (d.labels !== undefined) rulePackWords_(d.labels, where + '.description.labels', errors, 3);
      if (d.prefix !== undefined) rulePackText_(d.prefix, where + '.description.prefix', errors);
      if (d.text !== undefined) rulePackText_(d.text, where + '.description.text', errors);
    }
  }
  if (r.last4 !== undefined) {
    var l = r.last4;
    if (!l || typeof l !== 'object') errors.push(where + '.last4: needs {label, kind}');
    else {
      Object.keys(l).forEach(function (k) { if (k !== 'label' && k !== 'kind') errors.push(where + '.last4: unknown field ' + k); });
      rulePackText_(l.label, where + '.last4.label', errors);
      if (['card', 'masked', 'account'].indexOf(l.kind) === -1) errors.push(where + '.last4.kind: card, masked or account');
    }
  }
}

// Every string anywhere in the file (known field or not, nested or not) is public: no long numbers, no addresses (only a rule's `sender` is one), no
// links, no control characters. Returns the first problem or ''.
function rulePackScan_(node, key, depth) {
  if (depth > 6) return 'too deep';
  if (typeof node === 'string') {
    if (node.length > RULE_PACK_MAX_TEXT_) return 'a text is too long';
    if (/[\u0000-\u001f]/.test(node)) return 'control characters';
    if (/\d{5,}/.test(node)) return 'a long number (the file is public: words only)';
    if (/:\/\/|https?:|www\./i.test(node)) return 'a link (the file is public)';
    if (/@/.test(node) && key !== 'sender') return 'an address (the file is public)';
    return '';
  }
  if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) { var a = rulePackScan_(node[i], key, depth + 1); if (a) return a; } return ''; }
  if (node && typeof node === 'object') {
    var ks = Object.keys(node);
    for (var j = 0; j < ks.length; j++) { var b = rulePackScan_(node[ks[j]], ks[j], depth + 1); if (b) return b; }
  }
  return '';
}

// Parses and checks pack text. Returns { ok:true, pack, skipped:[ids] } or { ok:false, errors:[...] } (at most 8 messages). Never throws.
// opts.strict (the repo's tests, never a phone): an unknown field is an error too, so a typo in a field name is caught when the rule is written.
function rulePackValidate_(text, opts) {
  var strict = !!(opts && opts.strict);
  var errors = [];
  var raw = String(text === undefined || text === null ? '' : text);
  if (!raw.trim()) return { ok: false, errors: ['empty'] };
  if (raw.length > RULE_PACK_MAX_CHARS_) return { ok: false, errors: ['too big'] };
  var pack;
  try { pack = JSON.parse(raw); } catch (err) { return { ok: false, errors: ['not JSON'] }; }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return { ok: false, errors: ['not a pack'] };
  var scan = rulePackScan_(pack, '', 0);
  if (scan) return { ok: false, errors: [scan] };
  if (strict) Object.keys(pack).forEach(function (k) { if (k !== 'version' && k !== 'rules') errors.push('unknown field ' + k); });
  if (typeof pack.version !== 'number' || Math.floor(pack.version) !== pack.version || pack.version < 1 || pack.version > 1000000) errors.push('version: a whole number');
  var kept = [], skipped = [];
  if (!Array.isArray(pack.rules)) errors.push('rules: a list is needed');
  else if (pack.rules.length > RULE_PACK_MAX_RULES_) errors.push('too many rules');
  else {
    var ids = {};
    pack.rules.forEach(function (r, i) {
      var where = 'rule ' + (i + 1);
      if (r && typeof r === 'object' && !Array.isArray(r) && !strict && Object.keys(r).some(function (k) { return RULE_PACK_RULE_KEYS_.indexOf(k) === -1; })) {
        skipped.push(typeof r.id === 'string' ? r.id.slice(0, 40) : where);   // written for a newer backend: this rule waits, the others load
        return;
      }
      rulePackCheckRule_(r, where, errors, strict);
      if (r && typeof r.id === 'string') { if (ids[r.id]) errors.push(where + ': id used twice'); ids[r.id] = true; }
      kept.push(r);
    });
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 8) } : { ok: true, pack: { version: pack.version, rules: kept }, skipped: skipped };
}

// ---- compiling a rule into the shape the code rules have: { bank, sender, label, match(subject, body), extract(subject, body), ... } ----

function rulePackAllIn_(words, haystack) { return words.every(function (w) { return haystack.indexOf(rulePackFold_(w)) !== -1; }); }
function rulePackAnyIn_(words, haystack) { return words.some(function (w) { return haystack.indexOf(rulePackFold_(w)) !== -1; }); }

function rulePackCompile_(r) {
  var rule = { bank: r.bank, sender: r.sender, label: r.label, fromPack: true, packId: r.id };
  if (r.first === true) rule.first = true;
  if (r.replaces) rule.replaces = r.replaces;
  // `accountByCurrency: true` = when the e-mail names no account, the money left the account called "<Bank> soles" / "<Bank> dolares" (what the
  // welcome questions name a bank's accounts, and what BCP_ACCOUNTS spells out for BCP). Not a map: a public file never names a person's accounts.
  if (r.accountByCurrency === true) rule.accountByCurrency = { PEN: r.bank + ' soles', USD: r.bank + ' dolares' };
  if (r.skip === true) rule.skip = true;
  if (r.cardIsDestination === true) rule.cardIsDestination = true;
  rule.match = function (subject, body) {
    var s = rulePackFold_(subject), b = rulePackFold_(body);
    if (r.subjectHas && !rulePackAllIn_(r.subjectHas, s)) return false;
    if (r.subjectHasAny && !rulePackAnyIn_(r.subjectHasAny, s)) return false;
    if (r.subjectIs && s.trim() !== rulePackFold_(r.subjectIs).trim()) return false;
    if (r.subjectEndsWith && s.trim().slice(-rulePackFold_(r.subjectEndsWith).length) !== rulePackFold_(r.subjectEndsWith)) return false;
    if (r.bodyHas && !rulePackAllIn_(r.bodyHas, b)) return false;
    if (r.bodyHasAny && !rulePackAnyIn_(r.bodyHasAny, b)) return false;
    return true;
  };
  if (r.skip === true) { rule.extract = function () { return null; }; return rule; }
  rule.extract = function (subject, body) {
    var amountText = r.amount && r.amount.from === 'subject' ? subject
      : (r.amount && r.amount.label ? (afterLabel_(body, rulePackEscape_(r.amount.label)) || body) : body);
    var amt = extractAmount_(amountText);
    if (!amt) return null;
    var merchant = null;
    if (r.merchant && r.merchant.label) merchant = afterLabel_(body, rulePackEscape_(r.merchant.label));
    else if (r.merchant && r.merchant.between) {
      var mm = body.match(new RegExp(rulePackEscape_(r.merchant.between[0]) + '\\s*([^\\n]+?)\\s*' + rulePackEscape_(r.merchant.between[1]), 'i'));
      merchant = mm ? mm[1].trim() : null;
    }
    var recipient = r.recipient ? afterLabel_(body, rulePackEscape_(r.recipient.label)) : null;
    var description = null;
    if (r.description && r.description.labels) {
      description = r.description.labels.map(function (l) { return afterLabel_(body, rulePackEscape_(l)); }).filter(Boolean).join(' - ') || null;
    } else if (r.description && r.description.text) description = r.description.text;
    else description = merchant || recipient;
    if (description && r.description && r.description.prefix) description = r.description.prefix + description;
    var last4 = null;
    if (r.last4) {
      last4 = r.last4.kind === 'account'
        ? extractAccountLast4_(body, rulePackEscape_(r.last4.label))
        : (r.last4.kind === 'masked'
          ? lastFourAfter_(body, rulePackEscape_(r.last4.label))
          : extractLast4_(afterLabel_(body, rulePackEscape_(r.last4.label)) || body));
    }
    var fields = { type: r.type, amount: amt.amount, currency: amt.currency, description: description, last4: last4,
      externalId: r.externalId ? afterLabel_(body, rulePackEscape_(r.externalId.label)) : null };
    if (r.merchant) fields.merchant = merchant;   // like the code rules: a transfer names no merchant
    if (r.type === 'transferIfOwn') {
      var own = isOwnAccount_(recipient);
      fields.type = own ? 'transfer' : 'expense';
      if (!own) fields.needsReview = true;
    }
    return fields;
  };
  return rule;
}

// ---- storage ----

var rulePackCache_ = { raw: null, rules: [] };

function rulePackRules_() {
  var raw = '';
  try { raw = String(getSettingsMap()[RULE_PACK_SETTING_] || ''); } catch (err) { raw = ''; }
  if (rulePackCache_.raw === raw) return rulePackCache_.rules;
  var rules = [];
  if (raw) {
    var v = rulePackValidate_(raw);   // checked again on every read: a hand-edited Settings cell can never reach the reader unchecked
    if (v.ok) rules = v.pack.rules.map(rulePackCompile_);
  }
  rulePackCache_ = { raw: raw, rules: rules };
  return rules;
}

// Every rule the app can read an e-mail with: the ones written in code first (they keep winning), then the pack's.
// A pack rule marked `first` (a twin whose code rule has been proven identical) goes in front of the code rules, which stay behind it as the fallback.
function emailRules_() {
  var pack = rulePackRules_();
  return pack.filter(function (r) { return r.first; }).concat(EMAIL_RULES, pack.filter(function (r) { return !r.first; }));
}

function rulePackStatus_() {
  var st = {};
  try { st = JSON.parse(String(getSettingsMap()[RULE_PACK_STATUS_SETTING_] || '{}')) || {}; } catch (err) { st = {}; }
  return { version: Number(st.version) || 0, count: Number(st.count) || 0, at: String(st.at || ''), error: String(st.error || ''), skipped: Array.isArray(st.skipped) ? st.skipped : [] };
}

// The door: the phone hands over the public file's text. A refused file leaves the stored pack as it was.
function setRulePack(p) {
  var text = String((p && p.text) || '');
  var v = rulePackValidate_(text);
  var now = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var old = rulePackStatus_();
  if (!v.ok) {
    setSetting_(RULE_PACK_STATUS_SETTING_, JSON.stringify({ version: old.version, count: old.count, at: old.at, error: v.errors.join('; ').slice(0, 300), tried: now }));
    throw codedError_('rule_pack_refused', 'Rule pack refused: ' + v.errors.join('; '));
  }
  setSetting_(RULE_PACK_SETTING_, JSON.stringify(v.pack));
  setSetting_(RULE_PACK_STATUS_SETTING_, JSON.stringify({ version: v.pack.version, count: v.pack.rules.length, at: now, error: '', skipped: v.skipped.slice(0, 8) }));
  return { version: v.pack.version, count: v.pack.rules.length, skipped: v.skipped.length };
}

// ---- twin check: does a pack twin read the REAL mailbox like the code rule it replaces? (owner's copy only, read-only, helper key) ----
// For every pack rule with `replaces` (the label of a code rule of the same sender) it reads the last `days` days of that sender's mail and counts:
// both match and read the same fields / read different fields (which fields), only the code rule matches (the twin would miss it), only the twin
// matches (it would read something the code rule leaves alone, and says which code rule it would take it from). Nothing is changed.
// What it returns holds no amount, name or number: field NAMES, counts, and the subject's wording with its digits hidden.
function rulePackTwinCheck_(p) {
  if (isFriendCopy_()) throw codedError_('twin_not_here', 'This check runs on the owner\'s copy only.');
  var days = Math.max(1, Math.min(90, Math.floor(Number((p || {}).days) || 30)));
  var twins = rulePackRules_().filter(function (r) { return r.replaces; });
  var report = { days: days, twins: [] };
  var bySender = {};
  twins.forEach(function (t) { (bySender[t.sender] = bySender[t.sender] || []).push(t); });
  Object.keys(bySender).forEach(function (sender) {
    var messages = gmailSearchMessages_('from:' + sender + ' newer_than:' + days + 'd', { max: 200 });
    bySender[sender].forEach(function (twin) {
      var code = EMAIL_RULES.filter(function (r) { return r.sender === sender && r.label === twin.replaces; })[0];
      var row = { id: twin.packId, replaces: twin.replaces, codeRuleFound: !!code, emails: 0, both: 0, identical: 0, different: 0, onlyCode: 0, onlyTwin: 0, fieldsDiffering: {}, ruleAttributesDiffering: [], examples: [] };
      if (code) {
        // What the rule says about the entry besides the fields it reads (which bank, which account when the e-mail names none, a card-bill payment...)
        ['bank', 'cardIsDestination', 'skip', 'rail', 'exchange', 'accountByCurrency'].forEach(function (k) {
          var x = code[k] === undefined ? null : code[k], y = twin[k] === undefined ? null : twin[k];
          if (JSON.stringify(x) !== JSON.stringify(y)) row.ruleAttributesDiffering.push(k);
        });
        messages.forEach(function (m) {
          var subject = m.getSubject(), body = m.getPlainBody();
          var codeMatches = !!code.match(subject, body), twinMatches = !!twin.match(subject, body);
          if (!codeMatches && !twinMatches) return;
          row.emails++;
          var shape = unreadSubjectShape_(subject);
          if (codeMatches && twinMatches) {
            row.both++;
            var a = code.skip ? null : code.extract(subject, body), b = twin.skip ? null : twin.extract(subject, body);
            var differing = rulePackDiffFields_(a, b);
            if (!differing.length) row.identical++;
            else {
              row.different++;
              differing.forEach(function (f) { row.fieldsDiffering[f] = (row.fieldsDiffering[f] || 0) + 1; });
              if (row.examples.length < 5) row.examples.push({ kind: 'different', subject: shape, fields: differing });
            }
          } else if (codeMatches) {
            row.onlyCode++;
            if (row.examples.length < 5) row.examples.push({ kind: 'only code rule', subject: shape });
          } else {
            row.onlyTwin++;
            var taken = EMAIL_RULES.filter(function (r) { return r.sender === sender && r.match(subject, body); })[0];
            if (row.examples.length < 5) row.examples.push({ kind: 'only twin', subject: shape, wouldTakeFrom: taken ? taken.label : '(no code rule matches it)' });
          }
        });
      }
      report.twins.push(row);
    });
  });
  return report;
}

// The names of the fields on which two readings differ (null = could not read). A missing field and null count as the same.
function rulePackDiffFields_(a, b) {
  if (!a && !b) return [];
  if (!a || !b) return ['(one rule could not read it)'];
  var out = [];
  var keys = {};
  Object.keys(a).forEach(function (k) { keys[k] = true; });
  Object.keys(b).forEach(function (k) { keys[k] = true; });
  Object.keys(keys).forEach(function (k) {
    var x = a[k] === undefined ? null : a[k], y = b[k] === undefined ? null : b[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(k);
  });
  return out;
}
