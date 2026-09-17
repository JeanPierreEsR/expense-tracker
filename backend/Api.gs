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

function doPost(e) {
  var response;
  try {
    var body = JSON.parse(e.postData.contents);

    if (body && body.update_id !== undefined) {
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

    if (!isValidAccessCode(body.accessCode)) {
      response = { ok: false, error: 'Invalid access code' };
    } else {
      response = { ok: true, data: routeAction(body.action, body.payload || {}) };
    }
  } catch (err) {
    response = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeAction(action, payload) {
  switch (action) {
    case 'getMeta': return getMeta();
    case 'createEntry': return createEntry(payload);
    case 'listEntries': return listEntries(payload);
    case 'getPeriodSummary': return getPeriodSummary(payload);
    case 'getExchangeRate': return getExchangeRate(payload.currency, payload.month);
    case 'getLatestRateOnOrBefore': return { rate: getLatestRateOnOrBefore_(payload.currency, payload.month) };
    case 'listExchangeRates': return listExchangeRates();
    case 'setExchangeRate': return setExchangeRate(payload.currency, payload.month, payload.rate);
    case 'addFriend': return addFriend(payload);
    case 'listPayors': return listPayors();
    case 'addPayor': return addPayor(payload);
    case 'admin_deletePayor':
      var payorSheet = getSheet('Payors');
      var payorHeaders = getHeaders(payorSheet);
      var payorRowIndex = findRowIndexById(payorSheet, payorHeaders, payload.id);
      if (payorRowIndex !== -1) payorSheet.deleteRow(payorRowIndex);
      return { done: true };
    case 'admin_setCategoryPeriodType': return adminSetCategoryPeriodType(payload.categoryId, payload.periodType);
    case 'admin_linkEntryToRecurring': return adminLinkEntryToRecurring(payload.entryId, payload.recurringExpenseId);
    case 'findRecurringLinkCandidates': return findRecurringLinkCandidates(payload);
    case 'linkEntriesToRecurring': return linkEntriesToRecurring(payload);
    case 'addTag': return addTag(payload);
    case 'addPaymentMethod': return addPaymentMethod(payload);
    case 'admin_resetBanks': resetBanks(); return { done: true };
    case 'admin_linkPaymentMethodsToBanks': linkPaymentMethodsToBanks(); return { done: true };
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
        lastWebhookUpdateId: PropertiesService.getScriptProperties().getProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID') || null
      };
    case 'admin_resetTelegramWebhookDedup':
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID');
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
    case 'admin_setupSpreadsheet': setupSpreadsheet(); return { done: true };
    case 'admin_addCreatedAtColumnToEntries': return addCreatedAtColumnToEntries();
    case 'admin_addCurrencyColumnToBudgets': return addCurrencyColumnToBudgets();
    case 'admin_addNameColumnToBudgets': return addNameColumnToBudgets();
    case 'admin_checkBudgetsNow': return checkBudgets();
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
    case 'admin_debugUnlabel': return debugUnlabel_(payload.query);
    case 'admin_seedCategoryKeywords': seedCategoryKeywords(); return { done: true };
    case 'admin_bulkImportSpendeeCsv': return bulkImportSpendeeCsv(payload.csvText, payload.filename);
    case 'admin_mergeDuplicatePaymentMethods': return mergeDuplicatePaymentMethods();
    case 'addCategoryKeyword':
      var kw = { id: Utilities.getUuid(), keyword: payload.keyword, category_name: payload.category_name };
      appendRowObject('Category Keywords', kw);
      return kw;
    case 'listBudgets': return listBudgets(payload);
    case 'addBudget': return addBudget(payload);
    case 'updateBudget': return updateBudget(payload);
    case 'deleteBudget': return deleteBudget(payload.id);
    case 'getBudgetChartSeries': return getBudgetChartSeries(payload);
    case 'listRecurringExpenses': return listRecurringExpenses();
    case 'addRecurringExpense': return addRecurringExpense(payload);
    case 'updateRecurringExpense': return updateRecurringExpense(payload);
    case 'deleteRecurringExpense': return deleteRecurringExpense(payload.id);
    case 'listExpectedRecurringItems': return listExpectedRecurringItems();
    case 'getProjections': return getProjections(payload);
    case 'listCategoryProjections': return listCategoryProjections(payload);
    case 'getCategoryProjectionDetail': return getCategoryProjectionDetail(payload);
    case 'setProjectionOverride': return setProjectionOverride(payload);
    case 'deleteProjectionOverride': return deleteProjectionOverride(payload);
    case 'admin_resetProjectionOverridesSheet': return adminResetProjectionOverridesSheet();
    case 'admin_debugProjectionOverrides': return adminDebugProjectionOverrides();
    case 'listPendingEntries': return listPendingEntries();
    case 'confirmEntry': confirmEntryWithLearning_(payload.id); return { done: true };
    case 'discardEntry': deleteEntry_(payload.id); return { done: true };
    case 'updateEntry': return updateEntryFields(payload.id, payload.fields);
    case 'getEntry': return getEntryById_(payload.id);
    case 'getEntrySplits': return getEntrySplits(payload.entryId);
    case 'saveEntrySplits': return saveEntrySplits(payload.entryId, payload.splits);
    case 'listLoanBalances': return listLoanBalances();
    case 'getFriendLoanDetail': return getFriendLoanDetail(payload.friendId);
    case 'addLoan': return addLoan(payload);
    case 'updateLoan': return updateLoan(payload);
    case 'deleteLoan': deleteLoan(payload.id); return { done: true };
    case 'listSettlementsForLoan': return listSettlementsForLoan(payload.loanId);
    case 'addSettlement': return addSettlement(payload);
    case 'updateSettlement': return updateSettlement(payload);
    case 'deleteSettlement': deleteSettlement(payload.id); return { done: true };
    default: throw new Error('Unknown action: ' + action);
  }
}

// ---- Generic sheet helpers ----

function getSheet(name) {
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
  sent_at: 'yyyy-MM-dd',
  month: 'yyyy-MM',
  period: 'yyyy-MM',
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

function getAllRows(sheetName) {
  var sheet = getSheet(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaders(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var tz = Session.getScriptTimeZone();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) {
      var v = row[i];
      if (v instanceof Date && DATE_FIELD_FORMATS[h]) {
        v = Utilities.formatDate(v, tz, DATE_FIELD_FORMATS[h]);
      } else if (STRING_FIELDS[h] && v !== '' && v != null) {
        v = String(v);
      }
      obj[h] = v;
    });
    return obj;
  });
}

function appendRowObject(sheetName, obj) {
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.appendRow(row);
}

function findRowIndexById(sheet, headers, id) {
  var idCol = headers.indexOf('id');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

// ---- Meta (everything the form's dropdowns need, in one call) ----

function getMeta() {
  return {
    categories: getAllRows('Categories'),
    banks: getAllRows('Banks'),
    paymentMethods: getAllRows('Payment Methods'),
    tags: getAllRows('Tags'),
    friends: getAllRows('Friends'),
    payors: getPayorRows_(),
    settings: getSettingsMap()
  };
}

function getSettingsMap() {
  var map = {};
  getAllRows('Settings').forEach(function (r) { map[r.key] = r.value; });
  return map;
}

// ---- Entries ----

function createEntry(payload) {
  var id = Utilities.getUuid();
  var entry = {
    id: id,
    type: payload.type,
    date: payload.date,
    amount: payload.amount,
    currency: payload.currency || 'PEN',
    category_id: payload.category_id,
    description: payload.description || '',
    payment_method_id: payload.paid_by === 'me' ? (payload.payment_method_id || '') : '',
    paid_by: payload.paid_by || 'me',
    status: 'confirmed',
    source: 'manual',
    external_id: '',
    import_batch_id: '',
    created_at: nowTimestamp_()
  };
  appendRowObject('Entries', entry);

  if (payload.tag_ids && payload.tag_ids.length) {
    var entryTagsSheet = getSheet('Entry Tags');
    payload.tag_ids.forEach(function (tagId) {
      entryTagsSheet.appendRow([id, tagId]);
    });
  }

  return entry;
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
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
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
  if (payload && payload.categoryIds && payload.categoryIds.length) {
    var wantedCategoryIds = {};
    payload.categoryIds.forEach(function (id) { wantedCategoryIds[id] = true; });
    entries = entries.filter(function (e) { return wantedCategoryIds[e.category_id]; });
  }
  if (payload && payload.paymentMethodId) {
    entries = entries.filter(function (e) { return e.payment_method_id === payload.paymentMethodId; });
  }
  if (payload && payload.tagId) {
    var entryIdsWithTag = {};
    getAllRows('Entry Tags').forEach(function (et) {
      if (et.tag_id === payload.tagId) entryIdsWithTag[et.entry_id] = true;
    });
    entries = entries.filter(function (e) { return entryIdsWithTag[e.id]; });
  }

  entries.sort(compareEntriesRecency_);

  // A category/tag/payment-method drill-down is always a small, specific
  // slice — never cap it, even without a date range (e.g. "All-time").
  var hasFilter = payload && (payload.startDate || payload.endDate ||
    payload.categoryId !== undefined || (payload.categoryIds && payload.categoryIds.length) ||
    payload.tagId || payload.paymentMethodId);
  var limit = (payload && payload.limit) || (hasFilter ? null : DEFAULT_ENTRY_LIMIT);
  if (limit) entries = entries.slice(0, limit);

  entries.forEach(function (entry) {
    entry.amount_pen = computeAmountPen(entry.amount, entry.currency, entry.date);
  });
  return entries;
}

function listPendingEntries() {
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'pending'; });
  entries.forEach(function (entry) {
    entry.amount_pen = computeAmountPen(entry.amount, entry.currency, entry.date);
  });
  entries.sort(compareEntriesRecency_);
  return entries;
}

function updateEntryFields(entryId, fields) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) throw new Error('Entry not found');

  Object.keys(fields || {}).forEach(function (key) {
    setCellByRow_(sheet, headers, rowIndex, key, fields[key]);
  });

  return getEntryById_(entryId);
}

function computeAmountPen(amount, currency, dateStr) {
  if (currency === 'PEN') return amount;
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
  return getAllRows('Exchange Rates')
    .map(function (r) { return { id: r.id, currency: r.currency, month: r.month, rate: Number(r.rate) }; })
    .sort(function (a, b) {
      if (a.month !== b.month) return a.month < b.month ? 1 : -1;
      return a.currency < b.currency ? -1 : 1;
    });
}

function getExchangeRate(currency, month) {
  var match = getAllRows('Exchange Rates').filter(function (r) {
    return r.currency === currency && r.month === month;
  });
  return match.length ? match[0] : null;
}

// Every rate on file, grouped by currency and sorted ascending by month —
// the shared shape latestRateFromList_/getLatestRateOnOrBefore_ read, and
// the same shape Budgets.gs's buildBudgetContext_ builds independently
// (rebuilding it there too, since it already has its own Exchange Rates
// read folded into a larger one-time context for performance).
function buildRatesByCurrency_() {
  var map = {};
  getAllRows('Exchange Rates').forEach(function (r) {
    if (!map[r.currency]) map[r.currency] = [];
    map[r.currency].push({ month: r.month, rate: Number(r.rate) });
  });
  Object.keys(map).forEach(function (c) {
    map[c].sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  });
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
  if (currency === 'PEN') return 1;
  return latestRateFromList_(buildRatesByCurrency_()[currency], month);
}

function setExchangeRate(currency, month, rate) {
  var existing = getExchangeRate(currency, month);
  if (existing) {
    var sheet = getSheet('Exchange Rates');
    var headers = getHeaders(sheet);
    var rowIndex = findRowIndexById(sheet, headers, existing.id);
    sheet.getRange(rowIndex, headers.indexOf('rate') + 1).setValue(rate);
    existing.rate = rate;
    return existing;
  }
  var entry = { id: Utilities.getUuid(), month: month, currency: currency, rate: rate };
  appendRowObject('Exchange Rates', entry);
  return entry;
}

// ---- Small "add new" helpers used inline from the form ----

function addFriend(payload) {
  var friend = { id: Utilities.getUuid(), name: payload.name, notes: payload.notes || '' };
  appendRowObject('Friends', friend);
  return friend;
}

function addTag(payload) {
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
    entrySheet.getRange(2, 1, entryValues.length, entryHeaders.length).setValues(entryValues);
  }

  // Delete duplicate Payment Methods rows, bottom-up so row indices stay valid.
  var idCol = pmHeaders.indexOf('id');
  var pmLastRow = pmSheet.getLastRow();
  var rowsDeleted = 0;
  for (var r = pmLastRow; r >= 2; r--) {
    var rowId = pmSheet.getRange(r, idCol + 1).getValue();
    if (idsToDelete[rowId]) {
      pmSheet.deleteRow(r);
      rowsDeleted++;
    }
  }

  return { merged: mergedGroups, entriesReassigned: entriesReassigned, rowsDeleted: rowsDeleted };
}
