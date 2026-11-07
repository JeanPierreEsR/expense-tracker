/**
 * Optional abilities and this copy's own web address (friends & family rollout, stage 1).
 *
 * A friend's copy of the app starts with the basic ability only (read and write
 * its own spreadsheet). "Keep it awake" and "read my bank e-mails" are
 * separate Google approvals the person may or may not give, so the code must
 * work, and say so plainly, when they are missing. The installer writes the
 * Script Property FEATURES ("keepawake,gmail" — whichever were approved).
 *
 *   FEATURES missing  -> everything is on. That is the owner's copy and any old
 *                        install, so nothing changes for them.
 *   FEATURES present  -> only the listed abilities are on ('base' is always on).
 *
 * WEB_APP_URL is this copy's own address (used by the keep-awake ping and as the
 * Telegram webhook fallback). It used to be written into the code, which is
 * wrong for every copy except the owner's. The app tells the backend which
 * address it is using on each signed-in request, and the first one is kept.
 */

function featureOn_(name) {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURES');
  if (raw === null || raw === undefined || String(raw).trim() === '') return true;
  if (name === 'base') return true;
  return String(raw).split(',').map(function (s) { return s.trim(); }).indexOf(name) !== -1;
}

// For things the person asked for directly (they get a plain sentence, in their language).
function requireFeature_(name, stringKey) {
  if (featureOn_(name)) return;
  var err = new Error(tr_(stringKey));
  err.code = 'feature_off';
  throw err;
}

// True for a copy made by the installer (FEATURES present). The owner's own copy and every old install have no
// FEATURES, so they are never treated as a new person's app (no welcome questions, no sample friends removed).
function isFriendCopy_() {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURES');
  return !(raw === null || raw === undefined || String(raw).trim() === '');
}

function getWebAppUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '');
}

// Only a real Apps Script web-app address is accepted, and only once (the first signed-in request wins).
function healWebAppUrl_(url) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('WEB_APP_URL')) return;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(url || ''))) return;
  props.setProperty('WEB_APP_URL', String(url));
}

// What this copy can do, for the app to show or hide things.
// The backend version this copy was installed with: the installer writes INSTALL_BACKEND_REF (docs/setup/Install.gs) = the last
// commit that changed backend/ at install/update time. '' on the owner's own copy, which has no installer file. The app compares it with
// the newest one to offer "Update available" (More → Update).
function installedBackendRef_() {
  var ref = typeof INSTALL_BACKEND_REF === 'undefined' ? '' : String(INSTALL_BACKEND_REF || '');
  return ref.indexOf('__') === 0 ? '' : ref;
}

function getCapabilities_() {
  return {
    backendRef: installedBackendRef_(),
    // Dates are read in the Sheet's own time zone (2026-10-25). A server without this reads a Sheet in another zone a day early, and the app then
    // warns the person at once (REQUIRED_BACKEND_CAPS_ in app.js).
    sheetDates: true,
    emailExport: !!PropertiesService.getScriptProperties().getProperty('EXPORT_EMAIL'),
    bankEmails: featureOn_('gmail'),
    keepAwake: featureOn_('keepawake'),
    telegram: !!getTelegramToken_(),
    // A chat is actually linked (the token alone sends nothing): the app mentions Telegram in alert hints only then.
    telegramLinked: telegramLinked_(),
    // setExtraOn: More → Feedback & privacy → Extra features turns an extra back on in the app; an older backend sends the person to the setup page
    extrasOn: true,
    // This backend keeps in-app alerts (Notices.gs); an older one lacks it and the app then never asks for them.
    notices: true,
    // This backend checks alerts when asked (checkAlertsNow), so a copy without a timer still gets them; an older one lacks it.
    alertCheck: true,
    // More → Performance log is a diagnostic for the owner only; a copy made by the installer never shows it.
    perfLog: !isFriendCopy_(),
    // createEntry accepts the phone's own id (client_id) and answers a repeat with the same entry, so the app can save a NEW entry in the background.
    clientEntryId: true,
    // addLoan, recordCurrencyExchange, forgiveLoan and the overpayment entries accept the phone's own id (client_id) and answer a repeat with what they already made, so the app can save them in the background; an older backend lacks it and the app then waits for the answer as before.
    clientMoneyId: true,
    // This backend can say which bank addresses it reads (listSupportedSenders), so the app can tell a friend "your bank is ready".
    bankReady: true,
    // This backend takes a rule pack from the phone (setRulePack, RulePack.gs); an older one lacks it and the app then never sends one.
    rulePack: true,
    practiceProgrammed: true,   // removePracticeProgrammed: the Programmed items practice is only offered where this exists
    practiceBudgets: true,   // removePracticeBudgets + the alert check skips the practice's budget: the Budgets practice is only offered where this exists
    practiceLoansMore: true,   // removePracticeLoans + the overdue check skips the practice's loans: the standalone-loan and bank-loan practices are only offered where this exists
    practiceInvestments: true,   // removePracticeInvestments: the Investments practice is only offered where this exists
    practiceAccounts: true,   // removePracticeAccounts + the automatic matchers (e-mail, statements, Telegram, Yape/Plin) skip the practice's account: the Accounts practice is only offered where this exists
    practiceTripsFind: true,   // createPracticeTripExpenses + removePracticeTrips finds them by marker: the Trips practice teaches "Find expenses in these dates"; an older backend gets no Trips practice offered
    practiceTrips: true,   // removePracticeTrips + suggestions/alerts skip the practice trip: the Trips & events practice is only offered where this exists
    practiceExchange: true,   // removePracticeExchange + the exchange-house / pairing / last-account memories skip the practice's legs: the Currency exchange practice is only offered where this exists
    pmRemove: true,   // removePaymentMethod (one Delete: unused = deleted, with history = hidden) + the built-in Cash account (settings.cash_account_id); an older backend keeps Delete + Hide
    thenReads: true,   // a save may carry payload._then (reads to answer in the same reply, runThenReads_ in Api.gs); an older backend never gets it
    entryRepeat: true,
    recurringPayments: true,   // listRecurringPayments: the "Past payments" group of the Programmed item window    // saveEntryAll takes `repeat`: the entry form's "Repeat…" makes a Programmed item from the entry and links it
    entrySaveOne: true,   // saveEntryAll: a new / edited / confirmed entry with its split, tags and bill in ONE call (was 2-4 trips to Google); an older backend gets the separate calls
    practiceRemove: true,   // removePracticeData: the first-use practice's cleanup in one call; an older backend makes the phone do it step by step
    practiceTidy: true,   // createPracticeTidy + removePracticeTidy + listTidyGroups({pinPractice}): the Tidy my history practice is only offered where this exists
    practiceBank: true,   // createPracticeBankAccount + removePracticeBank: the Bank statements practice is only offered where this exists
    practiceImport: true,   // removePracticeImport: the Import from another app practice is only offered where this exists
    practiceDeleted: true,   // createPracticeDeleted + removePracticeDeleted: the Recently deleted practice is only offered where this exists (and where entriesRestore + entriesBulk do)
    practiceReview: true,  // createPracticePending + removePracticeReview + the practice entries are ignored by learning / follow / guesses: the Needs review practice is only offered where this exists
    openingLoan: true,   // addLoan understands `opening` (a debt from before the app: no money entry); an older backend would save a normal loan, so the app hides the switch
    friendsEdit: true,   // listMyFriends + updateFriend / deleteFriend for plain friends in any copy (More → Friends); an older backend lacks it, so the app hides the card
    friendPhone: true,   // setFriendPhone (the loan screen's "Remind on WhatsApp" remembers the number); an older backend lacks it, so the app does not offer to remember it
    friendPhoneEdit: true,   // addFriend / updateFriend take `phone` and listMyFriends returns it (More → Friends shows and edits the number); an older backend ignores it, so the app hides the field
    friendsBulkDelete: true,   // deleteFriends (several at once, More → Friends → Edit); an older backend lacks it, so the app hides the Edit button
    programmedStop: true,   // stopRecurringAtLastPayment / deleteRecurringExpenses / previewProgrammedDelete / convertPausedProgrammedForOwnerOnce + `paid` on one-time items (Programmed items: Stop or Delete); an older backend lacks them, so the app keeps its plain Delete
    paceCategories: true,   // getMonthlyHistory({categoryIds}): the Spending pace screen's 'Which expenses' (an older backend would ignore it and draw all expenses)
    budgetsBulkDelete: true,   // deleteBudgets (several at once, Budgets → Edit); an older backend lacks it, so the app hides the Edit button
    bulkShowAgain: true,   // restoreFriends / restorePaymentMethods / showCategories + `deletedRows` in deleteFriends / removePaymentMethods (Undo after a bulk delete or hide, and a bulk "Show again" in Edit mode); an older backend lacks them, so the app shows no Undo and no Show again button
    pmBulkRemove: true,   // removePaymentMethods (several accounts at once, More → Accounts → Edit); an older backend lacks it, so the app hides the Edit button
    tripsBulkDelete: true,   // deleteTrips (several trips / events at once, More → Trips & events → Edit); an older backend lacks it, so the app hides the Edit button
    categoriesBulkDelete: true,   // previewCategoryDelete + deleteCategories (several categories at once: move into one, or hide; More → Categories → Edit); an older backend lacks them, so the app hides the Edit button
    businessBulkDelete: true,   // deleteBusinessItems + deleteBusinessPeople (several companies / projects / people at once, Edit on the Business screens); an older backend lacks them, so the app hides the Edit buttons
    reviewBulk: true,   // confirmEntries + discardEntries (several waiting entries at once, Home → Needs review → Edit); an older backend lacks them, so the app hides the Edit button
    entriesBulk: true,   // previewEntriesDelete + deleteEntries (several Home entries at once, Home / search → Edit); an older backend lacks them, so the app hides the Edit buttons
    entriesRestore: true,   // a bulk delete keeps a 30-day safety copy: listDeletedEntries / restoreDeletedEntries / forgetDeletedEntries (Undo + More → Recently deleted); an older backend lacks them, so the app shows no Undo and no card
    entriesBulkLink: true,   // setEntriesTrip / setEntriesTag + their undo (link several Home entries to a trip or event, add / remove a tag); an older backend lacks them, so the app hides those two choices
    entriesBulkCategory: true,   // setEntriesCategory + undoSetEntriesCategory (change the category of several Home entries at once); an older backend lacks them, so the app hides the Category button
    ownName: true,   // answerOwnName + `ownNameAsk` in getMeta: the Home "Is this you?" card and the welcome name line; an older backend lacks them
    gapReasons: true,   // saveGapReason + `reasons` in getManualGaps: More → Bank emails → By transaction asks why no email came; an older backend lacks them, so the question is not shown
    accountCurrencyEdit: true,   // savePaymentMethod takes `currency` (More → Accounts); a card may be in one currency only ('credit_usd'); 2026-11-04
    accountCurrencyList: true,   // savePaymentMethod and saveOnboardingAccounts take `currencies`, a list: an account can have several (2026-11-06)
    plinMany: true,   // Plin on several accounts (saveRailLinks plin_pen_more)
    chargeFill: true,   // an entry's charge and what was paid (Charges.gs): the form's box, Home's card
    accountCurrencySuggest: true,   // getAccountCurrencySuggestions + apply: older accounts, shown in More → Accounts on the owner's copy (2026-11-06)
    accountCurrencies: true,   // saveOnboardingAccounts takes any currency for a debit / salary account ('debit_eur', 'sueldo_usd'); an older backend gets only soles / dollars offered in the welcome
    profileState: true,   // getProfileState (which saved picks still have their category) + applyProfile brings a hidden / deleted pick's category back: More → My profile → What fits me; an older backend shows the saved picks as they are
    dateOrder: true,   // saveDateOrder: More → My profile → How I type dates (Settings `date_format`); an older backend lacks it, so the app hides that card
    profile: true,   // applyProfile: "What fits you?" category packs (Profile.gs); an older backend lacks it, so the app never asks
    // Business pack (Business.gs): off until the person chooses it; the app shows nothing business while false.
    business: businessOn_(),
    // Whether this copy may see the pack at all (the welcome question and the More row). False on a new person's copy until the owner opens it.
    businessOffered: businessOffered_(),
    // The app shows its welcome questions once, on a copy the installer made, until they are answered (Onboarding.gs).
    onboarding: isFriendCopy_() && String(getSettingsMap().onboarded || '') !== 'yes'
  };
}

// ---- Turning extras off again (More → Extra features; friends' copies only) ----
// The two optional extras can be switched off without deleting anything: the app stops using the ability at once
// (FEATURES loses it; the keep-awake timer is removed; the e-mail steps already check featureOn_). The name is also kept in
// FEATURES_OFF so a later "Update my app" (installApplyCode_ in docs/setup/Install.gs, which rewrites FEATURES from what the
// installer was built with) does not silently turn it back on. Turning one ON again: setExtraOn below while Google's permission is still
// there; otherwise the setup page (only Google can ask for an approval), whose approval visit clears the name from FEATURES_OFF.
var OPT_OUT_EXTRAS_ = ['keepawake', 'gmail'];

function csvList_(raw) {
  return String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function requireFriendCopy_() {
  if (isFriendCopy_()) return;
  var denied = new Error(tr_('erase.ownerCopy'));
  denied.code = 'not_allowed';
  throw denied;
}

function setExtraOff(payload) {
  requireFriendCopy_();
  var name = String((payload && payload.name) || '');
  if (OPT_OUT_EXTRAS_.indexOf(name) === -1) {
    var bad = new Error(tr_('extras.unknown'));
    bad.code = 'bad_request';
    throw bad;
  }
  var props = PropertiesService.getScriptProperties();
  var on = csvList_(props.getProperty('FEATURES')).filter(function (f) { return f !== name && f !== 'base'; });
  props.setProperty('FEATURES', ['base'].concat(on).join(','));
  var off = csvList_(props.getProperty('FEATURES_OFF'));
  if (off.indexOf(name) === -1) off.push(name);
  props.setProperty('FEATURES_OFF', off.join(','));
  if (name === 'keepawake') removeKeepWarmPingTriggers_();
  return { capabilities: getCapabilities_() };
}

// Turning an extra ON again from the app (2026-11-04). Switching one off never removes Google's permission, so most of the time it can
// simply come back: first a harmless call proves Google still allows it (Gmail: the mailbox profile, no e-mail content; keep-awake: one
// outside request), then FEATURES gets the name, FEATURES_OFF loses it and the timer is (re)created. If Google says no (never approved at
// setup, or "Take back all permissions" was used), nothing changes and the answer says `needsApproval`: only Google's own page can ask,
// so the app then sends the person to the setup page as before.
function extraAllowedByGoogle_(name) {
  try {
    if (name === 'gmail') Gmail.Users.getProfile('me');
    else UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
    return true;
  } catch (err) {
    Logger.log('extra ' + name + ' not allowed: ' + err);
    return false;
  }
}

function setExtraOn(payload) {
  requireFriendCopy_();
  var name = String((payload && payload.name) || '');
  if (OPT_OUT_EXTRAS_.indexOf(name) === -1) {
    var bad = new Error(tr_('extras.unknown'));
    bad.code = 'bad_request';
    throw bad;
  }
  if (!extraAllowedByGoogle_(name)) return { needsApproval: true, capabilities: getCapabilities_() };
  try {
    if (name === 'keepawake') {
      removeKeepWarmPingTriggers_();
      ScriptApp.newTrigger('pingWebApp_').timeBased().everyMinutes(5).create();
    } else if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runAutomation'; })) {
      ScriptApp.newTrigger('runAutomation').timeBased().everyMinutes(15).create();
    }
  } catch (err) {
    Logger.log('extra ' + name + ' timer: ' + err);
    return { needsApproval: true, capabilities: getCapabilities_() };
  }
  var props = PropertiesService.getScriptProperties();
  var on = csvList_(props.getProperty('FEATURES')).filter(function (f) { return f !== name && f !== 'base'; });
  props.setProperty('FEATURES', ['base'].concat(on, [name]).join(','));
  props.setProperty('FEATURES_OFF', csvList_(props.getProperty('FEATURES_OFF')).filter(function (f) { return f !== name; }).join(','));
  return { capabilities: getCapabilities_() };
}

// "Take back all permissions, keep my data": every extra off, every timer stopped, and the app's own Google permission
// withdrawn (ScriptApp.invalidateAuth). The Sheet, the entries and the sign-ins stay; the app works again once the person
// approves it on the setup page.
function takeBackPermissions(payload) {
  requireFriendCopy_();
  if (!payload || payload.confirm !== true) {
    var unconfirmed = new Error(tr_('extras.notConfirmed'));
    unconfirmed.code = 'not_confirmed';
    throw unconfirmed;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('FEATURES', 'base');
  props.setProperty('FEATURES_OFF', OPT_OUT_EXTRAS_.join(','));
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var revoked = false;
  try { ScriptApp.invalidateAuth(); revoked = true; } catch (err) { Logger.log('invalidateAuth failed: ' + err); }
  return { permissionRevoked: revoked };
}
