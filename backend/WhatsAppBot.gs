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
var WA_EXPIRED_MS_ = 2 * 3600000;          // a bare value this long after the question gets "that question expired"
var WA_FRIEND_PAGE_ = 8;                   // + "More…" + "Someone else"
// True while a WhatsApp Edit tap runs a change through the engine: it only saves (finishTelegramEdit_ does not confirm).
var WA_SAVE_ONLY_ = false;
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
  if (id) {
    // Any message quoting one of a transaction's messages (an answer, the Edit list, a pick list) belongs to that transaction too,
    // so a reply to it, or a message sent right after it, is about that transaction (owner, 2026-11-16).
    var linked = payload.context ? whatsappCardEntry_(payload.context.message_id) : '';
    if (linked) appendRowObject('Telegram Messages', { message_id: String(id), entry_id: linked, created_at: new Date().toISOString() });
    waSetProp_('WA_LAST_OUT', id);
    return { ok: true, result: { message_id: id } };
  }
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

// ---- One sender for both bots (owner, 2026-11-16: Telegram gets WhatsApp's lists, "as similar as possible") ----
// The Edit lists, pick lists, friend lists, "pendientes" and their answers are written once and sent by the review bot of the
// moment: WhatsApp (a list behind "Choose", or up to 3 buttons) or Telegram (buttons under the message, one per row; Telegram's
// hidden button code is at most 64 characters, so a longer action travels as a short code kept 6 hours in the script cache).
function botIsWa_() { return reviewBotIsWhatsApp_(); }

function botText_(text, replyTo) {
  if (botIsWa_()) return whatsappText_(text, replyTo);
  var chat = getOwnerTelegramChatId_();
  if (!chat || !getTelegramToken_()) return { ok: false };
  var payload = { chat_id: chat, text: String(text).slice(0, 4096) };
  if (replyTo) { payload.reply_to_message_id = replyTo; payload.allow_sending_without_reply = true; }
  return telegramApi_('sendMessage', payload);
}

// rows: [{ id, title, description? }]. asButtons: WhatsApp shows them as buttons (at most 3) instead of a list.
function botChoices_(text, rows, replyTo, asButtons) {
  if (botIsWa_()) return asButtons ? whatsappButtons_(text, rows, replyTo) : whatsappList_(text, tr_('whatsapp.choose'), rows, replyTo);
  var chat = getOwnerTelegramChatId_();
  if (!chat || !getTelegramToken_()) return { ok: false };
  var payload = {
    chat_id: chat, text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: rows.map(function (r) {
      return [{ text: r.description ? r.title + ' · ' + r.description : r.title, callback_data: botCallbackData_(r.id) }];
    }) }
  };
  if (replyTo) { payload.reply_to_message_id = replyTo; payload.allow_sending_without_reply = true; }
  return telegramApi_('sendMessage', payload);
}

function botCallbackData_(id) {
  id = String(id);
  if (id.length <= 64) return id;
  var token = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  CacheService.getScriptCache().put('botcb-' + token, id, 21600);
  return 'k:' + token;
}
// The action behind a short code, '' when it expired (more than 6 hours).
function botResolveCallback_(data) {
  data = String(data || '');
  if (data.indexOf('k:') !== 0) return data;
  return String(CacheService.getScriptCache().get('botcb-' + data.slice(2)) || '');
}

// The list actions both bots share (the native ones — confirm, discard, waitpay, ptags, delrep — stay in handleTelegramCallback_).
var BOT_LIST_ACTIONS_ = /^(?:waedit|wafield|wapage|wapick|wahelp|wamore|waconv|wafp|wacv|wacvx):/;

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
  var wasClosed = !whatsappWindowOpen_();   // before this message re-opens it: says whether the catch-up is about the window
  var firstEver = !waProp_('WA_LAST_IN');   // the bot's tour starts by itself with a new person's first message (BotTour.gs)
  waSetProp_('WA_LAST_IN', Date.now());
  if (!reviewBotIsWhatsApp_()) {
    // Telegram is the review bot: a photo's card would go to Telegram, so WhatsApp only says where photos are read.
    if (p.type === 'image') return { saved: false, reply: tr_('whatsapp.photoNeedsBot') };
    return whatsappCaptureOnly_(p);
  }   // Telegram is the review bot: capture only, the relay sends the reply
  if (whatsappSeen_(p.id)) return { handled: true, duplicate: true };

  // No lock here: the steps below take the script lock themselves where they write (capture, conversions), and a lock taken
  // twice in one run would be released early by the inner one.
  // "The bot's last message" is the one the person saw before writing: not the cards the catch-up is about to send.
  p.lastTarget = whatsappLastTarget_();
  whatsappCatchUp_(false, wasClosed);
  var isText = p.type === 'text' || (p.type === undefined && !!p.text);
  if (!botTourBefore_(isText ? p.text : '', p, firstEver, !!p.context_id)) {
    if (p.type === 'interactive' || p.type === 'button') whatsappTap_(String(p.reply_id || ''), p);
    else if (isText) whatsappTextIn_(String(p.text || '').trim(), p);
    else if (p.type === 'image' && p.media_id) whatsappPhotoIn_(p);
    else botText_(tr_('whatsapp.onlyText'), p.id);
  }
  botTourAfter_();
  return { handled: true };
}

// saveOnly: an Edit tap (a pick or a typed value) — the change is saved and the entry keeps waiting for Confirm.
function whatsappEngineMessage_(p, text, targetId, saveOnly) {
  var msg = { chat: { id: botIsWa_() ? WA_CHAT_ID_ : getOwnerTelegramChatId_() }, message_id: p.id, text: text };
  if (targetId) msg.reply_to_message = { message_id: targetId };
  WA_SAVE_ONLY_ = !!saveOnly;
  try { handleTelegramMessage_(msg); } finally { WA_SAVE_ONLY_ = false; }
}

function whatsappIsCommand_(text) {
  return /^\/?(?:pendientes|pendiente|pending|por revisar|nuevo|nueva|new|help|ayuda)$/i.test(text) || startsWithEditKeyword_(text) ||
    /^(?:(?:mark\s+as|marcar\s+como)\s+)?(?:repayment|repago)\b|^(?:(?:convert\s+to|convertir\s+en)\s+)?(?:loan|pr[eé]stamo)\b/i.test(text);
}

// A message that is something else than an answer to "send the new …": a command, a new purchase, a pasted bank notice.
function whatsappIsOtherMessage_(text) {
  return whatsappIsCommand_(text) || !!typedReadLine_(text, homeCurrency_()) || !!typedReadByRules_(text);
}

// The value for the field the bot asked about, or null when this message is not one (owner's plan, 2026-11-16: only a value of
// the right shape is taken).
function whatsappValueFor_(field, text) {
  if (field === 'amount') {
    var t = text.replace(/\s/g, '');
    return /^[\d.,]+$/.test(t) && parseTypedAmount_(t) > 0 ? t : null;
  }
  if (field === 'date') return parseTypedDate_(text) ? text : null;
  if (field === 'description') return text && !whatsappIsOtherMessage_(text) ? text : null;
  return null;
}

// The answer to an open "send the new amount / description / date" question (both bots). True when this message was it (or was
// asked again); false when it is a message of its own, to be handled normally.
function botAwaitingText_(text, p) {
  var w = whatsappAwaitingRaw_();
  if (!w || p.context_id) return false;
  var age = Date.now() - Number(w.at);
  var value = whatsappValueFor_(w.word, text);
  if (age < WA_AWAIT_MS_) {
    if (value !== null) {
      whatsappClearAwaiting_();
      whatsappEngineMessage_(p, w.word + ' ' + value, whatsappCardFor_(w.entryId), true);
      botTourNote_('edited', w.entryId);
      return true;
    }
    // Not a value: re-ask, unless it is a message of its own (then it is handled and the question stays open).
    if (!whatsappIsOtherMessage_(text)) { botText_(whatsappAskText_(w.word), p.id); return true; }
    return false;
  }
  whatsappClearAwaiting_();
  if (age < WA_EXPIRED_MS_ && value !== null && w.word !== 'description') {
    botText_(tr_('whatsapp.expired', { field: tr_('whatsapp.f.' + w.word) }), p.id);
    return true;
  }
  return false;
}

function whatsappTextIn_(text, p) {
  if (botAwaitingText_(text, p)) return;
  if (botFillerWord_(text)) return botText_(tr_('bot.fillerHint'), p.id);   // "ok", "gracias"…: never a transaction's new text (BotTour.gs)
  if (p.context_id && whatsappCardEntry_(p.context_id)) return whatsappEngineMessage_(p, text, p.context_id);
  // General help (owner, 2026-11-16): "ayuda" / "help" / "menú" not replying to a transaction says what the bot can do. As a
  // reply to a transaction, "help" stays that transaction's reply words (the branch above).
  if (/^\/?(?:help|ayuda|men[uú]|\?)$/i.test(text)) return botText_(tr_('whatsapp.help'), p.id);
  if (/^\/?(?:pendientes|pendiente|pending|por revisar)$/i.test(text)) return whatsappSendPending_(0);
  if (/^\/?(?:nuevo|nueva|new)$/i.test(text)) return botText_(tr_('whatsapp.newHow'), p.id);
  if (whatsappIsCommand_(text)) {
    // A reply to a message that is not about a transaction must not edit the newest one by surprise.
    if (p.context_id) return botText_(tr_('bot.replyToACard'), p.id);
    return whatsappEngineMessage_(p, text, p.lastTarget || null);
  }
  // Not a reply, and not a purchase or a bank notice: about the transaction of the bot's last message, as on Telegram (plain words
  // are its description there too). A text with an amount is still a new purchase: typing is how a purchase is added here.
  var last = p.context_id ? '' : p.lastTarget;
  if (last && !typedReadLine_(text, homeCurrency_()) && !typedReadByRules_(text)) return whatsappEngineMessage_(p, text, last);
  whatsappNewPurchase_(text, p);
}

// Telegram is the review bot: WhatsApp only adds (the shared block, TypedEntry.gs); the relay sends the one reply.
function whatsappCaptureOnly_(p) {
  telegramTagAskAfter_ = '';
  var r = newTypedEntry_(p, 'whatsapp');
  telegramTagAskAfter_ = '';
  return r;
}

// A new transaction in one message: the shared block (TypedEntry.gs), then its message with its buttons, the engine's note,
// and the tag question when the keywords confirmed it — the same steps as Telegram's telegramNewTypedEntry_.
function whatsappNewPurchase_(text, p) {
  telegramTagAskAfter_ = '';
  var r = newTypedEntry_(p, 'whatsapp');
  if (!r.saved || !r.entry) { telegramTagAskAfter_ = ''; return botText_(r.reply, p.id); }
  var card = sendTelegramEntryNotification_(r.entry, r.categoryName);
  botTourNote_('newEntry', r.entry.id);
  var cardId = card && card.ok ? card.result.message_id : '';
  if (r.editMessage) botText_(r.editMessage, cardId || p.id);
  if (telegramTagAskAfter_) { sendTelegramTagAsk_(WA_CHAT_ID_, telegramTagAskAfter_, cardId || null); sendTelegramPlanAsk_(WA_CHAT_ID_, telegramTagAskAfter_, cardId || null); }
  telegramTagAskAfter_ = '';
}

function whatsappTap_(id, p) {
  var parts = id.split(':');
  var action = parts[0], entryId = parts[1] || '';
  whatsappClearAwaiting_();   // any tap cancels an open "send the new …" question (a field tap asks again)
  if (/^(?:confirm|discard|waitpay|ptags|ptagsno|plink|plinkno|delrep)$/.test(action)) {
    var cardId = p.context_id || whatsappCardFor_(entryId);
    return handleTelegramCallback_({ id: 'whatsapp', data: id, message: { chat: { id: WA_CHAT_ID_ }, message_id: cardId } });
  }
  return botListTap_(id, p);
}

// A tap on a shared list (WhatsApp or Telegram).
function botListTap_(id, p) {
  var parts = id.split(':');
  var action = parts[0], entryId = parts[1] || '';
  whatsappClearAwaiting_();
  botTourNote_(action === 'wapick' ? 'edited' : 'touched', entryId);
  if (action === 'waedit') return whatsappEditMenu_(entryId, p.context_id);
  if (action === 'wafield') return whatsappField_(entryId, parts[2], p.id);
  if (action === 'wapage') return whatsappPickList_(entryId, parts[2], Number(parts[3]) || 0, p.id);
  if (action === 'wapick') return whatsappPick_(entryId, parts[2], parts.slice(3).join(':'), p);
  if (action === 'wahelp') return whatsappOtherChanges_(entryId, p);
  if (action === 'wamore') return parts[1] === 'catch' ? whatsappCatchUp_(true) : whatsappSendPending_(Number(parts[2]) || 0);
  if (action === 'waconv') return whatsappFriendList_(entryId, parts[2], 0, p.id);
  if (action === 'wafp') return whatsappFriendList_(entryId, parts[2], Number(parts[3]) || 0, p.id);
  if (action === 'wacv') return whatsappConvert_(entryId, parts[2], parts.slice(3).join(':'), p);
  if (action === 'wacvx') return botText_(tr_('whatsapp.someoneElseHow'), p.id);
  botText_(tr_('bot.tooOld'), p.id);
}

// ---- receipt photos (2026-11-16: the same reader as Telegram, PhotoCapture.gs) ----
// A photo is queued for the Mac Mini's reader exactly like a Telegram photo; the job's file id is "wa:<media id>", and the Mac's
// getPhotoJob downloads it through the relay (/media), which holds the WhatsApp token. The answers ("queued", the card, "not a
// receipt") go through the engine's replies, so they come on WhatsApp. Only a copy with a photo reader (the owner's Mac helper)
// accepts photos; any other copy says so.
function whatsappPhotoReaderReady_() {
  return !isFriendCopy_() || !!PropertiesService.getScriptProperties().getProperty('HELPER_KEY');
}

function whatsappPhotoIn_(p) {
  if (!whatsappPhotoReaderReady_()) return botText_(tr_('whatsapp.photoNoReader'), p.id);
  enqueuePhotoJob_('wa:' + p.media_id, WA_CHAT_ID_, p.id);
  photoReply_(WA_CHAT_ID_, p.id, tr_('photo.queued'));
}

// { mime, base64 } of a photo the person sent, through the relay; null when it cannot be had (too old, relay down).
function whatsappDownloadMedia_(mediaId) {
  try {
    var res = UrlFetchApp.fetch(whatsappRelayUrl_() + '/media', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Relay-Secret': waProp_(WHATSAPP_SECRET_PROP_) },
      payload: JSON.stringify({ id: String(mediaId) })
    });
    var j = JSON.parse(res.getContentText()) || {};
    return j.base64 ? { mime: String(j.mime || 'image/jpeg'), base64: String(j.base64) } : null;
  } catch (err) {
    return null;
  }
}

// ---- cards ----

// The newest card of an entry on the review bot of the moment (its message id), or ''.
function whatsappCardFor_(entryId) {
  var wa = botIsWa_();
  var rows = getAllRows('Telegram Messages').filter(function (m) { return m.entry_id === entryId && isWamid_(m.message_id) === wa; });
  return rows.length ? String(rows[rows.length - 1].message_id) : '';
}
// The bot's last message, when it is about a transaction (its message id), else ''.
function whatsappLastTarget_() {
  var id = waProp_('WA_LAST_OUT');
  return id && whatsappCardEntry_(id) ? id : '';
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
  botTourNote_('pending');
  var list = whatsappPendingEntries_().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  if (!list.length) return botText_(tr_('whatsapp.nothingWaiting'));
  list.slice(offset, offset + WA_CARDS_PER_BATCH_).forEach(function (e) { sendTelegramEntryNotification_(e); });
  var left = list.length - offset - WA_CARDS_PER_BATCH_;
  if (left > 0) {
    botChoices_(tr_('whatsapp.moreWaiting', { n: left }), [{ id: 'wamore:pend:' + (offset + WA_CARDS_PER_BATCH_), title: tr_('whatsapp.showMore') }], null, true);
  }
}

// Waiting entries since the switch that never got a WhatsApp message, oldest first: those made while the window was closed, and
// any other (a waiting entry made in the app, e.g. a repayment's extra; a message WhatsApp refused). The sentence "came in while
// I couldn't write to you" only when the window really was closed (found live 2026-11-16: it showed with the window open).
// A message that fails WA_CARD_MAX_FAILS_ times is not retried with every message (it stays in Needs review).
var WA_CARD_MAX_FAILS_ = 3;
function whatsappCardFails_() {
  try { return JSON.parse(waProp_('WA_CARD_FAILS') || '{}') || {}; } catch (err) { return {}; }
}
function whatsappNoteCardFail_(entryId) {
  var fails = whatsappCardFails_();
  fails[entryId] = (fails[entryId] || 0) + 1;
  var keys = Object.keys(fails);
  if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(function (k) { delete fails[k]; });
  waSetProp_('WA_CARD_FAILS', JSON.stringify(fails));
}

function whatsappCatchUp_(more, wasClosed) {
  var since = waProp_('WA_SWITCH_AT');
  if (!since) return 0;
  var carded = {};
  getAllRows('Telegram Messages').forEach(function (m) { if (isWamid_(m.message_id)) carded[m.entry_id] = true; });
  var fails = whatsappCardFails_();
  var missed = whatsappPendingEntries_().filter(function (e) {
    return !carded[e.id] && String(e.created_at) >= since && (fails[e.id] || 0) < WA_CARD_MAX_FAILS_;
  }).sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
  if (!missed.length) {
    if (more) botText_(tr_('whatsapp.nothingWaiting'));
    return 0;
  }
  if (!more && wasClosed) botText_(tr_('whatsapp.catchUp', { n: missed.length }));
  missed.slice(0, WA_CARDS_PER_BATCH_).forEach(function (e) {
    var res = sendTelegramEntryNotification_(e);
    if (!res || !res.ok) whatsappNoteCardFail_(e.id);
  });
  var left = missed.length - WA_CARDS_PER_BATCH_;
  if (left > 0) botChoices_(tr_('whatsapp.moreWaiting', { n: left }), [{ id: 'wamore:catch', title: tr_('whatsapp.showMore') }], null, true);
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
  if (!entry) return botText_(tr_('bot.entryGone'), replyTo);
  var rows = whatsappEditFields_(entry).map(function (f) { return { id: 'wafield:' + entryId + ':' + f, title: tr_('whatsapp.f.' + f) }; });
  if (entry.status === 'pending' && waitingMatchForPending_(entry, listWaitingIncome_())) rows.push({ id: 'waitpay:' + entryId, title: tr_('whatsapp.f.waiting') });
  if (whatsappCanConvert_(entry)) {
    rows.push({ id: 'waconv:' + entryId + ':r', title: tr_('whatsapp.f.repayment') });
    rows.push({ id: 'waconv:' + entryId + ':l', title: tr_('whatsapp.f.loan') });
  }
  rows.push({ id: 'wahelp:' + entryId, title: tr_('whatsapp.f.more'), description: tr_('whatsapp.f.moreHint') });
  botChoices_(tr_('whatsapp.editAsk', { what: entry.description || tr_('bot.noDescription') }), rows, replyTo);
}

function whatsappField_(entryId, field, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), replyTo);
  if (field === 'amount' || field === 'description' || field === 'date') {
    waSetProp_('WA_AWAIT', JSON.stringify({ entryId: entryId, word: WA_FIELD_WORDS_[field], at: Date.now() }));
    return botText_(whatsappAskText_(field), replyTo);
  }
  whatsappPickList_(entryId, field, 0, replyTo);
}

// "Send the new …", with a date example in the person's own date order (the engine reads dates that way, parseTypedDate_).
function whatsappAskText_(field) {
  var order = userDateOrder_();
  var example = order === 'mdy' ? '11/15/2026' : order === 'ymd' ? '2026/11/15' : '15/11/2026';
  return tr_('whatsapp.ask.' + field, field === 'date' ? { example: example } : null);
}

function whatsappAwaitingRaw_() {
  var raw = waProp_('WA_AWAIT');
  if (!raw) return null;
  try { var w = JSON.parse(raw); return w && w.entryId ? w : null; } catch (err) { return null; }
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

// Owner, 2026-11-16: the most used first, but arranged A-Z so the list has some logic; then all the others, A-Z.
function botTopThenAz_(items, top) {
  var az = function (a, b) { return String(a.label).localeCompare(String(b.label)); };
  return items.slice(0, top).sort(az).concat(items.slice(top).sort(az));
}

function whatsappPickList_(entryId, field, page, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), replyTo);
  var items = botTopThenAz_(whatsappChoices_(entry, field), WA_LIST_PAGE_);
  if (!items.length) return botText_(tr_('whatsapp.pickNone'), replyTo);
  // WhatsApp: 9 a page + "More…" (its lists hold 10 rows). Telegram has no such limit: one page with everything (owner).
  var size = botIsWa_() ? WA_LIST_PAGE_ : items.length;
  var start = page * size;
  var rows = items.slice(start, start + size).map(function (it) { return { id: 'wapick:' + entryId + ':' + field + ':' + it.id, title: it.label }; });
  if (items.length > start + size) rows.push({ id: 'wapage:' + entryId + ':' + field + ':' + (page + 1), title: tr_('whatsapp.more') });
  botChoices_(tr_('whatsapp.pickAsk', { field: tr_('whatsapp.f.' + field), what: entry.description || tr_('bot.noDescription') }), rows, replyTo);
}

// A pick runs the same reply command a person would type ("category Restaurants"), so every rule of the engine applies. Two
// items with the same name could not be told apart by name: then the id is written directly and the card is sent again.
function whatsappPick_(entryId, field, itemId, p) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), p.id);
  var items = whatsappChoices_(entry, field);
  var it = items.find(function (x) { return String(x.id) === String(itemId); });
  if (!it) return botText_(tr_('whatsapp.optionGone'), p.id);
  var same = items.filter(function (x) { return normalizeName_(x.name) === normalizeName_(it.name); }).length;
  if (same > 1 && field === 'category') {
    setEntryField_(entryId, 'category_id', it.id);
    return sendTelegramEntryNotification_(getEntryById_(entryId));
  }
  var target = whatsappCardFor_(entryId);
  if (!target) { sendTelegramEntryNotification_(entry); target = whatsappCardFor_(entryId); }
  whatsappEngineMessage_(p, WA_FIELD_WORDS_[field] + ' ' + it.name, target, true);
}

// "Other changes" (owner, 2026-11-16): only the reply words the Edit list does not already offer as rows. "help" replied to a
// transaction still gives the full list (Telegram's telegramEditHelpText_).
function whatsappOtherChanges_(entryId, p) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), p.id);
  var keys;
  if (entry.type === 'transfer') keys = ['currency', 't.category', 'label', 't.type', '', 'wa:t'];
  else if (entry.type === 'investment') keys = ['i.direction', 'i.paymentMethod', 'i.receivedAt', 'currency', 'label', 'i.type', '', 'wa:i'];
  else {
    keys = ['o.paidBy', 'currency', 'label', 'o.split', 'o.type', '', 'wa:o', 'o.names'];
    if (entry.type === 'expense' && getTripRows_().length) keys.splice(keys.indexOf('o.split'), 0, 'trip');
  }
  // 'wa:x' = a "combine several" example made only of the words listed here (the shared ones also use category, amount…).
  var lines = [tr_('whatsapp.otherIntro')].concat(keys.map(function (k) {
    return k === '' ? '' : k.indexOf('wa:') === 0 ? tr_('whatsapp.otherCombine.' + k.slice(3)) : tr_('help.' + k);
  }), ['', tr_('help.bothLanguages')]);
  botText_(lines.join('\n'), whatsappCardFor_(entryId) || p.id);
}

// ---- Edit: Repayment / Loan (owner's plan "WhatsApp Edit and conversions", 2026-11-16) ----

// Same entries the reply words convert (applyTerminalReviewAction_): an expense, an income, a transfer with only one end.
function whatsappCanConvert_(entry) {
  if (entry.type === 'expense' || entry.type === 'income') return true;
  return entry.type === 'transfer' && (!!entry.payment_method_id !== !!entry.to_payment_method_id);
}
function whatsappIncoming_(entry) {
  return entry.type === 'income' || (entry.type === 'transfer' && !!entry.to_payment_method_id && !entry.payment_method_id);
}

// Friends for a conversion: the trip's group first (during a trip), then those with an open debt in the direction that fits a
// repayment, then by the latest loan, then by name. Trip groups of other trips are left out. Only existing friends: new friends
// are added in the app (owner, 2026-11-16).
function whatsappFriendChoices_(entry, kind) {
  var incoming = whatsappIncoming_(entry);
  var tripId = suggestedTripIdForDate_(entry.date);
  var group = tripId ? tripGroupFriend_(tripId) : null;
  var settled = buildSettlementTotalsByLoan_();
  var owed = {}, lastUse = {};
  getAllRows('Loans').forEach(function (l) {
    if (String(l.date || '') > String(lastUse[l.friend_id] || '')) lastUse[l.friend_id] = String(l.date || '');
    if (l.status === 'forgiven') return;
    var left = Number(l.amount) - (settled[l.id] || 0);
    if (left <= 0.004) return;
    var fits = incoming ? l.direction === 'they_owe_me' : l.direction === 'i_owe_them';
    var key = l.friend_id + '|' + l.currency;
    if (fits) owed[key] = (owed[key] || 0) + left;
  });
  var owedText = function (friendId) {
    var keys = Object.keys(owed).filter(function (k) { return k.split('|')[0] === String(friendId); });
    if (!keys.length) return '';
    var k = keys[0];
    return tr_(incoming ? 'whatsapp.owesYou' : 'whatsapp.youOwe', { amount: formatAmountText_(owed[k], k.split('|')[1]) });
  };
  var friends = getAllRows('Friends').filter(function (f) { return !f.trip_id || (group && f.id === group.id); });
  return friends.map(function (f) {
    var debt = kind === 'r' ? owedText(f.id) : '';
    return { id: f.id, name: f.name, isGroup: !!(group && f.id === group.id), debt: debt, last: lastUse[f.id] || '',
      description: group && f.id === group.id ? tr_('whatsapp.tripGroup') : debt };
  }).sort(function (a, b) {
    return (b.isGroup - a.isGroup) || ((b.debt ? 1 : 0) - (a.debt ? 1 : 0)) || b.last.localeCompare(a.last) || String(a.name).localeCompare(String(b.name));
  });
}

function whatsappFriendList_(entryId, kind, page, replyTo) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), replyTo);
  var items = whatsappFriendChoices_(entry, kind);
  // WhatsApp: 8 a page + "More…" + "Someone else" (its 10 rows; owner 2026-11-16). Telegram: one page with every friend.
  var size = botIsWa_() ? WA_FRIEND_PAGE_ : items.length;
  var start = page * size;
  var rows = items.slice(start, start + size).map(function (f) {
    return { id: 'wacv:' + entryId + ':' + kind + ':' + f.id, title: f.name, description: f.description };
  });
  if (items.length > start + size) rows.push({ id: 'wafp:' + entryId + ':' + kind + ':' + (page + 1), title: tr_('whatsapp.more') });
  rows.push({ id: 'wacvx:' + entryId, title: tr_('whatsapp.someoneElse') });
  botChoices_(tr_('whatsapp.pickFriend', { kind: tr_(kind === 'r' ? 'whatsapp.f.repayment' : 'whatsapp.f.loan') }), rows, replyTo);
}

// Straight away, like the reply words (owner, 2026-11-16): the engine's own conversion and its own answer.
function whatsappConvert_(entryId, kind, friendId, p) {
  var friend = getAllRows('Friends').find(function (f) { return String(f.id) === String(friendId); });
  if (!getEntryById_(entryId)) return botText_(tr_('bot.entryGone'), p.id);
  if (!friend) return botText_(tr_('whatsapp.optionGone'), p.id);
  var res = applyTerminalReviewAction_(entryId, kind === 'r' ? 'repayment' : 'loan', friend.name, friend);
  botText_(res.message, whatsappCardFor_(entryId) || p.id);
}

// ---- Telegram: the same commands as WhatsApp (owner, 2026-11-16) ----
// Called by handleTelegramMessage_ for a real Telegram message (not a reply). True when it was one of the shared commands or the
// answer to an open "send the new …" question.
function telegramSharedCommand_(msg, text) {
  var p = { id: msg.message_id };
  if (botAwaitingText_(text, p)) return true;
  if (/^\/?(?:help|ayuda|men[uú]|\?)$/i.test(text)) { botText_(tr_('bot.helpGeneral'), msg.message_id); return true; }
  if (/^\/?(?:pendientes|pendiente|pending|por revisar)$/i.test(text)) { whatsappSendPending_(0); return true; }
  if (/^\/?(?:nuevo|nueva|new)$/i.test(text)) { botText_(tr_('whatsapp.newHow'), msg.message_id); return true; }
  return false;
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
  var res = botText_(waiting ? tr_('whatsapp.nudgeWaiting', { n: waiting }) : tr_('whatsapp.nudge'));
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
