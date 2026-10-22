/**
 * "Delete everything" (More → Delete everything; friends' copies only).
 *
 * This is step 1 of 2. The app's own backend has no Drive permission, so it cannot delete the Google Sheet or
 * itself; what it CAN do is empty the Sheet, stop every timer, forget the settings (including the sign-in code),
 * sign every device out and take back its own Google permission (ScriptApp.invalidateAuth). Step 2 is the installer
 * page (docs/setup/, "#remove"), which has Drive access to the files it made and deletes the Sheet and the app, then
 * removes its own permission. Even if step 2 never happens, nothing of the person's is left in the Sheet.
 *
 * Refused on the owner's own copy and on a request that does not carry confirm:true.
 */
function eraseEverything(payload) {
  if (!isFriendCopy_()) {
    var denied = new Error(tr_('erase.ownerCopy'));
    denied.code = 'not_allowed';
    throw denied;
  }
  if (!payload || payload.confirm !== true) {
    var unconfirmed = new Error(tr_('erase.notConfirmed'));
    unconfirmed.code = 'not_confirmed';
    throw unconfirmed;
  }
  // Sign everybody out first: this also kills the cached "valid" markers, so no device keeps working on the old key.
  revokeSessionsWhere_(function () { return true; });
  // Stop every timer (the keep-awake ping, the bank-e-mail scan, any other).
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  // Empty every tab, headers included (the Sheet itself is deleted by the installer page afterwards).
  var tabs = 0;
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) { sheet.clear(); tabs++; });
  // Forget every setting: the sign-in code, the sign-in key, the Telegram link, the app's own address.
  PropertiesService.getScriptProperties().deleteAllProperties();
  // Last: take back this app's own permission to use the person's Google account. Anything after this would fail.
  var revoked = false;
  try { ScriptApp.invalidateAuth(); revoked = true; } catch (err) { Logger.log('invalidateAuth failed: ' + err); }
  return { erased: true, tabs: tabs, permissionRevoked: revoked };
}
