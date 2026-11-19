/**
 * WhatsApp capture (owner's request, 2026-11-16; specs/review-telegram-email.md § WhatsApp capture).
 *
 * The person writes to the app's WhatsApp Business number (Meta's free Cloud API). Meta calls a webhook; the Cloudflare Worker
 * `cloudflare-worker/whatsapp-relay.js` answers Meta's verification check, checks Meta's signature and that the message comes
 * from the person's own number, then forwards the text here with a shared secret (the web app's address is public and Apps Script
 * cannot read headers, so the secret travels in the body, the same way as the Telegram relay). The Worker sends our answer back
 * on WhatsApp.
 *
 * Reading and saving a typed transaction is the shared building block in TypedEntry.gs (the same for Telegram).
 */
var WHATSAPP_SECRET_PROP_ = 'WHATSAPP_RELAY_SECRET';

function isWhatsAppRelayAuthorized_(body) {
  var stored = String(PropertiesService.getScriptProperties().getProperty(WHATSAPP_SECRET_PROP_) || '');
  // Not set up = closed (unlike Telegram's older door, which stayed open until protected); turned off = closed.
  return stored.length >= 24 && String((body && body.relay_secret) || '') === stored && whatsappBotOn_();
}

// ---- The bot for friends (owner's plan "WhatsApp bot for friends (Mia first)", approved 2026-11-16) ----
// Off and invisible by default (optional-packs rule). The owner's copy always has it; a friend's copy only when the owner marks it
// (Settings `whatsapp_offered` = yes). The person turns it on in More → My profile → WhatsApp bot, with their WhatsApp number:
// the copy makes its own relay key, switches its review bot to WhatsApp and shows a code ("WA1 <number> <address> <key>") that
// the person sends the owner; the owner adds that line to the relay's WA_ROUTES. Off: the copy stops answering; nothing deleted.
var WHATSAPP_OPEN_TO_FRIENDS_ = false;

function whatsappOffered_() {
  if (!isFriendCopy_() || isOwnerCopyByAddress_() || WHATSAPP_OPEN_TO_FRIENDS_) return true;
  return String(getSettingsMap().whatsapp_offered || '').toLowerCase() === 'yes';
}

function whatsappBotOn_() {
  var props = PropertiesService.getScriptProperties();
  var flag = String(props.getProperty('WHATSAPP_BOT') || '');
  if (flag) return flag === 'on' && whatsappOffered_();
  return !!props.getProperty(WHATSAPP_SECRET_PROP_);   // set up from the Sheet menu before this switch existed (the owner's copy)
}

function getWhatsAppBot() {
  if (!whatsappOffered_()) return { offered: false };
  var props = PropertiesService.getScriptProperties();
  var on = whatsappBotOn_();
  var number = String(props.getProperty('WA_OWNER_NUMBER') || props.getProperty('WA_INVITED_NUMBER') || '');   // invited: filled in
  var key = String(props.getProperty(WHATSAPP_SECRET_PROP_) || '');
  var url = getWebAppUrl_();
  if (!url) { try { url = String(ScriptApp.getService().getUrl() || ''); } catch (err) { url = ''; } }   // not learned yet: Google's own answer
  return { offered: true, on: on, number: number, code: on && key && number && url ? ['WA1', number, url, key].join(' ') : '' };
}

function turnOnWhatsAppBot(payload) {
  if (!whatsappOffered_()) throw codedError_('feature_off', tr_('whatsappBot.off'));
  var number = String((payload && payload.number) || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) throw codedError_('bad_number', tr_('whatsappBot.badNumber'));
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty(WHATSAPP_SECRET_PROP_) || '').length < 24) props.setProperty(WHATSAPP_SECRET_PROP_, generateAccessCode_());
  props.setProperty('WA_OWNER_NUMBER', number);
  props.setProperty('WHATSAPP_BOT', 'on');
  if (props.getProperty('REVIEW_BOT') !== 'whatsapp') {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    props.setProperty('WA_SWITCH_AT', Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss"));
    props.setProperty('REVIEW_BOT', 'whatsapp');
  }
  return getWhatsAppBot();
}

function turnOffWhatsAppBot() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('WHATSAPP_BOT', 'off');
  props.deleteProperty('REVIEW_BOT');
  return getWhatsAppBot();
}

// ---- Invitation codes (owner's plan "WhatsApp invitation code", approved 2026-11-19) ----
// Instead of the Settings row typed in the friend's Sheet: the owner's app makes a code from the friend's WhatsApp number, the
// friend types code + number in Feedback & privacy → Extra features, and the copy marks itself (the same `whatsapp_offered` row).
// The code is the number's fingerprint, so every copy can check it with nothing stored; a code only works with its own number.
// It is not a secret (the recipe is in this public code): it only shows the card. Using the bot still needs the owner to add
// the number in Meta and the route in Cloudflare.
var WA_INVITE_LETTERS_ = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L: easy to read out and type

function whatsappInviteCode_(number) {
  var digits = String(number || '').replace(/\D/g, '');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'expense-tracker-whatsapp-invite-v1:' + digits);
  var out = '';
  for (var i = 0; i < 8; i++) out += WA_INVITE_LETTERS_.charAt(((bytes[i] % 256) + 256) % 256 % WA_INVITE_LETTERS_.length);
  return 'WA-' + out.slice(0, 4) + '-' + out.slice(4);
}

function whatsappInviteNumber_(payload) {
  var number = String((payload && payload.number) || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) throw codedError_('bad_number', tr_('whatsappBot.badNumber'));
  return number;
}

// The owner's copy only (the one that runs the relay).
function canMakeWhatsAppInvites_() { return !isFriendCopy_() || isOwnerCopyByAddress_(); }

function makeWhatsAppInvite(payload) {
  if (!canMakeWhatsAppInvites_()) throw codedError_('feature_off', tr_('whatsappBot.off'));
  var number = whatsappInviteNumber_(payload);
  return { number: number, code: whatsappInviteCode_(number) };
}

function useWhatsAppInvite(payload) {
  var number = whatsappInviteNumber_(payload);
  var typed = String((payload && payload.code) || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (typed !== whatsappInviteCode_(number).replace(/-/g, '')) throw codedError_('bad_invite', tr_('whatsappBot.inviteWrong'));
  var already = whatsappOffered_();
  if (String(getSettingsMap().whatsapp_offered || '').toLowerCase() !== 'yes') setSetting_('whatsapp_offered', 'yes');
  PropertiesService.getScriptProperties().setProperty('WA_INVITED_NUMBER', number);
  return { already: already, bot: getWhatsAppBot() };
}

// Sheet menu: paste the relay key (the same value as WA_RELAY_SECRET in Cloudflare and in the private secrets file).
function promptSetWhatsAppRelaySecret() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('WhatsApp relay key',
    'Paste the WA_RELAY_SECRET value (the same one you put in Cloudflare). Leave empty and press OK to switch WhatsApp capture off.',
    ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  var key = result.getResponseText().trim();
  var props = PropertiesService.getScriptProperties();
  if (!key) { props.deleteProperty(WHATSAPP_SECRET_PROP_); ui.alert('WhatsApp capture is OFF.'); return; }
  if (key.length < 24) { ui.alert('That key is too short (at least 24 characters). Nothing was changed.'); return; }
  props.setProperty(WHATSAPP_SECRET_PROP_, key);
  ui.alert('Saved. WhatsApp messages from your number will now land in Needs review.');
}
