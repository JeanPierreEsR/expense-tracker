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
 * Buttons handle only the two fixed actions (Confirm/Discard) — every
 * other option the app itself has for a pending expense is reachable by
 * replying directly to the transaction message with a short command
 * instead (added 2026-09-17, so nothing requires opening the app):
 * category/amount/description/paid-by/currency/date edits, splitting it
 * with friends ("split equal Ana", "split Ana 20, Carlos 15", "split
 * none"), or rerouting it entirely — "repayment Ana" / "loan Ana" —
 * to a settlement or a new loan instead of confirming it as an expense.
 * This is deliberately NOT free-form AI parsing (the project's $0 budget
 * rules out a paid AI API); it's a small keyword parser. See
 * applyEditCommand_ and applyTerminalReviewAction_.
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

function sendTelegramEntryNotification_(entry, categoryName, autoReason) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return null;

  var res = telegramApi_('sendMessage', {
    chat_id: chatId,
    text: formatEntryForTelegram_(entry, categoryName, autoReason),
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

// Shows every field the app itself would show/let you act on for this
// entry — added 2026-09-17 alongside full text-command coverage (see
// EDIT_COMMAND_PATTERNS, below), specifically so a decision (confirm,
// edit, split, or reroute to a loan/repayment) can be made entirely from
// the notification, without needing to open the app.
// autoReason (optional) marks the category as a guess made by the app, with
// the evidence, so it's clear it wasn't picked by hand — a reply like
// "category groceries" changes it and the refreshed card drops the tag.
function formatEntryForTelegram_(entry, categoryName, autoReason) {
  if (!categoryName && entry.category_id) {
    var cat = getAllRows('Categories').find(function (c) { return c.id === entry.category_id; });
    categoryName = cat ? cat.name : null;
  }
  var icon = entry.type === 'expense' ? '💸' : '🔁';
  var lines = [];
  lines.push(icon + ' ' + (entry.description || '(no description)'));
  lines.push(entry.currency + ' ' + moneyFmt_(entry.amount) + ' — ' + (categoryName || 'needs category') +
    (autoReason ? ' 🤖 auto (' + autoReason + ')' : ''));
  lines.push(entry.date + ' · ' + entry.type);
  if (entry.type === 'transfer') {
    // A transfer moves money between two of the owner's own accounts, so
    // it shows both ends explicitly (and no "Paid by" — it's always the
    // owner) instead of one ambiguous payment method.
    lines.push('⬆️ From: ' + paymentMethodDisplayName_(entry.payment_method_id, 'not set — reply "from Plin"'));
    lines.push('⬇️ To: ' + paymentMethodDisplayName_(entry.to_payment_method_id, 'not set — reply "to Diners"'));
  } else {
    lines.push('Paid by: ' + paidByDisplayName_(entry.paid_by));
    if (entry.payment_method_id) {
      var pm = getAllRows('Payment Methods').find(function (p) { return p.id === entry.payment_method_id; });
      if (pm) lines.push('💳 ' + pm.nickname + (pm.last_4 ? ' (' + pm.last_4 + ')' : ''));
    }
  }

  if (entry.type === 'expense') {
    var splits = getEntrySplits(entry.id);
    if (splits.length) {
      var splitTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
      var ownShare = Number(entry.amount) - splitTotal;
      var parts = splits.map(function (s) {
        return paidByDisplayName_(s.friend_id) + ' ' + entry.currency + ' ' + moneyFmt_(s.amount);
      });
      parts.push('you ' + entry.currency + ' ' + moneyFmt_(ownShare));
      lines.push('🔀 Split: ' + parts.join(', '));
    }
  }

  var tagIds = getEntryTags({ entryId: entry.id });
  if (tagIds.length) {
    var tagsById = rowsById_(getAllRows('Tags'));
    var tagNames = tagIds.map(function (id) { return tagsById[id] ? tagsById[id].name : id; });
    lines.push('🏷️ Labels: ' + tagNames.join(', '));
  }

  lines.push('');
  if (entry.type === 'transfer') {
    lines.push('Reply to edit — from, to, amount, description, currency, date, category, or label. ' +
      'E.g. "from Plin", "to Diners", or both: "from Plin, to Diners". ' +
      'Combine several with commas: "from Plin, to Diners, amount 90".');
    return lines.join('\n');
  }
  lines.push('Reply to edit — category, amount, description, paid by, payment method, currency, date, label, or split. ' +
    'E.g. "amount 45.50", "payment method Interbank", "label Trip, Work" (or "label none"), ' +
    '"split equal Ana", "split Ana 20, Carlos 15", "split none". ' +
    'Combine several with commas: "category groceries, amount 48, description Uber".');
  if (entry.type === 'expense') {
    lines.push('Or instead of confirming it as an expense: "repayment Ana" (you paying down what you owed them) ' +
      'or "loan Ana" (you lending them this) — either replaces it with the right Loans entry and removes it from here.');
  }
  return lines.join('\n');
}

function paymentMethodDisplayName_(id, missingText) {
  if (!id) return '❓ ' + missingText;
  var pm = getAllRows('Payment Methods').find(function (p) { return p.id === id; });
  return pm ? pm.nickname + (pm.last_4 ? ' (' + pm.last_4 + ')' : '') : id;
}

function paidByDisplayName_(id) {
  if (id === 'me') return 'Me';
  var friend = getAllRows('Friends').find(function (f) { return f.id === id; });
  return friend ? friend.name : id;
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

// Phase 5.6: loan due-date alerts, same bot, same "false means not
// configured yet, try again next cycle" contract as
// sendTelegramBudgetAlert_ above.
function sendTelegramLoanOverdueAlert_(loan, friendName) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return false;

  var directionText = loan.direction === 'they_owe_me' ? friendName + ' owes you' : 'You owe ' + friendName;
  var text = '⏰ Overdue: ' + directionText + ' ' + loan.currency + ' ' + moneyFmt_(loan.remaining) +
    ' (due ' + loan.due_date + ').' + (loan.description ? ' ' + loan.description : '');

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

  // Checked before the normal field-edit parser — "repayment"/"loan"
  // reroute the WHOLE entry to the Loans tab instead of editing a field
  // on it (see applyTerminalReviewAction_, below), so they don't try to
  // combine with other edits the way "category X, amount Y" does.
  var terminalMatch = text.match(/^(?:mark\s+as\s+)?repayment\s+(.+)/i) ||
    text.match(/^(?:convert\s+to\s+)?loan\s+(.+)/i);
  var result = terminalMatch
    ? applyTerminalReviewAction_(mapping.entry_id, text, terminalMatch[1])
    : applyEditCommand_(mapping.entry_id, text);

  // Threads to the owner's own edit command, which is itself already a
  // reply to the transaction card — keeps a clear chain (card -> edit
  // command -> "Updated X.") instead of a loose message at the bottom of
  // the chat with no visible connection to what it's about.
  telegramApi_('sendMessage', {
    chat_id: msg.chat.id, text: result.message,
    reply_to_message_id: msg.message_id, allow_sending_without_reply: true
  });

  // A terminal action already removed the entry — nothing left to show a
  // refreshed card for.
  if (result.entry && !result.removed) {
    sendTelegramEntryNotification_(result.entry, result.categoryName);
  }
}

// "repayment Ana" / "mark as repayment Ana" or "loan Ana" / "convert
// to loan Ana" — the Telegram equivalent of the review queue's own
// "💰 Mark as repayment" / "🤝 Convert to loan" (see CLAUDE.md's Review
// queue section for the shared reasoning: every pending entry is money
// the owner sent OUT, so there's exactly one sensible direction for
// each, never a picker). Reuses the exact same backend calls those make.
function applyTerminalReviewAction_(entryId, fullText, friendText) {
  var entry = getEntryById_(entryId);
  if (!entry) return { message: 'Entry not found — it may have already been confirmed or discarded.' };
  if (entry.type !== 'expense') {
    return { message: "This is an internal transfer, not a friend transaction — repayment/loan doesn't apply here." };
  }

  var friend = fuzzyFindFriend_(String(friendText).trim());
  if (!friend) {
    return { message: 'Didn\'t recognize the friend "' + String(friendText).trim() + '".' };
  }

  var isRepayment = /^(?:mark\s+as\s+)?repayment/i.test(fullText.trim());

  if (isRepayment) {
    var repayResult = recordRepayment({
      friend_id: friend.id,
      direction: 'i_owe_them',
      amount: Number(entry.amount),
      currency: entry.currency,
      date: entry.date,
      payment_method_id: entry.payment_method_id || ''
    });
    deleteEntry_(entryId);
    var msg = '✅ Marked as a repayment to ' + friend.name + '.';
    if (repayResult.overpaid > 0.004) {
      msg += ' ' + entry.currency + ' ' + moneyFmt_(repayResult.overpaid) +
        ' was more than they were owed — that part wasn’t recorded; handle it from the Loans tab in the app if needed.';
    }
    return { message: msg, removed: true };
  }

  addLoan({
    friend_id: friend.id,
    direction: 'they_owe_me',
    amount: Number(entry.amount),
    currency: entry.currency,
    date: entry.date,
    payment_method_id: entry.payment_method_id || '',
    description: entry.description || ''
  });
  deleteEntry_(entryId);
  return {
    message: '✅ Converted to a loan — ' + friend.name + ' now owes you ' + entry.currency + ' ' + moneyFmt_(entry.amount) + '.',
    removed: true
  };
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
  { field: 'date', re: /^date\s+(.+)/i },
  // Added 2026-09-17 alongside full text-command parity with the app's
  // own Split UI — see parseSplitCommand_, below, for the three forms
  // this accepts ("equal ...", "Name amount, Name amount", "none").
  { field: 'split', re: /^split\s+(.+)/i },
  // Payment method and label(s) — same parity goal, requested directly:
  // whatever the app's own entry-editing pop-up can change, a Telegram
  // reply should be able to change too. "payment method" (not "payment"
  // alone) to read unambiguously in a help line next to "paid by".
  { field: 'payment method', re: /^payment\s*method\s+(.+)/i },
  // Transfers only (see applyOneEditSegment_): the two ends of the move.
  { field: 'from', re: /^from\s+(.+)/i },
  { field: 'to', re: /^to\s+(.+)/i },
  { field: 'label', re: /^label\s+(.+)/i }
];

// A reply can combine several edits in one message, comma-separated (e.g.
// "category groceries, amount 48, description NutriH" — the exact case
// that motivated this). Only split at a comma that's actually followed by
// another field keyword, so a comma inside a free-text value (a
// description like "Rent, September") is left alone rather than being
// torn in two — this is also why a custom split's own friend-amount pairs
// ("Ana 20, Carlos 15") and a multi-label set ("label Trip, Work") stay
// intact as one segment each: "Carlos"/"Work" aren't field keywords, so
// the comma before either is never treated as a new segment boundary.
var EDIT_FIELD_KEYWORDS_RE = '(?:category|amount|description|paid\\s*by|currency|date|split|payment\\s*method|label|from|to)\\s+';

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
    '"paid by Ana", "currency USD", "date 2026-09-12", "payment method Interbank", ' +
    '"label Trip, Work" (or "label none"), "split equal Ana", ' +
    '"split Ana 20, Carlos 15", or "split none" — ' +
    'combine several separated by commas, e.g. "category groceries, amount 45.50". ' +
    'Names must match a whole word or the start of one — if a name fits more than one ' +
    '(e.g. two people named Ray), type more of it.';

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
  } else if (field === 'split') {
    var parsed = parseSplitCommand_(entry, value);
    if (!parsed) return null;
    saveEntrySplits(entryId, parsed);
  } else if (field === 'payment method') {
    var pm = fuzzyFindPaymentMethod_(value);
    if (!pm) return null;
    setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', pm.id);
  } else if (field === 'from' || field === 'to') {
    if (entry.type !== 'transfer') return null;
    var endPm = fuzzyFindPaymentMethod_(value);
    if (!endPm) return null;
    if (field === 'from') {
      setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', endPm.id);
    } else {
      ensureEntriesToPaymentMethodColumn_();
      setEntryField_(entryId, 'to_payment_method_id', endPm.id);
    }
  } else if (field === 'label') {
    var tagIds = parseLabelCommand_(value);
    if (tagIds === null) return null;
    saveEntryTags({ entryId: entryId, tagIds: tagIds });
  }

  return field;
}

// Parses the three forms the app's own Split UI offers, as text:
// - "none" (or "clear"/"off") — clears an existing split back to nothing,
//   same as unchecking "Split this expense" in the app.
// - "equal Ana" or "equal Ana, Carlos" — divides the entry's CURRENT
//   amount evenly across the owner + however many friends are named,
//   same cents-based rounding (leftover to the owner) as
//   computeEqualShares in docs/app.js, just computed server-side here
//   since there's no live form state to read it from.
// - "Ana 20, Carlos 15" — explicit amount per friend, same shape
//   saveEntrySplits already expects. Rejected (returns null, reported as
//   "couldn't apply") if the total exceeds the entry's own amount — the
//   app's own form validates this the same way before ever calling
//   saveEntrySplits, which doesn't check it itself.
// Returns the splits array to hand to saveEntrySplits, or null if
// anything couldn't be resolved (an unrecognized friend name, a bad
// amount, or an over-total).
function parseSplitCommand_(entry, text) {
  var trimmed = String(text).trim();
  if (/^(none|clear|off)$/i.test(trimmed)) return [];

  var equalMatch = trimmed.match(/^equal\s+(.+)/i);
  if (equalMatch) {
    var names = equalMatch[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) return null;
    var friends = [];
    for (var i = 0; i < names.length; i++) {
      var f = fuzzyFindFriend_(names[i]);
      if (!f) return null;
      friends.push(f);
    }
    var n = friends.length;
    var totalCents = Math.round(Number(entry.amount) * 100);
    var shareCents = Math.floor(totalCents / (n + 1));
    return friends.map(function (fr) { return { friend_id: fr.id, amount: shareCents / 100 }; });
  }

  // Custom: "Ana 20, Carlos 15" — each part is "<name> <amount>".
  var parts = trimmed.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  var splits = [];
  var assigned = 0;
  for (var j = 0; j < parts.length; j++) {
    var m = parts[j].match(/^(.+?)\s+([\d.,]+)$/);
    if (!m) return null;
    var friend2 = fuzzyFindFriend_(m[1].trim());
    if (!friend2) return null;
    var amt = parseFloat(m[2].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) return null;
    splits.push({ friend_id: friend2.id, amount: amt });
    assigned += amt;
  }
  if (assigned - Number(entry.amount) > 0.004) return null;
  return splits;
}

// "none" (or "clear"/"off") clears every label, same convention
// parseSplitCommand_ uses for clearing a split — otherwise a
// comma-separated list of tag names, e.g. "Trip, Work". This REPLACES
// the entry's whole label set (same as typing a new "category" replaces
// the old one, and same shape as saveEntryTags/saveEntrySplits'
// replace-from-scratch design elsewhere) rather than adding to it — a
// second "label ..." reply is how to change the set, not append to it.
// An unrecognized tag name fails the whole segment (returns null,
// reported as "couldn't apply") rather than creating a new tag on the
// fly — same as an unrecognized friend name in a split command; the
// app's own "+ Add tag…" is still the one place a brand-new tag gets
// created.
function parseLabelCommand_(text) {
  var trimmed = String(text).trim();
  if (/^(none|clear|off)$/i.test(trimmed)) return [];

  var names = trimmed.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!names.length) return null;

  var tagIds = [];
  for (var i = 0; i < names.length; i++) {
    var tag = fuzzyFindTag_(names[i]);
    if (!tag) return null;
    if (tagIds.indexOf(tag.id) === -1) tagIds.push(tag.id);
  }
  return tagIds;
}

// Lowercased, accent-stripped, punctuation collapsed to single spaces —
// "Food & Drink" and "food drink" compare equal, "Psicólogo" and
// "psicologo" too.
function normalizeName_(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// The one name-resolver every Telegram reply command shares (category,
// paid by, payment method, label, split friends, repayment/loan friend).
// Ranked, whole-word matching — NOT raw substring containment, which is
// what this used to be and which went wrong in a real reply: "category
// healthcare" resolved to Car, because the old category matcher also
// accepted a category whose NAME appears anywhere INSIDE the typed text,
// and "health-CAR-e" contains "car" (Car sits earlier in the sheet).
// Same class of hazard in the data today: "credit card" contains "car";
// "AI" sits inside "entertAInment". Tiers, best first — the first tier
// with any hit decides:
//   1. the whole name equals what was typed;
//   2. the name STARTS with what was typed ("food" -> Food & Drink);
//   3. what was typed starts one of the name's words ("drink" -> Food &
//      Drink, "card" -> Credit card);
//   4. the name appears as whole word(s) INSIDE the typed text
//      ("groceries store" -> Groceries) — whole words only, never mid-word.
// A hit is only returned when it's unambiguous: if the winning tier holds
// more than one different item ("ray" with both Ben Ray and
// Eva Ray), that's null — reported back as "couldn't apply" —
// instead of silently picking whichever is first in the sheet, since a
// wrong pick here means a debt or an expense on the wrong person/category.
function pickByName_(items, text, nameOf) {
  var q = normalizeName_(text);
  if (!q) return null;
  var padded = ' ' + q + ' ';
  var tiers = [[], [], [], []];
  items.forEach(function (item) {
    var n = normalizeName_(nameOf(item));
    if (!n) return;
    if (n === q) tiers[0].push(item);
    else if (n.indexOf(q) === 0) tiers[1].push(item);
    else if ((' ' + n).indexOf(' ' + q) !== -1) tiers[2].push(item);
    else if (padded.indexOf(' ' + n + ' ') !== -1) tiers[3].push(item);
  });
  for (var i = 0; i < tiers.length; i++) {
    if (tiers[i].length === 1) return tiers[i][0];
    if (tiers[i].length > 1) return i === 0 ? tiers[i][0] : null;
  }
  return null;
}

function fuzzyFindCategory_(text, type) {
  var cats = getAllRows('Categories').filter(function (c) { return c.type === type; });
  return pickByName_(cats, text, function (c) { return c.name; });
}

function fuzzyFindFriend_(text) {
  return pickByName_(getAllRows('Friends'), text, function (f) { return f.name; });
}

function fuzzyFindTag_(text) {
  return pickByName_(getAllRows('Tags'), text, function (t) { return t.name; });
}

function fuzzyFindPaymentMethod_(text) {
  return pickByName_(getAllRows('Payment Methods'), text, function (p) { return p.nickname; });
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
  // A no-op for an entry that was never split (the common case, and every
  // pending/review-queue entry today, since Phase 5's split UI is only on
  // confirmed entries) — see deleteEntrySplitsAndLoansForEntry_ in
  // Loans.gs for what it does when there's something to clean up.
  deleteEntrySplitsAndLoansForEntry_(entryId);
  deleteRowsWhere_('Entry Tags', function (row) { return row.entry_id === entryId; });
}
