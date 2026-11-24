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
  // While WhatsApp is the review bot (WhatsAppBot.gs), the "chat" is WhatsApp: the Telegram chat gets nothing and is not listened to.
  if (reviewBotIsWhatsApp_()) return WA_CHAT_ID_;
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
}

// Something can be sent: Telegram linked, or WhatsApp is the review bot.
function reviewBotCanSend_(chatId) {
  return !!chatId && (chatId === WA_CHAT_ID_ || !!getTelegramToken_());
}

function promptSetTelegramToken() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Set Telegram Bot Token', 'Paste the token @BotFather gave you:', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() === ui.Button.OK) {
    var token = result.getResponseText().trim();
    if (token) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', token);
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_UPDATE_OFFSET');
      PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_CHAT_ID');   // unlink: the next /start links afresh
      ui.alert('Saved. Now message your bot on Telegram: /start <your access code>');
    }
  }
}

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
  var target = relayUrl || getWebAppUrl_();   // this copy's own address (Features.gs), never another copy's
  if (!target) throw new Error(tr_('webAppUrl.missing'));
  return target;
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

// ---- Protecting the webhook (2026-10-05) ----
// One shared secret, three holders: Telegram sends it as the
// X-Telegram-Bot-Api-Secret-Token header (setWebhook's secret_token); the
// Cloudflare relay checks that header and adds the secret to the body it
// forwards (Apps Script can't read headers); doPost checks the body's
// relay_secret. Unset = not protected yet, nothing changes.
function getTelegramRelaySecret_() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_RELAY_SECRET') || '';
}

function isTelegramRelayAuthorized_(body) {
  var secret = getTelegramRelaySecret_();
  return !secret || body.relay_secret === secret;
}

function telegramWebhookPayload_() {
  var payload = { url: getTelegramWebhookTargetUrl_() };
  var secret = getTelegramRelaySecret_();
  if (secret) payload.secret_token = secret;
  return payload;
}

function menuProtectTelegramWebhook() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  if (!getTelegramToken_()) { ui.alert('Set the Telegram bot token first (menu item 9).'); return; }
  if (!props.getProperty('TELEGRAM_RELAY_URL')) {
    ui.alert('Set the Telegram relay URL first (menu item 17) — this protection works through the Cloudflare relay.');
    return;
  }
  var answer = ui.alert('Protect the Telegram webhook?',
    'This creates a secret and switches protection on immediately. Telegram buttons and replies will PAUSE (Telegram retries them) until you paste the updated Worker code and the secret into Cloudflare — the next screen shows exactly what to do. Continue?',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  var secret = generateAccessCode_();   // 32 letters/digits — allowed by Telegram's secret_token
  props.setProperty('TELEGRAM_RELAY_SECRET', secret);
  var res = telegramApi_('setWebhook', telegramWebhookPayload_());
  if (!res.ok) {
    props.deleteProperty('TELEGRAM_RELAY_SECRET');   // don't leave it on half-configured
    ui.alert('Could not re-register the webhook, so protection was NOT switched on: ' + (res.description || JSON.stringify(res)));
    return;
  }
  ui.alert('Protection is ON. Now, in Cloudflare (Workers → your relay → Edit code), paste the updated telegram-relay.js, then Settings → Variables and Secrets → add a SECRET named RELAY_SECRET with this value, and Deploy. Your secret (shown only now): ' + secret);
}

function enableTelegramWebhook() {
  var ui = SpreadsheetApp.getUi();
  if (!getTelegramToken_()) {
    ui.alert('Set the Telegram bot token first (menu item 9).');
    return;
  }
  var res = telegramApi_('setWebhook', telegramWebhookPayload_());
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
  // One review bot at a time: while it is WhatsApp, the messages go there instead (WhatsAppBot.gs); set-up calls stay Telegram's.
  if (WA_TELEGRAM_METHODS_[method] && reviewBotIsWhatsApp_()) return whatsappFromTelegram_(method, payload);
  var token = getTelegramToken_();
  if (!token) throw new Error('Telegram bot token not set');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var out = JSON.parse(res.getContentText());
  if (method === 'sendMessage' && out && out.ok && out.result && out.result.message_id) telegramNoteSent_(out.result.message_id, payload);
  return out;
}

// The "last message" rule, the same as WhatsApp's (owner, 2026-11-16): every message the bot sends is remembered (TG_LAST_OUT),
// and an answer that quotes a transaction's message ("✅ Confirmed.", a list, the tag question) belongs to that transaction too,
// like its card. A message sent without replying is then about the transaction of the bot's last message, waiting or confirmed.
function telegramNoteSent_(messageId, payload) {
  try {
    PropertiesService.getScriptProperties().setProperty('TG_LAST_OUT', String(messageId));
    botNoteSentId_(messageId);   // an action's answers belong to it, for "deshacer" (BotUndo.gs)
    var entryId = payload && payload.reply_to_message_id ? whatsappCardEntry_(payload.reply_to_message_id) : '';
    if (entryId) appendRowObject('Telegram Messages', { message_id: String(messageId), entry_id: entryId, created_at: new Date().toISOString() });
  } catch (err) { /* remembering never fails a send */ }
}
function telegramLastTarget_() {
  var id = String(PropertiesService.getScriptProperties().getProperty('TG_LAST_OUT') || '');
  return id && whatsappCardEntry_(id) ? id : '';
}

// ---- Outgoing notifications ----

function sendTelegramEntryNotification_(entry, categoryName, autoReason) {
  var chatId = getOwnerTelegramChatId_();
  if (!reviewBotCanSend_(chatId)) return null;

  var payload = {
    chat_id: chatId,
    // No "Reply to edit" line while the bot's tour runs (owner, 2026-11-20: it teaches words while the tour teaches the buttons);
    // its last step says what that line is. Not counted either.
    text: formatEntryForTelegram_(entry, categoryName, autoReason, { hint: botTourState_() ? false : replyHintShow_() })
  };
  // A confirmed entry's card (shown after an edit reply) has no buttons — it
  // is already done, and can still be changed by replying.
  if (entry.status !== 'confirmed') {
    // Confirm · Edit · Discard on both bots (owner, 2026-11-16). Edit opens the shared lists (WhatsAppBot.gs); "It's the income
    // I was waiting for" (IncomeWaiting.gs) is a row of that list when it fits, as on WhatsApp, no longer a button here.
    payload.reply_markup = {
      inline_keyboard: [[
        { text: tr_('bot.confirmButton'), callback_data: 'confirm:' + entry.id },
        { text: tr_('whatsapp.editButton'), callback_data: 'waedit:' + entry.id },
        { text: tr_('bot.discardButton'), callback_data: 'discard:' + entry.id }
      ]]
    };
  }
  var res = telegramApi_('sendMessage', payload);

  if (res.ok && res.result && res.result.message_id) {
    appendRowObject('Telegram Messages', {
      message_id: String(res.result.message_id),
      entry_id: entry.id,
      created_at: new Date().toISOString()
    });
    noteLastTelegramNotification_(res.result.message_id, entry.id);
  }
  return res;
}

// The newest notification the bot sent (an entry card, a budget alert, a loan
// alert, a statement notice). A message typed WITHOUT replying to anything is
// assumed to be about this one — but only if it is an entry card whose entry
// is still pending (see lastPendingCardMessageId_). Alerts store no entry id,
// so a typed message after an alert gets the "reply directly" note.
function noteLastTelegramNotification_(messageId, entryId) {
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_LAST_NOTIFICATION',
    JSON.stringify({ message_id: String(messageId), entry_id: entryId || '' }));
}

// The card's "Reply to edit" line (owner, 2026-11-20): on every card until the person has changed a transaction by writing
// REPLY_HINT_LEARNED_ times, then on one card in REPLY_HINT_EVERY_ as a reminder. A sign they are stuck ("help", words the
// bot did not understand) brings it back on the next REPLY_HINT_AGAIN_ cards. Edit taps on WhatsApp do not count as writing.
// "help" still gives every word at any time. One count per copy of the app (script property).
var REPLY_HINT_LEARNED_ = 3, REPLY_HINT_EVERY_ = 15, REPLY_HINT_AGAIN_ = 3;

function replyHintState_() {
  var raw = PropertiesService.getScriptProperties().getProperty('BOT_REPLY_HINT');
  var s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch (err) { s = null; }
  return { edits: Number(s && s.edits) || 0, cards: Number(s && s.cards) || 0, again: Number(s && s.again) || 0 };
}

function saveReplyHintState_(s) {
  PropertiesService.getScriptProperties().setProperty('BOT_REPLY_HINT', JSON.stringify(s));
}

// Whether the card being sent now carries the line; counts the card.
function replyHintShow_() {
  var s = replyHintState_(), show;
  if (s.edits < REPLY_HINT_LEARNED_) show = true;
  else if (s.again > 0) { s.again--; show = true; }
  else { s.cards++; show = s.cards % REPLY_HINT_EVERY_ === 0; }
  saveReplyHintState_(s);
  return show;
}

function noteReplyHintEdit_() {
  if (WA_SAVE_ONLY_) return;
  var s = replyHintState_();
  if (s.edits >= REPLY_HINT_LEARNED_) return;
  s.edits++;
  saveReplyHintState_(s);
}

function noteReplyHintStuck_() {
  var s = replyHintState_();
  if (s.edits < REPLY_HINT_LEARNED_) return;   // still learning: every card has it anyway
  s.again = REPLY_HINT_AGAIN_;
  saveReplyHintState_(s);
}

function noteTelegramAlertSent_(res) {
  if (res && res.ok && res.result && res.result.message_id) noteLastTelegramNotification_(res.result.message_id, '');
}

// Message id of the last notification when it is an entry card still waiting
// for approval; otherwise null.
function lastPendingCardMessageId_() {
  var raw = PropertiesService.getScriptProperties().getProperty('TELEGRAM_LAST_NOTIFICATION');
  if (!raw) return null;
  var last;
  try { last = JSON.parse(raw); } catch (err) { return null; }
  if (!last || !last.entry_id) return null;
  var entry = getEntryById_(last.entry_id);
  return entry && entry.status === 'pending' ? last.message_id : null;
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
// autoReason === true means a familiar merchant: just the bare "🤖 auto" tag.
function formatEntryForTelegram_(entry, categoryName, autoReason, opts) {
  if (!categoryName && entry.category_id) {
    var cat = getAllRows('Categories').find(function (c) { return c.id === entry.category_id; });
    categoryName = cat ? categoryLabel_(cat) : null;
  }
  // A waiting currency exchange is ONE card for both sides (owner, 2026-11-20): "PEN 5,000.00 → USD 1,448.44", where it left and
  // where it arrived. Confirm / Discard act on both (handleTelegramCallback_), "from" / "to" reach the right side (applyOneEditSegment_).
  var xPair = entry.type === 'transfer' ? exchangePairOf_(entry) : null;
  if (xPair) {
    var xLines = ['🔁 ' + (xPair.out.description || xPair['in'].description || tr_('bot.noDescription')) + (entry.status === 'confirmed' ? tr_('bot.confirmedTag') : ''),
      xPair.out.currency + ' ' + moneyFmt_(xPair.out.amount) + ' → ' + xPair['in'].currency + ' ' + moneyFmt_(xPair['in'].amount),
      entry.date === Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd') ? tr_('bot.today') : entry.date,
      tr_('bot.exchangeLeftFrom') + paymentMethodDisplayName_(xPair.out.payment_method_id, tr_('bot.notSetFrom')),
      tr_('bot.exchangeArrivedIn') + paymentMethodDisplayName_(xPair['in'].to_payment_method_id, tr_('bot.notSetTo'))];
    if (opts && opts.hint === false) return xLines.join('\n');
    xLines.push('');
    xLines.push(tr_('bot.hintExchange'));
    return xLines.join('\n');
  }
  var icon = entry.type === 'expense' ? '🧾' : entry.type === 'income' ? '💰' : entry.type === 'investment' ? '📈' : '🔁';
  var lines = [];
  // Short card (owner, 2026-11-20): an expense's 🧾 says its type, the rarer types keep their word on the first line.
  lines.push(icon + ' ' + (entry.description || tr_('bot.noDescription')) +
    (entry.type === 'expense' ? '' : ' · ' + tr_('bot.type.' + entry.type)) + (entry.status === 'confirmed' ? tr_('bot.confirmedTag') : ''));
  if (entry.type === 'investment') {
    // No category for investments (see defaultInvestmentCategoryId_); a type the app guessed from the place says so.
    lines.push(entry.currency + ' ' + moneyFmt_(entry.amount) +
      (autoReason === true ? tr_('bot.autoTagShort') : autoReason ? tr_('bot.autoTag', { reason: autoReason }) : ''));
  } else {
    lines.push(entry.currency + ' ' + moneyFmt_(entry.amount) + ' — ' + (categoryName || tr_('bot.needsCategory')) +
      (autoReason === true ? tr_('bot.autoTagShort') : autoReason ? tr_('bot.autoTag', { reason: autoReason }) : ''));
  }
  var dateText = entry.date === Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd') ? tr_('bot.today') : entry.date;
  var accountText = '💳 ' + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetPaymentMethod'));
  if (entry.type === 'transfer' || entry.type === 'investment') lines.push(dateText);
  if (entry.type === 'transfer') {
    // A transfer moves money between two of the owner's own accounts, so
    // it shows both ends explicitly (and no "Paid by" — it's always the
    // owner) instead of one ambiguous payment method.
    lines.push(tr_('bot.fromLabel') + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetFrom')));
    lines.push(tr_('bot.toLabel') + paymentMethodDisplayName_(entry.to_payment_method_id, tr_('bot.notSetTo')));
  } else if (entry.type === 'investment') {
    // Money from one of the owner's accounts into an investment platform.
    var platformName = paymentMethodDisplayName_(entry.to_payment_method_id, tr_('bot.notSetPlatform'));
    if (Number(entry.amount) < 0) {
      lines.push(tr_('bot.withdrawalLine'));
      lines.push(tr_('bot.fromPlatform') + platformName);
      lines.push(tr_('bot.receivedAt') + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetReceivedAt')));
    } else {
      lines.push(tr_('bot.fromLabel') + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetPaymentMethod')));
      lines.push(tr_('bot.platformLabel') + platformName);
    }
  } else if (entry.type === 'income') {
    // Income holds a payor (who paid the owner), never a friend.
    var payor = entry.paid_by ? getPayorRows_().find(function (p) { return p.id === entry.paid_by; }) : null;
    // No payment method shows "❓ not set — reply ..." (same as a transfer's
    // missing end) instead of leaving it out.
    lines.push(dateText + ' · ' + accountText);
    lines.push(tr_('bot.receivedFrom') + (payor ? payor.name : tr_('bot.notSetPayor')));
  } else {
    lines.push(dateText + ' · ' + accountText);
    // "Paid by" only when someone else paid (owner, 2026-11-20): paid by the person is the usual case and needs no line.
    if (entry.paid_by && entry.paid_by !== 'me') lines.push(tr_('bot.paidBy') + paidByDisplayName_(entry.paid_by));
  }

  // Kept waiting for its loans to be chosen (RepayIntent.gs): what Confirm does, and where to choose them.
  var repayIt = repayIntentOf_(entry);
  if (repayIt) {
    var repayFriend = getAllRows('Friends').find(function (f) { return f.id === repayIt.friend_id; });
    lines.push(tr_(repayIt.direction === 'they_owe_me' ? 'bot.repayIntentFrom' : 'bot.repayIntentTo', { friend: repayFriend ? repayFriend.name : '?' }));
  }

  if (entry.type === 'expense') {
    var splits = getEntrySplits(entry.id);
    if (splits.length) {
      var splitTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
      var ownShare = Number(entry.amount) - splitTotal;
      var parts = splits.map(function (s) {
        return paidByDisplayName_(s.friend_id) + ' ' + entry.currency + ' ' + moneyFmt_(s.amount);
      });
      parts.push(tr_('bot.you') + ' ' + entry.currency + ' ' + moneyFmt_(ownShare));
      lines.push(tr_('bot.splitLabel') + parts.join(', '));
    }
  }

  var tagIds = getEntryTags({ entryId: entry.id });
  if (tagIds.length) {
    var tagsById = rowsById_(getAllRows('Tags'));
    var tagNames = tagIds.map(function (id) { return tagsById[id] ? tagLabel_(tagsById[id]) : id; });
    lines.push(tr_('bot.labelsLabel') + tagNames.join(', '));
  }

  // Trip / event (expenses only): the current one, or — for a pending entry with none — the one whose
  // dates match, as a suggestion the owner confirms by replying "trip <name>".
  if (entry.type === 'expense') {
    var tripRows = getTripRows_();
    var linkedTrip = entry.trip_id ? tripRows.filter(function (t) { return t.id === entry.trip_id; })[0] : null;
    if (linkedTrip) {
      lines.push(tr_('bot.tripLabel') + tripDisplayName_(linkedTrip));
    } else if (entry.status === 'pending') {
      if (entry.trip_id === TRIP_DECLINED_) {
        lines.push(tr_('bot.tripNotLinked'));
      } else {
        // Confirming (the button, or a reply) links the trip whose dates cover this one — said here first.
        var suggestedId = suggestedTripIdForDate_(entry.date, tripRows);
        var suggestedTrip = suggestedId ? tripRows.filter(function (t) { return t.id === suggestedId; })[0] : null;
        if (suggestedTrip) lines.push(tr_('bot.tripWillLink', { name: tripDisplayName_(suggestedTrip) }));
      }
    }
  }

  // A bank e-mail someone forwarded (ForwardedEmail.gs): who sent it, unless it is this Gmail or one of the person's other addresses.
  var forwardedBy = entry.status === 'pending' ? forwardShownBy_(entry) : '';
  if (forwardedBy) lines.push(forwardedBy === FORWARD_UNKNOWN_ ? tr_('bot.forwardedByUnknown') : tr_('bot.forwardedBy', { address: forwardedBy }));

  var waitingMatch = waitingMatchForPending_(entry, entry.type === 'income' && entry.status === 'pending' ? listWaitingIncome_() : []);
  if (waitingMatch) {
    lines.push('');
    lines.push(tr_('bot.waitingAsk', { name: waitingMatch.friend_name, cur: waitingMatch.currency, amount: moneyFmt_(waitingMatch.remaining) }));
  }

  var twins = entry.status === 'pending' ? findSameDayTwins_(entry, getAllRows('Entries')) : [];
  if (twins.length) {
    lines.push('');
    lines.push(tr_('bot.duplicate', { list: twins.map(function (t) {
      return tr_('bot.duplicateItem', { name: t.description || tr_('bot.anEntry'), status: (t.status === 'pending' || t.status === 'confirmed') ? tr_('bot.status.' + t.status) : t.status });
    }).join(', ') }));
  }

  // The "Reply to edit" line comes and goes (replyHintShow_); a caller that does not say shows it.
  if (opts && opts.hint === false) return lines.join('\n');
  lines.push('');
  lines.push(tr_(entry.type === 'transfer' ? 'bot.hintTransfer' : entry.type === 'investment' ? 'bot.hintInvestment' : 'bot.hintOther'));
  return lines.join('\n');
}

// Full syntax + examples for editing a pending entry by reply — used to
// live inline on every card (two paragraphs, on every single transaction
// notification); now sent only on demand, via a "help" reply, so the card
// itself stays short. See formatEntryForTelegram_, above, and
// handleTelegramMessage_, below.
function telegramEditHelpText_(entry) {
  var help = function (keys) {
    return keys.map(function (k) { return k === '' ? '' : tr_('help.' + k); }).join('\n');
  };
  var tail = ['', 'undo', 'bothLanguages'];
  if (entry.type === 'transfer') {
    return help(['intro', 't.from', 't.to', 't.amount', 'descTaxi', 'currency', 'date', 't.category', 'label', 't.type', '', 't.combine', '', 'transfer.intro', 'transfer.repayment', 'transfer.loan'].concat(tail));
  }
  if (entry.type === 'investment') {
    return help(['intro', 'i.platform', 'i.direction', 'i.paymentMethod', 'i.receivedAt', 'i.amount', 'descDeposit', 'currency', 'date', 'label', 'i.type', '', 'i.combine'].concat(tail));
  }
  var keys = ['intro', 'o.category', 'o.amount', 'descUber', 'o.paidBy', 'o.paymentMethod', 'currency', 'date', 'label', 'o.split', 'o.type', '', 'o.combine', 'o.names'];
  if (entry.type === 'expense' && getTripRows_().length) keys.splice(keys.indexOf('o.split'), 0, 'trip');
  if (entry.type === 'expense') keys = keys.concat(['', 'expense.intro', 'expense.repayment', 'expense.loan']);
  if (entry.type === 'income') keys = keys.concat(['', 'income.intro', 'income.repayment', 'income.loan']);
  if ((entry.type === 'expense' || entry.type === 'income') && getTripRows_().length) keys.push('groupDefault');
  return help(keys.concat(tail));
}

function paymentMethodDisplayName_(id, missingText) {
  if (!id) return '❓ ' + missingText;
  var pm = getAllRows('Payment Methods').find(function (p) { return p.id === id; });
  return pm ? pm.nickname + (pm.last_4 ? ' (' + pm.last_4 + ')' : '') : id;
}

function paidByDisplayName_(id) {
  if (id === 'me') return tr_('bot.me');
  var friend = getAllRows('Friends').find(function (f) { return f.id === id; });
  return friend ? friend.name : id;
}

// Phase 4: budget threshold alerts, same bot as the review queue. Returns
// false (without throwing) when Telegram isn't linked yet, so checkBudgets
// knows not to mark the threshold as alerted — it'll try again next cycle.
function sendTelegramBudgetAlert_(budget, categoryDisplayName, threshold, progress) {
  var chatId = getOwnerTelegramChatId_();
  if (!reviewBotCanSend_(chatId)) return false;
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: budgetAlertText_(budget, categoryDisplayName, progress) });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
}

// The words of a budget alert (also the in-app notice, Notices.gs).
function budgetAlertText_(budget, categoryDisplayName, progress) {
  var periodLabel = tr_(budget.period_type === 'yearly' ? 'bot.thisYear' : budget.period_type === 'weekly' ? 'bot.thisWeek' : 'bot.thisMonth');
  var emoji = progress.percent >= 100 ? '🚨' : '⚠️';
  var spentStr = progress.spent != null ? moneyFmt_(progress.spent) : '?';
  var amountStr = moneyFmt_(budget.amount);
  // The threshold (e.g. 75%) is only what triggered this check, not what
  // to report — by the time it's actually noticed and sent, real spend
  // has usually already moved past it (e.g. 77%), so the message says
  // where things actually stand, not the round number that tripped it.
  var actualPercent = Math.round(progress.percent);
  return tr_('bot.budgetAlert', { emoji: emoji, category: categoryDisplayName, percent: actualPercent, cur: budget.currency,
    amount: amountStr, spent: spentStr, period: periodLabel });
}

// A trip/event budget alert — same contract as sendTelegramBudgetAlert_ (false = not configured, retry later).
// Telegram answers HTTP 200 with ok:false for a blocked bot, a bad chat id, etc. — only a real ok counts as sent, so the
// caller doesn't log the alert as delivered and never retry it.
function sendTelegramTripBudgetAlert_(trip, percent) {
  var chatId = getOwnerTelegramChatId_();
  if (!reviewBotCanSend_(chatId)) return false;
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: tripBudgetAlertText_(trip, percent) });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
}

function tripBudgetAlertText_(trip, percent) {
  return tr_('bot.tripBudgetAlert', {
    emoji: percent >= 100 ? '🚨' : '⚠️', name: tripDisplayName_(trip), percent: Math.round(percent),
    cur: tripCurrency_(trip), amount: moneyFmt_(trip.budget_amount), spent: moneyFmt_(trip.budgetSpent)
  });
}

// Phase 5.6: loan due-date alerts, same bot, same "false means not
// configured yet, try again next cycle" contract as
// sendTelegramBudgetAlert_ above.
function sendTelegramLoanOverdueAlert_(loan, friendName) {
  var chatId = getOwnerTelegramChatId_();
  if (!reviewBotCanSend_(chatId)) return false;
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: loanOverdueAlertText_(loan, friendName) });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
}

function loanOverdueAlertText_(loan, friendName) {
  return tr_(loan.direction === 'they_owe_me' ? 'bot.overdueTheyOwe' : 'bot.overdueIOwe', {
    friend: friendName, cur: loan.currency, amount: moneyFmt_(loan.remaining), date: loan.due_date,
    description: loan.description ? ' ' + loan.description : '' });
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
    // One bad update must not abort the rest of the batch (the offset has
    // already moved past it, so it is simply skipped — same as the webhook).
    try {
      handleTelegramUpdate_(update);
    } catch (err) {
      console.error('Telegram update ' + update.update_id + ' failed: ' + err);
    }
  });
}

// Telegram delivers a webhook "at least once", so a retried update must be a
// no-op — but it must be recognised by its EXACT id. The first version kept
// only the highest id seen and dropped anything at or below it; Apps Script
// runs webhook calls in parallel, so when two replies arrive seconds apart
// and the earlier one is slower (a cold start), the later one raised the
// mark first and the earlier reply was silently thrown away (2026-09-30:
// the first of three quick replies never ran). Now: remember the last 200
// handled ids and skip only those. The lock makes check-and-record atomic.
function isDuplicateTelegramUpdate_(updateId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'TELEGRAM_RECENT_WEBHOOK_UPDATE_IDS';
    var seen = JSON.parse(props.getProperty(key) || '[]');
    if (seen.indexOf(updateId) !== -1) return true;
    seen.push(updateId);
    props.setProperty(key, JSON.stringify(seen.slice(-200)));
    return false;
  } finally {
    lock.releaseLock();
  }
}

function handleTelegramUpdate_(update) {
  // The bot's tour (BotTour.gs) looks at each message from the linked chat: before (its own words) and after (was the step done?).
  var msg = update.message, cb = update.callback_query;
  var chatId = msg ? msg.chat.id : (cb && cb.message ? cb.message.chat.id : null);
  var tour = chatId !== null && isOwnerChat_(chatId) && !(msg && String(msg.text || '').indexOf('/start') === 0);
  if (tour && botTourBefore_(msg ? msg.text : '', { id: msg ? msg.message_id : cb.message.message_id, timestamp: msg ? msg.date : '' }, false, !!(msg && msg.reply_to_message))) {
    botTourAfter_();
    return;
  }
  if (cb) {
    handleTelegramCallback_(cb);
  } else if (msg) {
    handleTelegramMessage_(msg);
  }
  if (tour) botTourAfter_();
}

function handleTelegramCallback_(cb) {
  if (!isOwnerChat_(cb.message.chat.id)) return;

  // A long list action travels as a short code (botCallbackData_, WhatsAppBot.gs); one older than 6 hours is gone.
  var data = botResolveCallback_(cb.data);
  if (!data) {
    telegramApi_('sendMessage', { chat_id: cb.message.chat.id, text: tr_('bot.listExpired'), reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true });
    telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }
  cb.data = data;
  if (/^unr(?:show|send|no):/.test(data)) { unreadTap_(cb); return; }   // a new unreadable bank e-mail: show / send to JP (UnreadNotice.gs)
  // The shared lists (Edit, its pick lists, Repayment / Loan, "Show more"): the same code as WhatsApp's. Once a list is used,
  // its buttons go away (owner, 2026-11-16); Edit tapped on a transaction's own message keeps that message's buttons.
  if (BOT_LIST_ACTIONS_.test(data) && String(cb.message.chat.id) !== WA_CHAT_ID_) {
    var onCard = /^waedit:/.test(data) && !!whatsappCardEntry_(cb.message.message_id);
    botListTap_(data, { id: cb.message.message_id, context_id: cb.message.message_id });
    // Checking a loan changes the list's own buttons in place (RepayIntent.gs): they stay.
    if (!onCard && !/^wart:/.test(data)) removeCardButtons_(cb.message.chat.id, cb.message.message_id);
    telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }

  var parts = String(cb.data).split(':');
  var action = parts[0];
  var entryId = parts[1];
  botTourNote_('touched', entryId);
  // Every tap that changes something is recorded for "deshacer" (BotUndo.gs); a tap that changes nothing records nothing.
  var undoKind = { confirm: 'confirm', discard: 'discard', waitpay: 'waitpay', ptags: 'edit', plink: 'edit', delrep: 'delrep' }[action] || '';
  var recording = undoKind ? botActionBegin_(undoKind, entryId, [cb.message.message_id]) : false;   // Confirm / Discard on the tour's transaction: the tour checks what came of it

  // Once handled, take the buttons off the card so a second tap (easy when
  // the first reply is slow) can't confirm again — and answer a repeat tap
  // on an already-handled entry with a note instead of "Confirmed." again.
  var entry = action === 'confirm' || action === 'discard' || action === 'waitpay' ? getEntryById_(entryId) : null;
  telegramTagAskAfter_ = '';
  var reply = null;
  var replyMarkup = null;   // buttons on the bot's own reply (only the "delete the whole repayment" offer has any)
  var keepButtons = false;
  if (action === 'confirm') {
    if (entry && entry.status === 'confirmed') {
      reply = tr_('bot.alreadyConfirmed');
    } else if (!entry) {
      reply = tr_('bot.entryGone');
    } else if (repayIntentOf_(entry)) {
      // Marked as a repayment waiting for its loans (RepayIntent.gs): Confirm records it paying the oldest first, as the card says.
      try {
        var rec = withScriptLockOnce_(function () { return recordRepayIntent_(getEntryById_(entryId)); });
        reply = tr_(rec.incoming ? 'bot.markedRepaymentFrom' : 'bot.markedRepaymentTo', { friend: rec.friend }) +
          (rec.overpaid > 0.004 ? tr_(rec.incoming ? 'bot.overpaidIn' : 'bot.overpaidOut', { cur: entry.currency, amount: moneyFmt_(rec.overpaid) }) : '');
      } catch (recErr) {
        reply = recErr.message;
        keepButtons = true;
      }
    } else if (entry.type !== 'investment' && !entry.category_id) {
      // Same rule as the app's Confirm: no category, no confirmation. The
      // buttons stay so the owner can reply "category Stocks" and tap again.
      reply = tr_('bot.needCategoryFirst');
      keepButtons = true;
    } else if (entry.type === 'investment' && !entry.to_payment_method_id) {
      // Not confirmed, and the buttons stay on the card (see below) so the
      // owner can set the platform and tap Confirm again.
      reply = tr_('bot.needPlatformFirst');
      keepButtons = true;
    } else {
      var xConfirm = pendingExchangePair_(entry);   // a currency exchange's card is both sides: both are confirmed
      linkSuggestedTripOnTelegramConfirm_(entryId);   // the card said so (trip/event matching its date)
      confirmEntryWithLearning_(entryId);
      if (xConfirm) confirmEntryWithLearning_(xConfirm.out.id === entryId ? xConfirm['in'].id : xConfirm.out.id);
      reply = tr_(xConfirm ? 'bot.exchangeConfirmed' : 'bot.confirmed');
      telegramTagAskAfter_ = entryId;   // asked once the "Confirmed." reply is sent (below)
    }
  } else if (action === 'discard') {
    if (!entry) {
      reply = tr_('bot.entryGone');
    } else if (repaymentPartInfo_(entryId)) {
      // One of a repayment's two entries (its extra, waiting or already confirmed): never deleted on its own, whatever its
      // status. Point to the app, or let the owner choose to delete the WHOLE repayment (both entries) with one more tap.
      // The card keeps its buttons.
      reply = tr_('bot.repaymentPart', { friend: repaymentPartInfo_(entryId).friend });
      replyMarkup = { inline_keyboard: [[{ text: tr_('bot.deleteRepaymentButton'), callback_data: 'delrep:' + entryId }]] };
      keepButtons = true;
    } else if (entry.status === 'confirmed') {
      // Confirmed from the app after this card was sent — a late tap on
      // an old card must never delete a real, confirmed entry.
      reply = tr_('bot.alreadyConfirmedDelete');
    } else {
      try {
        var xDiscard = pendingExchangePair_(entry);   // a currency exchange's card is both sides: both go
        if (recording) botActionSafetyCopy_(xDiscard ? [xDiscard.out.id, xDiscard['in'].id] : [entryId]);   // also in Recently deleted
        discardEntryWithRepayments_(entryId);
        if (xDiscard) discardEntryWithRepayments_(xDiscard.out.id === entryId ? xDiscard['in'].id : xDiscard.out.id);
        reply = tr_(xDiscard ? 'bot.exchangeDiscarded' : 'bot.discarded');
      } catch (err) {
        reply = tr_('bot.notDiscarded', { error: err.message });
      }
    }
  } else if (action === 'waitpay') {
    // Worked out again from today's debts: the card may be old. If it no longer fits, Confirm and Discard stay on the card.
    var waitMatch = entry ? waitingMatchForPending_(entry, listWaitingIncome_()) : null;
    if (!entry) {
      reply = tr_('bot.entryGone');
    } else if (!waitMatch) {
      reply = tr_('bot.waitingGone');
      keepButtons = entry.status === 'pending';
    } else {
      try {
        applyWaitingPayment_(entry, waitMatch);
        reply = tr_('bot.waitingDone', { name: waitMatch.friend_name });
      } catch (err) {
        reply = tr_('bot.waitingFailed', { error: err.message });
        keepButtons = true;
      }
    }
  } else if (action === 'ptags' || action === 'ptagsno') {
    // The answer to "Add its tags?" (owner, 2026-11-16): worked out again from today's data, so an old message adds only what is still
    // missing. Only adds tags.
    if (action === 'ptags') {
      var asks = programmedTagAsk_([entryId]);
      var added = asks.length ? addTagsToEntry_(entryId, asks[0].tag_ids) : [];
      reply = added.length ? tr_('bot.tagsAdded', { tags: telegramTagNames_(added) }) : tr_('bot.tagsNothing');
    } else {
      reply = tr_('bot.tagsNo');
    }
  } else if (action === 'plink' || action === 'plinkno') {
    // The answer to "Is this your Salary for August?": linked only if it still matches today.
    if (action === 'plink') {
      var plan = planMatchFor_(getEntryById_(entryId));
      if (plan) { linkEntryToRecurring({ entryId: entryId, recurringExpenseId: plan.recurring_id, month: plan.month }); reply = tr_('bot.planLinked'); }
      else reply = tr_('bot.planGone');
    } else {
      reply = tr_('bot.planKept');
    }
  } else if (action === 'delrep') {
    // The owner chose to delete the whole repayment: loans part, money entry and extra entry together (deleteRepayment).
    var part = repaymentPartInfo_(entryId);
    if (!part) {
      reply = tr_('bot.repaymentGone');
    } else {
      try {
        deleteRepayment({ id: part.settlementId });
        reply = tr_('bot.repaymentDeleted', { friend: part.friend });
      } catch (err) {
        reply = tr_('bot.notDiscarded', { error: err.message });
      }
    }
  }
  if (reply) {
    var replyPayload = {
      chat_id: cb.message.chat.id, text: reply,
      reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true
    };
    if (replyMarkup) replyPayload.reply_markup = replyMarkup;
    telegramApi_('sendMessage', replyPayload);
    if (!keepButtons) removeCardButtons_(cb.message.chat.id, cb.message.message_id);
  }
  if (telegramTagAskAfter_) { sendTelegramTagAsk_(cb.message.chat.id, telegramTagAskAfter_, cb.message.message_id); sendTelegramPlanAsk_(cb.message.chat.id, telegramTagAskAfter_, cb.message.message_id); }
  telegramTagAskAfter_ = '';
  if (recording) botActionEnd_(undoKind);

  telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
}

// ---- "Add its tags?" after a confirm (owner, 2026-11-16; the app asks the same, specs/recurring.md § Tags) ----
// A confirmed entry that pays a Programmed item with tags it lacks gets one question with two buttons. Nothing is written until
// "Add tags" is tapped; a wrong match (shoes near the gym's due date) is answered No.
var telegramTagAskAfter_ = '';
function telegramTagNames_(ids) {
  var byId = {};
  getAllRows('Tags').forEach(function (t) { byId[String(t.id)] = tagLabel_(t); });
  return ids.map(function (id) { return byId[String(id)]; }).filter(Boolean).join(', ');
}
// ---- "Is this your Salary for August?" after a bot confirm (owner's plan, 2026-11-17; the app asks the same after "+") ----
// Worked out again when the answer comes (planMatchFor_), so an old message never links something that changed.
function botMonthLabel_(ym) {
  var names = tr_('bot.monthNames').split(',');
  return (names[Number(String(ym).substring(5, 7)) - 1] || ym) + ' ' + String(ym).substring(0, 4);
}
function sendTelegramPlanAsk_(chatId, entryId, replyTo) {
  var entry, plan;
  try { entry = getEntryById_(entryId); plan = planMatchFor_(entry); } catch (e) { return; }   // only a question: never fails the confirm
  if (!plan) return;
  telegramApi_('sendMessage', {
    chat_id: chatId,
    text: tr_('bot.planAsk', { entry: entry.description || '', name: plan.description, month: botMonthLabel_(plan.month) }),
    reply_to_message_id: replyTo, allow_sending_without_reply: true,
    reply_markup: { inline_keyboard: [[
      { text: tr_('bot.planYes'), callback_data: 'plink:' + entryId },
      { text: tr_('bot.planNo'), callback_data: 'plinkno:' + entryId }
    ]] }
  });
}
function sendTelegramTagAsk_(chatId, entryId, replyTo) {
  var ask;
  try { ask = programmedTagAsk_([entryId])[0]; } catch (e) { return; }   // only a question: never fails the confirm
  if (!ask) return;
  var tags = telegramTagNames_(ask.tag_ids);
  if (!tags) return;
  telegramApi_('sendMessage', {
    chat_id: chatId,
    text: tr_('bot.tagAsk', { entry: ask.description || ask.item, item: ask.item, tags: tags }),
    reply_to_message_id: replyTo, allow_sending_without_reply: true,
    reply_markup: { inline_keyboard: [[
      { text: tr_('bot.tagAskYes'), callback_data: 'ptags:' + entryId },
      { text: tr_('bot.tagAskNo'), callback_data: 'ptagsno:' + entryId }
    ]] }
  });
}

function handleTelegramMessage_(msg) {
  var text = (msg.text || '').trim();

  if (text.indexOf('/start') === 0) {
    var code = text.replace('/start', '').trim();
    var alreadyLinked = getOwnerTelegramChatId_();
    // Same lockout as signing in (10 wrong codes -> 10 minutes), shared.
    var startLock = loginLockState_();
    if (startLock.locked) {
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: lockMessage_(startLock),
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
      return;
    }
    if (isValidAccessCode(code) && alreadyLinked && !isOwnerChat_(msg.chat.id)) {
      clearLoginFailures_();
      // Someone who knows (or guessed) the code must not be able to silently
      // redirect every review card to their own chat. Moving the bot to a new
      // chat is deliberate: re-run "Set Telegram bot token" in the sheet menu,
      // which unlinks the old chat first.
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: tr_('bot.alreadyLinked'),
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
    } else if (!isValidAccessCode(code)) {
      noteLoginFailure_();
      recordFailedAccessAttempt_('telegram');
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: tr_('bot.codeNotRecognized'),
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
    } else {
      clearLoginFailures_();
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(msg.chat.id));
      telegramApi_('sendMessage', {
        chat_id: msg.chat.id, text: tr_('bot.linked'),
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true
      });
    }
    return;
  }

  if (!isOwnerChat_(msg.chat.id)) return;

  // A receipt image (Plin from WhatsApp, a Yape screen) becomes a new
  // pending entry — see PhotoCapture.gs.
  if (photoFileIdFromMessage_(msg)) {
    handleTelegramPhoto_(msg);
    return;
  }

  // "deshacer" / "undo" on its own (BotUndo.gs): about the message replied to, else the bot's last message. It closes an open
  // "send the new …" question first. WhatsApp checks it in its own door.
  if (String(msg.chat.id) !== WA_CHAT_ID_ && botUndoWord_(text)) {
    whatsappClearAwaiting_();
    botUndoMessage_(msg.reply_to_message ? msg.reply_to_message.message_id : String(PropertiesService.getScriptProperties().getProperty('TG_LAST_OUT') || ''), msg.message_id);
    return;
  }
  if (String(msg.chat.id) !== WA_CHAT_ID_ && botDeleteWord_(text)) {
    whatsappClearAwaiting_();
    botDeleteMessage_(msg.reply_to_message ? msg.reply_to_message.message_id : String(PropertiesService.getScriptProperties().getProperty('TG_LAST_OUT') || ''), msg.message_id);
    return;
  }

  // The same commands as WhatsApp (ayuda / pendientes / nuevo) and the answer to an open "send the new …" question
  // (WhatsAppBot.gs). Only for a real Telegram message, not a reply (WhatsApp's own messages come here as replies or commands).
  if (!msg.reply_to_message && String(msg.chat.id) !== WA_CHAT_ID_ && text && telegramSharedCommand_(msg, text)) return;
  // "ok", "gracias"… on their own, plain or as a reply: never a transaction's new text (BotTour.gs; WhatsApp checks it in its own door).
  if (String(msg.chat.id) !== WA_CHAT_ID_ && botFillerWord_(text)) {
    telegramApi_('sendMessage', { chat_id: msg.chat.id, text: tr_('bot.fillerHint'), reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
    return;
  }

  // A new transaction typed in one message (TypedEntry.gs, the same building block as WhatsApp; owner, 2026-11-16): not a reply,
  // and it starts with an amount or is a pasted bank notice ("25 almuerzo, account Interbank"). Before, such a text became the
  // last card's description.
  if (!msg.reply_to_message && !startsWithEditKeyword_(text) && typedIsNewEntry_(text)) {
    telegramNewTypedEntry_(msg, text);
    return;
  }

  // Not a reply to anything: assume it is about the last notification, if
  // that was an entry card still pending approval. Otherwise (an alert, a
  // confirmed/removed entry, nothing yet) ask for a direct reply.
  var targetMessageId;
  if (msg.reply_to_message) targetMessageId = msg.reply_to_message.message_id;
  else if (String(msg.chat.id) === WA_CHAT_ID_) targetMessageId = lastPendingCardMessageId_();   // WhatsApp chose its target already
  else {
    // The same rule as WhatsApp (owner, 2026-11-16): the transaction of the bot's last message, waiting or confirmed. When that
    // message was not about a transaction (an alert, the help): an edit word goes to the last waiting transaction, as before;
    // plain words are read as a new purchase, and with no amount the bot says how to write one.
    var lastTg = telegramLastTarget_();
    var isCommand = startsWithEditKeyword_(text) || /^\/?(?:help|ayuda)$/i.test(text) ||
      /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)\b|^(?:(?:convert\s+to|convertir\s+en)\s+)?(?:loan|pr[eé]stamo)\b/i.test(text);
    if (lastTg) targetMessageId = lastTg;
    else if (isCommand) targetMessageId = lastPendingCardMessageId_();
    else {
      telegramApi_('sendMessage', { chat_id: msg.chat.id, text: tr_('whatsapp.unreadable'), reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
      return;
    }
  }
  if (!targetMessageId) {
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id, text: tr_('bot.replyToACard'),
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
    return;
  }

  var mapping = getAllRows('Telegram Messages')
    .find(function (m) { return String(m.message_id) === String(targetMessageId); });

  if (!mapping) {
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id, text: tr_('bot.tooOld'),
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
    return;
  }

  // "help" or "/help" (Telegram clients often auto-format a leading slash) —
  // sends the full syntax + examples for this entry's type, kept off the
  // card itself. Checked before the edit parser so it can't also be read as
  // a (failing) field-edit segment.
  if (/^\/?(?:help|ayuda)$/i.test(text)) {
    noteReplyHintStuck_();
    var helpEntry = getEntryById_(mapping.entry_id);
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id,
      text: helpEntry ? telegramEditHelpText_(helpEntry) : tr_('bot.tooOld'),
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
    return;
  }

  // Checked before the normal field-edit parser — "repayment"/"loan"
  // reroute the WHOLE entry to the Loans tab instead of editing a field
  // on it (see applyTerminalReviewAction_, below), so they don't try to
  // combine with other edits the way "category X, amount Y" does.
  // With no name ("repayment") the friend is the group of the trip whose dates cover the entry, when there is
  // exactly one such trip (applyTerminalReviewAction_).
  // A comma may follow the word ("repayment, paid by Ana"): it is still the command (RepayIntent.gs § the words after "repayment").
  var terminalMatch = text.match(/^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)(?:[\s,]+(.+))?$/i) ||
    text.match(/^(?:(?:convert\s+to|convertir\s+en)\s+)?(?:loan|pr[eé]stamo)(?:[\s,]+(.+))?$/i);
  var undoKind = !terminalMatch ? 'edit' : /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)/i.test(text) ? 'repayment' : 'loan';
  var recording = botActionBegin_(undoKind, mapping.entry_id, [msg.message_id, targetMessageId]);   // for "deshacer" (BotUndo.gs)
  var result = terminalMatch
    ? applyDebtWords_(mapping.entry_id, text, terminalMatch[1] || '')
    : applyEditCommand_(mapping.entry_id, text);

  // Threads to the owner's own edit command, which is itself already a
  // reply to the transaction card — keeps a clear chain (card -> edit
  // command -> "Updated X.") instead of a loose message at the bottom of
  // the chat with no visible connection to what it's about.
  if (result.message) {
    telegramApi_('sendMessage', {
      chat_id: msg.chat.id, text: result.message,
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true
    });
  }

  // A terminal action already removed the entry — nothing left to show a
  // refreshed card for.
  if (result.entry && !result.removed) {
    var freshCard = sendTelegramEntryNotification_(result.entry, result.categoryName);
    // Kept waiting for its loans (RepayIntent.gs): the loans to tap, under the fresh card.
    if (result.repayList) botRepayLoanList_(result.entry.id, freshCard && freshCard.ok && freshCard.result ? freshCard.result.message_id : null);
  }
  if (telegramTagAskAfter_ && result.entry && !result.removed) { sendTelegramTagAsk_(msg.chat.id, telegramTagAskAfter_, msg.message_id); sendTelegramPlanAsk_(msg.chat.id, telegramTagAskAfter_, msg.message_id); }
  telegramTagAskAfter_ = '';

  // The card that was replied to is now superseded (by the refreshed card,
  // or by the entry being removed) — take its buttons off so it can't be
  // confirmed/discarded by mistake. A command that wasn't understood leaves
  // it untouched, since that card is still the live one.
  if ((result.entry && !result.removed) || result.removed) {
    removeCardButtons_(msg.chat.id, targetMessageId);
  }
  if (recording) botActionEnd_(undoKind);
}

// The same steps as WhatsApp's whatsappNewPurchase_: the shared block, then the card with its buttons, the engine's note, and the
// tag question when the keywords confirmed it.
function telegramNewTypedEntry_(msg, text) {
  telegramTagAskAfter_ = '';
  var r = newTypedEntry_({ id: 'tg:' + msg.chat.id + ':' + msg.message_id, text: text, timestamp: msg.date }, 'telegram');
  if (!r.saved || !r.entry) {
    telegramTagAskAfter_ = '';
    telegramApi_('sendMessage', { chat_id: msg.chat.id, text: r.reply, reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
    return;
  }
  var card = sendTelegramEntryNotification_(r.entry, r.categoryName);
  botTourNote_('newEntry', r.entry.id);
  var cardId = card && card.ok && card.result ? card.result.message_id : null;
  if (r.editMessage) {
    telegramApi_('sendMessage', { chat_id: msg.chat.id, text: r.editMessage, reply_to_message_id: cardId || msg.message_id, allow_sending_without_reply: true });
  }
  if (telegramTagAskAfter_) { sendTelegramTagAsk_(msg.chat.id, telegramTagAskAfter_, cardId || msg.message_id); sendTelegramPlanAsk_(msg.chat.id, telegramTagAskAfter_, cardId || msg.message_id); }
  telegramTagAskAfter_ = '';
}

function removeCardButtons_(chatId, messageId) {
  telegramApi_('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] }
  });
}

// "repayment Ana" / "mark as repayment Ana" or "loan Ana" / "convert
// to loan Ana" — the Telegram equivalent of the review queue's own
// "💰 Mark as repayment" / "🤝 Convert to loan" (see CLAUDE.md's Review
// queue section). The direction follows the pending entry's type, so
// there's never a picker:
// - a pending EXPENSE is money the owner sent OUT: repayment = paying down
//   what the owner owed ('i_owe_them'), loan = the owner lending it
//   ('they_owe_me');
// - a pending INCOME is money that CAME IN (e.g. a "Te Yapearon" photo):
//   repayment = the friend paying back what they owed ('they_owe_me'),
//   loan = the friend lending it to the owner ('i_owe_them').
// Reuses the exact same backend calls the app's buttons make.
// friendObj (optional): the friend already chosen from a list (WhatsApp's Repayment / Loan buttons), so no name is looked up.
function applyTerminalReviewAction_(entryId, fullText, friendText, friendObj) {
  var entry = getEntryById_(entryId);
  if (!entry) return { message: tr_('bot.entryNotFound') };

  // Which way the money moved, and through which of the owner's accounts.
  // An expense went out, an income came in. A transfer is read from its ends:
  // only a "to" account = money came in (e.g. a Yape from a friend); only a
  // "from" account = money went out. Both ends set = really between the
  // owner's own accounts.
  var way = repayMoneyWay_(entry);   // RepayIntent.gs
  if (way.error) return { message: way.error };
  var incoming = way.incoming, accountId = way.accountId;

  var friend = friendObj || null;
  if (friend) {
    // chosen from a list: nothing to look up
  } else if (!String(friendText || '').trim()) {
    // No name given: during a trip, that trip's group (one trip covering the date, never a guess between two).
    var tripId = suggestedTripIdForDate_(entry.date);
    friend = tripId ? tripGroupFriend_(tripId) : null;
    if (!friend) return { message: tr_('bot.needFriend') };
  } else {
    friend = fuzzyFindFriend_(String(friendText).trim());
    if (!friend) {
      return { message: tr_('bot.unknownFriend', { name: String(friendText).trim() }) };
    }
  }

  var isRepayment = /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)/i.test(fullText.trim());

  // A real choice of loans (two or more open, the payment does not cover them all): nothing is recorded yet. The entry waits in
  // Needs review, marked, so the person chooses the loans (owner, 2026-11-23; RepayIntent.gs). A confirmed one goes back to waiting.
  // Money you paid, marked as a repayment to someone who owes YOU and whom you owe nothing: the wrong way round ("Elmer paid me 37"
  // read as an expense, testers 2.68.2). Refused, saying how to turn it around; nothing changes.
  if (isRepayment && !incoming && !repayChoiceInfo_(entry, friend.id, 'i_owe_them').owed &&
      repayChoiceInfo_(entry, friend.id, 'they_owe_me').owed) {
    return { message: tr_('bot.repayWrongWay', { friend: friend.name }) };
  }

  if (isRepayment) {
    var repayDir = incoming ? 'they_owe_me' : 'i_owe_them';
    var choice = repayChoiceInfo_(entry, friend.id, repayDir);
    if (choice.matters) {
      try {
        withScriptLockOnce_(function () { markRepayIntent_(getEntryById_(entry.id), friend.id, repayDir); });
      } catch (markErr) {
        return { message: tr_('convert.nothingChanged', { error: markErr.message }) };
      }
      return { message: tr_('bot.repayKept', { friend: friend.name, n: choice.count }), entry: getEntryById_(entry.id), categoryName: null, repayList: true };
    }
  }

  // The same swap the app makes (convertEntryInto_, Loans.gs): it works on a
  // pending OR a confirmed entry, checks everything first, and puts the
  // original back if anything fails. An extra beyond what was owed waits in the
  // review queue; money coming in with nothing owed is refused and left as it is.
  var result;
  try {
    result = withScriptLockOnce_(function () {
      return convertEntryInto_({
        entry_id: entry.id,
        friend_id: friend.id,
        direction: isRepayment ? (incoming ? 'they_owe_me' : 'i_owe_them') : (incoming ? 'i_owe_them' : 'they_owe_me'),
        amount: Number(entry.amount),
        currency: entry.currency,
        date: entry.date,
        payment_method_id: accountId,
        description: isRepayment ? undefined : (entry.description || ''),
        overpay_pending_ok: true,
        require_owed: isRepayment && incoming
      }, isRepayment ? 'repayment' : 'loan');
    });
  } catch (err) {
    return { message: err.message };   // already says nothing was changed (convertEntryInto_)
  }

  if (isRepayment) {
    var msg = tr_(incoming ? 'bot.markedRepaymentFrom' : 'bot.markedRepaymentTo', { friend: friend.name });
    if (result.overpaid > 0.004) {
      msg += tr_(incoming ? 'bot.overpaidIn' : 'bot.overpaidOut', { cur: entry.currency, amount: moneyFmt_(result.overpaid) });
    }
    return { message: msg, removed: true };
  }
  return {
    message: incoming
      ? tr_('bot.loanIOwe', { friend: friend.name, cur: entry.currency, amount: moneyFmt_(entry.amount) })
      : tr_('bot.loanTheyOwe', { friend: friend.name, cur: entry.currency, amount: moneyFmt_(entry.amount) }),
    removed: true
  };
}

function isOwnerChat_(chatId) {
  var ownerChatId = getOwnerTelegramChatId_();
  return !!ownerChatId && String(chatId) === String(ownerChatId);
}

// ---- Command parser (keyword-based, no AI — see file header) ----

// The type word in a "type ..." reply, in English (what is stored): "gasto" ->
// "expense", "inversión" -> "investment", and so on.
function entryTypeFromWord_(word) {
  var w = String(word || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  w = w.replace(/^(inversion)es$/, '$1').replace(/s$/, '');   // plurals: "investments", "gastos", "inversiones"
  var map = { gasto: 'expense', ingreso: 'income', transferencia: 'transfer', inversion: 'investment' };
  return map[w] || w;
}

// A typed amount ("45.50", "1,234.50", "45,50", "1.234,50"). Dots and commas
// follow the same rule as the app's amount box: when both appear the LAST one is
// the decimal point; a comma alone is a thousands separator only in the usual
// grouping (1,234 / 1,234,567) and a decimal comma otherwise (45,50 -> 45.50).
// NaN when it can't be read.
function parseTypedAmount_(raw) {
  var s = String(raw == null ? '' : raw).replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s)) return NaN;
  var lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    return lastComma > lastDot
      ? parseFloat(s.replace(/\./g, '').replace(',', '.'))
      : parseFloat(s.replace(/,/g, ''));
  }
  if (lastComma !== -1) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) return parseFloat(s.replace(/,/g, ''));
    if (s.indexOf(',') !== lastComma) return NaN;   // 1,2,3 — not a number
    return parseFloat(s.replace(',', '.'));
  }
  return parseFloat(s);
}

var EDIT_COMMAND_PATTERNS = [
  { field: 'category', re: /^(?:category|categor[ií]a)\s+(.+)/i },
  { field: 'amount', re: /^(?:amount|monto)\s+([\d.,]+)/i },
  { field: 'description', re: /^(?:description|descripci[oó]n)\s+(.+)/i },
  { field: 'paid by', re: /^(?:paid\s*by|pagado\s*por)\s+(.+)/i },
  // The code must be a whole word: "moneda extranjera" must not read as EXT.
  { field: 'currency', re: /^(?:currency|moneda)\s+([a-zA-Z]{3})(?![a-zA-Z])/i },
  { field: 'date', re: /^(?:date|fecha)\s+(.+)/i },
  // Added 2026-09-17 alongside full text-command parity with the app's
  // own Split UI — see parseSplitCommand_, below, for the three forms
  // this accepts ("equal ...", "Name amount, Name amount", "none").
  { field: 'split', re: /^(?:split|repartir|dividir)\s+(.+)/i },
  // Payment method and label(s) — same parity goal, requested directly:
  // whatever the app's own entry-editing pop-up can change, a Telegram
  // reply should be able to change too. The word is "account" / "cuenta" (owner,
  // 2026-10-21: one name for it everywhere); "payment method" / "medio de pago" are
  // still accepted so old habits keep working.
  { field: 'payment method', re: /^(?:account|cuenta|payment\s*method|medio\s*de\s*pago)\s+(.+)/i },
  // Transfers only (see applyOneEditSegment_): the two ends of the move.
  { field: 'from', re: /^(?:from|desde)\s+(.+)/i },
  { field: 'to', re: /^(?:to|hasta|hacia)\s+(.+)/i },
  // Withdrawals only: same as "to", worded the way it reads for money coming back.
  { field: 'received at', re: /^(?:received\s*(?:at|in)|recibido\s*en)\s+(.+)/i },
  { field: 'label', re: /^(?:labels?|tags?|etiquetas?)\s+(.+)/i },
  // Trips & events (expenses only): "trip Cusco" links the expense, "trip none" unlinks it.
  { field: 'trip', re: /^(?:trip|event|viaje|evento)\s+(.+)/i },
  // Reclassifies the whole entry — e.g. a self-transfer between the
  // owner's own accounts that the email parser couldn't confirm as one
  // (isOwnAccount_ in EmailParser.gs only recognizes the owner's own full
  // name, not every account nickname) and so landed as a plain pending
  // expense instead. See applyOneEditSegment_'s 'type' branch for the
  // cleanup this does on the way in/out of 'transfer'. Send "type
  // transfer" before "from"/"to" in the same reply — those two only
  // apply to an entry that's already a transfer by the time they run.
  // Investments only (see applyOneEditSegment_): which platform the money went to.
  { field: 'platform', re: /^(?:platform|plataforma)\s+(.+)/i },
  // Investments only: which way the money moved. A withdrawal is stored as
  // a NEGATIVE amount (see Investments.gs), a deposit as a positive one.
  { field: 'direction', re: /^(withdrawal|deposit|retiro|dep[oó]sito)(?![\wáéíóúñ])/i },
  // A plural is understood too ("type investments", owner 2026-11-20: it was answered "Didn't recognize that").
  { field: 'type', re: /^(?:type|tipo)\s+(expenses?|incomes?|transfers?|investments?|gastos?|ingresos?|transferencias?|inversi[oó]n(?:es)?)(?![\wáéíóúñ])/i }
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
var EDIT_FIELD_KEYWORDS_RE = '(?:(?:category|categor[ií]a|amount|monto|description|descripci[oó]n|paid\\s*by|pagado\\s*por|currency|moneda|date|fecha|split|repartir|dividir|account|cuenta|payment\\s*method|medio\\s*de\\s*pago|labels?|tags?|etiquetas?|trip|event|viaje|evento|from|desde|to|hasta|hacia|received\\s*(?:at|in)|recibido\\s*en|platform|plataforma|type|tipo)\\s+|(?:withdrawal|deposit|retiro|dep[oó]sito)(?![\\wáéíóúñ]))';

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

// What's missing before an entry may be confirmed (same rules as the Confirm
// button), or null if nothing is.
function telegramConfirmBlocker_(entry) {
  if (entry.type === 'investment') {
    return entry.to_payment_method_id ? null : tr_('bot.blockerPlatform');
  }
  return entry.category_id ? null : tr_('bot.blockerCategory');
}

// Runs after a reply's edits were applied (2026-10-02, owner's request):
// - a PENDING entry is confirmed by its first successful reply — unless some
//   part of the reply couldn't be applied, or the entry still lacks what
//   Confirm requires; then it stays pending, buttons and all;
// - a CONFIRMED entry stays editable by reply. A confirmed expense's
//   loans are rebuilt from its (possibly changed) paid by / amount / split
//   (same as the app does when a confirmed entry is edited), and if an edit
//   (e.g. "type income") left it without a category/platform it goes back to
//   pending rather than staying confirmed in an invalid state.
// Returns a short note for the reply, or ''.
function finishTelegramEdit_(entryId, statusBefore, allApplied) {
  var entry = getEntryById_(entryId);
  if (!entry) return '';
  if (statusBefore === 'pending') {
    // WhatsApp's Edit taps only save (owner, 2026-11-16): the person finishes with Confirm. Replies in words still confirm.
    if (WA_SAVE_ONLY_) return '';
    var blocker = telegramConfirmBlocker_(entry);
    if (!allApplied) return tr_('bot.notConfirmedPartial');
    if (blocker) return tr_('bot.notConfirmedBlocker', { blocker: blocker });
    var xFinish = pendingExchangePair_(entry);   // one message for a currency exchange: its other side is confirmed with it
    linkSuggestedTripOnTelegramConfirm_(entryId);
    confirmEntryWithLearning_(entryId);
    if (xFinish) confirmEntryWithLearning_(xFinish.out.id === entryId ? xFinish['in'].id : xFinish.out.id);
    telegramTagAskAfter_ = entryId;   // asked after the refreshed card (handleTelegramMessage_)
    return ''; // the refreshed card says "✅ Confirmed" itself
  }
  if (statusBefore === 'confirmed') {
    var blocker2 = telegramConfirmBlocker_(entry);
    if (blocker2) {
      setEntryField_(entryId, 'status', 'pending');
      return tr_('bot.backToPending', { blocker: blocker2 });
    }
    if (entry.type === 'expense') {
      var current = getEntrySplits(entryId).map(function (sp) {
        return { friend_id: sp.friend_id, amount: Number(sp.amount) };
      });
      saveEntrySplits(entryId, current);
    } else {
      deleteEntrySplitsAndLoansForEntry_(entryId);
    }
  }
  return '';
}

// True when the text begins with one of the reply field keywords (a lone
// keyword counts too, so "split" alone stays "not understood").
function startsWithEditKeyword_(text) {
  return new RegExp('^' + EDIT_FIELD_KEYWORDS_RE, 'i').test(String(text).trim() + ' ');
}

// The Telegram edit fields that change what a loan and its money entry share (see syncLoanBeforeEntryEdit_).
var LOAN_SHARED_EDIT_FIELDS_ = ['amount', 'description', 'date', 'currency', 'payment method', 'from'];

// After a Telegram edit of an entry that is a loan's money movement: hand the entry's new date / amount / currency / account /
// description to the loan (through updateLoan, so its own rules apply). Returns '' when nothing was needed or the loan accepted,
// or the bot's refusal text — in which case those five fields of the entry have been put back to what they were.
function syncLoanAfterTelegramEdit_(entryId, before) {
  var now = getEntryById_(entryId);
  if (!now || !before) return '';
  var keys = ['date', 'amount', 'currency', 'payment_method_id', 'description'];
  var changed = keys.some(function (k) { return String(now[k] === undefined ? '' : now[k]) !== String(before[k] === undefined ? '' : before[k]); });
  if (!changed) return '';
  var fields = {};
  keys.forEach(function (k) { fields[k] = now[k]; });
  try {
    syncLoanBeforeEntryEdit_(entryId, fields);   // no-op unless this entry is a loan's money movement
    return '';
  } catch (err) {
    keys.forEach(function (k) { setEntryField_(entryId, k, before[k] === undefined ? '' : before[k]); });
    return tr_('bot.loanRefused', { error: err.message });
  }
}

// After a Telegram edit of one of a repayment's two entries (its money movement or its extra), the SAME rules as in the app
// (`guardRepaymentEntryEdit_` / `syncRepaymentAfterEntryEdit_`, Loans.gs): a new date or account carries over to the other entry
// and to the repayment's rows, so they stay one transfer on the same day from the same account; a new AMOUNT is refused — it is
// changed in the repayment's editor in the app, where the loans and the extra are split — and the entry's amount is put back.
// Returns '' or the bot's refusal text.
function syncRepaymentAfterTelegramEdit_(entryId, before) {
  var link = repaymentOfEntry_(entryId);
  var now = getEntryById_(entryId);
  if (!link || !now || !before) return '';
  if (String(now.currency) !== String(before.currency)) {   // another currency is another debt: re-recorded in the app only
    setEntryField_(entryId, 'currency', before.currency);
    return tr_('bot.repaymentRefused', { reason: tr_('repay.editCurrencyRerecord') });
  }
  if (Math.abs(Number(now.amount) - Number(before.amount)) > 0.004) {
    setEntryField_(entryId, 'amount', before.amount);
    return tr_('bot.repaymentRefused', { reason: tr_(link.kind === 'transfer' ? 'repay.editAmountInHistory' : 'repay.editExtraInHistory') });
  }
  var change = {};
  if (String(now.date) !== String(before.date)) change.date = now.date;
  if (String(now.payment_method_id || '') !== String(before.payment_method_id || '')) change.payment_method_id = now.payment_method_id || '';
  if (Object.keys(change).length) syncRepaymentAfterEntryEdit_(entryId, change);
  return '';
}

// A forgiveness entry's amount and currency are not editable (forgivenessEditBlock_): put back, with the reason.
function syncForgivenessAfterTelegramEdit_(entryId, before) {
  var now = getEntryById_(entryId);
  if (!now || !before || !forgivenessOfEntry_(entryId)) return '';
  var amountChanged = Math.abs(Number(now.amount) - Number(before.amount)) > 0.004;
  var currencyChanged = String(now.currency) !== String(before.currency);
  if (!amountChanged && !currencyChanged) return '';
  if (amountChanged) setEntryField_(entryId, 'amount', before.amount);
  if (currencyChanged) setEntryField_(entryId, 'currency', before.currency);
  return tr_('bot.repaymentRefused', { reason: tr_('forgive.entryLocked') });
}

function applyEditCommand_(entryId, text) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return { message: tr_('bot.entryNotFound') };

  var appliedFields = [];
  var failedSegments = [];
  var entryBefore = getEntryById_(entryId) || {};
  var statusBefore = entryBefore.status;

  // No field keyword at the start ("Uber to the airport"): the person meant
  // the description, so say it for them. A message that DOES start with a
  // keyword is untouched, so a typo in its value is still reported.
  if (!startsWithEditKeyword_(text)) text = 'description ' + String(text).trim();

  withWriteBatch_(function () {
    var previousField = null;
    // A split is applied last: "split group" needs the trip a "trip …" in the same reply sets, in whatever order it was written.
    var segments = splitEditCommands_(text);
    var isSplit = function (s) { return /^(?:split|repartir|dividir)\s/i.test(String(s).trim()); };
    segments = segments.filter(function (s) { return !isSplit(s); }).concat(segments.filter(isSplit));
    segments.forEach(function (segment) {
      var field = applyOneEditSegment_(sheet, headers, rowIndex, entryId, segment);
      if (field) {
        appliedFields.push(field);
        previousField = field;
      } else if (previousField === 'description' && FORMAT_KEYWORD_RE_.test(segment)) {
        // "description Dinner, date of my birthday": a date / currency / amount
        // keyword whose value is not one is almost surely part of the description
        // the person was writing, so keep the text instead of losing it.
        var current = getEntryById_(entryId);
        setCellByRow_(sheet, headers, rowIndex, 'description', String(current.description || '') + ', ' + segment);
      } else {
        failedSegments.push(segment);
        previousField = null;
      }
    });
  });

  // Same text as the "help" reply, so the two never drift apart.
  var helpText = telegramEditHelpText_(getEntryById_(entryId));

  // A loan's money entry and the loan are ONE thing: what was just typed (date, amount, currency, account, description)
  // goes to the loan too. If the loan refuses (e.g. an amount below what is already repaid) the entry is put back and the
  // owner is told, so the two never disagree.
  var loanRefusal = syncLoanAfterTelegramEdit_(entryId, entryBefore);
  if (loanRefusal) appliedFields = appliedFields.filter(function (f) { return LOAN_SHARED_EDIT_FIELDS_.indexOf(f) === -1; });
  // Same for a repayment's two entries: date / account follow, an amount change is refused (see syncRepaymentAfterTelegramEdit_).
  var repaymentRefusal = loanRefusal ? '' : syncRepaymentAfterTelegramEdit_(entryId, entryBefore);
  if (repaymentRefusal) appliedFields = appliedFields.filter(function (f) { return f !== 'amount'; });
  var forgivenessRefusal = syncForgivenessAfterTelegramEdit_(entryId, entryBefore);
  if (forgivenessRefusal) appliedFields = appliedFields.filter(function (f) { return f !== 'amount' && f !== 'currency'; });
  loanRefusal = loanRefusal || repaymentRefusal || forgivenessRefusal;   // one note, whichever record said no
  if (loanRefusal && !appliedFields.length) {
    return { message: loanRefusal, entry: getEntryById_(entryId), categoryName: null };
  }

  if (!appliedFields.length) {
    noteReplyHintStuck_();
    return { message: tr_('bot.notRecognized') + '\n\n' + helpText, failed: true };
  }
  if (failedSegments.length) noteReplyHintStuck_();
  else noteReplyHintEdit_();

  var messageParts = [tr_('bot.updated', { fields: appliedFields.map(function (f) { return tr_('bot.field.' + String(f).replace(/ /g, '_')); }).join(', ') })];
  var statusNote = finishTelegramEdit_(entryId, statusBefore, !failedSegments.length);
  if (statusNote) messageParts.push(statusNote);
  if (loanRefusal) messageParts.push(loanRefusal);
  if (failedSegments.length) {
    messageParts.push(tr_('bot.couldntApply', { list: failedSegments.map(function (s) { return '"' + s + '"'; }).join(', ') }) + '\n\n' + helpText);
  }

  var updated = getEntryById_(entryId);
  var categoryName = null;
  if (updated.category_id) {
    var found = getAllRows('Categories').find(function (c) { return c.id === updated.category_id; });
    categoryName = found ? categoryLabel_(found) : null;
  }

  // Everything applied and nothing to warn about: the refreshed card that
  // follows shows the result, so a separate "Updated X." bubble is noise.
  var quiet = !failedSegments.length && !statusNote && !loanRefusal;
  return { message: quiet ? '' : messageParts.join(' '), entry: updated, categoryName: categoryName, failed: failedSegments.length > 0 };
}

// Keywords whose value must have a strict shape. Only these are folded back into
// a description when the value is not valid (a typo in "category Gorceries" must
// still be reported, not silently turned into description text).
var FORMAT_KEYWORD_RE_ = /^(?:date|fecha|currency|moneda|amount|monto)(?![a-záéíóúñ])/i;

// The currencies the app's picker offers (docs/app.js CURRENCIES), plus any
// already in the exchange-rate table.
var KNOWN_CURRENCY_CODES_ = ['PEN', 'USD', 'EUR', 'ARS', 'MXN', 'BRL', 'CLP', 'COP', 'BOB', 'UYU', 'PYG', 'VES', 'GTQ', 'CRC', 'PAB', 'DOP', 'HNL', 'NIO', 'CUP', 'GBP', 'CAD', 'CHF', 'JPY', 'CNY', 'KRW', 'INR', 'AUD', 'NZD', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'ZAR', 'AED', 'THB', 'RUB', 'ILS', 'AFN', 'ALL', 'DZD', 'AOA', 'AMD', 'AWG', 'AZN', 'BSD', 'BHD', 'BDT', 'BBD', 'BYN', 'BZD', 'BMD', 'BTN', 'BAM', 'BWP', 'BND', 'BIF', 'KHR', 'CVE', 'KYD', 'XAF', 'KMF', 'CDF', 'XCG', 'CZK', 'DJF', 'XCD', 'EGP', 'SVC', 'ERN', 'SZL', 'ETB', 'FKP', 'FJD', 'XPF', 'GMD', 'GEL', 'GHS', 'GIP', 'GNF', 'GYD', 'HTG', 'HUF', 'ISK', 'IDR', 'IRR', 'IQD', 'JMD', 'JOD', 'KZT', 'KES', 'KWD', 'KGS', 'LAK', 'LBP', 'LSL', 'LRD', 'LYD', 'MOP', 'MGA', 'MWK', 'MYR', 'MVR', 'MRU', 'MUR', 'MDL', 'MNT', 'MAD', 'MZN', 'MMK', 'NAD', 'NPR', 'NGN', 'KPW', 'MKD', 'OMR', 'PKR', 'PGK', 'PHP', 'QAR', 'RON', 'RWF', 'SHP', 'WST', 'STN', 'SAR', 'RSD', 'SCR', 'SLE', 'SBD', 'SOS', 'SSP', 'LKR', 'SDG', 'SRD', 'SYP', 'TWD', 'TJS', 'TZS', 'TOP', 'TTD', 'TND', 'TMT', 'UGX', 'UAH', 'UZS', 'VUV', 'VND', 'XOF', 'YER', 'ZMW', 'ZWG'];

function isKnownCurrencyCode_(code) {
  if (KNOWN_CURRENCY_CODES_.indexOf(code) >= 0) return true;
  return getAllRows('Exchange Rates').some(function (r) { return String(r.currency).toUpperCase() === code; });
}

// The order the person writes numeric dates in: the Settings row `date_format`
// ('ymd' | 'dmy' | 'mdy', set by the onboarding once it exists), otherwise the one
// that goes with the active language (Spanish day/month/year, English month/day/year).
function userDateOrder_() {
  var saved = '';
  try { saved = String(getSettingsMap().date_format || '').toLowerCase(); } catch (err) { /* sheet unreadable */ }
  if (saved === 'ymd' || saved === 'dmy' || saved === 'mdy') return saved;
  return currentLang_() === 'es' ? 'dmy' : 'mdy';
}

// A typed date as 'YYYY-MM-DD', or '' when it is not a real calendar day. Year
// first (2026-09-12, 2026/09/12) is always understood; otherwise the person's own
// order (see userDateOrder_), with / - or . between the parts and a 2- or 4-digit year.
function parseTypedDate_(text) {
  var t = String(text).trim();
  var y, mo, d, m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m) { y = m[1]; mo = m[2]; d = m[3]; }
  else {
    m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})$/);
    if (!m) return '';
    y = m[3].length === 2 ? '20' + m[3] : m[3];
    var order = userDateOrder_();
    if (order === 'ymd') return '';   // year-first people write it year-first: no guessing
    if (order === 'mdy') { mo = m[1]; d = m[2]; } else { d = m[1]; mo = m[2]; }
  }
  var dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return '';
  return y + '-' + ('0' + Number(mo)).slice(-2) + '-' + ('0' + Number(d)).slice(-2);
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
    var amt = parseTypedAmount_(value);
    if (isNaN(amt) || amt <= 0) return null;
    // A withdrawal stays negative however its amount is retyped.
    setCellByRow_(sheet, headers, rowIndex, 'amount', entry.type === 'investment' && Number(entry.amount) < 0 ? -amt : amt);
  } else if (field === 'description') {
    setCellByRow_(sheet, headers, rowIndex, 'description', value);
  } else if (field === 'paid by' && entry.type === 'income') {
    // Income: "paid by" names the payor. Reuse a matching one, otherwise
    // create it (the owner typed the name on purpose).
    var payorRow = pickByName_(getPayorRows_(), value, function (p) { return p.name; }) ||
      findOrCreatePayorByName_(value);
    setCellByRow_(sheet, headers, rowIndex, 'paid_by', payorRow.id);
  } else if (field === 'paid by') {
    if (/^(?:me|yo)$/i.test(value.trim())) {
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
    } else {
      var friend = fuzzyFindFriend_(value);
      if (!friend) return null;
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', friend.id);
    }
  } else if (field === 'currency') {
    // Only a currency the app knows; anything else is reported as not applied.
    if (!isKnownCurrencyCode_(value.toUpperCase())) return null;
    setCellByRow_(sheet, headers, rowIndex, 'currency', value.toUpperCase());
  } else if (field === 'date') {
    // Only a real calendar date (see parseTypedDate_); "fecha de mi cumple" is not one.
    var typedDate = parseTypedDate_(value);
    if (!typedDate) return null;
    setCellByRow_(sheet, headers, rowIndex, 'date', typedDate);
  } else if (field === 'split') {
    var parsed = parseSplitCommand_(entry, value);
    if (!parsed) return null;
    saveEntrySplits(entryId, parsed);
  } else if (field === 'payment method') {
    // A withdrawal has no "payment method" — the account it lands in is its
    // "to" (stored in payment_method_id, which is what balances read).
    if (entry.type === 'investment' && Number(entry.amount) < 0) return null;
    var pm = fuzzyFindPaymentMethod_(value);
    if (!pm) return null;
    setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', pm.id);
  } else if ((field === 'to' || field === 'received at') && entry.type === 'investment' && Number(entry.amount) < 0) {
    // Withdrawal: "received at <account>" (or "to <account>") is where the money lands.
    var landPm = fuzzyFindPaymentMethod_(value);
    if (!landPm || landPm.type === 'investment') return null;
    setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', landPm.id);
  } else if (field === 'from' || field === 'to' || field === 'received at') {
    if (entry.type !== 'transfer' || field === 'received at') return null;
    // "from none" / "to none": that end of the move isn't one of the owner's
    // own accounts (e.g. a Yape that came in from someone else's account), so
    // it is left empty — a balance only moves for the end that is set.
    var clearEnd = /^(?:none|nothing|no\s+account|clear|-|ninguno|ninguna|nada|sin\s+cuenta)$/i.test(value);
    var endPm = clearEnd ? { id: '' } : fuzzyFindPaymentMethod_(value);
    if (!endPm) return null;
    // One card for a waiting exchange: "from" is where the money LEFT, "to" where it ARRIVED, whichever side the card is.
    var xEdit = exchangePairOf_(entry);
    if (xEdit) {
      if (field === 'from') setEntryField_(xEdit.out.id, 'payment_method_id', endPm.id);
      else { ensureEntriesToPaymentMethodColumn_(); setEntryField_(xEdit['in'].id, 'to_payment_method_id', endPm.id); }
    } else if (isExchangeLegMarked_(entry)) {
      // One side of an exchange whose other side is not here (owner, 2026-11-23): it holds ONE account. "from" fits only the side the
      // money left, "to" only the side it arrived in; the other end stays empty (the exchange house). Before, "from <soles account>" on
      // the dollars side made one USD entry leaving the soles account.
      var xSide = exchangePairSide_(entry), wantSide = field === 'from' ? 'out' : 'in';
      if (xSide && xSide !== wantSide) return null;
      ensureEntriesToPaymentMethodColumn_();
      setEntryField_(entryId, 'payment_method_id', wantSide === 'out' ? endPm.id : '');
      setEntryField_(entryId, 'to_payment_method_id', wantSide === 'in' ? endPm.id : '');
    } else if (field === 'from') {
      setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', endPm.id);
    } else {
      ensureEntriesToPaymentMethodColumn_();
      setEntryField_(entryId, 'to_payment_method_id', endPm.id);
    }
  } else if (field === 'direction') {
    if (entry.type !== 'investment') return null;
    var absAmount = Math.abs(Number(entry.amount));
    setCellByRow_(sheet, headers, rowIndex, 'amount', /^(?:withdrawal|retiro)$/i.test(value.trim()) ? -absAmount : absAmount);
  } else if (field === 'platform') {
    if (entry.type !== 'investment') return null;
    var platform = pickByName_(
      getAllRows('Payment Methods').filter(function (p) { return p.type === 'investment'; }),
      value, function (p) { return p.nickname; });
    if (!platform) return null;
    ensureEntriesToPaymentMethodColumn_();
    setEntryField_(entryId, 'to_payment_method_id', platform.id);
  } else if (field === 'label') {
    var tagIds = parseLabelCommand_(value);
    if (tagIds === null) return null;
    saveEntryTags({ entryId: entryId, tagIds: tagIds });
  } else if (field === 'trip') {
    if (entry.type !== 'expense') return null;
    var tripId = parseTripCommand_(value);
    if (tripId === null) return null;
    ensureEntriesTripColumn_();
    // "trip none" on a pending entry must stick until the confirmation that this same reply triggers.
    setEntryField_(entryId, 'trip_id', tripId === '' && entry.status === 'pending' ? TRIP_DECLINED_ : tripId);
  } else if (field === 'type') {
    var newType = entryTypeFromWord_(value);
    if (newType === entry.type) return field; // no-op, nothing to clean up
    setCellByRow_(sheet, headers, rowIndex, 'type', newType);
    if (newType === 'transfer') {
      // Transfers always carry the one fixed "Between Accounts" category
      // (same as the app — transfer is excluded from ICON_PICKER_TYPES,
      // so its category picker only ever offers this one option) and are
      // always the owner's own money, never a friend's.
      var transferCat = getAllRows('Categories').find(function (c) { return c.type === 'transfer'; });
      setCellByRow_(sheet, headers, rowIndex, 'category_id', transferCat ? transferCat.id : '');
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
      // An income's account is where the money LANDED, so on a transfer it is
      // the "To" end, not the "From" end (a received Yape on BCP became
      // "From BCP", as if the money had left it). The other end is unknown —
      // reply "from Plin" if it was one of the owner's own accounts.
      if (entry.type === 'income') {
        ensureEntriesToPaymentMethodColumn_();
        setEntryField_(entryId, 'to_payment_method_id', entry.payment_method_id || '');
        setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', '');
      }
      // A transfer can't carry a split — clear one left over from when
      // this was still a pending expense (same cleanup updateEntry's
      // caller in app.js does for a type change via the Split popup).
      if (entry.type === 'expense') saveEntrySplits(entryId, []);
    } else if (newType === 'investment') {
      // An investment is the owner's own money moving from one of their
      // accounts (payment_method_id, kept as is) to a platform
      // (to_payment_method_id — chosen with "platform Hapi"). Its category
      // comes from the investment list, so the old one is cleared unless
      // it already belongs to it; a transfer's "to" is an account, not a
      // platform, so it's cleared too. Never a friend's, never split.
      if (needsInvestmentCategory_(entry.category_id)) {
        setCellByRow_(sheet, headers, rowIndex, 'category_id', defaultInvestmentCategoryId_());
      }
      setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
      ensureEntriesToPaymentMethodColumn_();
      setEntryField_(entryId, 'to_payment_method_id', '');
      if (entry.type === 'expense') saveEntrySplits(entryId, []);
    } else {
      // Leaving transfer (or switching expense<->income): the old
      // category_id belongs to the old type's category list, so it's
      // cleared unless it happens to already be a valid category for the
      // new type — same "needs category" state a fresh pending entry
      // without a guess shows, rather than silently keeping a
      // mismatched one.
      var oldCat = entry.category_id ?
        getAllRows('Categories').find(function (c) { return c.id === entry.category_id; }) : null;
      if (!oldCat || oldCat.type !== newType) {
        setCellByRow_(sheet, headers, rowIndex, 'category_id', '');
      }
      if (entry.type === 'transfer' || entry.type === 'investment') {
        ensureEntriesToPaymentMethodColumn_();
        // Becoming income: its "Received at" is the account the money went INTO
        // (the transfer's "To"), mirroring the income -> transfer move above.
        if (entry.type === 'transfer' && newType === 'income' && entry.to_payment_method_id) {
          setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', entry.to_payment_method_id);
        }
        setEntryField_(entryId, 'to_payment_method_id', '');
      }
      // Only investments carry a negative amount (a withdrawal).
      if (entry.type === 'investment' && Number(entry.amount) < 0) {
        setCellByRow_(sheet, headers, rowIndex, 'amount', Math.abs(Number(entry.amount)));
      }
      // paid_by means a different kind of row per type (a Payor for
      // income; 'me' or a Friend for expense/transfer) — a value carried
      // over from the old type is never valid for the new one. Income
      // starts blank (prompted for, like a fresh income entry); landing
      // on expense from income defaults back to 'me' rather than leaving
      // a Payor id that'd display as a raw, unresolved id.
      if (newType === 'income') {
        setCellByRow_(sheet, headers, rowIndex, 'paid_by', '');
      } else if (entry.type === 'income') {
        setCellByRow_(sheet, headers, rowIndex, 'paid_by', 'me');
      }
    }
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
// Each part may give its number AFTER or BEFORE the name ("Ana 20" / "20 Ana"), and as an
// amount or a percentage of the entry's amount ("Ana 50%" / "50% Ana"); parts are still
// separated by commas (owner, 2026-11-03).
function parseSplitPart_(part) {
  var s = String(part).trim();
  var m = s.match(/^([\d.,]+)\s*(%?)\s+(.+)$/);
  if (m) return { name: m[3].trim(), num: m[1], pct: !!m[2] };
  m = s.match(/^(.+?)\s+([\d.,]+)\s*(%?)$/);
  if (m) return { name: m[1].trim(), num: m[2], pct: !!m[3] };
  return null;
}

// The amount (in the entry's currency, to the cent) a split part stands for; null when the number is unreadable.
function splitPartAmount_(p, entry) {
  var n = parseFloat(p.num.replace(/,/g, ''));
  if (isNaN(n)) return null;
  return p.pct ? Math.round(Number(entry.amount) * n) / 100 : n;
}

// The trip a "split group" means: the trip set on the entry, else the one whose dates cover it (never a guess between two).
function splitGroupTrip_(entry) {
  var id = entry.trip_id && entry.trip_id !== TRIP_DECLINED_ ? entry.trip_id : suggestedTripIdForDate_(entry.date);
  return id ? tripById_(id) : null;
}

// An equal split with a trip's group (owner, 2026-11-16): the amount is divided by the people in the group (the owner included),
// exactly like the app's "People in the group" box (groupEqualShares_ in app.js): each share rounded to the cent, the group owes
// everyone else's shares as one debt, the owner keeps the leftover cent. `size` given = that number, and it becomes the trip's
// new starting number (as on the app's form); else the trip's own group_size (2 when empty).
function splitWithGroup_(entry, trip, size) {
  var friend = ensureTripGroupFriend_(trip);
  var n = size ? Math.round(Number(size)) : (Number(trip.group_size) || 2);
  if (!isFinite(n) || n < 2 || n > 99) return null;
  if (size && n !== Number(trip.group_size)) setTripGroupSize_(trip.id, n);
  var totalCents = Math.round(Number(entry.amount) * 100);
  var groupCents = Math.round(totalCents / n) * (n - 1);
  if (groupCents <= 0 || groupCents >= totalCents) return null;
  return [{ friend_id: friend.id, amount: groupCents / 100 }];
}

function parseSplitCommand_(entry, text) {
  var trimmed = String(text).trim();
  if (/^(none|clear|off|ninguno|ninguna|borrar)$/i.test(trimmed)) return [];

  // "group", "with the group", "equal group", "group 5" (Spanish: "grupo", "con el grupo", "igual grupo", "grupo 5"): the
  // trip's group, divided by its people.
  var groupMatch = trimmed.match(/^(?:(?:equal|igual)\s+)?(?:with\s+(?:the\s+)?|con\s+(?:el\s+)?)?(?:group|grupo)(?:\s+(?:of\s+|de\s+)?(\d{1,2})(?:\s+(?:people|personas))?)?$/i);
  if (groupMatch) {
    var gTrip = splitGroupTrip_(entry);
    return gTrip ? splitWithGroup_(entry, gTrip, groupMatch[1]) : null;
  }

  var equalMatch = trimmed.match(/^(?:equal|igual)\s+(.+)/i);
  if (equalMatch) {
    var names = equalMatch[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) return null;
    var friends = [];
    for (var i = 0; i < names.length; i++) {
      var f = fuzzyFindFriend_(names[i]);
      if (!f) return null;
      friends.push(f);
    }
    // The group of a trip named by hand ("equal Costa Rica 2026 group"): divided by its people, not as one person.
    if (friends.length === 1 && friends[0].trip_id) {
      var named = tripById_(friends[0].trip_id);
      if (named) return splitWithGroup_(entry, named, null);
    }
    var n = friends.length;
    var totalCents = Math.round(Number(entry.amount) * 100);
    var shareCents = Math.floor(totalCents / (n + 1));
    return friends.map(function (fr) { return { friend_id: fr.id, amount: shareCents / 100 }; });
  }

  // Custom: "Ana 20, Carlos 15" — each part is "<name> <amount>".
  var parts = trimmed.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  // "Ana, me 30" / "Ana, JP 30" — the owner states their OWN share and
  // the friend(s) without an amount cover the rest (divided evenly if
  // several, leftover cents to the last one).
  var ownerIdx = -1, ownerAmt = 0;
  for (var k = 0; k < parts.length; k++) {
    var om = parseSplitPart_(parts[k]);
    if (om && /^(?:me|jp|yo)$/i.test(om.name)) { ownerIdx = k; ownerAmt = splitPartAmount_(om, entry); break; }
  }
  if (ownerIdx !== -1) {
    if (ownerAmt === null || ownerAmt < 0) return null;
    var others = parts.filter(function (_, idx) { return idx !== ownerIdx; });
    if (!others.length) return null;
    var fixed = [], open = [], fixedTotal = 0;
    for (var p = 0; p < others.length; p++) {
      var pm2 = parseSplitPart_(others[p]);
      var fr2 = fuzzyFindFriend_(pm2 ? pm2.name : others[p]);
      if (!fr2) return null;
      if (pm2) {
        var a2 = splitPartAmount_(pm2, entry);
        if (a2 === null || a2 <= 0) return null;
        fixed.push({ friend_id: fr2.id, amount: a2 });
        fixedTotal += a2;
      } else {
        open.push(fr2);
      }
    }
    var restCents = Math.round((Number(entry.amount) - ownerAmt - fixedTotal) * 100);
    if (open.length) {
      if (restCents <= 0) return null;
      var each = Math.floor(restCents / open.length);
      open.forEach(function (fr, idx) {
        var c = idx === open.length - 1 ? restCents - each * (open.length - 1) : each;
        fixed.push({ friend_id: fr.id, amount: c / 100 });
      });
    } else if (Math.abs(restCents) > 0) {
      return null; // every share stated but they don't add up to the bill
    }
    return fixed;
  }

  var splits = [];
  var assigned = 0;
  for (var j = 0; j < parts.length; j++) {
    var m = parseSplitPart_(parts[j]);
    if (!m) return null;
    var friend2 = fuzzyFindFriend_(m.name);
    if (!friend2) return null;
    var amt = splitPartAmount_(m, entry);
    if (amt === null || amt <= 0) return null;
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
  if (/^(none|clear|off|ninguno|ninguna|borrar)$/i.test(trimmed)) return [];

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
// "Family & Personal" and "family personal" compare equal, "Psicólogo" and
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
//   2. the name STARTS with what was typed ("rest" -> Restaurants);
//   3. what was typed starts one of the name's words ("personal" -> Family &
//      Personal, "card" -> Credit card);
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
  // The stored (English) name first, then the Spanish one — the owner may type either.
  return pickByName_(cats, text, function (c) { return c.name; }) ||
    pickByName_(cats, text, function (c) { return categoryLabel_(c, 'es'); });
}

function fuzzyFindFriend_(text) {
  return pickByName_(getAllRows('Friends'), text, function (f) { return f.name; });
}

// "trip none" (or clear/off/ninguno) unlinks; otherwise the name must match exactly one trip or event
// (same whole-word matcher as every other reply name); an unknown or ambiguous name fails the segment.
function parseTripCommand_(text) {
  var trimmed = String(text).trim();
  if (/^(none|clear|off|ninguno|ninguna|borrar)$/i.test(trimmed)) return '';
  var trip = fuzzyFindTrip_(trimmed);
  return trip ? trip.id : null;
}

function fuzzyFindTrip_(text) {
  return pickByName_(getTripRows_(), text, function (t) { return t.name; });
}

function fuzzyFindTag_(text) {
  var tags = getAllRows('Tags');
  // The stored name first, then the Spanish one (the built-in Annual tag is "Anual").
  return pickByName_(tags, text, function (t) { return t.name; }) ||
    pickByName_(tags, text, function (t) { return tagLabel_(t, 'es'); });
}

function fuzzyFindPaymentMethod_(text) {
  return pickByName_(withoutPracticeAccounts_(getAllRows('Payment Methods')), text, function (p) { return p.nickname; });
}

function getEntryById_(entryId) {
  return findRowById_('Entries', entryId);   // the id column and one row, not the whole sheet (Api.gs)
}

function setCellByRow_(sheet, headers, rowIndex, fieldName, value) {
  var col = headers.indexOf(fieldName);
  if (col === -1) return;
  changeNoteCell_(sheet, headers, rowIndex, fieldName, value);   // the change log (ChangeLog.gs, company copies)
  sheet.getRange(rowIndex, col + 1).setValue(safeCellValue_(sheet.getName(), fieldName, value));
  noteCellWrite_(sheet, rowIndex, fieldName);
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
  if (changeLogOn_('Entries')) {   // the change log keeps what was deleted (ChangeLog.gs, company copies)
    var gone = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0], obj = {};
    headers.forEach(function (h, i) { obj[h] = gone[i]; });
    changeNoteDelete_('Entries', obj);
  }
  deleteSheetRows_(sheet, rowIndex, 1);
  recordEntryDeletions_([entryId]);
  // A no-op for an entry that was never split (the common case, and every
  // pending/review-queue entry today, since Phase 5's split UI is only on
  // confirmed entries) — see deleteEntrySplitsAndLoansForEntry_ in
  // Loans.gs for what it does when there's something to clean up.
  deleteEntrySplitsAndLoansForEntry_(entryId);
  deleteRowsWhere_('Entry Tags', function (row) { return row.entry_id === entryId; });
  deleteEntryBill_(entryId);
}
