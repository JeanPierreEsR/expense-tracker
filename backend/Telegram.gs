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

function formatEntryForTelegram_(entry, categoryName) {
  var icon = entry.type === 'expense' ? '💸' : '🔁';
  var lines = [];
  lines.push(icon + ' ' + (entry.description || '(no description)'));
  lines.push(entry.currency + ' ' + Number(entry.amount).toFixed(2) + ' — ' + (categoryName || 'needs category'));
  lines.push(entry.date + ' · ' + entry.type);
  lines.push('');
  lines.push('Reply to change something, e.g. "category groceries" or "amount 45.50".');
  return lines.join('\n');
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
    telegramApi_('sendMessage', { chat_id: cb.message.chat.id, text: '✅ Confirmed.' });
  } else if (action === 'discard') {
    deleteEntry_(entryId);
    telegramApi_('sendMessage', { chat_id: cb.message.chat.id, text: '🗑️ Discarded.' });
  }

  telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
}

function handleTelegramMessage_(msg) {
  var text = (msg.text || '').trim();

  if (text.indexOf('/start') === 0) {
    var code = text.replace('/start', '').trim();
    if (isValidAccessCode(code)) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(msg.chat.id));
      telegramApi_('sendMessage', { chat_id: msg.chat.id, text: "✅ Linked! I'll send you transactions to review here." });
    } else {
      telegramApi_('sendMessage', { chat_id: msg.chat.id, text: "That code wasn't recognized." });
    }
    return;
  }

  if (!isOwnerChat_(msg.chat.id)) return;

  if (!msg.reply_to_message) {
    telegramApi_('sendMessage', { chat_id: msg.chat.id, text: 'Reply directly to a transaction message to edit it.' });
    return;
  }

  var mapping = getAllRows('Telegram Messages')
    .find(function (m) { return String(m.message_id) === String(msg.reply_to_message.message_id); });

  if (!mapping) {
    telegramApi_('sendMessage', { chat_id: msg.chat.id, text: "Couldn't find that transaction — it may be too old." });
    return;
  }

  var result = applyEditCommand_(mapping.entry_id, text);
  telegramApi_('sendMessage', { chat_id: msg.chat.id, text: result.message });

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

function applyEditCommand_(entryId, text) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return { message: 'Entry not found — it may have already been confirmed or discarded.' };

  var field = null, value = null;
  for (var i = 0; i < EDIT_COMMAND_PATTERNS.length; i++) {
    var m = text.match(EDIT_COMMAND_PATTERNS[i].re);
    if (m) { field = EDIT_COMMAND_PATTERNS[i].field; value = m[1].trim(); break; }
  }

  if (!field) {
    return {
      message: 'Didn\'t recognize that. Try: "category groceries", "amount 45.50", ' +
        '"description text", "paid by Ana", "currency USD", or "date 2026-09-12".'
    };
  }

  var entry = getEntryById_(entryId);
  var categoryName = null;

  if (field === 'category') {
    var cat = fuzzyFindCategory_(value, entry.type);
    if (!cat) return { message: 'No ' + entry.type + ' category matching "' + value + '" found.' };
    setCellByRow_(sheet, headers, rowIndex, 'category_id', cat.id);
    categoryName = cat.name;
  } else if (field === 'amount') {
    var amt = parseFloat(value.replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return { message: "Couldn't read that amount." };
    setCellByRow_(sheet, headers, rowIndex, 'amount', amt);
  } else if (field === 'description') {
    setCellByRow_(sheet, headers, rowIndex, 'description', value);
  } else if (field === 'paid by') {
    if (value.toLowerCase() === 'me') {
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
    } else {
      var friend = fuzzyFindFriend_(value);
      if (!friend) return { message: 'No friend matching "' + value + '" found.' };
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', friend.id);
    }
  } else if (field === 'currency') {
    setCellByRow_(sheet, headers, rowIndex, 'currency', value.toUpperCase());
  } else if (field === 'date') {
    setCellByRow_(sheet, headers, rowIndex, 'date', value);
  }

  var updated = getEntryById_(entryId);
  if (!categoryName && updated.category_id) {
    var found = getAllRows('Categories').find(function (c) { return c.id === updated.category_id; });
    categoryName = found ? found.name : null;
  }

  return { message: 'Updated ' + field + '.', entry: updated, categoryName: categoryName };
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
