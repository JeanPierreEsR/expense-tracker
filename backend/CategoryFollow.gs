/**
 * Categories that catch up later ("Fill my history", phase 2 — 2026-10-24).
 *
 * Entries from a statement import arrive with NO category on purpose (the
 * person should not have to describe hundreds of lines before using the app).
 * This file is how they get one afterwards, with the same non-AI rule the
 * email guesser uses (CategoryGuess.gs): what the person already decided for
 * the same merchant.
 *
 *   - Follow: when the person gives one entry a category, the other
 *     UNCATEGORIZED confirmed expenses of the same merchant get it too
 *     (categoryFollowAfterEdit_). Only blanks are ever filled, and only when
 *     the merchant is not already split between categories (>= 80% of its
 *     categorized entries must agree on the one just chosen). The reply
 *     lists the ids so the phone can offer Undo (undoCategoryFollow).
 *   - Tidy my history: the uncategorized entries grouped by merchant, biggest
 *     first, each with the app's suggestion when the merchant has history
 *     (listTidyGroups); one choice per group fills the whole group
 *     (applyTidyGroups, also undoable).
 *   - A new entry saved without a category gets the same guess
 *     (guessCategoryForNewEntry_).
 *
 * "Similar descriptions" (2026-10-24): when a place has no history of its own, the guess
 * also looks at places that start with the same brand word — "WONG SAN ISIDRO" and
 * "Wong Miraflores" are one family (familyTokens_). A family needs at least two
 * categorized entries that agree (>= 80%); a place that has history of its own, even a
 * split one, is never overridden by its family.
 *
 * The matching key is the entry's `merchant` (what imports and emails store)
 * or, when it has none (manual and Spendee entries), its description
 * normalized the same way — so "Rappi" typed by hand lines up with the bank's
 * "RAPPI PERU*123".
 */

var FOLLOW_MIN_SHARE = 0.8;      // same as MERCHANT_MIN_SHARE (category guessing)
var FOLLOW_SAMPLES = 3;          // sample lines shown per group in Tidy my history
var FOLLOW_SIMILAR_MIN = 2;      // a family of similar places needs this many categorized entries before it guesses

// Words a bank puts in front of the place ("COMPRA WONG SURCO", "PAGO EN LA BODEGA"): skipped to find the brand.
var FOLLOW_SKIP_WORDS_ = ['compra', 'compras', 'consumo', 'pago', 'pagos', 'pos', 'tarjeta', 'purchase', 'payment', 'en', 'de', 'del', 'la', 'el', 'los', 'las', 'the', 'at'];
// First words that name a way of moving money, not a place: "YAPE JUAN" says nothing about the category, so such keys have no family.
var FOLLOW_CHANNEL_WORDS_ = ['yape', 'plin', 'transferencia', 'transf', 'retiro', 'deposito', 'abono', 'cargo', 'comision', 'envio', 'recarga',
  'servicio', 'pagar', 'transfer', 'withdrawal', 'deposit', 'interes', 'intereses'];

/**
 * The words a place is filed under in its family, most specific first: the first two brand words glued together
 * ("plaza vea" -> "plazavea", which also catches a bank that writes "PLAZAVEA") and the first brand word alone.
 * Nothing for a key whose brand word is a way of paying, has a digit or has fewer than 3 letters.
 */
function familyTokens_(key) {
  var t = String(key || '').split(' ').filter(Boolean);
  while (t.length && FOLLOW_SKIP_WORDS_.indexOf(t[0]) !== -1) t.shift();
  if (!t.length) return [];
  var first = t[0];
  if (first.length < 3 || /\d/.test(first) || FOLLOW_CHANNEL_WORDS_.indexOf(first) !== -1) return [];
  var out = [];
  if (t.length > 1) out.push(first + t[1]);
  out.push(first);
  return out;
}

function followKey_(e) {
  var key = e.merchant ? String(e.merchant) : normalizeMerchant_(e.description);
  return key.length >= 2 ? key : '';
}

/**
 * One pass over Entries: for every key, how the person categorized it so far
 * (peers) and which confirmed expenses still have no category (blanks).
 * A pending entry's category is only a guess, so it never counts as a peer
 * (same rule as buildGuessContext_).
 */
function scanFollow_() {
  var expenseCatIds = {};
  getAllRows('Categories').forEach(function (c) { if (c.type === 'expense') expenseCatIds[c.id] = true; });
  var groups = {}, families = {};
  function famOf(tok) { return families[tok] || (families[tok] = { key: tok, counts: {}, total: 0, blanks: [], keys: {} }); }
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'expense') return;
    var key = followKey_(e);
    if (!key) return;
    var g = groups[key] || (groups[key] = { key: key, counts: {}, total: 0, blanks: [] });
    var toks = familyTokens_(key);
    if (expenseCatIds[e.category_id]) {
      if (e.status === 'confirmed' || e.source === 'import') {
        g.counts[e.category_id] = (g.counts[e.category_id] || 0) + 1;
        g.total++;
        toks.forEach(function (t) { var f = famOf(t); f.counts[e.category_id] = (f.counts[e.category_id] || 0) + 1; f.total++; f.keys[key] = true; });
      }
    } else if (!e.category_id && e.status === 'confirmed') {
      g.blanks.push(e);
      toks.forEach(function (t) { famOf(t).blanks.push(e); });
    }
  });
  return { expenseCatIds: expenseCatIds, groups: groups, families: families };
}

/**
 * The family a key belongs to for guessing: the most specific one with categorized entries of OTHER places, or null.
 * (A family that exists but disagrees is still returned — the caller must not fall back to a broader one.)
 */
function familyFor_(scan, key) {
  var toks = familyTokens_(key);
  for (var i = 0; i < toks.length; i++) {
    var f = scan.families[toks[i]];
    // A family made only of this very place (the two glued words of "wong miraflores") says nothing about similar ones.
    if (f && f.total && Object.keys(f.keys).some(function (k) { return k !== key; })) return f;
  }
  return null;
}

/**
 * What to file an expense of this key under: { categoryId, n, total, similar } or null.
 * The place's own history wins (one earlier choice is enough, and if it is split nothing is guessed);
 * with none, the family of similar places decides (two or more agreeing entries).
 */
function categorySuggestion_(scan, key) {
  var g = scan.groups[key];
  if (g && g.total) {
    var own = followSuggestion_(g);
    return own ? { categoryId: own.categoryId, n: own.n, total: own.total, similar: false } : null;
  }
  var f = familyFor_(scan, key);
  if (!f || f.total < FOLLOW_SIMILAR_MIN) return null;
  var fs = followSuggestion_(f);
  return fs ? { categoryId: fs.categoryId, n: fs.n, total: fs.total, similar: true, via: f.key } : null;
}

// The category most of this key's categorized entries share, or null when they disagree.
function followSuggestion_(g) {
  if (!g || !g.total) return null;
  var best = null;
  Object.keys(g.counts).forEach(function (id) { if (!best || g.counts[id] > g.counts[best]) best = id; });
  return g.counts[best] / g.total >= FOLLOW_MIN_SHARE ? { categoryId: best, n: g.counts[best], total: g.total } : null;
}

/**
 * Writes `category_id` for many entries in one go (a column write, like the
 * statement import) and stamps updated_at so every phone picks the change up.
 * changes: [{ id, categoryId, expect }] — `expect` (optional) is the category
 * the entry must still have, so a stale Undo never overwrites a newer choice.
 * Returns the ids actually changed.
 */
function bulkSetEntryCategories_(changes) {
  if (!changes.length) return [];
  var want = {};
  changes.forEach(function (c) { want[c.id] = c; });
  var updatedCol = ensureEntriesUpdatedAtColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var idCol = headers.indexOf('id'), catCol = headers.indexOf('category_id');
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var cats = sheet.getRange(2, catCol + 1, lastRow - 1, 1).getValues();
  var stamps = sheet.getRange(2, updatedCol, lastRow - 1, 1).getValues();
  var stamp = nowStamp_();
  var done = [];
  for (var i = 0; i < ids.length; i++) {
    var c = want[String(ids[i][0])];
    if (!c) continue;
    var current = String(cats[i][0] || '');
    if (c.expect !== undefined && current !== String(c.expect)) continue;
    if (current === String(c.categoryId)) continue;
    cats[i][0] = c.categoryId;
    stamps[i][0] = stamp;
    done.push(String(ids[i][0]));
  }
  if (!done.length) return [];
  sheet.getRange(2, catCol + 1, cats.length, 1).setValues(cats);
  sheet.getRange(2, updatedCol, stamps.length, 1).setValues(stamps);
  bumpVersion_('ENTRIES_VERSION');
  return done;
}

// Entries just moved into Travel become Annual too (autoTagTravelEntry_ does it
// for a single edit). Returns the ids that got a NEW Annual tag, for Undo.
function annualForTravelMoves_(ids, categoryId) {
  if (!ids.length || !travelCategoryIdSet_()[categoryId]) return [];
  ensureAnnualTag_();
  var has = annualEntryIdSet_();
  var added = [];
  ids.forEach(function (id) {
    if (has[id]) return;
    appendRowObject('Entry Tags', { entry_id: id, tag_id: ANNUAL_TAG_ID });
    added.push(id);
  });
  return added;
}

function categoryNameForMessage_(categoryId) {
  var c = getAllRows('Categories').filter(function (x) { return x.id === categoryId; })[0];
  return c ? categoryLabel_(c) : '';
}

/**
 * Called by the app's updateEntry route after the person changed an entry's
 * category. Returns null when nothing followed, else
 * { count, categoryId, categoryName, ids, annualIds }.
 */
function categoryFollowAfterEdit_(entryId) {
  var e = getEntryById_(entryId);
  if (!e || e.type !== 'expense' || e.status !== 'confirmed' || !e.category_id) return null;
  var key = followKey_(e);
  if (!key) return null;
  var scan = scanFollow_();
  if (!scan.expenseCatIds[e.category_id]) return null;
  var g = scan.groups[key];
  var s = followSuggestion_(g);
  var plan = [], seen = {}, similarCount = 0;
  // The same place: its blanks follow when the place is not split between categories.
  if (g && g.blanks.length && s && s.categoryId === e.category_id) {
    g.blanks.forEach(function (b) { seen[b.id] = true; plan.push({ id: b.id, categoryId: e.category_id, expect: '' }); });
  }
  // Similar places: blanks of the same family follow when the family agrees on this category (counting the one just chosen).
  var f = familyFor_(scan, key);
  var fs = f && f.total >= FOLLOW_SIMILAR_MIN ? followSuggestion_(f) : null;
  if (fs && fs.categoryId === e.category_id) {
    f.blanks.forEach(function (b) {
      if (seen[b.id] || followKey_(b) === key) return;   // a split place of its own is left alone
      seen[b.id] = true;
      plan.push({ id: b.id, categoryId: e.category_id, expect: '' });
    });
  }
  if (!plan.length) return null;
  var ids = bulkSetEntryCategories_(plan);
  if (!ids.length) return null;
  var done = {};
  ids.forEach(function (id) { done[id] = true; });
  plan.forEach(function (p) { if (done[p.id] && !(g && g.blanks.some(function (b) { return b.id === p.id; }))) similarCount++; });
  return {
    count: ids.length, similarCount: similarCount, categoryId: e.category_id, categoryName: categoryNameForMessage_(e.category_id),
    ids: ids, annualIds: annualForTravelMoves_(ids, e.category_id)
  };
}

// updateEntry as the app calls it: same write, plus the "other entries followed" answer when the category changed.
function updateEntryFromApp_(payload) {
  // A plain edit must never change the type of an entry other records hang on (see entryTypeChangeBlock_).
  if (payload.fields && payload.fields.type !== undefined) {
    var blocked = entryTypeChangeBlock_(payload.id, payload.fields.type);
    if (blocked) throw new Error(blocked);
    // Repaid debts of a shared expense are settled first (releaseEntryRepaidLoans); never leave them open and orphaned.
    if (entryTypeChangeRepaidLoanIds_(payload.id, payload.fields.type).length) throw new Error(tr_('typeChange.pickRepayments'));
  }
  // A withdrawal is stored negative; whatever else it becomes, the amount is positive (the form always sends it; this keeps
  // any other caller from leaving a negative expense / income / transfer behind).
  if (payload.fields && payload.fields.type && payload.fields.type !== 'investment' && payload.fields.amount === undefined) {
    var before_ = getEntryById_(payload.id);
    if (before_ && before_.type === 'investment' && Number(before_.amount) < 0) payload.fields.amount = Math.abs(Number(before_.amount));
  }
  guardRepaymentEntryEdit_(payload.id, payload.fields);
  syncLoanBeforeEntryEdit_(payload.id, payload.fields);   // a loan's money entry and the loan are one: the loan follows (and may refuse)
  var before = payload.fields && payload.fields.category_id !== undefined ? (getEntryById_(payload.id) || {}).category_id : null;
  var wasExchangeLeg = !!exchangeLegSide_(getEntryById_(payload.id));
  var entry = updateEntryFields(payload.id, payload.fields);
  // No longer an exchange leg once it is another type: drop the marker so nothing treats it as one.
  if (wasExchangeLeg && entry && entry.type !== 'transfer' && entry.exchange) {
    updateRowFields_('Entries', payload.id, { exchange: '' });
    entry = getEntryById_(payload.id);
  }
  syncRepaymentAfterEntryEdit_(payload.id, payload.fields);
  if (before !== null && entry && entry.category_id && entry.category_id !== before) {
    var follow = categoryFollowAfterEdit_(payload.id);
    if (follow) return Object.assign({}, entry, { follow: follow });
  }
  return entry;
}

/**
 * Undo of a follow / tidy. payload: { changes: [{ categoryId, ids }], annualIds }.
 * Only entries that still carry that category go back to blank; the Annual
 * tags this action added are removed.
 */
function undoCategoryFollow(payload) {
  var changes = [];
  (payload.changes || []).forEach(function (c) {
    (c.ids || []).forEach(function (id) { changes.push({ id: id, categoryId: '', expect: c.categoryId }); });
  });
  var reverted = bulkSetEntryCategories_(changes);
  var annual = {};
  (payload.annualIds || []).forEach(function (id) { annual[id] = true; });
  if (Object.keys(annual).length) {
    deleteRowsWhere_('Entry Tags', function (r) { return r.tag_id === ANNUAL_TAG_ID && annual[r.entry_id]; });
  }
  return { reverted: reverted.length };
}

/**
 * Tidy my history: uncategorized confirmed expenses grouped by merchant.
 * payload: { limit } (groups, default 60). Returns
 * { groupCount (all groups), groups: [{ key, label, count, totalMain, firstDate, lastDate, suggestion: { categoryId, categoryName, n, total } | null,
 *             samples: [{ id, date, description, amount, currency }] }], totalEntries, shown }.
 * Biggest total (in the main currency) first; lines in a currency with no rate count as 0 toward the order only.
 */
function listTidyGroups(payload) {
  var limit = (payload && Number(payload.limit)) || 60;
  var scan = scanFollow_();
  var rates = buildRatesByCurrency_();
  var main = homeCurrency_();
  function toMain(e) {
    var amount = Number(e.amount) || 0;
    if (e.currency === main) return amount;
    var rate = rateToMain_(rates, e.currency, String(e.date).substring(0, 7));
    return rate != null ? amount * rate : 0;
  }
  var out = [], totalEntries = 0;
  Object.keys(scan.groups).forEach(function (key) {
    var g = scan.groups[key];
    if (!g.blanks.length) return;
    totalEntries += g.blanks.length;
    var sorted = g.blanks.slice().sort(compareEntriesRecency_);
    var total = 0, labels = {};
    sorted.forEach(function (e) {
      total += toMain(e);
      var d = String(e.description || '');
      if (d) labels[d] = (labels[d] || 0) + 1;
    });
    var label = Object.keys(labels).sort(function (a, b) { return labels[b] - labels[a]; })[0] || key;
    var s = categorySuggestion_(scan, key);
    out.push({
      key: key, label: label, count: sorted.length, totalMain: Math.round(total * 100) / 100,
      firstDate: sorted[sorted.length - 1].date, lastDate: sorted[0].date,
      suggestion: s ? { categoryId: s.categoryId, categoryName: categoryNameForMessage_(s.categoryId), n: s.n, total: s.total, similar: !!s.similar } : null,
      samples: sorted.slice(0, FOLLOW_SAMPLES).map(function (e) {
        return { id: e.id, date: e.date, description: e.description || '', amount: Number(e.amount), currency: e.currency };
      })
    });
  });
  out.sort(function (a, b) { return b.totalMain - a.totalMain || b.count - a.count; });
  return { groups: out.slice(0, limit), totalEntries: totalEntries, groupCount: out.length, shown: Math.min(limit, out.length), main: main };
}

/**
 * Applies the person's choices. payload: { items: [{ key, categoryId }] }.
 * Fills only entries that are STILL uncategorized (a second tap or another
 * phone's earlier choice is never overwritten). Reply: { count, changes: [{ categoryId, ids }], annualIds, groups }
 * — the same shape undoCategoryFollow takes back.
 */
function applyTidyGroups(payload) {
  var items = (payload && payload.items) || [];
  var scan = scanFollow_();
  var plan = [], byCat = {}, groupsDone = 0;
  items.forEach(function (it) {
    var g = scan.groups[it.key];
    if (!g || !g.blanks.length) return;
    if (!scan.expenseCatIds[it.categoryId]) throw new Error(tr_('err.categoryNotFound'));
    groupsDone++;
    g.blanks.forEach(function (b) {
      plan.push({ id: b.id, categoryId: it.categoryId, expect: '' });
      (byCat[it.categoryId] = byCat[it.categoryId] || []).push(b.id);
    });
  });
  var done = {};
  bulkSetEntryCategories_(plan).forEach(function (id) { done[id] = true; });
  var changes = [], annualIds = [];
  Object.keys(byCat).forEach(function (catId) {
    var ids = byCat[catId].filter(function (id) { return done[id]; });
    if (!ids.length) return;
    changes.push({ categoryId: catId, ids: ids });
    annualIds = annualIds.concat(annualForTravelMoves_(ids, catId));
  });
  var count = changes.reduce(function (n, c) { return n + c.ids.length; }, 0);
  return { count: count, groups: groupsDone, changes: changes, annualIds: annualIds };
}

/**
 * A new expense saved with no category: the category this merchant (or description) has history for,
 * else the one its similar places agree on, or ''. `scan` (optional) lets an import reuse one read.
 */
function guessCategoryForNewEntry_(entry, scan) {
  if (entry.type !== 'expense' || entry.category_id) return '';
  var key = followKey_(entry);
  if (!key) return '';
  var s = categorySuggestion_(scan || scanFollow_(), key);
  return s ? s.categoryId : '';
}
