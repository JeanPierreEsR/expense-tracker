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

// True for a copy made by the installer (FEATURES present). The owner's own copy and every old install have no
// FEATURES, so they are never treated as a new person's app (no welcome questions, no sample friends removed).
function isFriendCopy_() {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURES');
  return !(raw === null || raw === undefined || String(raw).trim() === '');
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
// The backend version this copy was installed with: the installer writes INSTALL_BACKEND_REF (docs/setup/Install.gs) = the last
// commit that changed backend/ at install/update time. '' on the owner's own copy, which has no installer file. The app compares it with
// the newest one to offer "Update available" (More → Update).
function installedBackendRef_() {
  var ref = typeof INSTALL_BACKEND_REF === 'undefined' ? '' : String(INSTALL_BACKEND_REF || '');
  return ref.indexOf('__') === 0 ? '' : ref;
}

function getCapabilities_() {
  return {
    backendRef: installedBackendRef_(),
    emailExport: !!PropertiesService.getScriptProperties().getProperty('EXPORT_EMAIL'),
    bankEmails: featureOn_('gmail'),
    keepAwake: featureOn_('keepawake'),
    telegram: !!getTelegramToken_(),
    // More → Performance log is a diagnostic for the owner only; a copy made by the installer never shows it.
    perfLog: !isFriendCopy_(),
    // This backend can say which bank addresses it reads (listSupportedSenders), so the app can tell a friend "your bank is ready".
    bankReady: true,
    // The app shows its welcome questions once, on a copy the installer made, until they are answered (Onboarding.gs).
    onboarding: isFriendCopy_() && String(getSettingsMap().onboarded || '') !== 'yes'
  };
}

// ---- Turning extras off again (More → Extra features; friends' copies only) ----
// The two optional extras can be switched off without deleting anything: the app stops using the ability at once
// (FEATURES loses it; the keep-awake timer is removed; the e-mail steps already check featureOn_). The name is also kept in
// FEATURES_OFF so a later "Update my app" (installApplyCode_ in docs/setup/Install.gs, which rewrites FEATURES from what the
// installer was built with) does not silently turn it back on. Turning one ON again goes through the setup page (the Google
// approval cannot be given from here); its approval visit clears the name from FEATURES_OFF.
var OPT_OUT_EXTRAS_ = ['keepawake', 'gmail'];

function csvList_(raw) {
  return String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function requireFriendCopy_() {
  if (isFriendCopy_()) return;
  var denied = new Error(tr_('erase.ownerCopy'));
  denied.code = 'not_allowed';
  throw denied;
}

function setExtraOff(payload) {
  requireFriendCopy_();
  var name = String((payload && payload.name) || '');
  if (OPT_OUT_EXTRAS_.indexOf(name) === -1) {
    var bad = new Error(tr_('extras.unknown'));
    bad.code = 'bad_request';
    throw bad;
  }
  var props = PropertiesService.getScriptProperties();
  var on = csvList_(props.getProperty('FEATURES')).filter(function (f) { return f !== name && f !== 'base'; });
  props.setProperty('FEATURES', ['base'].concat(on).join(','));
  var off = csvList_(props.getProperty('FEATURES_OFF'));
  if (off.indexOf(name) === -1) off.push(name);
  props.setProperty('FEATURES_OFF', off.join(','));
  if (name === 'keepawake') removeKeepWarmPingTriggers_();
  return { capabilities: getCapabilities_() };
}

// "Take back all permissions, keep my data": every extra off, every timer stopped, and the app's own Google permission
// withdrawn (ScriptApp.invalidateAuth). The Sheet, the entries and the sign-ins stay; the app works again once the person
// approves it on the setup page.
function takeBackPermissions(payload) {
  requireFriendCopy_();
  if (!payload || payload.confirm !== true) {
    var unconfirmed = new Error(tr_('extras.notConfirmed'));
    unconfirmed.code = 'not_confirmed';
    throw unconfirmed;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('FEATURES', 'base');
  props.setProperty('FEATURES_OFF', OPT_OUT_EXTRAS_.join(','));
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var revoked = false;
  try { ScriptApp.invalidateAuth(); revoked = true; } catch (err) { Logger.log('invalidateAuth failed: ' + err); }
  return { permissionRevoked: revoked };
}
