/**
 * Optional abilities and this copy's own web address (friends & family rollout, stage 1).
 *
 * A friend's copy of the app starts with the basic ability only (read and write
 * its own spreadsheet). "Keep it awake" and "read my bank e-mails" are
 * separate Google approvals the person may or may not give, so the code must
 * work, and say so plainly, when they are missing. The installer writes the
 * Script Property FEATURES ("keepawake,gmail" — whichever were approved).
 *
 *   FEATURES missing  -> everything is on. That is the owner's copy and any old
 *                        install, so nothing changes for them.
 *   FEATURES present  -> only the listed abilities are on ('base' is always on).
 *
 * WEB_APP_URL is this copy's own address (used by the keep-awake ping and as the
 * Telegram webhook fallback). It used to be written into the code, which is
 * wrong for every copy except the owner's. The app tells the backend which
 * address it is using on each signed-in request, and the first one is kept.
 */

function featureOn_(name) {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURES');
  if (raw === null || raw === undefined || String(raw).trim() === '') return true;
  if (name === 'base') return true;
  return String(raw).split(',').map(function (s) { return s.trim(); }).indexOf(name) !== -1;
}

// For things the person asked for directly (they get a plain sentence, in their language).
function requireFeature_(name, stringKey) {
  if (featureOn_(name)) return;
  var err = new Error(tr_(stringKey));
  err.code = 'feature_off';
  throw err;
}

function getWebAppUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '');
}

// Only a real Apps Script web-app address is accepted, and only once (the first signed-in request wins).
function healWebAppUrl_(url) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('WEB_APP_URL')) return;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(url || ''))) return;
  props.setProperty('WEB_APP_URL', String(url));
}

// What this copy can do, for the app to show or hide things.
function getCapabilities_() {
  return {
    emailExport: !!PropertiesService.getScriptProperties().getProperty('EXPORT_EMAIL'),
    bankEmails: featureOn_('gmail'),
    keepAwake: featureOn_('keepawake'),
    telegram: !!getTelegramToken_()
  };
}
