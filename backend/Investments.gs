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
    color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'investments'
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
  if (!hasInvestmentReturnsCategory_(cats)) {
    report.createdCategory = 'Investment returns';
    if (!dryRun) createInvestmentReturnsCategory_(cats);
  }
  return report;
}

function hasInvestmentReturnsCategory_(cats) {
  return cats.some(function (c) { return c.type === 'income' && c.name === 'Investment returns'; });
}

function createInvestmentReturnsCategory_(cats) {
  appendRowObject('Categories', {
    id: Utilities.getUuid(), name: 'Investment returns', type: 'income', icon: '📈',
    color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'investment_returns'
  });
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
  // A friend's copy starts with NO platforms (owner, 2026-10-20): the welcome step lets them add their own, and deleting the
  // last one must not bring the owner's four back. Only the "Investment returns" income category is kept for them.
  if (isFriendCopy_()) {
    var cats = getAllRowsCached_('Categories');
    if (!hasInvestmentReturnsCategory_(cats)) createInvestmentReturnsCategory_(cats);
    return;
  }
  var any = getAllRows('Payment Methods').some(function (pm) { return pm.type === 'investment'; });
  if (!any) adminSetupInvestmentPlatforms({ dryRun: false });
}

// ---- First-use Investments practice ----
// The practice adds a platform named like this (both languages), records a deposit and a withdrawal with it and hides/removes it again.
// Nothing here is ever an alert or a learning rule: budgets count expenses only, the payee/category memory is read from the entries (which
// are deleted below), and Telegram never hears about a confirmed manual entry.
function isPracticePlatform_(pm) {
  return !!pm && String(pm.type) === 'investment' && /^(Practice platform|Plataforma de práctica)$/.test(String(pm.nickname || '').trim());
}
function isPracticeInvestmentEntry_(e) {
  return !!e && String(e.type) === 'investment' && /^(Practice deposit|Depósito de práctica|Practice withdrawal|Retiro de práctica)$/.test(String(e.description || '').trim());
}

// The Investments practice cleanup in ONE call: the practice's deposit and withdrawal entries (dated since the practice started),
// then every platform named like the practice's. A REAL entry that points at the practice platform is never deleted, only unpointed
// (its platform cleared). A platform something else still uses is kept (and counted in `kept`).
//   payload: { started_on }   Returns { entries, platforms, unlinked, kept }.
function removePracticeInvestments(payload) {
  return withScriptLockOnce_(function () {
    var out = { entries: 0, platforms: 0, unlinked: 0, kept: 0 };
    var startedOn = String((payload && payload.started_on) || '');
    var platforms = getAllRows('Payment Methods').filter(isPracticePlatform_);
    var ids = {};
    platforms.forEach(function (pm) { ids[String(pm.id)] = true; });
    getAllRows('Entries').forEach(function (e) {
      if (isPracticeInvestmentEntry_(e) && (!startedOn || String(e.date) >= startedOn)) {
        deleteEntry_(e.id);
        out.entries++;
      } else if (ids[String(e.to_payment_method_id || '')] || ids[String(e.payment_method_id || '')]) {
        if (ids[String(e.to_payment_method_id || '')]) setEntryField_(e.id, 'to_payment_method_id', '');
        if (ids[String(e.payment_method_id || '')]) setEntryField_(e.id, 'payment_method_id', '');
        out.unlinked++;
      }
    });
    if (ROWS_MEMO_) delete ROWS_MEMO_['Entries'];
    platforms.forEach(function (pm) {
      try { deletePaymentMethod({ id: String(pm.id) }); out.platforms++; }
      catch (err) { out.kept++; }   // something else uses it (a statement, a loan): it stays, hidden from the pickers
    });
    return out;
  });
}
