// ---- Investment platforms ----
//
// Inteligo, Hapi, Prestamype, Binance… are Payment Methods of type
// `investment`. They hold no balance of their own and never appear in the
// Balances card — this app only tracks cash moved to/from them, not what
// the money is worth (see CLAUDE.md § Investment platforms).
//
// A deposit is an `investment` Entry: payment_method_id = the account the
// money left, to_payment_method_id = the platform. A withdrawal is the same
// entry with a NEGATIVE amount (money coming back), so the account balance
// and the Investments total both move the right way with no extra field.
// "Invested so far" per platform = the sum of its entries' amounts, per
// currency, never converted.

var INVESTMENT_PLATFORMS = [
  { nickname: 'Inteligo' },
  { nickname: 'Hapi' },
  { nickname: 'Prestamype' },
  { nickname: 'Binance' }
];

// Investments carry no category in the app (owner's decision, 2026-10-01 —
// "not yet"), but Projections and the per-category views are built from
// categories, so an investment with none would silently drop out of them.
// The backend therefore quietly files every investment under one hidden-in-
// the-UI default category, "Investments" (created on first need). Used by
// createEntry, updateEntryFields, confirmEntryWithLearning_ and the
// Telegram "type investment" edit.
function defaultInvestmentCategoryId_() {
  var cats = getAllRows('Categories');
  var found = cats.find(function (c) { return c.type === 'investment' && String(c.name).trim().toLowerCase() === 'investments'; });
  if (found) return found.id;
  var id = Utilities.getUuid();
  appendRowObject('Categories', {
    id: id, name: 'Investments', type: 'investment', icon: '📈',
    color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length], parent_id: ''
  });
  return id;
}

// Runs with the 15-minute automation: files any investment that has no
// investment category (e.g. one confirmed before this rule existed) under the
// default one. Cheap and a no-op once everything is filed.
function backfillInvestmentCategories_() {
  var cats = getAllRows('Categories');   // read once, not per entry
  var bad = getAllRows('Entries').filter(function (e) {
    return e.type === 'investment' && needsInvestmentCategory_(e.category_id, cats);
  });
  if (!bad.length) return 0;
  var defaultId = defaultInvestmentCategoryId_();
  bad.forEach(function (e) { setEntryField_(e.id, 'category_id', defaultId); });
  return bad.length;
}

// True when `categoryId` is missing or isn't an investment category.
function needsInvestmentCategory_(categoryId, cats) {
  if (!categoryId) return true;
  var cat = (cats || getAllRows('Categories')).find(function (c) { return c.id === categoryId; });
  return !cat || cat.type !== 'investment';
}

// Net cash put into each platform (confirmed entries only), one line per
// currency, plus a PEN total at the latest rate on file (null when a
// currency has no rate at all).
function listInvestmentPlatforms() {
  var pms = getAllRows('Payment Methods').filter(function (pm) { return pm.type === 'investment'; });
  if (!pms.length) return [];
  var month = todayMonthKey_();
  var totalsByPm = {};
  confirmedEntries_().forEach(function (e) {
    if (e.type !== 'investment' || !e.to_payment_method_id) return;
    var cur = e.currency || 'PEN';
    var t = totalsByPm[e.to_payment_method_id] || (totalsByPm[e.to_payment_method_id] = {});
    t[cur] = (t[cur] || 0) + Number(e.amount);
  });
  return pms.map(function (pm) {
    var totals = totalsByPm[pm.id] || {};
    var totalPen = 0;
    var lines = Object.keys(totals).map(function (cur) {
      var amount = Math.round(totals[cur] * 100) / 100;
      var rate = cur === 'PEN' ? 1 : getLatestRateOnOrBefore_(cur, month);
      if (rate == null || totalPen == null) totalPen = null;
      else totalPen += amount * rate;
      return { currency: cur, amount: amount };
    }).filter(function (l) { return Math.abs(l.amount) > 0.004; });
    return {
      id: pm.id,
      nickname: pm.nickname,
      lines: lines,
      total_pen: totalPen == null ? null : Math.round(totalPen * 100) / 100
    };
  }).sort(function (a, b) {
    return (b.total_pen == null ? -Infinity : b.total_pen) - (a.total_pen == null ? -Infinity : a.total_pen);
  });
}

/**
 * One-off setup (idempotent, dry-run unless payload.dryRun === false):
 * creates the four platforms as `investment` payment methods and the
 * income category "Investment returns" (interest/dividends paid straight
 * into a bank account).
 */
function adminSetupInvestmentPlatforms(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, createdPaymentMethods: [], createdCategory: null };

  var pms = getAllRows('Payment Methods');
  INVESTMENT_PLATFORMS.forEach(function (p) {
    var exists = pms.some(function (pm) { return String(pm.nickname).trim().toLowerCase() === p.nickname.toLowerCase(); });
    if (exists) return;
    report.createdPaymentMethods.push(p.nickname);
    if (!dryRun) addPaymentMethod({ nickname: p.nickname, type: 'investment' });
  });

  var cats = getAllRows('Categories');
  if (!cats.some(function (c) { return c.type === 'income' && c.name === 'Investment returns'; })) {
    report.createdCategory = 'Investment returns';
    if (!dryRun) {
      appendRowObject('Categories', {
        id: Utilities.getUuid(), name: 'Investment returns', type: 'income', icon: '📈',
        color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length], parent_id: ''
      });
    }
  }
  return report;
}

// Sheet menu item 18: shows what would be created, and only creates it
// after a confirmation.
function menuSetupInvestmentPlatforms() {
  var ui = SpreadsheetApp.getUi();
  var preview = adminSetupInvestmentPlatforms({ dryRun: true });
  if (!preview.createdPaymentMethods.length && !preview.createdCategory) {
    ui.alert('Everything is already set up. Nothing to create.');
    return;
  }
  var lines = [];
  if (preview.createdPaymentMethods.length) lines.push('Platforms: ' + preview.createdPaymentMethods.join(', '));
  if (preview.createdCategory) lines.push('Income category: ' + preview.createdCategory);
  var answer = ui.alert('Create these?', lines.join('\n'), ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  adminSetupInvestmentPlatforms({ dryRun: false });
  ui.alert('Done.');
}

// Self-heal: the first time the app loads and no investment platform
// exists yet, create the starter set (same as menu item 18). Never runs
// again once any platform exists.
function ensureInvestmentPlatforms_() {
  var any = getAllRows('Payment Methods').some(function (pm) { return pm.type === 'investment'; });
  if (!any) adminSetupInvestmentPlatforms({ dryRun: false });
}
