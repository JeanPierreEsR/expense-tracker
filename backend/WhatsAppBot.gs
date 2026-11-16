/**
 * WhatsApp review bot (owner's plan "WhatsApp review cards - plan (DRAFT 2026-11-16)", approved the same day:
 * cards and edit lists together, the "keep it open" message, tap-lists instead of forms, photos later).
 * specs/review-telegram-email.md § WhatsApp review bot.
 *
 * ONE review bot at a time (Script Property REVIEW_BOT = 'whatsapp', else Telegram). On WhatsApp, the Telegram bot's own engine
 * (Telegram.gs: cards, Confirm / Discard, every reply command, every safety rule, tag question, alerts) runs unchanged; only the
 * delivery changes:
 *   - out: telegramApi_ hands sendMessage / answerCallbackQuery / editMessageReplyMarkup to whatsappFromTelegram_, which turns a
 *     Telegram message into a WhatsApp one (text, up to 3 reply buttons, or a tap-list). A card's Confirm / Discard become
 *     Confirm · Edit · Discard. WhatsApp cannot take buttons off an old message: a late tap gets the engine's own "already
 *     confirmed" / "gone" answer.
 *   - in: a WhatsApp message (from the relay, WhatsApp.gs) becomes the Telegram shape the engine reads: a button tap is a
 *     callback, a reply to a card is a reply, chat id WA_CHAT_ID_.
 * The 24-hour window: WhatsApp lets the bot write for free only within 24 h of the person's last message (paid templates are never
 * used, $0 rule). A card made while it is closed is not sent; every such card is sent ("catch-up") the next time the person writes.
 * Alerts that could not be sent are retried by their own checks (their "false = try again" contract). Shortly before the window
 * closes, one message asks the person to write anything (whatsappNudgeIfDue_, from runAutomation).
 */
var WA_CHAT_ID_ = 'whatsapp';
var WA_WINDOW_MS_ = 23 * 3600000;          // 1 h of margin before WhatsApp's 24 h
var WA_NUDGE_FROM_MS_ = 22.5 * 3600000;    // the "keep it open" message goes between 22.5 h and 23.75 h after the last message
var WA_NUDGE_UNTIL_MS_ = 23.75 * 3600000;
var WA_CARDS_PER_BATCH_ = 5;
var WA_LIST_PAGE_ = 9;                     // + one "More…" row = WhatsApp's 10 rows
var WA_AWAIT_MS_ = 15 * 60000;
// The app never holds the WhatsApp access token: it asks the Cloudflare relay to send (POST <relay>/send with the relay key),
// and the relay, which has the token, only ever sends to the owner's own number(s) (WA_ALLOWED_FROM).
var WA_RELAY_URL_DEFAULT_ = 'https://whatsapp-relay.jper75.workers.dev';

function waProp_(key) { return String(PropertiesService.getScriptProperties().getProperty(key) || ''); }
function waSetProp_(key, value) { PropertiesService.getScriptProperties().setProperty(key, String(value)); }
function whatsappRelayUrl_() { return (waProp_('WA_RELAY_URL') || WA_RELAY_URL_DEFAULT_).replace(/\/+$/, ''); }

function whatsappCanSend_() { return !!(waProp_(WHATSAPP_SECRET_PROP_) && waProp_('WA_OWNER_NUMBER')); }
function reviewBotIsWhatsApp_() { return waProp_('REVIEW_BOT') === 'whatsapp' && whatsappCanSend_(); }
function whatsappWindowOpen_() {
  var last = Number(waProp_('WA_LAST_IN')) || 0;
  return last > 0 && Date.now() - last < WA_WINDOW_MS_;
}
function isWamid_(id) { return /^wamid\./.test(String(id || '')); }

// ---- sending ----

function whatsappGraphSend_(body) {
  var payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waProp_('WA_OWNER_NUMBER') };
  Object.keys(body).forEach(function (k) { payload[k] = body[k]; });
  var res;
  try {
    res = UrlFetchApp.fetch(whatsappRelayUrl_() + '/send', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Relay-Secret': waProp_(WHATSAPP_SECRET_PROP_) },
      payload: JSON.stringify({ message: payload })
    });
  } catch (err) {
    return { ok: false, description: String(err) };
  }
  var j = {};
  try { j = JSON.parse(res.getContentText()) || {}; } catch (err) { j = {}; }
  var id = j.messages && j.messages[0] && j.messages[0].id;
  if (id) return { ok: true, result: { message_id: id } };
  console.error('WhatsApp send failed: ' + JSON.stringify(j).slice(0, 300));
  return { ok: false, description: (j.error && j.error.message) || 'WhatsApp send failed' };
}

function waClip_(text, max) {
  text = String(text == null ? '' : text).trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
function waWithContext_(body, replyTo) {
  if (isWamid_(replyTo)) body.context = { message_id: String(replyTo) };
  return body;
}
function whatsappText_(text, replyTo) {
  return whatsappGraphSend_(waWithContext_({ type: 'text', text: { body: waClip_(text, 4096), preview_url: false } }, replyTo));
}
// buttons: [{ id, title }], 1 to 3.
function whatsappButtons_(text, buttons, replyTo) {
  return whatsappGraphSend_(waWithContext_({
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: waClip_(text, 1024) },
      action: { buttons: buttons.slice(0, 3).map(function (b) { return { type: 'reply', reply: { id: String(b.id).slice(0, 256), title: waClip_(b.title, 20) } }; }) }
    }
  }, replyTo));
}
// rows: [{ id, title, description? }], 1 to 10.
function whatsappList_(text, buttonLabel, rows, replyTo) {
  return whatsappGraphSend_(waWithContext_({
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: waClip_(text, 1024) },
      action: {
        button: waClip_(buttonLabel, 20),
        sections: [{ title: waClip_(buttonLabel, 24), rows: rows.slice(0, 10).map(function (r) {
          var row = { id: String(r.id).slice(0, 200), title: waClip_(r.title, 24) };
          if (r.description) row.description = waClip_(r.description, 72);
          return row;
        }) }]
      }
    }
  }, replyTo));
}

var WA_TELEGRAM_METHODS_ = { sendMessage: 1, answerCallbackQuery: 1, editMessageReplyMarkup: 1, editMessageText: 1 };

// Called by telegramApi_ while WhatsApp is the review bot. Answers in Telegram's own shape, so the engine reads it unchanged.
function whatsappFromTelegram_(method, payload) {
  if (method !== 'sendMessage') return { ok: true, result: true };   // no taps to acknowledge, no buttons to take off
  if (!whatsappWindowOpen_()) return { ok: false, description: 'whatsapp_window_closed' };
  var buttons = [];
  ((payload.reply_markup && payload.reply_markup.inline_keyboard) || []).forEach(function (row) {
    row.forEach(function (b) { if (b.callback_data) buttons.push({ id: b.callback_data, title: b.text }); });
  });
  var replyTo = payload.reply_to_message_id;
  if (!buttons.length) return whatsappText_(payload.text, replyTo);
  var confirm = buttons.filter(function (b) { return /^confirm:/.test(b.id); })[0];
  var discard = buttons.filter(function (b) { return /^discard:/.test(b.id); })[0];
  if (confirm && discard) {
    // A card: Confirm · Edit · Discard. "It's the income I was waiting for" lives in the Edit list (WhatsApp allows 3 buttons).
    buttons = [confirm, { id: 'waedit:' + confirm.id.split(':')[1], title: tr_('whatsapp.editButton') }, discard];
  }
  if (buttons.length <= 3) return whatsappButtons_(payload.text, buttons, replyTo);
  return whatsappList_(payload.text, tr_('whatsapp.choose'), buttons, replyTo);
}

// ---- receiving ----

// A retried delivery from Meta (same message id) is handled once.
function whatsappSeen_(id) {
  if (!id) return false;
  var cache = CacheService.getScriptCache();
  var key = 'wa-in-' + sha256Hex_(String(id)).slice(0, 24);
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600);
  return false;
}

// payload (from the relay): { id, from, timestamp, type, text, context_id, reply_id, reply_title }.
function handleWhatsAppInbound_(p) {
  p = p || {};
  var from = String(p.from || '').replace(/\D/g, '');
  if (from) waSetProp_('WA_OWNER_NUMBER', from);   // the relay only forwards the owner's own number(s)
  waSetProp_('WA_LAST_IN', Date.now());
  if (!reviewBotIsWhatsApp_()) return captureWhatsApp_(p);   // Telegram is the review bot: capture only, the relay sends the reply
  if (whatsappSeen_(p.id)) return { handled: true, duplicate: true };

  // No lock here: the steps below take the script lock themselves where they write (capture, conversions), and a lock taken
  // twice in one run would be released early by the inner one.
  whatsappCatchUp_();
  if (p.type === 'interactive' || p.type === 'button') whatsappTap_(String(p.reply_id || ''), p);
  else if (p.type === 'text' || (p.type === undefined && p.text)) whatsappTextIn_(String(p.text || '').trim(), p);
  else whatsappText_(tr_('whatsapp.onlyText'), p.id);
  return { handled: true };
}

function whatsappEngineMessage_(p, text, targetId) {
  var msg = { chat: { id: WA_CHAT_ID_ }, message_id: p.id, text: text };
  if (targetId) msg.reply_to_message = { message_id: targetId };
  handleTelegramMessage_(msg);
}

function whatsappTextIn_(text, p) {
  var waiting = whatsappAwaiting_();
  if (waiting && !p.context_id) {
    whatsappClearAwaiting_();
    return whatsappEngineMessage_(p, waiting.word + ' ' + text, whatsappCardFor_(waiting.entryId));
  }
  if (p.context_id && whatsappCardEntry_(p.context_id)) return whatsappEngineMessage_(p, text, p.context_id);
  if (/^\/?(?:pendientes|pendiente|pending|por revisar)$/i.test(text)) return whatsappSendPending_(0);
  if (/^\/?(?:nuevo|nueva|new)$/i.test(text)) return whatsappText_(tr_('whatsapp.newHow'), p.id);
  var terminal = /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)\b|^(?:(?:convert\s+to|convertir\s+en)\s+)?(?:loan|pr[eé]stamo)\b/i.test(text);
  if (startsWithEditKeyword_(text) || /^\/?(?:help|ayuda)$/i.test(text) || terminal) return whatsappEngineMessage_(p, text, null);
  var r = captureWhatsApp_(p);
  if (r.saved && r.entry) sendTelegramEntryNotification_(r.entry, r.categoryName);
  else whatsappText_(r.reply, p.id);
}

function whatsappTap_(id, p) {
  var parts = id.split(':');
  var action = parts[0], entryId = parts[1] || '';
  if (/^(?:confirm|discard|waitpay|ptags|ptagsno|delrep)$/.test(action)) {
    var cardId = p.context_id || whatsappCardFor_(entryId);
    return handleTelegramCallback_({ id: 'whatsapp', data: id, message: { chat: { id: WA_CHAT_ID_ }, message_id: cardId } });
  }
  if (action === 'waedit') return whatsappEditMenu_(entryId, p.context_id);
  if (action === 'wafield') return whatsappField_(entryId, parts[2], p.id);
  if (action === 'wapage') return whatsappPickList_(entryId, parts[2], Number(parts[3]) || 0, p.id);
  if (action === 'wapick') return whatsappPick_(entryId, parts[2], parts.slice(3).join(':'), p);
  if (action === 'wahelp') return whatsappEngineMessage_(p, 'help', whatsappCardFor_(entryId));
  if (action === 'wamore') return parts[1] === 'catch' ? whatsappCatchUp_(true) : whatsappSendPending_(Number(parts[2]) || 0);
  whatsappText_(tr_('bot.tooOld'), p.id);
}

// ---- cards ----

// The newest WhatsApp card sent for an entry (its message id), or ''.
function whatsappCardFor_(entryId) {
  var rows = getAllRows('Telegram Messages').filter(function (m) { return m.entry_id === entryId && isWamid_(m.message_id); });
  return rows.length ? String(rows[rows.length - 1].message_id) : '';
}
function whatsappCardEntry_(messageId) {
  var row = getAllRows('Telegram Messages').find(function (m) { return String(m.message_id) === String(messageId); });
  return row ? row.entry_id : '';
}

function whatsappPendingEntries_() {
  return getAllRows('Entries').filter(function (e) { return e.status === 'pending'; });
}

// "pendientes": every waiting entry, newest first, WA_CARDS_PER_BATCH_ at a time.
function whatsappSendPending_(offset) {
  var list = whatsappPendingEntries_().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  if (!list.length) return whatsappText_(tr_('whatsapp.nothingWaiting'));
  list.slice(offset, offset + WA_CARDS_PER_BATCH_).forEach(function (e) { sendTelegramEntryNotification_(e); });
  var left = list.length - offset - WA_CARDS_PER_BATCH_;
  if (left > 0) {
    whatsappButtons_(tr_('whatsapp.moreWaiting', { n: left }), [{ id: 'wamore:pend:' + (offset + WA_CARDS_PER_BATCH_), title: tr_('whatsapp.showMore') }]);
  }
}

// Cards made while the window was closed (waiting entries since the switch with no WhatsApp card), oldest first.
function whatsappCatchUp_(more) {
  var since = waProp_('WA_SWITCH_AT');
  if (!since) return 0;
  var carded = {};
  getAllRows('Telegram Messages').forEach(function (m) { if (isWamid_(m.message_id)) carded[m.entry_id] = true; });
  var missed = whatsappPendingEntries_().filter(function (e) { return !carded[e.id] && String(e.created_at) >= since; })
    .sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
  if (!missed.length) {
    if (more) whatsappText_(tr_('whatsapp.nothingWaiting'));
    return 0;
  }
  if (!more) whatsappText_(tr_('whatsapp.catchUp', { n: missed.length }));
  missed.slice(0, WA_CARDS_PER_BATCH_).forEach(function (e) { sendTelegramEntryNotification_(e); });
  var left = missed.length - WA_CARDS_PER_BATCH_;
  if (left > 0) whatsappButtons_(tr_('whatsapp.moreWaiting', { n: left }), [{ id: 'wamore:catch', title: tr_('whatsapp.showMore') }]);
  return missed.length;
}

// ---- Edit: tap-lists ----

var WA_FIELD_WORDS_ = { category: 'category', account: 'account', from: 'from', to: 'to', platform: 'platform', amount: 'amount', description: 'description', date: 'date' };

function whatsappEditFields_(entry) {
  if (entry.type === 'transfer') return ['from', 'to', 'amount', 'description', 'date'];
  if (entry.type === 'investment') return ['platform', 'amount', 'description', 'date'];
  return ['category', 'account', 'amount', 'description', 'date'];
}

function whatsappEditMenu_(entryId, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return whatsappText_(tr_('bot.entryGone'), replyTo);
  var rows = whatsappEditFields_(entry).map(function (f) { return { id: 'wafield:' + entryId + ':' + f, title: tr_('whatsapp.f.' + f) }; });
  if (entry.status === 'pending' && waitingMatchForPending_(entry, listWaitingIncome_())) rows.push({ id: 'waitpay:' + entryId, title: tr_('whatsapp.f.waiting') });
  rows.push({ id: 'wahelp:' + entryId, title: tr_('whatsapp.f.more'), description: tr_('whatsapp.f.moreHint') });
  whatsappList_(tr_('whatsapp.editAsk', { what: entry.description || tr_('bot.noDescription') }), tr_('whatsapp.choose'), rows, replyTo);
}

function whatsappField_(entryId, field, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return whatsappText_(tr_('bot.entryGone'), replyTo);
  if (field === 'amount' || field === 'description' || field === 'date') {
    waSetProp_('WA_AWAIT', JSON.stringify({ entryId: entryId, word: WA_FIELD_WORDS_[field], at: Date.now() }));
    return whatsappText_(tr_('whatsapp.ask.' + field), replyTo);
  }
  whatsappPickList_(entryId, field, 0, replyTo);
}

function whatsappAwaiting_() {
  var raw = waProp_('WA_AWAIT');
  if (!raw) return null;
  try {
    var w = JSON.parse(raw);
    return w && Date.now() - Number(w.at) < WA_AWAIT_MS_ ? w : null;
  } catch (err) { return null; }
}
function whatsappClearAwaiting_() { PropertiesService.getScriptProperties().deleteProperty('WA_AWAIT'); }

function waHidden_(row) { var h = String(row.hidden || '').toLowerCase(); return h === 'yes' || h === 'true'; }

// What a list offers for a field, most used first: [{ id, name (what the reply command reads), label (what is shown) }].
function whatsappChoices_(entry, field) {
  var uses = {};
  var key = field === 'category' ? 'category_id' : (field === 'to' || field === 'platform') ? 'to_payment_method_id' : 'payment_method_id';
  getAllRows('Entries').forEach(function (e) { if (e[key]) uses[e[key]] = (uses[e[key]] || 0) + 1; });
  var items;
  if (field === 'category') {
    items = getAllRows('Categories').filter(function (c) { return c.type === entry.type && !waHidden_(c); })
      .map(function (c) { return { id: c.id, name: c.name, label: categoryLabel_(c) }; });
  } else {
    items = withoutPracticeAccounts_(getAllRows('Payment Methods')).filter(function (pm) {
      return !waHidden_(pm) && (field === 'platform' ? pm.type === 'investment' : pm.type !== 'investment');
    }).map(function (pm) { return { id: pm.id, name: pm.nickname, label: pm.nickname + (pm.last_4 ? ' (' + pm.last_4 + ')' : '') }; });
  }
  return items.sort(function (a, b) { return (uses[b.id] || 0) - (uses[a.id] || 0) || String(a.label).localeCompare(String(b.label)); });
}

function whatsappPickList_(entryId, field, page, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return whatsappText_(tr_('bot.entryGone'), replyTo);
  var items = whatsappChoices_(entry, field);
  if (!items.length) return whatsappText_(tr_('whatsapp.pickNone'), replyTo);
  var start = page * WA_LIST_PAGE_;
  var rows = items.slice(start, start + WA_LIST_PAGE_).map(function (it) { return { id: 'wapick:' + entryId + ':' + field + ':' + it.id, title: it.label }; });
  if (items.length > start + WA_LIST_PAGE_) rows.push({ id: 'wapage:' + entryId + ':' + field + ':' + (page + 1), title: tr_('whatsapp.more') });
  whatsappList_(tr_('whatsapp.pickAsk', { field: tr_('whatsapp.f.' + field), what: entry.description || tr_('bot.noDescription') }), tr_('whatsapp.choose'), rows, replyTo);
}

// A pick runs the same reply command a person would type ("category Restaurants"), so every rule of the engine applies. Two
// items with the same name could not be told apart by name: then the id is written directly and the card is sent again.
function whatsappPick_(entryId, field, itemId, p) {
  var entry = getEntryById_(entryId);
  if (!entry) return whatsappText_(tr_('bot.entryGone'), p.id);
  var items = whatsappChoices_(entry, field);
  var it = items.find(function (x) { return String(x.id) === String(itemId); });
  if (!it) return whatsappText_(tr_('bot.tooOld'), p.id);
  var same = items.filter(function (x) { return normalizeName_(x.name) === normalizeName_(it.name); }).length;
  if (same > 1 && field === 'category') {
    setEntryField_(entryId, 'category_id', it.id);
    return sendTelegramEntryNotification_(getEntryById_(entryId));
  }
  var target = whatsappCardFor_(entryId);
  if (!target) { sendTelegramEntryNotification_(entry); target = whatsappCardFor_(entryId); }
  whatsappEngineMessage_(p, WA_FIELD_WORDS_[field] + ' ' + it.name, target);
}

// ---- keeping the window open ----

// From runAutomation (every 15 minutes): once per window, between 22.5 h and 23.75 h after the person's last message.
function whatsappNudgeIfDue_() {
  if (!reviewBotIsWhatsApp_()) return;
  var last = Number(waProp_('WA_LAST_IN')) || 0;
  var age = Date.now() - last;
  if (!last || age < WA_NUDGE_FROM_MS_ || age >= WA_NUDGE_UNTIL_MS_) return;
  if (waProp_('WA_NUDGED_FOR') === String(last)) return;
  var waiting = whatsappPendingEntries_().length;
  var res = whatsappText_(waiting ? tr_('whatsapp.nudgeWaiting', { n: waiting }) : tr_('whatsapp.nudge'));
  if (res.ok) waSetProp_('WA_NUDGED_FOR', last);
}

// ---- Sheet menu ----

function menuSwitchReviewBot() {
  var ui = SpreadsheetApp.getUi();
  if (waProp_('REVIEW_BOT') === 'whatsapp') {
    if (ui.alert('Review bot: WhatsApp', 'Switch back to Telegram? Cards and alerts will go to Telegram again.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    PropertiesService.getScriptProperties().deleteProperty('REVIEW_BOT');
    ui.alert('Done: Telegram is the review bot.');
    return;
  }
  if (!waProp_(WHATSAPP_SECRET_PROP_)) { ui.alert('First use "34. Set the WhatsApp relay key".'); return; }
  if (!waProp_('WA_OWNER_NUMBER')) { ui.alert('First send any message to the WhatsApp bot from your phone, so the app knows your number.'); return; }
  if (ui.alert('Review bot: Telegram', 'Switch to WhatsApp? Telegram will stop sending cards and alerts. WhatsApp sends them while you have written to it in the last 23 hours; the rest wait and come the next time you write.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  waSetProp_('WA_SWITCH_AT', Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss"));
  waSetProp_('REVIEW_BOT', 'whatsapp');
  ui.alert('Done: WhatsApp is the review bot. Write "pendientes" to it to see what is waiting.');
}
