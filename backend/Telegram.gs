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

  var payload = {
    chat_id: chatId,
    text: formatEntryForTelegram_(entry, categoryName, autoReason)
  };
  // A confirmed entry's card (shown after an edit reply) has no buttons — it
  // is already done, and can still be changed by replying.
  if (entry.status !== 'confirmed') {
    payload.reply_markup = {
      inline_keyboard: [[
        { text: tr_('bot.confirmButton'), callback_data: 'confirm:' + entry.id },
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
function formatEntryForTelegram_(entry, categoryName, autoReason) {
  if (!categoryName && entry.category_id) {
    var cat = getAllRows('Categories').find(function (c) { return c.id === entry.category_id; });
    categoryName = cat ? categoryLabel_(cat) : null;
  }
  var icon = entry.type === 'expense' ? '💸' : entry.type === 'income' ? '💰' : entry.type === 'investment' ? '📈' : '🔁';
  var lines = [];
  lines.push(icon + ' ' + (entry.description || tr_('bot.noDescription')) + (entry.status === 'confirmed' ? tr_('bot.confirmedTag') : ''));
  if (entry.type === 'investment') {
    // No category for investments (see defaultInvestmentCategoryId_).
    lines.push(entry.currency + ' ' + moneyFmt_(entry.amount));
  } else {
    lines.push(entry.currency + ' ' + moneyFmt_(entry.amount) + ' — ' + (categoryName || tr_('bot.needsCategory')) +
      (autoReason === true ? tr_('bot.autoTagShort') : autoReason ? tr_('bot.autoTag', { reason: autoReason }) : ''));
  }
  lines.push(entry.date + ' · ' + tr_('bot.type.' + entry.type));
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
    var payor = entry.paid_by ? getAllRows('Payors').find(function (p) { return p.id === entry.paid_by; }) : null;
    lines.push(tr_('bot.receivedFrom') + (payor ? payor.name : tr_('bot.notSetPayor')));
    // No payment method shows "❓ not set — reply ..." (same as a transfer's
    // missing end) instead of leaving the line out.
    lines.push('💳 ' + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetPaymentMethod')));
  } else {
    lines.push(tr_('bot.paidBy') + paidByDisplayName_(entry.paid_by));
    lines.push('💳 ' + paymentMethodDisplayName_(entry.payment_method_id, tr_('bot.notSetPaymentMethod')));
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

  var twins = entry.status === 'pending' ? findSameDayTwins_(entry, getAllRows('Entries')) : [];
  if (twins.length) {
    lines.push('');
    lines.push(tr_('bot.duplicate', { list: twins.map(function (t) {
      return tr_('bot.duplicateItem', { name: t.description || tr_('bot.anEntry'), status: (t.status === 'pending' || t.status === 'confirmed') ? tr_('bot.status.' + t.status) : t.status });
    }).join(', ') }));
  }

  lines.push('');
  if (entry.type === 'transfer') {
    lines.push(tr_('bot.hintTransfer'));
    return lines.join('\n');
  }
  if (entry.type === 'investment') {
    lines.push(tr_('bot.hintInvestment'));
    return lines.join('\n');
  }
  lines.push(tr_('bot.hintOther'));
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
  var tail = ['', 'bothLanguages'];
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
  if (!chatId || !getTelegramToken_()) return false;

  var periodLabel = tr_(budget.period_type === 'yearly' ? 'bot.thisYear' : 'bot.thisMonth');
  var emoji = progress.percent >= 100 ? '🚨' : '⚠️';
  var spentStr = progress.spent != null ? moneyFmt_(progress.spent) : '?';
  var amountStr = moneyFmt_(budget.amount);
  // The threshold (e.g. 75%) is only what triggered this check, not what
  // to report — by the time it's actually noticed and sent, real spend
  // has usually already moved past it (e.g. 77%), so the message says
  // where things actually stand, not the round number that tripped it.
  var actualPercent = Math.round(progress.percent);
  var text = tr_('bot.budgetAlert', { emoji: emoji, category: categoryDisplayName, percent: actualPercent, cur: budget.currency,
    amount: amountStr, spent: spentStr, period: periodLabel });

  // Telegram answers HTTP 200 with ok:false for a blocked bot, a bad
  // chat id, etc. — only a real ok counts as sent, so the caller doesn't
  // log the alert as delivered and never retry it.
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: text });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
}

// A trip/event budget alert — same contract as sendTelegramBudgetAlert_ (false = not configured, retry later).
function sendTelegramTripBudgetAlert_(trip, percent) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return false;
  var cur = trip.budget_currency || homeCurrency_();
  var text = tr_('bot.tripBudgetAlert', {
    emoji: percent >= 100 ? '🚨' : '⚠️', name: tripDisplayName_(trip), percent: Math.round(percent),
    cur: cur, amount: moneyFmt_(trip.budget_amount), spent: moneyFmt_(trip.budgetSpent)
  });
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: text });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
}

// Phase 5.6: loan due-date alerts, same bot, same "false means not
// configured yet, try again next cycle" contract as
// sendTelegramBudgetAlert_ above.
function sendTelegramLoanOverdueAlert_(loan, friendName) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return false;

  var text = tr_(loan.direction === 'they_owe_me' ? 'bot.overdueTheyOwe' : 'bot.overdueIOwe', {
    friend: friendName, cur: loan.currency, amount: moneyFmt_(loan.remaining), date: loan.due_date,
    description: loan.description ? ' ' + loan.description : '' });

  // Telegram answers HTTP 200 with ok:false for a blocked bot, a bad
  // chat id, etc. — only a real ok counts as sent, so the caller doesn't
  // log the alert as delivered and never retry it.
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: text });
  noteTelegramAlertSent_(res);
  return !!(res && res.ok);
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

  // Once handled, take the buttons off the card so a second tap (easy when
  // the first reply is slow) can't confirm again — and answer a repeat tap
  // on an already-handled entry with a note instead of "Confirmed." again.
  var entry = action === 'confirm' || action === 'discard' ? getEntryById_(entryId) : null;
  var reply = null;
  var keepButtons = false;
  if (action === 'confirm') {
    if (entry && entry.status === 'confirmed') {
      reply = tr_('bot.alreadyConfirmed');
    } else if (!entry) {
      reply = tr_('bot.entryGone');
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
      linkSuggestedTripOnTelegramConfirm_(entryId);   // the card said so (trip/event matching its date)
      confirmEntryWithLearning_(entryId);
      reply = tr_('bot.confirmed');
    }
  } else if (action === 'discard') {
    if (!entry) {
      reply = tr_('bot.entryGone');
    } else if (entry.status === 'confirmed') {
      // Confirmed from the app after this card was sent — a late tap on
      // an old card must never delete a real, confirmed entry.
      reply = tr_('bot.alreadyConfirmedDelete');
    } else {
      try {
        discardEntryWithRepayments_(entryId);
        reply = tr_('bot.discarded');
      } catch (err) {
        reply = tr_('bot.notDiscarded', { error: err.message });
      }
    }
  }
  if (reply) {
    telegramApi_('sendMessage', {
      chat_id: cb.message.chat.id, text: reply,
      reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true
    });
    if (!keepButtons) removeCardButtons_(cb.message.chat.id, cb.message.message_id);
  }

  telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
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

  // Not a reply to anything: assume it is about the last notification, if
  // that was an entry card still pending approval. Otherwise (an alert, a
  // confirmed/removed entry, nothing yet) ask for a direct reply.
  var targetMessageId = msg.reply_to_message ? msg.reply_to_message.message_id : lastPendingCardMessageId_();
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
  var terminalMatch = text.match(/^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)\s+(.+)/i) ||
    text.match(/^(?:(?:convert\s+to|convertir\s+en)\s+)?(?:loan|pr[eé]stamo)\s+(.+)/i);
  var result = terminalMatch
    ? applyTerminalReviewAction_(mapping.entry_id, text, terminalMatch[1])
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
    sendTelegramEntryNotification_(result.entry, result.categoryName);
  }

  // The card that was replied to is now superseded (by the refreshed card,
  // or by the entry being removed) — take its buttons off so it can't be
  // confirmed/discarded by mistake. A command that wasn't understood leaves
  // it untouched, since that card is still the live one.
  if ((result.entry && !result.removed) || result.removed) {
    removeCardButtons_(msg.chat.id, targetMessageId);
  }
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
function applyTerminalReviewAction_(entryId, fullText, friendText) {
  var entry = getEntryById_(entryId);
  if (!entry) return { message: tr_('bot.entryNotFound') };

  // Which way the money moved, and through which of the owner's accounts.
  // An expense went out, an income came in. A transfer is read from its ends:
  // only a "to" account = money came in (e.g. a Yape from a friend); only a
  // "from" account = money went out. Both ends set = really between the
  // owner's own accounts.
  var incoming, accountId;
  if (entry.type === 'expense' || entry.type === 'income') {
    incoming = entry.type === 'income';
    accountId = entry.payment_method_id || '';
  } else if (entry.type === 'transfer') {
    var hasFrom = !!entry.payment_method_id, hasTo = !!entry.to_payment_method_id;
    if (hasFrom && hasTo) return { message: tr_('bot.internalTransfer') };
    if (!hasFrom && !hasTo) return { message: tr_('bot.transferNoEnds') };
    incoming = hasTo;
    accountId = incoming ? entry.to_payment_method_id : entry.payment_method_id;
  } else {
    return { message: tr_('bot.onlyExpenseIncome', { type: tr_('bot.type.' + entry.type) }) };
  }

  var friend = fuzzyFindFriend_(String(friendText).trim());
  if (!friend) {
    return { message: tr_('bot.unknownFriend', { name: String(friendText).trim() }) };
  }

  var isRepayment = /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)/i.test(fullText.trim());

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
  var w = String(word || '').trim().toLowerCase();
  var map = { gasto: 'expense', ingreso: 'income', transferencia: 'transfer', 'inversión': 'investment', inversion: 'investment' };
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
  // reply should be able to change too. "payment method" (not "payment"
  // alone) to read unambiguously in a help line next to "paid by".
  { field: 'payment method', re: /^(?:payment\s*method|medio\s*de\s*pago)\s+(.+)/i },
  // Transfers only (see applyOneEditSegment_): the two ends of the move.
  { field: 'from', re: /^(?:from|desde)\s+(.+)/i },
  { field: 'to', re: /^(?:to|hasta|hacia)\s+(.+)/i },
  // Withdrawals only: same as "to", worded the way it reads for money coming back.
  { field: 'received at', re: /^(?:received\s*at|recibido\s*en)\s+(.+)/i },
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
  { field: 'type', re: /^(?:type|tipo)\s+(expense|income|transfer|investment|gasto|ingreso|transferencia|inversi[oó]n)(?![\wáéíóúñ])/i }
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
var EDIT_FIELD_KEYWORDS_RE = '(?:(?:category|categor[ií]a|amount|monto|description|descripci[oó]n|paid\\s*by|pagado\\s*por|currency|moneda|date|fecha|split|repartir|dividir|payment\\s*method|medio\\s*de\\s*pago|labels?|tags?|etiquetas?|trip|event|viaje|evento|from|desde|to|hasta|hacia|received\\s*at|recibido\\s*en|platform|plataforma|type|tipo)\\s+|(?:withdrawal|deposit|retiro|dep[oó]sito)(?![\\wáéíóúñ]))';

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
    var blocker = telegramConfirmBlocker_(entry);
    if (!allApplied) return tr_('bot.notConfirmedPartial');
    if (blocker) return tr_('bot.notConfirmedBlocker', { blocker: blocker });
    linkSuggestedTripOnTelegramConfirm_(entryId);
    confirmEntryWithLearning_(entryId);
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

function applyEditCommand_(entryId, text) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) return { message: tr_('bot.entryNotFound') };

  var appliedFields = [];
  var failedSegments = [];
  var statusBefore = (getEntryById_(entryId) || {}).status;

  withWriteBatch_(function () {
    var previousField = null;
    splitEditCommands_(text).forEach(function (segment) {
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

  if (!appliedFields.length) {
    return { message: tr_('bot.notRecognized') + '\n\n' + helpText };
  }

  var messageParts = [tr_('bot.updated', { fields: appliedFields.map(function (f) { return tr_('bot.field.' + String(f).replace(/ /g, '_')); }).join(', ') })];
  var statusNote = finishTelegramEdit_(entryId, statusBefore, !failedSegments.length);
  if (statusNote) messageParts.push(statusNote);
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
  var quiet = !failedSegments.length && !statusNote;
  return { message: quiet ? '' : messageParts.join(' '), entry: updated, categoryName: categoryName };
}

// Keywords whose value must have a strict shape. Only these are folded back into
// a description when the value is not valid (a typo in "category Gorceries" must
// still be reported, not silently turned into description text).
var FORMAT_KEYWORD_RE_ = /^(?:date|fecha|currency|moneda|amount|monto)(?![a-záéíóúñ])/i;

// The currencies the app's picker offers (docs/app.js CURRENCIES), plus any
// already in the exchange-rate table.
var KNOWN_CURRENCY_CODES_ = ['PEN', 'USD', 'EUR', 'ARS', 'MXN', 'BRL', 'CLP', 'COP', 'BOB', 'UYU', 'PYG', 'VES', 'GTQ', 'CRC', 'PAB', 'DOP', 'HNL', 'NIO', 'CUP', 'GBP', 'CAD', 'CHF', 'JPY', 'CNY', 'KRW', 'INR', 'AUD', 'NZD', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'ZAR', 'AED', 'THB', 'RUB', 'ILS'];

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
    if (field === 'from') {
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
function parseSplitCommand_(entry, text) {
  var trimmed = String(text).trim();
  if (/^(none|clear|off|ninguno|ninguna|borrar)$/i.test(trimmed)) return [];

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
    var om = parts[k].match(/^(?:me|jp|yo)\s+([\d.,]+)$/i);
    if (om) { ownerIdx = k; ownerAmt = parseFloat(om[1].replace(/,/g, '')); break; }
  }
  if (ownerIdx !== -1) {
    if (isNaN(ownerAmt) || ownerAmt < 0) return null;
    var others = parts.filter(function (_, idx) { return idx !== ownerIdx; });
    if (!others.length) return null;
    var fixed = [], open = [], fixedTotal = 0;
    for (var p = 0; p < others.length; p++) {
      var pm2 = others[p].match(/^(.+?)\s+([\d.,]+)$/);
      var fr2 = fuzzyFindFriend_(pm2 ? pm2[1].trim() : others[p]);
      if (!fr2) return null;
      if (pm2) {
        var a2 = parseFloat(pm2[2].replace(/,/g, ''));
        if (isNaN(a2) || a2 <= 0) return null;
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
  return pickByName_(getAllRows('Payment Methods'), text, function (p) { return p.nickname; });
}

function getEntryById_(entryId) {
  return getAllRows('Entries').find(function (e) { return e.id === entryId; });
}

function setCellByRow_(sheet, headers, rowIndex, fieldName, value) {
  var col = headers.indexOf(fieldName);
  if (col === -1) return;
  sheet.getRange(rowIndex, col + 1).setValue(value);
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
  sheet.deleteRow(rowIndex);
  recordEntryDeletions_([entryId]);
  // A no-op for an entry that was never split (the common case, and every
  // pending/review-queue entry today, since Phase 5's split UI is only on
  // confirmed entries) — see deleteEntrySplitsAndLoansForEntry_ in
  // Loans.gs for what it does when there's something to clean up.
  deleteEntrySplitsAndLoansForEntry_(entryId);
  deleteRowsWhere_('Entry Tags', function (row) { return row.entry_id === entryId; });
  deleteEntryBill_(entryId);
}
