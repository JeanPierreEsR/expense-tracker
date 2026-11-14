/**
 * Web App API. The frontend sends a POST with a JSON body:
 *   { accessCode, action, payload }
 * Using Content-Type: text/plain avoids a CORS preflight, which Apps
 * Script web apps don't handle — this is the standard workaround.
 *
 * This same URL also receives Telegram's webhook deliveries (see
 * enableTelegramWebhook in Telegram.gs) — a Telegram update always carries
 * update_id and never our accessCode/action shape, so it's routed to
 * handleTelegramUpdate_ before the frontend-API handling below even looks
 * at accessCode. Telegram doesn't read the response body, just needs 200.
 */

// Performance tracking: doPost stamps each frontend response with how long
// the server itself spent (serverMs) and whether this request was the first
// one served by a freshly started script instance (coldInstance — module
// globals reset on every cold start). The app compares serverMs with its own
// round-trip time to tell network/wake-up delay from real Sheet work.
var PERF_INSTANCE_WARM_ = false;

// A Sheet cell not set to text turns 0123 into 123: read as what was meant.
function pmLast4_(v) { var s = String(v === undefined || v === null ? '' : v).trim(); return /^\d{1,3}$/.test(s) ? ('000' + s).slice(-4) : s; }

function doPost(e) {
  var perfStart = Date.now();
  var perfCold = !PERF_INSTANCE_WARM_;
  PERF_INSTANCE_WARM_ = true;
  RATES_MEMO_ = null;   // never carry rates over from a previous request
  HOME_CURRENCY_MEMO_ = null;   // nor the main currency (HomeCurrency.gs)
  RATE_BASE_MEMO_ = null;       // nor the rates' base currency
  RATE_FORM_MEMO_ = null;       // nor how its rows read (RatesUsd.gs)
  STMT_COVERAGE_MEMO_ = null;   // nor statement coverage (see Balances.gs)
  REQUEST_LANG_ = null;         // nor the previous request's language (see Strings.gs)
  var response;
  try {
    var body = JSON.parse(e.postData.contents);
    // The app tells us which language the person is using; everything this
    // request says back (errors, labels, category names) follows it.
    if (body && body.lang) REQUEST_LANG_ = normalizeLang_(body.lang);

    if (body && body.ping === true) {
      // Keep-warm ping (see pingWebApp_ in Triggers.gs) — answered before
      // the access-code check since it carries none and needs no data,
      // just to have actually run doPost on this instance.
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body && body.update_id !== undefined) {
      // The URL of this web app is public, so anyone can POST something that
      // looks like a Telegram update. Once the owner has turned on webhook
      // protection (sheet menu 24), only updates carrying the shared secret —
      // added by the Cloudflare relay after it verified Telegram's own header —
      // are handled. Not configured yet = accepted as before.
      if (!isTelegramRelayAuthorized_(body)) {
        recordFailedAccessAttempt_('telegram webhook');
        return ContentService.createTextOutput(JSON.stringify({ ok: false }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      // Telegram webhooks are "at least once" delivery — if doPost is slow
      // to respond (Apps Script cold start, a slow Sheet write), Telegram
      // can retry the same update, which would otherwise run
      // handleTelegramUpdate_ (and its Confirm/Discard reply) twice.
      if (!isDuplicateTelegramUpdate_(body.update_id)) {
        try {
          handleTelegramUpdate_(body);
        } catch (err) {
          // Never let one bad update fail the webhook delivery — repeated
          // failures make Telegram back off and eventually stop retrying.
          Logger.log('Telegram webhook error: ' + err.message);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body && body.action === 'login') {
      // The one request that needs no key: it trades the access code for a
      // session key (see Auth.gs), behind its own lockout.
      response = { ok: true, data: loginWithCode_(body.payload || {}) };
    } else if (body && body.action === 'reportBankSample') {
      // A redacted e-mail sample from a friend's phone: needs no sign-in, so BankSamples.gs validates every field.
      response = { ok: true, data: reportBankSample_(body.payload || {}) };
    } else if (body && body.action === 'reportStatementSample') {
      // A redacted bank STATEMENT (text only) from a friend's phone: no sign-in either; StatementSamples.gs validates every field.
      response = { ok: true, data: reportStatementSample_(body.payload || {}) };
    } else if (body && body.action === 'reportPerf') {
      // App-speed numbers from a friend's phone: needs no sign-in, so PerfReports.gs validates every field.
      response = { ok: true, data: reportPerf_(body.payload || {}) };
    } else if (body && body.action === 'reportBeta') {
      // Setup-step and error counts from a friend's phone / the installer page: no sign-in either; BetaEvents.gs validates every field.
      response = { ok: true, data: reportBeta_(body.payload || {}) };
    } else if (body && body.action === 'reportFeedback') {
      // A note a friend wrote on purpose ("Send feedback to JP"): no sign-in either; Feedback.gs validates every field.
      response = { ok: true, data: reportFeedback_(body.payload || {}) };
    } else if (!authenticateRequest_(body)) {
      recordFailedAccessAttempt_('app');
      response = { ok: false, error: tr_('auth.invalidCode'), code: 'invalid_access_code' };
    } else {
      healWebAppUrl_(body.apiUrl);   // learns this copy's own address from the app (Features.gs)
      var payload = body.payload || {};
      var thenReads = payload._then;   // reads the app wants back with this save (see runThenReads_)
      if (thenReads) delete payload._then;
      response = { ok: true, data: routeActionOnce_(body.action, payload) };
      if (thenReads) response.then = runThenReads_(thenReads);
    }
  } catch (err) {
    response = { ok: false, error: err.message, code: err.code || undefined };
  }
  response.serverMs = Date.now() - perfStart;
  response.coldInstance = perfCold;
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// Actions that CREATE something and are not safe to run twice. The app
// resends a request on its own when no reply arrives (slow Apps Script
// start, dropped connection — see callApi in app.js), and if the first
// copy had actually reached the server the second would be applied again:
// that is how one 500 repayment got recorded twice (CHANGELOG.md,
// 2026-10-01). The app stamps each such request with a `_requestId` that
// stays the same across its resends; the first run's result is remembered
// for 6 hours and handed back for any repeat, instead of running again.
// The lock makes a repeat that arrives WHILE the first is still running
// wait for it, then get its result.
var ONCE_ACTIONS_ = {
  createEntry: 1, recordCurrencyExchange: 1, recordRepayment: 1, convertEntryToRepayment: 1, convertEntryToLoan: 1, convertLoanToEntry: 1, convertLoanToRepayment: 1, convertLoanToLoan: 1, convertRepaymentToEntry: 1, convertRepaymentToLoan: 1, convertRepaymentToRepayment: 1,
  recordOverpaymentIncome: 1, recordOverpaymentExpense: 1, recordTripSettlement: 1,
  addCompany: 1, addProject: 1, addExpectedPayment: 1, addIgvPayment: 1,   // Business pack (Business.gs): a resend must not create a second one
  addLoan: 1, addFriend: 1, addRecurringExpense: 1,
  saveEntryAll: 1,   // may create an entry (the lock also keeps a resend from running next to the first)
  exportData: 1,   // a resend must not email the same files twice
  // The two long statement writes: the app waits at most 150 s for them, but a resend that does arrive must not run a second copy
  // next to the first (the lock below makes it wait, then get the first one's answer).
  applyStatementDecisions: 1, undoStatementBatch: 1,
  applyTidyGroups: 1,   // a resend must not run a second copy next to the first
  assignEntryAccounts: 1   // the same for filling accounts (NoAccount.gs)
};

// Speed (2026-11-02): the app can ask a save to bring back the lists it reloads right after (payload._then =
// [[action, payload], …]); each costs the phone a whole extra trip to Google otherwise (~2.5 s). Only looking actions
// (get…/list…), at most 5; each answers { ok, data } or { ok: false } on its own, never failing the save that already
// happened. Capability thenReads.
function runThenReads_(reads) {
  if (!Array.isArray(reads)) return [];
  return reads.slice(0, 5).map(function (r) {
    var action = r && r[0];
    if (typeof action !== 'string' || !/^(get|list)[A-Z]/.test(action)) return { ok: false };
    try { return { ok: true, data: routeAction(action, (r[1] && typeof r[1] === 'object') ? r[1] : {}) }; }
    catch (e) { return { ok: false }; }
  });
}

function routeActionOnce_(action, payload) {
  var id = payload && payload._requestId;
  if (!id || !ONCE_ACTIONS_[action]) return routeAction(action, payload);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cache = CacheService.getScriptCache();
    var key = 'req:' + id;
    var seen = cache.get(key);
    if (seen !== null) return JSON.parse(seen);
    var result = routeAction(action, payload);
    try {
      cache.put(key, JSON.stringify(result === undefined ? null : result), 21600);
    } catch (cacheErr) {
      // Too big or cache unavailable — the action itself already succeeded.
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

// Speed (2026-11-02): a call that only LOOKS (get…/list…) reads each sheet from Google once and reuses it (withRowsMemo_);
// these used to re-read the same sheet 2-9 times per call. getMeta repairs sheets as it goes, so it stays as it was (the
// start-up bundle handles its own memory). Anything that opens a sheet to change it drops that sheet's copy (getSheet).
var MEMO_SKIP_ACTIONS_ = { getMeta: 1, getStartupBundle: 1 };

function routeAction(action, payload) {
  if (/^(get|list)[A-Z]/.test(action) && !MEMO_SKIP_ACTIONS_[action]) {
    return withRowsMemo_(function () { return routeActionSwitch_(action, payload); });
  }
  return routeActionSwitch_(action, payload);
}

function routeActionSwitch_(action, payload) {
  switch (action) {
    case 'logout': return logout();
    case 'listSessions': return listSessions();
    case 'revokeSession': return revokeSession(payload);
    case 'revokeOtherSessions': return revokeOtherSessions();
    case 'getMeta': ensureEntriesEditTrigger_(); return getMeta();   // once per copy: manual Sheet edits keep loans / repayments in step (EditSync.gs)
    case 'setLanguage': return setLanguage(payload);
    case 'listSampleEmails': return listSampleEmails(payload);
    case 'getSampleEmail': return getSampleEmail(payload);
    case 'saveOnboarding': return saveOnboarding(payload);
    case 'saveDateOrder': return saveDateOrder(payload);
    case 'eraseEverything': return eraseEverything(payload);
    case 'setExtraOff': return setExtraOff(payload);
    case 'setExtraOn': return setExtraOn(payload);
    case 'takeBackPermissions': return takeBackPermissions(payload);
    case 'saveOnboardingAccounts': return saveOnboardingAccounts(payload);
    case 'saveOnboardingPlatforms': return saveOnboardingPlatforms(payload);
    case 'saveRailLinks': return saveRailLinks(payload);
    case 'getStartupBundle': return getStartupBundle(payload);
    case 'createEntry': return createEntry(payload);
    case 'saveEntryAll': return saveEntryAll(payload);
    case 'listEntries': return listEntries(payload);
    case 'listPeriodFlows': return listPeriodFlows(payload);
    case 'listLoanMovements': return listLoanMovements(payload);
    case 'getPeriodSummary': return getPeriodSummary(payload);
    case 'getHomeGlance': return getHomeGlance();
    case 'getMonthlyHistory': return getMonthlyHistory(payload);
    case 'getSpendingPace': return getSpendingPace(payload);
    case 'getExchangeRate': return getExchangeRate(payload.currency, payload.month);
    case 'getLatestRateOnOrBefore': return { rate: getLatestRateOnOrBefore_(payload.currency, payload.month), per_usd: perUsdAt_(payload.currency, payload.month) };
    case 'listExchangeRates': return listExchangeRates();
    case 'setExchangeRate': return payload.per_usd != null ? setUsdRate(payload.currency, payload.month, payload.per_usd) : setExchangeRate(payload.currency, payload.month, payload.rate);
    case 'previewRatesToUsd': return previewRatesToUsd();
    case 'convertRatesToUsd': return convertRatesToUsd();
    case 'previewMainCurrencyChange': return previewMainCurrencyChange(payload);
    case 'changeMainCurrency': return changeMainCurrency(payload);
    case 'addFriend': return addFriend(payload);
    case 'listPayors': return listPayors();
    case 'addPayor': return addPayor(payload);
    case 'applyPayorMerge': return applyPayorMerge(payload);
    case 'admin_deletePayor':
      var payorSheet = getSheet('Payors');
      var payorHeaders = getHeaders(payorSheet);
      var payorRowIndex = findRowIndexById(payorSheet, payorHeaders, payload.id);
      if (payorRowIndex !== -1) { deleteSheetRows_(payorSheet, payorRowIndex, 1); bumpStructureVersion_(); }
      return { done: true };
    case 'admin_setCategoryPeriodType': return adminSetCategoryPeriodType(payload.categoryId, payload.periodType);
    case 'admin_linkEntryToRecurring': return adminLinkEntryToRecurring(payload.entryId, payload.recurringExpenseId);
    case 'findRecurringLinkCandidates': return findRecurringLinkCandidates(payload);
    case 'listRecurringPayments': return listRecurringPayments(payload);
    case 'linkEntriesToRecurring': return linkEntriesToRecurring(payload);
    case 'addTag': return addTag(payload);
    case 'getManualGaps': return getManualGaps(payload);
    case 'saveGapReason': return saveGapReason(payload);
    case 'listTrips': return listTrips();
    case 'getTripDetail': return getTripDetail(payload);
    case 'addTrip': return addTrip(payload);
    case 'updateTrip': return updateTrip(payload);
    case 'deleteTrip': return deleteTrip(payload);
    case 'deleteTrips': return deleteTrips(payload);
    case 'findTripCandidates': return findTripCandidates(payload);
    case 'linkEntriesToTrip': return linkEntriesToTrip(payload);
    case 'recordTripSettlement': return recordTripSettlement(payload);
    case 'setBusinessFeatures': return setBusinessFeatures(payload);
    case 'enableBusinessForOwnerOnce': return enableBusinessForOwnerOnce();
    case 'listBusinessPeople': return listBusinessPeople();
    case 'listMyFriends': return listMyFriends();
    case 'listExpectedPayments': return listExpectedPayments(payload);
    case 'addExpectedPayment': return addExpectedPayment(payload);
    case 'getCompanyIgv': return getCompanyIgv(payload);
    case 'addIgvPayment': return addIgvPayment(payload);
    case 'updateIgvPayment': return updateIgvPayment(payload);
    case 'deleteIgvPayment': return deleteIgvPayment(payload);
    case 'updateExpectedPayment': return updateExpectedPayment(payload);
    case 'coverExpectedPayment': return coverExpectedPayment(payload);
    case 'deleteExpectedPayment': return deleteExpectedPayment(payload);
    case 'updateFriend': return updateFriend(payload);
    case 'setFriendPhone': return setFriendPhone(payload);
    case 'setFriendRemind': return setFriendRemind(payload);
    case 'setReminderTemplate': return setReminderTemplate(payload);
    case 'deleteFriend': return deleteFriend(payload);
    case 'deleteFriends': return deleteFriends(payload);
    case 'unhideFriend': return unhideFriend(payload);
    case 'restoreFriends': return restoreFriends(payload);
    case 'getProjectDebts': return getProjectDebts(payload);
    case 'listCompaniesAndProjects': return listCompaniesAndProjects(payload);
    case 'addCompany': return addCompany(payload);
    case 'updateCompany': return updateCompany(payload);
    case 'deleteCompany': return deleteCompany(payload);
    case 'addProject': return addProject(payload);
    case 'updateProject': return updateProject(payload);
    case 'deleteProject': return deleteProject(payload);
    case 'previewBusinessDelete': return previewBusinessDelete(payload);
    case 'deleteBusinessItems': return deleteBusinessItems(payload);
    case 'deleteBusinessPeople': return deleteBusinessPeople(payload);
    case 'getProjectDetail': return getProjectDetail(payload);
    case 'getCompanyDetail': return getCompanyDetail(payload);
    case 'addPaymentMethod': return addPaymentMethod(payload);
    case 'savePaymentMethod': return savePaymentMethod(payload);
    case 'getAccountCurrencySuggestions': return getAccountCurrencySuggestions();
    case 'listPendingCharges': return listPendingCharges();
    case 'fillEntryCharge': return fillEntryCharge(payload);
    case 'keepEntryCharge': return keepEntryCharge(payload);
    case 'fillChargeFromReview': return fillChargeFromReview(payload);
    case 'applyAccountCurrencySuggestions': return applyAccountCurrencySuggestions(payload);
    case 'removePaymentMethod': return removePaymentMethod(payload);
    case 'removePaymentMethods': return removePaymentMethods(payload);
    case 'deletePaymentMethod': return deletePaymentMethod(payload);
    case 'setPaymentMethodHidden': return setPaymentMethodHidden(payload);
    case 'restorePaymentMethods': return restorePaymentMethods(payload);
    case 'addBank': return addBank(payload);
    case 'admin_resetBanks': resetBanks(); return { done: true };
    case 'admin_linkPaymentMethodsToBanks': linkPaymentMethodsToBanks(); return { done: true };
    case 'admin_ensureUpdatedAtColumn': return { column: ensureEntriesUpdatedAtColumn_() };
    case 'admin_touchLatestEntry': {
      // Live check of the change-tracking path: stamps ONLY updated_at on the newest confirmed entry.
      var latest = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; }).sort(compareEntriesRecency_)[0];
      touchEntriesById_([latest.id]);
      return { id: latest.id };
    }
    case 'listEntrySearchIndex': return listEntrySearchIndex();
    case 'syncEntrySearchIndex': return syncEntrySearchIndex(payload);
    case 'listPhotoJobs': return listPhotoJobs();
    case 'getPhotoJob': return getPhotoJob(payload);
    case 'submitPhotoJobText': return submitPhotoJobText(payload);
    case 'failPhotoJob': return failPhotoJob(payload);
    case 'exportData': return exportData(payload);
    case 'exportDownload': return exportDownload(payload);
    case 'admin_setExportEmail': return adminSetExportEmail(payload);
    case 'admin_setTelegramToken':
      var newToken = String(payload.token || '').trim();
      if (!newToken) throw new Error('No token provided');
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', newToken);
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_UPDATE_OFFSET');
      return { done: true };
    case 'admin_setTelegramRelayUrl':
      var relayUrl = String(payload.url || '').trim();
      if (!relayUrl) throw new Error('No URL provided');
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_RELAY_URL', relayUrl);
      return { done: true };
    case 'admin_telegramStatus':
      var token = getTelegramToken_();
      return {
        tokenSet: !!token,
        tokenLength: token ? token.length : 0,
        chatIdSet: !!getOwnerTelegramChatId_(),
        updateOffset: PropertiesService.getScriptProperties().getProperty('TELEGRAM_UPDATE_OFFSET') || null,
        relayUrl: PropertiesService.getScriptProperties().getProperty('TELEGRAM_RELAY_URL') || null,
        lastWebhookUpdateId: PropertiesService.getScriptProperties().getProperty('TELEGRAM_RECENT_WEBHOOK_UPDATE_IDS') || null
      };
    case 'admin_resetTelegramWebhookDedup':
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID');
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_RECENT_WEBHOOK_UPDATE_IDS');
      return { done: true };
    case 'admin_telegramGetUpdatesRaw': return telegramApi_('getUpdates', { offset: 0, timeout: 0 });
    case 'admin_automationStatus':
      var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
        return t.getHandlerFunction() === 'runAutomation';
      });
      return {
        active: triggers.length > 0,
        triggerCount: triggers.length,
        eventType: triggers.length ? String(triggers[0].getEventType()) : null
      };
    case 'admin_automationTimings': return getAutomationTimings_();
    case 'checkEmailsNow': return checkEmailsNow();
    case 'listNotices': return listNotices();
    case 'checkAlertsNow': return checkAlertsNow(payload);
    case 'markNoticesSeen': return markNoticesSeen(payload);
    case 'admin_setupSpreadsheet': setupSpreadsheet(); return { done: true };
    case 'admin_addCreatedAtColumnToEntries': return addCreatedAtColumnToEntries();
    case 'admin_addCurrencyColumnToBudgets': return addCurrencyColumnToBudgets();
    case 'admin_addNameColumnToBudgets': return addNameColumnToBudgets();
    case 'admin_checkBudgetsNow': return checkBudgets();
    case 'admin_checkTripBudgetsNow': return checkTripBudgets();
    case 'admin_checkOverdueLoansNow': return checkOverdueLoans();
    case 'admin_setTelegramWebhook': return telegramApi_('setWebhook', { url: getTelegramWebhookTargetUrl_() });
    case 'admin_deleteTelegramWebhook': return telegramApi_('deleteWebhook', {});
    case 'admin_telegramWebhookInfo': return telegramApi_('getWebhookInfo', {});
    case 'admin_generateTopCategoryBudgets': return generateTopCategoryBudgets(payload);
    case 'admin_seedParsingRulesDoc': seedParsingRulesDoc(); return { done: true };
    case 'admin_runAutomation':
      var emailResults = processEmails();
      pollTelegramUpdates();
      return emailResults;
    case 'admin_debugGmail': return debugGmailSearch_(payload.query);
    case 'admin_compareGmailReaders': return compareGmailReaders(payload);
    case 'admin_backfillEntryMerchants': return backfillEntryMerchants(payload);
    case 'admin_listCategoryKeywords': return getAllRows('Category Keywords');
    case 'admin_processEmailsBack': return processEmails({ days: Number(payload.days) || 7, senders: payload.senders, includeOverlaps: payload.includeOverlaps === true });
    case 'admin_emailCoverageReport': return emailCoverageReport_(payload);
    case 'admin_debugListEmails': return debugListEmails_(payload.senders || [], Number(payload.days) || 7);
    case 'admin_setupIbkAccounts': return adminSetupIbkAccounts(payload);
    case 'admin_setupInvestmentPlatforms': return adminSetupInvestmentPlatforms(payload);
    case 'admin_setupBcpAccounts': return adminSetupBcpAccounts(payload);
    case 'admin_applyStatementActions': return adminApplyStatementActions(payload);
    case 'admin_undoImportBatch': return adminUndoImportBatch(payload);
    case 'admin_debugSearchEmails': return debugSearchEmails_(payload.query, payload.max);
    case 'admin_debugEmailBody': return debugEmailBody_(payload.query, payload.chars);
    case 'listStatementCoverage': return listStatementCoverage();
    case 'getStatementMonthMatrix': return getStatementMonthMatrix();
    case 'listStatementInbox': return listStatementInbox();
    case 'getStatementAttachment': return getStatementAttachment(payload);
    case 'listPerfAppVersions': return listPerfAppVersions_();
    case 'listStatementSamples': return listStatementSamples_(payload);
    case 'rulePackTwinCheck': return rulePackTwinCheck_(payload);
    case 'findStatementEmails': return findStatementEmails(payload);
    case 'addStatementsToInbox': return addStatementsToInbox(payload);
    case 'rememberStatementSender': return rememberStatementSender(payload);
    case 'dismissStatement': return dismissStatement(payload);
    case 'admin_scanStatementInbox': return scanStatementInbox_();
    case 'analyzeStatements': return analyzeStatements(payload);
    case 'planStatementHistory': return planStatementHistory(payload);
    case 'applyStatementDecisions': return applyStatementDecisions(payload);
    case 'undoStatementBatch': return undoStatementBatch(payload);
    case 'listStatementBatches': return listStatementBatches(payload);
    case 'setBatchOrigin': return setBatchOrigin(payload);
    case 'createStatementAccounts': return createStatementAccounts(payload);
    case 'getStatementBatchDetails': return getStatementBatchDetails(payload);
    case 'getOwnerNames': return getOwnerNames();
    case 'saveOwnerNames': return saveOwnerNames(payload);
    case 'answerOwnName': return answerOwnName(payload);
    case 'applyProfile': return applyProfile(payload);
    case 'getProfileState': return getProfileState();
    case 'listStatementGaps': return listStatementGaps();
    case 'resolveStatementGap': return resolveStatementGap(payload);
    case 'getEntriesNear': return getEntriesNear(payload);
    case 'admin_reopenStatementLines': return adminReopenStatementLines(payload);
    case 'admin_seedStatementUploads': return adminSeedStatementUploads(payload);
    case 'admin_seedCategoryKeywords': seedCategoryKeywords(); return { done: true };
    case 'admin_bulkImportSpendeeCsv': return bulkImportSpendeeCsv(payload.csvText, payload.filename);
    case 'admin_mergeDuplicatePaymentMethods': return mergeDuplicatePaymentMethods();
    case 'saveCategory': return saveCategory(payload);
    case 'setPay': return setPay(payload);
    case 'deleteCategory': return deleteCategory(payload);
    case 'previewCategoryDelete': return previewCategoryDelete(payload);
    case 'deleteCategories': return deleteCategories(payload);
    case 'getCategoryCounts': return getCategoryCounts();
    case 'setCategoryHidden': return setCategoryHidden(payload);
    case 'showCategories': return showCategories(payload);
    case 'addCategoryKeyword':
      var kw = { id: Utilities.getUuid(), keyword: payload.keyword, category_name: payload.category_name };
      appendRowObject('Category Keywords', kw);
      return kw;
    case 'listBudgets': return listBudgets(payload);
    case 'addBudget': return addBudget(payload);
    case 'updateBudget': return updateBudget(payload);
    case 'deleteBudget': return deleteBudget(payload.id);
    case 'endBudget': return endBudget(payload);
    case 'endBudgets': return endBudgets(payload);
    case 'deleteBudgets': return deleteBudgets(payload);
    case 'getBudgetChartSeries': return getBudgetChartSeries(payload);
    case 'listRecurringExpenses': return listRecurringExpenses();
    case 'addRecurringExpense': return addRecurringExpense(payload);
    case 'updateRecurringExpense': return updateRecurringExpense(payload);
    case 'deleteRecurringExpense': return deleteRecurringExpense(payload.id);
    case 'convertPausedProgrammedForOwnerOnce': return convertPausedProgrammedForOwnerOnce();
    case 'stopRecurringAtLastPayment': return stopRecurringAtLastPayment(payload);
    case 'deleteRecurringExpenses': return deleteRecurringExpenses(payload);
    case 'previewProgrammedDelete': return withRowsMemo_(function () { return previewProgrammedDelete(payload); });
    case 'skipRecurringOccurrence': return skipRecurringOccurrence(payload);
    case 'unskipRecurringOccurrence': return unskipRecurringOccurrence(payload);
    case 'linkEntryToRecurring': return linkEntryToRecurring(payload);
    case 'recordRecurringPayment': return recordRecurringPayment(payload);
    case 'listEntriesForRecurringMonth': return listEntriesForRecurringMonth(payload);
    case 'getRecurringExpenseSplits': return getRecurringExpenseSplits(payload);
    case 'saveRecurringExpenseSplits': return saveRecurringExpenseSplits(payload);
    case 'listExpectedRecurringItems': return listExpectedRecurringItems();
    case 'suggestVariableRecurring': return suggestVariableRecurring();
    case 'getProjections': return withRowsMemo_(function () { return getProjections(payload); });
    case 'listCategoryProjections': return withRowsMemo_(function () { return listCategoryProjections(payload); });
    case 'getCategoryProjectionDetail': return withRowsMemo_(function () { return getCategoryProjectionDetail(payload); });
    case 'setProjectionOverride': return setProjectionOverride(payload);
    case 'getProjectionMethodSettings': return projectionMethodSettings();
    case 'setProjectionMethod': return setProjectionMethod(payload);
    case 'applyProjectionMethodToAll': return applyProjectionMethodToAll(payload);
    case 'compareProjectionMethods': return compareProjectionMethods(payload);
    case 'applyBestProjectionMethods': return applyBestProjectionMethods();
    case 'deleteProjectionOverride': return deleteProjectionOverride(payload);
    case 'admin_resetProjectionOverridesSheet': return adminResetProjectionOverridesSheet();
    case 'admin_debugProjectionOverrides': return adminDebugProjectionOverrides();
    case 'admin_debugBudgetAlertLog': return adminDebugBudgetAlertLog();
    case 'suggestCategoryMap': return suggestCategoryMap(payload);
    case 'getStatementFormat': return getStatementFormat(payload);
    case 'saveStatementFormat': return saveStatementFormat(payload);
    case 'deleteStatementFormat': return deleteStatementFormat(payload);
    case 'listPendingEntries': return listPendingEntries();
    case 'suggestForDescription': return suggestForDescription(payload);
    case 'listSupportedSenders': return listSupportedSenders();
    case 'setRulePack': return setRulePack(payload);
    case 'confirmEntry': return confirmEntryFromApp_(payload);
    case 'unconfirmEntry': return unconfirmEntry_(payload);
    case 'createPracticePending': return createPracticePending(payload);
    case 'removePracticeReview': return removePracticeReview(payload);
    case 'createPracticeTidy': return createPracticeTidy(payload);
    case 'removePracticeTidy': return removePracticeTidy();
    case 'createPracticeDeleted': return createPracticeDeleted(payload);
    case 'removePracticeDeleted': return removePracticeDeleted();
    case 'removePracticeImport': return removePracticeImport(payload);
    case 'createPracticeBankAccount': return createPracticeBankAccount(payload);
    case 'removePracticeBank': return removePracticeBank(payload);
    case 'removePracticeProgrammed': return removePracticeProgrammed(payload);
    case 'removePracticeBudgets': return removePracticeBudgets();
    case 'removePracticeInvestments': return removePracticeInvestments(payload);
    case 'removePracticeAccounts': return removePracticeAccounts(payload);
    case 'removePracticeTrips': return removePracticeTrips(payload);
    case 'createPracticeTripExpenses': return createPracticeTripExpenses(payload);
    case 'removePracticeExchange': return removePracticeExchange(payload);
    case 'removePracticeData': return removePracticeData(payload);
    case 'removePracticeLoans': return removePracticeLoans(payload);
    case 'discardEntry': refuseRepaymentPartDiscard_(payload.id); return discardEntryWithRepayments_(payload.id, payload.repayments);
    case 'confirmEntries': return confirmEntries(payload);
    case 'previewEntriesDelete': return withRowsMemo_(function () { return previewEntriesDelete(payload); });
    case 'deleteEntries': return withRowsMemo_(function () { return deleteEntries(payload); });
    case 'listDeletedEntries': return listDeletedEntries();
    case 'restoreDeletedEntries': return restoreDeletedEntries(payload);
    case 'forgetDeletedEntries': return forgetDeletedEntries(payload);
    // Each tab read once for the whole action, like the delete above: looking the entries up one by one cost ~4 trips to Google per entry (speed, 2026-11-12).
    case 'setEntriesCategory': return withRowsMemo_(function () { return setEntriesCategory(payload); });
    case 'setEntriesTrip': return withRowsMemo_(function () { return setEntriesTrip(payload); });
    case 'undoSetEntriesTrip': return withRowsMemo_(function () { return undoSetEntriesTrip(payload); });
    case 'setEntriesTag': return withRowsMemo_(function () { return setEntriesTag(payload); });
    case 'undoSetEntriesTag': return withRowsMemo_(function () { return undoSetEntriesTag(payload); });
    case 'undoSetEntriesCategory': return withRowsMemo_(function () { return undoSetEntriesCategory(payload); });
    case 'discardEntries': return discardEntries(payload);
    case 'getEntryRepaymentLinks': return getEntryRepaymentLinks(payload);
    case 'checkEntryTypeChange': return checkEntryTypeChange(payload);
    case 'releaseEntryRepaidLoans': return releaseEntryRepaidLoans(payload);
    case 'updateEntry': return updateEntryFromApp_(payload);
    case 'convertPendingToTransfer': return convertPendingToTransfer(payload);
    case 'undoCategoryFollow': return undoCategoryFollow(payload);
    case 'listTidyGroups': return listTidyGroups(payload);
    case 'applyTidyGroups': return applyTidyGroups(payload);
    case 'listNoAccountEntries': return listNoAccountEntries(payload);
    case 'listStartBalanceCandidates': return listStartBalanceCandidates(payload);
    case 'assignEntryAccounts': return assignEntryAccounts(payload);
    case 'undoEntryAccounts': return undoEntryAccounts(payload);
    case 'getEntry': return getEntryById_(payload.id);
    case 'recordCurrencyExchange': return recordCurrencyExchange(payload);
    case 'getEntrySplits': return getEntrySplits(payload.entryId);
    case 'saveEntrySplits': return saveEntrySplits(payload.entryId, payload.splits);
    case 'getEntryBill': return getEntryBill(payload);
    case 'saveEntryBill': return saveEntryBill(payload);
    case 'getEntryTags': return getEntryTags(payload);
    case 'saveEntryTags': return saveEntryTags(payload);
    case 'listPaymentMethodBalances': return listPaymentMethodBalances();
    case 'getPaymentMethodMovements': return getPaymentMethodMovements(payload);
    case 'setPaymentMethodOpeningBalance': return setPaymentMethodOpeningBalance(payload);
    case 'listLoanBalances': return listLoanBalances(payload);
    case 'getFriendLoanDetail': return getFriendLoanDetail(payload.friendId);
    case 'getFriendRepaymentHistory': return getFriendRepaymentHistory(payload);
    case 'reassignRepayment': return reassignRepayment(payload);
    case 'recordRepaymentEntry': return recordRepaymentEntry(payload);
    case 'saveBankLoan': return saveBankLoan(payload);
    case 'getLoanSchedule': return getLoanSchedule(payload);
    case 'saveLoanSchedule': return saveLoanSchedule(payload);
    case 'recordInstallment': return recordInstallment(payload);
    case 'recordEarlyPayment': return recordEarlyPayment(payload);
    case 'undoCancelOut': return undoCancelOut(payload);
    case 'applyUnappliedPayment': return applyUnappliedPayment(payload);
    case 'listSettledLoanFriends': return listSettledLoanFriends(payload);
    case 'addLoan': return addLoan(payload);
    case 'updateLoan': return updateLoan(payload);
    case 'deleteLoan': deleteLoan(payload.id, payload.repayments); return { done: true };
    case 'getLoanDeleteInfo': return getLoanDeleteInfo(payload);
    case 'listSettlementsForFriendCurrency': return listSettlementsForFriendCurrency(payload.friendId, payload.currency);
    case 'recordRepayment': return recordRepayment(payload);
    case 'convertEntryToRepayment': return convertEntryToRepayment(payload);
    case 'convertEntryToLoan': return convertEntryToLoan(payload);
    case 'convertLoanToEntry': return convertLoanToEntry(payload);
    case 'convertLoanToRepayment': return convertLoanToRepayment(payload);
    case 'convertLoanToLoan': return convertLoanToLoan(payload);
    case 'checkLoanToLoan': return checkLoanToLoan(payload);
    case 'convertRepaymentToEntry': return convertRepaymentToEntry(payload);
    case 'convertRepaymentToLoan': return convertRepaymentToLoan(payload);
    case 'convertRepaymentToRepayment': return convertRepaymentToRepayment(payload);
    case 'deleteRepayment': return deleteRepayment(payload);
    case 'recordOverpaymentIncome': return recordOverpaymentIncome(payload);
    case 'recordOverpaymentExpense': return recordOverpaymentExpense(payload);
    case 'forgiveLoan': return forgiveLoan(payload);
    case 'updateSettlement': return updateSettlement(payload);
    case 'deleteSettlement': deleteSettlement(payload.id); return { done: true };
    default: throw new Error('Unknown action: ' + action);
  }
}

// ---- Generic sheet helpers ----

// Whoever asks for the sheet itself may be about to change it: while the per-request read memory is on (withRowsMemo_), that
// sheet's remembered rows are dropped, so a later getAllRows reads it again instead of handing back rows from before the change.
function getSheet(name) {
  if (ROWS_MEMO_) { delete ROWS_MEMO_[name]; delete ROWS_MEMO_['@h:' + name]; }
  return sheetRaw_(name);
}

function sheetRaw_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

// Sheets auto-converts recognizable date strings to its own Date type on
// write, even into columns pre-formatted as plain text — that conversion
// can't be reliably prevented. Instead, always normalize back to a clean
// string on the way out, regardless of how the cell actually stored it.
var DATE_FIELD_FORMATS = {
  date: 'yyyy-MM-dd',
  due_date: 'yyyy-MM-dd',
  month: 'yyyy-MM',           // Exchange Rates / Recurring Skips: a Sheets Date back to text (numeric months are untouched)
  start_date: 'yyyy-MM-dd',   // Recurring Expenses (a Sheets Date is turned back into text on read)
  end_date: 'yyyy-MM-dd',
  opening_balance_date: 'yyyy-MM-dd',
  as_of: "yyyy-MM-dd'T'HH:mm:ss",
  period_start: 'yyyy-MM-dd',
  period_end: 'yyyy-MM-dd',
  processed_at: 'yyyy-MM-dd',
  sent_at: 'yyyy-MM-dd',
  first_seen: 'yyyy-MM-dd',   // Unread Emails: a Sheets Date back to text (else the screen said "last on Invalid Date")
  last_seen: 'yyyy-MM-dd',
  month: 'yyyy-MM',
  period: 'yyyy-MM',
  from_period: 'yyyy-MM-dd',   // Budget History: a start Sheets turned into a date (budgetFromKey_ cuts it to the budget's kind)
  // Full timestamp (not date-only) — lets same-day entries sort by the
  // exact moment they were captured, not just insertion order.
  created_at: "yyyy-MM-dd'T'HH:mm:ss"
};

// Same root cause as dates: a purely-numeric-looking id (a bank operation
// number, say) gets auto-converted to Sheets' Number type on write, which
// silently drops leading zeros — that loss happens at write time and can't
// be recovered by normalizing on read. What CAN be fixed here is the type:
// always hand back a string, so later strict-equality dedup checks don't
// break comparing a stored Number against a freshly-extracted String.
var STRING_FIELDS = { external_id: true, id: true };

// Optional per-request read cache. OFF by default (null); only the app-open
// bundle switches it on (see getStartupBundle), because that one request
// re-reads Entries 4x and Payment Methods 7x. While on, each sheet is read
// once and every caller gets its own shallow copies (callers add fields to
// the rows they get). appendRowObject / deleteRowsWhere_ drop a sheet's cache
// entry, and the bundle switches it off in a finally.
var ROWS_MEMO_ = null;

// Runs `fn` with each sheet read from Google at most once (getAllRows then serves
// repeats from memory; a write to a sheet drops its copy). The projection screens
// read Entries dozens of times per request otherwise. Inside an outer scope (the
// start-up bundle) the outer one is kept.
function withRowsMemo_(fn) {
  if (ROWS_MEMO_) return fn();
  ROWS_MEMO_ = {};
  try {
    return fn();
  } finally {
    ROWS_MEMO_ = null;
  }
}

// True when, in this request, the sheet's columns were already read (and the sheet has not been opened for a change since)
// and every one of `cols` is among them; a "make sure the column exists" check can then stop without a call to Google.
// Anything uncertain answers false and the check runs as it always did. Outside withRowsMemo_ always false.
function memoHasColumns_(sheetName, cols) {
  if (!ROWS_MEMO_) return false;
  var headers = ROWS_MEMO_['@h:' + sheetName];
  if (!headers && !ROWS_MEMO_[sheetName]) {
    // Not read yet in this request: read it now (a looking call reads it right after anyway), so the check and the read
    // that follows cost one trip to Google instead of two.
    try { getAllRows(sheetName); } catch (e) { return false; }
    headers = ROWS_MEMO_ && ROWS_MEMO_['@h:' + sheetName];
  }
  if (!headers) return false;
  return cols.every(function (c) { return headers.indexOf(c) !== -1; });
}

function getAllRows(sheetName) {
  if (ROWS_MEMO_ && ROWS_MEMO_[sheetName]) {
    return ROWS_MEMO_[sheetName].map(function (r) { return Object.assign({}, r); });
  }
  var rows = readAllRows_(sheetName);
  if (sheetName === 'Loans' || sheetName === 'Settlements') rows.forEach(cleanHandTypedMoneyRow_);
  if (ROWS_MEMO_) ROWS_MEMO_[sheetName] = rows.map(function (r) { return Object.assign({}, r); });
  return rows;
}

// A hand-typed amount: a clear text form becomes its number ("1,200.50", "1.200,50", "12,50"). NaN = it cannot be read for sure: "1,200"
// could be a thousand or a decimal, and the app never guesses (same rule as the amount boxes).
function parseHandTypedAmount_(v) {
  if (typeof v === 'number') return v;
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(',', '.'));
  return NaN;
}

// Rows of Loans / Settlements as the rest of the code expects them, whatever was typed in the Sheet. An amount or currency that cannot
// be read counts as 0 (a NaN would poison every total) and the row is marked; the Loans tab names it (Ingrid, 2026-11-09).
function cleanHandTypedMoneyRow_(row) {
  var blank = row.amount === '' || row.amount === null || row.amount === undefined;
  if (blank && !row.friend_id && !row.loan_id) return;   // an empty row
  var amount = parseHandTypedAmount_(row.amount);
  var loanRow = row.direction !== undefined;
  var currency = loanRow ? String(row.currency === null || row.currency === undefined ? '' : row.currency).trim().toUpperCase() : '';
  var badCurrency = loanRow && !(currency && (currency === homeCurrency_() || isKnownCurrencyCode_(currency)));
  // The direction, typed by hand, is read when it clearly names one of the two ("They owe me", "they_owe_me"); anything else is never
  // guessed (it used to count as "You owe": Ingrid, 2026-11-09) and the row is named like an unreadable amount.
  var direction = loanRow ? String(row.direction === null || row.direction === undefined ? '' : row.direction).trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  var badDirection = loanRow && direction !== 'they_owe_me' && direction !== 'i_owe_them';
  if (blank || isNaN(amount) || amount < 0 || badCurrency || badDirection) {
    row.unreadable_amount = row.amount;
    row.unreadable_currency = row.currency;
    row.amount = 0;
    return;
  }
  row.amount = amount;
  if (loanRow) { row.currency = currency; row.direction = direction; }
}

// The time zone Sheets used when it turned a written date into a Date cell. Dates must be turned back into text in THIS
// zone (not the script's): a copy whose Sheet is set to another zone (say UTC) would otherwise read every date one day early.
function sheetDateTz_() {
  try {
    var z = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    if (z) return z;
  } catch (e) { /* fall back below */ }
  return Session.getScriptTimeZone();
}

// Speed (2026-11-02): ONE read of the whole sheet (headers + rows) instead of four calls to Google (last row, last column,
// headers, rows); the Sheet's time zone asked once per request; and each date converted once (the same day repeats across
// thousands of rows, and every Utilities.formatDate is a call into Google's side). See CHANGELOG.md § Speed pass.
function readAllRows_(sheetName) {
  var sheet = sheetRaw_(sheetName);
  var all = sheet.getDataRange().getValues();
  var headers = all[0] || [];
  if (ROWS_MEMO_) ROWS_MEMO_['@h:' + sheetName] = headers.slice();   // for memoHasColumns_
  if (all.length < 2) return [];
  var values = all.slice(1);
  var tz = ROWS_MEMO_ ? (ROWS_MEMO_['@tz'] || (ROWS_MEMO_['@tz'] = sheetDateTz_())) : sheetDateTz_();
  var dates = {};
  return values.map(function (row, i) { return cleanSheetRow_(sheetName, rowToObject_(headers, row, tz, dates), headers, i + 2); });
}

// One sheet row as the object getAllRows gives (dates back to text, ids as text). `dates` remembers converted dates.
function rowToObject_(headers, row, tz, dates) {
  var obj = {};
  headers.forEach(function (h, i) {
    var v = row[i];
    if (v instanceof Date && DATE_FIELD_FORMATS[h]) {
      var key = DATE_FIELD_FORMATS[h] + '|' + v.getTime();
      v = dates[key] || (dates[key] = Utilities.formatDate(v, tz, DATE_FIELD_FORMATS[h]));
    } else if (STRING_FIELDS[h] && v !== '' && v != null) {
      v = String(v);
    }
    obj[h] = v;
  });
  return obj;
}

// The FIRST row whose id is `id` (exactly what getAllRows(sheetName).find(id) gives), without reading the whole sheet:
// the id column, then that one row. Speed (2026-11-02): looking up one entry read all of Entries (thousands of rows x
// ~30 columns) and a single save did it up to ten times. Inside withRowsMemo_ the remembered rows are used instead.
function findRowById_(sheetName, id) {
  if (ROWS_MEMO_) return getAllRows(sheetName).find(function (r) { return r.id === id; });
  var sheet = sheetRaw_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return undefined;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idCol = headers.indexOf('id');
  if (idCol === -1) return getAllRows(sheetName).find(function (r) { return r.id === id; });
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    var v = ids[i][0];
    var asText = (v !== '' && v != null) ? String(v) : v;   // as getAllRows hands it back
    if (asText === id) {
      var row = sheet.getRange(i + 2, 1, 1, lastCol).getValues()[0];
      return cleanSheetRow_(sheetName, rowToObject_(headers, row, sheetDateTz_(), {}), headers, i + 2);
    }
  }
  return undefined;
}

function appendRowObject(sheetName, obj) {
  // Every new entry is stamped with when it last changed (see DataVersion.gs).
  if (sheetName === 'Entries') {
    ensureEntriesUpdatedAtColumn_();
    obj.updated_at = nowStamp_();
  }
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var row = headers.map(function (h) { return obj[h] !== undefined ? safeCellValue_(sheetName, h, obj[h]) : ''; });
  sheet.appendRow(row);
  if (ROWS_MEMO_) delete ROWS_MEMO_[sheetName];
  noteRowAppended_(sheetName, obj);
}

function findRowIndexById(sheet, headers, id) {
  var idCol = headers.indexOf('id');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;   // String(): a hand-retyped id can be stored as a number
  }
  return -1;
}

// ---- Meta (everything the form's dropdowns need, in one call) ----

function getMeta() {
  runHealsOnce_();   // one-time repairs of a copy installed before a fix existed (Heals.gs); friends' copies only
  ensureInvestmentPlatforms_();
  ensureCashAccount_();   // every copy has one built-in Cash account (owner, 2026-11-02)
  ensureRailDefaults_();
  ensureAnnualTag_();
  ensureAllTripGroupFriends_();
  var payorMergeAsk = payorMergeAskForApp_();   // the owner's copy: names to confirm before payors and friends become one list
  return {
    categories: localizeCategories_(getAllRowsCached_('Categories')),
    banks: getAllRowsCached_('Banks'),
    paymentMethods: getAllRowsCached_('Payment Methods').map(function (pm) { return Object.assign({}, pm, { last_4: pmLast4_(pm.last_4) }); }),
    tags: localizeTags_(getAllRowsCached_('Tags')),
    trips: getTripRows_(),
    // Business pack (Business.gs): empty, and no sheet is read, while the person has not turned it on.
    companies: getCompanyRows_(),
    projects: getProjectRows_(),
    expectedPayments: getExpectedRows_(),   // empty (and nothing read) while the pack is off
    friends: getFriendsWithLastUsed_(),
    payors: getPayorsWithLastIncome_(),
    payorMergeAsk: payorMergeAsk,
    settings: settingsForApp_(),
    // What this copy of the backend can do beyond the spreadsheet (Features.gs). The
    // Export screen offers "Send to my email" only when an address was saved.
    capabilities: getCapabilities_(),
    // Banks for the welcome questions (two alphabetical groups) and the words account names are built from.
    bankCatalog: getBankCatalog_(),
    // Which Google account's inbox bank e-mails are read from, and the banks whose e-mails have a rule (EmailParser.gs): More → Bank emails.
    emailInfo: getEmailInfo_(),
    // "Is this you?" (OwnerNames.gs): the name the Home card asks about, '' when there is none.
    ownNameAsk: ownerNameAsk_(),
    // The day this copy started being used: "from before the app" dates start on the day before (Loans.gs).
    firstUseDate: firstUseDate_(),
    // Programmed items still PAUSED (Pause no longer exists: the app makes the person choose Reactivate / Stop / Delete for each, once).
    pausedProgrammed: pausedProgrammedForApp_()
  };
}

// Friends plus `last_used` — the date of their most recent loan (shared
// expenses and cash loans both create one), used only to order the split
// picker most-recent-first. Loans is small, so this stays cheap in getMeta;
// a friend with no loans yet gets '' and sorts last.
function getFriendsWithLastUsed_() {
  var last = {};
  // Loans reflects money/debt state, so it stays a live read — only the
  // Friends list itself (names, rarely added/edited) is cached.
  getAllRows('Loans').forEach(function (l) {
    var d = String(l.date || '');
    if (d && (!last[l.friend_id] || d > last[l.friend_id])) last[l.friend_id] = d;
  });
  // A bank you borrowed from is a person of that name in the lists: marked so it can be told apart (🏦, 2026-11-09).
  var bankLender = {};
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Loan Installments')) {
    var withSchedule = {};
    getAllRows('Loan Installments').forEach(function (r) { withSchedule[r.loan_id] = true; });
    getAllRows('Loans').forEach(function (l) { if (withSchedule[l.id]) bankLender[l.friend_id] = true; });
  }
  var lastIncome = lastIncomeByPerson_();
  return getAllRowsCached_('Friends').map(function (f) {
    f.last_used = last[f.id] || '';
    f.bank_lender = !!bankLender[f.id];
    f.last_income = lastIncome[f.id] || '';
    return f;
  });
}

// ---- Small read cache for rarely-changing reference tables ----
// getMeta alone used to mean 7 sequential Sheet reads every single time
// (see CHANGELOG.md § Architecture, "Performance instrumentation") — this
// cuts a cache-hit read to near-zero. Deliberately TTL-only, with no
// manual invalidation on write: these tables (categories, banks, payment
// methods, tags, settings, payors) are edited rarely and by hand, so up to
// REFERENCE_CACHE_TTL_SECONDS of staleness after an edit is harmless —
// and that's a much smaller risk than a future write path somewhere
// forgetting to clear a cache key and silently going stale forever.
// NEVER apply this to Entries or anything else money-related — those must
// always be current, per CLAUDE.md principle 6 ("anything automated lands
// in a review queue as pending until confirmed") and the core principle
// that the app's numbers are always live, never a snapshot.
// Originally 120s — real usage (CHANGELOG.md § Architecture, "Startup-
// speed fixes") showed opens are hours apart, so a 2-minute cache almost
// never got a hit; raised to 1 hour, still short enough that adding a
// category and using it the same sitting is a rare, low-stakes miss.
var REFERENCE_CACHE_TTL_SECONDS = 3600;

function getAllRowsCached_(sheetName) {
  var cache = CacheService.getScriptCache();
  // The key includes STRUCTURE_VERSION (bumped on every write to Categories /
  // Payment Methods / Friends / Payors / Tags / Exchange Rates — see
  // DataVersion.gs), so adding or editing one of those is visible at once
  // instead of only after the 1-hour TTL.
  var key = 'rows_' + sheetName + '_' + getVersion_('STRUCTURE_VERSION');
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  var rows = getAllRows(sheetName);
  try {
    cache.put(key, JSON.stringify(rows), REFERENCE_CACHE_TTL_SECONDS);
  } catch (err) {
    // Too big for a cache entry (100KB limit) or a transient CacheService
    // error — harmless, this just reads the Sheet directly every time.
  }
  return rows;
}

// The frontend's app-open screen needs getMeta + the entry list + the
// review queue + this month's expected recurring items — four independent
// reads, previously four separate round trips (see init() in app.js). Each
// round trip pays its own share of Apps Script's per-request startup cost
// (real for this app: it's used a few times a day with idle gaps between,
// so almost every request runs on a freshly-spun-up instance — see
// CHANGELOG.md § Architecture, "Performance instrumentation"). Bundling
// into one call pays that cost once per app open instead of four times.
// Pure aggregation — no new business logic, so nothing here changes what
// any of the four screens show.
function getStartupBundle(payload) {
  // getMeta first and uncached: it can self-heal (add header columns / seed
  // platforms), so the cache only starts once the sheets are in final shape.
  var meta = getMeta();
  ROWS_MEMO_ = {};
  try {
    return {
      meta: meta,
      entries: listEntries({ limit: (payload && payload.entriesLimit) || 20 }),
      pending: listPendingEntries(),
      expectedRecurring: listExpectedRecurringItems()
    };
  } finally {
    ROWS_MEMO_ = null;
  }
}

// What the phone gets of the Settings: all of them except the rule pack, which can be 40,000 characters and only the backend reads.
function settingsForApp_() {
  var map = getSettingsMap();
  delete map[RULE_PACK_SETTING_];
  return map;
}

function getSettingsMap() {
  var map = {};
  getAllRowsCached_('Settings').forEach(function (r) { map[r.key] = r.value; });
  return map;
}

// ---- Entries ----

function createEntry(payload) {
  // A save the phone sends from its background queue carries its own id (client_id), so sending it again — after a lost
  // reply, or when the app was closed mid-save — never makes a second entry: the same id answers with the entry it made.
  var clientId = String(payload.client_id || '');
  var validClientId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
  if (validClientId) {
    var already = getEntryById_(clientId);
    if (already) return already;
  }
  var id = validClientId ? clientId : Utilities.getUuid();
  var entry = {
    id: id,
    type: payload.type,
    date: payload.date,
    amount: payload.amount,
    currency: payload.currency || homeCurrency_(),
    category_id: payload.category_id,
    description: payload.description || '',
    // Income always keeps its "Received at" account — its paid_by is a
    // payor id, never 'me' — so only the other types blank it for a
    // friend-paid entry (see specs/entries-and-categories.md, Payors).
    payment_method_id: (payload.type === 'income' || payload.paid_by === 'me') ? (payload.payment_method_id || '') : '',
    paid_by: payload.paid_by || 'me',
    status: 'confirmed',
    source: 'manual',
    external_id: '',
    import_batch_id: '',
    created_at: nowTimestamp_()
  };
  // Only a transfer or an investment has a destination account (see
  // Balances.gs / Investments.gs).
  if ((payload.type === 'transfer' || payload.type === 'investment') && payload.to_payment_method_id) {
    ensureEntriesToPaymentMethodColumn_();
    entry.to_payment_method_id = payload.to_payment_method_id;
  }
  if (entry.type === 'investment' && needsInvestmentCategory_(entry.category_id)) {
    entry.category_id = defaultInvestmentCategoryId_();
  }
  // Only an expense can belong to a trip / event (Trips.gs); an unknown id means none.
  var tripId = entry.type === 'expense' ? validTripIdOrBlank_(payload.trip_id) : '';
  if (tripId) {
    ensureEntriesTripColumn_();
    entry.trip_id = tripId;
  }
  // Business pack: an expense or income may belong to a company / project (ignored while the pack is off).
  var businessLink = businessLinkFor_(entry.type, payload.project_id, payload.company_id);
  if (businessLink.company_id) {
    ensureBusinessSheets_();
    entry.company_id = businessLink.company_id;
    entry.project_id = businessLink.project_id;
    // An income may settle one expected payment of its project (same currency).
    var expectedId = expectedLinkFor_(entry.type, payload.expected_payment_id, businessLink.project_id, entry.currency);
    if (expectedId) entry.expected_payment_id = expectedId;
    // The IGV inside the amount (a company's expense or income only; refused if it is not smaller than the amount).
    var igv = cleanIgv_(entry.type, entry.amount, businessLink, payload.igv_amount);
    if (igv) entry.igv_amount = igv;
  }
  // Saved with no category (the person chose not to pick one): fill it from what they decided for the same merchant
  // or description before, else leave it blank for Tidy my history. See CategoryFollow.gs.
  var guessedCategory = '';
  if (entry.type === 'expense' && !entry.category_id) {
    guessedCategory = guessCategoryForNewEntry_(entry);
    if (guessedCategory) entry.category_id = guessedCategory;
  }
  if (entry.type === 'expense' && entry.paid_by === 'me' && (payload.charge_pending || payload.paid_amount)) {
    ensureEntriesChargeColumns_();
    if (payload.charge_pending) entry.charge_pending = '1';
    if (Number(payload.paid_amount) > 0 && payload.paid_currency) { entry.paid_amount = Number(payload.paid_amount); entry.paid_currency = String(payload.paid_currency).toUpperCase(); }
  }
  var incomeWaits = entry.type === 'income' && !!payload.income_waiting;
  if (incomeWaits) {
    checkWaitingIncome_(entry.paid_by, !!entry.company_id);
    ensureIncomeWaitingColumns_();
    entry.payment_method_id = '';   // no account until the money arrives
    entry.income_waiting = '1';
  }
  appendRowObject('Entries', entry);
  if (incomeWaits) createWaitingIncomeLoan_(entry, payload.due_date);
  if (guessedCategory) entry.guessed_category_name = categoryNameForMessage_(guessedCategory);

  if (payload.tag_ids && payload.tag_ids.length) {
    payload.tag_ids.forEach(function (tagId) {
      appendRowObject('Entry Tags', { entry_id: id, tag_id: tagId });   // by column NAME, not position
    });
  }
  // The form pre-selects Annual for Travel and always sends its tags, so what
  // it sends wins (the owner may have un-ticked it); a caller that sends no
  // tag list at all gets the default here.
  if (!payload.tag_ids) autoTagTravelEntry_(entry);

  return entry;
}

function confirmEntryFromApp_(payload) {
  confirmEntryWithLearning_(payload.id);
  // Confirming gives the entry its category for good: the blank look-alikes (imports waiting in Tidy my history) follow, with Undo.
  var followed = null;
  try { followed = categoryFollowAfterEdit_(payload.id); } catch (err) { followed = null; }
  return followed ? { done: true, follow: followed } : { done: true };
}

// Undo of a Needs review Confirm (owner, 2026-11-12): the entry goes back to waiting. Only a plain one (an expense or income
// that came in automatically, with no split): a split made debts at confirm time, and "waiting" cannot hold a debt. What the
// confirm taught the email rules is kept (the next e-mail from that shop still gets its category).
function unconfirmEntry_(payload) {
  var id = String((payload && payload.id) || '');
  var entry = getEntryById_(id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  if (entry.status !== 'confirmed') return { done: true, already: true };
  if (entry.source === 'manual' || (entry.type !== 'expense' && entry.type !== 'income')) throw new Error(tr_('err.cannotUnconfirm'));
  var hasSplits = getAllRows('Entry Splits').some(function (sp) { return sp.entry_id === id; });
  if (hasSplits) throw new Error(tr_('err.cannotUnconfirm'));
  setEntryField_(id, 'status', 'pending');
  return { done: true };
}

// ---- Needs review: several entries at once (Home → Needs review → Edit, owner's request 2026-11-03) ----
// Each is judged by the SAME rules as the row's own Confirm / Discard, in ONE call, never throwing for a single entry.
// confirmEntries({ items: [{ id, trip_id? }] }): an entry is confirmed only if it is still pending and READY — it has a category (an investment: a platform) and
// an amount; `trip_id` is the trip the card suggested (a trip is linked only by the owner's Confirm, as in the single path). Answers
// { confirmed: [ids], kept: [{ id, reason: missing|notPending|needsCategory|needsPlatform|badAmount|refused, message? }] }. The "blank look-alikes follow" learning
// (categoryFollowAfterEdit_) is NOT run here — it belongs to the single Confirm; Telegram's Confirm does not run it either.
function confirmEntries(payload) {
  var items = [], seen = {};
  ((payload && payload.items) || []).forEach(function (it) {
    var id = String((it && it.id) || '');
    if (id && !seen[id]) { seen[id] = true; items.push({ id: id, trip_id: it.trip_id }); }
  });
  var out = { confirmed: [], kept: [] };
  items.forEach(function (it) {
    var entry = getEntryById_(it.id);
    if (!entry) { out.kept.push({ id: it.id, reason: 'missing' }); return; }
    if (entry.status !== 'pending') { out.kept.push({ id: it.id, reason: 'notPending' }); return; }
    if (entry.type !== 'investment' && !entry.category_id) { out.kept.push({ id: it.id, reason: 'needsCategory' }); return; }
    if (entry.type === 'investment' && !entry.to_payment_method_id) { out.kept.push({ id: it.id, reason: 'needsPlatform' }); return; }
    if (!(Math.abs(Number(entry.amount)) > 0)) { out.kept.push({ id: it.id, reason: 'badAmount' }); return; }
    try {
      if (it.trip_id !== undefined && entry.type === 'expense') updateEntryFromApp_({ id: it.id, fields: { trip_id: it.trip_id } });
      confirmEntryWithLearning_(it.id);
      out.confirmed.push(it.id);
    } catch (err) {
      out.kept.push({ id: it.id, reason: 'refused', message: String(err && err.message || err) });
    }
  });
  return out;
}

// discardEntries({ ids }): the row's Discard for each waiting entry. Only entries still pending are discarded; a repayment's entries are never discarded on their
// own (`repayment`, the person deletes the whole repayment from Loans); anything the single discard would refuse is kept with its message.
// Answers { discarded: [ids], kept: [{ id, reason: missing|notPending|repayment|refused, message? }] }.
function discardEntries(payload) {
  var ids = uniqueIds_(payload && payload.ids);
  var out = { discarded: [], kept: [] };
  var candidates = [];
  ids.forEach(function (id) {
    var entry = getEntryById_(id);
    if (!entry) { out.kept.push({ id: id, reason: 'missing' }); return; }
    if (entry.status !== 'pending') { out.kept.push({ id: id, reason: 'notPending' }); return; }
    if (repaymentPartInfo_(id)) { out.kept.push({ id: id, reason: 'repayment' }); return; }
    // The single Discard asks what to do with repayments recorded against the entry (or its exchange partner); a bulk one cannot ask per entry, and
    // silently dropping the choice turned a friend's 30 owed into 20 owed to them (QA round 1, 2026-11-03). Such entries are left for their own Discard.
    var verdict = entryBulkVerdict_(entry);
    if (verdict) { out.kept.push({ id: id, reason: verdict }); return; }
    candidates.push(id);
  });
  // The same 30-day safety copy as the Home bulk delete, written FIRST (a waiting entry is real data: a bulk Discard of 200 had no way back).
  // Restoring brings each entry back still waiting in Needs review. `batch_id` is only answered when something was discarded.
  var batchId = candidates.length && typeof snapshotEntriesForUndo_ === 'function' ? snapshotEntriesForUndo_(candidates) : '';
  candidates.forEach(function (id) {
    try {
      discardEntryWithRepayments_(id, undefined);
      out.discarded.push(id);
    } catch (err) {
      out.kept.push({ id: id, reason: 'refused', message: String(err && err.message || err) });
    }
  });
  if (out.discarded.length && batchId) { out.batch_id = batchId; out.undoable = out.discarded.slice(); }
  return out;
}

// Speed (2026-11-02): one trip to Google for what used to be 2-4 in a row (each costs ~2.5 s on a phone before any work).
// The same functions run in the same order as the separate calls did:
//   create:  createEntry (fields carry client_id + tag_ids), then the Programmed-item link, the split and the bill;
//   update:  updateEntry, then the split, the tags and the bill;
//   confirm: updateEntry, confirmEntry, then the split and the tags (a waiting entry from Needs review).
// A create sent again answers with the entry its client_id already made and lays the split / bill over it again (each
// replaces what is there), so a resend after a lost reply is safe. A failed Programmed-item link does not fail the save
// (the entry is kept; `link_failed` says so), as before.
function saveEntryAll(payload) {
  var kind = payload.kind;
  var id, out;
  // "Repeat…" in the entry form (owner, 2026-11-05): checked BEFORE anything is written, so a bad choice saves nothing.
  if (payload.repeat) validateEntryRepeat_(payload.repeat);
  if (kind === 'create') {
    out = createEntry(payload.fields || {});
    id = out.id;
    if (payload.link_recurring_id) {
      try { linkEntryToRecurring({ entryId: id, recurringExpenseId: payload.link_recurring_id }); }
      catch (linkErr) { out = Object.assign({}, out, { link_failed: true }); }
    }
  } else if (kind === 'update' || kind === 'confirm') {
    id = payload.id;
    out = updateEntryFromApp_({ id: id, fields: payload.fields === undefined ? null : payload.fields });
    if (kind === 'confirm') out = confirmEntryFromApp_({ id: id });
  } else {
    throw new Error('Unknown kind: ' + kind);
  }
  if (payload.splits) saveEntrySplits(id, payload.splits);
  if (kind !== 'create' && payload.tag_ids) saveEntryTags({ entryId: id, tagIds: payload.tag_ids });
  if (payload.bill) saveEntryBill({ entryId: id, bill: payload.bill });
  if (payload.repeat) out = Object.assign({}, out, { repeat: repeatEntryAsProgrammed_(id, payload.repeat) });
  return out;
}

// entry id -> its tag ids, from one read of the Entry Tags tab.
function tagIdsByEntry_() {
  var byEntry = {};
  getAllRows('Entry Tags').forEach(function (et) {
    (byEntry[et.entry_id] = byEntry[et.entry_id] || []).push(et.tag_id);
  });
  return byEntry;
}

function getEntryTags(payload) {
  return getAllRows('Entry Tags')
    .filter(function (et) { return et.entry_id === payload.entryId; })
    .map(function (et) { return et.tag_id; });
}

// Replaces this entry's whole tag set with the new one — same
// recalculate-from-scratch approach saveEntrySplits/saveRecurringExpenseSplits
// use, so editing tags never leaves a stale row behind. Always sent, even
// as [] — that's how removing every tag from an already-tagged entry
// actually clears it.
function saveEntryTags(payload) {
  var entryId = payload.entryId;
  deleteRowsWhere_('Entry Tags', function (row) { return row.entry_id === entryId; });
  var tagIds = payload.tagIds || [];
  tagIds.forEach(function (tagId) { appendRowObject('Entry Tags', { entry_id: entryId, tag_id: tagId }); });
  return { tagIds: tagIds };
}

// With thousands of historical entries now imported, an unbounded fetch
// hangs both the request and the browser trying to render it. Until Phase
// 3 (proper period filtering) exists, cap to the most recent N when no
// explicit date range is given, rather than returning everything.
var DEFAULT_ENTRY_LIMIT = 100;

function nowTimestamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

// Newest date first; entries sharing a date fall back to created_at
// (when to-the-minute or truer time is known) instead of whatever order
// they happen to sit in the sheet — e.g. two same-day purchases showing
// in the order they actually happened rather than a coin flip. Rows from
// before created_at existed (the historical Spendee import) just have no
// tiebreaker and keep their relative sheet order for entries on that date.
function compareEntriesRecency_(a, b) {
  var dateDiff = new Date(b.date) - new Date(a.date);
  if (dateDiff !== 0) return dateDiff;
  var aTs = a.created_at || '';
  var bTs = b.created_at || '';
  if (aTs === bTs) return 0;
  return bTs > aTs ? 1 : -1;
}

function listEntries(payload) {
  // An upload's own list ("See what it added") also shows what it sent to Needs review (pending); every other list is confirmed only.
  var withPending = !!(payload && payload.importBatchId);
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed' || (withPending && e.status === 'pending'); });
  if (payload && payload.startDate) {
    entries = entries.filter(function (e) { return e.date >= payload.startDate; });
  }
  if (payload && payload.endDate) {
    entries = entries.filter(function (e) { return e.date <= payload.endDate; });
  }
  if (payload && payload.type) {
    entries = entries.filter(function (e) { return e.type === payload.type; });
  }
  if (payload && payload.categoryId !== undefined && payload.categoryId !== null) {
    entries = entries.filter(function (e) { return e.category_id === payload.categoryId; });
  }
  // Multi-category budget drill-down (see openBudgetDrilldown in app.js) —
  // an "ALL categories" budget passes neither this nor categoryId, so
  // every category matches, same as no filter at all.
  // A budget's drill-down sends budgetId: a trip set to "Leave out of my budgets" or "Count only in…" (Trips.gs tripBudgetRoutes_)
  // decides for its own expenses, whatever their category, so the list adds up to the budget's "spent".
  var budgetTripRoutes = payload && payload.budgetId ? tripBudgetRoutes_() : null;
  var routedHere = function (e) {
    var t = budgetTripRoutes && e.trip_id ? budgetTripRoutes[e.trip_id] : null;
    return t ? (t.route[String(payload.budgetId)] === true) : null;   // null = as usual
  };
  if (payload && payload.categoryIds && payload.categoryIds.length) {
    var wantedCategoryIds = {};
    payload.categoryIds.forEach(function (id) { wantedCategoryIds[id] = true; });
    entries = entries.filter(function (e) { var r = routedHere(e); return r === null ? !!wantedCategoryIds[e.category_id] : r; });
  } else if (budgetTripRoutes) {
    entries = entries.filter(function (e) { return routedHere(e) !== false; });
  }
  // Overview "By account or card" slices (only Overview sends these): an account, a special slice ("Not repaid yet", …) or
  // "No account" — the same split the pie uses (AccountSlices.gs), each entry with its part in that slice.
  if (payload && payload.paymentMethodId) {
    entries = filterEntriesBySlice_(entries, String(payload.paymentMethodId));
  } else if (payload && payload.noAccount) {
    entries = filterEntriesBySlice_(entries, '');
  }
  // Overview Investments card: deposits into / withdrawals from one platform.
  if (payload && payload.toPaymentMethodId !== undefined && payload.toPaymentMethodId !== null) {
    entries = entries.filter(function (e) { return (e.to_payment_method_id || '') === payload.toPaymentMethodId; });
  }
  // A MONTHLY budget's drill-down: the entries it actually counts, so the list
  // adds up to the budget's own "spent" figure (Annual-tagged ones don't count
  // against a monthly budget — see excludeAnnual in Budgets.gs).
  if (payload && payload.excludeAnnual) {
    var annualIds = annualEntryIdSet_();
    entries = entries.filter(function (e) { return !annualIds[e.id]; });
  }
  // The other way round: only the Annual-tagged ones (a monthly budget's "… tagged Annual, not counted ›", 2026-11-07).
  if (payload && payload.onlyAnnual) {
    var annualOnly = annualEntryIdSet_();
    entries = entries.filter(function (e) { return !!annualOnly[e.id]; });
  }
  // Exactly these entries (Overview's summary list sends one page of ids, Reports.gs listPeriodFlows).
  if (payload && payload.entryIds && payload.entryIds.length) {
    var wantedIds = {};
    payload.entryIds.forEach(function (id) { wantedIds[id] = true; });
    entries = entries.filter(function (e) { return wantedIds[e.id]; });
  }
  if (payload && payload.tripId) {
    entries = entries.filter(function (e) { return e.trip_id === payload.tripId; });
  }
  // Business pack: one project's or one company's entries (a company includes its projects'). Ignored while off.
  if (payload && payload.projectId && businessOn_()) {
    entries = entries.filter(function (e) { return String(e.project_id || '') === String(payload.projectId); });
  }
  if (payload && payload.companyId && businessOn_()) {
    entries = entries.filter(function (e) { return String(e.company_id || '') === String(payload.companyId); });
  }
  // Overview's "Showing" filter (personal / one company / one project), so a drill-down adds up to the totals it came from.
  if (payload && payload.scope) entries = filterEntriesByScope_(entries, payload.scope);
  // The entries one statement upload created ("See what it added" on the Statements screen).
  if (payload && payload.importBatchId) {
    entries = entries.filter(function (e) { return e.import_batch_id === payload.importBatchId; });
  }
  if (payload && payload.tagId) {
    var entryIdsWithTag = {};
    getAllRows('Entry Tags').forEach(function (et) {
      if (et.tag_id === payload.tagId) entryIdsWithTag[et.entry_id] = true;
    });
    entries = entries.filter(function (e) { return entryIdsWithTag[e.id]; });
  }
  if (payload && payload.noTag) {
    var taggedEntryIds = {};
    getAllRows('Entry Tags').forEach(function (et) { taggedEntryIds[et.entry_id] = true; });
    entries = entries.filter(function (e) { return !taggedEntryIds[e.id]; });
  }

  // Entries-tab search bar: every typed word must appear somewhere in the
  // entry's searchable text (see filterEntriesBySearch_).
  if (payload && payload.search && String(payload.search).trim()) {
    entries = filterEntriesBySearch_(entries, String(payload.search));
  }

  entries.sort(compareEntriesRecency_);

  // A category/tag/payment-method drill-down is always a small, specific
  // slice — never cap it, even without a date range (e.g. "All-time").
  var hasFilter = payload && (payload.startDate || payload.endDate ||
    payload.categoryId !== undefined || (payload.categoryIds && payload.categoryIds.length) ||
    payload.tagId || payload.noTag || payload.noAccount || (payload.entryIds && payload.entryIds.length) || payload.toPaymentMethodId !== undefined || payload.tripId || payload.projectId || payload.companyId || (payload.scope && payload.scope !== 'all') || payload.paymentMethodId || payload.importBatchId);
  var limit = (payload && payload.limit) || (hasFilter ? null : DEFAULT_ENTRY_LIMIT);
  // `offset` (Entries tab's "Load more"): skip that many of the newest rows
  // first, so the next page can be fetched without re-sending earlier ones.
  var offset = (payload && payload.offset) || 0;
  if (limit) entries = entries.slice(offset, offset + limit);
  else if (offset) entries = entries.slice(offset);

  // own_share/own_share_pen: this entry's actual cost to the owner (amount
  // minus whatever's been split off to friends — Entry Splits is
  // expense-only, same reasoning as Reports.gs/Budgets.gs/Projections.gs).
  // `amount`/`amount_pen` stay the FULL disbursement (still needed as-is
  // for editing an entry, Loans, etc.) — this only adds the owner's-share
  // figure alongside it, for the frontend to render per CLAUDE.md's
  // "big amount is my share" rule.
  var splitSumByEntry = {};
  var splitsByEntry = {};
  var tagIdsByEntry = tagIdsByEntry_();
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
    (splitsByEntry[s.entry_id] = splitsByEntry[s.entry_id] || []).push({ friend_id: s.friend_id, amount: Number(s.amount) });
  });
  // The due date the split's debts carry (one for the whole entry, '' = none), so the edit form can show it at once.
  var splitDueByEntry = {};
  if (Object.keys(splitsByEntry).length) {
    getAllRows('Loans').forEach(function (l) {
      if (l.origin === 'entry' && l.due_date && splitsByEntry[l.entry_id] && !splitDueByEntry[l.entry_id]) splitDueByEntry[l.entry_id] = String(l.due_date);
    });
  }

  // Transfers that are a repayment / cash loan with a friend carry `link`
  // (see buildTransferLinkMap_) so the app can name the friend instead of
  // saying "Between Accounts".
  var transferLinks = entries.some(function (e) { return e.type === 'transfer' || e.type === 'income' || e.type === 'expense'; }) ? buildTransferLinkMap_() : {};
  entries.forEach(function (entry) {
    entry.amount_pen = computeAmountPen(entry.amount, entry.currency, entry.date);
    if (transferLinks[entry.id]) entry.link = transferLinks[entry.id];
    var ownShare = entry.type === 'expense'
      ? Number(entry.amount) - (splitSumByEntry[entry.id] || 0)
      : Number(entry.amount);
    entry.own_share = ownShare;
    // Already read above — lets the edit form show a split instantly instead of
    // waiting on a separate getEntrySplits call.
    entry.splits = splitsByEntry[entry.id] || [];
    entry.split_due_date = splitDueByEntry[entry.id] || '';
    // Same idea for the labels: the row shows them after "who paid", and the
    // edit form reuses them instead of a separate getEntryTags call.
    entry.tagIds = tagIdsByEntry[entry.id] || [];
    entry.own_share_pen = computeAmountPen(ownShare, entry.currency, entry.date);
    var usdShare = usdLineAmount_(buildRatesByCurrency_(), ownShare, entry.currency, entry.date);
    if (usdShare != null) entry.own_share_usd = usdShare;   // third currency: the share in dollars, under the main amount (RatesUsd.gs)
  });
  return entries;
}

// Lowercase and accent-free, so "cafe" finds "Café" and "YAPE" finds "yape".
function searchNormalize_(text) {
  return String(text == null ? '' : text).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Lookup tables for entrySearchText_, built once per request.
function buildSearchLookups_() {
  var tagsById = rowsById_(getAllRows('Tags'));
  var tagNamesByEntry = {};
  var tagSearchNamesByEntry = {};
  getAllRows('Entry Tags').forEach(function (et) {
    var tag = tagsById[et.tag_id];
    if (!tag) return;
    (tagNamesByEntry[et.entry_id] = tagNamesByEntry[et.entry_id] || []).push(tag.name);
    (tagSearchNamesByEntry[et.entry_id] = tagSearchNamesByEntry[et.entry_id] || []).push(tagSearchNames_(tag));
  });
  return {
    tripsById: rowsById_(getTripRows_()),
    companiesById: rowsById_(getCompanyRows_()),     // empty (and nothing read) while the Business pack is off
    projectsById: rowsById_(getProjectRows_()),
    categoriesById: rowsById_(getAllRows('Categories')),
    methodsById: rowsById_(getAllRows('Payment Methods')),
    friendsById: rowsById_(getAllRows('Friends')),
    payorsById: rowsById_(getPayorRows_()),
    tagNamesByEntry: tagNamesByEntry,
    tagSearchNamesByEntry: tagSearchNamesByEntry,
    transferLinks: buildTransferLinkMap_()
  };
}

/**
 * The one definition of "what text can find this entry": description, the
 * bank's merchant name, category (and its parent), type, date, amount (as
 * stored and as 2 decimals), currency, payment method (both ends of a
 * transfer), who paid / who paid the owner, and labels — lowercased and
 * accent-free. Used both by the server-side `search` filter and shipped to
 * the app (`_s`) so its instant, as-you-type search matches identically.
 */
function entrySearchText_(e, lk) {
  var cat = lk.categoriesById[e.category_id];
  var parent = cat && cat.parent_id ? lk.categoriesById[cat.parent_id] : null;
  var payer = e.type === 'income' ? lk.payorsById[e.paid_by] : lk.friendsById[e.paid_by];
  var parts = [
    e.description, e.merchant, e.type, e.date, e.currency,
    e.amount, isNaN(Number(e.amount)) ? '' : Number(e.amount).toFixed(2),
    cat && categorySearchNames_(cat), parent && categorySearchNames_(parent),
    lk.methodsById[e.payment_method_id] && lk.methodsById[e.payment_method_id].nickname,
    lk.methodsById[e.to_payment_method_id] && lk.methodsById[e.to_payment_method_id].nickname,
    e.paid_by === 'me' ? 'me' : (payer && payer.name),
    (lk.tagSearchNamesByEntry[e.id] || []).join(' '),
    e.trip_id && lk.tripsById && lk.tripsById[e.trip_id] && lk.tripsById[e.trip_id].name,
    e.company_id && lk.companiesById && lk.companiesById[e.company_id] && lk.companiesById[e.company_id].name,
    e.project_id && lk.projectsById && lk.projectsById[e.project_id] && lk.projectsById[e.project_id].name,
    lk.transferLinks && lk.transferLinks[e.id] && (lk.transferLinks[e.id].kind + ' ' + lk.transferLinks[e.id].friend)
  ];
  return searchNormalize_(parts.filter(function (x) { return x != null && x !== ''; }).join(' | '));
}

// AND-search: each whitespace-separated word must appear as a substring of
// the entry's search text. No fuzzy/AI matching — a plain, explainable rule.
function filterEntriesBySearch_(entries, search) {
  var words = searchNormalize_(search).split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  var lk = buildSearchLookups_();
  return entries.filter(function (e) {
    var haystack = entrySearchText_(e, lk);
    return words.every(function (w) { return haystack.indexOf(w) !== -1; });
  });
}

/**
 * Every confirmed entry, newest first, in the compact shape the Entries-tab
 * search needs to run entirely on the phone (instant as-you-type results):
 * just the fields rows/editing use, plus `_s` (see entrySearchText_).
 * Exchange rates are read ONCE — computeAmountPen re-reads the rates sheet
 * on every call, which is far too slow across thousands of entries.
 */
function listEntrySearchIndex() {
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  entries.sort(compareEntriesRecency_);
  return buildSearchIndexRows_(entries);
}

// Shapes entry rows for the phone's search copy. Exchange rates are read
// ONCE — computeAmountPen re-reads the rates sheet on every call, which is
// far too slow across thousands of entries.
function buildSearchIndexRows_(entries) {
  if (!entries.length) return [];
  var lk = buildSearchLookups_();
  var ratesByCurrency = buildRatesByCurrency_();
  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (sp) {
    splitSumByEntry[sp.entry_id] = (splitSumByEntry[sp.entry_id] || 0) + Number(sp.amount);
  });
  var tagIdsByEntry = tagIdsByEntry_();
  var pen = function (amount, currency, date) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(date).substring(0, 7));
    return rate != null ? amount * rate : null;
  };
  var business = businessOn_();
  return entries.map(function (e) {
    var ownShare = e.type === 'expense' ? Number(e.amount) - (splitSumByEntry[e.id] || 0) : Number(e.amount);
    var row = {
      id: e.id, type: e.type, date: e.date, amount: e.amount, currency: e.currency,
      category_id: e.category_id, description: e.description,
      payment_method_id: e.payment_method_id, to_payment_method_id: e.to_payment_method_id,
      paid_by: e.paid_by, created_at: e.created_at,
      amount_pen: pen(e.amount, e.currency, e.date),
      own_share: ownShare,
      own_share_pen: pen(ownShare, e.currency, e.date),
      link: lk.transferLinks[e.id] || undefined,
      tagIds: tagIdsByEntry[e.id] || [],
      trip_id: e.trip_id || '',
      exchange: e.exchange ? '1' : '',
      exchange_pair: e.exchange_pair || '',
      _s: entrySearchText_(e, lk)
    };
    var usdShare = usdLineAmount_(ratesByCurrency, ownShare, e.currency, e.date);
    if (usdShare != null) row.own_share_usd = usdShare;   // third currency: the share in dollars (RatesUsd.gs)
    // Only while the Business pack is on, so a personal-only copy's search data is exactly what it was.
    if (e.income_waiting) row.income_waiting = e.income_waiting;
    if (business) { row.company_id = e.company_id || ''; row.project_id = e.project_id || ''; row.expected_payment_id = e.expected_payment_id || ''; row.igv_amount = e.igv_amount || ''; }
    return row;
  });
}

// "Possible duplicate" warning (owner's request, 2026-10-01): the same day,
// currency, amount AND merchant (the bank's own merchant name when the entry
// came from an email, else the normalised description) as another entry —
// confirmed or still pending. NEVER acted on automatically: legitimate
// repeats are common (a payment split because of a bank's commission
// threshold or Yape/Plin limits), so this only warns and the owner decides.
// Same day only; an entry with no merchant/description never matches.
function entryTwinWho_(e) {
  return e.merchant ? String(e.merchant) : searchNormalize_(e.description);
}

function findSameDayTwins_(entry, allEntries) {
  var who = entryTwinWho_(entry);
  var amount = Math.abs(Number(entry.amount)).toFixed(2);
  // Wider for an entry read from a bank e-mail (2026-11-05, the double-count map): the same money already recorded by HAND, from a
  // photo or from a statement/import usually carries another name and often another day (a subscription typed in, a statement
  // line). So: same currency and amount within 1 day either side (owner, 2026-11-05: 2 days was too wide), whatever the name,
  // when the other entry did not come from an e-mail.
  // E-mail vs e-mail keeps the same-day, same-name rule (bank operation numbers already stop real repeats there). Warn only.
  var fromEmail = entry.source === 'email';
  if (!who && !fromEmail) return [];
  return allEntries.filter(function (o) {
    if (o.id === entry.id || o.currency !== entry.currency || Math.abs(Number(o.amount)).toFixed(2) !== amount) return false;
    if (who && o.date === entry.date && entryTwinWho_(o) === who) return true;
    return fromEmail && o.source !== 'email' && (o.status === 'confirmed' || o.status === 'pending') &&
      Math.abs(daysBetweenDates_(String(o.date).substring(0, 10), String(entry.date).substring(0, 10))) <= 1;
  }).map(function (o) {
    return { id: o.id, status: o.status, description: o.description || '' };
  });
}

function listPendingEntries() {
  var all = getAllRows('Entries');
  var entries = all.filter(function (e) { return e.status === 'pending'; });
  var trips = getTripRows_();
  // A waiting entry can be a repayment's extra (income / expense with no category yet): it carries `link` like a confirmed one
  // so the Needs review row can send Discard to the repayment's screen instead of deleting it on its own.
  var transferLinks = entries.length ? buildTransferLinkMap_() : {};
  var waitingIncome = entries.some(function (e) { return e.type === 'income'; }) ? listWaitingIncome_() : [];
  var payeeHist = entries.length ? buildPayeeHistory_() : null;   // PayeeGuess.gs
  entries.forEach(function (entry) {
    if (transferLinks[entry.id]) entry.link = transferLinks[entry.id];
    entry.amount_pen = computeAmountPen(entry.amount, entry.currency, entry.date);
    entry.twins = findSameDayTwins_(entry, all);
    if (ownerNameMaybeOwn_(entry)) entry.maybe_own = true;   // "Maybe yours?" while no own name is confirmed (OwnerNames.gs)
    // A suggestion only (the review card pre-selects it; it is linked when the owner confirms).
    if (entry.type === 'expense' && !entry.trip_id && !isPracticeReview_(entry)) entry.suggested_trip_id = suggestedTripIdForDate_(entry.date, trips);
    // "Looks like a loan to Ana again" (a place the person turned into a loan / repayment before): a suggestion only.
    var loanHint = entry.source === 'email' ? payeeLoanHint_(entry, payeeHist) : null;
    if (loanHint) entry.loan_hint = loanHint;
    var chargeMatch = chargeMatchForReview_(entry, all);   // "Is this the charge of …?" (Charges.gs)
    if (chargeMatch) entry.charge_match = chargeMatch;
    var waitingMatch = waitingMatchForPending_(entry, waitingIncome);   // "Is this the payment you were waiting for?" (IncomeWaiting.gs)
    if (waitingMatch) entry.waiting_match = waitingMatch;
  });
  entries.sort(compareEntriesRecency_);
  return entries;
}

function updateEntryFields(entryId, fields) {
  fields = businessFieldsForUpdate_(entryId, fields);   // Business pack link cleaned (Business.gs); untouched when it is not involved
  if (fields && fields.to_payment_method_id !== undefined) ensureEntriesToPaymentMethodColumn_();
  if (fields && fields.exchange !== undefined) ensureEntriesExchangeColumn_();   // "Not an exchange" clears it (a statement-made side may predate the column)
  if (fields && (fields.paid_amount !== undefined || fields.charge_pending !== undefined)) ensureEntriesChargeColumns_();
  if (fields && fields.trip_id !== undefined) {
    fields = Object.assign({}, fields, { trip_id: validTripIdOrBlank_(fields.trip_id) });
    if (fields.trip_id) ensureEntriesTripColumn_();
  }
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) throw new Error(tr_('err.entryNotFound'));

  var categoryChanges = !!fields && fields.category_id !== undefined;
  var categoryBefore = categoryChanges ? (getEntryById_(entryId) || {}).category_id : null;
  withWriteBatch_(function () {
    Object.keys(fields || {}).forEach(function (key) {
      setCellByRow_(sheet, headers, rowIndex, key, fields[key]);
    });
    // An investment never carries a category the owner has to pick (see
    // defaultInvestmentCategoryId_) — file it under the default one.
    var after = getEntryById_(entryId);
    if (after && after.type === 'investment' && needsInvestmentCategory_(after.category_id)) {
      setCellByRow_(sheet, headers, rowIndex, 'category_id', defaultInvestmentCategoryId_());
    }
    // Moved INTO Travel (Telegram edit, review queue): it becomes Annual too.
    // Only on a real change, so re-saving an old Travel entry never re-adds a
    // tag the owner removed.
    if (after && categoryChanges && after.category_id !== categoryBefore) autoTagTravelEntry_(after);
  });
  // Business pack: the debts this entry made follow its project.
  if (fields && fields.project_id !== undefined) syncEntryLoanProject_(entryId);

  return getEntryById_(entryId);
}

/**
 * Needs review: "this is not an expense/income, it is my own money moving". A PENDING expense or income
 * becomes a (one-sided) transfer: an expense left its account, so that account is the "From"; an income
 * arrived, so its account is the "To". The other side stays blank for the owner to pick on the card.
 * The expense's category is dropped (the lone transfer category is used when there is one); no trip. Description and amount typed in the row ride along.
 * payload: { id, description?, amount? }. Returns the updated entry.
 */
function convertPendingToTransfer(payload) {
  var entry = getEntryById_(payload.id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  if (entry.status !== 'pending' || (entry.type !== 'expense' && entry.type !== 'income')) {
    throw new Error(tr_('review.alreadyHandled'));
  }
  var account = entry.payment_method_id || '';
  // The card still asks for a category on a transfer: when there is only one transfer category
  // ("Between accounts"), pick it so the owner doesn't have to.
  var transferCats = getAllRows('Categories').filter(function (c) { return c.type === 'transfer'; });
  var fields = {
    type: 'transfer',
    category_id: transferCats.length === 1 ? transferCats[0].id : '',
    payment_method_id: entry.type === 'expense' ? account : '',
    to_payment_method_id: entry.type === 'income' ? account : ''
  };
  if (entry.trip_id) fields.trip_id = '';
  if (payload.description !== undefined) fields.description = String(payload.description);
  var amount = Number(payload.amount);
  if (payload.amount !== undefined && amount > 0) fields.amount = amount;
  return updateEntryFields(payload.id, fields);
}

function computeAmountPen(amount, currency, dateStr) {
  if (currency === homeCurrency_()) return amount;
  var month = String(dateStr).substring(0, 7);
  var rate = getLatestRateOnOrBefore_(currency, month);
  return rate != null ? amount * rate : null;
}

// ---- Exchange rates ----

// For the More > Exchange rates screen — every rate ever set, most recent
// month first, so an existing one can be found and edited (setExchangeRate
// already upserts; nothing else needs to change to support editing, since
// an entry's PEN amount is derived fresh from whatever rate is on file at
// read time, never stored — see CLAUDE.md's Entries section).
function listExchangeRates() {
  var by = buildRatesByCurrency_();
  var main = homeCurrency_(), base = rateBase_();
  var usd = ratesThroughUsd_();   // each row also says "1 USD = per_usd <currency>" (RatesUsd.gs)
  var out = [];
  getAllRows('Exchange Rates').forEach(function (r) {
    var cur = String(r.currency).toUpperCase();
    var rate = rowRateToBase_(r.rate);
    if (cur === base) return;   // the base has no rate of its own (it is 1)
    var row;
    if (cur === main) {
      // The main currency's own row, shown from the other side: 1 BASE = 1/rate MAIN.
      row = { id: r.id, currency: base, month: r.month, rate: 1 / rate };
    } else {
      var m = mainBaseRateAt_(by, r.month);
      if (m != null) row = { id: r.id, currency: cur, month: r.month, rate: rate / m };
    }
    if (!row) return;
    if (usd) row.per_usd = Number(r.rate);
    out.push(row);
  });
  return out.sort(function (a, b) {
    if (a.month !== b.month) return a.month < b.month ? 1 : -1;
    return a.currency < b.currency ? -1 : 1;
  });
}

// The stored row (rate in BASE terms) for exactly this currency and month, or null.
function getRateRow_(currency, month) {
  var match = getAllRows('Exchange Rates').filter(function (r) {
    return String(r.currency).toUpperCase() === currency && r.month === month;
  });
  return match.length ? match[0] : null;
}

// The rate for exactly this currency and month, as the person reads it: 1 <currency> = rate <MAIN currency>.
// Null when none was set for that month (the entry flow then asks for it).
function getExchangeRate(currency, month) {
  currency = String(currency || '').trim().toUpperCase();
  var main = homeCurrency_(), base = rateBase_();
  if (currency === main) return null;
  if (currency === base) {
    var mainRow = getRateRow_(main, month);
    return mainRow ? { id: mainRow.id, month: month, currency: base, rate: 1 / rowRateToBase_(mainRow.rate) } : null;
  }
  var row = getRateRow_(currency, month);
  if (!row) return null;
  var m = mainBaseRateAt_(buildRatesByCurrency_(), month);
  return m == null ? null : { id: row.id, month: month, currency: currency, rate: rowRateToBase_(row.rate) / m };
}

// Every rate on file, grouped by currency and sorted ascending by month —
// the shared shape latestRateFromList_/getLatestRateOnOrBefore_ read, and
// the same shape Budgets.gs's buildBudgetContext_ builds independently
// (rebuilding it there too, since it already has its own Exchange Rates
// read folded into a larger one-time context for performance).
// Memoised for the duration of one request: building it reads the whole
// Exchange Rates sheet, and the Overview summary asks for a rate once per
// foreign-currency entry (hundreds of times — ~700 sheet reads before this).
// Cleared at the start of every request (doPost) and on any rate write, so a
// warm script instance never serves stale rates. Callers only read the map.
var RATES_MEMO_ = null;

function buildRatesByCurrency_() {
  if (RATES_MEMO_) return RATES_MEMO_;
  var map = {};
  getAllRows('Exchange Rates').forEach(function (r) {
    if (!map[r.currency]) map[r.currency] = [];
    map[r.currency].push({ month: r.month, rate: rowRateToBase_(r.rate) });   // "1 USD = r X" rows turned around (RatesUsd.gs)
  });
  Object.keys(map).forEach(function (c) {
    map[c].sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  });
  RATES_MEMO_ = map;
  return map;
}

// list: this currency's sorted-by-month rate rows (or undefined). Finds
// the most recent one at or before cutoffMonth — a plain linear scan
// since a single currency's rate history is always small.
function latestRateFromList_(list, cutoffMonth) {
  if (!list) return null;
  var best = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].month <= cutoffMonth) best = list[i];
  }
  return best ? best.rate : null;
}

// General rule: anything OTHER than the act of saving an entry (which
// requires and prompts for its own exact month's rate — see
// ensureExchangeRate in app.js) uses the most recent rate on file at or
// before the month it needs, rather than requiring an exact match.
// amount_pen is always derived fresh at render time, never stored (see
// CLAUDE.md's Entries section) — entry lists, reports, budgets, and
// projections all go through this, so a currency/month that was never
// explicitly rated (common for older imported entries) still resolves
// to a sensible figure instead of silently dropping the amount.
function getLatestRateOnOrBefore_(currency, month) {
  if (currency === homeCurrency_()) return 1;
  return rateToMain_(buildRatesByCurrency_(), currency, month);
}

// `rate` is what the person reads and types: 1 <currency> = rate <MAIN currency>. It is stored in BASE terms
// (see HomeCurrency.gs), so changing the main currency later never rewrites a stored rate.
function setExchangeRate(currency, month, rate) {
  currency = String(currency || '').trim().toUpperCase();
  month = String(month || '').trim();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(tr_('err.monthFormat'));
  rate = Number(rate);
  if (!isFinite(rate) || rate <= 0) throw new Error(tr_('err.rateGreater'));
  var main = homeCurrency_(), base = rateBase_();
  if (currency === main) throw new Error(tr_('err.rateMain'));
  RATES_MEMO_ = null;
  var storeCurrency, storeRate;
  if (currency === base) {
    storeCurrency = main; storeRate = 1 / rate;           // 1 BASE = rate MAIN  =>  1 MAIN = 1/rate BASE
  } else {
    var m = mainBaseRateAt_(buildRatesByCurrency_(), month);
    if (m == null) throw new Error(tr_('err.rateMainFirst'));
    storeCurrency = currency; storeRate = rate * m;
  }
  upsertBaseRate_(storeCurrency, month, storeRate);
  return { id: (getRateRow_(storeCurrency, month) || {}).id, month: month, currency: currency, rate: rate };
}

// Once rates go through the dollar (RatesUsd.gs): `perUsd` is what the person typed, 1 USD = perUsd <currency> (for USD
// itself, 1 USD = perUsd <MAIN>). Answers like setExchangeRate (rate = 1 <currency> = rate <MAIN>), plus per_usd.
function setUsdRate(currency, month, perUsd) {
  currency = String(currency || '').trim().toUpperCase();
  month = String(month || '').trim();
  if (!ratesThroughUsd_()) throw new Error(tr_('rates.usdNotYet'));
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(tr_('err.monthFormat'));
  perUsd = Number(perUsd);
  if (!isFinite(perUsd) || perUsd <= 0) throw new Error(tr_('err.rateGreater'));
  var main = homeCurrency_();
  if (currency === main) throw new Error(tr_('err.rateMain'));
  var code = currency === 'USD' ? main : currency;   // the row that holds it: 1 USD = perUsd <code>
  upsertBaseRate_(code, month, 1 / perUsd);
  var rate = getLatestRateOnOrBefore_(currency, month);
  return { id: (getRateRow_(code, month) || {}).id, month: month, currency: currency, rate: rate, per_usd: perUsd };
}

// Writes one row of the Exchange Rates table (rate in BASE terms), replacing the month's row if there is one.
function upsertBaseRate_(currency, month, baseRate) {
  var existing = getRateRow_(currency, month);
  if (existing) {
    var sheet = getSheet('Exchange Rates');
    var headers = getHeaders(sheet);
    var rowIndex = findRowIndexById(sheet, headers, existing.id);
    sheet.getRange(rowIndex, headers.indexOf('rate') + 1).setValue(baseRateToRow_(baseRate));
    bumpStructureVersion_();
  } else {
    appendRowObject('Exchange Rates', { id: Utilities.getUuid(), month: month, currency: currency, rate: baseRateToRow_(baseRate) });
  }
  RATES_MEMO_ = null;
}

// ---- Small "add new" helpers used inline from the form ----

function addFriend(payload) {
  // Idempotent by name (same as addPaymentMethod): a second "Ana" would split
  // that person's loans across two friends and break their FIFO balance.
  var name = String(payload.name || '').trim();
  if (!name) throw new Error(tr_('err.enterName'));
  // More → Friends → Add can carry a WhatsApp number (Business.gs § setFriendPhone); checked before anything is written.
  var phone = payload.phone ? normalizeFriendPhone_(payload.phone) : '';
  var existing = getAllRows('Friends').find(function (f) {
    return String(f.name).trim().toLowerCase() === name.toLowerCase();
  });
  if (existing) {
    // A HIDDEN friend with this name comes back (with their history) instead of a second person being created.
    if (String(existing.hidden) === 'yes') { setFriendHidden_(existing.id, false); existing.hidden = ''; existing.unhidden = true; }
    // A number is only filled in where there is none: typing a name that already exists must not silently replace that friend's number (QA round 2).
    // `existed` tells the app it was NOT a new person; `phoneKept` that the number it sent was not used.
    existing.existed = true;
    if (phone) {
      if (!String(existing.phone || '').replace(/\D/g, '')) { writeFriendPhone_(existing.id, phone); existing.phone = phone; }
      else if (String(existing.phone).replace(/\D/g, '') !== phone.replace(/\D/g, '')) existing.phoneKept = true;
    }
    return existing;
  }
  var friend = { id: Utilities.getUuid(), name: name, notes: payload.notes || '' };
  // Business pack: a client / supplier / partner. Ignored while the pack is off, so a personal copy never gets the column.
  var role = businessRoleFromPayload_(payload.role);
  if (role !== 'friend') { ensureBusinessSheets_(); friend.role = role; }
  appendRowObject('Friends', friend);
  if (phone) { writeFriendPhone_(friend.id, phone); friend.phone = phone; }
  return friend;
}

function addTag(payload) {
  // Typing "annual"/"anual" means the built-in Annual tag — never a second one.
  if (isAnnualTagName_(payload.name)) {
    ensureAnnualTag_();
    return localizeTags_(getAllRows('Tags').filter(function (t) { return t.id === ANNUAL_TAG_ID; }))[0];
  }
  var tag = { id: Utilities.getUuid(), name: payload.name, color: payload.color || '' };
  appendRowObject('Tags', tag);
  return tag;
}

function addPaymentMethod(payload) {
  // Idempotent by nickname — the "+ Add payment method…" flow re-prompts
  // every time (e.g. tapping it again for "Cash" instead of picking the
  // one already in the list), and previously created a brand-new row each
  // time. Reuse an existing match instead of duplicating it.
  var nickname = String(payload.nickname || '').trim();
  var existing = getAllRows('Payment Methods').find(function (pm) {
    return String(pm.nickname).trim().toLowerCase() === nickname.toLowerCase();
  });
  if (existing) return existing;

  var pm = {
    id: Utilities.getUuid(),
    nickname: nickname,
    type: payload.type,
    bank_id: payload.bank_id || '',
    last_4: payload.last_4 || ''
  };
  appendRowObject('Payment Methods', pm);
  return pm;
}

// ---- Accounts & cards screen (More tab): add + edit in one action ----

var PAYMENT_METHOD_TYPES_ = ['credit', 'debit', 'cash', 'transfer', 'wallet', 'investment'];
// 'transfer' is no longer offered for a NEW account (owner, 2026-11-02: a bank transfer always leaves a real account, and the
// word already means a move between your own accounts); an account that has it keeps it.

// ---- The built-in Cash account (owner, 2026-11-02) ----
// Every copy has one account for cash, in any currency (soles and dollars together: balances are kept per currency). It is made
// on the first open (or the first existing cash account is adopted, so nobody gets a second one), remembered in Settings
// `cash_account_id`, and can be renamed but never deleted, hidden or turned into another type.
function cashAccountId_() {
  return String(getSettingsMap().cash_account_id || '');
}
function isBasicCashAccount_(id) {
  var cid = cashAccountId_();
  return !!cid && String(id || '') === cid;
}
function ensureCashAccount_() {
  var pms = getAllRows('Payment Methods');
  var cid = cashAccountId_();
  if (cid && pms.some(function (p) { return String(p.id) === cid; })) return;
  var existing = pms.find(function (p) { return p.type === 'cash' && String(p.hidden || '') !== 'yes'; }) ||
    pms.find(function (p) { return p.type === 'cash'; });
  if (existing) {
    if (String(existing.hidden || '') === 'yes') setPaymentMethodHidden({ id: existing.id, hidden: false });
    setSetting_('cash_account_id', String(existing.id));
    return;
  }
  var taken = {};
  pms.forEach(function (p) { taken[String(p.nickname).trim().toLowerCase()] = true; });
  var name = tr_('pm.cashName'), n = 2;
  while (taken[name.toLowerCase()]) name = tr_('pm.cashName') + ' ' + (n++);
  var pm = { id: Utilities.getUuid(), nickname: name, type: 'cash', bank_id: '', last_4: '' };
  appendRowObject('Payment Methods', pm);
  setSetting_('cash_account_id', pm.id);
  bumpStructureVersion_();
}

// last_4 is digits that may start with 0 ("0123"): Sheets turns a typed "0123"
// into the number 123 unless the cell is text first (CLAUDE.md: text-date trap).
function setPaymentMethodLast4_(sheet, headers, rowIndex, last4) {
  var col = headers.indexOf('last_4');
  if (col === -1) return;
  sheet.getRange(rowIndex, col + 1).setNumberFormat('@');
  setCellByRow_(sheet, headers, rowIndex, 'last_4', last4);
}

// Without `id` it adds an account; with `id` it edits that one. Unlike the
// inline addPaymentMethod (which quietly reuses a same-name row), a name
// already taken by ANOTHER account is an error here — the owner is looking
// at the list and chose to save. Entries point at the account's id, so a
// rename or a changed bank/last-4 never detaches past entries.
function savePaymentMethod(payload) {
  var nickname = String(payload.nickname || '').trim();
  if (!nickname) throw new Error(tr_('err.enterName'));
  var type = String(payload.type || '').trim().toLowerCase();
  if (PAYMENT_METHOD_TYPES_.indexOf(type) === -1) throw new Error(tr_('err.pmType'));
  var last4 = String(payload.last_4 == null ? '' : payload.last_4).trim();
  if (last4 && !/^\d{4}$/.test(last4)) throw new Error(tr_('err.pmLast4'));
  var bankId = String(payload.bank_id || '').trim();
  if (bankId && !getAllRows('Banks').some(function (b) { return String(b.id) === bankId; })) {
    throw new Error(tr_('err.pmBank'));
  }
  var id = payload.id ? String(payload.id) : '';
  if (!id && type === 'transfer') throw new Error(tr_('err.pmType'));
  if (id && type !== 'cash' && isBasicCashAccount_(id)) throw new Error(tr_('err.pmCashType'));
  var taken = getAllRows('Payment Methods').some(function (pm) {
    return String(pm.id) !== id && String(pm.nickname).trim().toLowerCase() === nickname.toLowerCase();
  });
  if (taken) throw new Error(tr_('err.pmNameTaken'));
  // Plin is not an account (owner, 2026-10-23): it is linked from the bank account behind it. Only a new or renamed row is refused.
  if (plainNickname_(nickname) === 'plin') {
    var current = id && getAllRows('Payment Methods').find(function (p) { return String(p.id) === id; });
    if (!current || plainNickname_(current.nickname) !== 'plin') throw new Error(tr_('err.pmPlin'));
  }

  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  // A list of currencies (2026-11-06). One names the account's kind as `currency` always did; several or none leave a savings account's kind as it
  // is, and make a card plain 'credit'.
  var hasList = Array.isArray(payload.currencies) && (type === 'debit' || type === 'credit');
  var listValue = hasList ? accountCurrenciesValue_(payload.currencies) : '';
  if (hasList) {
    payload = Object.assign({}, payload);
    delete payload.currency;
    if (/^[A-Z]{3}$/.test(listValue)) payload.currency = listValue;
    else if (type === 'credit') payload.currency = '';
    ensurePaymentMethodCurrenciesColumn_();
    headers = getHeaders(sheet);
  }
  if (!id) {
    var pm = { id: Utilities.getUuid(), nickname: nickname, type: type, bank_id: bankId, last_4: '' };
    var newKind = accountCurrencyKind_(payload, type, null);
    if (newKind) { ensurePaymentMethodAliasColumns_(); headers = getHeaders(sheet); pm.alias_kind = newKind; pm.alias_auto = 'no'; }
    if (hasList) pm.currencies = listValue;
    appendRowObject('Payment Methods', pm);
    if (last4) {
      setPaymentMethodLast4_(sheet, headers, findRowIndexById(sheet, headers, pm.id), last4);
    }
    pm.last_4 = last4;
    return pm;
  }
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex === -1) throw new Error(tr_('err.pmNotFound'));
  // A name made automatically stays automatic only while the person leaves its name, type and bank alone
  // (Accounts.gs); a change to the last 4 of an automatic name that shows them refreshes the name.
  var before = getAllRows('Payment Methods').find(function (p) { return String(p.id) === id; }) || {};
  if (String(before.alias_auto) === 'yes' && headers.indexOf('alias_auto') !== -1) {
    var sameName = String(before.nickname) === nickname, sameType = String(before.type) === type, sameBank = String(before.bank_id || '') === bankId;
    if (!(sameName && sameType && sameBank)) {
      setCellByRow_(sheet, headers, rowIndex, 'alias_auto', 'no');
    } else if (String(before.last_4 || '') !== last4 && String(before.alias_show_last4) === 'yes') {
      var bank = getAllRows('Banks').find(function (b) { return String(b.id) === bankId; });
      var taken = {};
      getAllRows('Payment Methods').forEach(function (p) { if (String(p.id) !== id) taken[String(p.nickname).trim().toLowerCase()] = true; });
      nickname = uniqueAccountName_(autoAccountAlias_(bankShortName_(bank ? bank.name : ''), String(before.alias_kind), last4, !!last4, currentLang_()), last4, taken);
    }
  }
  // The account's currency (More → Accounts, 2026-11-04): a savings / salary account names one; a card is soles and dollars ('') or one
  // currency only. Stored in alias_kind, which the welcome already uses; an automatic name follows the new currency.
  var kind = accountCurrencyKind_(payload, type, before);
  if (kind && kind !== String(before.alias_kind || '')) {
    ensurePaymentMethodAliasColumns_();
    headers = getHeaders(sheet);
    if (String(before.alias_auto) === 'yes' && String(before.nickname) === nickname && String(before.bank_id || '') === bankId) {
      var bankK = getAllRows('Banks').find(function (b) { return String(b.id) === bankId; });
      var takenK = {};
      getAllRows('Payment Methods').forEach(function (p) { if (String(p.id) !== id) takenK[String(p.nickname).trim().toLowerCase()] = true; });
      nickname = uniqueAccountName_(autoAccountAlias_(bankShortName_(bankK ? bankK.name : ''), kind, last4, String(before.alias_show_last4) === 'yes', currentLang_()), last4, takenK);
    }
    setCellByRow_(sheet, headers, rowIndex, 'alias_kind', kind);
  }
  // An older phone that sends one `currency` replaces the list too.
  var currencies = hasList ? listValue : (kind ? '' : String(before.currencies || ''));
  if (headers.indexOf('currencies') !== -1 && currencies !== String(before.currencies || '')) setCellByRow_(sheet, headers, rowIndex, 'currencies', currencies);
  setCellByRow_(sheet, headers, rowIndex, 'nickname', nickname);
  setCellByRow_(sheet, headers, rowIndex, 'type', type);
  setCellByRow_(sheet, headers, rowIndex, 'bank_id', bankId);
  setPaymentMethodLast4_(sheet, headers, rowIndex, last4);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  return { id: id, nickname: nickname, type: type, bank_id: bankId, last_4: last4, alias_kind: kind || String(before.alias_kind || ''), currencies: currencies };
}

// The alias_kind a save asks for, or '' when it says nothing about the currency (an older phone) or the type has none (cash, wallet,
// platform). A salary account stays a salary account.
function accountCurrencyKind_(payload, type, before) {
  if (!payload || payload.currency === undefined || payload.currency === null) return '';
  if (type !== 'debit' && type !== 'credit') return '';
  var base = type === 'credit' ? 'credit' : (/^sueldo/.test(String((before && before.alias_kind) || '')) ? 'sueldo' : 'debit');
  return accountKindFor_(base, payload.currency);
}

// How many records point at an account. Entries (either end), loans, settlements and the
// statement bookkeeping sheets all hold its id; a sheet that doesn't exist yet counts as 0.
function paymentMethodUsage_(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  [['Entries', ['payment_method_id', 'to_payment_method_id']], ['Loans', ['payment_method_id']],
   ['Settlements', ['payment_method_id']], ['Statement Uploads', ['payment_method_id']],
   ['Statement Gaps', ['payment_method_id']]].forEach(function (spec) {
    if (!ss.getSheetByName(spec[0])) return;
    getAllRows(spec[0]).forEach(function (r) {
      if (spec[1].some(function (f) { return String(r[f] || '') === id; })) n++;
    });
  });
  return n;
}

// Delete an account, only when nothing uses it (an unused one holds no history, so nothing
// breaks). Its starting-balance rows go with it. One in use is refused with a count: the
// owner hides it instead (setPaymentMethodHidden). Principle: past entries never lose their account.
function deletePaymentMethod(payload) {
  var id = String((payload && payload.id) || '');
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var rowIndex = id ? findRowIndexById(sheet, headers, id) : -1;
  if (rowIndex === -1) throw new Error(tr_('err.pmNotFound'));
  if (isBasicCashAccount_(id)) throw new Error(tr_('err.pmCashBasic'));
  var used = paymentMethodUsage_(id);
  if (used > 0) throw new Error(tr_('err.pmInUse', { n: used }));
  var settings = getSettingsMap();
  if (accountHasRailLink_(id, settings)) throw new Error(tr_('err.pmRailLinked'));
  deleteRowsWhere_('Account Opening Balances', function (row) { return String(row.payment_method_id) === id; });
  deleteSheetRows_(sheet, rowIndex, 1);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  bumpStructureVersion_();
  return { id: id, deleted: true };
}

// The account window's one Delete (owner, 2026-11-02 — the same rule as deleting a friend): an account nothing uses is deleted
// (with its starting balances); one with history (entries, loans, repayments, statements) is HIDDEN instead, so its past records
// keep their account. One linked to Yape / Plin is still refused (hiding it would leave the wallet pointing at a hidden account);
// the built-in Cash is refused. Answers { deleted: true } or { hidden: 'yes', used: n }.
function removePaymentMethod(payload) {
  var id = String((payload && payload.id) || '');
  if (isBasicCashAccount_(id)) throw new Error(tr_('err.pmCashBasic'));
  if (!getAllRows('Payment Methods').some(function (p) { return String(p.id) === id; })) throw new Error(tr_('err.pmNotFound'));
  var settings = getSettingsMap();
  if (accountHasRailLink_(id, settings)) throw new Error(tr_('err.pmRailLinked'));
  var used = paymentMethodUsage_(id);
  if (used > 0) {
    setPaymentMethodHidden({ id: id, hidden: true });
    return { id: id, hidden: 'yes', used: used };
  }
  return deletePaymentMethod({ id: id });
}

// How many records point at each of several accounts, in ONE pass over the sheets (paymentMethodUsage_ asks about one). A record counts once per account.
function paymentMethodUsageMap_(ids) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var want = {}, usage = {};
  ids.forEach(function (id) { want[String(id)] = true; usage[String(id)] = 0; });
  [['Entries', ['payment_method_id', 'to_payment_method_id']], ['Loans', ['payment_method_id']],
   ['Settlements', ['payment_method_id']], ['Statement Uploads', ['payment_method_id']],
   ['Statement Gaps', ['payment_method_id']]].forEach(function (spec) {
    if (!ss.getSheetByName(spec[0])) return;
    getAllRows(spec[0]).forEach(function (r) {
      var counted = {};
      spec[1].forEach(function (f) {
        var v = String(r[f] || '');
        if (want[v] && !counted[v]) { counted[v] = true; usage[v]++; }
      });
    });
  });
  return usage;
}

// Several accounts at once (More → Accounts → Edit, owner's request 2026-11-03): the SAME rule as removePaymentMethod for each one, decided in one pass and
// never throwing for a single account: unused → deleted (with its starting balances); with history → hidden (its past records keep it; the Balances card
// is not affected by Hide); the built-in Cash, one linked to Yape / Plin, one that no longer exists, or one that is already hidden → left as it is.
// Answers { deleted: [{id,name}], hidden: [{id,name,used}], kept: [{id,name,reason: cash|rail|missing|hiddenAlready}] }.
function removePaymentMethods(payload) {
  var ids = [], seen = {};
  ((payload && payload.ids) || []).forEach(function (id) { id = String(id || ''); if (id && !seen[id]) { seen[id] = true; ids.push(id); } });
  var out = { deleted: [], hidden: [], kept: [] };
  if (!ids.length) return out;
  var byId = {};
  getAllRows('Payment Methods').forEach(function (p) { byId[String(p.id)] = p; });
  var settings = getSettingsMap();
  var linked = {};
  RAIL_LINK_KEYS_.forEach(function (k) { if (settings[k]) linked[String(settings[k])] = true; });
  plinMoreIds_(settings).forEach(function (id) { linked[id] = true; });
  var usage = paymentMethodUsageMap_(ids);
  var gone = {}, toHide = [];
  ids.forEach(function (id) {
    var pm = byId[id];
    if (!pm) { out.kept.push({ id: id, name: '', reason: 'missing' }); return; }
    var name = String(pm.nickname || '');
    if (isBasicCashAccount_(id)) { out.kept.push({ id: id, name: name, reason: 'cash' }); return; }
    if (linked[id]) { out.kept.push({ id: id, name: name, reason: 'rail' }); return; }
    if (usage[id] > 0) {
      if (String(pm.hidden || '') === 'yes') { out.kept.push({ id: id, name: name, reason: 'hiddenAlready' }); return; }
      toHide.push(id);
      out.hidden.push({ id: id, name: name, used: usage[id] });
      return;
    }
    gone[id] = true;
    out.deleted.push({ id: id, name: name });
  });
  out.deletedRows = { accounts: [], balances: [] };   // kept for Undo (restorePaymentMethods)
  if (out.deleted.length) {
    out.deletedRows.accounts = Object.keys(gone).map(function (id) { return byId[id]; });
    out.deletedRows.balances = getAllRows('Account Opening Balances').filter(function (row) { return gone[String(row.payment_method_id)] === true; });
    deleteRowsWhere_('Account Opening Balances', function (row) { return gone[String(row.payment_method_id)] === true; });
    deleteRowsWhere_('Payment Methods', function (row) { return gone[String(row.id)] === true; });
    bumpStructureVersion_();
  }
  toHide.forEach(function (id) { setPaymentMethodHidden({ id: id, hidden: true }); });
  return out;
}

// Undo of a bulk delete AND the bulk "Show again" (More → Accounts → Edit): shows the given hidden accounts again and puts back the accounts that were
// deleted (an account is only deleted when nothing uses it, so the row and its starting balances are the whole account). One pass, never throws for one
// account: an id that no longer exists is skipped; a deleted account whose id or nickname is back already is skipped, never duplicated.
// Answers { shown: n, restored: n, skipped: [names] }.
function restorePaymentMethods(payload) {
  payload = payload || {};
  var methods = getAllRows('Payment Methods');
  var byId = {}, names = {};
  methods.forEach(function (p) { byId[String(p.id)] = p; names[String(p.nickname).trim().toLowerCase()] = true; });
  var out = { shown: 0, restored: 0, skipped: [] };
  uniqueIds_(payload.show).forEach(function (id) {
    if (!byId[id]) return;
    setPaymentMethodHidden({ id: id, hidden: false });
    out.shown++;
  });
  var rows = payload.rows || {}, add = [], addedIds = {};
  (rows.accounts || []).forEach(function (r) {
    var id = String((r && r.id) || ''), name = String((r && r.nickname) || '').trim();
    if (!id || !name) return;
    if (byId[id] || names[name.toLowerCase()]) { out.skipped.push(name); return; }
    byId[id] = true; names[name.toLowerCase()] = true; addedIds[id] = true;
    var copy = {};
    Object.keys(r).forEach(function (k) { copy[k] = r[k]; });
    copy.hidden = '';
    add.push(copy);
  });
  if (add.length) {
    appendObjectsBatch_('Payment Methods', add);
    var bal = (rows.balances || []).filter(function (b) { return b && addedIds[String(b.payment_method_id)]; });
    appendObjectsBatch_('Account Opening Balances', bal);
    out.restored = add.length;
  }
  return out;
}

// Hide / show an account. A hidden account keeps its row (past records still show its name
// and balances stay correct) but the phone leaves it out of every "pick an account" list.
function setPaymentMethodHidden(payload) {
  var id = String((payload && payload.id) || '');
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  if (headers.indexOf('hidden') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('hidden');
    headers.push('hidden');
    if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  }
  var rowIndex = id ? findRowIndexById(sheet, headers, id) : -1;
  if (rowIndex === -1) throw new Error(tr_('err.pmNotFound'));
  var hidden = payload.hidden === true || payload.hidden === 'yes' ? 'yes' : '';
  if (hidden && isBasicCashAccount_(id)) throw new Error(tr_('err.pmCashBasic'));
  setCellByRow_(sheet, headers, rowIndex, 'hidden', hidden);
  bumpStructureVersion_();
  return { id: id, hidden: hidden };
}

// A bank name typed in the add/edit window. Same name (any case) = same bank.
function addBank(payload) {
  var name = String(payload.name || '').trim();
  if (!name) throw new Error(tr_('err.enterName'));
  var existing = getAllRows('Banks').find(function (b) {
    return String(b.name).trim().toLowerCase() === name.toLowerCase();
  });
  if (existing) return existing;
  var bank = { id: Utilities.getUuid(), name: name };
  appendRowObject('Banks', bank);
  bumpStructureVersion_();
  return bank;
}

// One-time cleanup for payment methods that got duplicated before
// addPaymentMethod became idempotent by nickname (see above). Groups by
// nickname, keeps whichever row is actually used by the most Entries (or
// the first one if none are used), reassigns every Entry pointing at a
// duplicate to the surviving id, then deletes the duplicate rows.
function mergeDuplicatePaymentMethods() {
  var pmSheet = getSheet('Payment Methods');
  var pmHeaders = getHeaders(pmSheet);
  var pmRows = getAllRows('Payment Methods');

  var usageCounts = {};
  var entrySheet = getSheet('Entries');
  var entryHeaders = getHeaders(entrySheet);
  var pmIdCol = entryHeaders.indexOf('payment_method_id');
  var lastRow = entrySheet.getLastRow();
  var entryValues = lastRow > 1 ? entrySheet.getRange(2, 1, lastRow - 1, entryHeaders.length).getValues() : [];
  entryValues.forEach(function (row) {
    var pmId = row[pmIdCol];
    if (pmId) usageCounts[pmId] = (usageCounts[pmId] || 0) + 1;
  });

  var groups = {};
  pmRows.forEach(function (pm) {
    var key = String(pm.nickname).trim().toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(pm);
  });

  var idRemap = {};
  var idsToDelete = {};
  var mergedGroups = [];

  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    if (group.length < 2) return;

    group.sort(function (a, b) { return (usageCounts[b.id] || 0) - (usageCounts[a.id] || 0); });
    var survivor = group[0];
    var duplicates = group.slice(1);
    duplicates.forEach(function (dup) {
      idRemap[dup.id] = survivor.id;
      idsToDelete[dup.id] = true;
    });
    mergedGroups.push({
      nickname: survivor.nickname,
      survivorId: survivor.id,
      removedIds: duplicates.map(function (d) { return d.id; }),
      reassignedEntries: duplicates.reduce(function (sum, d) { return sum + (usageCounts[d.id] || 0); }, 0)
    });
  });

  if (!mergedGroups.length) return { merged: [], entriesReassigned: 0, rowsDeleted: 0 };

  // Reassign affected Entries in one bulk write.
  var entriesReassigned = 0;
  entryValues.forEach(function (row, i) {
    var pmId = row[pmIdCol];
    if (pmId && idRemap[pmId]) {
      entryValues[i][pmIdCol] = idRemap[pmId];
      entriesReassigned++;
    }
  });
  if (entriesReassigned > 0) {
    entrySheet.getRange(2, 1, entryValues.length, entryHeaders.length).setValues(sheetSafeRows_(entryValues));
  }

  // Delete duplicate Payment Methods rows, bottom-up so row indices stay valid.
  var idCol = pmHeaders.indexOf('id');
  var pmLastRow = pmSheet.getLastRow();
  var rowsDeleted = 0;
  for (var r = pmLastRow; r >= 2; r--) {
    var rowId = pmSheet.getRange(r, idCol + 1).getValue();
    if (idsToDelete[rowId]) {
      deleteSheetRows_(pmSheet, r, 1);
      bumpStructureVersion_();
      rowsDeleted++;
    }
  }

  return { merged: mergedGroups, entriesReassigned: entriesReassigned, rowsDeleted: rowsDeleted };
}
