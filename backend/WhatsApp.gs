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
  // Not set up = closed (unlike Telegram's older door, which stayed open until protected).
  return stored.length >= 24 && String((body && body.relay_secret) || '') === stored;
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
