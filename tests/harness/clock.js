// Time travel for the test copy (TIME_TRAVEL=1, 2026-11-17): the fake backend and the phone both believe "now" is a moment the
// tester chooses, so a made-up person can live through months of use in an afternoon. Only "now" moves (new Date() with nothing
// in the brackets, and Date.now()); a date written out (new Date("2027-01-05")) means what it says. The phone gets the same shift
// from a small script the test server puts at the top of the page (browserSnippet), so both always agree.
const RealDate = Date;
let offsetMs = 0;

class ShiftedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offsetMs); else super(...a); }
  static now() { return RealDate.now() + offsetMs; }
}

let installed = false;
// Replaces the global Date for this whole Node process (the real backend runs on it through gas-runtime's sandbox).
function install() {
  if (installed) return;
  globalThis.Date = ShiftedDate;
  installed = true;
}
function now() { return RealDate.now() + offsetMs; }
function offset() { return offsetMs; }
// Moves "now" to the given moment (ms since 1970). Moving backwards is allowed but makes little sense for a journey.
function setNow(ms) { offsetMs = ms - RealDate.now(); }

// "2027-03-05" or "2027-03-05T09:30" read as Lima's clock (UTC−5 all year: Peru has no summer time) → ms.
function limaMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(text).trim());
  if (!m) throw new Error("Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (Lima time): " + text);
  return RealDate.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 9) + 5, +(m[5] || 0));
}
// ms → "2027-03-05 09:30" on Lima's clock.
function limaText(ms) {
  const d = new RealDate(ms - 5 * 3600000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// The phone's copy of the same shift, put first in <head>: the offset is read when the page loads; window.__tt.set(ms) moves it
// without a reload (the journey runner uses it right after it moves the server's clock).
function browserSnippet() {
  return `<script>(function(){var R=Date;var tt=window.__tt={off:${offsetMs - 0},set:function(ms){tt.off=ms-R.now();}};` +
    `class D extends R{constructor(...a){if(a.length===0)super(R.now()+tt.off);else super(...a);}static now(){return R.now()+tt.off;}}` +
    `window.Date=D;})();</script>`;
}

module.exports = { RealDate, install, now, offset, setNow, limaMs, limaText, browserSnippet };
