/**
 * Web App API. The frontend sends a POST with a JSON body:
 *   { accessCode, action, payload }
 * Using Content-Type: text/plain avoids a CORS preflight, which Apps
 * Script web apps don't handle — this is the standard workaround.
 */

function doPost(e) {
  var response;
  try {
    var body = JSON.parse(e.postData.contents);
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
    case 'getExchangeRate': return getExchangeRate(payload.currency, payload.month);
    case 'setExchangeRate': return setExchangeRate(payload.currency, payload.month, payload.rate);
    case 'addFriend': return addFriend(payload);
    case 'addTag': return addTag(payload);
    case 'addPaymentMethod': return addPaymentMethod(payload);
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

function getAllRows(sheetName) {
  var sheet = getSheet(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaders(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
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
    import_batch_id: ''
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

function listEntries(payload) {
  var entries = getAllRows('Entries');
  if (payload && payload.startDate) {
    entries = entries.filter(function (e) { return e.date >= payload.startDate; });
  }
  if (payload && payload.endDate) {
    entries = entries.filter(function (e) { return e.date <= payload.endDate; });
  }
  entries.forEach(function (entry) {
    entry.amount_pen = computeAmountPen(entry.amount, entry.currency, entry.date);
  });
  entries.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  return entries;
}

function computeAmountPen(amount, currency, dateStr) {
  if (currency === 'PEN') return amount;
  var month = String(dateStr).substring(0, 7);
  var rate = getExchangeRate(currency, month);
  return rate ? amount * rate.rate : null;
}

// ---- Exchange rates ----

function getExchangeRate(currency, month) {
  var match = getAllRows('Exchange Rates').filter(function (r) {
    return r.currency === currency && r.month === month;
  });
  return match.length ? match[0] : null;
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
  var pm = {
    id: Utilities.getUuid(),
    nickname: payload.nickname,
    type: payload.type,
    bank_id: payload.bank_id || '',
    last_4: payload.last_4 || ''
  };
  appendRowObject('Payment Methods', pm);
  return pm;
}
