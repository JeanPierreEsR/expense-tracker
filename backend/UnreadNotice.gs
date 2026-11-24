/**
 * The bot says when a bank e-mail with a NEW wording could not be read (owner, 2026-11-24).
 *
 * "Bank emails I couldn't read" (ManualGaps.gs) gets one row per sender + wording; the first time a row is made, the e-mail scan
 * notes it here and, once the scan is done, the review bot (Telegram or WhatsApp) sends one message per new wording, at most
 * UNREAD_NOTICE_MAX_ per scan (a new copy's first scan may find many: the rest is one line).
 *   - Owner's copy: a heads-up, with who forwarded it when a friend did (that is how he finds the rules to build). Only "no rule"
 *     wordings: an e-mail a rule knows but could not read is already in the automation alert.
 *   - A friend's copy: the same heads-up, plus "Show what JP gets": the e-mail is cleaned the way the app's own "send a sample" does
 *     (BankSampleRedact.gs, a copy of docs/bank-sample.js: every digit becomes 9; e-mail addresses, links, names after greetings and
 *     labels, and the person's own names are hidden), shown in the chat, and sent to the owner's copy (reportBankSample, BankSamples.gs)
 *     only after "Send to JP". Nothing leaves without that tap. A forwarded e-mail has no button (its text is inside another e-mail).
 */

var UNREAD_NOTICE_MAX_ = 3;
var UNREAD_SEND_KEY_ = 'UNREAD_SEND';        // { code: { id, sender, subject, at } }: e-mails a friend's bot offered to send
var UNREAD_SEND_KEEP_ = 30;
var UNREAD_CHAT_MAX_ = 3000;                 // what is shown in the chat is exactly what is sent, so both are capped here
var UNREAD_NEW_ = [];                        // this scan's new wordings

function unreadNoteNew_(sender, shape, kind, message) {
  try {
    if (!isFriendCopy_() && kind !== 'no_rule') return;
    var by = message && message.forwardedBy ? String(message.forwardedBy) : '';
    var id = message && message.getId ? String(message.getId()) : '';
    UNREAD_NEW_.push({ sender: sender, shape: shape, kind: kind, by: by, id: /^[A-Za-z0-9_-]{2,64}$/.test(id) && !by ? id : '' });
  } catch (err) { /* a notice must never stop the scan */ }
}

function sendUnreadNotices_() {
  var items = UNREAD_NEW_;
  UNREAD_NEW_ = [];
  if (!items.length) return 0;
  var chatId = getOwnerTelegramChatId_();
  if (!reviewBotCanSend_(chatId)) return 0;
  var friend = isFriendCopy_();
  items.slice(0, UNREAD_NOTICE_MAX_).forEach(function (u) {
    var text = tr_(u.kind === 'unreadable' ? 'bot.unreadBroken' : 'bot.unreadNew', {
      sender: u.sender, subject: u.shape || '-', by: u.by ? tr_('bot.unreadBy', { by: u.by }) : '' });
    var payload = { chat_id: chatId, text: text };
    if (friend && u.id) {
      payload.text += tr_('bot.unreadAsk');
      payload.reply_markup = { inline_keyboard: [[{ text: tr_('bot.unreadShowButton'), callback_data: 'unrshow:' + unreadRemember_(u) }]] };
    }
    telegramApi_('sendMessage', payload);
  });
  if (items.length > UNREAD_NOTICE_MAX_) telegramApi_('sendMessage', { chat_id: chatId, text: tr_('bot.unreadMore', { n: items.length - UNREAD_NOTICE_MAX_ }) });
  return Math.min(items.length, UNREAD_NOTICE_MAX_);
}

function unreadSendMap_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(UNREAD_SEND_KEY_) || '{}') || {}; } catch (e) { return {}; }
}

// A short code for the button (Telegram allows 64 characters of button data); the newest UNREAD_SEND_KEEP_ are kept.
function unreadRemember_(u) {
  var map = unreadSendMap_();
  var code = Utilities.getUuid().replace(/-/g, '').substring(0, 10);
  map[code] = { id: u.id, sender: u.sender, at: Date.now() };
  var codes = Object.keys(map).sort(function (a, b) { return map[b].at - map[a].at; });
  codes.slice(UNREAD_SEND_KEEP_).forEach(function (c) { delete map[c]; });
  PropertiesService.getScriptProperties().setProperty(UNREAD_SEND_KEY_, JSON.stringify(map));
  return code;
}

// The cleaned text, exactly as it would be sent: { subject, text } or null when the e-mail is gone.
function unreadCleaned_(item) {
  var m;
  try { m = gmailGetMessage_(item.id); } catch (e) { return null; }
  if (!m) return null;
  var hide = ownerNamesList_().join(', ');
  var clean = function (s, max) { return BankSample.redact(s, { sender: item.sender, hide: hide, maxChars: max }); };
  return { subject: clean(String(m.getSubject() || ''), BANK_SAMPLE_MAX_SUBJECT_), text: clean(String(m.getPlainBody() || ''), UNREAD_CHAT_MAX_) };
}

// The id the owner's copy counts this copy's samples by (its Bank Samples tab, its per-phone daily limit). Random, made once.
function unreadInstallId_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOT_SAMPLE_INSTALL');
  if (!id) { id = Utilities.getUuid(); props.setProperty('BOT_SAMPLE_INSTALL', id); }
  return id;
}

function unreadSendToOwner_(item, cleaned) {
  var names = ownerNamesList_();
  var label = names.length ? names[0].split(/\s+/)[0] : '';
  var res = UrlFetchApp.fetch('https://script.google.com/macros/s/' + OWNER_WEB_APP_ID_ + '/exec', {
    method: 'post', contentType: 'text/plain;charset=utf-8', muteHttpExceptions: true, followRedirects: true,
    payload: JSON.stringify({ action: 'reportBankSample', payload: {
      install: unreadInstallId_(), label: label, sender: item.sender, subject: cleaned.subject, text: cleaned.text,
      language: currentLang_(), app: '', how: 'bot' } })
  });
  var out;
  try { out = JSON.parse(res.getContentText()); } catch (e) { out = null; }
  if (!(out && out.ok)) throw new Error(out && out.code === 'sample_busy' ? 'busy' : 'failed');
}

// A tap on one of the buttons (Telegram, or WhatsApp through whatsappTap_).
function unreadTap_(cb) {
  var parts = String(cb.data).split(':');
  var action = parts[0], code = parts[1] || '';
  var chatId = cb.message.chat.id, msgId = cb.message.message_id;
  var say = function (text, markup) {
    var p = { chat_id: chatId, text: text, reply_to_message_id: msgId, allow_sending_without_reply: true };
    if (markup) p.reply_markup = markup;
    return telegramApi_('sendMessage', p);
  };
  var item = unreadSendMap_()[code];
  if (!item || !isFriendCopy_()) {
    say(tr_('bot.unreadGone'));
  } else if (action === 'unrno') {
    say(tr_('bot.unreadNotSent'));
  } else {
    var cleaned = unreadCleaned_(item);
    if (!cleaned) {
      say(tr_('bot.unreadGone'));
    } else if (action === 'unrshow') {
      say(tr_('bot.unreadPreview', { text: cleaned.text }));
      say(tr_('bot.unreadPreviewAsk'), { inline_keyboard: [[
        { text: tr_('bot.unreadSendButton'), callback_data: 'unrsend:' + code },
        { text: tr_('bot.unreadNoButton'), callback_data: 'unrno:' + code }]] });
    } else {
      try {
        unreadSendToOwner_(item, cleaned);
        var map = unreadSendMap_();
        delete map[code];   // sent once: a second tap does not send it again
        PropertiesService.getScriptProperties().setProperty(UNREAD_SEND_KEY_, JSON.stringify(map));
        say(tr_('bot.unreadSent'));
      } catch (err) {
        say(tr_(String(err.message) === 'busy' ? 'bot.unreadBusy' : 'bot.unreadSendFailed'));
        telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
        return;   // the buttons stay, so it can be tried again
      }
    }
  }
  removeCardButtons_(chatId, msgId);
  telegramApi_('answerCallbackQuery', { callback_query_id: cb.id });
}
