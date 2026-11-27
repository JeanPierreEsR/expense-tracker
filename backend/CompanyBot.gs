/**
 * Business 2, Phase 1, piece 5 (owner's plan, approved 2026-11-22): on a COMPANY copy the bots (WhatsApp and Telegram, through the
 * shared reader in TypedEntry.gs) read a typed line in parts, in ANY order:
 *   1. type: "ingreso", "cobré", "recibí" or "+" anywhere = income; none of them = expense;
 *   2. unit: the name of a tag that already exists (the units made with "Add units"), with or without its prefix: "depa 805",
 *      "dpto 805" or a bare "805";
 *   3. amount: the number that is not a unit: "30000", "30,000", "30 mil", "30k"; "$" or "USD" = dollars;
 *   4. concept (income only): a word of an income category: "separación" → Reservation deposits, "inicial" → Down payments,
 *      "saldo" → Sale balances;
 *   5. client (income only): a client that already exists; a new name left over in an income becomes a new client (said in the reply).
 * What is left is the description. When it cannot tell (two numbers that are both units and nothing else), it ASKS instead of guessing.
 * A line with nothing of the company's (no unit, concept or client) is read the usual way (typedReadLine_), so "25 almuerzo" works
 * as everywhere. A "depa 7" that is not a unit stays in the description, and the reply says so.
 */

var CO_UNIT_PREFIX_ = /^(?:depa|dpto|depto|departamento|unidad|dep|unit|apt)\.?$/i;
var CO_INCOME_WORD_ = /^(?:ingreso|ingresos|income|cobr[eé]|cobro|recib[ií]|received)$/i;
var CO_FILLER_ = /^(?:de|del|la|el|los|las|por|para|a|en|y|of|the|for|from|by)$/i;

function coNorm_(s) { return searchNormalize_(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim(); }

// A unit tag's own part ("Depa 805" → "805", "Tienda 1" → "tienda 1", "805" → "805").
function coUnitKey_(name) {
  var words = coNorm_(name).split(' ');
  if (words.length > 1 && CO_UNIT_PREFIX_.test(words[0])) words.shift();
  return words.join(' ');
}

// Pure: reads `text` with what this copy knows. ctx = { home, units: [{id, name, project_id, project_name, company_id}], incomeCats:
// [{id, name}], clients: [{id, name}] }. Returns null (not a company line: read it the usual way), { ask } / { askUnit } (a question
// back), or
// { type, amount, currency, description, unit, category, client, clientNew, unknownUnit }.
function companyReadLine_(text, ctx) {
  var raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  var toks = raw.split(' ').map(function (t) { return { raw: t, used: false }; });
  var type = 'expense', currency = '';
  // An income word or a "+" anywhere.
  toks.forEach(function (t) {
    var w = coNorm_(t.raw);
    if (CO_INCOME_WORD_.test(w)) { type = 'income'; t.used = true; }
    else if (t.raw === '+') { type = 'income'; t.used = true; }
    else if (/^\+/.test(t.raw)) { type = 'income'; t.raw = t.raw.slice(1); }
  });
  // Currency words and signs ("$5000", "USD", "dólares", "S/").
  toks.forEach(function (t) {
    if (t.used) return;
    var w = coNorm_(t.raw);
    if (/^(?:usd|dolares|dolar)$/.test(w) || t.raw === '$' || t.raw === 'US$') { currency = 'USD'; t.used = true; return; }
    if (/^(?:pen|soles|sol)$/.test(w) || /^S\/\.?$/i.test(t.raw)) { currency = 'PEN'; t.used = true; return; }
    var sign = /^(US\$|\$|S\/\.?)(?=\d)/i.exec(t.raw);
    if (sign) { currency = /S\//i.test(sign[1]) ? 'PEN' : 'USD'; t.raw = t.raw.slice(sign[1].length); }
  });

  // Units: an explicit prefix + its number ("depa 805", "dpto 805"), then a whole tag name ("Tienda 1"), then a bare number.
  var unitByKey = {};
  (ctx.units || []).forEach(function (u) { var k = coUnitKey_(u.name); if (k && !unitByKey[k]) unitByKey[k] = u; });
  var unit = null, unknownUnit = '';
  for (var i = 0; i < toks.length - 1 && !unit; i++) {
    if (toks[i].used || !CO_UNIT_PREFIX_.test(coNorm_(toks[i].raw))) continue;
    var key = coNorm_(toks[i + 1].raw);
    if (unitByKey[key]) { unit = unitByKey[key]; toks[i].used = toks[i + 1].used = true; }
    else if (!unknownUnit) unknownUnit = toks[i].raw + ' ' + toks[i + 1].raw;
  }
  if (!unit) {
    var normText = ' ' + toks.filter(function (t) { return !t.used; }).map(function (t) { return coNorm_(t.raw); }).join(' ') + ' ';
    (ctx.units || []).slice().sort(function (a, b) { return coNorm_(b.name).length - coNorm_(a.name).length; }).some(function (u) {
      var n = coNorm_(u.name);
      if (!/[a-z]/.test(n) || n.indexOf(' ') < 0 && !/\d/.test(n)) return false;   // a word-only tag ("Annual") is never a unit
      if (normText.indexOf(' ' + n + ' ') < 0) return false;
      var parts = n.split(' ');
      for (var s = 0; s + parts.length <= toks.length; s++) {
        var ok = true;
        for (var k = 0; k < parts.length; k++) if (toks[s + k].used || coNorm_(toks[s + k].raw) !== parts[k]) { ok = false; break; }
        if (ok) { for (var k2 = 0; k2 < parts.length; k2++) toks[s + k2].used = true; unit = u; return true; }
      }
      return false;
    });
  }
  if (unit && unknownUnit) unknownUnit = '';

  // Numbers left: an amount with "mil" / "k" after it, or a currency sign, is surely the amount; a bare number may be a unit.
  var nums = [];
  toks.forEach(function (t, idx) {
    if (t.used) return;
    var m = /^(\d[\d.,]*)(k|mil)?$/i.exec(t.raw);
    if (!m) return;
    var mult = m[2] ? 1000 : 1, sure = !!m[2];
    var next = toks[idx + 1];
    if (!m[2] && next && !next.used && /^(?:mil|k)$/i.test(next.raw)) { mult = 1000; sure = true; next.used = true; }
    var value = parseTypedAmount_(m[1].replace(/[.,]+$/, ''));
    if (!(value > 0)) return;
    nums.push({ tok: t, value: Math.round(value * mult * 100) / 100, sure: sure || !!currency, digits: m[1] });
  });
  if (!nums.length) return null;
  var amountTok = null;
  var sure = nums.filter(function (n) { return n.sure && !(unitByKey[n.digits] && nums.length > 1 && !unit); });
  var notUnits = nums.filter(function (n) { return !unitByKey[n.digits]; });
  if (sure.length === 1) amountTok = sure[0];
  else if (notUnits.length === 1) amountTok = notUnits[0];
  else if (notUnits.length === 0 && nums.length >= 2 && !unit) {
    return { ask: nums.map(function (n) { return n.digits; }) };
  } else if (notUnits.length === 0 && nums.length === 1) {
    if (unit) amountTok = nums[0];
    else return null;   // only a unit's number: no amount
  } else amountTok = notUnits[0];
  amountTok.tok.used = true;
  if (!unit) {
    var asUnit = nums.find(function (n) { return n !== amountTok && unitByKey[n.digits]; });
    if (asUnit) { unit = unitByKey[asUnit.digits]; asUnit.tok.used = true; unknownUnit = ''; }
  }
  // The same unit name in two projects (owner, 2026-11-27: each building has its "Depa 101"): a word of one project's name in the line
  // decides ("depa 101 pinos"); otherwise it asks which project instead of guessing.
  if (unit) {
    var twins = (ctx.units || []).filter(function (u) { return coUnitKey_(u.name) === coUnitKey_(unit.name); });
    if (twins.length > 1) {
      var wordsOf = function (u) { return coNorm_(u.project_name).split(' ').filter(function (w) { return w.length >= 3 && !CO_FILLER_.test(w); }); };
      var own = function (u) { return wordsOf(u).filter(function (w) { return !twins.some(function (o) { return o !== u && wordsOf(o).indexOf(w) >= 0; }); }); };
      var hit = twins.filter(function (u) { var mine = own(u); return toks.some(function (t) { return !t.used && mine.indexOf(coNorm_(t.raw)) >= 0; }); });
      if (hit.length !== 1) return { askUnit: { unit: unit.name, projects: twins.map(function (u) { return u.project_name; }) } };
      unit = hit[0];
      var mine = own(unit);
      toks.forEach(function (t) { if (!t.used && mine.indexOf(coNorm_(t.raw)) >= 0) t.used = true; });
    }
  }

  // Concept and client: income only.
  var category = null, client = null, clientNew = '';
  if (type === 'income') {
    toks.forEach(function (t) {
      if (t.used || category) return;
      var w = coNorm_(t.raw);
      if (w.length < 4) return;
      var hit = (ctx.incomeCats || []).find(function (c) {
        return coNorm_(c.name).split(' ').some(function (cw) { return cw.length >= 4 && cw.slice(0, 5) === w.slice(0, 5) && Math.abs(cw.length - w.length) <= 3; });
      });
      if (hit) { category = hit; t.used = true; }
    });
    var restText = toks.filter(function (t) { return !t.used; }).map(function (t) { return coNorm_(t.raw); }).join(' ');
    var clients = (ctx.clients || []).slice().sort(function (a, b) { return coNorm_(b.name).length - coNorm_(a.name).length; });
    client = clients.find(function (c) { return (' ' + restText + ' ').indexOf(' ' + coNorm_(c.name) + ' ') >= 0; }) || null;
    if (!client) {
      // one word that is the only client with it (their last or first name)
      var hits = {};
      toks.forEach(function (t) {
        if (t.used) return;
        var w = coNorm_(t.raw);
        if (w.length < 3) return;
        var who = clients.filter(function (c) { return coNorm_(c.name).split(' ').indexOf(w) >= 0; });
        if (who.length === 1) hits[w] = who[0];
      });
      var keys = Object.keys(hits);
      if (keys.length === 1) client = hits[keys[0]];
    }
    if (client) {
      var cn = coNorm_(client.name).split(' ');
      toks.forEach(function (t) { if (!t.used && cn.indexOf(coNorm_(t.raw)) >= 0) t.used = true; });
    } else {
      // What is left of an income, 1 to 3 words of letters (no filler, no number), is a new client.
      var left = toks.filter(function (t) { return !t.used && !CO_FILLER_.test(coNorm_(t.raw)); });
      if (left.length >= 1 && left.length <= 3 && left.every(function (t) { return /^[A-Za-zÀ-ÿ'.-]+$/.test(t.raw); })) {
        clientNew = left.map(function (t) { return t.raw.charAt(0).toUpperCase() + t.raw.slice(1); }).join(' ');
        left.forEach(function (t) { t.used = true; });
      }
    }
  }
  // Nothing of the company's: the usual reading (keeps "25 almuerzo" exactly as before).
  if (!unit && !category && !client && !clientNew && !unknownUnit) return null;

  var leftover = toks.filter(function (t) { return !t.used && !CO_FILLER_.test(coNorm_(t.raw)); }).map(function (t) { return t.raw; }).join(' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  var parts = [];
  if (leftover) parts.push(leftover.charAt(0).toUpperCase() + leftover.slice(1));
  else if (category) parts.push(category.name);
  if (unit) parts.push(unit.name);
  if (client || clientNew) parts.push(client ? client.name : clientNew);
  return {
    type: type, amount: amountTok.value, currency: currency || ctx.home, description: parts.join(' · ').slice(0, 120),
    unit: unit, category: category, client: client, clientNew: clientNew, unknownUnit: unknownUnit
  };
}

// What this copy knows, for companyReadLine_: its units (each with its project, Units.gs), income categories (in the person's language)
// and clients.
function companyBotContext_() {
  var projects = {};
  getProjectRows_().forEach(function (p) { projects[p.id] = p; });
  return {
    home: homeCurrency_(),
    units: unitsForMeta_().map(function (u) {
      var p = projects[u.project_id] || {};
      return { id: u.id, name: u.name, project_id: u.project_id, project_name: String(p.name || ''), company_id: String(p.company_id || '') };
    }),
    incomeCats: getAllRows('Categories').filter(function (c) { return c.type === 'income' && c.hidden !== 'yes'; })
      .map(function (c) { return { id: String(c.id), name: categoryLabel_(c) }; }),
    clients: getAllRows('Friends').filter(function (f) { return !f.trip_id && friendRoleOf_(f) === 'client'; }).map(function (f) { return { id: String(f.id), name: String(f.name) }; })
  };
}

// The answer line: what was understood, so a wrong reading can be corrected (the one-line reply of a capture-only WhatsApp).
function companyUnderstood_(co) {
  var bits = [tr_(co.type === 'income' ? 'coBot.income' : 'coBot.expense', { amount: formatAmountText_(co.amount, co.currency) })];
  if (co.category) bits.push(co.category.name);
  if (co.unit) bits.push(co.unit.name);
  if (co.client) bits.push(tr_('coBot.client', { name: co.client.name }));
  if (co.clientNew) bits.push(tr_('coBot.clientNew', { name: co.clientNew }));
  var line = tr_('coBot.understood', { what: bits.join(' · ') });
  var notes = companyNotes_(co, true);
  return notes ? line + '\n' + notes : line;
}

// What the transaction's own message cannot show: a new client, a unit that does not exist, an income with no concept. Sent under the
// card by both bots (TypedEntry.gs → editMessage). `withClient` false: the card already names the client, only "new" is said.
function companyNotes_(co, withClientInLine) {
  var lines = [];
  if (co.clientNew && !withClientInLine) lines.push(tr_('coBot.clientAdded', { name: co.clientNew }));
  if (co.unknownUnit) lines.push(tr_('coBot.unknownUnit', { unit: co.unknownUnit }));
  if (co.type === 'income' && !co.category) lines.push(tr_('coBot.noConcept'));
  return lines.join('\n');
}

// "Add units" (More → Categories & tags, company copies): many tags at once. A name that already exists (any case, accents) is skipped.
// payload: { names: [..] } (at most 300). Returns { added, skipped }.
function addTagsBulk(payload) {
  var names = ((payload && payload.names) || []).map(function (n) { return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40); })
    .filter(function (n) { return n; });
  if (!names.length) throw new Error(tr_('err.tagName'));
  if (names.length > 300) throw new Error(tr_('units.tooMany'));
  var seen = {};
  getAllRows('Tags').forEach(function (t) { seen[searchNormalize_(String(t.name).trim())] = true; });
  var rows = [], skipped = 0;
  names.forEach(function (n) {
    var k = searchNormalize_(n);
    if (seen[k] || isAnnualTagName_(n)) { skipped++; return; }
    seen[k] = true;
    rows.push({ id: Utilities.getUuid(), name: n, color: '' });
  });
  if (rows.length) { appendRowsBulk_('Tags', rows); bumpStructureVersion_(); }
  return { added: rows.length, skipped: skipped, tags: rows };
}
