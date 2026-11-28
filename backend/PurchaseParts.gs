/**
 * Split by category (owner's plan, 2026-11-27): ONE purchase saved as linked parts.
 *
 * Every part is an ordinary expense entry with its own category, amount and friends' split, so budgets, Overview, trips and
 * Projections count each part in its own category with no change. All parts share the date, account, currency, description,
 * payer, trip, tags and company, and carry the same `purchase_id`: the id of the FIRST part (the "main" entry, the one the
 * form opens and edits). A plain entry has no purchase_id.
 *
 * Money screens see the purchase whole: a bank statement line is matched to the sum of the parts (stmtCollapsePurchases_,
 * StatementMatch.gs), Home shows one row, a friend's Loans screen one line, and deleting any part deletes the purchase.
 *
 *   saveEntryAll { ..., parts: [{ id, category_id, amount, splits }] }   the OTHER parts (the main one is the entry itself);
 *                                                                        [] = no longer split (the other parts go)
 */

// What every part has the same as the main entry.
var PURCHASE_SHARED_FIELDS_ = ['date', 'currency', 'description', 'paid_by', 'payment_method_id', 'trip_id', 'company_id', 'project_id'];
var PURCHASE_ID_RE_ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var purchaseDeleting_ = false;   // set while a purchase deletes its own parts, so each part does not delete the others again
var purchaseSyncing_ = false;    // set while the parts are written together, so each write does not copy itself to the others again

function purchaseIdOf_(entry) {
  return entry ? String(entry.purchase_id || '') : '';
}

// The other parts of the purchase this entry belongs to (never the entry itself), from one read of Entries.
function purchaseSiblings_(entry) {
  var pid = purchaseIdOf_(entry);
  if (!pid) return [];
  return getAllRows('Entries').filter(function (e) { return String(e.purchase_id || '') === pid && String(e.id) !== String(entry.id); });
}

// Why this entry cannot be split by category ('' = it can). Checked before anything is written.
function purchasePartsBlock_(main) {
  if (!main) return tr_('err.entryNotFound');
  if (main.type !== 'expense') return tr_('parts.onlyExpense');
  if (Number(main.amount) <= 0 || String(main.refund_of || '') || Number(main.paid_amount) > 0 || String(main.charge_pending || '') ||
      Number(main.igv_amount) > 0 || String(main.unit_id || '')) return tr_('parts.notThisOne');
  if (main.status !== 'confirmed') return tr_('parts.notThisOne');
  var links = getEntryRepaymentLinks({ id: main.id });
  if (links && (links.loan || links.forgiveness || links.repayment || links.repaymentExtra)) return tr_('parts.notThisOne');
  // A plain purchase that already has refunds is not split now (step 3 refunds ONE part of a purchase already split).
  if (!purchaseIdOf_(main) && purchaseRefundSummary_(main.id)) return tr_('parts.notThisOne');
  return '';
}

function cleanPurchaseParts_(parts) {
  var cats = {};
  getAllRows('Categories').forEach(function (c) { cats[String(c.id)] = c; });
  var seen = {};
  return (parts || []).map(function (p) {
    var id = String((p && p.id) || '');
    if (!PURCHASE_ID_RE_.test(id) || seen[id]) throw new Error(tr_('parts.badPart'));
    seen[id] = true;
    var amount = Math.round(Number(p.amount) * 100) / 100;
    if (!(amount > 0)) throw new Error(tr_('parts.badAmount'));
    var cat = cats[String(p.category_id || '')];
    if (!cat || cat.type !== 'expense') throw new Error(tr_('parts.pickCategory'));
    return { id: id, category_id: String(cat.id), amount: amount, splits: Array.isArray(p.splits) ? p.splits : [] };
  });
}

// Saves the other parts of the purchase whose main entry is `mainId` (already saved with its own category, amount and split).
// Parts sent with an id that is already a part are updated, new ids are created (the id is the part's client_id, so a resend
// never makes a second one), and parts no longer sent are deleted. `tagIds` = the purchase's tags (undefined = keep each part's).
function saveEntryParts_(mainId, parts, tagIds) {
  ensureColumn_('Entries', 'purchase_id');
  var main = getEntryById_(mainId);
  var clean = cleanPurchaseParts_(parts);
  if (clean.length) {
    var block = purchasePartsBlock_(main);
    if (block) throw new Error(block);
  }
  if (!main) throw new Error(tr_('err.entryNotFound'));
  var shared = { type: 'expense' };
  PURCHASE_SHARED_FIELDS_.forEach(function (k) { if (main[k] !== undefined) shared[k] = main[k] === null ? '' : main[k]; });
  var before = purchaseSiblings_(Object.assign({}, main, { purchase_id: mainId }));
  var beforeIds = {};
  before.forEach(function (e) { beforeIds[String(e.id)] = true; });
  var tags = tagIds;
  if (tags === undefined) tags = getEntryTags({ entryId: mainId });
  var kept = {};
  // A part with refunds (plan step 3) is never dropped, nor made smaller than what came back on it: checked before any write.
  var sentIds = {};
  clean.forEach(function (p) { sentIds[p.id] = true; });
  before.forEach(function (e) {
    if (!sentIds[String(e.id)] && purchaseRefundSummary_(String(e.id))) throw new Error(tr_('parts.refundedPart'));
  });
  clean.forEach(function (p) { if (beforeIds[p.id]) refundEditGuard_(p.id, { amount: p.amount }); });
  purchaseSyncing_ = true;
  try {
  clean.forEach(function (p) {
    if (beforeIds[p.id]) {
      updateEntryFields(p.id, Object.assign({}, shared, { category_id: p.category_id, amount: p.amount }));
      saveEntryTags({ entryId: p.id, tagIds: tags || [] });
    } else {
      if (getEntryById_(p.id)) throw new Error(tr_('parts.badPart'));   // an id that belongs to another entry
      createEntry(Object.assign({}, shared, { category_id: p.category_id, amount: p.amount, client_id: p.id, tag_ids: tags || [] }));
      updateRowFields_('Entries', p.id, { purchase_id: mainId });
    }
    saveEntrySplits(p.id, p.splits);   // always: a part a friend paid owes them its own share even with no split
    kept[p.id] = true;
  });
  } finally { purchaseSyncing_ = false; }
  before.forEach(function (e) {
    if (kept[String(e.id)]) return;
    purchaseDeleting_ = true;
    try { discardEntryWithRepayments_(String(e.id), undefined); }
    finally { purchaseDeleting_ = false; }
  });
  updateRowFields_('Entries', mainId, { purchase_id: clean.length ? mainId : '' });
  return { parts: clean.map(function (p) { return p.id; }) };
}

// Deleting any part deletes the whole purchase, with the same choice about repaid debts (called by discardEntryWithRepayments_
// after the entry itself is gone).
function deletePurchaseSiblings_(entry, repayments) {
  if (purchaseDeleting_ || !purchaseIdOf_(entry)) return;
  var siblings = purchaseSiblings_(entry);
  if (!siblings.length) return;
  purchaseDeleting_ = true;
  try {
    siblings.forEach(function (s) { if (getEntryById_(s.id)) discardEntryWithRepayments_(String(s.id), repayments); });
  } finally { purchaseDeleting_ = false; }
}

// A bulk delete given one part takes the whole purchase.
function expandPurchaseIds_(ids) {
  var want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  var pids = {};
  var all = getAllRows('Entries');
  all.forEach(function (e) { if (want[String(e.id)] && purchaseIdOf_(e)) pids[purchaseIdOf_(e)] = true; });
  if (!Object.keys(pids).length) return ids;
  var out = ids.slice();
  all.forEach(function (e) {
    if (pids[purchaseIdOf_(e)] && !want[String(e.id)]) { out.push(String(e.id)); want[String(e.id)] = true; }
  });
  return out;
}

// purchase id -> { total, count } over every part (confirmed or not), from one read of Entries.
function purchaseTotals_() {
  var out = {};
  getAllRows('Entries').forEach(function (e) {
    var pid = purchaseIdOf_(e);
    if (!pid) return;
    var t = out[pid] = out[pid] || { total: 0, count: 0 };
    t.total = Math.round((t.total + Number(e.amount || 0)) * 100) / 100;
    t.count++;
  });
  return out;
}

// listEntries / the search copy: each part says the whole purchase's amount and how many parts it has, so a list that shows
// only one part (a category's list) can say "120 of 160".
function addPurchaseTotals_(entries) {
  if (!entries.some(function (e) { return purchaseIdOf_(e); })) return entries;
  var totals = purchaseTotals_();
  entries.forEach(function (e) {
    var t = totals[purchaseIdOf_(e)];
    if (!t) return;
    e.purchase_total = t.total;
    e.purchase_count = t.count;
  });
  return entries;
}

// The whole purchase for the edit form, when the phone's list does not hold every part (a page cut it, or the form was opened
// from a list of one category): each part with its friends' split, main part first.
function getPurchaseParts(payload) {
  var entry = getEntryById_(String((payload && payload.id) || ''));
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  var pid = purchaseIdOf_(entry);
  if (!pid) return { purchase_id: '', parts: [] };
  var splits = {};
  getAllRows('Entry Splits').forEach(function (s) {
    (splits[s.entry_id] = splits[s.entry_id] || []).push({ friend_id: s.friend_id, amount: Number(s.amount) });
  });
  var rows = getAllRows('Entries'), loans = getAllRows('Loans');
  var parts = rows.filter(function (e) { return purchaseIdOf_(e) === pid; })
    .sort(function (a, b) { return (String(a.id) === pid ? -1 : 0) - (String(b.id) === pid ? -1 : 0); })
    .map(function (e) { return { id: String(e.id), category_id: String(e.category_id || ''), amount: Number(e.amount), splits: splits[e.id] || [],
      refunded: sumParts_(refundedParts_(String(e.id), rows, loans)) }; });   // what came back on each part (Refunds.gs)
  return { purchase_id: pid, parts: parts };
}

// A bank statement sees ONE payment for a split purchase: its parts are folded into the main entry carrying the whole amount,
// so the line matches it (and the discount / tip pairing compares the whole amount). Only for matching: nothing is written.
function stmtCollapsePurchases_(entries) {
  var groups = {};
  entries.forEach(function (e) { var pid = purchaseIdOf_(e); if (pid) (groups[pid] = groups[pid] || []).push(e); });
  var pids = Object.keys(groups).filter(function (pid) { return groups[pid].length > 1; });
  if (!pids.length) return entries;
  var carrier = {}, total = {};
  pids.forEach(function (pid) {
    var parts = groups[pid];
    carrier[pid] = parts.filter(function (e) { return String(e.id) === pid; })[0] || parts[0];
    total[pid] = Math.round(parts.reduce(function (sum, e) { return sum + Number(e.amount || 0); }, 0) * 100) / 100;
  });
  var out = [];
  entries.forEach(function (e) {
    var pid = purchaseIdOf_(e);
    if (!pid || !carrier[pid]) { out.push(e); return; }
    if (e !== carrier[pid]) return;
    out.push(Object.assign({}, e, { amount: total[pid], purchase_whole: true }));
  });
  return out;
}

// A statement's "already in the app" line for a split purchase: the whole amount and every part's category ("Gifts + Shopping").
function purchaseStmtSummary_(e, catsById, pmsById) {
  var pid = purchaseIdOf_(e);
  var parts = getAllRows('Entries').filter(function (x) { return purchaseIdOf_(x) === pid; });
  var main = parts.filter(function (x) { return String(x.id) === pid; })[0] || e;
  var total = Math.round(parts.reduce(function (sum, x) { return sum + Number(x.amount || 0); }, 0) * 100) / 100;
  var names = [];
  parts.forEach(function (x) {
    var c = catsById[x.category_id];
    var label = c ? categoryLabel_(c) : '';
    if (label && names.indexOf(label) === -1) names.push(label);
  });
  return {
    id: main.id, date: main.date, type: main.type, description: main.description,
    amount: total, currency: main.currency, status: main.status,
    category: names.join(' + '),
    account: pmsById[main.payment_method_id] ? pmsById[main.payment_method_id].nickname : '',
    to_account: pmsById[main.to_payment_method_id] ? pmsById[main.to_payment_method_id].nickname : ''
  };
}

// Undo of a Needs review confirm that split the purchase (owner, 2026-11-27: "it shouldn't be refused"): the purchase goes back
// to how it arrived — ONE waiting item with the whole amount and the first part's category; the other parts are deleted, and the
// friends' shares and the debts they made go too (owner: also when a part is shared). A debt only netted against what the
// friend owed the other way just owes again. Refused only when a friend REALLY repaid part of it, or it was forgiven: that
// money moved, and Undo must not make it vanish (the person deletes the purchase instead, which asks what to do with it).
// True when a debt made by sharing one of these entries (ids = { id: true }) was REALLY repaid or forgiven, even in part.
// A debt only netted against what the friend owed the other way does not count: undoing it just makes that debt owe again.
function sharedEntriesRepaid_(ids) {
  var loans = getAllRows('Loans').filter(function (l) { return l.origin === 'entry' && ids[String(l.entry_id)]; });
  if (!loans.length) return false;
  ensureSettlementsOffsetColumn_();
  var loanIds = {};
  loans.forEach(function (l) { loanIds[String(l.id)] = true; });
  return loans.some(function (l) { return l.status === 'forgiven' || Number(l.forgiven_parts ? loanForgivenPartsTotal_(l) : 0) > 0.004; }) ||
    getAllRows('Settlements').some(function (s) { return loanIds[String(s.loan_id)] && !s.offset_loan_id && Number(s.amount) > 0.004; });
}

// Undo of a Needs review confirm of a PLAIN entry shared with friends (owner, 2026-11-28, "build all"): like a split purchase's
// Undo, the friends' shares and the debts they made go, and it waits in Needs review again. Same refusals: a real repayment or a
// forgiveness, or a refund on it.
function unconfirmSharedEntry_(entry) {
  var id = String(entry.id);
  var ids = {};
  ids[id] = true;
  if (purchaseRefundSummary_(id)) throw new Error(tr_('review.undoRefunded'));
  if (sharedEntriesRepaid_(ids)) throw new Error(tr_('review.undoRepaid'));
  deleteEntrySplitsAndLoansForEntry_(id, false);
  setEntryField_(id, 'status', 'pending');
  return { done: true };
}

function unconfirmPurchase_(entry) {
  var pid = purchaseIdOf_(entry);
  var all = getAllRows('Entries').filter(function (e) { return purchaseIdOf_(e) === pid; });
  var main = all.filter(function (e) { return String(e.id) === pid; })[0];
  if (!main || main.source === 'manual') throw new Error(tr_('err.cannotUnconfirm'));
  var ids = {};
  all.forEach(function (e) { ids[String(e.id)] = true; });
  // A refund recorded on a part is real money back: Undo refuses, like a friend's repayment (delete the purchase instead).
  if (all.some(function (e) { return purchaseRefundSummary_(String(e.id)); })) throw new Error(tr_('parts.undoRefunded'));
  if (sharedEntriesRepaid_(ids)) throw new Error(tr_('parts.undoRepaid'));
  var total = Math.round(all.reduce(function (sum, e) { return sum + Number(e.amount || 0); }, 0) * 100) / 100;
  purchaseDeleting_ = true;
  try {
    all.forEach(function (e) { if (String(e.id) !== pid) discardEntryWithRepayments_(String(e.id), undefined); });
  } finally { purchaseDeleting_ = false; }
  deleteEntrySplitsAndLoansForEntry_(pid, false);   // the main part's shares and debts (the other parts took theirs with them)
  updateRowFields_('Entries', pid, { amount: total, purchase_id: '' });
  setEntryField_(pid, 'status', 'pending');
  return { done: true, id: pid };
}

// One part changed from anywhere but the purchase's own save (a bot reply, Tidy my history, Home's bulk edits): what every part
// shares follows on the others, so the purchase stays one payment (plan step 3; step 1 left this open). A part (not the first)
// that becomes something other than an expense leaves the purchase; a purchase left with one part is a plain entry again. The
// first part changing type is the purchase's own form (it sends no parts, and the others go there).
function syncPurchaseShared_(entryId, fields) {
  if (purchaseSyncing_ || !fields) return;
  var entry = getEntryById_(entryId);
  var pid = purchaseIdOf_(entry);
  if (!pid) return;
  purchaseSyncing_ = true;
  try {
    if (entry.type !== 'expense') {
      updateRowFields_('Entries', entryId, { purchase_id: '' });
      var rest = getAllRows('Entries').filter(function (e) { return purchaseIdOf_(e) === pid; });
      if (rest.length === 1) { updateRowFields_('Entries', String(rest[0].id), { purchase_id: '' }); return; }
      // The FIRST part left (owner, 2026-11-28): the next part becomes the purchase's first, and every part left points to it,
      // so the rest stays one purchase (the purchase's id is always its first part's id).
      if (String(entryId) === pid && rest.length) {
        var next = String(rest[0].id);
        rest.forEach(function (e) { updateRowFields_('Entries', String(e.id), { purchase_id: next }); });
      }
      return;
    }
    var shared = {};
    PURCHASE_SHARED_FIELDS_.forEach(function (k) { if (fields[k] !== undefined) shared[k] = entry[k] === null || entry[k] === undefined ? '' : entry[k]; });
    if (!Object.keys(shared).length) return;
    purchaseSiblings_(entry).forEach(function (s) {
      var differs = Object.keys(shared).some(function (k) { return String(s[k] == null ? '' : s[k]) !== String(shared[k]); });
      if (differs) updateEntryFields(String(s.id), shared);
    });
  } finally { purchaseSyncing_ = false; }
}

// A bot's card for a split purchase: the whole amount and each part ("Gifts 120.00 · Shopping 40.00"), so a reply is understood
// as being about the purchase. Null for a plain entry.
function purchaseBotLines_(entry) {
  var pid = purchaseIdOf_(entry);
  if (!pid) return null;
  var parts = getAllRows('Entries').filter(function (e) { return purchaseIdOf_(e) === pid; });
  if (parts.length < 2) return null;
  parts.sort(function (a, b) { return (String(a.id) === pid ? -1 : 0) - (String(b.id) === pid ? -1 : 0); });
  var cats = rowsById_(getAllRows('Categories'));
  var total = Math.round(parts.reduce(function (sum, e) { return sum + Number(e.amount || 0); }, 0) * 100) / 100;
  return {
    amount: entry.currency + ' ' + moneyFmt_(total),
    parts: tr_('bot.partsLine', { parts: parts.map(function (e) { return (cats[e.category_id] ? categoryLabel_(cats[e.category_id]) : '?') + ' ' + moneyFmt_(e.amount); }).join(' · ') })
  };
}
