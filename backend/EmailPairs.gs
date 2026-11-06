/**
 * Joining a shop's receipt with the bank's e-mail for the same charge (owner's design, 2026-11-05).
 *
 * DiDi and Apple e-mail their own receipts, and a card bank may ALSO e-mail the charge (Interbank's "pago recurrente", another bank's
 * "consumo"). Both are read; the second one to arrive does not make a new entry, it JOINS the first:
 *   - the card comes from the bank's e-mail (DiDi's receipt only says "Credit / Debit Card");
 *   - the description, category and DATE come from the receipt (owner's choice);
 *   - silent: nothing on the entry says it was joined.
 * Which shops are paired is data in the rule pack (`pairs`, RulePack.gs), so a new pair reaches every copy without new code.
 *
 * Two e-mails join when: one is the shop's receipt (from the pair's sender) and the other a bank's e-mail whose merchant contains one of the pair's
 * words; same currency and exact amount; at most EMAIL_PAIR_HOURS_ apart (measured on the owner's mailbox: DiDi 0-10 minutes, Apple 4-5 hours);
 * the earlier one not joined yet; the closest in time wins. Nothing else is touched: a lone receipt or a lone bank e-mail stays as it is.
 *
 * Entries.email_pair remembers the role: "<pair id>|receipt" / "<pair id>|bank" while waiting, "<pair id>|joined|<external id of the second
 * e-mail>" once joined (that id counts as already read, so re-reading the second e-mail never makes an entry). Past e-mails are never re-joined.
 */
var EMAIL_PAIR_HOURS_ = 12;
var EMAIL_PAIR_COLUMN_ = 'email_pair';

// The pair this e-mail belongs to and its side, or null.
function emailPairRole_(rule, fields) {
  if (!rule || !fields || fields.type !== 'expense' || fields.exchangeLeg) return null;
  var pairs = rulePackPairs_();
  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i];
    if (rule.sender === p.sender) return { pair: p, role: 'receipt' };
    if (rule.bank && rulePackAnyIn_(p.merchantHas, rulePackFold_(fields.merchant || fields.description || ''))) return { pair: p, role: 'bank' };
  }
  return null;
}

function emailPairTime_(v) {
  if (v instanceof Date) return v.getTime();
  var t = new Date(String(v || '').replace(' ', 'T')).getTime();
  return isNaN(t) ? null : t;
}

// The waiting entry of the other side that this e-mail joins, or null.
function findEmailPairPartner_(role, fields, createdAt) {
  var want = role.pair.id + '|' + (role.role === 'receipt' ? 'bank' : 'receipt');
  var at = emailPairTime_(createdAt);
  if (at === null) return null;
  var amount = Math.abs(Number(fields.amount)).toFixed(2);
  var best = null, bestGap = null;
  getAllRows('Entries').forEach(function (e) {
    if (String(e[EMAIL_PAIR_COLUMN_] || '') !== want) return;
    if (e.type !== 'expense' || e.currency !== fields.currency || Math.abs(Number(e.amount)).toFixed(2) !== amount) return;
    if (e.status !== 'pending' && e.status !== 'confirmed') return;
    var t = emailPairTime_(e.created_at);
    if (t === null) return;
    var gap = Math.abs(t - at);
    if (gap > EMAIL_PAIR_HOURS_ * 3600000) return;
    if (bestGap === null || gap < bestGap) { best = e; bestGap = gap; }
  });
  return best;
}

// Joins this e-mail into `partner`. A waiting partner takes what this e-mail knows better; a confirmed one (the person already checked it)
// only gets what it lacks.
function joinEmailPair_(partner, role, fields, externalId, dateStr, paymentMethod, categoryId) {
  var pending = partner.status === 'pending';
  var change = {};
  change[EMAIL_PAIR_COLUMN_] = role.pair.id + '|joined|' + externalId;
  if (role.role === 'bank') {
    // The receipt came first: the bank's e-mail tells which card paid.
    if (paymentMethod && (pending || !partner.payment_method_id)) change.payment_method_id = paymentMethod.id;
  } else {
    // The bank's e-mail came first: the receipt brings the name, category and date.
    if (pending) {
      if (fields.description) change.description = fields.description;
      var merchant = normalizeMerchant_(fields.merchant) || normalizeMerchant_(fields.description);
      if (merchant) change.merchant = merchant;
      if (categoryId) change.category_id = categoryId;
      change.date = dateStr;
    } else {
      if (!partner.category_id && categoryId) change.category_id = categoryId;
      if (!partner.description && fields.description) change.description = fields.description;
    }
  }
  updateRowFields_('Entries', partner.id, change);
}

// The second e-mail's id inside a joined entry's email_pair, so the scan counts it as already read.
function emailPairJoinedId_(value) {
  var parts = String(value || '').split('|');
  return parts[1] === 'joined' && parts[2] ? parts.slice(2).join('|') : '';
}
