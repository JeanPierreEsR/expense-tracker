/**
 * Which account paid a Diners card bill (owner, 2026-11-26).
 *
 * Diners' "Comprobante de pago" makes the transfer (To = the Diners card) but never says where the money came from. When the bill is
 * paid with an Interbank debit card, Interbank ALSO e-mails it as a purchase at "Diners Club"; that e-mail is ignored as an entry (it
 * would count the payment twice), but it names the card that paid. So, whichever of the two arrives first:
 *   - Diners first: the Interbank e-mail fills From on the waiting Diners payment (only when From is still blank);
 *   - Interbank first: the account is remembered for DINERS_PAID_FROM_HOURS_ and the Diners payment takes it when it is made.
 * They belong together when the currency and the exact amount match and they are at most DINERS_PAID_FROM_HOURS_ apart (measured on the
 * owner's mailbox: the same minute); the closest in time wins. Nothing else on the entry changes, and an account the person already
 * picked is never replaced. Built for Diners and Interbank only (owner's rule: a feature from one bank's mail is that bank's).
 */
var DINERS_PAID_FROM_HOURS_ = 12;
var DINERS_PAID_FROM_PROP_ = 'DINERS_PAID_FROM';

function dinersPaidFromSame_(currency, amount, wantCurrency, wantAmount) {
  return String(currency) === String(wantCurrency) && Math.abs(Number(amount)).toFixed(2) === Math.abs(Number(wantAmount)).toFixed(2);
}

function dinersPaidFromLoad_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(DINERS_PAID_FROM_PROP_) || '[]') || []; }
  catch (err) { return []; }
}

function dinersPaidFromSave_(list) {
  var props = PropertiesService.getScriptProperties();
  if (list.length) props.setProperty(DINERS_PAID_FROM_PROP_, JSON.stringify(list));
  else props.deleteProperty(DINERS_PAID_FROM_PROP_);
}

// The paying bank's e-mail (Interbank "consumo" at Diners Club). `paid` = { amount, currency, last4 } or null.
function dinersPaidFromBankEmail_(rule, paid, createdAt, banks, paymentMethods) {
  if (!paid) return null;
  var account = emailAccountFor_(rule, paid, banks, paymentMethods);
  var at = emailPairTime_(createdAt);
  if (!account || at === null) return null;
  var diners = banks.find(function (b) { return b.name === 'Diners'; });
  if (!diners) return null;
  var dinersCards = {};
  paymentMethods.forEach(function (pm) { if (pm.bank_id === diners.id) dinersCards[String(pm.id)] = true; });
  var best = null, bestGap = null;
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'transfer' || e.source !== 'email' || e.payment_method_id || !dinersCards[String(e.to_payment_method_id || '')]) return;
    if (e.status !== 'pending' && e.status !== 'confirmed') return;
    if (!dinersPaidFromSame_(e.currency, e.amount, paid.currency, paid.amount)) return;
    var t = emailPairTime_(e.created_at);
    if (t === null) return;
    var gap = Math.abs(t - at);
    if (gap > DINERS_PAID_FROM_HOURS_ * 3600000) return;
    if (bestGap === null || gap < bestGap) { best = e; bestGap = gap; }
  });
  if (best) {
    updateRowFields_('Entries', best.id, { payment_method_id: account.id });
    return { filled: best.id };
  }
  // The Diners e-mail has not come yet: remember which account paid.
  var list = dinersPaidFromLoad_().filter(function (w) { return Math.abs(Number(w.at) - at) <= DINERS_PAID_FROM_HOURS_ * 3600000 * 2; });
  if (!list.some(function (w) { return w.at === at && dinersPaidFromSame_(w.currency, w.amount, paid.currency, paid.amount); })) {
    list.push({ currency: paid.currency, amount: paid.amount, account: account.id, at: at });
  }
  dinersPaidFromSave_(list.slice(-20));
  return { waiting: account.id };
}

// The Diners payment being made: the account a paying bank's e-mail already named, or null. Used once: it is then forgotten.
function takeDinersPaidFrom_(fields, createdAt, paymentMethods) {
  var at = emailPairTime_(createdAt);
  if (at === null) return null;
  var list = dinersPaidFromLoad_();
  if (!list.length) return null;
  var bestI = -1, bestGap = null;
  list.forEach(function (w, i) {
    if (!dinersPaidFromSame_(w.currency, w.amount, fields.currency, fields.amount)) return;
    var gap = Math.abs(Number(w.at) - at);
    if (gap > DINERS_PAID_FROM_HOURS_ * 3600000) return;
    if (bestGap === null || gap < bestGap) { bestI = i; bestGap = gap; }
  });
  if (bestI < 0) return null;
  var account = paymentMethods.find(function (pm) { return String(pm.id) === String(list[bestI].account); }) || null;
  list.splice(bestI, 1);
  dinersPaidFromSave_(list);
  return account;
}
