/**
 * The bot's own tour (owner's plan "Bot tutorial - WhatsApp and Telegram", 2026-11-20; specs/review-telegram-email.md § Bot tour).
 * The bot teaches itself, in the chat, one short message per step, and moves on when the person really does the step:
 *   1 write an expense ("25 almuerzo"; "prueba" makes a test one instead) → 2 its card: tap Edit and change the category
 *   ("saltar" skips) → 3 tap Confirm (test: Discard) → 4 reply to it in words, two keywords at once ("descripción …, monto 30";
 *   left out when the transaction is gone) → 5 write "pendientes" → 6 tips, done.
 * Starts by itself on a friend's copy with the first message ever sent to the WhatsApp bot; "tutorial" starts it on any copy and
 * on both bots. Nothing is blocked: every message is handled as usual, and only then does the tour look at what happened. A
 * message that did not fit repeats the step once; two in a row stop the tour. "salir" stops it. It ends by itself after 24 hours
 * without a step (WhatsApp's window anyway). The tour records nothing of its own: the expense is a normal waiting entry.
 * State: Script Property BOT_TOUR = { v, step, at, misses, entryId, test, oneDone }; BOT_TOUR_DONE = the day it was finished or exited.
 */
var BOT_TOUR_MAX_AGE_MS_ = 24 * 3600000;
// What happened during the message being handled (reset by botTourBefore_, read by botTourAfter_).
var BOT_TOUR_EV_ = null;

function botTourState_() {
  var raw = PropertiesService.getScriptProperties().getProperty('BOT_TOUR');
  if (!raw) return null;
  try {
    var st = JSON.parse(raw);
    if (!st || !st.step || Date.now() - Number(st.at) > BOT_TOUR_MAX_AGE_MS_) { botTourEnd_(false); return null; }
    if (!st.v) { st.v = 2; if (st.step >= 4) st.step++; }   // a tour started before the "reply in words" step (2.41.0)
    return st;
  } catch (err) { return null; }
}
function botTourSave_(st) {
  st.at = Date.now();
  st.v = 2;
  PropertiesService.getScriptProperties().setProperty('BOT_TOUR', JSON.stringify(st));
}
// done: finished or exited by the person (it then counts as taught, like the app's tutorials).
function botTourEnd_(done) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('BOT_TOUR');
  if (done) props.setProperty('BOT_TOUR_DONE', Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd'));
}
function botTourDone_() { return !!PropertiesService.getScriptProperties().getProperty('BOT_TOUR_DONE'); }

// Called by the bots where something the tour waits for happens. kind: 'newEntry' | 'edited' | 'touched' | 'pending'.
function botTourNote_(kind, entryId) {
  if (!BOT_TOUR_EV_) return;
  if (kind === 'pending') { BOT_TOUR_EV_.pending = true; return; }
  if (kind === 'newEntry') { BOT_TOUR_EV_.newEntry = String(entryId || ''); return; }
  BOT_TOUR_EV_[kind] = BOT_TOUR_EV_[kind] || {};
  BOT_TOUR_EV_[kind][String(entryId || '')] = true;
}

// The fields a reply in words can change (step 4 counts how many changed).
var BOT_TOUR_FIELDS_ = ['amount', 'description', 'category_id', 'date', 'payment_method_id', 'to_payment_method_id', 'currency', 'paid_by', 'type', 'trip_id'];
function botTourSnapshot_(entryId) {
  var e = getEntryById_(entryId);
  if (!e) return null;
  var o = {};
  BOT_TOUR_FIELDS_.forEach(function (f) { o[f] = String(e[f] === undefined || e[f] === null ? '' : e[f]); });
  return o;
}
function botTourChanged_(before, after) {
  if (!before || !after) return 0;
  return BOT_TOUR_FIELDS_.filter(function (f) { return before[f] !== after[f]; }).length;
}

// The step's own message. Steps 2, 3 and 4 quote the tour's transaction (its newest message), so the step reads as being about it.
function botTourStepText_(st) {
  var stop = '\n\n' + tr_('botTour.stopHint');
  if (st.step === 1) return { text: tr_('botTour.step1') + stop };
  if (st.step === 2 || st.step === 3) {
    var e = getEntryById_(st.entryId);
    // Step 3 for a transaction still without a category (another field was changed at step 2): Confirm would be refused, so say why.
    var key = st.step === 2 ? (e && e.category_id ? 'botTour.step2' : 'botTour.step2NoCat')
      : st.test ? 'botTour.step3Test' : (e && (e.category_id || e.type === 'investment') ? 'botTour.step3' : 'botTour.step3NoCat');
    return { text: tr_(key) + stop, replyTo: whatsappCardFor_(st.entryId) || null };
  }
  if (st.step === 4) return { text: tr_('botTour.stepWords') + stop, replyTo: whatsappCardFor_(st.entryId) || null };
  if (st.step === 5) return { text: tr_('botTour.step4') + stop };
  // The reply-in-words tip is short after step 4; in full when step 4 was left out (the transaction was discarded).
  return { text: tr_('botTour.step5', { reply: tr_(st.wordsDone ? 'botTour.replyShort' : 'botTour.replyFull') }) + (botIsWa_() ? '\n\n' + tr_('botTour.step5Wa') : '') };
}
function botTourSay_(st, before) {
  var m = botTourStepText_(st);
  botText_((before ? before + '\n\n' : '') + m.text, m.replyTo);
}

function botTourStart_() {
  var st = { v: 2, step: 1, misses: 0, entryId: '', test: false };
  botTourSave_(st);
  return st;
}

// A friend's new WhatsApp bot, its very first message, a tour never done: the tour starts by itself (the one exception to "a
// tutorial never starts by itself", like the app's guided practices). Never on the owner's copy.
function botTourAutoStartOk_() {
  return isFriendCopy_() && reviewBotIsWhatsApp_() && !botTourDone_() && !botTourState_();
}

// Before the message is handled. text: the message's text ('' for a tap or a photo); isReply: it quotes a message. Returns true
// when the tour answered it and the bot must not handle it (its own words, or a first "hola" that would only get "no amount").
function botTourBefore_(text, p, firstEver, isReply) {
  BOT_TOUR_EV_ = {};
  var t = String(text || '').trim();
  var plain = t && !isReply;
  if (plain && /^\/?(?:tutorial|tour)$/i.test(t)) {
    botTourSay_(botTourStart_());
    BOT_TOUR_EV_.skip = true;
    return true;
  }
  var st = botTourState_();
  if (st && st.step === 4) BOT_TOUR_EV_.before = botTourSnapshot_(st.entryId);   // what a reply in words changes
  // The tour's own words are never a transaction's text, at any step, sent plainly or as a reply (testers, 2026-11-20: "saltar"
  // at step 4 became a confirmed expense's description). A word that does not fit the step just says the step again.
  var word = botTourWord_(t);
  if (st && word === 'exit') {
    botTourEnd_(true);
    botText_(tr_('botTour.stopped'), p.id);
    BOT_TOUR_EV_.skip = true;
    return true;
  }
  if (st && plain && st.step === 1 && word === 'test') {
    st.test = true;
    botTourSave_(st);
    botNewPurchase_('1 ' + tr_('botTour.testName'), p);   // the usual card; botTourAfter_ moves on to step 2
    return true;
  }
  if (st && word === 'skip' && st.step >= 2) {
    if (st.step >= 5) { botTourEnd_(true); st.step = 6; botTourSay_(st); }   // the last step: the tips, and the tour is done
    else { st.step += 1; st.misses = 0; botTourSave_(st); botTourSay_(st); }
    BOT_TOUR_EV_.skip = true;
    return true;
  }
  // "deshacer" during the tour: handled as usual (BotUndo.gs), and never counted as a wrong answer.
  if (st && botUndoWord_(t)) { BOT_TOUR_EV_.skip = true; return false; }
  // "test" after step 1, "skip" at step 1, and "ok" / "gracias"…: the step again, not counted as a miss (re-check, 2026-11-21:
  // "gracias" twice lost the tour, and each got "Nothing changed" plus the step, two messages).
  if (st && (word || botFillerWord_(t))) {
    botTourSay_(st);
    BOT_TOUR_EV_.skip = true;
    return true;
  }
  if (!st && firstEver && botTourAutoStartOk_()) {
    botTourStart_();
    if (t && !isReply && typedIsNewEntry_(t)) return false;   // already an expense: handled as usual, the tour starts at step 2
    if (t) { botTourSay_({ step: 1 }); BOT_TOUR_EV_.skip = true; return true; }   // "hola": the tour's greeting is the answer
    BOT_TOUR_EV_.greet = true;   // a photo or a tap: handled as usual, then the greeting
  }
  return false;
}

// The tour's own words, in either language: 'exit' | 'skip' | 'test' | ''.
function botTourWord_(t) {
  t = String(t || '').trim().replace(/[.!¡\s]+$/, '');
  if (/^\/?(?:salir|stop|exit)$/i.test(t)) return 'exit';
  if (/^(?:saltar|skip)$/i.test(t)) return 'skip';
  if (/^(?:prueba|test)$/i.test(t)) return 'test';
  return '';
}

// A word on its own that is never a transaction's new text, tour or not (owner, 2026-11-21): "ok", "gracias", the tour's words…
// Before, the bot's last-message rule made it the description of the last transaction, even a confirmed one.
function botFillerWord_(text) {
  var t = String(text || '').trim().replace(/[.!¡\s]+$/, '');
  return /^(?:ok|okay|vale|listo|gracias|thanks|exit|salir|stop|skip|saltar|test|prueba)$/i.test(t);
}

// After the message was handled: did the person do the step?
function botTourAfter_() {
  var ev = BOT_TOUR_EV_ || {};
  BOT_TOUR_EV_ = null;
  if (ev.skip) return;
  var st = botTourState_();
  if (!st) return;
  if (ev.greet) { botTourSay_(st); return; }
  var advance = function (step, before) { st.step = step; st.misses = 0; botTourSave_(st); botTourSay_(st, before); };
  if (st.step === 1) {
    if (!ev.newEntry) return botTourMiss_(st);
    st.entryId = ev.newEntry;
    var made = getEntryById_(st.entryId);
    if (made && made.status === 'confirmed') return advance(4, tr_('botTour.confirmedAlready'));   // straight to replying
    return advance(2);
  }
  if (st.step === 2 || st.step === 3) {
    var e = getEntryById_(st.entryId);
    if (!e) return advance(5, tr_(st.test ? 'botTour.testDiscarded' : 'botTour.discarded'));   // nothing left to reply to
    if (e.status === 'confirmed') return advance(4, tr_(st.test ? 'botTour.testConfirmed' : 'botTour.confirmed'));
    if (st.step === 2 && ev.edited && ev.edited[st.entryId]) return advance(3);
    if ((ev.edited && ev.edited[st.entryId]) || (ev.touched && ev.touched[st.entryId])) return;   // still working on it
    return botTourMiss_(st);
  }
  if (st.step === 4) {
    var n = botTourChanged_(ev.before, botTourSnapshot_(st.entryId));
    if (!getEntryById_(st.entryId)) return advance(5);   // deleted meanwhile (in the app): nothing to reply to any more
    if (n >= 2 || (n === 1 && st.oneDone)) { st.wordsDone = true; return advance(5, tr_(n >= 2 ? 'botTour.wordsBoth' : 'botTour.wordsOk')); }
    if (n === 1) { st.oneDone = true; st.misses = 0; botTourSave_(st); botText_(tr_('botTour.wordsOne'), whatsappCardFor_(st.entryId) || null); return; }
    if (ev.touched && ev.touched[st.entryId]) return;   // Edit taps on it: still working on it
    return botTourMiss_(st);
  }
  if (st.step === 5) {
    if (!ev.pending) return botTourMiss_(st);
    botTourEnd_(true);
    st.step = 6;
    botTourSay_(st);
  }
}

// A message that did not fit the step: the step once more; the second in a row stops the tour (it lost its place).
function botTourMiss_(st) {
  st.misses = (Number(st.misses) || 0) + 1;
  if (st.misses >= 2) { botTourEnd_(false); botText_(tr_('botTour.lost')); return; }
  botTourSave_(st);
  botTourSay_(st);
}

// A new transaction typed for the tour ("prueba"), through the bot of the moment's own path.
function botNewPurchase_(text, p) {
  var q = { id: p.id, text: text, timestamp: p.timestamp };
  if (botIsWa_()) return whatsappNewPurchase_(text, q);
  return telegramNewTypedEntry_({ chat: { id: getOwnerTelegramChatId_() }, message_id: p.id, date: p.timestamp }, text);
}
