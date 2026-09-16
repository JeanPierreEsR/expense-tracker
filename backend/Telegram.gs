/**
 * Telegram bot for reviewing automated entries. The bot token and the
 * owner's chat id live only in Script Properties — never in a file, so
 * never in git.
 *
 * Setup: create a bot via @BotFather, run "9. Set Telegram bot token"
 * from the menu, then message your bot "/start <access code>" (the same
 * code the web app uses) to link your account. Only that linked chat is
 * ever listened to.
 *
 * Buttons handle the two fixed actions (Confirm/Discard). Anything else —
 * changing a category, amount, description, etc — is done by replying
 * directly to the transaction message with a short command. This is
 * deliberately NOT free-form AI parsing (the project's $0 budget rules
 * out a paid AI API); it's a small keyword parser. See applyEditCommand_.
 *
 * Delivery: a webhook (see "15. Enable instant Telegram replies" in the
 * menu), not polling — Telegram pushes each update to doPost() in Api.gs
 * the moment it happens, so Confirm/Discard/edit replies apply and get a
 * reply back immediately instead of waiting for the 15-minute automation
 * cycle. pollTelegramUpdates() below is left wired into that cycle as a
 * harmless fallback: Telegram refuses getUpdates while a webhook is set
 * (silently returns ok:false, already handled below), so it only ever
 * does real work if the webhook is ever disabled or drops.
 */

function getTelegramToken_() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
}

function getOwnerTelegramChatId_() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
}

function promptSetTelegramToken() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Set Telegram Bot Token', 'Paste the token @BotFather gave you:', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() === ui.Button.OK) {
    var token = result.getResponseText().trim();
    if (token) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', token);
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_UPDATE_OFFSET');
      ui.alert('Saved. Now message your bot on Telegram: /start <your access code>');
    }
  }
}

// Same URL the app itself calls (docs/app.js's API_URL) — hardcoded rather
// than derived from ScriptApp.getService().getUrl(), which is ambiguous
// when a project has more than one Web App deployment (this one does: a
// @HEAD dev deployment alongside the real one). It's already public, baked
// into the committed frontend, so there's no new exposure in repeating it
// here.
var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec';

// Telegram's webhook delivery needs a direct 200 response and will not
// follow the 302-to-script.googleusercontent.com redirect every Apps
// Script Web App call answers with (confirmed live 2026-09-15 — see
// CLAUDE.md's "Incident — webhook silently dropping edits"). A small
// Cloudflare Worker (cloudflare-worker/telegram-relay.js) sits in front
// to do that redirect hop itself and hand Telegram back a clean response.
// When TELEGRAM_RELAY_URL is set (via promptSetTelegramRelayUrl or
// admin_setTelegramRelayUrl), the webhook points at the relay instead of
// straight at Apps Script; with nothing set, it falls back to the old
// direct URL, which is known not to work reliably for webhook delivery
// but is kept as the default so this never silently points at an empty
// string.
function getTelegramWebhookTargetUrl_() {
  var relayUrl = PropertiesService.getScriptProperties().getProperty('TELEGRAM_RELAY_URL');
  return relayUrl || WEB_APP_URL;
}

function promptSetTelegramRelayUrl() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Set Telegram Relay URL',
    'Paste the Cloudflare Worker URL (e.g. https://telegram-relay.<you>.workers.dev):',
    ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() === ui.Button.OK) {
    var url = result.getResponseText().trim();
    if (url) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_RELAY_URL', url);
      ui.alert('Saved. Re-run "Enable instant Telegram replies" (menu item 15) to point the webhook at it.');
    }
  }
}

function enableTelegramWebhook() {
  var ui = SpreadsheetApp.getUi();
  if (!getTelegramToken_()) {
    ui.alert('Set the Telegram bot token first (menu item 9).');
    return;
  }
  var res = telegramApi_('setWebhook', { url: getTelegramWebhookTargetUrl_() });
  ui.alert(res.ok
    ? 'Done — Confirm/Discard and edit replies now apply and respond instantly.'
    : 'Could not enable it: ' + (res.description || JSON.stringify(res)));
}

function disableTelegramWebhook() {
  var ui = SpreadsheetApp.getUi();
  var res = telegramApi_('deleteWebhook', {});
  ui.alert(res.ok
    ? 'Done — back to checking Telegram every 15 minutes.'
    : 'Could not disable it: ' + (res.description || JSON.stringify(res)));
}

function telegramApi_(method, payload) {
  var token = getTelegramToken_();
  if (!token) throw new Error('Telegram bot token not set');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText());
}

// ---- Outgoing notifications ----

function sendTelegramEntryNotification_(entry, categoryName) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return null;

  var res = telegramApi_('sendMessage', {
    chat_id: chatId,
    text: formatEntryForTelegram_(entry, categoryName),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirm', callback_data: 'confirm:' + entry.id },
        { text: '❌ Discard', callback_data: 'discard:' + entry.id }
      ]]
    }
  });

  if (res.ok && res.result && res.result.message_id) {
    appendRowObject('Telegram Messages', {
      message_id: String(res.result.message_id),
      entry_id: entry.id,
      created_at: new Date().toISOString()
    });
  }
  return res;
}

// Apps Script's V8 runtime supports toLocaleString same as the browser —
// matches the frontend's own moneyFmt() so amounts read the same way in
// Telegram as they do in the app (a bare .toFixed(2) has no thousands
// separator, e.g. "6000.00" instead of "6,000.00").
function moneyFmt_(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatEntryForTelegram_(entry, categoryName) {
  var icon = entry.type === 'expense' ? '💸' : '🔁';
  var lines = [];
  lines.push(icon + ' ' + (entry.description || '(no description)'));
  lines.push(entry.currency + ' ' + moneyFmt_(entry.amount) + ' — ' + (categoryName || 'needs category'));
  lines.push(entry.date + ' · ' + entry.type);
  lines.push('');
  lines.push('Reply to edit — category, amount, description, paid by, currency, or date. ' +
    'E.g. "amount 45.50", or combine several: "category groceries, amount 48, description Uber".');
  return lines.join('\n');
}

// Phase 4: budget threshold alerts, same bot as the review queue. Returns
// false (without throwing) when Telegram isn't linked yet, so checkBudgets
// knows not to mark the threshold as alerted — it'll try again next cycle.
function sendTelegramBudgetAlert_(budget, categoryDisplayName, threshold, progress) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return false;

  var periodLabel = budget.period_type === 'yearly' ? 'this year' : 'this month';
  var emoji = progress.percent >= 100 ? '🚨' : '⚠️';
  var spentStr = progress.spent != null ? moneyFmt_(progress.spent) : '?';
  var amountStr = moneyFmt_(budget.amount);
  // The threshold (e.g. 75%) is only what triggered this check, not what
  // to report — by the time it's actually noticed and sent, real spend
  // has usually already moved past it (e.g. 77%), so the message says
  // where things actually stand, not the round number that tripped it.
  var actualPercent = Math.round(progress.percent);
  var text = emoji + ' ' + categoryDisplayName + ': ' + actualPercent + '% of your ' + budget.currency + ' ' +
    amountStr + ' budget (' + budget.currency + ' ' + spentStr + ' spent ' + periodLabel + ').';

  telegramApi_('sendMessage', { chat_id: chatId, text: text });
  return true;
}

// ---- Polling for replies / button taps ----

function pollTelegramUpdates() {
  var token = getTelegramToken_();
  if (!token) return;

  var props = PropertiesService.getScriptProperties();
  var offset = Number(props.getProperty('TELEGRAM_UPDATE_OFFSET') || '0');

  var res = telegramApi_('getUpdates', { offset: offset, timeout: 0 });
  if (!res.ok) return;

  res.result.forEach(function (update) {
    props.setProperty('TELEGRAM_UPDATE_OFFSET', String(update.update_id + 1));
    handleTelegramUpdate_(update);
  });
}

// Same idea as pollTelegramUpdates' offset, applied to push delivery
// instead of pull: Telegram update_ids are monotonically increasing, so
// remembering the highest one actually processed and skipping anything at
// or below it is enough to make a retried delivery a no-op.
function isDuplicateTelegramUpdate_(updateId) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID') || '0');
  if (updateId <= last) return true;
  props.setProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID', String(updateId));
  return false;
}

function handleTelegramUpdate_(update) {
  if (update.callback_query) {
    handleTelegramCallback_(update.callback_query);
  } else if (update.message) {
    handleTelegramMessage_(update.message);
  }
}

function handleTelegramCallback_(cb) {
  if (!isOwnerChat_(cb.message.chat.id)) return;

  var parts = String(cb.data).split(':');
  var action = parts[0];
  var entryId = parts[1];

  if (action === 'confirm') {
    confirmEntryWithLearning_(entryId);
    telegramApi_('sendMessage', {
      chat_id: cb.message.chat.id, text: '✅ Confirmed.',
      reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true
    });
  } else if (action === 'discard') {
    deleteEntry_(entryId);
    telegramApi_('sendMessage', {
      chat_id: cb.message.chat.id, text: '🗑️ Discarded.',
      reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true
    });
  }

  telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
}

function handleTelegramMessage_(msg) {
  var text = (msg.text || '').trim();

  if (text.indexOf('/start') === 0) {
    var code = text.replace('/start', '').trim();
    if (isValidAccessCode(code)) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(msg.chat.id));
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: "✅ Linked! I'll send you transactions to review here.",
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
    } else {
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: "That code wasn't recognized.",
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
    }
    return;
  }

  if (!isOwnerChat_(msg.chat.id)) return;

  if (!msg.reply_to_message) {
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id, text: 'Reply directly to a transaction message to edit it.',
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
    return;
  }

  var mapping = getAllRows('Telegram Messages')
    .find(function (m) { return String(m.message_id) === String(msg.reply_to_message.message_id); });

  if (!mapping) {
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id, text: "Couldn't find that transaction — it may be too old.",
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
    return;
  }

  var result = applyEditCommand_(mapping.entry_id, text);
  // Threads to the owner's own edit command, which is itself already a
  // reply to the transaction card — keeps a clear chain (card -> edit
  // command -> "Updated X.") instead of a loose message at the bottom of
  // the chat with no visible connection to what it's about.
  telegramApi_('sendMessage', {
    chat_id: msg.chat.id, text: result.message,
    reply_to_message_id: msg.message_id, allow_sending_without_reply: true
  });

  if (result.entry) {
    sendTelegramEntryNotification_(result.entry, result.categoryName);
  }
}

function isOwnerChat_(chatId) {
  var ownerChatId = getOwnerTelegramChatId_();
  return !!ownerChatId && String(chatId) === String(ownerChatId);
}

// ---- Command parser (keyword-based, no AI — see file header) ----

var EDIT_COMMAND_PATTERNS = [
  { field: 'category', re: /^category\s+(.+)/i },
  { field: 'amount', re: /^amount\s+([\d.,]+)/i },
  { field: 'description', re: /^description\s+(.+)/i },
  { field: 'paid by', re: /^paid\s*by\s+(.+)/i },
  { field: 'currency', re: /^currency\s+([a-zA-Z]{3})/i },
  { field: 'date', re: /^date\s+(.+)/i }
];

// A reply can combine several edits in one message, comma-separated (e.g.
// "category groceries, amount 48, description NutriH" — the exact case
// that motivated this). Only split at a comma that's actually followed by
// another field keyword, so a comma inside a free-text value (a
// description like "Rent, September") is left alone rather than being
// torn in two.
var EDIT_FIELD_KEYWORDS_RE = '(?:category|amount|description|paid\\s*by|currency|date)\\s+';

function splitEditCommands_(text) {
  var boundaryRe = new RegExp('\\s*,\\s*(?=' + EDIT_FIELD_KEYWORDS_RE + ')', 'i');
  var segments = [];
  String(text).split(/\r?\n/).forEach(function (line) {
    line.split(boundaryRe).forEach(function (seg) {
      var trimmed = seg.trim();
      if (trimmed) segments.push(trimmed);
    });
  });
  return segments;
}

function applyEditCommand_(entryId, text) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return { message: 'Entry not found — it may have already been confirmed or discarded.' };

  var appliedFields = [];
  var failedSegments = [];

  splitEditCommands_(text).forEach(function (segment) {
    var field = applyOneEditSegment_(sheet, headers, rowIndex, entryId, segment);
    if (field) appliedFields.push(field);
    else failedSegments.push(segment);
  });

  var helpText = 'Try: "category groceries", "amount 45.50", "description text", ' +
    '"paid by Ana", "currency USD", or "date 2026-09-12" — ' +
    'combine several separated by commas, e.g. "category groceries, amount 45.50".';

  if (!appliedFields.length) {
    return { message: 'Didn\'t recognize that. ' + helpText };
  }

  var messageParts = ['Updated ' + appliedFields.join(', ') + '.'];
  if (failedSegments.length) {
    messageParts.push('Couldn\'t apply: ' + failedSegments.map(function (s) { return '"' + s + '"'; }).join(', ') + '. ' + helpText);
  }

  var updated = getEntryById_(entryId);
  var categoryName = null;
  if (updated.category_id) {
    var found = getAllRows('Categories').find(function (c) { return c.id === updated.category_id; });
    categoryName = found ? found.name : null;
  }

  return { message: messageParts.join(' '), entry: updated, categoryName: categoryName };
}

// Applies a single "field value" segment. Returns the field name on
// success, or null if the segment wasn't recognized or its value didn't
// resolve (unknown category/friend, unparseable amount) — the caller
// reports those back to the owner rather than failing the whole message.
function applyOneEditSegment_(sheet, headers, rowIndex, entryId, text) {
  var field = null, value = null;
  for (var i = 0; i < EDIT_COMMAND_PATTERNS.length; i++) {
    var m = text.match(EDIT_COMMAND_PATTERNS[i].re);
    if (m) { field = EDIT_COMMAND_PATTERNS[i].field; value = m[1].trim(); break; }
  }
  if (!field) return null;

  var entry = getEntryById_(entryId);

  if (field === 'category') {
    var cat = fuzzyFindCategory_(value, entry.type);
    if (!cat) return null;
    setCellByRow_(sheet, headers, rowIndex, 'category_id', cat.id);
  } else if (field === 'amount') {
    var amt = parseFloat(value.replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return null;
    setCellByRow_(sheet, headers, rowIndex, 'amount', amt);
  } else if (field === 'description') {
    setCellByRow_(sheet, headers, rowIndex, 'description', value);
  } else if (field === 'paid by') {
    if (value.toLowerCase() === 'me') {
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
    } else {
      var friend = fuzzyFindFriend_(value);
      if (!friend) return null;
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', friend.id);
    }
  } else if (field === 'currency') {
    setCellByRow_(sheet, headers, rowIndex, 'currency', value.toUpperCase());
  } else if (field === 'date') {
    setCellByRow_(sheet, headers, rowIndex, 'date', value);
  }

  return field;
}

function fuzzyFindCategory_(text, type) {
  var lower = text.toLowerCase();
  return getAllRows('Categories')
    .filter(function (c) { return c.type === type; })
    .find(function (c) {
      var name = c.name.toLowerCase();
      return name.indexOf(lower) !== -1 || lower.indexOf(name) !== -1;
    });
}

function fuzzyFindFriend_(text) {
  var lower = text.toLowerCase();
  return getAllRows('Friends').find(function (f) { return f.name.toLowerCase().indexOf(lower) !== -1; });
}

function getEntryById_(entryId) {
  return getAllRows('Entries').find(function (e) { return e.id === entryId; });
}

function setCellByRow_(sheet, headers, rowIndex, fieldName, value) {
  var col = headers.indexOf(fieldName);
  if (col === -1) return;
  sheet.getRange(rowIndex, col + 1).setValue(value);
}

function setEntryField_(entryId, fieldName, value) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return;
  setCellByRow_(sheet, headers, rowIndex, fieldName, value);
}

function deleteEntry_(entryId) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return;
  sheet.deleteRow(rowIndex);
}
