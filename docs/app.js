// The Web App URL isn't secret by itself — the ACCESS_CODE is what protects
// writes. That code lives only in this browser's localStorage, never here.
//
// The address of THIS phone's backend is kept in localStorage ("apiUrl"): a friend's
// app talks to the friend's own backend, put there by "Paste my sign-in" (see
// signin-link.js). OWNER_API_URL is only the owner's own address from before addresses
// were per phone: a phone that is already signed in and has no saved address is the
// owner's, and is migrated once. A new phone never falls back to it.
const OWNER_API_URL = "https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec";

function getApiUrl() {
  return localStorage.getItem("apiUrl") || "";
}

function setApiUrl(url) {
  localStorage.setItem("apiUrl", url);
}

(function migrateOwnerApiUrl_() {
  if (!getApiUrl() && (localStorage.getItem("sessionToken") || localStorage.getItem("accessCode"))) {
    setApiUrl(OWNER_API_URL);
  }
})();

const TYPE_LABELS = {
  expense: tr("type.expense"),
  income: tr("type.income"),
  investment: tr("type.investment"),
  transfer: tr("type.transfer")
};

// Shared by every pop-up sheet (currency picker, drill-down, entry edit,
// budget edit, exchange rate) — whichever one was opened most recently
// gets bumped to the very top, regardless of which other sheets happen to
// already be open underneath it. A fixed z-index per sheet type can't work
// here: the currency picker, for instance, is opened from both the plain
// entry form AND from inside the budget form, so "above X" isn't a fixed
// fact about the currency picker — it depends on what's already open when
// it's launched. The CSS z-index values (250/260/270) stay as sensible
// defaults for a sheet's first paint; this always overrides them once a
// sheet is actually opened.
let topModalZIndex = 250;
function bringModalToFront_(backdropEl) {
  topModalZIndex += 1;
  backdropEl.style.zIndex = topModalZIndex;
}

let meta = null;
let selectedType = "expense";
let selectedTagIds = new Set();
let selectedCategoryId = null;
let editingEntryId = null;
// True while the entry form is open as a pop-up on top of a drill-down
// sheet (Overview) rather than inline on the Entries screen — changes
// where save/cancel/delete land afterward.
let editingViaPopup = false;

// ---- Splitting an expense with friends (Phase 5) ----
// splitFriendIds holds who else is in the split (never the owner — their
// own share is always the leftover, never stored, per CLAUDE.md's Entry
// Splits section). customSplitAmounts only matters in "custom" mode.
let splitFriendIds = new Set();
let splitMode = "equal";
let customSplitAmounts = {};
// The owner's own box in Custom mode ("Me"). Blank = "not filled", same as
// any friend's box: every blank box shares whatever the filled ones leave.
let customOwnAmount = "";
let splitInputEls = {};
// True while editing an entry that was type "expense" when the edit
// started — lets the submit handler still clear its splits/loans if the
// owner changes its type away from expense mid-edit, even though the
// split field itself is hidden (and selectedType no longer "expense") by
// the time they hit Save.
let editingEntryWasSplittable = false;
let editingEntryOriginalType = null;
// Set only while confirming a pending (review-queue) entry through the
// full entry-card popup — see openConfirmPendingPopup, Phase 5.7's
// "Split" action. Distinct from editingEntryId (which the popup's own
// startEditEntry call also sets, to reuse its prefill logic) — the
// submit handler checks this FIRST so a pending confirmation never falls
// through to the normal "update an existing entry" path.
let confirmingPendingId = null;

// ---- Currencies ----

const CURRENCIES = [
  { code: "PEN", flag: "🇵🇪", name: tr("currency.PEN") },
  { code: "USD", flag: "🇺🇸", name: tr("currency.USD") },
  { code: "EUR", flag: "🇪🇺", name: tr("currency.EUR") },
  { code: "ARS", flag: "🇦🇷", name: tr("currency.ARS") },
  { code: "MXN", flag: "🇲🇽", name: tr("currency.MXN") },
  { code: "BRL", flag: "🇧🇷", name: tr("currency.BRL") },
  { code: "CLP", flag: "🇨🇱", name: tr("currency.CLP") },
  { code: "COP", flag: "🇨🇴", name: tr("currency.COP") },
  { code: "BOB", flag: "🇧🇴", name: tr("currency.BOB") },
  { code: "UYU", flag: "🇺🇾", name: tr("currency.UYU") },
  { code: "PYG", flag: "🇵🇾", name: tr("currency.PYG") },
  { code: "VES", flag: "🇻🇪", name: tr("currency.VES") },
  { code: "GTQ", flag: "🇬🇹", name: tr("currency.GTQ") },
  { code: "CRC", flag: "🇨🇷", name: tr("currency.CRC") },
  { code: "PAB", flag: "🇵🇦", name: tr("currency.PAB") },
  { code: "DOP", flag: "🇩🇴", name: tr("currency.DOP") },
  { code: "HNL", flag: "🇭🇳", name: tr("currency.HNL") },
  { code: "NIO", flag: "🇳🇮", name: tr("currency.NIO") },
  { code: "CUP", flag: "🇨🇺", name: tr("currency.CUP") },
  { code: "GBP", flag: "🇬🇧", name: tr("currency.GBP") },
  { code: "CAD", flag: "🇨🇦", name: tr("currency.CAD") },
  { code: "CHF", flag: "🇨🇭", name: tr("currency.CHF") },
  { code: "JPY", flag: "🇯🇵", name: tr("currency.JPY") },
  { code: "CNY", flag: "🇨🇳", name: tr("currency.CNY") },
  { code: "KRW", flag: "🇰🇷", name: tr("currency.KRW") },
  { code: "INR", flag: "🇮🇳", name: tr("currency.INR") },
  { code: "AUD", flag: "🇦🇺", name: tr("currency.AUD") },
  { code: "NZD", flag: "🇳🇿", name: tr("currency.NZD") },
  { code: "SGD", flag: "🇸🇬", name: tr("currency.SGD") },
  { code: "HKD", flag: "🇭🇰", name: tr("currency.HKD") },
  { code: "SEK", flag: "🇸🇪", name: tr("currency.SEK") },
  { code: "NOK", flag: "🇳🇴", name: tr("currency.NOK") },
  { code: "DKK", flag: "🇩🇰", name: tr("currency.DKK") },
  { code: "PLN", flag: "🇵🇱", name: tr("currency.PLN") },
  { code: "TRY", flag: "🇹🇷", name: tr("currency.TRY") },
  { code: "ZAR", flag: "🇿🇦", name: tr("currency.ZAR") },
  { code: "AED", flag: "🇦🇪", name: tr("currency.AED") },
  { code: "THB", flag: "🇹🇭", name: tr("currency.THB") },
  { code: "RUB", flag: "🇷🇺", name: tr("currency.RUB") },
  { code: "ILS", flag: "🇮🇱", name: tr("currency.ILS") }
];

const DEFAULT_RECENT_CURRENCIES = ["PEN", "USD", "EUR", "ARS", "MXN"];

// The main ("home") currency: every total, budget and exchange rate is in it. It is the Settings row default_currency
// (soles, unless the person chose another in the welcome questions, once; see backend/HomeCurrency.gs).
function homeCur() {
  const c = meta && meta.settings && meta.settings.default_currency;
  return /^[A-Za-z]{3}$/.test(String(c || "")) ? String(c).toUpperCase() : "PEN";
}

function findCurrency(code) {
  return CURRENCIES.find((c) => c.code === code) || { code, flag: "💱", name: code };
}

function getRecentCurrencies() {
  try {
    const stored = JSON.parse(localStorage.getItem("recentCurrencies"));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch (err) {
    // fall through to defaults
  }
  return [homeCur(), ...DEFAULT_RECENT_CURRENCIES.filter((c) => c !== homeCur())].slice(0, 5);
}

function bumpRecentCurrency(code) {
  let recent = getRecentCurrencies().filter((c) => c !== code);
  recent.unshift(code);
  recent = recent.slice(0, 5);
  localStorage.setItem("recentCurrencies", JSON.stringify(recent));
  return recent;
}

// Currency picking is shared between the entry form and the budget form —
// `target` ("entry" or "budget") says which hidden input + chip row is
// currently being edited. The "More…" search modal is one shared DOM node,
// so it remembers the target that opened it (currencyPickerTarget) for
// when a result gets picked.
let currencyPickerTarget = "entry";

function currencyFieldIds(target) {
  if (target === "budget") return { input: "budget-currency", chips: "budget-currency-chips" };
  if (target === "recurring") return { input: "recurring-currency", chips: "recurring-currency-chips" };
  if (target === "loan") return { input: "loan-currency", chips: "loan-currency-chips" };
  if (target === "balance") return { input: "balance-currency", chips: "balance-currency-chips" };
  if (target === "trip") return { input: "trip-currency", chips: "trip-currency-chips" };
  return { input: "currency", chips: "currency-chips" };
}

function selectCurrency(code, target) {
  const resolvedTarget = target || currencyPickerTarget;
  if (resolvedTarget === "main-change") { closeCurrencyModal(); startMainCurrencyChange_(code); return; }
  const ids = currencyFieldIds(resolvedTarget);
  document.getElementById(ids.input).value = code;
  bumpRecentCurrency(code);
  renderCurrencyChips(resolvedTarget);
  closeCurrencyModal();

  // Entries already resolve their rate at save time (ensureExchangeRate,
  // tied to that entry's specific date) — for a budget, just refresh the
  // visible warning + "Set one" link (see refreshBudgetRateWarning_),
  // since a budget has no single date to resolve a rate against.
  if (resolvedTarget === "budget") {
    refreshBudgetRateWarning_(null);
  } else if (resolvedTarget === "entry") {
    renderSplitSummary();
  } else if (resolvedTarget === "trip") {
    refreshTripRateWarning_(true);   // a newly chosen trip currency with no rate on file asks for one
  }
}

function renderCurrencyChips(target) {
  const ids = currencyFieldIds(target);
  const container = document.getElementById(ids.chips);
  const current = document.getElementById(ids.input).value;
  container.innerHTML = "";

  getRecentCurrencies().forEach((code) => {
    const cur = findCurrency(code);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "currency-chip" + (code === current ? " active" : "");
    chip.innerHTML = `<span>${cur.flag}</span><span>${cur.code}</span>`;
    chip.addEventListener("click", () => selectCurrency(code, target));
    container.appendChild(chip);
  });

  const moreChip = document.createElement("button");
  moreChip.type = "button";
  moreChip.className = "currency-chip more";
  moreChip.textContent = tr("common.more");
  moreChip.addEventListener("click", () => openCurrencyModal(target));
  container.appendChild(moreChip);
}

function openCurrencyModal(target) {
  currencyPickerTarget = target || "entry";
  const backdrop = document.getElementById("currency-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  document.getElementById("currency-search").value = "";
  renderCurrencyOptionList("");
  document.getElementById("currency-search").focus();
}

function closeCurrencyModal() {
  document.getElementById("currency-modal-backdrop").hidden = true;
}

function renderCurrencyOptionList(filterText) {
  const list = document.getElementById("currency-option-list");
  list.innerHTML = "";
  const q = filterText.trim().toLowerCase();
  const filtered = CURRENCIES.filter(
    (c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
  filtered.forEach((c) => {
    const row = document.createElement("div");
    row.className = "currency-option";
    row.innerHTML = `
      <span class="currency-option-flag">${c.flag}</span>
      <span class="currency-option-code">${c.code}</span>
      <span class="currency-option-name">${escapeHtml(c.name)}</span>
    `;
    row.addEventListener("click", () => selectCurrency(c.code, currencyPickerTarget));
    list.appendChild(row);
  });
}

document.getElementById("currency-modal-close").addEventListener("click", closeCurrencyModal);
document.getElementById("currency-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "currency-modal-backdrop") closeCurrencyModal();
});
document.getElementById("currency-search").addEventListener("input", (e) => {
  renderCurrencyOptionList(e.target.value);
});

function getAccessCode() {
  return localStorage.getItem("accessCode") || "";
}

function setAccessCode(code) {
  localStorage.setItem("accessCode", code);
}

// Sign-in sessions (2026-10-05): the access code is typed once, to `login`; the
// phone then keeps only a long random session key (never the code) and each
// request carries that. An older copy of the app that still sends the code keeps
// working until the owner switches sessions to "required" (sheet menu 26).
function getSessionToken() {
  return localStorage.getItem("sessionToken") || "";
}

function setSessionToken(token) {
  localStorage.setItem("sessionToken", token);
}

// "iPhone · home-screen app" — what the Signed-in devices list shows.
function deviceName_() {
  const ua = navigator.userAgent || "";
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? tr("device.windows") : tr("device.other");
  const standalone = navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  return tr(standalone ? "device.homeScreen" : "device.browser", { kind });
}

// What this phone keeps about the signed-in owner: the session key, any old
// stored code, and the cached financial data / drafts (so a signed-out device
// holds nothing).
function clearLocalSignIn_() {
  localStorage.removeItem("sessionToken");
  localStorage.removeItem("accessCode");
  localStorage.removeItem(STARTUP_CACHE_KEY);
  localStorage.removeItem(PROJECTIONS_CACHE_KEY);
  localStorage.removeItem(ENTRY_DRAFT_KEY);
  clearSearchCache_();
}

function showSignedOutScreen_(message) {
  document.getElementById("loading-screen").hidden = true;
  document.getElementById("app").hidden = true;
  document.getElementById("bottom-nav").hidden = true;
  showSetupScreen(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apps Script's free Web App "falls asleep" after a period of inactivity —
// the first request after that can take 20+ seconds to wake it up, and
// sometimes the slow/cold response comes back looking like a CORS failure.
// Retrying clears it up once the backend is warm.
// Actions that create something and must never be applied twice — the retry
// loop below resends a request when no reply arrives, even though the first
// copy may well have been applied. Each gets one `_requestId`, created on the
// first attempt and carried unchanged through every resend; the server
// (routeActionOnce_ in Api.gs) runs it once and answers repeats from memory.
const ONCE_ACTIONS = new Set([
  "createEntry", "recordRepayment", "convertEntryToRepayment", "convertEntryToLoan",
  "recordOverpaymentIncome", "recordOverpaymentExpense", "addLoan", "addFriend", "addRecurringExpense",
  "exportData"
]);

function newRequestId_() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// How many calls are waiting on the server right now; sending app-speed reports (below) never starts while any are.
let perfInflight_ = 0;
async function callApi(action, payload, attempt = 1, startedAt = performance.now()) {
  perfInflight_++;
  try { return await callApiOnce_(action, payload, attempt, startedAt); } finally { perfInflight_--; }
}

async function callApiOnce_(action, payload, attempt, startedAt) {
  if (attempt === 1 && ONCE_ACTIONS.has(action) && !(payload && payload._requestId)) {
    payload = { ...(payload || {}), _requestId: newRequestId_() };
  }
  const apiUrl = getApiUrl();
  if (!apiUrl) throw Object.assign(new Error(tr("link.noBackend")), { code: "no_backend" });   // not connected to a backend yet
  let json;
  try {
    // A hard cap per attempt — without one, a request that goes quiet
    // (the app backgrounded mid-flight, a dropped connection with no
    // error) leaves its promise unsettled forever, which then blocks
    // anything awaiting it (retries, and the review-queue's background
    // flush loop) from ever moving on. 25s comfortably covers Apps
    // Script's own cold-start delay (up to ~20s, see below).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        // `lang`: the server answers (errors, category names…) in the app's language.
        // `apiUrl`: the address this phone uses; the backend keeps its own copy of it
        // (Features.gs) for the keep-awake ping, so no copy of the app has to have it written in its code.
        body: JSON.stringify(getSessionToken()
          ? { sessionToken: getSessionToken(), action, payload: payload || {}, lang: I18n.getLang(), apiUrl }
          : { accessCode: getAccessCode(), action, payload: payload || {}, lang: I18n.getLang(), apiUrl }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    json = await res.json();
  } catch (networkErr) {
    // Apps Script's free Web App "falls asleep" after a period of
    // inactivity — the first request after that can take 20+ seconds to
    // wake it up, and sometimes the slow/cold response comes back
    // looking like a CORS failure. Retrying clears it up once the
    // backend is warm.
    if (attempt < 6) {
      await sleep(400 * attempt);
      return callApi(action, payload, attempt + 1, startedAt);
    }
    perfRecordCall_(action, performance.now() - startedAt, attempt, null, null, false);
    betaRecordError_(action, "network");
    throw new Error(tr("error.unreachable"));
  }
  perfRecordCall_(action, performance.now() - startedAt, attempt, json.serverMs, json.coldInstance, !!json.ok);
  if (!json.ok && (json.code === "invalid_access_code" || json.error === "Invalid access code") && getSessionToken()) {
    // This device's session was ended (signed out from another device, the
    // sheet menu, or unused for 90 days): go back to the sign-in screen.
    clearLocalSignIn_();
    showSignedOutScreen_(tr("signin.signedOutHere"));
  }
  if (!json.ok && /^Unknown action/.test(String(json.error || ""))) {
    // The app is newer than this copy's backend (it asked for something the backend does not have yet): say so, and offer the update.
    setUpdateAvailable_(true);
    json.error = tr("update.needed");
    betaRecordError_(action, "backend_old");
  } else if (!json.ok) {
    betaRecordError_(action, PerfShare.errorCode({ code: json.code }));
  }
  if (!json.ok) {
    const failure = new Error(json.error || tr("error.unknown"));
    failure.code = json.code;   // the app recognises some errors by code, not by their (translated) text
    throw failure;
  }
  return json.data;
}

// ---- Performance log ----
// Every server call (and each app-startup phase) is timed and kept in
// localStorage (last PERF_LOG_MAX entries) so slowness can be diagnosed
// from real use: More → Performance log. totalMs is what the phone waited;
// serverMs is what the script spent inside doPost — the gap is
// network + wake-up time.

const PERF_LOG_KEY = "perfLog";
const PERF_LOG_MAX = 600;

// ---- Startup cache (instant paint on every open after the first) ----
// Three days of the performance log above (see CHANGELOG.md § Architecture,
// "Startup-speed fixes") showed the real bottleneck: Apps Script itself —
// cold start plus several Sheet reads — takes 15-25+ seconds per open
// almost every time, no matter how the calls are arranged. Waiting on a
// loading screen for that on every single open was the actual complaint.
// So the last successful getStartupBundle result is kept here and painted
// immediately on the next open — clearly still real data, just possibly a
// few hours stale — while the live bundle loads in the background and
// replaces it, same self-correcting pattern pull-to-refresh already uses.
// First-ever open on a phone has nothing saved yet, so it falls back to
// the old loading-screen behaviour. See init() for how the live refresh
// avoids overwriting anything the owner is actively typing/editing when
// it lands.
const STARTUP_CACHE_KEY = "startupCache";

function loadStartupCache_() {
  try {
    const cached = JSON.parse(localStorage.getItem(STARTUP_CACHE_KEY));
    // Saved in another language (category names come from the server already
    // translated): don't paint it, load the live data instead.
    return cached && cached.lang === I18n.getLang() ? cached : null;
  } catch (err) {
    return null;
  }
}

function saveStartupCache_(bundle) {
  try {
    localStorage.setItem(STARTUP_CACHE_KEY, JSON.stringify({ ...bundle, lang: I18n.getLang() }));
  } catch (err) {
    // Storage full/unavailable — next open just falls back to the
    // loading-screen behaviour, same as before this cache existed.
  }
}

// The instant first paint from cache: never flushes (see refreshReviewQueue's
// skipFlush) and never skips anything else, since nothing on screen has
// been touched yet at this point in a fresh app open.
async function renderCachedStartupBundle_(bundle) {
  await loadMeta(bundle.meta);
  await refreshEntryList(bundle.entries);
  await refreshReviewQueue(bundle.pending, true);
  await refreshExpectedRecurring(bundle.expectedRecurring.groups);
}

function perfAppend_(entry) {
  try {
    const share = perfShareState_();
    // The on-phone log screen only exists on the owner's copy; a friend who answered keeps no local log at all.
    if (!(share.asked && !share.owner)) {
      const log = JSON.parse(localStorage.getItem(PERF_LOG_KEY) || "[]");
      log.push(entry);
      localStorage.setItem(PERF_LOG_KEY, JSON.stringify(log.slice(-PERF_LOG_MAX)));
    }
    if (share.on) perfOutbox_.append(entry);   // waits in the outbox until it is sent (see "Sharing app speed" below)
  } catch (err) {
    // Logging must never break the app.
  }
}

function perfRecordCall_(action, totalMs, attempts, serverMs, cold, ok) {
  perfAppend_({
    t: Date.now(), kind: "call", name: action, totalMs: Math.round(totalMs),
    serverMs: typeof serverMs === "number" ? serverMs : null,
    cold: !!cold, attempts, ok
  });
}

function perfRecordStartup_(name, ms) {
  perfAppend_({ t: Date.now(), kind: "startup", name, totalMs: Math.round(ms) });
}

// ---- Sharing app speed with the owner (beta) ----
// With the person's OK (welcome question / More → Share app speed) the timings above are also queued in a small
// outbox (docs/perf-share.js) and sent to the owner's backend, which appends them to his Sheet (backend/PerfReports.gs).
// Only timings and action names are ever sent — no amounts, text or names. Sending is quiet and never in the way:
// it waits until no call is running and the app is on screen, runs when the browser is idle, sends at most every 2 h
// (30 min after a failure), only when 30+ entries are waiting (or the oldest is a day old), and ignores every error.
// An entry leaves the outbox only after the backend confirms it is stored. The owner's own copy shares automatically
// with the label "Owner" (to his own backend); the log screen in More exists only there.
const PERF_SHARE_KEY = "perfShare";   // { on, label, asked, owner } — chosen per phone
const perfOutbox_ = PerfShare.create(localStorage);
// A second, much smaller outbox: which app actions failed (name + a short code, never the message) — backend/BetaEvents.gs.
// Only recorded for a person who agreed to scope 2 (see PerfShare.SCOPE); a person who agreed to speed only sends no errors.
const betaOutbox_ = PerfShare.create(localStorage, { outboxKey: "betaOutbox", seqKey: "betaSeq" });
// Scope 3 (see PerfShare.SCOPE): what the person did with a pending entry, and how often each screen is opened. Only for a person
// who agreed to the version that announced them; names and counts only — never an amount, text, account or name.
function betaScope3_() {
  const share = perfShareState_();
  return !!(share.on && (share.scope || 1) >= 3);
}
function betaRecordEvents_(events) {
  try {
    if (!betaScope3_()) return;
    events.forEach((e) => betaOutbox_.appendRaw({ t: Date.now(), ...e }));
  } catch (err) {
    // Counting must never break the app.
  }
}
// Where a pending entry came from: the bank of its account (as the app's own bank list names it), or the other way it arrived.
function betaEntryPlace_(entry) {
  if (entry.source && entry.source !== "email") return ["photo", "shortcut", "import", "manual"].includes(entry.source) ? entry.source : "other_source";
  const pm = ((meta && meta.paymentMethods) || []).find((p) => p.id === (entry.payment_method_id || entry.to_payment_method_id));
  const bank = pm && ((meta && meta.banks) || []).find((b) => b.id === pm.bank_id);
  return bank ? PerfShare.bankSlug(bank.name) : "no_account";
}
let betaScreenNow_ = "entries", betaScreenBefore_ = "entries";   // in memory only: the feedback note says which screen the person was on
function betaCountScreen_(name) {
  try {
    if (!betaScope3_()) return;
    PerfShare.recordScreen(localStorage, name, Date.now()).forEach((e) => betaOutbox_.appendRaw(e));
  } catch (err) {
    // Counting must never break the app.
  }
}
function betaRecordError_(action, code) {
  try {
    const share = perfShareState_();
    if (!share.on || (share.scope || 1) < PerfShare.SCOPE) return;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(String(action || ""))) return;
    if (!PerfShare.shouldRecordError(localStorage, action, code, Date.now())) return;
    betaOutbox_.appendRaw({ t: Date.now(), k: "error", n: action, d: code, v: 1 });
  } catch (err) {
    // Counting must never break the app.
  }
}

function perfShareState_() {
  try { return JSON.parse(localStorage.getItem(PERF_SHARE_KEY)) || {}; } catch (e) { return {}; }
}
function perfShareSave_(state) {
  try { localStorage.setItem(PERF_SHARE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked: nothing is shared */ }
}
function perfInstallId_() {
  let id = "";
  try { id = localStorage.getItem("perfInstall") || ""; } catch (e) { /* see below */ }
  if (!/^[0-9a-f-]{16,36}$/.test(id)) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    try { localStorage.setItem("perfInstall", id); } catch (e) { /* a new id next time */ }
  }
  return id;
}
// The owner's own copy: his backend says so, or the phone is connected to his address (an older cached answer lacks the flag).
function perfIsOwnerCopy_() {
  return !!(meta && meta.capabilities && meta.capabilities.perfLog === true) || getApiUrl() === OWNER_API_URL;
}
function perfShareOwnerInit_() {
  if (!perfIsOwnerCopy_()) return;
  const s = perfShareState_();
  if (!(s.owner && s.on && s.scope === PerfShare.SCOPE)) perfShareSave_({ on: true, owner: true, asked: true, label: "Owner", scope: PerfShare.SCOPE });
}
// The release number ("1.4.2") this copy of the app was shipped as. ship.sh writes it into the
// <meta name="app-release"> tag of index.html; it reads "dev" on the test harness. Shown at the bottom of
// More and sent with the app-speed reports and bank samples so the owner can tell which version a phone runs.
function appRelease_() {
  const m = document.querySelector("meta[name=app-release]");
  return (m && /^[0-9A-Za-z.\-]{1,30}$/.test(m.content)) ? m.content : "";
}
// Where reports go: the owner's backend (his own copy: itself). Only a test page on this Mac may override it.
function perfReportUrl_() {
  try {
    const o = localStorage.getItem("perfReportUrl");
    if (o && /^http:\/\/localhost(:\d+)?\//.test(o)) return o;
  } catch (e) { /* no override */ }
  return perfShareState_().owner ? getApiUrl() : OWNER_API_URL;
}

async function perfSendOnce_(outbox = perfOutbox_, action = "reportPerf") {
  const entries = outbox.peek(action === "reportPerf" ? 200 : 100);
  if (!entries.length) return false;
  const share = perfShareState_();
  const standalone = navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    // A plain fetch, not callApi: reporting must not be timed, retried or counted like the app's own calls.
    const res = await fetch(perfReportUrl_(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, payload: {
        install: perfInstallId_(), label: share.label || "", app: appRelease_(),
        device: PerfShare.deviceKind(navigator.userAgent, standalone), entries
      } }),
      signal: controller.signal
    });
    const json = await res.json();
    if (json && json.ok && json.data && Number.isFinite(json.data.ack)) { outbox.ack(json.data.ack); return true; }
    return false;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let perfSending_ = false;
async function perfSendMaybe_() {
  try {
    if (perfSending_ || perfInflight_ > 0 || document.hidden || !perfShareState_().on) return;
    const failed = localStorage.getItem("perfSendFailed") === "1";
    if (!PerfShare.shouldSend(perfOutbox_.status(), Date.now(), Number(localStorage.getItem("perfLastTry")) || 0, failed)) return;
    perfSending_ = true;
    localStorage.setItem("perfLastTry", String(Date.now()));
    for (let i = 0; i < 5; i++) {   // a backlog goes out in a few batches of 200, a pause between each
      const ok = await perfSendOnce_();
      localStorage.setItem("perfSendFailed", ok ? "0" : "1");
      if (!ok || !perfOutbox_.status().count || perfInflight_ > 0 || document.hidden) break;
      await sleep(2000);
    }
  } catch (e) {
    /* sharing must never break the app */
  } finally {
    perfSending_ = false;
  }
}
// The beta counts are rare, so ONE waiting entry is enough to send (at most every 2 h, 30 min after a failure).
async function betaSendMaybe_() {
  try {
    if (perfSending_ || perfInflight_ > 0 || document.hidden || !perfShareState_().on) return;
    const failed = localStorage.getItem("betaSendFailed") === "1";
    if (!PerfShare.shouldSend(betaOutbox_.status(), Date.now(), Number(localStorage.getItem("betaLastTry")) || 0, failed, 1)) return;
    perfSending_ = true;
    localStorage.setItem("betaLastTry", String(Date.now()));
    const ok = await perfSendOnce_(betaOutbox_, "reportBeta");
    localStorage.setItem("betaSendFailed", ok ? "0" : "1");
  } catch (e) {
    /* sharing must never break the app */
  } finally {
    perfSending_ = false;
  }
}
async function perfAndBetaSend_() { await perfSendMaybe_(); await betaSendMaybe_(); }
function perfSchedule_(delayMs) {
  setTimeout(() => { if (window.requestIdleCallback) requestIdleCallback(() => perfAndBetaSend_(), { timeout: 10000 }); else perfAndBetaSend_(); }, delayMs);
}
// Every time a screen becomes visible it counts once in this week's tally (docs/perf-share.js recordScreen); a finished week goes to
// the beta outbox as one entry per screen. Watching the screens' own hidden flag covers every way of getting to a screen.
const betaScreenObserver_ = new MutationObserver((records) => records.forEach((r) => {
  if (r.target.hidden) return;
  const name = PerfShare.screenName(r.target.id);
  if (name !== betaScreenNow_) { betaScreenBefore_ = betaScreenNow_; betaScreenNow_ = name; }
  betaCountScreen_(name);
}));
document.querySelectorAll(".screen").forEach((el) => betaScreenObserver_.observe(el, { attributes: true, attributeFilter: ["hidden"] }));
setTimeout(() => betaCountScreen_("entries"), 0);   // the app opens on Entries: counts as an opening, and closes a week that has ended
perfSchedule_(20000);                               // shortly after the app has opened and settled
setInterval(() => perfSchedule_(0), 15 * 60000);    // while it stays open
document.addEventListener("visibilitychange", () => { if (!document.hidden) perfSchedule_(15000); });

function todayLocalISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// A week out from a given YYYY-MM-DD — the default due date for a new
// standalone loan (see openLoanModal), shown pre-filled and editable
// rather than left blank, so it's obvious up front what'll actually be
// saved instead of it materializing invisibly (the backend's own
// addLoan has the same default as a fallback, for any call that bypasses
// this form).
function defaultDueDate_(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 7);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---- Setup screen (access code) ----

function isStandaloneApp_() {
  return navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
}

// On an iPhone, Safari and the Home Screen icon do not share storage: pasting the sign-in in Safari would be
// thrown away when the icon is opened. So in Safari the first screen shows the install steps (and a Copy button for
// the sign-in the setup page left in Safari), and pasting happens once, in the icon. "Only in Safari" skips this.
let installScreenSkipped_ = false;
function isIosSafariBrowser_() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent || "") && !isStandaloneApp_();
}

function showSetupScreen(message) {
  // A brand-new phone whose language is Spanish gets Spanish from the first screen (a choice made later in
  // More still wins). Only before any address is known, so the owner's phone is never affected.
  if (!getApiUrl() && !I18n.hasChosenLang() && /^es/i.test(navigator.language || "")) {
    I18n.saveLang("es");
    location.reload();
    return;
  }
  document.getElementById("app").hidden = true;
  const setup = document.getElementById("setup-screen");
  setup.hidden = false;
  // Typing an access code only makes sense once this app knows its own backend address.
  document.getElementById("setup-code-block").hidden = !getApiUrl();
  const showInstall = !getApiUrl() && isIosSafariBrowser_() && !installScreenSkipped_;
  document.getElementById("install-block").hidden = !showInstall;
  document.getElementById("link-block").hidden = showInstall;
  if (showInstall) {
    const waiting = SigninLink.parse(localStorage.getItem("etSigninHandoff") || "", { allowLocal: location.hostname === "localhost" });
    document.getElementById("install-step-copy").hidden = !waiting;
    document.getElementById("install-copy-btn").hidden = !waiting;
    document.getElementById("install-note").textContent = waiting ? "" : tr("link.noHandoff");
  }
  document.getElementById("link-intro").textContent = tr(isStandaloneApp_() ? "link.introInstalled" : "link.introBrowser");
  document.getElementById("setup-error").textContent = message || "";
}

document.getElementById("install-copy-btn").addEventListener("click", async () => {
  const note = document.getElementById("install-note");
  try {
    await navigator.clipboard.writeText(localStorage.getItem("etSigninHandoff") || "");
    note.style.color = "";
    note.textContent = tr("link.copied");
  } catch (err) {
    note.style.color = "#d64545";
    note.textContent = tr("link.copyBlocked");
  }
});

document.getElementById("use-safari-link").addEventListener("click", (e) => {
  e.preventDefault();
  installScreenSkipped_ = true;
  showSetupScreen();
});

// "Paste my sign-in": the setup page left a sign-in text on the clipboard (signin-link.js). This app has storage
// of its own on an iPhone (nothing the setup page saved in Safari is visible here), so this is how it learns its
// backend address and access code on first launch.
async function useSigninText_(text) {
  const errorEl = document.getElementById("setup-error");
  const link = SigninLink.parse(text, { allowLocal: location.hostname === "localhost" });
  if (!link) {
    errorEl.textContent = tr(String(text || "").trim() ? "link.notRight" : "link.nothing");
    return;
  }
  errorEl.textContent = tr("signin.signingIn");
  const previous = getApiUrl();
  setApiUrl(link.url);
  try {
    const res = await callApi("login", { code: link.code, deviceName: deviceName_() });
    setSessionToken(res.sessionToken);
    localStorage.removeItem("accessCode");
    errorEl.textContent = "";
    // Best effort: the sign-in text should not stay on the clipboard once it has done its job.
    if (isStandaloneApp_()) { try { await navigator.clipboard.writeText(""); } catch (err) { /* not allowed: harmless */ } }
    await init();
  } catch (err) {
    if (previous) setApiUrl(previous); else localStorage.removeItem("apiUrl");
    errorEl.textContent = err.message;
  }
}

document.getElementById("paste-btn").addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    document.getElementById("setup-error").textContent = tr("link.pasteBlocked");
    document.getElementById("paste-manual").open = true;
    return;
  }
  useSigninText_(text);
});

document.getElementById("paste-manual-btn").addEventListener("click", () => {
  useSigninText_(document.getElementById("paste-input").value);
});

document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("setup-code-input").value.trim();
  if (!code) return;
  const errorEl = document.getElementById("setup-error");
  errorEl.textContent = tr("signin.signingIn");
  try {
    const res = await callApi("login", { code, deviceName: deviceName_() });
    setSessionToken(res.sessionToken);
    localStorage.removeItem("accessCode");
    document.getElementById("setup-code-input").value = "";
    errorEl.textContent = "";
    await init();
  } catch (err) {
    errorEl.textContent = err.message;   // "Wrong access code." / "Too many wrong codes. Try again in N minutes."
  }
});

// ---- Meta loading & form population ----

// prefetchedMeta lets a caller that already has the data (see init(), which
// fetches meta/entries/pending/recurring together in one call) skip the
// network round trip; every other call site omits it and fetches as before.
// skipFormPopulate: used only by init()'s silent background refresh after
// an instant cache-paint (see renderCachedStartupBundle_) when the owner
// is actively using the entry form right that moment — rebuilding the
// category/payment-method/tag pickers under their fingers would reset
// whatever they'd already picked. `meta` itself is still updated either
// way, so anything opened fresh (a new pop-up, the next screen) sees
// current data; only this one already-open form keeps its stale-but-
// still-valid picker contents for the rest of the session.
// A friend added from ANY inline "+ Add friend…" (Paid by, repayment, loan,
// review) must show up at once in the expense form's split chips and the
// Programmed split chips too — those lists are only drawn when asked.
function refreshFriendChips_() {
  renderSplitFriendChips();
  if (typeof renderRecurringSplitFriendChips === "function") renderRecurringSplitFriendChips();
}

// The language chosen on this phone is kept in the Sheet too (see the picker in
// More). Re-sent once per app open if the Sheet disagrees, so a choice made
// before this existed — or while offline — still reaches the server.
let languageSynced_ = false;
function syncLanguageSetting_() {
  if (languageSynced_ || !meta || !meta.settings || !I18n.hasChosenLang()) return;
  languageSynced_ = true;
  if (meta.settings.language !== I18n.getLang()) callApi("setLanguage", { lang: I18n.getLang() }).catch(() => {});
}

let homeCurFormDone_ = false;
async function loadMeta(prefetchedMeta, skipFormPopulate) {
  meta = prefetchedMeta || await callApi("getMeta", {});
  if (typeof refreshExtrasRow_ === "function") refreshExtrasRow_();
  // A friend's copy remembers the quick currency buttons they chose (Settings favorite_currencies) on a new phone too.
  try {
    const fav = meta.settings && meta.settings.favorite_currencies;
    if (fav && !localStorage.getItem("recentCurrencies")) localStorage.setItem("recentCurrencies", JSON.stringify(String(fav).split(",").slice(0, 5)));
  } catch (e) { /* storage blocked */ }
  // Once per page load: the entry form starts in the main currency (its static default is soles).
  if (!homeCurFormDone_ && meta.settings && meta.settings.default_currency !== undefined) {
    homeCurFormDone_ = true;
    if (homeCur() !== "PEN") { document.getElementById("currency").value = homeCur(); renderCurrencyChips("entry"); }
  }
  if (typeof maybeShowWelcome_ === "function") maybeShowWelcome_();
  syncLanguageSetting_();
  if (skipFormPopulate) return;
  // Rebuilding the pickers resets them to their first option. A refresh
  // (pull-down, or any reload of the lists) while an edit screen is open must
  // not change what is already chosen there — it once flipped a pending card
  // entry's payment method to the first account in the list.
  const keptPicks = ["paid_by", "payment_method"].map((id) => document.getElementById(id).value);
  populateCategoryOptions();
  populateCategoryPicker();
  populatePaidByOptions();
  populatePaymentMethodOptions();
  ["paid_by", "payment_method"].forEach((id, k) => {
    const sel = document.getElementById(id);
    if (keptPicks[k] && Array.from(sel.options).some((o) => o.value === keptPicks[k])) sel.value = keptPicks[k];
  });
  togglePaymentMethodVisibility();   // paid by may have been restored: show/hide the payment method to match
  populateToPaymentMethodOptions();
  populateTags();
  populateTripOptions_();
  renderSplitFriendChips();
}

// Categories are always offered alphabetically by the name SHOWN (so the order
// follows the language), with "Other" last. A built-in carries key "other";
// before the categories cleanup has run, the name is the test.
function isOtherCategory_(c) { return c.key === "other" || (!c.key && c.name === "Other"); }
function sortedCategories_(list) {
  const locale = I18n.getLang() === "es" ? "es" : "en";
  return list.slice().sort((a, b) => {
    const aLast = isOtherCategory_(a), bLast = isOtherCategory_(b);
    if (aLast !== bLast) return aLast ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), locale, { sensitivity: "base" });
  });
}

// A hidden category (More → Categories) is left out of every "pick a category" list, but one
// already chosen on the record being edited (`keep`: an id, or a Set of ids) stays listed.
function catHidden_(c) { return String(c.hidden || "") === "yes"; }
function pickableCategories_(list, keep) {
  const kept = (c) => (keep instanceof Set ? keep.has(c.id) : keep != null && keep === c.id);
  return list.filter((c) => !catHidden_(c) || kept(c));
}

function populateCategoryOptions() {
  const select = document.getElementById("category");
  select.innerHTML = "";
  sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === selectedType)))
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      select.appendChild(opt);
    });
}

// ---- Category icon picker (Expense, Income — Investment/Transfer still
// use the plain dropdown until they get icon sets of their own) ----

const ICON_PICKER_TYPES = ["expense", "income"];

function populateCategoryPicker() {
  const grid = document.getElementById("category-picker");
  grid.innerHTML = "";
  sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === selectedType)))
    .forEach((c) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "category-tile";
      tile.innerHTML = `
        <span class="category-tile-icon" style="background:${c.color || "#eee"}">${c.icon || "•"}</span>
        <span class="category-tile-name">${escapeHtml(c.name)}</span>
      `;
      tile.addEventListener("click", () => { showDetailForm(c); preselectAnnualForTravel_(c.id); });
      grid.appendChild(tile);
    });
}

// Travel is Annual by default: picking a Travel category ticks the Annual chip
// (still removable by hand). Only for a pick the person just made — opening an
// existing entry for editing never goes through here, so an old Travel entry
// whose tag was removed stays as it is. The server applies the same rule to
// entries that arrive without the form (email, photo, statements).
// If the person then changes their mind to a non-Travel category, a tick that
// WE added is taken back (one they ticked themselves is left alone).
let annualAutoTicked = false;
function preselectAnnualForTravel_(categoryId) {
  if (selectedType !== "expense") return;
  const byId = new Map(meta.categories.map((c) => [c.id, c]));
  const isTravel = (c) => !!c && (c.key === "travel" || (!c.key && c.name === "Travel"));
  const cat = byId.get(categoryId);
  if (!isTravel(cat) && !(cat && isTravel(byId.get(cat.parent_id)))) {
    if (annualAutoTicked && selectedTagIds.delete("system-annual")) populateTags();
    annualAutoTicked = false;
    return;
  }
  if (!meta.tags.some((t) => t.id === "system-annual") || selectedTagIds.has("system-annual")) return;
  selectedTagIds.add("system-annual");
  annualAutoTicked = true;
  populateTags();
}

document.getElementById("category").addEventListener("change", (ev) => preselectAnnualForTravel_(ev.target.value));

function showCategoryPicker() {
  selectedCategoryId = null;
  populateCategoryPicker();
  document.getElementById("category-picker").hidden = false;
  document.getElementById("entry-form").hidden = true;
}

function showDetailForm(category) {
  const usesIconPicker = ICON_PICKER_TYPES.includes(selectedType);
  const banner = document.getElementById("selected-category-banner");
  const selectField = document.getElementById("category-select-field");

  if (usesIconPicker && category) {
    selectedCategoryId = category.id;
    document.getElementById("selected-category-icon").textContent = category.icon || "•";
    document.getElementById("selected-category-icon").style.background = category.color || "#eee";
    document.getElementById("selected-category-name").textContent = category.name;
    banner.hidden = false;
    selectField.hidden = true;
  } else {
    banner.hidden = true;
    // Investments have no category in the app (the backend files them under
    // a default one) — nothing to pick here.
    selectField.hidden = selectedType === "investment";
  }

  document.getElementById("category-picker").hidden = true;
  document.getElementById("entry-form").hidden = false;
  toggleSplitFieldVisibility();
  tripPickLocked_ = false;   // a fresh form: suggest again
  autoPickTripForDate_();
  // Safety net: whichever way the form was reached, the labels and the
  // From/To/Paid-by fields always match the entry type being shown.
  togglePaymentMethodVisibilityBase_();
  document.getElementById("paid-by-label").hidden = selectedType === "transfer";
  document.getElementById("paid_by").hidden = selectedType === "transfer";
  updateRepaymentUi_();

  const amountInput = document.getElementById("amount");
  amountInput.focus();
}

// Which widget is actually showing decides where the answer comes from —
// not just the type. An icon-picker type (expense/income) normally reads
// selectedCategoryId (set by tapping a tile), but falls back to the plain
// select whenever showDetailForm had no category tile to preselect (the
// banner stays hidden, the select field shows instead) — previously
// unreachable for a real Save (createEntry already requires a category,
// so a confirmed entry never has a blank one to edit into this state),
// but very much reachable now: a pending review-queue entry can have a
// genuinely blank category_id, and Phase 5.7's "Split" action reuses
// this exact form to confirm one. Without this, that fallback select was
// fully interactive but silently ignored — getCategoryId() kept reading
// the untouched, still-null selectedCategoryId no matter what was picked
// in it, always failing "Pick a category" even after picking one.
function getCategoryId() {
  // A transfer's category is always the select's value (it is hidden behind
  // the "Type of transfer" choice, but still holds "Between Accounts").
  if (selectedType === "transfer") return document.getElementById("category").value;
  const selectFieldVisible = !document.getElementById("category-select-field").hidden;
  if (selectFieldVisible) return document.getElementById("category").value;
  return selectedCategoryId;
}

document.getElementById("change-category-btn").addEventListener("click", showCategoryPicker);

// Income keeps its own list (Payors — a client, employer, "Acme
// Group") entirely separate from Friends: a friend paying for a shared
// expense is a debt relationship (see Loans in CLAUDE.md), but whoever
// pays the owner income isn't a debt at all, so it doesn't belong next
// to actual friends. "Me" only makes sense as an expense/investment/
// transfer payer, not an income source, so it's left out of the income
// list entirely.
function populatePaidByOptions() {
  const select = document.getElementById("paid_by");
  const label = document.getElementById("paid-by-label");
  select.innerHTML = "";

  if (selectedType === "income") {
    label.textContent = tr("field.receivedFrom");
    meta.payors.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    const addOpt = document.createElement("option");
    addOpt.value = "__add_payor__";
    addOpt.textContent = tr("common.addPayor");
    select.appendChild(addOpt);
  } else {
    label.textContent = tr("field.paidBy");
    const meOpt = document.createElement("option");
    meOpt.value = "me";
    meOpt.textContent = tr("common.me");
    select.appendChild(meOpt);

    meta.friends.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      select.appendChild(opt);
    });

    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = tr("common.addFriend");
    select.appendChild(addOpt);
  }

  togglePaymentMethodVisibility();
}

// A hidden account is left out of every "pick an account" list, but an old entry that used it must
// still show it when opened for editing (specs/accounts.md).
function pmHidden_(pm) { return String(pm.hidden || "") === "yes"; }
function keepHiddenAccountOption_(selectId, pmId) {
  const pm = pmId && meta.paymentMethods.find((p) => p.id === pmId);
  const select = document.getElementById(selectId);
  if (!pm || !pmHidden_(pm) || Array.from(select.options).some((o) => o.value === pmId)) return;
  const opt = document.createElement("option");
  opt.value = pm.id;
  opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
  select.appendChild(opt);
}

function populatePaymentMethodOptions() {
  const select = document.getElementById("payment_method");
  select.innerHTML = "";

  if (meta.paymentMethods.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = tr("common.noPaymentMethods");
    select.appendChild(opt);
  }

  // Investment platforms are never a "paid with" account — they're only
  // ever the destination of an investment entry (see Investments.gs).
  meta.paymentMethods.filter((pm) => pm.type !== "investment" && !pmHidden_(pm)).forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });

  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = tr("common.addPaymentMethod");
  select.appendChild(addOpt);
}

// Transfers only: "To" is the account the money lands in (see
// Balances.gs). Optional, so it starts on "None" — a transfer with no
// destination (e.g. money leaving to someone outside the app) keeps
// working exactly as before.
function populateToPaymentMethodOptions() {
  const select = document.getElementById("to_payment_method");
  const previous = select.value;
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  const anyPlatform = meta.paymentMethods.some((pm) => pm.type === "investment" && !pmHidden_(pm));
  noneOpt.textContent = selectedType === "investment" ? tr(anyPlatform ? "form.pickPlatform" : "form.noPlatforms") : tr("form.noneAccount");
  select.appendChild(noneOpt);
  // An investment's "To" is a platform; a transfer's is a real account.
  const wantPlatforms = selectedType === "investment";
  meta.paymentMethods.filter((pm) => (pm.type === "investment") === wantPlatforms && !pmHidden_(pm)).forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });
  select.value = previous;
  if (select.value !== previous) select.value = "";
}

function populateTags() {
  const container = document.getElementById("tags-list");
  container.innerHTML = "";
  meta.tags.forEach((tag) => {
    const chip = document.createElement("div");
    chip.className = "tag-chip" + (selectedTagIds.has(tag.id) ? " selected" : "");
    chip.textContent = tag.name;
    chip.addEventListener("click", () => {
      if (tag.id === "system-annual") annualAutoTicked = false;   // the person's own choice from here on
      if (selectedTagIds.has(tag.id)) selectedTagIds.delete(tag.id);
      else selectedTagIds.add(tag.id);
      populateTags();
    });
    container.appendChild(chip);
  });
}

function togglePaymentMethodVisibility() {
  togglePaymentMethodVisibilityBase_();
  updateRepaymentUi_();
  updateAutoTransferDescription_();
}

// A new plain transfer between the owner's own accounts gets "from X to Y" as
// its description automatically (filled as the accounts are picked, still
// editable). Only while the field is empty or still holds what was filled in
// here — anything typed by hand is never overwritten. Not for repayments /
// loans (they name the friend), nor when editing an existing entry.
let lastAutoDescription = "";
function updateAutoTransferDescription_() {
  const desc = document.getElementById("description");
  const typedByHand = desc.value.trim() !== "" && desc.value !== lastAutoDescription;
  if (typedByHand) { lastAutoDescription = ""; return; }
  let text = "";
  if (selectedType === "transfer" && !editingEntryId && !confirmingPendingId && transferKind_() === "between") {
    const nameOf = (id) => { const pm = meta.paymentMethods.find((p) => p.id === id); return pm ? pm.nickname.replace(/\s*\(\s*\d+\s*\)\s*$/, "") : ""; };  // nickname only, never the account digits
    const from = nameOf(document.getElementById("payment_method").value);
    const to = nameOf(document.getElementById("to_payment_method").value);
    if (from) text = to ? tr("transfer.autoFromTo", { from, to }) : tr("transfer.autoFrom", { from });
    else if (to) text = tr("transfer.autoInto", { to });
  }
  desc.value = text;
  lastAutoDescription = text;
}
document.getElementById("payment_method").addEventListener("change", updateAutoTransferDescription_);
document.getElementById("to_payment_method").addEventListener("change", updateAutoTransferDescription_);

// A transfer may have no "From" (money arriving from outside the app, e.g.
// the USD side of a currency exchange: the PEN leaves one account as its own
// entry, the USD arrives here as another). Only transfers get the extra
// "None" choice; it sits after the accounts so the default stays the first
// account.
function updateFromNoneOption_() {
  const select = document.getElementById("payment_method");
  const existing = select.querySelector("option[data-none]");
  if (selectedType === "transfer" && !existing) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.dataset.none = "1";
    opt.textContent = tr("form.noneFromOutside");
    const addOpt = Array.from(select.options).find((o) => o.value === "__add__");
    select.insertBefore(opt, addOpt || null);
  } else if (selectedType !== "transfer" && existing) {
    const wasNone = select.value === "";
    existing.remove();
    if (wasNone && select.options.length) select.selectedIndex = 0;
  }
}

function togglePaymentMethodVisibilityBase_() {
  // A transfer moves money between two accounts, so its payment method
  // reads as "From" and a "To" picker appears alongside it.
  const isInvestment = selectedType === "investment";
  document.getElementById("payment-method-label").textContent =
    selectedType === "transfer" || isInvestment ? tr("field.from") :
    selectedType === "income" ? tr("field.receivedAt") :
    tr("field.paymentMethod");
  document.getElementById("to-payment-method-field").hidden = selectedType !== "transfer" && !isInvestment;
  document.getElementById("to-payment-method-label").textContent = isInvestment ? tr("field.platform") : tr("field.toAccount");
  document.getElementById("to-payment-method-hint").hidden = isInvestment;
  updateFromNoneOption_();
  // A transfer has no "Paid by": who it came from is the From account (or
  // None). Friends are handled by the loan/repayment kinds. Kept at "me" so
  // the From account is always saved.
  const isTransfer = selectedType === "transfer";
  document.getElementById("paid-by-label").hidden = isTransfer;
  document.getElementById("paid_by").hidden = isTransfer;
  if (isTransfer) document.getElementById("paid_by").value = "me";
  document.getElementById("investment-direction-field").hidden = !isInvestment;
  populateToPaymentMethodOptions();

  // Income's payment method means "which account received this," which
  // has nothing to do with who paid it — unlike an expense, where it's
  // tied to paid_by === "me" (a friend paying means the owner's own
  // accounts were never touched). Always shown for income accordingly.
  if (selectedType === "income") {
    document.getElementById("payment-method-field").hidden = false;
    return;
  }
  const paidBy = document.getElementById("paid_by").value;
  document.getElementById("payment-method-field").hidden = paidBy !== "me";
}

// ---- Repayment / new loan with a friend (Transfer tab) ----
// The transfer type has a "Type of transfer" choice in the category's old
// slot: Between Accounts (a plain move between the owner's own accounts, the
// default), Repayments, or New loan. Repayments goes through the same
// recordRepayment FIFO/offset engine the Loans tab's "Record repayment"
// uses; New loan through addLoan (the Loans tab's "+ Add loan"). Both also
// write the linked transfer Entry, and neither is ever an expense or income
// (principle 2). These are choices on the form, NOT rows in the Categories
// sheet: a real category could be put on a transfer without touching any
// debt.
// Direction buttons are worded from the owner's side: "I paid them" /
// "They paid me". For a repayment that means the debt direction
// i_owe_them / they_owe_me; for a NEW LOAN it is the other way round (I paid
// them = I lent it, so they owe me) — see debtDirection_().
let repaymentDirectionChoice = "i_owe_them"; // "I paid them"; or "they_owe_me" = "They paid me"

// Also offered when editing an existing expense or plain transfer ("I saved
// this as X but it was really a repayment / loan") — the swap is one server
// call (convertEntryToRepayment / convertEntryToLoan), which refuses safely
// when the entry is already part of a loan/repayment and puts everything
// back if anything fails.
function repaymentAvailable_() {
  return selectedType === "transfer" && !confirmingPendingId &&
    (!editingEntryId || editingEntryOriginalType === "expense" || editingEntryOriginalType === "income" || editingEntryOriginalType === "transfer");
}

// "between" | "repayment" | "loan"
function transferKind_() {
  return repaymentAvailable_() ? document.getElementById("transfer-kind").value : "between";
}

function repaymentActive_() {
  return transferKind_() !== "between";
}

// The debt's direction (Loans.direction) for what's being saved.
function debtDirection_() {
  const iPaid = repaymentDirectionChoice === "i_owe_them";
  if (transferKind_() === "loan") return iPaid ? "they_owe_me" : "i_owe_them";
  return repaymentDirectionChoice;
}

function populateRepaymentFriendOptions_() {
  const select = document.getElementById("repayment-friend");
  const previous = select.value;
  select.innerHTML = "";
  meta.friends.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    select.appendChild(opt);
  });
  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = tr("common.addFriend");
  select.appendChild(addOpt);
  if (previous && previous !== "__add__" && meta.friends.some((f) => f.id === previous)) select.value = previous;
}

document.getElementById("repayment-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt(tr("prompt.friendName"));
  e.target.value = meta.friends.length ? meta.friends[0].id : "";
  if (name && name.trim()) {
    const friend = await callApi("addFriend", { name: name.trim() });
    meta.friends.push(friend);
    refreshFriendChips_();
    populateRepaymentFriendOptions_();
    document.getElementById("repayment-friend").value = friend.id;
  }
});

function updateRepaymentUi_() {
  const available = repaymentAvailable_();
  document.getElementById("repayment-field").hidden = !available;
  // For a transfer the "Type of transfer" choice stands in for the category
  // dropdown (its only option was "Between Accounts"); the category select
  // stays in the page holding that value for a plain transfer.
  if (selectedType === "transfer") document.getElementById("category-select-field").hidden = available;
  const kindSelect = document.getElementById("transfer-kind");
  if (!available) kindSelect.value = "between";
  const kind = transferKind_();
  document.getElementById("repayment-detail").hidden = kind === "between";
  if (kind === "between") return;

  const isLoan = kind === "loan";
  const iPaid = repaymentDirectionChoice === "i_owe_them";
  document.querySelectorAll("#repayment-direction-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.direction === repaymentDirectionChoice));
  if (!document.getElementById("repayment-friend").options.length) populateRepaymentFriendOptions_();

  document.getElementById("repayment-overpay-block").hidden = isLoan;
  document.getElementById("loan-due-block").hidden = !isLoan;
  if (!isLoan) {
    populateCategoryOptionsForSelect_("repayment-overpay-category", iPaid ? "expense" : "income");
    document.getElementById("repayment-overpay-category-label").textContent = iPaid ? tr("transfer.overpayCategoryIPaid") : tr("transfer.overpayCategoryTheyPaid");
  }
  document.getElementById("repayment-hint").textContent = isLoan
    ? (iPaid ? tr("transfer.hintLoanIPaid") : tr("transfer.hintLoanTheyPaid"))
    : (iPaid ? tr("transfer.hintRepayIPaid") : tr("transfer.hintRepayTheyPaid"));

  // This replaces the transfer's own fields: no "Paid by", no "To" — just
  // the one account the money moved through.
  document.getElementById("paid-by-label").hidden = true;
  document.getElementById("paid_by").hidden = true;
  document.getElementById("to-payment-method-field").hidden = true;
  document.getElementById("payment-method-field").hidden = false;
  document.getElementById("payment-method-label").textContent = iPaid ? tr("field.paidFromAccount") : tr("field.receivedIntoAccount");
}

document.getElementById("transfer-kind").addEventListener("change", () => {
  // Undo what a previous non-"between" state hid, then let the normal rules re-apply.
  document.getElementById("paid-by-label").hidden = selectedType === "transfer";
  document.getElementById("paid_by").hidden = selectedType === "transfer";
  // Converting a friend-paid expense: that friend is almost certainly the
  // one being repaid.
  const paidBy = document.getElementById("paid_by").value;
  if (repaymentActive_() && editingEntryId && meta.friends.some((f) => f.id === paidBy)) {
    populateRepaymentFriendOptions_();
    document.getElementById("repayment-friend").value = paidBy;
  }
  togglePaymentMethodVisibility();
});

document.querySelectorAll("#repayment-direction-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    repaymentDirectionChoice = tab.dataset.direction;
    updateRepaymentUi_();
  });
});

// ---- Splitting an expense (Phase 5) ----
// Only expenses can be split (Entry Splits is "only used for shared
// expenses" per CLAUDE.md) — every other type keeps the field hidden and
// the split state gets cleared so a stale selection can't leak back in if
// the owner switches back to expense later.
function toggleSplitFieldVisibility() {
  const show = selectedType === "expense";
  document.getElementById("split-field").hidden = !show;
  if (!show) resetSplitState();
  // Only an expense can belong to a trip or event, so the picker follows the same rule.
  document.getElementById("trip-field").hidden = !show || !(meta.trips || []).length;
  if (!show) document.getElementById("entry-trip").value = "";
}

function resetSplitState() {
  billState = null;
  billApplied = false;
  billItemsEdited = false;
  splitFriendIds = new Set();
  splitMode = "equal";
  customSplitAmounts = {};
  customOwnAmount = "";
  splitFriendsExpanded = false;
  document.getElementById("split-toggle").checked = false;
  document.getElementById("split-detail").hidden = true;
  document.querySelectorAll("#split-mode-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === "equal");
  });
  renderSplitFriendChips();
  renderSplitRows();
  document.getElementById("split-summary").textContent = "";
  document.getElementById("split-error").textContent = "";
}

// The friend picker shows at most 3 rows, most-recently-used first (by
// `last_used`, see getFriendsWithLastUsed_ in Api.gs); a "More…" chip ends
// the third row and expands to everyone (then "Less"). Rows are measured
// from the real layout, since chip widths vary with the names. A selected
// friend is never left hidden — that forces the list open instead.
let splitFriendsExpanded = false;
const SPLIT_FRIEND_MAX_ROWS = 3;

function renderSplitFriendChips() {
  const container = document.getElementById("split-friend-chips");
  container.innerHTML = "";
  const sorted = meta.friends
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.last_used || "").localeCompare(a.f.last_used || "") || a.i - b.i)
    .map((x) => x.f);

  const chips = sorted.map((f) => {
    const chip = document.createElement("div");
    chip.className = "tag-chip" + (splitFriendIds.has(f.id) ? " selected" : "");
    chip.textContent = f.name;
    chip.addEventListener("click", () => {
      if (splitFriendIds.has(f.id)) {
        splitFriendIds.delete(f.id);
        delete customSplitAmounts[f.id];
      } else {
        splitFriendIds.add(f.id);
      }
      renderSplitFriendChips();
      renderSplitRows();
      renderSplitSummary();
    });
    container.appendChild(chip);
    return { f, chip };
  });

  const toggle = document.createElement("div");
  toggle.className = "tag-chip more-chip";
  toggle.addEventListener("click", () => {
    splitFriendsExpanded = !splitFriendsExpanded;
    renderSplitFriendChips();
  });

  if (splitFriendsExpanded) {
    toggle.textContent = tr("common.less");
    container.appendChild(toggle);
    return;
  }

  // Collapsed: needs a laid-out (visible) container to measure rows.
  if (!container.offsetWidth) return;
  const rowCount = () => {
    const tops = new Set();
    Array.from(container.children).forEach((el) => { if (!el.hidden) tops.add(el.offsetTop); });
    return tops.size;
  };
  if (rowCount() <= SPLIT_FRIEND_MAX_ROWS) return; // everyone fits, no "More" needed

  toggle.textContent = tr("common.more");
  container.appendChild(toggle);
  // Hide chips from the end until the "More…" chip lands within row 3.
  let visible = chips.length;
  while (visible > 0 && rowCount() > SPLIT_FRIEND_MAX_ROWS) {
    visible--;
    chips[visible].chip.hidden = true;
  }
  if (chips.slice(visible).some((c) => splitFriendIds.has(c.f.id))) {
    splitFriendsExpanded = true;
    renderSplitFriendChips();
  }
}

// Only custom mode needs a row per friend — equal mode's amounts are
// computed, not typed, so there's nothing to show below the chips there.
function renderSplitRows() {
  const container = document.getElementById("split-rows");
  container.innerHTML = "";
  splitInputEls = {};
  if (splitMode !== "custom" || splitFriendIds.size === 0) return;

  const addRow = (key, label, getValue, setValue) => {
    const row = document.createElement("div");
    row.className = "split-row";

    const name = document.createElement("span");
    name.className = "split-row-name";
    name.textContent = label;

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "0.00";
    input.value = getValue() || "";
    input.addEventListener("input", (e) => {
      setValue(e.target.value);
      renderSplitSummary();
    });

    splitInputEls[key] = input;
    row.appendChild(name);
    row.appendChild(input);
    container.appendChild(row);
  };

  addRow("me", tr("common.me"), () => customOwnAmount, (v) => { customOwnAmount = v; });
  Array.from(splitFriendIds).forEach((id) => {
    const friend = meta.friends.find((f) => f.id === id);
    if (!friend) return;
    addRow(id, friend.name, () => customSplitAmounts[id], (v) => { customSplitAmounts[id] = v; });
  });
}

// Custom mode: any box the owner filled is fixed; every EMPTY box (Me
// included) shares what's left equally. Cents-based so it sums exactly —
// a leftover cent goes to the owner if their box is empty, otherwise to
// the last empty friend. Returns { amounts: {key: number}, openKeys,
// unassigned (cents nobody's box absorbs — only when every box is filled),
// over (fixed boxes exceed the total) }.
function computeCustomShares() {
  const totalCents = Math.round((parseFloat(document.getElementById("amount").value) || 0) * 100);
  const keys = ["me", ...Array.from(splitFriendIds)];
  const raw = (k) => String(k === "me" ? customOwnAmount : customSplitAmounts[k] || "").trim();
  const isFilled = (k) => raw(k) !== "" && !isNaN(parseFloat(raw(k)));

  const amounts = {};
  let fixedCents = 0;
  keys.filter(isFilled).forEach((k) => {
    const c = Math.round(parseFloat(raw(k)) * 100);
    amounts[k] = c / 100;
    fixedCents += c;
  });
  const openKeys = keys.filter((k) => !isFilled(k));
  const restCents = totalCents - fixedCents;

  if (openKeys.length && restCents >= 0) {
    const each = Math.floor(restCents / openKeys.length);
    const leftover = restCents - each * openKeys.length;
    const leftoverKey = openKeys.includes("me") ? "me" : openKeys[openKeys.length - 1];
    openKeys.forEach((k) => { amounts[k] = (each + (k === leftoverKey ? leftover : 0)) / 100; });
  }
  return {
    amounts,
    openKeys,
    unassigned: openKeys.length ? 0 : restCents,
    over: restCents < 0,
  };
}

// Splits inherit the entry's own currency — Entry Splits has no currency
// column of its own (see CLAUDE.md's Data model section).
function computeEqualShares(amount, friendIds) {
  const n = friendIds.length;
  if (n === 0 || !amount) return { shareEach: 0, ownerShare: amount || 0 };
  // Cents-based so the split always sums exactly to the total — any
  // rounding leftover goes to the owner's own (never-stored) share rather
  // than to a friend, so no one else ever sees an odd extra cent.
  const totalCents = Math.round(amount * 100);
  const shareCentsEach = Math.floor(totalCents / (n + 1));
  const ownerCents = totalCents - shareCentsEach * n;
  return { shareEach: shareCentsEach / 100, ownerShare: ownerCents / 100 };
}

function renderSplitSummary() {
  const summaryEl = document.getElementById("split-summary");
  const errorEl = document.getElementById("split-error");
  errorEl.textContent = "";

  const amount = parseFloat(document.getElementById("amount").value) || 0;
  const currency = (document.getElementById("currency").value || homeCur()).toUpperCase();
  const friendIds = Array.from(splitFriendIds);

  if (friendIds.length === 0) {
    summaryEl.textContent = tr("split.pickWho");
    return;
  }

  if (splitMode === "equal") {
    const { shareEach, ownerShare } = computeEqualShares(amount, friendIds);
    summaryEl.textContent = tr("split.summaryEqual", { cur: currency, each: moneyFmt(shareEach), own: moneyFmt(ownerShare) });
  } else {
    const shares = computeCustomShares();
    // Empty boxes show what they'd get, as their placeholder.
    Object.keys(splitInputEls).forEach((k) => {
      splitInputEls[k].placeholder = shares.openKeys.includes(k) && !shares.over ? moneyFmt(shares.amounts[k]) : "0.00";
    });
    if (shares.over) {
      summaryEl.textContent = "";
      errorEl.textContent = tr("split.errorOver");
    } else if (shares.unassigned) {
      summaryEl.textContent = "";
      errorEl.textContent = tr("split.errorEveryoneFilled", { cur: currency, sum: moneyFmt(amount - shares.unassigned / 100), total: moneyFmt(amount) });
    } else {
      const friendsTotal = friendIds.reduce((sum, id) => sum + (shares.amounts[id] || 0), 0);
      summaryEl.textContent = tr("split.summaryCustom", { cur: currency, friends: moneyFmt(friendsTotal), total: moneyFmt(amount), own: moneyFmt(shares.amounts.me) });
    }
  }
}

function getSplitPayload() {
  const amount = parseFloat(document.getElementById("amount").value) || 0;
  const friendIds = Array.from(splitFriendIds);

  if (splitMode === "equal") {
    const { shareEach } = computeEqualShares(amount, friendIds);
    return friendIds.map((id) => ({ friend_id: id, amount: shareEach }));
  }
  const shares = computeCustomShares();
  return friendIds
    .map((id) => ({ friend_id: id, amount: shares.amounts[id] || 0 }))
    .filter((s) => s.amount > 0);
}

// Called from the submit handler, before anything is saved. Returns the
// split array to send once the entry itself exists, or null when the
// split toggle is off — throws (same as the other field checks there) so
// a bad split blocks the save instead of silently saving a broken one.
function validateSplitIfEnabled() {
  if (selectedType !== "expense" || !document.getElementById("split-toggle").checked) return null;

  const amount = parseFloat(document.getElementById("amount").value) || 0;
  const friendIds = Array.from(splitFriendIds);
  if (friendIds.length === 0) {
    throw new Error(tr("split.errNoFriend"));
  }

  const splits = getSplitPayload();
  const assigned = splits.reduce((sum, s) => sum + s.amount, 0);
  if (splitMode === "custom") {
    const shares = computeCustomShares();
    if (shares.over) throw new Error(tr("split.errOverTotal"));
    if (shares.unassigned) throw new Error(tr("split.errNotTotal"));
    if (assigned <= 0) throw new Error(tr("split.errNoAmount"));
  }
  if (assigned - amount > 0.004) {
    throw new Error(tr("split.errOverTotal"));
  }
  return splits;
}

document.getElementById("split-toggle").addEventListener("change", (e) => {
  document.getElementById("split-detail").hidden = !e.target.checked;
  // Common case per CLAUDE.md: paying and sharing with just that one
  // friend — pre-select them so the owner isn't required to re-pick who
  // they just chose in "Paid by". Only on turning the toggle ON, and only
  // if nothing's selected yet, so it never overrides a manual edit.
  if (e.target.checked && splitFriendIds.size === 0) {
    const paidBy = document.getElementById("paid_by").value;
    if (paidBy && paidBy !== "me" && meta.friends.some((f) => f.id === paidBy)) {
      splitFriendIds.add(paidBy);
    }
  }
  renderSplitFriendChips();
  renderSplitRows();
  renderSplitSummary();
});

document.querySelectorAll("#split-mode-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    splitMode = tab.dataset.mode;
    document.querySelectorAll("#split-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderSplitRows();
    renderSplitSummary();
  });
});

document.getElementById("split-add-friend-btn").addEventListener("click", async () => {
  const name = prompt(tr("prompt.friendName"));
  if (!name || !name.trim()) return;
  const friend = await callApi("addFriend", { name: name.trim() });
  friend.last_used = todayLocalISO();
  meta.friends.push(friend);
  refreshFriendChips_();
  splitFriendIds.add(friend.id);
  renderSplitFriendChips();
  renderSplitRows();
  renderSplitSummary();
});

document.getElementById("amount").addEventListener("input", () => {
  if (document.getElementById("split-toggle").checked) renderSplitSummary();
});

// ---- Investment deposit / withdrawal ----
// A withdrawal is stored as a NEGATIVE investment amount (see
// Investments.gs); the form always shows the plain positive number.
let investmentDirection = "deposit";

function setInvestmentDirection(direction) {
  investmentDirection = direction;
  document.querySelectorAll("#investment-direction-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.direction === direction));
  document.getElementById("investment-direction-hint").textContent = direction === "withdrawal"
    ? tr("investment.withdrawalHint")
    : tr("investment.depositHint");
}

document.querySelectorAll("#investment-direction-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setInvestmentDirection(tab.dataset.direction));
});

// ---- Type tabs ----

document.querySelectorAll("#entry-type-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    selectedType = tab.dataset.type;
    document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
    populateCategoryOptions();
    populatePaidByOptions();
    if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    } else {
      showDetailForm(null);
    }
  });
});

// ---- Paid by / payment method / friend & payment method inline add ----

document.getElementById("paid_by").addEventListener("change", async (e) => {
  if (e.target.value === "__add__") {
    const name = prompt(tr("prompt.friendName"));
    e.target.value = "me";
    if (name && name.trim()) {
      const friend = await callApi("addFriend", { name: name.trim() });
      meta.friends.push(friend);
      refreshFriendChips_();
      populatePaidByOptions();
      document.getElementById("paid_by").value = friend.id;
    }
  } else if (e.target.value === "__add_payor__") {
    const name = prompt(tr("prompt.payorName"));
    e.target.value = meta.payors.length ? meta.payors[0].id : "";
    if (name && name.trim()) {
      const payor = await callApi("addPayor", { name: name.trim() });
      meta.payors.push(payor);
      populatePaidByOptions();
      document.getElementById("paid_by").value = payor.id;
    }
  }
  togglePaymentMethodVisibility();
});

// The type is stored in English in the Sheet (credit, debit, cash, transfer,
// wallet); the owner may type it in either language.
const PAYMENT_METHOD_TYPE_WORDS = {
  credit: "credit", "crédito": "credit", credito: "credit", "tarjeta de crédito": "credit",
  debit: "debit", "débito": "debit", debito: "debit", "tarjeta de débito": "debit",
  cash: "cash", efectivo: "cash",
  transfer: "transfer", transferencia: "transfer",
  wallet: "wallet", billetera: "wallet"
};
function paymentMethodTypeFromAnswer_(answer) {
  const word = String(answer || "").trim().toLowerCase();
  return PAYMENT_METHOD_TYPE_WORDS[word] || (word ? word : "credit");
}

document.getElementById("payment_method").addEventListener("change", async (e) => {
  if (e.target.value === "__add__") {
    const nickname = prompt(tr("prompt.paymentMethodName"));
    if (!nickname || !nickname.trim()) {
      e.target.value = "";
      return;
    }
    const trimmed = nickname.trim();

    // Reuse an existing one instead of creating a duplicate (e.g. picking
    // "+ Add payment method…" again and typing "Cash" a second time).
    const existing = meta.paymentMethods.find((pm) => pm.nickname.trim().toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      document.getElementById("payment_method").value = existing.id;
      return;
    }

    const type = paymentMethodTypeFromAnswer_(prompt(tr("prompt.paymentMethodType"), "credit"));
    const last4 = prompt(tr("prompt.last4")) || "";
    const pm = await callApi("addPaymentMethod", { nickname: trimmed, type: type.trim(), last_4: last4.trim() });
    meta.paymentMethods.push(pm);
    populatePaymentMethodOptions();
    populateToPaymentMethodOptions();
    document.getElementById("payment_method").value = pm.id;
  }
});

document.getElementById("add-tag-btn").addEventListener("click", async () => {
  const name = prompt(tr("prompt.tagName"));
  if (name && name.trim()) {
    const tag = await callApi("addTag", { name: name.trim() });
    meta.tags.push(tag);
    selectedTagIds.add(tag.id);
    populateTags();
  }
});

// ---- Amount input: always use a decimal point ----
// Native number inputs render the decimal separator based on the device's
// locale (a comma on many non-US locales), which fights with how amounts
// are parsed/stored everywhere else in the app. Using a plain text input
// with our own sanitizing keeps "." as the only decimal separator, while
// still bringing up the numeric keypad on a phone via inputmode="decimal".
// Shared with the review-queue amount field below.
function sanitizeAmountInputValue(value) {
  // Both separators at once ("1,234.50" pasted whole, or "1.234,50"): the
  // LAST one is the decimal point and the other is a thousands separator.
  // Without this, the comma became a dot and the second dot was then
  // dropped, turning 1,234.50 into 1.2345 — a 1000x error. (Typing it key
  // by key can't be told apart from a decimal comma, so a lone comma still
  // means "decimal point", as before.)
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    value = lastComma > lastDot
      ? value.replace(/\./g, "")
      : value.replace(/,/g, "");
  }
  let v = value.replace(/,/g, ".");
  v = v.replace(/[^\d.]/g, "");
  const firstDot = v.indexOf(".");
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
  }
  return v;
}

document.getElementById("amount").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
});

// ---- Currency & exchange rate ----

const knownRateMonths_ = new Set();

async function ensureExchangeRate(currency, dateStr) {
  if (currency === homeCur()) return;
  const month = dateStr.slice(0, 7);
  // A rate that exists stays (it can be edited, not removed), so a month
  // confirmed once this session isn't asked about again — saving a
  // foreign-currency edit used to wait on this round trip every time.
  const key = currency + "|" + month;
  if (knownRateMonths_.has(key)) return;
  const existing = await callApi("getExchangeRate", { currency, month });
  if (existing) { knownRateMonths_.add(key); return; }

  const rate = await openRateModal(currency, month, /* required */ true);
  if (rate == null) {
    throw new Error(tr("error.rateRequired"));
  }
}

// One shared modal for entering a rate, used by both the entry flow
// (required — see ensureExchangeRate) and the budget flow (optional — see
// refreshBudgetRateWarning_'s "Set one" link, below). Always stores the
// rate in its canonical meaning,
// "1 currency = rate PEN" (per CLAUDE.md's Exchange Rates section), even
// though the UI defaults to that same orientation for readability (the
// foreign currency's "1" on the left) and lets the owner flip it to enter
// "1 PEN = __ <currency>" instead if that's more natural for them —
// inverted back to the canonical meaning before saving either way.
let rateModalState = null; // { currency, month, inverted, resolve, existingRate }

function renderRateModalLabels_() {
  const { currency, inverted, existingRate } = rateModalState;
  document.getElementById("rate-left-label").textContent = inverted ? `1 ${homeCur()}` : `1 ${currency}`;
  document.getElementById("rate-right-label").textContent = inverted ? currency : homeCur();
  // existingRate is always in the canonical "1 currency = rate PEN"
  // orientation (see the comment above) — flip it for display whenever
  // the owner has toggled to the "1 PEN = __ currency" view, same as the
  // save handler flips it back on the way in.
  const displayValue = existingRate == null ? "" : (inverted ? 1 / existingRate : existingRate);
  document.getElementById("rate-value-input").value = displayValue === "" ? "" : String(displayValue);
}

// existingRate (optional) pre-fills the input for editing an already-set
// rate — omitted, the field just starts blank (a brand-new rate).
function openRateModal(currency, month, required, existingRate) {
  return new Promise((resolve) => {
    rateModalState = { currency, month, inverted: false, resolve, existingRate: existingRate != null ? existingRate : null };
    document.getElementById("rate-modal-title").textContent = tr("rateModal.titleWithCurrency", { currency });
    document.getElementById("rate-modal-subtitle").textContent = existingRate != null
      ? tr("rateModal.editing", { currency, month })
      : tr("rateModal.none", { currency, month });
    document.getElementById("rate-cancel-btn").hidden = !!required;
    document.getElementById("rate-form-error").textContent = "";
    renderRateModalLabels_();
    const backdrop = document.getElementById("rate-modal-backdrop");
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
    document.getElementById("rate-value-input").focus();
  });
}

function closeRateModal_(result) {
  document.getElementById("rate-modal-backdrop").hidden = true;
  const resolve = rateModalState && rateModalState.resolve;
  rateModalState = null;
  if (resolve) resolve(result);
}

document.getElementById("rate-invert-btn").addEventListener("click", () => {
  if (!rateModalState) return;
  rateModalState.inverted = !rateModalState.inverted;
  renderRateModalLabels_();
});

document.getElementById("rate-value-input").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
});

document.getElementById("rate-modal-close").addEventListener("click", () => closeRateModal_(null));
document.getElementById("rate-cancel-btn").addEventListener("click", () => closeRateModal_(null));
document.getElementById("rate-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "rate-modal-backdrop") closeRateModal_(null);
});

document.getElementById("rate-save-btn").addEventListener("click", async () => {
  if (!rateModalState) return;
  const errorEl = document.getElementById("rate-form-error");
  errorEl.textContent = "";

  const raw = parseFloat(document.getElementById("rate-value-input").value);
  if (!raw || raw <= 0) {
    errorEl.textContent = tr("rateModal.validNumber");
    return;
  }

  const { currency, month, inverted } = rateModalState;
  const rate = inverted ? 1 / raw : raw;
  const saveBtn = document.getElementById("rate-save-btn");
  saveBtn.disabled = true;
  try {
    // A typo like 37 instead of 3.7 would silently rewrite every report for
    // that month, so a rate that differs a lot from the previous one has to be
    // confirmed (rule from specs/entries-and-categories.md, Exchange Rates).
    const [yy, mm] = month.split("-").map(Number);
    const prevMonth = mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, "0")}`;
    const prev = (await callApi("getLatestRateOnOrBefore", { currency, month: prevMonth })).rate;
    if (prev && Math.abs(rate / prev - 1) > 0.10) {
      const pct = Math.round(Math.abs(rate / prev - 1) * 100);
      if (!confirm(tr(rate > prev ? "rateModal.confirmHigher" : "rateModal.confirmLower", { rate, pct, prev }))) {
        saveBtn.disabled = false;
        return;
      }
    }
    await callApi("setExchangeRate", { currency, month, rate });
    closeRateModal_(rate);
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// A brief, non-error confirmation in the same spot #form-error normally
// shows validation problems — reused rather than a new toast system, just
// recolored and auto-cleared so it doesn't linger like a real error would.
function showFormNotice_(text) {
  const el = document.getElementById("form-error");
  el.style.color = "var(--income)";
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = "";
      el.style.color = "#d64545";
    }
  }, 6000);
}

// ---- Submit ----

document.getElementById("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById("submit-btn");
  const errorEl = document.getElementById("form-error");
  errorEl.textContent = "";
  submitBtn.disabled = true;
  // Captured before anything below runs — the editingEntryId/
  // confirmingPendingId branches null it out themselves (exitEditMode)
  // partway through, so this is the only reliable way for the tail at
  // the bottom to know whether this save finished an edit of an existing
  // entry, vs. created a brand-new one.
  const wasEditingExistingEntry = !!editingEntryId;
  // Flips to true the moment every write to the server has succeeded. After
  // that, a failure (typically the list refresh on a flaky connection) must
  // not be reported as "save failed" — the owner would just re-enter the
  // entry and create a duplicate.
  let writesDone = false;
  let splitSaveFailed = false;
  let billSaveFailed = false;
  let popupHiddenEarly = false;

  try {
    const date = document.getElementById("date").value;
    const amount = parseFloat(document.getElementById("amount").value);
    const currency = document.getElementById("currency").value.toUpperCase();
    const isRepayment = repaymentActive_();
    const categoryId = isRepayment ? "" : getCategoryId();
    const description = document.getElementById("description").value.trim();
    const paidBy = document.getElementById("paid_by").value;
    const paymentMethodId = document.getElementById("payment_method").value;
    // Same condition togglePaymentMethodVisibility() uses to show the
    // field — income always carries a payment method (which account
    // received it), an expense/investment/transfer only when the owner
    // themselves paid.
    const usesPaymentMethod = isRepayment || selectedType === "income" || paidBy === "me";
    // Transfers only; always sent (even blank) so switching an entry away
    // from transfer, or clearing the destination, actually clears it.
    const toPaymentMethodId = selectedType === "transfer" || selectedType === "investment" ? document.getElementById("to_payment_method").value : "";
    if (selectedType === "transfer" && toPaymentMethodId && toPaymentMethodId === paymentMethodId) {
      throw new Error(tr("error.sameAccount"));
    }
    if (selectedType === "investment" && !toPaymentMethodId && !editingEntryId) {
      throw new Error(tr("error.pickPlatform"));
    }
    const isWithdrawal = selectedType === "investment" && investmentDirection === "withdrawal";

    if (!date) throw new Error(tr("error.dateRequired"));
    if (!amount || amount <= 0) throw new Error(tr("error.validAmount"));
    const isInvestmentEntry = selectedType === "investment";
    if (!isRepayment && !isInvestmentEntry && !categoryId) throw new Error(tr("error.pickCategory"));
    // Investments send no category at all — the server files them under its default.
    const categoryField = isInvestmentEntry ? {} : { category_id: categoryId };
    if (selectedType === "transfer" && !isRepayment && !paymentMethodId && !toPaymentMethodId) {
      throw new Error(tr("error.pickAccount"));
    }
    // A transfer may have only a "To" (money arriving from outside the app).
    if (usesPaymentMethod && !paymentMethodId && !(selectedType === "transfer" && toPaymentMethodId)) throw new Error(tr("error.pickPaymentMethod"));
    const splits = validateSplitIfEnabled();
    const tagIds = Array.from(selectedTagIds);
    const tripId = selectedType === "expense" ? document.getElementById("entry-trip").value : "";

    // A future-dated save that's a plain, fully-owned transaction (not a
    // transfer between the owner's own accounts, not shared with a friend
    // — those need real Entry/Splits machinery this doesn't have) becomes
    // a Programmed, one-time item instead of a confirmed Entry, so it
    // never shows in "Recent entries" until it's actually real. Only for
    // a genuinely new save — editing an existing real entry into a future
    // date doesn't retroactively un-become a real entry. A split expense
    // needs the same real Entry/Splits machinery a friend-paid one does,
    // even when the owner themselves paid, so it's excluded here too.
    const isFutureDate = !editingEntryId && !confirmingPendingId && date > todayLocalISO();
    const canProgram = isFutureDate && selectedType !== "transfer" && !isWithdrawal &&
      (selectedType === "income" || paidBy === "me") && !splits;
    let programmedInstead = false;

    if (isRepayment) {
      const friendId = document.getElementById("repayment-friend").value;
      if (!friendId || friendId === "__add__") throw new Error(tr("error.pickFriend"));
      const friendName = (meta.friends.find((f) => f.id === friendId) || {}).name || "";
      const isLoanKind = transferKind_() === "loan";
      const direction = debtDirection_();
      const overpayCategoryId = document.getElementById("repayment-overpay-category").value;
      const fields = {
        friend_id: friendId,
        direction,
        amount,
        currency,
        date,
        payment_method_id: paymentMethodId,
        description
      };
      if (isLoanKind) fields.due_date = document.getElementById("loan-due-date").value;
      let result;
      let extraNote = "";
      if (editingEntryId) {
        // Swapping an existing expense/transfer for the repayment / loan: one
        // server call that checks everything first and undoes itself if
        // anything fails (see convertEntryInto_ in Loans.gs).
        // From the edit pop-up: it closes now while the server works, and
        // comes back with the error shown if the conversion is refused.
        if (editingViaPopup) {
          document.getElementById("edit-entry-modal-backdrop").hidden = true;
          popupHiddenEarly = true;
        }
        result = await callApi(isLoanKind ? "convertEntryToLoan" : "convertEntryToRepayment", {
          ...fields,
          entry_id: editingEntryId,
          ...(isLoanKind ? {} : { overpay_category_id: overpayCategoryId })
        });
        exitEditMode();
      } else if (isLoanKind) {
        result = await callApi("addLoan", fields);
      } else {
        // More than was owed (or nothing was owed): the server books the
        // leftover itself, in the same request — confirmed if a category was
        // chosen, otherwise as a pending entry in the review queue.
        result = await callApi("recordRepayment", { ...fields, overpay_category_id: overpayCategoryId });
      }
      if (!isLoanKind && result.overpaid > 0.004) {
        const isIncome = direction === "they_owe_me";
        const noteKey = (overpayCategoryId ? "repay.overpaidRecorded" : "repay.overpaidPending") + (isIncome ? "Income" : "Expense");
        extraNote = tr(noteKey, { cur: currency, amount: moneyFmt(result.overpaid) });
        refreshReviewQueue().catch(() => {});
      }
      refreshLoans().catch(() => {});
      showFormNotice_(isLoanKind
        ? tr(direction === "they_owe_me" ? "repay.loanTo" : "repay.loanFrom", { name: friendName })
        : tr(direction === "they_owe_me" ? "repay.repaymentFrom" : "repay.repaymentTo", { name: friendName }) + extraNote);
    } else if (confirmingPendingId) {
      // Confirming a pending (review-queue) entry through the full form
      // — Phase 5.7's "Split" action. Same field set as a normal update,
      // plus the two steps a plain Confirm-button tap does (confirmEntry,
      // then saveEntrySplits) that the lightweight review-item fields
      // can't reach.
      await ensureExchangeRate(currency, date);
      await callApi("updateEntry", {
        id: confirmingPendingId,
        fields: {
          type: selectedType,
          date,
          amount: isWithdrawal ? -amount : amount,
          currency,
          ...categoryField,
          description,
          paid_by: paidBy,
          payment_method_id: usesPaymentMethod ? paymentMethodId : "",
          to_payment_method_id: toPaymentMethodId,
          trip_id: tripId
        }
      });
      await callApi("confirmEntry", { id: confirmingPendingId });
      if (selectedType === "expense" && (paidBy !== "me" || (splits && splits.length))) {
        await callApi("saveEntrySplits", { entryId: confirmingPendingId, splits: splits || [] });
      }
      await callApi("saveEntryTags", { entryId: confirmingPendingId, tagIds });
    } else if (editingEntryId) {
      // ensureExchangeRate stays blocking — it can need the owner's own
      // input (the rate modal), which a background task can't ask for.
      // Everything after it (updateEntry, splits, tags) doesn't need the
      // owner to wait on it: all three overwrite rather than append, so
      // retrying/replaying any of them is safe (confirmed before this was
      // built — see CHANGELOG.md § Entries & Tags, "Background entry-edit
      // saving"). Queued and sent in the background instead, so finishing
      // an edit feels instant. NOT used for a repayment conversion
      // (handled above, under isRepayment) or confirming a pending entry
      // (below, under confirmingPendingId) — both stay blocking, being
      // less frequent and already more involved than a plain edit.
      await ensureExchangeRate(currency, date);
      const id = editingEntryId;
      const wasPopup = editingViaPopup;
      const fields = {
        type: selectedType,
        date,
        amount: isWithdrawal ? -amount : amount,
        currency,
        ...categoryField,
        description,
        paid_by: paidBy,
        payment_method_id: usesPaymentMethod ? paymentMethodId : "",
        to_payment_method_id: toPaymentMethodId,
        trip_id: tripId
      };
      // null (not an expense, never was) means "don't touch splits" — see
      // queueEntryEdit_. Sent as [] rather than null whenever the entry
      // IS (or was) splittable, even with nothing in it — that's how
      // turning the split toggle back off on an already-split entry
      // clears its splits and linked loan(s) on save (saveEntrySplits in
      // Loans.gs replaces whatever was there before from scratch), and
      // how switching away from "expense" clears old splits/loans instead
      // of silently orphaning them.
      const sendSplits = selectedType === "expense" || editingEntryWasSplittable;
      // The bill behind the split is saved only when it was (re)applied in this
      // edit and a split still exists; undefined = leave the stored bill alone.
      const billToSave = billApplied && splits && splits.length ? billToJSON_() : undefined;
      queueEntryEdit_(id, fields, sendSplits ? (splits || []) : null, tagIds, billToSave);
      exitEditMode();
      flushEntryEdit_(id); // not awaited — runs in the background
      // Re-rendered from what's already in hand (with the queued edit
      // overlaid), not re-fetched — a real listEntries call is exactly
      // the multi-second wait this is meant to avoid. Expected-recurring
      // isn't refreshed here for the same reason; it catches up on the
      // next natural refresh (reopening the app, pulling to refresh).
      renderEntryListFromCache_();
      if (wasPopup) {
        resetEntryFormFields_();
        await refreshAfterPopupEdit();
      } else {
        resetToFreshEntryScreen_();
      }
      return;
    } else if (canProgram) {
      // No ensureExchangeRate here on purpose — a Programmed item's PEN
      // figure always falls back to the latest rate on file (see
      // CLAUDE.md's Exchange Rates section), so it never needs one set
      // for a month that, being in the future, usually doesn't have one
      // yet — unlike a real Entry, which does require it at save time.
      await callApi("addRecurringExpense", {
        category_id: categoryId,
        description,
        amount,
        currency,
        frequency: "once",
        date,
        active: true,
        trip_id: tripId   // a picked trip/event makes it an estimate there
      });
      programmedInstead = true;
    } else {
      await ensureExchangeRate(currency, date);
      const created = await callApi("createEntry", {
        type: selectedType,
        date,
        amount: isWithdrawal ? -amount : amount,
        currency,
        ...categoryField,
        description,
        paid_by: paidBy,
        payment_method_id: usesPaymentMethod ? paymentMethodId : "",
        to_payment_method_id: toPaymentMethodId,
        tag_ids: tagIds,
        trip_id: tripId
      });
      // Sent whenever it could actually matter — including a friend-paid
      // expense with the split toggle left OFF, so it still creates a
      // loan for the full amount (own_share = amount − 0 = the whole
      // thing, per saveEntrySplits in Loans.gs). The split toggle is only
      // needed when someone OTHER than the owner and the payer also had
      // part of it; "a friend covered this 100% for me" is the default,
      // not something that needs an extra step to record. Skipped when
      // the owner paid and nothing was split — guaranteed to be a no-op
      // there, so there's no point in the extra round trip.
      if (selectedType === "expense" && (paidBy !== "me" || (splits && splits.length))) {
        // The entry itself is already saved at this point. If only the
        // split fails, failing the whole submit would invite a retry that
        // creates a SECOND entry — so report it separately instead.
        try {
          await callApi("saveEntrySplits", { entryId: created.id, splits: splits || [] });
        } catch (splitErr) {
          splitSaveFailed = true;
        }
        // The bill behind the split, so its items can be edited later. Its
        // failure is only reported — the entry and split are already saved.
        if (!splitSaveFailed && billApplied && splits && splits.length) {
          try {
            await callApi("saveEntryBill", { entryId: created.id, bill: billToJSON_() });
          } catch (billErr) {
            billSaveFailed = true;
          }
        }
      }
    }
    writesDone = true;
    clearEntryDraft_();

    document.getElementById("amount").value = "";
    document.getElementById("description").value = "";
    document.getElementById("to_payment_method").value = "";
    lastAutoDescription = "";
    updateAutoTransferDescription_();
    setInvestmentDirection("deposit");
    selectedTagIds.clear();
    populateTags();
    document.getElementById("entry-trip").value = "";   // each expense picks its own trip, so a forgotten one never sticks
    resetSplitState();

    await refreshEntryList();
    refreshExpectedRecurring();

    if (confirmingPendingId) {
      closeConfirmPendingPopup();
      await refreshReviewQueue();
    } else if (editingViaPopup) {
      await refreshAfterPopupEdit();
    } else if (programmedInstead) {
      // Stays on the (now-cleared) form instead of jumping back to the
      // category picker like a normal save does — that jump would hide
      // #form-error, along with it the only sign this became a Programmed
      // item instead of a real entry, before the owner ever saw it.
      // A Programmed item is not a real entry yet, so it can't belong to a trip
      // or event: say so instead of silently dropping the pick.
      showFormNotice_(tr(tripId ? "entry.programmedTripNotice" : "entry.programmedNotice", { date }));
    } else if (wasEditingExistingEntry) {
      // Finishing an edit (as opposed to creating a brand-new entry)
      // returns the screen to exactly what a fresh app open looks like,
      // regardless of what type the edited entry happened to be — asked
      // for explicitly by the owner. A new entry instead stays on the
      // same type/account/currency, so logging several in a row is fast.
      resetToFreshEntryScreen_();
    } else if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    }
    if (splitSaveFailed) {
      alert(tr("entry.splitSaveFailed"));
    } else if (billSaveFailed) {
      alert(tr("entry.billSaveFailed"));
    }
  } catch (err) {
    if (popupHiddenEarly && !writesDone) document.getElementById("edit-entry-modal-backdrop").hidden = false;
    errorEl.textContent = writesDone
      ? tr("entry.savedNotRefreshed", { error: err.message })
      : err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---- Entry list ----

// No flag for PEN — it's the default currency (every other one is the
// exception worth calling out), so a flag on it next to nearly every
// entry was just noise repeated over and over rather than information.
function formatAmount(amount, currency) {
  const flag = currency === homeCur() ? "" : findCurrency(currency).flag + " ";
  return `${flag}${currency} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Confirmed entries lead with PEN (the currency every report/budget
// actually compares in) and, for a foreign-currency entry, show what was
// originally paid underneath — smaller, grey, flag included — so the
// original amount stays visible without competing with PEN as the primary
// number. The review queue (formatAmount above) is left as original-first,
// since a pending entry's PEN value can still be provisional.
//
// A split expense (own_share < amount — see listEntries' own_share/
// own_share_pen fields) leads with the OWNER'S share, not the full
// disbursement — that's what actually counts against budgets/reports
// (see CLAUDE.md), so it's what should stand out as the big number too.
// The full disbursement still shows, smaller/grey, as a "Total" line
// underneath — for PEN that's the only extra line; for a foreign currency
// it's a second line below the owner's-share-in-that-currency line, same
// pattern generalized from what a plain USD split looks like.
function renderEntryAmountHtml(entry) {
  // A withdrawal is stored negative; it reads as money coming BACK, so it
  // shows as a positive green figure with a leading +, like income.
  if (entry.type === "investment" && Number(entry.amount) < 0) {
    const abs = (v) => (v == null ? v : Math.abs(Number(v)));
    const flipped = Object.assign({}, entry, {
      amount: abs(entry.amount), amount_pen: abs(entry.amount_pen),
      own_share: abs(entry.own_share), own_share_pen: abs(entry.own_share_pen)
    });
    return renderEntryAmountHtml(flipped).replace('class="primary-amt">', 'class="primary-amt withdrawal-amt">+');
  }
  const hasSplit = entry.own_share != null &&
    Math.abs(Number(entry.own_share) - Number(entry.amount)) > 0.005;

  if (entry.currency === homeCur()) {
    if (!hasSplit) {
      return `<span class="primary-amt">${homeCur()} ${moneyFmt(entry.amount)}</span>`;
    }
    const totalLine = `<span class="original-amt">${tr("common.total")} ${homeCur()} ${moneyFmt(entry.amount)}</span>`;
    return `<span class="primary-amt">${homeCur()} ${moneyFmt(entry.own_share)}</span>${totalLine}`;
  }

  if (entry.amount_pen == null) {
    // No PEN value on file for this one (can happen on an older imported
    // entry whose month never got a rate entered) — fall back to the
    // original amount as the primary line rather than showing nothing.
    // Nothing meaningful to pro-rate for a split without a rate, so this
    // stays the full-amount fallback either way.
    return `<span class="primary-amt">${formatAmount(entry.amount, entry.currency)}</span>`;
  }

  if (!hasSplit) {
    const originalLine = `<span class="original-amt">${formatAmount(entry.amount, entry.currency)}</span>`;
    return `<span class="primary-amt">${homeCur()} ${moneyFmt(entry.amount_pen)}</span>${originalLine}`;
  }

  const primaryPen = entry.own_share_pen != null ? entry.own_share_pen : entry.amount_pen;
  const ownShareLine = `<span class="original-amt">${formatAmount(entry.own_share, entry.currency)}</span>`;
  const totalLine = `<span class="original-amt">${tr("common.total")} ${formatAmount(entry.amount, entry.currency)}</span>`;
  return `<span class="primary-amt">${homeCur()} ${moneyFmt(primaryPen)}</span>${ownShareLine}${totalLine}`;
}

function findCategory(id) {
  return meta.categories.find((cat) => cat.id === id);
}

// What an entry's row leads with. An investment has no category in the app:
// it shows the PLATFORM it went to — or, for a withdrawal, came back from —
// instead (a historical investment with no platform falls back to its
// category). `meta` is the account line under it: deposits say which account
// the money left, withdrawals which one received it.
function entryHeadline_(entry) {
  // A transfer that is really a repayment / cash loan with a friend says so
  // and names them; only a plain move between the owner's own accounts says
  // "Between Accounts" (its category).
  if (entry.type === "transfer" && entry.link && entry.link.friend) {
    const l = entry.link;
    const paidThem = l.direction === "i_owe_them"; // repayment: I paid them; loan: they lent me
    const text = l.kind === "repayment"
      ? tr(paidThem ? "entry.repaymentTo" : "entry.repaymentFrom", { friend: l.friend })
      : tr(paidThem ? "entry.loanFrom" : "entry.loanTo", { friend: l.friend });
    return { title: `<span class="type-dot" data-type="transfer"></span>${escapeHtml(text)}`, meta: paidByLabel(entry) };
  }
  if (entry.type !== "investment") {
    const cat = findCategory(entry.category_id);
    const marker = cat && cat.icon
      ? `<span class="entry-cat-icon" style="background:${cat.color || "#eee"}">${cat.icon}</span>`
      : `<span class="type-dot" data-type="${entry.type}"></span>`;
    return { title: `${marker}${categoryName(entry.category_id)}`, meta: paidByLabel(entry) };
  }
  const withdrawal = Number(entry.amount) < 0;
  const pmName = (id) => { const pm = meta.paymentMethods.find((p) => p.id === id); return pm ? pm.nickname : ""; };
  const platform = pmName(entry.to_payment_method_id);
  const account = pmName(entry.payment_method_id);
  // The purple dot every investment row has always had (same idea as a
  // transfer's grey one) — the owner liked it, so it stays instead of an icon.
  const marker = `<span class="type-dot" data-type="investment"></span>`;
  const title = platform
    ? tr(withdrawal ? "entry.withdrawalFrom" : "entry.investmentIn", { platform: escapeHtml(platform) })
    : tr(withdrawal ? "entry.withdrawalCategory" : "entry.investmentCategory", { category: escapeHtml(categoryName(entry.category_id)) });
  const metaText = account ? tr(withdrawal ? "entry.receivedAt" : "entry.fromAccount", { account: escapeHtml(account) }) : tr("entry.noAccount");
  return { title: `${marker}${title}`, meta: metaText };
}

function categoryName(id) {
  const c = findCategory(id);
  return c ? c.name : tr("entry.unknownCategory");
}

function paidByLabel(entryOrPaidBy) {
  // Accepts either a full entry (so income can look up Payors instead of
  // Friends) or a bare paid_by string for older call sites.
  const isEntry = entryOrPaidBy && typeof entryOrPaidBy === "object";
  const paidBy = isEntry ? entryOrPaidBy.paid_by : entryOrPaidBy;
  if (isEntry && entryOrPaidBy.type === "income") {
    const p = meta.payors.find((payor) => payor.id === paidBy);
    return p ? p.name : paidBy;
  }
  if (paidBy === "me") return tr("common.me");
  const f = meta.friends.find((fr) => fr.id === paidBy);
  return f ? f.name : paidBy;
}

// The small grey line under an entry's description: date, who paid, then the
// entry's labels (Tags) as little pills. Labels the app doesn't know (a tag
// deleted since) are skipped.
function entryMetaHtml_(entry, headline) {
  const tripPill = tripPillHtml_(entry);
  const pills = tripPill + (Array.isArray(entry.tagIds) ? entry.tagIds : [])
    .map((id) => meta.tags.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => `<span class="entry-tag">${escapeHtml(t.name)}</span>`)
    .join("");
  return `${entry.date} · ${headline.meta}${pills ? ` <span class="entry-tags">${pills}</span>` : ""}`;
}

// How many rows the Entries tab shows. Grows by ENTRY_PAGE_SIZE each time
// "Load more" is tapped and is kept across full refreshes (after an
// edit/delete) so the list doesn't snap back to the newest 100. Each fetch
// asks for one row beyond what's wanted, purely to know whether a Load more
// button is needed.
const ENTRY_PAGE_SIZE = 100;
let entriesShown = ENTRY_PAGE_SIZE;

function buildEntryRow_(entry) {
  const row = document.createElement("div");
  row.className = "entry";

  const headline = entryHeadline_(entry);

  // _queueStatus: see applyQueuedEditOverlay_ — an edit to this entry is
  // still saving in the background, or failed and is waiting to be
  // retried. Shown right under the description so it's never mistaken
  // for an already-landed change.
  const statusLine = entry._queueStatus === "saving"
    ? `<div class="entry-queue-status">${tr("entry.saving")}</div>`
    : entry._queueStatus === "failed"
      ? `<div class="entry-queue-status entry-queue-failed">${tr("entry.saveFailedRetry")}</div>`
      : "";

  const left = document.createElement("div");
  left.className = "entry-left";
  left.innerHTML = `
    <div class="entry-category">${headline.title}</div>
    ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
    <div class="entry-meta">${entryMetaHtml_(entry, headline)}</div>
    ${statusLine}
  `;

  const amount = document.createElement("div");
  amount.className = "entry-amount";
  amount.innerHTML = renderEntryAmountHtml(entry);

  row.appendChild(left);
  row.appendChild(amount);
  row.addEventListener("click", () => {
    // A "failed" entry still opens normally — pre-filled with the queued
    // (attempted) values since `entry` here already carries them, see
    // applyQueuedEditOverlay_ — so editing and saving again, even
    // unchanged, naturally retries it.
    if (blockedWhileSavingEdit_(entry.id)) return;
    startEditEntry(entry);
  });
  return row;
}

// Adds (or replaces) the Load more button at the end of the list.
function setLoadMoreButton_(list, hasMore) {
  const old = document.getElementById("entry-load-more");
  if (old) old.remove();
  if (!hasMore) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "entry-load-more";
  btn.className = "cancel-edit-btn";
  btn.textContent = tr("common.loadMore");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = tr("common.loading");
    try {
      // Only the next page is fetched and appended — earlier rows stay put.
      const fetched = await callApi("listEntries", { limit: ENTRY_PAGE_SIZE + 1, offset: entriesShown });
      const more = fetched.length > ENTRY_PAGE_SIZE;
      const page = more ? fetched.slice(0, ENTRY_PAGE_SIZE) : fetched;
      btn.remove();
      lastRenderedEntries_ = lastRenderedEntries_.concat(page);
      applyQueuedEditOverlay_(page).forEach((entry) => list.appendChild(buildEntryRow_(entry)));
      entriesShown += page.length;
      setLoadMoreButton_(list, more);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = tr("common.loadMore");
    }
  });
  list.appendChild(btn);
}

// The entries from the last real fetch (cached or live), BEFORE the
// queued-edit overlay — kept so a queue change (a save landing, failing,
// or starting) can re-render the list instantly from what's already in
// hand, via renderEntryListFromCache_ below, without another network call.
let lastRenderedEntries_ = [];
let lastRenderedHasMore_ = false;

// prefetchedEntries: see loadMeta's comment above.
async function refreshEntryList(prefetchedEntries) {
  // Any change to entries makes the search list stale (see setupEntrySearch_).
  searchIndexStale = true;
  const fetched = prefetchedEntries || await callApi("listEntries", { limit: entriesShown + 1 });
  const hasMore = fetched.length > entriesShown;
  lastRenderedEntries_ = hasMore ? fetched.slice(0, entriesShown) : fetched;
  lastRenderedHasMore_ = hasMore;
  renderEntryListFromCache_();
}

// A change made somewhere else (a repayment or loan in the Loans tab) can
// add or alter rows here. Re-fetches the list in the background and, while
// that runs, shows a small "Updating…" line above it — so switching to
// Entries right away shows either the new row or that it's on its way.
let entriesUpdating_ = 0;
function refreshEntriesInBackground_() {
  let note = document.getElementById("entries-updating");
  if (!note) {
    note = document.createElement("div");
    note.id = "entries-updating";
    note.className = "status-msg";
    document.getElementById("entry-list").before(note);
  }
  entriesUpdating_++;
  note.textContent = tr("entries.updating");
  note.hidden = false;
  refreshEntryList().catch(() => {}).finally(() => {
    if (--entriesUpdating_ === 0) note.hidden = true;
  });
}

// Re-renders the already-fetched entry list with the current queued-edit
// overlay applied — no network call. Used whenever a background edit's
// status changes (see flushEntryEdit_), so the "Saving…"/"Couldn't save"
// tag updates immediately.
function renderEntryListFromCache_() {
  const list = document.getElementById("entry-list");
  const entries = applyQueuedEditOverlay_(lastRenderedEntries_);
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr("entries.empty"))}</div>`;
    return;
  }

  entries.forEach((entry) => list.appendChild(buildEntryRow_(entry)));
  setLoadMoreButton_(list, lastRenderedHasMore_);
}

// ---- Entries-tab search: instant, as-you-type ----
// The server takes 5-8 s per query (Apps Script reads the whole sheet), far
// too slow to feel live. So ONE compact list of every confirmed entry
// (listEntrySearchIndex, each row carrying its searchable text `_s`) is
// loaded in the background and filtered right here on every keystroke.
// While searching, the tab shows only the search box and its results.
const SEARCH_MIN_CHARS = 2;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_CACHE_VERSION = 4;          // bump to drop every phone's saved copy
const SEARCH_FULL_RELOAD_MS = 24 * 3600 * 1000; // hand edits in the Sheet aren't tracked
let searchIndex = null;          // array once loaded (from the phone's copy or the server)
let searchSync = null;           // {structureVersion, entriesVersion, since, fullAt}
let searchIndexPromise = null;   // in-flight sync, if any
let searchIndexStale = false;    // entries changed in this app since the last sync
let searchIndexLoadedAt = 0;
let searchIndexError = "";       // last sync failure, shown instead of "Loading…"
let searchShown = SEARCH_PAGE_SIZE;
let searchActive = false;

function normalizeSearchText_(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ---- The phone's saved copy (IndexedDB; every call fails soft to "no copy") ----
function searchCacheDb_() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no indexedDB"));
    const req = indexedDB.open("expense-tracker", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function searchCacheGet_() {
  try {
    const db = await searchCacheDb_();
    return await new Promise((resolve) => {
      const req = db.transaction("kv").objectStore("kv").get("searchIndex");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) { return null; }
}
async function searchCachePut_(value) {
  try {
    const db = await searchCacheDb_();
    db.transaction("kv", "readwrite").objectStore("kv").put(value, "searchIndex");
  } catch (err) { /* memory-only this session */ }
}
async function clearSearchCache_() {
  searchIndex = null;
  searchSync = null;
  try {
    const db = await searchCacheDb_();
    db.transaction("kv", "readwrite").objectStore("kv").delete("searchIndex");
  } catch (err) { /* nothing to clear */ }
}

// Same order the server uses: newest date first, then newest created_at.
function compareSearchRows_(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const ac = a.created_at || "", bc = b.created_at || "";
  if (ac === bc) return 0;
  return bc > ac ? 1 : -1;
}

// Brings the list up to date. Sends what the phone's copy was built from;
// the server answers with the whole list ("full"), only what changed
// ("delta"), or "none". Old results keep working while it runs.
function syncSearchIndex_(opts) {
  if (searchIndexPromise) return searchIndexPromise;
  const force = !!(opts && opts.force);
  searchIndexStale = false;
  const tooOld = !searchSync || Date.now() - searchSync.fullAt > SEARCH_FULL_RELOAD_MS;
  const payload = force || tooOld || !searchIndex ? {} : {
    structureVersion: searchSync.structureVersion,
    entriesVersion: searchSync.entriesVersion,
    since: searchSync.since
  };
  searchIndexPromise = callApi("syncEntrySearchIndex", payload)
    .then((r) => {
      if (r.mode === "full") {
        searchIndex = r.rows;
        searchSync = { structureVersion: r.structureVersion, entriesVersion: r.entriesVersion, since: r.syncedAt, fullAt: Date.now() };
      } else if (r.mode === "delta") {
        const byId = new Map(searchIndex.map((e) => [e.id, e]));
        r.removedIds.forEach((id) => byId.delete(id));
        r.changed.forEach((e) => byId.set(e.id, e));
        searchIndex = Array.from(byId.values()).sort(compareSearchRows_);
        // `since` only moves forward on a real delta — a "none" must not
        // advance it (a write can be mid-flight; see DataVersion.gs).
        searchSync = { ...searchSync, entriesVersion: r.entriesVersion, since: r.syncedAt };
        if (searchIndex.length !== r.count) throw new Error("__resync__"); // copy drifted — start over
      }
      searchIndexLoadedAt = Date.now();
      searchIndexError = "";
      searchCachePut_({ v: SEARCH_CACHE_VERSION, rows: searchIndex, sync: searchSync });
    })
    .catch((err) => {
      if (err.message === "__resync__") {
        searchIndexPromise = null;
        return syncSearchIndex_({ force: true });
      }
      searchIndexError = err.message || tr("error.unknown");
      throw err;
    })
    .finally(() => { searchIndexPromise = null; });
  return searchIndexPromise;
}

function buildSearchRow_(entry) {
  const row = buildEntryRow_(entry);
  // Replace the inline-edit click with the pop-up, so the results stay put
  // underneath; after a save/delete the pop-up asks the same hook the
  // Overview/Budgets drill-downs use to refresh what's below it.
  const fresh = row.cloneNode(true);
  fresh.addEventListener("click", () => {
    if (blockedWhileSavingEdit_(entry.id)) return;
    currentDrilldown = { refetch: refreshSearchAfterEdit_ };
    openEditPopup(entry);
  });
  return fresh;
}

async function refreshSearchAfterEdit_() {
  const box = document.getElementById("search-results");
  box.classList.add("entry-updating");
  document.getElementById("entry-search-hint").textContent = tr("search.updating");
  try { await syncSearchIndex_(); } catch (err) { /* keeps the old list */ }
  box.classList.remove("entry-updating");
  renderSearchResults_();
}

function renderSearchResults_() {
  if (!searchActive) return;
  const input = document.getElementById("entry-search");
  const hint = document.getElementById("entry-search-hint");
  const box = document.getElementById("search-results");
  const term = input.value.trim();
  box.innerHTML = "";
  hint.hidden = false;

  if (term.length < SEARCH_MIN_CHARS) {
    hint.textContent = tr("search.minChars", { n: SEARCH_MIN_CHARS });
    return;
  }
  if (!searchIndex) {
    hint.textContent = searchIndexError
      ? tr("search.loadFailed", { error: searchIndexError })
      : tr("search.loadingAll");
    return;
  }

  const words = normalizeSearchText_(term).split(/\s+/).filter(Boolean);
  const matches = searchIndex.filter((e) => words.every((w) => e._s.indexOf(w) !== -1));
  hint.textContent = matches.length === 0
    ? ""
    : tr("search.matches", { n: matches.length });

  if (matches.length === 0) {
    box.innerHTML = `<div class="status-msg">${escapeHtml(tr("search.noMatch", { term }))}</div>`;
    return;
  }
  matches.slice(0, searchShown).forEach((entry) => box.appendChild(buildSearchRow_(entry)));
  if (matches.length > searchShown) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "cancel-edit-btn search-show-more";
    more.textContent = tr("search.showMore", { n: matches.length - searchShown });
    more.addEventListener("click", () => { searchShown += SEARCH_PAGE_SIZE; renderSearchResults_(); });
    box.appendChild(more);
  }
}

function setSearchActive_(on) {
  searchActive = on;
  document.getElementById("screen-entries").classList.toggle("searching", on);
  document.getElementById("search-results-card").hidden = !on;
  document.getElementById("entry-search-refresh").hidden = !on;
  if (!on) {
    document.getElementById("entry-search-hint").hidden = true;
    document.getElementById("search-results").innerHTML = "";
  }
}

function setupEntrySearch_() {
  const input = document.getElementById("entry-search");
  const clearBtn = document.getElementById("entry-search-clear");

  const onChange = () => {
    clearBtn.hidden = input.value === "";
    const typing = input.value.trim() !== "";
    if (typing !== searchActive) {
      setSearchActive_(typing);
      if (typing) window.scrollTo(0, 0);
    }
    searchShown = SEARCH_PAGE_SIZE;
    if (typing && !searchIndex && !searchIndexPromise) {
      syncSearchIndex_().then(renderSearchResults_).catch(renderSearchResults_);
    }
    if (typing) renderSearchResults_();
  };

  // Loading starts the moment the box is touched (or shortly after the app
  // opens), so it's usually ready before the first letter is typed.
  input.addEventListener("focus", () => {
    const old = !searchIndex || searchIndexStale || Date.now() - searchIndexLoadedAt > 60000;
    if (old) syncSearchIndex_().then(renderSearchResults_).catch(renderSearchResults_);
  });
  input.addEventListener("input", onChange);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    onChange();
    input.focus();
  });
  document.getElementById("entry-search-refresh").addEventListener("click", () => {
    const hint = document.getElementById("entry-search-hint");
    hint.textContent = tr("search.reloading");
    syncSearchIndex_({ force: true }).then(renderSearchResults_).catch(renderSearchResults_);
  });

  // The phone's saved copy is ready almost at once; the check for changes
  // runs a couple of seconds after the app has opened, off to the side.
  searchCacheGet_().then((saved) => {
    if (saved && saved.v === SEARCH_CACHE_VERSION && !searchIndex) {
      searchIndex = saved.rows;
      searchSync = saved.sync;
      searchIndexLoadedAt = Date.now();
      renderSearchResults_();
    }
  });
  setTimeout(() => { syncSearchIndex_().then(renderSearchResults_).catch(() => {}); }, 2500);
}

// ---- Unsaved new-entry draft ----
// A half-typed NEW entry is kept on the phone as it is typed and restored the
// next time the app opens (after the update banner's reload, an app switch the
// phone kills, a call), then cleared the moment it is saved. Nothing is sent
// anywhere; it never exists for an entry being edited or confirmed. Splits and
// repayments are not part of it. Older than a day = dropped.
const ENTRY_DRAFT_KEY = "entryDraft_v1";
const ENTRY_DRAFT_MAX_AGE_MS = 24 * 3600 * 1000;
let entryDraftTimer_ = null;
let entryDateTouched_ = false;   // the owner picked the date themselves

function entryFormIsNewEntry_() {
  return !editingEntryId && !confirmingPendingId && !editingViaPopup;
}

// undefined = not a new entry right now (leave any stored draft alone);
// null = a new entry with nothing worth keeping; otherwise the draft.
function captureEntryDraft_() {
  if (!entryFormIsNewEntry_()) return undefined;
  if (typeof repaymentActive_ === "function" && repaymentActive_()) return undefined;
  const amount = document.getElementById("amount").value.trim();
  const description = document.getElementById("description").value.trim();
  if (!amount && !description) return null;
  return {
    v: 1, savedAt: Date.now(), type: selectedType, categoryId: getCategoryId() || "",
    amount, description,
    currency: document.getElementById("currency").value,
    paidBy: document.getElementById("paid_by").value,
    paymentMethodId: document.getElementById("payment_method").value,
    toPaymentMethodId: document.getElementById("to_payment_method").value,
    date: entryDateTouched_ ? document.getElementById("date").value : "",
    tagIds: [...selectedTagIds],
    tripId: document.getElementById("entry-trip").value
  };
}

function saveEntryDraftNow_() {
  clearTimeout(entryDraftTimer_);
  try {
    const d = captureEntryDraft_();
    if (d === undefined) return;
    if (d === null) localStorage.removeItem(ENTRY_DRAFT_KEY);
    else localStorage.setItem(ENTRY_DRAFT_KEY, JSON.stringify(d));
  } catch (err) { /* storage unavailable (private mode): the draft is a convenience */ }
}

function clearEntryDraft_() {
  clearTimeout(entryDraftTimer_);
  try { localStorage.removeItem(ENTRY_DRAFT_KEY); } catch (err) { /* ignore */ }
}

function scheduleEntryDraftSave_() {
  clearTimeout(entryDraftTimer_);
  entryDraftTimer_ = setTimeout(saveEntryDraftNow_, 400);
}

// Puts a saved draft back into the form. Returns true if it did.
function restoreEntryDraft_() {
  if (!entryFormIsNewEntry_()) return false;
  let d = null;
  try { d = JSON.parse(localStorage.getItem(ENTRY_DRAFT_KEY) || "null"); } catch (err) { d = null; }
  if (!d || d.v !== 1 || !(Date.now() - d.savedAt < ENTRY_DRAFT_MAX_AGE_MS)) { clearEntryDraft_(); return false; }
  if (document.getElementById("amount").value.trim() || document.getElementById("description").value.trim()) return false;

  selectedType = d.type;
  document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === d.type));
  populateCategoryOptions();
  populatePaidByOptions();
  const category = findCategory(d.categoryId);
  if (ICON_PICKER_TYPES.includes(d.type)) {
    showDetailForm(category || null);
  } else {
    showDetailForm(null);
    document.getElementById("category").value = d.categoryId || "";
  }
  document.getElementById("amount").value = d.amount;
  document.getElementById("description").value = d.description;
  selectCurrency(d.currency || homeCur(), "entry");
  if (d.date) { document.getElementById("date").value = d.date; entryDateTouched_ = true; }
  if (d.paidBy) document.getElementById("paid_by").value = d.paidBy;
  togglePaymentMethodVisibility();
  // A transfer's "From" may legitimately be None (blank).
  if (d.paymentMethodId || d.type === "transfer") document.getElementById("payment_method").value = d.paymentMethodId || "";
  document.getElementById("to_payment_method").value = d.toPaymentMethodId || "";
  selectedTagIds.clear();
  (d.tagIds || []).forEach((id) => selectedTagIds.add(id));
  populateTags();
  setTripPick_(d.tripId);
  showFormNotice_(tr("entry.draftRestored"));
  return true;
}

(function setupEntryDraft_() {
  const card = document.getElementById("entry-card");
  ["input", "change", "click"].forEach((evt) => card.addEventListener(evt, scheduleEntryDraftSave_));
  document.getElementById("date").addEventListener("input", () => { entryDateTouched_ = true; });
  // iOS can kill a backgrounded app without warning, so save on the way out.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveEntryDraftNow_();
    } else if (document.visibilityState === "visible" && entryFormIsNewEntry_() && !entryDateTouched_) {
      // The form's date is an automatic "today" — after midnight it must not stay yesterday.
      const dateEl = document.getElementById("date");
      if (dateEl.value && dateEl.value !== todayLocalISO()) dateEl.value = todayLocalISO();
    }
  });
  window.addEventListener("pagehide", saveEntryDraftNow_);
})();

// ---- Cancelling a NEW entry mid-way ----
// "Cancel edit" exists for an entry that is being edited; this is the same for
// a brand-new one: back to the category screen, everything typed discarded
// (and the unsaved draft with it). It only shows while the form is open for a
// new entry — i.e. the form is visible and the edit-mode banner is not.
function syncCancelNewEntryButton_() {
  const formOpen = !document.getElementById("entry-form").hidden;
  const editing = !document.getElementById("edit-mode-banner").hidden;
  document.getElementById("cancel-new-entry-btn").hidden = !(formOpen && !editing && entryFormIsNewEntry_());
}

(function setupCancelNewEntry_() {
  const watch = new MutationObserver(syncCancelNewEntryButton_);
  ["entry-form", "edit-mode-banner"].forEach((id) =>
    watch.observe(document.getElementById(id), { attributes: true, attributeFilter: ["hidden"] }));
  syncCancelNewEntryButton_();

  document.getElementById("cancel-new-entry-btn").addEventListener("click", () => {
    const typed = document.getElementById("amount").value.trim() || document.getElementById("description").value.trim();
    if (typed && !confirm(tr("entry.confirmCancelNew"))) return;
    selectedTagIds.clear();
    populateTags();
    resetSplitState();
    entryDateTouched_ = false;
    resetToFreshEntryScreen_();   // also clears the unsaved draft
    document.getElementById("form-error").textContent = "";
  });
})();

// ---- Editing a previously confirmed entry ----

let editingEntrySummary_ = "";

async function startEditEntry(entry) {
  editingEntryId = entry.id;
  editingEntrySummary_ = describeForConfirm_(entry.description || entry.merchant || "", formatAmount(entry.amount, entry.currency), entry.date);
  editingEntryWasSplittable = entry.type === "expense";
  editingEntryOriginalType = entry.type;
  // If this turns out to be a repayment / loan, start from the way the money
  // moved: an income came in (they paid me); an expense went out (I paid them);
  // a transfer is read from its ends (only "to" = came in, only "from" = went out).
  if (entry.type === "income") repaymentDirectionChoice = "they_owe_me";
  else if (entry.type === "expense") repaymentDirectionChoice = "i_owe_them";
  else if (entry.type === "transfer" && entry.to_payment_method_id && !entry.payment_method_id) repaymentDirectionChoice = "they_owe_me";
  else if (entry.type === "transfer" && entry.payment_method_id && !entry.to_payment_method_id) repaymentDirectionChoice = "i_owe_them";

  selectedType = entry.type;
  document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === entry.type));
  populateCategoryOptions();
  populatePaidByOptions();

  const category = findCategory(entry.category_id);
  if (ICON_PICKER_TYPES.includes(entry.type)) {
    showDetailForm(category || null);
  } else {
    showDetailForm(null);
    document.getElementById("category").value = entry.category_id || "";
  }

  const entryIsWithdrawal = entry.type === "investment" && Number(entry.amount) < 0;
  setInvestmentDirection(entryIsWithdrawal ? "withdrawal" : "deposit");
  document.getElementById("amount").value = entryIsWithdrawal ? Math.abs(Number(entry.amount)) : entry.amount;
  document.getElementById("date").value = entry.date;
  document.getElementById("description").value = entry.description || "";
  selectCurrency(entry.currency, "entry");

  document.getElementById("paid_by").value = entry.paid_by;
  togglePaymentMethodVisibility();
  if (entry.type === "income" || entry.paid_by === "me") {
    keepHiddenAccountOption_("payment_method", entry.payment_method_id);
    document.getElementById("payment_method").value = entry.payment_method_id || "";
  }
  keepHiddenAccountOption_("to_payment_method", entry.to_payment_method_id);
  document.getElementById("to_payment_method").value = entry.to_payment_method_id || "";

  // Tags are per-entry (Entry Tags), not a column on Entries — loaded
  // fresh for whichever entry is being edited, same reasoning as the
  // split-loading below. Start from a clean slate so a previous entry's
  // selection can't leak into this one.
  selectedTagIds.clear();
  // Both lookups start now, in parallel (they used to run one after the
  // other, each a slow Apps Script round trip). Entries from listEntries
  // already carry their splits, so for those the split shows with no wait.
  // Array.isArray(entry.tagIds): same shortcut as splits below — lets a
  // "couldn't save, tap to retry" re-open (see applyQueuedEditOverlay_)
  // prefill with the TAGS THAT WERE ACTUALLY QUEUED rather than the
  // server's still-stale ones, so retrying doesn't silently revert them.
  const tagsPromise = Array.isArray(entry.tagIds) ? Promise.resolve(entry.tagIds) : callApi("getEntryTags", { entryId: entry.id });
  const splitsPromise = entry.type !== "expense"
    ? null
    : Array.isArray(entry.splits) ? Promise.resolve(entry.splits) : callApi("getEntrySplits", { entryId: entry.id });

  // showDetailForm (above) already showed/hid #split-field via
  // toggleSplitFieldVisibility; for a non-expense entry that also cleared
  // the split state, so there's nothing more to do. For an expense, start
  // from a clean slate and pull in whatever's actually on file — always
  // loaded as "custom" regardless of how it was originally entered, since
  // that's the one mode that can represent exactly what's stored without
  // having to guess whether it started as an equal split.
  resetSplitState();
  if (splitsPromise) {
    const splits = await splitsPromise;
    if (splits.length) {
      splitMode = "custom";
      document.querySelectorAll("#split-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === "custom"));
      splits.forEach((s) => {
        splitFriendIds.add(s.friend_id);
        customSplitAmounts[s.friend_id] = String(s.amount);
      });
      document.getElementById("split-toggle").checked = true;
      document.getElementById("split-detail").hidden = false;
      renderSplitFriendChips();
      renderSplitRows();
      renderSplitSummary();
    }
  }

  const entryTagIds = await tagsPromise;
  entryTagIds.forEach((id) => selectedTagIds.add(id));
  populateTags();
  setTripPick_(entry.trip_id);

  document.getElementById("edit-mode-banner").hidden = false;
  document.getElementById("submit-btn").textContent = tr("entry.update");
  document.getElementById("cancel-edit-btn-2").hidden = false;
  document.getElementById("delete-entry-btn").hidden = false;

  document.getElementById("entry-form").scrollIntoView({ behavior: "smooth" });
}

function exitEditMode() {
  editingEntryId = null;
  editingEntryWasSplittable = false;
  editingEntryOriginalType = null;
  confirmingPendingId = null;
  updateRepaymentUi_();
  document.getElementById("edit-mode-banner").hidden = true;
  document.getElementById("submit-btn").textContent = tr("entry.save");
  document.getElementById("cancel-edit-btn-2").hidden = true;
  document.getElementById("delete-entry-btn").hidden = true;
  selectedTagIds.clear();
  populateTags();
  document.getElementById("entry-trip").value = "";
  resetSplitState();
}

// Clears the form's actual field VALUES back to a blank "new entry" state
// — exitEditMode above only resets the edit-mode flags/banner/tags/splits,
// never amount/description/date/currency/accounts. For expense/income
// that staleness used to be hidden behind the category picker taking over
// the screen; transfer/investment have no such picker to hide behind, so
// cancelling or deleting an edit left the OLD entry's values sitting in a
// form that otherwise looked exactly like it was still being edited —
// caught live by the owner after deleting a transfer. NOT used after a
// successful save of a brand-NEW entry, which deliberately leaves date/
// currency/account as they were, to make logging several in a row from
// the same account the same day faster — see resetToFreshEntryScreen_
// below for the "finishing an edit" case, which also resets these.
function resetEntryFormFields_() {
  clearEntryDraft_();
  document.getElementById("amount").value = "";
  document.getElementById("description").value = "";
  lastAutoDescription = "";
  document.getElementById("date").value = todayLocalISO();
  selectCurrency(homeCur(), "entry");
  document.getElementById("to_payment_method").value = "";
  // payment_method (the "From"/"Paid from" account) has no blank option
  // to reset to — whatever the browser falls back to (its first real
  // option) is still a real improvement over showing the specific
  // deleted/cancelled entry's own account.
  document.getElementById("payment_method").value = "";
  setInvestmentDirection("deposit");
}

// Returns the Entries screen to exactly what a fresh app open looks like
// — the Expense tab, its category picker, every field blank — regardless
// of what type the entry being deleted/edited happened to be. Used after
// deleting an entry or finishing an edit of an EXISTING one, per the
// owner's explicit request ("I see the same I see as when first opening
// the app"); NOT used after creating a brand-new entry, which keeps the
// same type/account/currency selected on purpose (see
// resetEntryFormFields_ above) so logging several in a row stays fast.
function resetToFreshEntryScreen_() {
  selectedType = "expense";
  document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === "expense"));
  resetEntryFormFields_();
  showCategoryPicker();
}

function cancelEdit() {
  exitEditMode();
  if (editingViaPopup) {
    resetEntryFormFields_();
    closeEditPopup();
  } else {
    resetToFreshEntryScreen_();
  }
}

document.getElementById("cancel-edit-btn-2").addEventListener("click", cancelEdit);

document.getElementById("delete-entry-btn").addEventListener("click", async () => {
  if (!editingEntryId) return;
  // A repayment's transfer entry takes the repayment with it — say so first.
  let confirmText = tr("confirm.deleteEntry", { what: editingEntrySummary_ || tr("confirm.thisEntry") });
  if (["transfer", "expense", "income"].includes(editingEntryOriginalType)) {
    const links = await callApi("getEntryRepaymentLinks", { id: editingEntryId });
    if (links.forgiveness) {
      const f = links.forgiveness;
      confirmText = tr(f.direction === "they_owe_me" ? "delete.forgivenessTheyOweMe" : "delete.forgivenessIOweThem", { friend: f.friend });
    }
    if (links.loan) {
      alert(tr("delete.isLoan"));
      return;
    }
    if (links.repayment) {
      const r = links.repayment;
      confirmText = tr(r.direction === "they_owe_me" ? "delete.repaymentFrom" : "delete.repaymentTo", { friend: r.friend, cur: r.currency, total: moneyFmt(r.total) });
    }
  }
  if (!confirm(confirmText)) return;
  await callApi("discardEntry", { id: editingEntryId });
  refreshLoans().catch(() => {});
  exitEditMode();
  await refreshEntryList();
  refreshExpectedRecurring();
  if (editingViaPopup) {
    resetEntryFormFields_();
    await refreshAfterPopupEdit();
  } else {
    resetToFreshEntryScreen_();
  }
});

// ---- Editing as a pop-up (from an Overview drill-down) ----
// Reuses the exact same entry-card (type tabs, category picker, form) by
// physically relocating it into the pop-up's body, instead of duplicating
// all of that logic in a second form. Moving a DOM node preserves its
// event listeners, so everything above keeps working unchanged.

function openEditPopup(entry) {
  document.getElementById("edit-entry-modal-body").appendChild(document.getElementById("entry-card"));
  document.getElementById("edit-entry-modal-title").textContent = tr("entry.editTitle");
  const backdrop = document.getElementById("edit-entry-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  editingViaPopup = true;
  startEditEntry(entry);
}

function closeEditPopup() {
  document.getElementById("edit-entry-modal-backdrop").hidden = true;
  const screenEntries = document.getElementById("screen-entries");
  screenEntries.insertBefore(document.getElementById("entry-card"), screenEntries.firstChild);
  editingViaPopup = false;
}

// Phase 5.7's "Split" action — reuses the exact same popup and prefill
// logic as openEditPopup/startEditEntry (category, amount, description,
// currency, split toggle) rather than building a second, parallel split
// UI just for the review queue. What makes this "confirming," not
// "editing," is entirely in the submit handler's own confirmingPendingId
// branch, above (updateEntry + confirmEntry + saveEntrySplits, instead
// of a plain updateEntry) — everything about the form itself is
// identical to a normal edit.
async function openConfirmPendingPopup(entry) {
  document.getElementById("edit-entry-modal-body").appendChild(document.getElementById("entry-card"));
  const backdrop = document.getElementById("edit-entry-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  editingViaPopup = true;
  confirmingPendingId = entry.id;
  // Awaited (unlike the plain openEditPopup this mirrors) — startEditEntry
  // is itself async and sets the banner/button text/visibility near its
  // OWN end, after an internal await (fetching any existing splits); not
  // awaiting it here let that later, unrelated write win the race and
  // silently overwrite the overrides below back to "Update entry" a
  // moment after this function returned — caught live in testing.
  await startEditEntry(entry);
  document.getElementById("edit-entry-modal-title").textContent = tr("entry.confirmTitle");
  document.getElementById("edit-mode-banner").textContent = tr("entry.confirmingBanner");
  document.getElementById("submit-btn").textContent = tr("entry.confirmButton");
  // Discarding is the review queue row's own separate action — hidden
  // here rather than duplicated, so there's only one place to do it.
  document.getElementById("delete-entry-btn").hidden = true;
}

function closeConfirmPendingPopup() {
  closeEditPopup();
  exitEditMode();
}

// After a save/delete from the pop-up: close it and re-run the same
// drill-down query so the sheet underneath reflects the change, without
// closing the drill-down itself or leaving Overview.
async function refreshAfterPopupEdit() {
  closeEditPopup();
  if (currentDrilldown) {
    await currentDrilldown.refetch();
  }
  // The trip screen is a screen of its own, not a drill-down: refresh it too.
  if (!document.getElementById("screen-trip-detail").hidden) await refreshTripDetail_();
}

document.getElementById("edit-entry-modal-close").addEventListener("click", cancelEdit);
document.getElementById("edit-entry-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "edit-entry-modal-backdrop") cancelEdit();
});

// A delete/discard prompt that says WHAT is about to go ("Delete "Gym" —
// PEN 80.00?") instead of a generic "this item" — with a list of similar
// rows it was impossible to be sure the right one was open. Pieces that are
// blank are left out.
function describeForConfirm_(label, amountText, extra) {
  const head = label ? tr("confirm.label", { label }) : tr("confirm.thisItem");
  const detail = [amountText, extra].filter(Boolean).join(", ");
  return detail ? `${head} (${detail})` : head;
}

// A status word from the server, in the current language (unknown ones as-is).
function statusLabel_(status) {
  return ["pending", "confirmed", "discarded"].includes(status) ? tr("status." + status) : status;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- Review queue (entries caught automatically from email) ----

// Confirming/discarding used to just disable the row and wait for the API
// call to finish — on a flaky connection (or the phone getting locked/
// backgrounded mid-request, which iOS can pause outright) that left it
// stuck on "Confirming…" with no way to tell whether it had actually gone
// through, and a reload brought the same item right back since nothing
// had been recorded anywhere except mid-flight in that one request.
//
// Instead, the tap now applies immediately and locally: the row
// disappears right away, and the action (confirm-with-these-fields, or
// discard) is written to localStorage BEFORE the network call even
// starts. Every refresh first tries to flush anything still queued
// (harmless to retry — confirming/discarding an already-confirmed/gone
// entry is a no-op) and hides any entry that's still queued even if the
// flush hasn't landed yet, so nothing reappears asking to be confirmed a
// second time, on this load or any later one, until the server actually
// has it.
const REVIEW_ACTIONS_KEY = "reviewQueueActions";

function getQueuedReviewActions_() {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_ACTIONS_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function setQueuedReviewActions_(actions) {
  try {
    localStorage.setItem(REVIEW_ACTIONS_KEY, JSON.stringify(actions));
  } catch (err) {
    // Storage full/unavailable — the action just won't survive a reload
    // if it doesn't land this session; not worth failing the confirm/
    // discard itself over.
  }
}

function queueReviewAction_(id, action, fields) {
  const actions = getQueuedReviewActions_().filter((a) => a.id !== id);
  actions.push({ id, action, fields: fields || null });
  setQueuedReviewActions_(actions);
}

function unqueueReviewAction_(id) {
  setQueuedReviewActions_(getQueuedReviewActions_().filter((a) => a.id !== id));
}

async function applyReviewAction_(a) {
  if (a.action === "confirm") {
    await callApi("updateEntry", { id: a.id, fields: a.fields });
    await callApi("confirmEntry", { id: a.id });
  } else {
    await callApi("discardEntry", { id: a.id });
  }
  unqueueReviewAction_(a.id);
}

// Safe to call anytime, including at the top of every refresh — an
// action already applied server-side just no-ops the second time.
async function flushQueuedReviewActions_() {
  for (const a of getQueuedReviewActions_()) {
    try {
      await applyReviewAction_(a);
    } catch (err) {
      // Still unreachable — leave it queued, the next flush retries it.
    }
  }
}

// ---- Background entry-edit saving ----
// Finishing an edit of an EXISTING entry (not creating a new one, not a
// repayment conversion, not confirming a pending entry — see the submit
// handler's editingEntryId branch) doesn't make the owner wait for
// updateEntry/saveEntrySplits/saveEntryTags to actually land: the edit is
// written here first, the screen updates immediately, and the real calls
// run in the background. Modeled on the review queue's own offline-action
// pattern just above, with two differences that matter specifically for
// an edit:
// - Only ONE queued edit per entry — a newer edit REPLACES the queued
//   one, never both ("last edit wins", matching what the owner would
//   expect if they changed their mind about something seconds later).
// - Never two requests in flight for the SAME entry at once
//   (entryEditFlushing_ below) — editing the same entry twice in quick
//   succession, with the first save still slow or retrying, could
//   otherwise land out of order and silently discard the newer edit.
// Survives closing the app: queued edits are replayed on the next open
// (flushAllQueuedEdits_, called from init()), same as queued review
// actions already are.
const EDIT_QUEUE_KEY = "entryEditQueue";

function getQueuedEdits_() {
  try {
    return JSON.parse(localStorage.getItem(EDIT_QUEUE_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function setQueuedEdits_(edits) {
  try {
    localStorage.setItem(EDIT_QUEUE_KEY, JSON.stringify(edits));
  } catch (err) {
    // Storage full/unavailable — the edit just won't survive a reload if
    // it doesn't land this session; not worth failing the save over.
  }
}

function findQueuedEdit_(id) {
  return getQueuedEdits_().find((e) => e.id === id) || null;
}

// splits: null means "don't touch splits for this entry" (not an expense,
// never was) — [] means "send an empty list" (clears any existing splits).
function queueEntryEdit_(id, fields, splits, tagIds, bill) {
  const edits = getQueuedEdits_().filter((e) => e.id !== id);
  edits.push({ id, fields, splits, tagIds, bill, status: "saving", lastError: null, queuedAt: Date.now() });
  setQueuedEdits_(edits);
  renderSaveFailedBanner_();
}

function unqueueEntryEdit_(id) {
  setQueuedEdits_(getQueuedEdits_().filter((e) => e.id !== id));
  renderSaveFailedBanner_();
}

function markQueuedEditStatus_(id, status, error) {
  const edits = getQueuedEdits_();
  const edit = edits.find((e) => e.id === id);
  if (!edit) return;
  edit.status = status;
  edit.lastError = error || null;
  setQueuedEdits_(edits);
  renderSaveFailedBanner_();
}

// Blocks re-opening an entry for editing while its own background save is
// actively in flight — a "failed" one is deliberately NOT blocked here,
// see applyQueuedEditOverlay_'s comment on why re-opening it is safe (and
// useful: it's how a failed save gets retried).
function blockedWhileSavingEdit_(id) {
  const q = findQueuedEdit_(id);
  if (q && q.status === "saving") {
    alert(tr("entry.stillSaving"));
    return true;
  }
  return false;
}

// Overlays any queued/failed background edit onto a list of entries, so
// Recent entries shows what's ACTUALLY about to be saved, not a snapshot
// of what the server still has — with a visible status (buildEntryRow_)
// so it's never mistaken for an already-confirmed value, in the same
// spirit as principle 6 even though this isn't the review queue.
// own_share drives which rendering mode renderEntryAmountHtml uses (a
// plain amount, or a split's "owner's share + Total" layout) — leaving it
// at its stale pre-edit value while `amount` changed made a perfectly
// plain entry render as if it had suddenly become split (own_share no
// longer equalling the new amount). Recomputed here the same way
// saveEntrySplits (Loans.gs) does server-side: splits === null means this
// entry type never has splits at all (income/investment/transfer), so
// own_share is simply the full amount. amount_pen/own_share_pen are only
// recomputed for PEN itself — the exchange-rate lookup lives server-side,
// so a foreign-currency edit's PEN figures stay stale for a few seconds
// until the next real refresh, same as before this function existed.
function applyDerivedOverlayFields_(merged, splits) {
  const splitTotal = splits ? splits.reduce((sum, s) => sum + Number(s.amount || 0), 0) : 0;
  merged.own_share = Number(merged.amount) - splitTotal;
  if (merged.currency === homeCur()) {
    merged.amount_pen = Number(merged.amount);
    merged.own_share_pen = merged.own_share;
  }
}

function applyQueuedEditOverlay_(entries) {
  const queued = getQueuedEdits_();
  if (!queued.length) return entries;
  const byId = {};
  queued.forEach((e) => { byId[e.id] = e; });
  return entries.map((entry) => {
    const q = byId[entry.id];
    if (!q) return entry;
    const merged = Object.assign({}, entry, q.fields);
    // Also overlays splits/tagIds (q.splits===null means "wasn't touched
    // by this edit" — keep the original) so that re-opening a FAILED
    // entry (startEditEntry's Array.isArray shortcuts, above/below) picks
    // up what was actually queued, not the server's still-stale values —
    // otherwise retrying could silently revert a split or tag change.
    if (q.splits !== null) merged.splits = q.splits;
    merged.tagIds = q.tagIds;
    applyDerivedOverlayFields_(merged, q.splits);
    merged._queueStatus = q.status;
    merged._queueError = q.lastError;
    return merged;
  });
}

// Permanently folds a successfully-saved edit into lastRenderedEntries_
// (the raw, pre-overlay list) — called right before unqueuing it in
// flushEntryEdit_, so the row keeps showing the new values once the
// "Saving…" tag goes away, instead of reverting to the stale pre-edit
// ones that a real re-fetch would otherwise be needed to replace.
function commitEditToLastRendered_(edit) {
  lastRenderedEntries_ = lastRenderedEntries_.map((entry) => {
    if (entry.id !== edit.id) return entry;
    const merged = Object.assign({}, entry, edit.fields);
    if (edit.splits !== null) merged.splits = edit.splits;
    merged.tagIds = edit.tagIds;
    applyDerivedOverlayFields_(merged, edit.splits);
    return merged;
  });
}

// Tracks which entry ids are currently mid-send, so a second call for the
// same id (another tap, or the startup flush racing a fresh edit) waits
// instead of firing a second overlapping request.
const entryEditFlushing_ = new Set();

async function flushEntryEdit_(id) {
  if (entryEditFlushing_.has(id)) return;
  entryEditFlushing_.add(id);
  try {
    // Loops so that if this entry's queued edit gets REPLACED by a newer
    // one while this attempt is still sending — the one case where that
    // can legitimately happen, the owner retrying a "couldn't save" entry
    // while an earlier failed attempt was still showing — the newer one
    // goes out next, instead of the stale one unqueuing itself as if it
    // had won.
    for (;;) {
      const edit = findQueuedEdit_(id);
      if (!edit) break;
      markQueuedEditStatus_(id, "saving", null);
      renderEntryListFromCache_();
      try {
        await callApi("updateEntry", { id: edit.id, fields: edit.fields });
        if (edit.splits !== null) {
          await callApi("saveEntrySplits", { entryId: edit.id, splits: edit.splits });
        }
        await callApi("saveEntryTags", { entryId: edit.id, tagIds: edit.tagIds });
        if (edit.bill) await callApi("saveEntryBill", { entryId: edit.id, bill: edit.bill });
      } catch (err) {
        markQueuedEditStatus_(id, "failed", err.message);
        renderEntryListFromCache_();
        break;
      }
      const stillSame = findQueuedEdit_(id);
      if (stillSame && stillSame.queuedAt === edit.queuedAt) {
        // Folded into lastRenderedEntries_ itself, not just left to the
        // overlay — otherwise the row would visually REVERT to its
        // stale pre-edit values the instant this unqueues, since nothing
        // else re-fetches the real list until the next natural refresh.
        commitEditToLastRendered_(edit);
        unqueueEntryEdit_(id);
        renderEntryListFromCache_();
        break;
      }
      // else: replaced mid-flight — loop again and send the newer one.
    }
  } finally {
    entryEditFlushing_.delete(id);
  }
}

// Called once at app startup (see init()) so an edit that didn't finish
// landing before the app was last closed gets retried now, instead of
// silently waiting for the owner to notice and re-open that entry.
function flushAllQueuedEdits_() {
  getQueuedEdits_().forEach((e) => flushEntryEdit_(e.id));
}

// The one thing about a background edit that has to be impossible to
// miss: a FAILED save, since it means that edit effectively never
// happened until it's retried. A persistent banner (same fixed-top
// treatment as the "new version available" one, so it's visible
// regardless of which tab is open) rather than a toast that could fade
// away unnoticed. Called every time the queue changes, above.
function renderSaveFailedBanner_() {
  const banner = document.getElementById("save-failed-banner");
  const failed = getQueuedEdits_().filter((e) => e.status === "failed");
  if (!failed.length) {
    banner.hidden = true;
    return;
  }
  banner.textContent = tr("banner.saveFailed", { n: failed.length });
  banner.hidden = false;
  // Stacks below the update banner rather than overlapping it, on the
  // rare chance both are showing at once — both are position:fixed/top:0.
  const updateBanner = document.getElementById("update-banner");
  banner.style.top = updateBanner.hidden ? "0" : updateBanner.getBoundingClientRect().height + "px";
}

document.getElementById("save-failed-banner").addEventListener("click", () => {
  const failed = getQueuedEdits_().filter((e) => e.status === "failed");
  if (!failed.length) return;
  // Jumps to the Entries tab and opens the first failed one for editing,
  // pre-filled with the queued (attempted) values — so saving again, even
  // completely unchanged, naturally retries it.
  showScreen("entries");
  const entry = applyQueuedEditOverlay_(lastRenderedEntries_).find((e) => e.id === failed[0].id);
  if (entry) {
    startEditEntry(entry);
  } else {
    alert(tr("entry.notInList"));
  }
});

// <option>s for a transfer's From/To pickers in the review queue — every
// payment method, with a blank "not set" first (both ends are optional).
// Investment platforms only (Payment Methods of type "investment") — the
// pending-investment row's one remaining decision when everything else was
// already set through Telegram.
function investmentPlatformOptions_(selectedId) {
  const opts = meta.paymentMethods.filter((pm) => pm.type === "investment" && (!pmHidden_(pm) || pm.id === selectedId)).map((pm) =>
    `<option value="${pm.id}" ${pm.id === selectedId ? "selected" : ""}>${escapeHtml(pm.nickname)}</option>`
  );
  return `<option value="">${escapeHtml(tr("review.pickPlatform"))}</option>` + opts.join("");
}

function transferAccountOptions_(selectedId, blankLabel) {
  const opts = meta.paymentMethods.filter((pm) => !pmHidden_(pm) || pm.id === selectedId).map((pm) =>
    `<option value="${pm.id}" ${pm.id === selectedId ? "selected" : ""}>${escapeHtml(pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : ""))}</option>`
  );
  return `<option value="">${blankLabel}</option>` + opts.join("");
}

// prefetchedPending: see loadMeta's comment above. Still flushes first
// either way — cheap/no-op when the queue's already empty, and callers
// that already flushed (init(), via the bundle path) just flush an empty
// queue again rather than needing a separate code path.
// The review queue is the one piece of cached data that can actually
// mislead (principle 6 — an entry might have just been caught by email,
// or already resolved via Telegram, since the cached snapshot was taken).
// Everything else the cache-painted screen shows (categories/accounts,
// recent entries, programmed items) is lower-stakes — nothing to action,
// just a view — but the owner asked for the same honesty across the
// board: every piece of the startup bundle gets its own status line
// (siblings of/right under its section's heading) saying outright
// whenever what's on screen might not be confirmed yet, rather than
// leaving some sections silent about it and others not. Only used on the
// cache-painted path — see init().
function setCheckStatus_(elementId, state, noun) {
  const el = document.getElementById(elementId);
  if (state === "checking") {
    el.textContent = tr("check.checking." + noun);
    el.hidden = false;
  } else if (state === "failed") {
    el.textContent = tr("check.failed." + noun);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}
function setReviewCheckStatus_(state) {
  setCheckStatus_("review-check-status", state, "review");
}
function setEntriesCheckStatus_(state) {
  setCheckStatus_("entries-check-status", state, "entries");
}
function setMetaCheckStatus_(state) {
  setCheckStatus_("meta-check-status", state, "meta");
}
function setRecurringCheckStatus_(state) {
  setCheckStatus_("recurring-check-status", state, "recurring");
}

// Entries/meta/recurring all come from the one getStartupBundle call, so
// they share one fate — set/cleared together whenever it resolves or
// fails. Review is deliberately NOT included here: it has its own
// independent, faster check (see init()'s pendingPromise) that can
// succeed or fail on its own schedule, unrelated to the rest of the bundle.
function setBundleCheckStatuses_(state) {
  setEntriesCheckStatus_(state);
  setMetaCheckStatus_(state);
  setRecurringCheckStatus_(state);
}

// skipFlush: used only by the instant cache-paint below — flushing means
// real network calls (one per queued offline action), which would delay
// the very "show something instantly" this exists for. The live
// background refresh that follows right after still flushes normally.
async function refreshReviewQueue(prefetchedPending, skipFlush) {
  if (!skipFlush) await flushQueuedReviewActions_();
  const queuedIds = new Set(getQueuedReviewActions_().map((a) => a.id));
  const source = prefetchedPending || await callApi("listPendingEntries", {});
  const entries = source.filter((e) => !queuedIds.has(e.id));
  const card = document.getElementById("review-queue-card");
  const list = document.getElementById("review-list");
  document.getElementById("review-count").textContent = entries.length;

  if (entries.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  list.innerHTML = "";

  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "review-item";

    const categoryOptions = sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === entry.type), entry.category_id))
      .map((c) => `<option value="${c.id}" ${c.id === entry.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");

    item.innerHTML = `
      <div class="review-item-top">
        <div>
          <div class="review-item-desc">${escapeHtml(entry.description || tr("review.noDescription"))}</div>
          <div class="review-item-meta">${entry.date} · ${escapeHtml((TYPE_LABELS[entry.type] || entry.type).toLowerCase())}</div>
        </div>
        <div class="review-item-amount">${formatAmount(entry.amount, entry.currency)}</div>
      </div>
      ${(entry.twins || []).length ? `<div class="review-dup-warning">${tr("review.dupWarning", { list: (entry.twins || []).map((t) => tr("review.dupItem", { name: escapeHtml(t.description || tr("review.dupAnEntry")), status: escapeHtml(statusLabel_(t.status)) })).join(", ") })}</div>` : ""}
      <div class="review-item-fields">
        ${entry.type === "investment" ? "" : `<select class="review-category">
          <option value="">${escapeHtml(tr("review.pickCategory"))}</option>
          ${categoryOptions}
        </select>`}
        <input class="review-description" type="text" value="${escapeHtml(entry.description || "")}" placeholder="${escapeHtml(tr("field.description"))}">
        <input class="review-amount" type="text" inputmode="decimal" value="${Math.abs(Number(entry.amount))}" placeholder="${escapeHtml(tr("field.amount"))}">
        ${entry.type === "expense" && (meta.trips || []).length ? `
        <label class="review-transfer-label">${tr("field.trip")}</label>
        <select class="review-trip">${reviewTripOptions_(entry.trip_id || entry.suggested_trip_id || "")}</select>` : ""}
        ${entry.type === "transfer" ? `
        <label class="review-transfer-label">${tr("review.fromLabel")}</label>
        <select class="review-from">${transferAccountOptions_(entry.payment_method_id, tr("review.pickAccountLeft"))}</select>
        <label class="review-transfer-label">${tr("review.toLabel")}</label>
        <select class="review-to">${transferAccountOptions_(entry.to_payment_method_id, tr("review.pickAccountEntered"))}</select>` : ""}
        ${entry.type === "investment" ? `
        <label class="review-transfer-label">${tr("review.platformLabel")}${Number(entry.amount) < 0 ? tr("review.platformWithdrawal") : ""}</label>
        <select class="review-platform">${investmentPlatformOptions_(entry.to_payment_method_id)}</select>
        ${Number(entry.amount) < 0 ? `
        <label class="review-transfer-label">${tr("review.receivedAtLabel")}</label>
        <select class="review-land">${transferAccountOptions_(entry.payment_method_id, tr("review.pickAccount"))}</select>` : ""}` : ""}
      </div>
      <div class="review-item-actions">
        <button type="button" class="review-confirm-btn">${tr("review.confirm")}</button>
        <button type="button" class="review-discard-btn">${tr("review.discard")}</button>
      </div>
      ${entry.type === "expense" || entry.type === "income" ? `
      <div class="review-item-secondary-actions">
        ${entry.type === "expense" ? `<button type="button" class="add-inline review-split-btn">${tr("review.split")}</button>` : ""}
        <button type="button" class="add-inline review-repay-btn">${tr("review.markRepayment")}</button>
        <button type="button" class="add-inline review-loan-btn">${tr("review.convertLoan")}</button>
      </div>` : ""}
    `;

    const amountInput = item.querySelector(".review-amount");
    amountInput.addEventListener("input", (e) => {
      const sanitized = sanitizeAmountInputValue(e.target.value);
      if (sanitized !== e.target.value) e.target.value = sanitized;
    });

    const confirmBtn = item.querySelector(".review-confirm-btn");
    const discardBtn = item.querySelector(".review-discard-btn");

    confirmBtn.addEventListener("click", async () => {
      const categoryEl = item.querySelector(".review-category");
      const categoryId = categoryEl ? categoryEl.value : "";
      const description = item.querySelector(".review-description").value.trim();
      const amountStr = amountInput.value.trim();
      const amount = parseFloat(amountStr);

      if (!categoryId && entry.type !== "investment") {
        alert(tr("review.pickCategoryFirst"));
        return;
      }
      if (!amountStr || isNaN(amount) || amount <= 0) {
        alert(tr("error.validAmount"));
        return;
      }

      // Applies immediately and locally — see the note above the queue
      // helpers. The row is gone the instant you tap, whether or not the
      // network call behind it has finished (or even started).
      // A withdrawal is stored negative (set through Telegram) — keep it so.
      const fields = { description, amount: entry.type === "investment" && Number(entry.amount) < 0 ? -amount : amount };
      if (entry.type !== "investment") fields.category_id = categoryId;
      if (entry.type === "transfer") {
        const fromId = item.querySelector(".review-from").value;
        const toId = item.querySelector(".review-to").value;
        if (fromId && toId && fromId === toId) {
          alert(tr("error.sameAccount"));
          return;
        }
        fields.payment_method_id = fromId;
        fields.to_payment_method_id = toId;
      }
      if (entry.type === "investment") {
        const platformId = item.querySelector(".review-platform").value;
        if (!platformId) {
          alert(tr("review.pickPlatformFirst"));
          return;
        }
        fields.to_payment_method_id = platformId;
        const landEl = item.querySelector(".review-land");
        if (landEl) fields.payment_method_id = landEl.value;
      }
      // A trip/event is linked only now, by the owner's Confirm — the card merely pre-selected the one
      // whose dates match (or "None"). Always sent, so choosing "None" clears a suggestion.
      const tripEl = item.querySelector(".review-trip");
      if (tripEl) fields.trip_id = tripEl.value;
      betaRecordEvents_(PerfShare.queueEvents(entry, fields, betaEntryPlace_(entry)));
      queueReviewAction_(entry.id, "confirm", fields);
      item.remove();
      document.getElementById("review-count").textContent = list.children.length;
      if (list.children.length === 0) document.getElementById("review-queue-card").hidden = true;

      try {
        await applyReviewAction_({ id: entry.id, action: "confirm", fields });
        refreshEntryList();
        refreshExpectedRecurring();
      } catch (err) {
        // Stays queued — the next refreshReviewQueue (including on the
        // next app open) retries it automatically, no action needed here.
      }
    });

    discardBtn.addEventListener("click", () => {
      if (!confirm(tr("review.confirmDiscard", { what: describeForConfirm_(entry.description || "", formatAmount(entry.amount, entry.currency), entry.date) }))) return;

      betaRecordEvents_(PerfShare.queueEvents(entry, null, betaEntryPlace_(entry)));
      queueReviewAction_(entry.id, "discard", null);
      item.remove();
      document.getElementById("review-count").textContent = list.children.length;
      if (list.children.length === 0) document.getElementById("review-queue-card").hidden = true;

      applyReviewAction_({ id: entry.id, action: "discard", fields: null }).catch(() => {
        // Stays queued, same as above.
      });
    });

    // Phase 5.7's three deferred review-queue actions — only ever shown
    // for a pending expense (Split too) or a pending income (the two friend
    // actions only — never a plain internal transfer, which is
    // always the owner's own account-to-account move, never a friend
    // transaction; see EmailParser.gs). Unlike Confirm/Discard, above,
    // these don't use the offline-optimistic queue — they're rarer,
    // multi-step actions (picking a friend, a split, etc.) that don't
    // reduce to "retry this fields object blindly," so they just call the
    // API directly and surface an error if it fails, same as every other
    // modal in this app.
    if (entry.type === "expense" || entry.type === "income") {
      // Carry over whatever's already been typed/picked in this row
      // (category, description, amount) instead of the stored values, so
      // opening the Split popup / transfer modal doesn't reset them.
      // The row only ever shows what was loaded when the queue last refreshed,
      // which can be older than what's saved (an account corrected from
      // Telegram or another device, say). So the popup is built from the
      // LATEST saved copy, with only what was actually changed in this row
      // laid on top — otherwise Confirm wrote the older values back over the
      // newer ones (e.g. an old payment method replacing the corrected one).
      const entryWithRowEdits = async () => {
        let fresh = entry;
        try {
          fresh = await callApi("getEntry", { id: entry.id });
        } catch (err) { /* offline / slow: fall back to what the row has */ }
        if (!fresh || fresh.status !== "pending") {
          alert(tr("review.alreadyHandled"));
          refreshReviewQueue().catch(() => {});
          return null;
        }
        const amt = parseFloat(amountInput.value.trim());
        const rowCategory = item.querySelector(".review-category").value;
        const rowDescription = item.querySelector(".review-description").value.trim();
        const amountEdited = !isNaN(amt) && amt > 0 && amt !== Math.abs(Number(entry.amount));
        const rowTripEl = item.querySelector(".review-trip");
        return Object.assign({}, fresh, {
          trip_id: rowTripEl ? rowTripEl.value : (fresh.trip_id || ""),
          category_id: rowCategory && rowCategory !== (entry.category_id || "") ? rowCategory : (fresh.category_id || rowCategory),
          description: rowDescription !== (entry.description || "") ? rowDescription : (fresh.description || ""),
          amount: amountEdited ? amt : fresh.amount
        });
      };
      const withRowEdits = (open) => async () => {
        const merged = await entryWithRowEdits();
        if (merged) open(merged);
      };
      const splitBtn = item.querySelector(".review-split-btn"); // expenses only
      if (splitBtn) splitBtn.addEventListener("click", withRowEdits((e) => openConfirmPendingPopup(e)));
      item.querySelector(".review-repay-btn").addEventListener("click", withRowEdits((e) => openReviewTransferModal(e, "repay")));
      item.querySelector(".review-loan-btn").addEventListener("click", withRowEdits((e) => openReviewTransferModal(e, "loan")));
    }

    list.appendChild(item);
  });
}

// ---- Screens / bottom nav ----

const FALLBACK_PALETTE = ["#C9E4F7", "#F7C6D9", "#D9F2D9", "#FFE0B2", "#E0D9F7", "#FFF3B0", "#F7D9C4", "#D9F7F0"];

// The period selector (#period-selector-card) is one shared DOM node,
// relocated into whichever of Overview/Budgets is active — both screens
// read the same periodType/periodAnchor state, so Budgets naturally starts
// on "whatever Overview was showing" and changing it in either place moves
// both, rather than keeping two selectors in sync by hand.
function ensurePeriodSelectorIn(screenName) {
  const card = document.getElementById("period-selector-card");
  const target = document.getElementById(`screen-${screenName}`);
  if (card.parentElement !== target) {
    target.insertBefore(card, target.firstChild);
  }
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.hidden = el.id !== `screen-${name}`;
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });
  if (name === "overview") {
    ensurePeriodSelectorIn("overview");
    refreshOverview();
    refreshBalances().catch(() => {});
    // Investments card: hidden for now (2026-09-27) — the owner doesn't
    // want a per-platform balance shown yet, only the flows in/out. The
    // card, its API, and Investments.gs are left in place; this is the
    // one line keeping it off Overview. See CLAUDE.md § Investment
    // platforms.
    // refreshInvestments().catch(() => {});
  }
  if (name === "budgets") {
    ensurePeriodSelectorIn("budgets");
    refreshBudgets();
  }
  if (name === "projections") {
    ensurePeriodSelectorIn("projections");
    refreshProjectionsScreen();
  }
  if (name === "loans") {
    refreshLoans();
  }
}

// Recurring income/expenses lives under More but isn't a bottom-nav tab of
// its own — reached only via the "Recurring income/expenses" row, so this
// keeps "More" highlighted in the nav rather than clearing every tab's
// active state the way showScreen(name) would for an id with no matching
// button.
function showRecurringScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-recurring"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === "more");
  });
  refreshRecurringExpenses();
}

// Same "More stays highlighted" reasoning as showRecurringScreen, above.
function showExchangeRatesScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-exchange-rates"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === "more");
  });
  refreshExchangeRates();
}

// Whichever of Overview/Budgets is currently visible re-fetches with the
// new period — the other picks it up on its own next time it's shown
// (showScreen already refreshes on every tab switch), so there's no need
// to eagerly refresh a screen nobody's looking at.
function refreshCurrentPeriodScreen() {
  if (!document.getElementById("screen-overview").hidden) refreshOverview();
  if (!document.getElementById("screen-budgets").hidden) refreshBudgets();
  if (!document.getElementById("screen-projections").hidden) refreshProjectionsScreen();
}

// The screens reached from the More list (not tabs of their own). If one of
// them is open when the owner taps another tab, tapping More again puts them
// back on that same screen — not on the top-level More list — at the same
// scroll position. Restoring just un-hides the screen, with no refresh, so
// anything half-done on it (a statement being reviewed, an unsent export
// choice) is still there.
const MORE_SUBSCREENS = ["recurring", "accounts", "categories", "trips", "trip-detail", "exchange-rates", "perf", "export", "statements"];
let moreReturn = null; // { name, scrollY } of the More sub-screen left behind, or null

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.screen;
    const visible = Array.from(document.querySelectorAll(".screen")).find((el) => !el.hidden);
    const visibleName = visible ? visible.id.replace(/^screen-/, "") : null;
    if (target !== "more" && MORE_SUBSCREENS.includes(visibleName)) {
      moreReturn = { name: visibleName, scrollY: window.scrollY };
    } else if (target !== "more" && visibleName === "more") {
      moreReturn = null;
    }
    if (target === "more" && moreReturn && !MORE_SUBSCREENS.includes(visibleName) && visibleName !== "more") {
      const { name, scrollY } = moreReturn;
      moreReturn = null;
      document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== `screen-${name}`; });
      document.querySelectorAll(".nav-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.screen === "more");
      });
      window.scrollTo(0, scrollY);
      return;
    }
    showScreen(target);
  });
});

// ---- Overview: period selector ----

let periodType = "month";
let periodAnchor = new Date();

function pad2(n) { return String(n).padStart(2, "0"); }

function monthBounds(d) {
  const y = d.getFullYear(), m = d.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    startDate: `${y}-${pad2(m + 1)}-01`,
    endDate: `${y}-${pad2(m + 1)}-${pad2(lastDay)}`,
    label: I18n.fmtMonthYear(d)
  };
}

function yearBounds(d) {
  const y = d.getFullYear();
  return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: String(y) };
}

function getPeriodBounds() {
  if (periodType === "month") return monthBounds(periodAnchor);
  if (periodType === "year") return yearBounds(periodAnchor);
  if (periodType === "alltime") return { startDate: null, endDate: null, label: tr("period.alltime") };
  if (periodType === "custom") {
    const start = document.getElementById("custom-start").value;
    const end = document.getElementById("custom-end").value;
    return { startDate: start || null, endDate: end || null, label: tr("period.customRange") };
  }
  return { startDate: null, endDate: null, label: "" };
}

function renderPeriodSelector() {
  const bounds = getPeriodBounds();
  const labelEl = document.getElementById("period-label");
  labelEl.textContent = bounds.label;
  labelEl.classList.toggle("tappable", periodType === "month" || periodType === "year");
  labelEl.title = periodType === "month" || periodType === "year" ? tr("period.tapToChoose") : "";

  document.querySelectorAll(".period-type-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.periodType === periodType);
  });

  const navVisible = periodType === "month" || periodType === "year";
  document.getElementById("period-prev").hidden = !navVisible;
  document.getElementById("period-next").hidden = !navVisible;
  document.getElementById("custom-range-fields").hidden = periodType !== "custom";
}

function movePeriod(delta) {
  if (periodType === "month") {
    periodAnchor = new Date(periodAnchor.getFullYear(), periodAnchor.getMonth() + delta, 1);
  } else if (periodType === "year") {
    periodAnchor = new Date(periodAnchor.getFullYear() + delta, periodAnchor.getMonth(), 1);
  } else {
    return;
  }
  refreshCurrentPeriodScreen();
}

document.getElementById("period-prev").addEventListener("click", () => movePeriod(-1));
document.getElementById("period-next").addEventListener("click", () => movePeriod(1));

// ---- Quick month/year picker ----
// Tapping the period name (Overview, Budgets, Projections and the Projections
// category detail) opens a grid instead of stepping with ‹ › one period at a
// time. Month: a year header (‹ ›) over 12 months. Year: a grid of years.
// Future months/years are allowed (projections look ahead).
let periodPickerYear = null;   // the year shown in the month grid

function periodPickerAvailable_() { return periodType === "month" || periodType === "year"; }

function openPeriodPicker_() {
  if (!periodPickerAvailable_()) return;
  periodPickerYear = periodAnchor.getFullYear();
  const backdrop = document.getElementById("period-picker-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  renderPeriodPicker_();
}

function closePeriodPicker_() {
  document.getElementById("period-picker-backdrop").hidden = true;
}

function renderPeriodPicker_() {
  const grid = document.getElementById("period-picker-grid");
  const now = new Date();
  grid.innerHTML = "";
  const addCell = (label, isSelected, isNow, onPick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "period-picker-cell" + (isSelected ? " selected" : "") + (isNow ? " now" : "");
    b.textContent = label;
    b.addEventListener("click", onPick);
    grid.appendChild(b);
  };
  if (periodType === "year") {
    document.getElementById("period-picker-title").textContent = tr("period.pickYear");
    document.getElementById("period-picker-year-row").hidden = true;
    const selectedYear = periodAnchor.getFullYear();
    const first = Math.min(now.getFullYear() - 9, selectedYear), last = Math.max(now.getFullYear() + 2, selectedYear);
    for (let y = first; y <= last; y++) {
      addCell(String(y), y === selectedYear, y === now.getFullYear(), () => choosePeriodAnchor_(new Date(y, periodAnchor.getMonth(), 1)));
    }
    return;
  }
  document.getElementById("period-picker-title").textContent = tr("period.pickMonth");
  document.getElementById("period-picker-year-row").hidden = false;
  document.getElementById("period-picker-year").textContent = String(periodPickerYear);
  for (let m = 0; m < 12; m++) {
    addCell(
      I18n.monthShort(m, true),
      periodPickerYear === periodAnchor.getFullYear() && m === periodAnchor.getMonth(),
      periodPickerYear === now.getFullYear() && m === now.getMonth(),
      () => choosePeriodAnchor_(new Date(periodPickerYear, m, 1))
    );
  }
}

// Same effect as pressing the arrows to get there: the shared period moves,
// the open screen redraws, and an open Projections category detail reloads.
function choosePeriodAnchor_(date) {
  periodAnchor = date;
  closePeriodPicker_();
  refreshCurrentPeriodScreen();
  if (drilldownProjection && currentDrilldown) currentDrilldown.refetch();
}

document.getElementById("period-label").addEventListener("click", openPeriodPicker_);
document.getElementById("period-label").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPeriodPicker_(); }
});
document.getElementById("drilldown-subtitle").addEventListener("click", () => {
  if (drilldownProjection) openPeriodPicker_();
});
document.getElementById("period-picker-close").addEventListener("click", closePeriodPicker_);
document.getElementById("period-picker-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "period-picker-backdrop") closePeriodPicker_();
});
document.getElementById("period-picker-prev").addEventListener("click", () => { periodPickerYear -= 1; renderPeriodPicker_(); });
document.getElementById("period-picker-next").addEventListener("click", () => { periodPickerYear += 1; renderPeriodPicker_(); });

document.querySelectorAll(".period-type-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    periodType = chip.dataset.periodType;
    renderPeriodSelector();
    if (periodType !== "custom") refreshCurrentPeriodScreen();
  });
});

document.getElementById("custom-start").addEventListener("change", refreshCurrentPeriodScreen);
document.getElementById("custom-end").addEventListener("change", refreshCurrentPeriodScreen);

// Swipe left/right over the Overview screen to move a month/year at a
// time — same touch-gesture spirit as pull-to-refresh below.
// Bound to all three screens now that they share one period selector —
// swiping to change the period works "just as in Overview" from Budgets
// and Projections too.
["screen-overview", "screen-budgets", "screen-projections"].forEach((screenId) => {
  const el = document.getElementById(screenId);
  let startX = 0, startY = 0, tracking = false;

  el.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  el.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      movePeriod(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
});

// ---- Overview: expense/income toggle ----

let overviewType = "expense";
let lastOverviewData = null;

document.querySelectorAll("#overview-type-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    overviewType = tab.dataset.type;
    document.querySelectorAll("#overview-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
    if (lastOverviewData) renderBreakdowns(lastOverviewData.breakdowns[overviewType]);
  });
});

// ---- Overview: fetch + render ----

// Shared everywhere an amount is displayed — always 2 decimals with a
// thousands separator (a raw .toFixed(2) doesn't add one, which is what
// let a 4-digit budget render as "4000.00" instead of "4,000.00").
function moneyFmt(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPen(n) {
  return `${homeCur()} ${moneyFmt(n)}`;
}

async function refreshOverview() {
  renderPeriodSelector();
  const bounds = getPeriodBounds();
  if (periodType === "custom" && (!bounds.startDate || !bounds.endDate)) return;

  const data = await callApi("getPeriodSummary", { startDate: bounds.startDate, endDate: bounds.endDate });
  lastOverviewData = data;

  document.getElementById("summary-income").textContent = formatPen(data.totals.income);
  document.getElementById("summary-expense").textContent = formatPen(data.totals.expense);
  document.getElementById("summary-investment").textContent = formatPen(data.totals.investment);
  document.getElementById("summary-net").textContent = formatPen(data.totals.net);

  const excludedNote = document.getElementById("overview-excluded-note");
  if (data.excludedCount > 0) {
    excludedNote.hidden = false;
    excludedNote.textContent = tr("overview.excluded", { n: data.excludedCount });
  } else {
    excludedNote.hidden = true;
  }

  const hasAny = data.totals.income !== 0 || data.totals.expense !== 0 || data.totals.investment !== 0;
  document.getElementById("overview-empty-note").hidden = hasAny;

  renderBreakdowns(data.breakdowns[overviewType]);
}

function renderBreakdowns(breakdown) {
  renderPie("category", breakdown.byCategory);
  renderPie("tag", breakdown.byTag);
  renderPie("paymentMethod", breakdown.byPaymentMethod);
}

// Categories below this are folded into a single "Others" pie slice and
// skipped as an outside label — with a real month's ~14 non-zero
// categories, giving every sliver its own slice/label would just be noise
// on a phone-width screen. The full list below always shows everything
// individually regardless of this cutoff.
const PIE_OUTSIDE_LABEL_MIN_PERCENT = 4;
const OTHERS_COLOR = "#B5B5BD";

// Assigns each item a displayColor, nudging any item whose color (its own
// or a recycled fallback) matches the item immediately before it — two
// same-colored slices back-to-back are indistinguishable in a pie, or two
// same-colored swatches back-to-back in a list read as one group.
function resolveDisplayColors(items) {
  let prevColor = null;
  return items.map((item, i) => {
    let color = item.color || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
    if (color === prevColor) {
      color = FALLBACK_PALETTE.find((c) => c !== prevColor) || color;
    }
    prevColor = color;
    return Object.assign({}, item, { displayColor: color });
  });
}

// Collapses every item below the outside-label threshold into one
// "Others" item, so the pie itself stays readable — the full breakdown is
// still always available in the list below.
function buildPieSlices(items) {
  const shown = items.filter((it) => it.percent >= PIE_OUTSIDE_LABEL_MIN_PERCENT);
  const rest = items.filter((it) => it.percent < PIE_OUTSIDE_LABEL_MIN_PERCENT);
  const slices = shown.slice();
  if (rest.length) {
    slices.push({
      id: null,
      name: tr("overview.others", { n: rest.length }),
      icon: "⋯",
      color: OTHERS_COLOR,
      amount_pen: rest.reduce((sum, it) => sum + it.amount_pen, 0),
      percent: rest.reduce((sum, it) => sum + it.percent, 0),
      isOthers: true
    });
  }
  return slices;
}

function renderPie(key, items) {
  const wrapEl = document.getElementById(`pie-wrap-${key}`);
  const pieEl = document.getElementById(`pie-${key}`);
  const listEl = document.getElementById(`list-${key}`);

  wrapEl.querySelectorAll(".pie-outside-label").forEach((el) => el.remove());

  if (!items.length) {
    pieEl.style.background = "var(--bg)";
    listEl.innerHTML = `<div class="status-msg">${escapeHtml(tr("overview.nothingYet"))}</div>`;
    return;
  }

  // Resolved once for the full list (its own adjacency), and again for the
  // pie's slices (folding small items into Others can create a new
  // adjacency the list-order pass never saw).
  const listItems = resolveDisplayColors(items);
  const slices = resolveDisplayColors(buildPieSlices(items));

  let cumulative = 0;
  const stops = slices.map((slice) => {
    const start = cumulative;
    cumulative += slice.percent;
    return { slice, start, end: cumulative };
  });
  pieEl.style.background = `conic-gradient(${stops.map((s) => `${s.slice.displayColor} ${s.start}% ${s.end}%`).join(", ")})`;

  // Outside labels are placed by angle around the wrap's own measured
  // size (it's responsive, capped at 280px) rather than a hardcoded pixel
  // radius, so they land correctly at any phone width. Consecutive small
  // slices near the threshold can sit close enough in angle to collide —
  // when that happens, alternate near/far radius to keep them legible.
  const half = wrapEl.offsetWidth / 2;
  const nearRadius = half * 0.82;
  const farRadius = half * 0.98;
  const minGapDeg = 22;
  let lastAngleDeg = null;
  let useFar = false;

  stops.forEach((s) => {
    if (s.slice.percent < PIE_OUTSIDE_LABEL_MIN_PERCENT) return;
    const midPercent = (s.start + s.end) / 2;
    const angleDeg = (midPercent / 100) * 360;

    useFar = lastAngleDeg !== null && (angleDeg - lastAngleDeg) < minGapDeg ? !useFar : false;
    lastAngleDeg = angleDeg;

    const radius = useFar ? farRadius : nearRadius;
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = radius * Math.sin(angleRad);
    const y = -radius * Math.cos(angleRad);

    const label = document.createElement("div");
    label.className = "pie-outside-label";
    label.style.left = `${half + x}px`;
    label.style.top = `${half + y}px`;
    label.innerHTML = `
      <span class="pie-outside-icon" style="background:${s.slice.displayColor}">${s.slice.icon || ""}</span>
      <span class="pie-outside-pct">${s.slice.percent.toFixed(0)}%</span>
    `;
    // "Others" bundles multiple categories — nothing single to drill into;
    // every category inside it is still individually clickable in the
    // list below.
    if (!s.slice.isOthers) {
      label.addEventListener("click", () => openBreakdownDrilldown(key, s.slice));
    }
    wrapEl.appendChild(label);
  });

  listEl.innerHTML = "";
  listItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `
      <span class="legend-swatch" style="background:${item.displayColor}"></span>
      <div class="legend-text">
        <div class="legend-name">${item.icon ? item.icon + " " : ""}${escapeHtml(item.name)}</div>
        <div class="legend-sub">
          <span class="legend-amount">${formatPen(item.amount_pen)}</span>
          <span class="legend-percent">${item.percent.toFixed(1)}%</span>
        </div>
      </div>
    `;
    row.addEventListener("click", () => openBreakdownDrilldown(key, item));
    listEl.appendChild(row);
  });
}

// ---- Breakdown drill-down: transactions behind one category/tag/payment method ----

// Remembered so a pop-up edit launched from this sheet can refresh it
// afterward without the caller (Overview's breakdown, or a budget row)
// having to thread its own context through the edit form's shared
// save/cancel/delete paths — each opener just hands back a closure that
// re-runs its own query.
let currentDrilldown = null;

// Which budget (if any) the currently-open drill-down was opened from —
// null when it was opened from an Overview breakdown instead. Drives
// whether the ⋮ menu (modify/delete this budget) is shown at all.
let drilldownBudget = null;
let drilldownProjection = null;
let drilldownProjectionDetail = null;

async function openDrilldownWithPayload_(payload, titleText, subtitleText) {
  const backdrop = document.getElementById("drilldown-modal-backdrop");
  const title = document.getElementById("drilldown-title");
  const subtitle = document.getElementById("drilldown-subtitle");
  const list = document.getElementById("drilldown-list");

  title.textContent = titleText;
  subtitle.textContent = subtitleText;
  // A Projections category detail lets the owner tap the period to pick another.
  subtitle.classList.toggle("tappable", !!drilldownProjection && (periodType === "month" || periodType === "year"));
  list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  bringModalToFront_(backdrop);
  backdrop.hidden = false;

  try {
    const entries = await callApi("listEntries", payload);
    renderDrilldownEntries(entries);
  } catch (err) {
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
  }
}

async function openBreakdownDrilldown(kind, item) {
  currentDrilldown = { refetch: () => openBreakdownDrilldown(kind, item) };
  drilldownBudget = null;
  drilldownProjection = null;
  drilldownProjectionDetail = null;
  document.getElementById("drilldown-period-prev").hidden = true;
  document.getElementById("drilldown-period-next").hidden = true;
  document.getElementById("drilldown-menu-btn").hidden = true;
  document.getElementById("drilldown-menu").hidden = true;
  document.getElementById("drilldown-categories").hidden = true;
  document.getElementById("drilldown-chart").hidden = true;
  document.getElementById("drilldown-projection-row").hidden = true;
  ["drilldown-projection-actual-row", "drilldown-projection-annual-note", "drilldown-projection-total-row"].forEach((id) => { document.getElementById(id).hidden = true; });

  const bounds = getPeriodBounds();

  const payload = { startDate: bounds.startDate, endDate: bounds.endDate, type: overviewType };
  if (kind === "category") payload.categoryId = item.id;
  else if (kind === "tag") payload.tagId = item.id;
  else if (kind === "paymentMethod") payload.paymentMethodId = item.id;

  await openDrilldownWithPayload_(
    payload,
    `${item.icon ? item.icon + " " : ""}${item.name}`,
    `${bounds.label} · ${TYPE_LABELS[overviewType]}`
  );
}

// Same drill-down sheet, sourced from a budget row instead of an Overview
// breakdown — budgets are always expense categories, and the date range is
// the budget's own *effective* period (see computeBudgetProgressWithContext_
// server-side: a yearly budget stays yearly even while browsing by month).
// The ⋮ menu (modify/delete) only makes sense here, not from Overview.
async function openBudgetDrilldown(budget) {
  currentDrilldown = { refetch: () => openBudgetDrilldown(budget) };
  drilldownBudget = budget;
  drilldownProjection = null;
  drilldownProjectionDetail = null;
  document.getElementById("drilldown-period-prev").hidden = true;
  document.getElementById("drilldown-period-next").hidden = true;
  document.getElementById("drilldown-menu-btn").hidden = false;
  document.getElementById("drilldown-menu").hidden = true;
  document.getElementById("drilldown-projection-row").hidden = true;
  ["drilldown-projection-actual-row", "drilldown-projection-annual-note", "drilldown-projection-total-row"].forEach((id) => { document.getElementById(id).hidden = true; });
  // "Projected" (not "Pace to stay in budget") since the dashed line
  // stopped being an even pace toward the flat budget cap and became the
  // same expected+programmed forecast Projections draws (2026-09-22) —
  // the cap itself is still shown, just as its own separate flat
  // reference line (budgetLineY, below), so the wording only needs to
  // describe THIS line.
  document.getElementById("drilldown-chart-legend-2").textContent = tr("drill.projectedLegend");

  // Hide immediately (and clear any previous SVG) rather than leaving
  // whatever budget's chart was already on screen — the fetch below is
  // async, and without this the previous budget's chart stayed visible
  // for a moment after switching, which could easily read as belonging
  // to the new budget until it was replaced.
  document.getElementById("drilldown-chart").hidden = true;
  document.getElementById("drilldown-chart-svg").innerHTML = "";

  // The category list only needs spelling out here for a budget covering
  // 2+ specific categories — a single category is already the title, and
  // "All expense categories" (category_ids === null) is self-explanatory.
  // Was previously always visible on the budget's own row, which got
  // unreadably packed for a budget spanning many categories.
  const categoriesEl = document.getElementById("drilldown-categories");
  if (budget.category_ids && budget.category_ids.length > 1) {
    categoriesEl.hidden = false;
    const budgetCats = budget.category_ids
      .map((id) => meta.categories.find((c) => c.id === id)).filter(Boolean);
    categoriesEl.textContent = sortedCategories_(budgetCats)
      .map((cat) => `${cat.icon ? cat.icon + " " : ""}${cat.name}`).join(", ");
  } else {
    categoriesEl.hidden = true;
  }

  const p = budget.progress;

  // budget.category_ids is null for an "All expense categories" budget —
  // omitting categoryIds entirely then matches every category, same as
  // no filter at all.
  const payload = { startDate: p.startDate, endDate: p.endDate, type: "expense" };
  if (budget.category_ids) payload.categoryIds = budget.category_ids;
  // A monthly budget doesn't count Annual-tagged expenses (a yearly one does).
  if (budget.period_type !== "yearly") payload.excludeAnnual = true;

  await openDrilldownWithPayload_(
    payload,
    `${budget.category_icon ? budget.category_icon + " " : ""}${budget.category_name}`,
    tr(p.effectivePeriodType === "yearly" ? "drill.budgetYear" : "drill.budgetMonth", { cur: budget.currency, amount: moneyFmt(p.effectiveAmount) })
  );

  loadAndRenderBudgetChart_(budget);
}

// Fetches this budget's daily spend + recurring expenses for its own
// period and draws the chart — kept separate from the entries fetch above
// (and not awaited there) so a slow/failed chart never blocks the
// transaction list from showing.
async function loadAndRenderBudgetChart_(budget) {
  const chartEl = document.getElementById("drilldown-chart");
  const p = budget.progress;
  try {
    const data = await callApi("getBudgetChartSeries", {
      budgetId: budget.id,
      startDate: p.startDate,
      endDate: p.endDate,
      periodType: p.effectivePeriodType
    });
    // The drill-down may have been closed, or moved on to a different
    // budget, while this was in flight.
    if (!drilldownBudget || drilldownBudget.id !== budget.id) return;
    renderBudgetChart_(data, budget);
    chartEl.hidden = false;
  } catch (err) {
    chartEl.hidden = true;
  }
}

function enumeratePeriodDates_(startDate, endDate) {
  const dates = [];
  let cur = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`);
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return dates;
}

// Shared by both the budget chart and the projections chart: the Y-axis
// (4 evenly-spaced, round-numbered labels + faint dotted gridlines) and
// X-axis (weekly for a monthly period, quarterly for a yearly one, found
// by matching real calendar dates rather than assumed offsets), plus the
// two axis border lines. Returns raw SVG strings for the caller to
// interleave with its own data lines/reference lines.
function buildChartAxesSvg_(days, n, maxY, effectivePeriodType, marginLeft, marginTop, plotRight, plotBottom, xFor, yFor) {
  const yRoundingUnit = maxY >= 400 ? 100 : (maxY >= 40 ? 10 : 1);
  const yGridlinesSvg = [0, 1, 2, 3].map((i) => {
    const y = yFor((maxY * i) / 3).toFixed(1);
    return `<line x1="${marginLeft}" y1="${y}" x2="${plotRight}" y2="${y}" style="stroke:rgba(128,128,128,0.25);stroke-width:1;stroke-dasharray:1,2" />`;
  }).join("");

  const yTicksSvg = [0, 1, 2, 3].map((i) => {
    const value = (maxY * i) / 3;
    const roundedValue = Math.round(value / yRoundingUnit) * yRoundingUnit;
    const y = yFor(value).toFixed(1);
    return `
      <line x1="${marginLeft - 3}" y1="${y}" x2="${marginLeft}" y2="${y}" style="stroke:var(--border);stroke-width:1" />
      <text x="${marginLeft - 6}" y="${y}" dy="2.5" text-anchor="end" style="font-size:7.5px;fill:var(--muted)">${roundedValue.toLocaleString("en-US")}</text>
    `;
  }).join("");

  const axisYear = days[0].slice(0, 4);
  let xTickIndices;
  if (effectivePeriodType === "yearly") {
    xTickIndices = [1, 4, 7, 10]
      .map((m) => days.indexOf(`${axisYear}-${pad2(m)}-01`))
      .filter((i) => i !== -1);
  } else {
    xTickIndices = [];
    for (let i = 0; i < n; i += 7) xTickIndices.push(i);
  }
  const xTicksSvg = xTickIndices.map((i) => {
    const x = xFor(i).toFixed(1);
    const label = effectivePeriodType === "yearly"
      ? MONTH_NAMES_SHORT[parseInt(days[i].slice(5, 7), 10) - 1]
      : String(parseInt(days[i].slice(8, 10), 10));
    return `
      <line x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 3}" style="stroke:var(--border);stroke-width:1" />
      <text x="${x}" y="${plotBottom + 11}" text-anchor="middle" style="font-size:7.5px;fill:var(--muted)">${label}</text>
    `;
  }).join("");

  const axisBordersSvg = `
    <line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${plotBottom}" style="stroke:var(--border);stroke-width:1" />
    <line x1="${marginLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" style="stroke:var(--border);stroke-width:1" />
  `;

  return { gridlinesSvg: yGridlinesSvg, yTicksSvg, xTicksSvg, axisBordersSvg };
}

// Draws two lines over the budget's period: actual cumulative spend
// (solid), and a dashed pacing target from 0 to the budget amount. When
// recurring expenses fall in this category/period, the pacing line steps
// up on each one's actual day first — money that's already spoken for —
// and only then runs a straight line to the budget amount, rather than
// pretending every day of the period is equally free to spend.
function renderBudgetChart_(data, budget) {
  const p = budget.progress;
  const days = enumeratePeriodDates_(p.startDate, p.endDate);
  const n = days.length;
  const budgetAmount = p.effectiveAmount;

  let running = 0;
  const actualPoints = days.map((d) => {
    running += (data.dailySpend && data.dailySpend[d]) || 0;
    return running;
  });

  // Actual spend only ever draws through today — the rest of the period
  // has no data yet, and continuing the line flat to the end implied
  // spending had actually stopped rather than just not having happened
  // yet. A period entirely in the past draws in full (all of it is
  // "known"); one that hasn't started yet draws nothing.
  const todayStr = todayLocalISO();
  const actualEndIdx = todayStr < p.startDate ? -1 : (todayStr > p.endDate ? n - 1 : days.indexOf(todayStr));
  const actualSoFar = actualEndIdx >= 0 ? actualPoints[actualEndIdx] : 0;

  const recurringByDate = {};
  (data.recurringOccurrences || []).forEach((o) => {
    recurringByDate[o.date] = (recurringByDate[o.date] || 0) + o.amount;
  });
  const recurringDays = Object.keys(recurringByDate).sort();

  // Same "Expected ramp + Programmed bump" line the Projections drill-down
  // chart draws (unified 2026-09-22 — see CLAUDE.md): a constant per-day
  // rate for "Expected" (the YTD average across whatever this budget
  // covers, from getBudgetChartSeries) between events, a vertical jump at
  // each still-outstanding recurring item's own real calendar day. Starts
  // at today's actual, not 0 — this is a genuine forecast of where spend
  // is headed, not an idealized even pace toward the budget cap from the
  // period's first day (that idea — a flat target you're racing toward —
  // is still shown, just as the separate flat `budgetLineY` reference
  // below, so the two stay comparable rather than conflated into one
  // line). daysLeft/expectedRemaining come straight from the backend so
  // this can't drift from its own "N days left" pace note.
  const startIdx = Math.max(actualEndIdx, 0);
  const daysLeft = data.daysLeft != null ? data.daysLeft : Math.max(n - 1 - startIdx, 0);
  const expectedPerDay = daysLeft > 0 ? (data.expectedRemaining || 0) / daysLeft : 0;

  const paceVertices = [[startIdx, actualSoFar]];
  let cumulativeProgrammed = 0;
  recurringDays.forEach((d) => {
    const idx = Math.max(days.indexOf(d), startIdx);
    if (idx === -1) return;
    const cumulativeExpected = expectedPerDay * (idx - startIdx);
    paceVertices.push([idx, actualSoFar + cumulativeExpected + cumulativeProgrammed]);
    cumulativeProgrammed += recurringByDate[d];
    paceVertices.push([idx, actualSoFar + cumulativeExpected + cumulativeProgrammed]);
  });
  const lastIdx = n - 1;
  const finalValue = actualSoFar + expectedPerDay * daysLeft + cumulativeProgrammed;
  const lastVertex = paceVertices[paceVertices.length - 1];
  if (lastVertex[0] === lastIdx) lastVertex[1] = finalValue;
  else paceVertices.push([lastIdx, finalValue]);

  const maxY = Math.max(budgetAmount, finalValue, ...actualPoints, 1) * 1.08;

  // Plot area sits inset from the full SVG canvas — a left margin for the
  // Y-axis' money labels, a bottom margin for the X-axis' date labels.
  const W = 300, H = 130;
  const marginLeft = 34, marginTop = 8, marginBottom = 14;
  const plotRight = W, plotBottom = H - marginBottom;
  const plotWidth = plotRight - marginLeft;
  const plotHeight = plotBottom - marginTop;

  const xFor = (i) => marginLeft + (n <= 1 ? 0 : (i / (n - 1)) * plotWidth);
  const yFor = (v) => plotBottom - (v / maxY) * plotHeight;

  const actualPath = actualPoints
    .slice(0, actualEndIdx + 1)
    .map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`)
    .join(" ");
  const pacePath = paceVertices.map(([i, v]) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const budgetLineY = yFor(budgetAmount).toFixed(1);

  const axes = buildChartAxesSvg_(days, n, maxY, p.effectivePeriodType, marginLeft, marginTop, plotRight, plotBottom, xFor, yFor);

  document.getElementById("drilldown-chart-svg").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${axes.gridlinesSvg}
      ${axes.axisBordersSvg}
      ${axes.yTicksSvg}
      ${axes.xTicksSvg}
      <line x1="${marginLeft}" y1="${budgetLineY}" x2="${plotRight}" y2="${budgetLineY}" style="stroke:var(--border);stroke-width:1" />
      <polyline points="${pacePath}" style="fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3" />
      <polyline points="${actualPath}" style="fill:none;stroke:var(--accent);stroke-width:2" />
    </svg>
  `.trim();

  renderBudgetPaceNote_(budget, recurringByDate, days);
}

// "What should I do to stay in budget" — only meaningful while the period
// being shown is the one actually happening right now.
function renderBudgetPaceNote_(budget, recurringByDate, days) {
  const p = budget.progress;
  const note = document.getElementById("drilldown-chart-pace-note");
  const today = todayLocalISO();

  if (today < p.startDate || today > p.endDate || p.spent == null) {
    note.textContent = "";
    return;
  }

  let upcomingRecurring = 0;
  days.forEach((d) => { if (d > today && recurringByDate[d]) upcomingRecurring += recurringByDate[d]; });

  const remaining = p.effectiveAmount - p.spent;
  const periodWord = tr(p.effectivePeriodType === "yearly" ? "period.wordYear" : "period.wordMonth");

  if (remaining <= 0) {
    note.textContent = tr("pace.over", { period: periodWord });
    return;
  }

  const discretionary = remaining - upcomingRecurring;
  const daysLeft = days.filter((d) => d >= today).length;

  if (discretionary <= 0) {
    note.textContent = tr("pace.recurringUsesUp", { cur: budget.currency, amount: moneyFmt(upcomingRecurring), period: periodWord });
    return;
  }

  const perDay = discretionary / Math.max(daysLeft, 1);
  const recurringPart = upcomingRecurring > 0
    ? tr("pace.afterRecurring", { cur: budget.currency, amount: moneyFmt(upcomingRecurring) })
    : "";
  note.textContent = tr("pace.leftToSpend", { cur: budget.currency, amount: moneyFmt(discretionary), after: recurringPart, perDay: moneyFmt(perDay), n: daysLeft });
}

function renderDrilldownEntries(entries) {
  renderEntriesInto_(document.getElementById("drilldown-list"), entries);
}

// A plain list of entry rows (tap one to edit it in a pop-up), shared by the
// drill-downs and the trip screen.
function renderEntriesInto_(list, entries, emptyKey) {
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr(emptyKey || "drill.noEntries"))}</div>`;
    return;
  }

  entries.forEach((entry) => {
    const headline = entryHeadline_(entry);

    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div class="entry-left">
        <div class="entry-category">${headline.title}</div>
        ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
        <div class="entry-meta">${entryMetaHtml_(entry, headline)}</div>
      </div>
      <div class="entry-amount">
        ${renderEntryAmountHtml(entry)}
      </div>
    `;
    // Opens the same edit form used everywhere else, but as a pop-up on
    // top of this sheet — no need to leave Overview or close the
    // drill-down to fix a transaction.
    row.addEventListener("click", () => {
      if (blockedWhileSavingEdit_(entry.id)) return;
      openEditPopup(entry);
    });
    list.appendChild(row);
  });
}

function closeDrilldown() {
  document.getElementById("drilldown-modal-backdrop").hidden = true;
  document.getElementById("drilldown-menu").hidden = true;
  collapseDrilldownExpand_();
  drilldownBudget = null;
  drilldownProjection = null;
  drilldownProjectionDetail = null;
}

document.getElementById("drilldown-modal-close").addEventListener("click", closeDrilldown);
document.getElementById("drilldown-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "drilldown-modal-backdrop") closeDrilldown();
});

// Only visible/wired for a Projections drill-down (see
// openCategoryProjectionDrilldown_) — moves the shared period selector's
// own state, so the background "By category" list updates too, then
// reloads this same category's drill-down for the new period without
// closing it.
function moveDrilldownPeriod_(delta) {
  if (!drilldownProjection) return;
  movePeriod(delta);
  if (currentDrilldown) currentDrilldown.refetch();
}
document.getElementById("drilldown-period-prev").addEventListener("click", () => moveDrilldownPeriod_(-1));
document.getElementById("drilldown-period-next").addEventListener("click", () => moveDrilldownPeriod_(1));

// ---- Drag on the drill-down's header to expand/collapse it full-screen ----
// A long transaction list or a budget with many categories can want more
// room than the normal 75%-height sheet — dragging up on the header (the
// one part that never scrolls) expands it to fill the screen; dragging down
// on it again returns to the normal sheet size without closing the
// drill-down itself. Same gesture both ways, so no separate button is
// needed to go back.
function expandDrilldown_() {
  document.getElementById("drilldown-modal-inner").classList.add("expanded");
}

function collapseDrilldownExpand_() {
  document.getElementById("drilldown-modal-inner").classList.remove("expanded");
}

(function setupDrilldownDragToExpand() {
  const header = document.getElementById("drilldown-header");
  const inner = document.getElementById("drilldown-modal-inner");
  let startY = 0;
  let tracking = false;

  header.addEventListener("touchstart", (e) => {
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  header.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dy = e.changedTouches[0].clientY - startY;
    const expanded = inner.classList.contains("expanded");
    if (!expanded && dy < -40) expandDrilldown_();
    else if (expanded && dy > 40) collapseDrilldownExpand_();
  }, { passive: true });
})();

// ---- Budget drill-down's ⋮ menu (modify / delete this budget) ----

document.getElementById("drilldown-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("drilldown-menu");
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", (e) => {
  const menu = document.getElementById("drilldown-menu");
  if (!menu.hidden && !e.target.closest(".drilldown-menu-wrap")) {
    menu.hidden = true;
  }
});

document.getElementById("drilldown-menu-edit").addEventListener("click", () => {
  document.getElementById("drilldown-menu").hidden = true;
  if (drilldownBudget) openBudgetModal(drilldownBudget);
});

document.getElementById("drilldown-menu-delete").addEventListener("click", async () => {
  document.getElementById("drilldown-menu").hidden = true;
  if (!drilldownBudget) return;
  if (!confirm(tr(drilldownBudget.period_type === "yearly" ? "budget.confirmDeleteYearly" : "budget.confirmDeleteMonthly", { what: describeForConfirm_(drilldownBudget.name || drilldownBudget.category_name || "", drilldownBudget.currency ? `${drilldownBudget.currency} ${moneyFmt(drilldownBudget.amount)}` : "") }))) return;
  const id = drilldownBudget.id;
  closeDrilldown();
  try {
    await callApi("deleteBudget", { id });
  } catch (err) {
    // The dialog is already closed — without this the failure (offline, slow
    // network) was invisible and the budget just reappeared on next refresh.
    alert(tr("budget.deleteFailed", { error: err.message }));
  }
  refreshBudgetsInBackground_();
});

// ---- Budgets ----

let budgetPeriodType = "monthly";
let editingBudgetId = null;
const DEFAULT_BUDGET_THRESHOLDS_DISPLAY = "50, 75, 100, 110, 125, 150";

document.querySelectorAll("#budget-period-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    budgetPeriodType = tab.dataset.period;
    document.querySelectorAll("#budget-period-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
  });
});

// A budget can cover one category, several, or every expense category —
// same multi-select-chip pattern as tags on the entry form. "All expense
// categories" is a "select all" checkbox, not a separate mode: checking it
// selects every chip (and stays checked only for as long as every chip
// stays selected); unchecking a single chip un-checks it again, same as
// any standard select-all checkbox. Saving still stores the compact "ALL"
// form whenever the selection happens to cover every category — including
// a category added later, which an explicit list of today's ids wouldn't.
let selectedBudgetCategoryIds = new Set();

function allExpenseCategoryIds_() {
  return meta.categories.filter((c) => c.type === "expense").map((c) => c.id);
}

function updateBudgetAllCategoriesCheckbox_() {
  const allIds = allExpenseCategoryIds_();
  document.getElementById("budget-all-categories-checkbox").checked =
    allIds.length > 0 && allIds.every((id) => selectedBudgetCategoryIds.has(id));
}

function populateBudgetCategoryChips() {
  const container = document.getElementById("budget-category-chips");
  container.innerHTML = "";
  sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === "expense"), selectedBudgetCategoryIds))
    .forEach((c) => {
      const chip = document.createElement("div");
      chip.className = "tag-chip" + (selectedBudgetCategoryIds.has(c.id) ? " selected" : "");
      chip.textContent = (c.icon ? c.icon + " " : "") + c.name;
      chip.addEventListener("click", () => {
        if (selectedBudgetCategoryIds.has(c.id)) selectedBudgetCategoryIds.delete(c.id);
        else selectedBudgetCategoryIds.add(c.id);
        updateBudgetAllCategoriesCheckbox_();
        populateBudgetCategoryChips();
      });
      container.appendChild(chip);
    });
  updateBudgetAllCategoriesCheckbox_();
}

document.getElementById("budget-all-categories-checkbox").addEventListener("change", (e) => {
  selectedBudgetCategoryIds = new Set(e.target.checked ? allExpenseCategoryIds_() : []);
  populateBudgetCategoryChips();
});

// Only checks whether a rate exists and shows/hides a visible warning with
// a "Set one" link — never pops the rate modal automatically, so picking a
// currency (or opening a budget that already has one) never interrupts
// the form; the owner acts on it when ready, or not at all.
async function refreshBudgetRateWarning_(budget) {
  const warning = document.getElementById("budget-rate-warning");
  const currency = document.getElementById("budget-currency").value;
  if (currency === homeCur()) {
    warning.hidden = true;
    return;
  }

  let hasRate;
  if (budget && budget.currency === currency) {
    // Reuse the already-computed, period-correct signal for an existing
    // budget rather than re-deriving it against just "today".
    hasRate = budget.progress.rateAvailable;
  } else {
    const month = todayLocalISO().slice(0, 7);
    try {
      // Fallback-to-latest, not an exact match on today's month — a budget
      // reads its own currency's rate the same way (latestRateAtOrBefore_
      // in Budgets.gs), so this warning should only fire when there's
      // truly nothing on file yet for this currency, not merely nothing
      // for the current calendar month.
      const { rate } = await callApi("getLatestRateOnOrBefore", { currency, month });
      hasRate = rate != null;
    } catch (err) {
      hasRate = true; // don't nag over a network hiccup
    }
  }

  // The currency chip may have changed again while the check above was
  // in flight — only apply the result if it's still relevant.
  if (document.getElementById("budget-currency").value !== currency) return;

  warning.hidden = hasRate;
  if (!hasRate) document.getElementById("budget-rate-warning-text").textContent = tr("budgetModal.noRate", { currency });
}

document.getElementById("budget-rate-warning-link").addEventListener("click", async () => {
  const currency = document.getElementById("budget-currency").value;
  const month = todayLocalISO().slice(0, 7);
  const rate = await openRateModal(currency, month, /* required */ false);
  await refreshBudgetRateWarning_(null);
  // Saving a rate here only ever updated this form's own warning line —
  // the budgets list underneath (percent, spent, progress bar for every
  // row using this currency) had nothing telling it to recompute, so it
  // stayed showing "needs an exchange rate" until something else happened
  // to refresh it. Runs in the background so it doesn't block this modal.
  if (rate != null) refreshBudgetsInBackground_();
});

function openBudgetModal(budget) {
  editingBudgetId = budget ? budget.id : null;
  document.getElementById("budget-modal-title").textContent = budget ? tr("budgetModal.edit") : tr("budgetModal.add");
  document.getElementById("budget-form-error").textContent = "";
  document.getElementById("budget-name").value = budget ? (budget.name || "") : "";

  // An "ALL" budget materializes as every current expense category
  // selected, so the chips (and the checkbox, derived from them) show it
  // the same way as a budget that happens to cover all of them explicitly.
  selectedBudgetCategoryIds = new Set(
    budget ? (budget.all_categories ? allExpenseCategoryIds_() : (budget.category_ids || [])) : []
  );
  populateBudgetCategoryChips();

  document.getElementById("budget-amount").value = budget ? budget.amount : "";
  document.getElementById("budget-currency").value = budget ? budget.currency : homeCur();
  renderCurrencyChips("budget");
  refreshBudgetRateWarning_(budget);

  budgetPeriodType = budget ? budget.period_type : "monthly";
  document.querySelectorAll("#budget-period-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.period === budgetPeriodType));

  document.getElementById("budget-thresholds").value = budget ? budget.thresholds : DEFAULT_BUDGET_THRESHOLDS_DISPLAY;
  document.getElementById("budget-delete-btn").hidden = !budget;

  const backdrop = document.getElementById("budget-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

// Cancelling (✕, backdrop tap) just closes the edit form — if it was
// opened from a budget's drill-down (its ⋮ menu), that drill-down is still
// there underneath, same as cancelling an entry edit returns to its
// drill-down. Saving or deleting, below, close both together instead.
function closeBudgetModal() {
  document.getElementById("budget-modal-backdrop").hidden = true;
  editingBudgetId = null;
}

document.getElementById("add-budget-btn").addEventListener("click", () => openBudgetModal(null));
document.getElementById("budget-modal-close").addEventListener("click", closeBudgetModal);
document.getElementById("budget-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "budget-modal-backdrop") closeBudgetModal();
});

document.getElementById("budget-amount").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
});

document.getElementById("budget-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("budget-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("budget-save-btn");
  saveBtn.disabled = true;

  try {
    const name = document.getElementById("budget-name").value.trim();
    const amount = parseFloat(document.getElementById("budget-amount").value);
    const currency = document.getElementById("budget-currency").value.toUpperCase();
    const thresholds = document.getElementById("budget-thresholds").value.trim() || DEFAULT_BUDGET_THRESHOLDS_DISPLAY;

    if (selectedBudgetCategoryIds.size === 0) {
      throw new Error(tr("budget.pickCategory"));
    }
    if (!amount || amount <= 0) throw new Error(tr("error.validAmount"));

    // Stores the compact "ALL" form whenever the selection happens to
    // cover every category that exists right now — whether the owner got
    // there via the checkbox or by tapping every chip by hand — so a
    // category added later is automatically included too.
    const allIds = allExpenseCategoryIds_();
    const isEveryCategory = allIds.length > 0 && allIds.every((id) => selectedBudgetCategoryIds.has(id));
    const categoryId = isEveryCategory ? "ALL" : Array.from(selectedBudgetCategoryIds).join(",");
    const fields = { category_id: categoryId, amount, currency, period_type: budgetPeriodType, thresholds, name };

    if (editingBudgetId) {
      await callApi("updateBudget", Object.assign({ id: editingBudgetId }, fields));
    } else {
      await callApi("addBudget", fields);
    }
    // Close as soon as the save itself succeeds — that's the fast part.
    // listBudgets recomputes every budget's progress against the full
    // Entries sheet (~4s), so waiting for it before closing made every
    // save feel sluggish; refreshing the list in the background instead
    // means the modal (and, if this was opened from one, its drill-down)
    // close right away, and any refresh failure surfaces in the list
    // itself rather than getting lost behind an already-closed modal.
    closeBudgetModal();
    closeDrilldown();
    refreshBudgetsInBackground_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("budget-delete-btn").addEventListener("click", async () => {
  if (!editingBudgetId) return;
  const b = drilldownBudget && drilldownBudget.id === editingBudgetId ? drilldownBudget : null;
  const budgetLabel = document.getElementById("budget-name").value.trim() || (b && b.category_name) || "";
  if (!confirm(tr(budgetPeriodType === "yearly" ? "budget.confirmDeleteYearly" : "budget.confirmDeleteMonthly", { what: describeForConfirm_(budgetLabel, b && b.currency ? `${b.currency} ${moneyFmt(b.amount)}` : "") }))) return;
  const id = editingBudgetId;
  closeBudgetModal();
  closeDrilldown();
  await callApi("deleteBudget", { id });
  refreshBudgetsInBackground_();
});

// Fire-and-forget refresh used after a save/delete already closed its
// modal(s) — a failure here shows up in the budgets list itself (the one
// place still on screen) instead of blocking the close that triggered it.
function refreshBudgetsInBackground_() {
  refreshBudgets().catch((err) => {
    document.getElementById("budgets-list").innerHTML =
      `<div class="status-msg">${escapeHtml(tr("budget.refreshFailed", { error: err.message }))}</div>`;
  });
}

async function refreshBudgets() {
  // renderPeriodSelector() keeps the shared selector's own label/arrows in
  // sync — refreshOverview() already does this for itself, but movePeriod()
  // doesn't call it directly, so navigating with the arrows while ON the
  // Budgets tab (rather than Overview) left the period label frozen on
  // whatever it last showed even though the budgets below correctly
  // refreshed for the new period underneath it.
  renderPeriodSelector();
  // Same period the Overview tab is showing (periodType/periodAnchor are
  // shared state) — the backend widens a budget's own period to match
  // when it's the larger of the two (a monthly budget shown across a
  // year), but never narrows a yearly budget down to a month. All-time
  // and Custom don't carry a month/year size, so budgets just show their
  // own current period in those views (anchorDate is ignored server-side).
  const anchorDate = `${periodAnchor.getFullYear()}-${pad2(periodAnchor.getMonth() + 1)}-01`;
  const { budgets, summary } = await callApi("listBudgets", { displayPeriodType: periodType, anchorDate });
  const list = document.getElementById("budgets-list");
  const emptyNote = document.getElementById("budgets-empty-note");
  const summaryCard = document.getElementById("budgets-summary-card");
  list.innerHTML = "";

  if (budgets.length === 0) {
    emptyNote.hidden = false;
    summaryCard.hidden = true;
    return;
  }
  emptyNote.hidden = true;

  // Collected while rendering the rows below, then shown once as a single
  // footnote under the totals rather than repeated inside every box — a
  // rate line inside each budget's own box read as if it were part of
  // that budget's definition, not just a note about how its progress was
  // computed.
  const fxNotes = [];

  budgets.forEach((b) => {
    const p = b.progress;
    const pct = p.percent;
    let statusClass = "";
    if (pct != null) {
      if (pct >= 100) statusClass = "over";
      else if (pct >= 75) statusClass = "warn";
    }
    const barPct = pct == null ? 0 : Math.min(100, Math.max(0, pct));

    const amountLabel = `${b.currency} ${moneyFmt(p.effectiveAmount)}`;
    const subLabel = pct == null
      ? tr("budget.needsRate", { cur: b.currency })
      : `${b.currency} ${moneyFmt(p.spent)} / ${amountLabel}`;
    const periodLabel = tr(p.effectivePeriodType === "yearly" ? "budget.thisYear" : "budget.thisMonth") +
      (p.annualized ? tr("budget.annualized") : "");

    if (b.currency !== homeCur() && p.rate != null) {
      fxNotes.push(`1 ${b.currency} = ${moneyFmt(p.rate)} ${homeCur()} — ${b.category_name}`);
    }

    const row = document.createElement("div");
    row.className = "budget-row";
    row.innerHTML = `
      <div class="budget-row-top">
        <div class="budget-row-name">${b.category_icon ? b.category_icon + " " : ""}${escapeHtml(b.category_name)}</div>
        <span class="budget-row-period">${periodLabel}</span>
      </div>
      <div class="budget-progress-track">
        <div class="budget-progress-fill ${statusClass}" style="width:${barPct}%"></div>
      </div>
      <div class="budget-row-sub">
        <span>${subLabel}</span>
        <span class="budget-row-pct">${pct == null ? "" : pct.toFixed(0) + "%"}</span>
      </div>
    `;
    // Editing/deleting now lives behind the drill-down's ⋮ menu (see
    // openBudgetDrilldown) rather than a second tap target on the row.
    row.addEventListener("click", () => openBudgetDrilldown(b));
    list.appendChild(row);
  });

  summaryCard.hidden = false;
  document.getElementById("budgets-summary-monthly").textContent = formatPen(summary.monthlyPen);
  document.getElementById("budgets-summary-yearly").textContent = formatPen(summary.yearlyPen);
  const summaryNote = document.getElementById("budgets-summary-note");
  if (summary.excludedCount > 0) {
    summaryNote.hidden = false;
    summaryNote.textContent = tr("budget.excluded", { n: summary.excludedCount });
  } else {
    summaryNote.hidden = true;
  }

  const fxNote = document.getElementById("budgets-summary-fx");
  if (fxNotes.length) {
    fxNote.hidden = false;
    fxNote.innerHTML = fxNotes.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  } else {
    fxNote.hidden = true;
  }

  // Server already worked out which budgets fully contain others (those
  // are just left out of the total, silently) and which merely share some
  // categories without one containing the other — only the latter has no
  // single correct total, so that's the only case shown here.
  const overlapNote = document.getElementById("budgets-summary-overlap");
  if (summary.overlapNotes && summary.overlapNotes.length) {
    overlapNote.hidden = false;
    overlapNote.innerHTML = summary.overlapNotes.map((line) => `<div>⚠️ ${escapeHtml(line)}</div>`).join("");
  } else {
    overlapNote.hidden = true;
  }
}

// ---- Init ----

// An older copy of the app stored the access code itself. In the background
// (so opening the app is never slowed down), trade it for a session key once
// and stop keeping the code on the phone. Offline or a server hiccup: nothing
// happens, the code is still accepted until sessions are required, and it is
// tried again the next time the app opens. attempt=6 = no retries here.
async function migrateLegacyCodeToSession_() {
  try {
    const res = await callApi("login", { code: getAccessCode(), deviceName: deviceName_() }, 6);
    setSessionToken(res.sessionToken);
    localStorage.removeItem("accessCode");
  } catch (err) {
    if (err.code === "wrong_code" || err.code === "locked" || /wrong|too many/i.test(err.message)) {
      clearLocalSignIn_();
      showSignedOutScreen_(err.message);
    }
  }
}

async function init() {
  if (!getSessionToken() && getAccessCode()) migrateLegacyCodeToSession_();   // not awaited, on purpose
  if (!getSessionToken() && !getAccessCode()) {
    showSetupScreen();
    return;
  }

  document.getElementById("setup-screen").hidden = true;
  document.getElementById("date").value = todayLocalISO();
  renderCurrencyChips("entry");
  setupEntrySearch_();
  // An edit that didn't finish landing before the app was last closed
  // (see "Background entry-edit saving" above) gets retried now, rather
  // than silently waiting for the owner to notice and re-open that entry
  // — and if one already failed last session, the banner says so right
  // away instead of only after the next action touches the queue.
  flushAllQueuedEdits_();
  renderSaveFailedBanner_();

  const initStart = performance.now();
  const timedStep = async (name, fn) => {
    const t0 = performance.now();
    const result = await fn();
    perfRecordStartup_(name, performance.now() - t0);
    return result;
  };

  // Instant paint from the last successful load, if this phone has one —
  // see STARTUP_CACHE_KEY's comment above for why. First-ever open has
  // nothing cached, so it falls through to the old loading-screen path.
  const cachedBundle = loadStartupCache_();
  const paintedFromCache = !!cachedBundle;
  if (paintedFromCache) {
    await renderCachedStartupBundle_(cachedBundle);
    if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    } else {
      showDetailForm(null);
    }
    renderPeriodSelector();
    restoreEntryDraft_();
    document.getElementById("loading-screen").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("bottom-nav").hidden = false;
    perfRecordStartup_("init:cachedPaint", performance.now() - initStart);
    perfRecordStartup_("open→usable", performance.now());
  } else {
    document.getElementById("app").hidden = true;
    document.getElementById("loading-screen").hidden = false;
  }

  // If the app was painted from cache above, the owner may already be
  // typing/picking in the entry form or mid-edit on a review-queue row by
  // the time live data lands — never stomp on that. Checked fresh at the
  // moment each area is about to be re-rendered (not once up front), since
  // the fast pending check below can resolve well before the rest of the
  // bundle does. Nothing is skipped on a first-ever (uncached) load, since
  // nothing could have been touched yet.
  const formBusyNow = () => (paintedFromCache &&
    document.activeElement && document.activeElement.closest("#entry-form")) ||
    // a restored/typed draft must not have its dropdowns reset by the live data landing
    !!(document.getElementById("amount").value.trim() || document.getElementById("description").value.trim());
  const reviewBusyNow = () => paintedFromCache &&
    document.activeElement && document.activeElement.closest("#review-list");

  try {
    // Queued offline review actions (confirm/discard tapped while
    // unreachable — see flushQueuedReviewActions_) must reach the server
    // BEFORE either read below, or an already-actioned entry could still
    // show as pending for this load.
    await timedStep("init:flushReviewQueue", flushQueuedReviewActions_);

    // The review queue is the one piece of cached data that can actually
    // mislead (see setReviewCheckStatus_'s comment) — an item might have
    // just been caught by email, or already resolved via Telegram, since
    // the cached snapshot. So it gets its own fast, dedicated check
    // (listPendingEntries alone is far cheaper server-side than the full
    // bundle — see the performance log) fired at the same time as the
    // full bundle below, rather than waiting on whichever of the bundle's
    // four pieces is slowest. Whichever check succeeds most recently wins;
    // if only one of the two succeeds, that one's value is what gets
    // saved to the cache — see the Promise.allSettled below.
    let latestPending = cachedBundle ? cachedBundle.pending : null;
    let pendingCheckSucceeded = false;
    if (paintedFromCache) {
      setReviewCheckStatus_("checking");
      // Lower-stakes than the review queue (nothing to action, just a
      // view), but the owner asked for the same honesty across every
      // section — cleared once the bundle below resolves and each
      // section re-renders.
      setBundleCheckStatuses_("checking");
    }
    const pendingPromise = timedStep("init:pendingCheck", () => callApi("listPendingEntries", {}))
      .then((fresh) => {
        latestPending = fresh;
        pendingCheckSucceeded = true;
        if (paintedFromCache) {
          setReviewCheckStatus_("hidden");
          if (!reviewBusyNow()) refreshReviewQueue(fresh, true);
        }
      })
      .catch((err) => {
        // Logged, not rethrown — this runs alongside the main bundle
        // fetch below and must never abort it. A failure here just means
        // the review queue keeps showing what was already on screen,
        // clearly labelled as unconfirmed via setReviewCheckStatus_.
        console.error("Review-queue freshness check failed:", err);
        if (paintedFromCache) setReviewCheckStatus_("failed");
      });

    // One call instead of three separate round trips for getMeta/entries/
    // expected recurring (pending is handled above, on its own) — each
    // round trip used to pay its own share of Apps Script's per-request
    // startup cost (see getStartupBundle's comment in backend/Api.gs, and
    // CHANGELOG.md § Architecture). The render steps below just show data
    // that's already in hand, so they should be near-instant — compare
    // their times here with older entries in the log with the same names
    // to see the effect.
    let bundle;
    const bundlePromise = timedStep("init:fetchBundle", async () => {
      bundle = await callApi("getStartupBundle", { entriesLimit: entriesShown + 1 });
    });

    // allSettled, not a plain await, so a failure in one never stops us
    // from waiting on the other — pendingPromise already handled its own
    // failure above; a bundle failure (e.g. Invalid access code) still
    // needs to reach the catch block below exactly as before.
    const [bundleOutcome] = await Promise.allSettled([bundlePromise, pendingPromise]);
    if (bundleOutcome.status === "rejected") throw bundleOutcome.reason;

    if (!pendingCheckSucceeded) latestPending = bundle.pending;
    saveStartupCache_({ meta: bundle.meta, entries: bundle.entries, pending: latestPending, expectedRecurring: bundle.expectedRecurring });

    await timedStep("init:getMeta", () => loadMeta(bundle.meta, formBusyNow()));
    if (paintedFromCache) setMetaCheckStatus_("hidden");
    await timedStep("init:entries", () => refreshEntryList(bundle.entries));
    if (paintedFromCache) setEntriesCheckStatus_("hidden");
    if (!paintedFromCache) {
      // The fast check above already renders the review queue on the
      // cache-painted path (as soon as it resolves, independent of this
      // section) — a first-ever load has no cache to paint, so it's
      // rendered here instead, same as before this change.
      await timedStep("init:reviewQueue", () => refreshReviewQueue(latestPending, true));
    }
    await timedStep("init:expectedRecurring", () => refreshExpectedRecurring(bundle.expectedRecurring.groups));
    if (paintedFromCache) setRecurringCheckStatus_("hidden");

    if (!paintedFromCache) {
      if (ICON_PICKER_TYPES.includes(selectedType)) {
        showCategoryPicker();
      } else {
        showDetailForm(null);
      }
      renderPeriodSelector();
      restoreEntryDraft_();
      document.getElementById("loading-screen").hidden = true;
      document.getElementById("app").hidden = false;
      document.getElementById("bottom-nav").hidden = false;
    }
    if (paintedFromCache) {
      // The real open→usable moment was already recorded above, right
      // after the instant cache paint — this is a distinct measurement:
      // how long the live catch-up that follows it took.
      perfRecordStartup_("init:backgroundRefresh", performance.now() - initStart);
    } else {
      perfRecordStartup_("init:total", performance.now() - initStart);
      // performance.now() counts from page navigation, so this is the
      // full "tapped the icon → usable" time, including HTML/JS download.
      perfRecordStartup_("open→usable", performance.now());
    }
  } catch (err) {
    if (err.code === "invalid_access_code" || err.message === "Invalid access code") {
      // Keep showing cached data under a now-invalid code, and every
      // action would keep silently failing — surface it instead.
      clearLocalSignIn_();
      showSignedOutScreen_(tr("signin.codeRejected"));
      return;
    }
    if (paintedFromCache) {
      // Already showing a working (if possibly stale) app from cache —
      // same as a failed pull-to-refresh: fail quietly, keep it on screen.
      console.error("Background startup refresh failed:", err);
      setBundleCheckStatuses_("failed");
      return;
    }
    document.getElementById("loading-screen").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("bottom-nav").hidden = false;
    document.getElementById("entry-list").innerHTML =
      `<div class="status-msg">${escapeHtml(tr("error.loadData", { error: err.message }))}</div>`;
  }
}

// ---- Pull to refresh ----
// PWAs in standalone mode lose Safari's native pull-to-refresh, so this
// gives it back: drag down from the very top of the page to re-fetch data.
(function setupPullToRefresh() {
  const indicator = document.getElementById("pull-refresh-indicator");
  const threshold = 70;
  const maxPull = 100;
  const hiddenOffset = -56;
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  function reset() {
    indicator.style.transform = `translateY(${hiddenOffset}px)`;
    indicator.classList.remove("ready");
  }

  function onTouchStart(e) {
    if (refreshing || document.getElementById("app").hidden || window.scrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }

  function onTouchMove(e) {
    if (!pulling || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0) { reset(); return; }
    const capped = Math.min(delta, maxPull);
    const offset = Math.min(capped, 56) + hiddenOffset;
    indicator.style.transform = `translateY(${offset}px)`;
    indicator.classList.toggle("ready", capped > threshold);
  }

  async function onTouchEnd() {
    if (!pulling || refreshing) { pulling = false; return; }
    const wasReady = indicator.classList.contains("ready");
    pulling = false;

    if (!wasReady) { reset(); return; }

    refreshing = true;
    indicator.classList.add("refreshing");
    indicator.style.transform = "translateY(0)";
    try {
      await loadMeta();
      await refreshEntryList();
      await refreshReviewQueue();
      await refreshExpectedRecurring();
      if (!document.getElementById("screen-overview").hidden) {
        await refreshOverview();
      }
      if (!document.getElementById("screen-budgets").hidden) {
        await refreshBudgets();
      }
    } catch (err) {
      // Data just doesn't refresh this time — the user can pull again.
    }
    indicator.classList.remove("refreshing", "ready");
    reset();
    refreshing = false;
  }

  reset();
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
})();

// ---- Update banner ----
// A PWA left open (or a stale cached page in general) never re-fetches
// index.html/app.js on its own — a code change we push is invisible until
// the owner happens to force-quit and reopen it. This polls a tiny version
// file instead: remembers whatever version was live when the page loaded,
// then periodically (and whenever the tab/app comes back to the
// foreground) checks whether that's changed, and shows a banner rather
// than silently running stale code indefinitely. docs/version.json needs
// its value bumped on every deploy that touches docs/*.html, *.js, *.css
// — nothing else keeps this in sync automatically.
// ---- More tab ----

document.getElementById("more-recurring-btn").addEventListener("click", showRecurringScreen);
document.getElementById("recurring-back-btn").addEventListener("click", () => showScreen("more"));
document.getElementById("more-exchange-rates-btn").addEventListener("click", showExchangeRatesScreen);
document.getElementById("more-perf-btn").addEventListener("click", showPerfScreen);

// ---- Signed-in devices / sign out ----

async function signOutThisDevice_() {
  try { await callApi("logout", {}); } catch (err) { /* offline: the key is still dropped on this phone */ }
  clearLocalSignIn_();
  showSignedOutScreen_(tr("signin.signedOut"));
}

document.getElementById("more-signout-btn").addEventListener("click", async () => {
  if (!confirm(tr("signin.confirmSignOut"))) return;
  await signOutThisDevice_();
});

function formatSessionTime_(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? ts : I18n.fmtDateTime(d);
}

async function openDevicesModal_() {
  const backdrop = document.getElementById("devices-modal-backdrop");
  const list = document.getElementById("devices-list");
  const errorEl = document.getElementById("devices-error");
  const statusEl = document.getElementById("devices-status");
  errorEl.textContent = "";
  statusEl.textContent = "";
  list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  // Still holding the old stored code (the background switch-over hasn't worked
  // yet)? Try it now, so the list below is right.
  if (!getSessionToken() && getAccessCode()) await migrateLegacyCodeToSession_();
  statusEl.textContent = getSessionToken()
    ? tr("devices.statusSession")
    : tr("devices.statusCode");
  let sessions;
  try {
    sessions = await callApi("listSessions", {});
  } catch (err) {
    list.innerHTML = "";
    errorEl.textContent = tr("devices.loadFailed", { error: err.message });
    return;
  }
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = `<p class="hint">${escapeHtml(tr("devices.empty"))}</p>`;
  }
  sessions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "skipped-month-row";
    row.innerHTML = `
      <div>
        <div>${escapeHtml(s.device_name || tr("device.other"))}${s.current ? ` <span class="hint">${escapeHtml(tr("devices.thisDevice"))}</span>` : ""}</div>
        <div class="hint">${escapeHtml(tr("devices.lastUsed", { when: formatSessionTime_(s.last_used_at) }))}</div>
      </div>
      <button type="button" class="add-inline">${escapeHtml(tr("devices.signOut"))}</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      if (!confirm(s.current ? tr("devices.confirmThis") : tr("devices.confirmNamed", { name: s.device_name }))) return;
      if (s.current) { await signOutThisDevice_(); return; }
      try {
        await callApi("revokeSession", { id: s.id });
        openDevicesModal_();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
    list.appendChild(row);
  });
}

document.getElementById("more-devices-btn").addEventListener("click", openDevicesModal_);

// "Extra features": only on a copy that was given fewer abilities at setup (friends' copies; the owner's has all of them).
// The setup page cannot run inside the Home Screen icon (Google's sign-in window), so the person copies its address into Safari.
function extrasOff_() {
  const c = (meta && meta.capabilities) || {};
  const off = [];
  if (c.keepAwake === false) off.push(tr("extras.awake"));
  if (c.bankEmails === false) off.push(tr("extras.bank"));
  return off;
}
function refreshExtrasRow_() {
  document.getElementById("more-extras-btn").hidden = !extrasOff_().length;
  // The Performance log screen is for the owner's own copy only; a friend gets the "Share app speed" row instead.
  perfShareOwnerInit_();
  const owner = perfIsOwnerCopy_();
  document.getElementById("more-perf-btn").hidden = !owner;
  document.getElementById("more-perf-share-btn").hidden = owner;
  document.getElementById("more-bank-sample-btn").hidden = owner;   // the owner's own banks are already built in
  document.getElementById("more-feedback-btn").hidden = owner;      // the owner is the one who reads the notes
  document.getElementById("more-preview-welcome-btn").hidden = !owner;   // friends see the real welcome flow; only the owner previews it
  document.getElementById("more-bank-mail-btn").hidden = !(meta && meta.capabilities && meta.capabilities.bankEmails);
  maybeAskPerfShare_();
  checkBackendUpdate_();
}

// ---- "Help me improve the app" pop-up (a friend's copy only) ----
// Asked once per phone: at the end of the welcome questions for a new app, or at the next open for an app that was
// already set up. "Share" starts ticked; More → Share app speed changes the choice or the name at any time.
let perfShareDone_ = null, perfShareReask_ = false;
function openPerfShareModal_(onDone) {
  const s = perfShareState_();
  const backdrop = document.getElementById("perf-share-modal-backdrop");
  perfShareDone_ = onDone || null;
  I18n.applyStatic(backdrop);
  document.getElementById("perf-share-on").checked = s.asked ? !!s.on : true;
  document.getElementById("perf-share-name").value = s.label || "";
  document.getElementById("perf-share-close").hidden = !s.asked;   // the first time, the answer is the Save button
  // Someone who agreed to an older version sees what is new, and ✕ means "not now" (asked again later, three times at most).
  perfShareReask_ = !!(s.asked && s.on && (s.scope || 1) < PerfShare.SCOPE);
  document.getElementById("perf-share-new").hidden = !perfShareReask_;
  bringModalToFront_(backdrop);
  backdrop.style.zIndex = 400;   // above the welcome card (300), which is still open behind it at the end of the welcome questions
  backdrop.hidden = false;
}
function closePerfShareModal_() {
  document.getElementById("perf-share-modal-backdrop").hidden = true;
  const next = perfShareDone_;
  perfShareDone_ = null;
  if (next) next();
}
// ---- Updating a friend's copy of the backend (stage 4c) ----
// A copy made by the installer carries the backend version it was built from (capabilities.backendRef = the last commit that changed backend/).
// Once a day the app asks GitHub for the newest one (docs/setup/pin.json says whether everyone is held at a pinned commit); when they differ,
// More shows "Update available" and the More tab gets a dot. The update itself is done by the setup page (it has the person's Google sign-in).
// The owner's own copy is updated by ship.sh, so it never asks (capabilities.perfLog is true there).
const UPDATE_CHECK_KEY = "etBackendUpdate";
let updateChecked_ = false, updateChecking_ = false;
function setUpdateAvailable_(on) {
  document.getElementById("more-update-btn").hidden = !on;
  document.body.classList.toggle("update-ready", !!on);
}
async function checkBackendUpdate_() {
  const caps = (meta && meta.capabilities) || {};
  if (updateChecked_ || updateChecking_ || caps.perfLog !== false) return;   // false (not just missing) = a copy made by the installer
  updateChecking_ = true;
  try { await checkBackendUpdateNow_(caps); } finally { updateChecking_ = false; }
}
async function checkBackendUpdateNow_(caps) {
  let latest = "";
  try { const c = JSON.parse(localStorage.getItem(UPDATE_CHECK_KEY)); if (c && Date.now() - c.at < 12 * 3600 * 1000) latest = c.latest || ""; } catch (e) { /* no memory of an earlier check */ }
  if (!latest) {
    try {
      const pin = String(((await (await fetch("setup/pin.json", { cache: "no-store" })).json()) || {}).pin || "");
      const r = await fetch("https://api.github.com/repos/JeanPierreEsR/expense-tracker/commits?path=backend&sha=" + encodeURIComponent(pin || "main") + "&per_page=1");
      if (!r.ok) return;   // GitHub says no (busy, offline): try again next time, never bother the person
      latest = ((await r.json())[0] || {}).sha || "";
      if (latest) localStorage.setItem(UPDATE_CHECK_KEY, JSON.stringify({ at: Date.now(), latest }));
    } catch (e) { return; }
  }
  // A copy made before backend versions were stamped has none: it is offered the update too.
  if (latest) { updateChecked_ = true; setUpdateAvailable_(!caps.backendRef || caps.backendRef !== latest); }
}
function updatePageUrl_() { return new URL("setup/#update", location.href).href; }
function openUpdateModal_() {
  const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches));
  document.getElementById("update-modal-hint").textContent = tr(standalone ? "update.hintHome" : "update.hintSafari");
  document.getElementById("update-copied").hidden = true;
  const backdrop = document.getElementById("update-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}
document.getElementById("more-update-btn").addEventListener("click", openUpdateModal_);
document.getElementById("update-close-btn").addEventListener("click", () => { document.getElementById("update-modal-backdrop").hidden = true; });
document.getElementById("update-open-btn").addEventListener("click", () => { window.open(updatePageUrl_(), "_blank", "noopener"); });
document.getElementById("update-copy-btn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(updatePageUrl_()); document.getElementById("update-copied").hidden = false; }
  catch (e) { window.prompt(tr("update.copyManual"), updatePageUrl_()); }
});

function maybeAskPerfShare_() {
  const caps = (meta && meta.capabilities) || {};
  if (!meta || caps.onboarding || !PerfShare.needsAsk(perfShareState_(), perfIsOwnerCopy_())) return;
  if (!document.getElementById("welcome-overlay").hidden || !document.getElementById("perf-share-modal-backdrop").hidden) return;
  openPerfShareModal_(null);
}
document.getElementById("perf-share-save").addEventListener("click", () => {
  if (welcome_ && welcome_.preview) { closePerfShareModal_(); return; }   // welcome preview: keep the real sharing choice untouched
  const on = document.getElementById("perf-share-on").checked;
  perfShareSave_({ on, label: PerfShare.cleanLabel(document.getElementById("perf-share-name").value), asked: true, owner: false, scope: PerfShare.SCOPE });
  if (!on) { perfOutbox_.clear(); betaOutbox_.clear(); }
  try { localStorage.removeItem(PERF_LOG_KEY); } catch (e) { /* nothing to remove */ }   // a friend keeps no on-phone log
  closePerfShareModal_();
  perfSchedule_(5000);
});
document.getElementById("perf-share-close").addEventListener("click", () => {
  if (perfShareReask_) {   // "not now" on the new question: keep what they agreed to before, ask again at a later open (3 times at most)
    const s = perfShareState_();
    perfShareSave_({ ...s, scopeSkips: (s.scopeSkips || 0) + 1 });
    perfShareReask_ = false;
  }
  closePerfShareModal_();
});
document.getElementById("more-perf-share-btn").addEventListener("click", () => openPerfShareModal_(null));

// ---- "Send feedback to JP": a short note the person writes on purpose (backend/Feedback.gs, tab "Feedback") ----
// Steps: 1 kind + text + first name → 2 the exact note as it will be sent (e-mail addresses and long numbers hidden, docs/perf-share.js)
// → 3 thanks. It goes the same way the app-speed reports do (perfReportUrl_). No screenshots (they would show money). It does not depend
// on the "Help me improve the app" choice: the person writes it and taps Send themselves.
const fbEl_ = (id) => document.getElementById(id);
function fbStep_(n) { [1, 2, 3].forEach((i) => { fbEl_("fb-step-" + i).hidden = i !== n; }); }
function openFeedbackModal_() {
  const backdrop = fbEl_("fb-modal-backdrop");
  I18n.applyStatic(backdrop);
  fbEl_("fb-text").value = "";
  fbEl_("fb-kind").value = "broke";
  fbEl_("fb-name").value = perfShareState_().label || "";
  fbEl_("fb-error").hidden = true;
  fbEl_("fb-review").disabled = true;
  fbStep_(1);
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}
function fbScreen_() { return betaScreenNow_ === "more" ? betaScreenBefore_ : betaScreenNow_; }
function fbReady_() { return PerfShare.cleanFeedback(fbEl_("fb-text").value).length >= 5; }
fbEl_("fb-text").addEventListener("input", () => { fbEl_("fb-review").disabled = !fbReady_(); });
document.getElementById("more-feedback-btn").addEventListener("click", openFeedbackModal_);
fbEl_("fb-close").addEventListener("click", () => { fbEl_("fb-modal-backdrop").hidden = true; });
fbEl_("fb-done").addEventListener("click", () => { fbEl_("fb-modal-backdrop").hidden = true; });
fbEl_("fb-back").addEventListener("click", () => fbStep_(1));
fbEl_("fb-review").addEventListener("click", () => {
  if (!fbReady_()) return;
  const text = PerfShare.cleanFeedback(fbEl_("fb-text").value);
  fbEl_("fb-preview").textContent = text;
  fbEl_("fb-also").textContent = tr("feedback.alsoSent", { name: PerfShare.cleanLabel(fbEl_("fb-name").value) || "—", version: appRelease_() || "dev" });
  fbEl_("fb-error").hidden = true;
  fbStep_(2);
});
fbEl_("fb-send").addEventListener("click", async () => {
  const btn = fbEl_("fb-send");
  btn.disabled = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const standalone = navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
    const label = PerfShare.cleanLabel(fbEl_("fb-name").value);
    const res = await fetch(perfReportUrl_(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "reportFeedback", payload: {
        install: perfInstallId_(), label, kind: fbEl_("fb-kind").value, screen: fbScreen_(), language: I18n.getLang(), app: appRelease_(),
        device: PerfShare.deviceKind(navigator.userAgent, standalone), text: PerfShare.cleanFeedback(fbEl_("fb-text").value)
      } }),
      signal: controller.signal
    });
    const json = await res.json();
    if (json && json.ok) { fbStep_(3); return; }
    fbEl_("fb-error").textContent = tr(json && json.code === "feedback_busy" ? "feedback.tooMany" : "feedback.sendFailed");
  } catch (e) {
    fbEl_("fb-error").textContent = tr("feedback.sendFailed");
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
  fbEl_("fb-error").hidden = false;
});

// ---- "My bank isn't supported yet": send the owner ONE e-mail from the bank, with the private details hidden ----
// Steps: 1 the bank's sender address → 2 pick one of the person's own e-mails (or paste one) → 3 preview of the exact
// text that would be sent (editable) → 4 thanks. The hiding is done here (docs/bank-sample.js) BEFORE anything is sent;
// the owner's backend (BankSamples.gs) hides digits and addresses a second time. A friend's phone is not signed in to the
// owner's copy, so the sample goes the same way the app-speed reports do (perfReportUrl_).
const bs_ = { sender: "", raw: "", subject: "", how: "picked", sending: false };
const bsEl_ = (id) => document.getElementById(id);
function bsMsg_(text) { bsEl_("bs-msg").textContent = text || ""; }
function bsStep_(n) { [1, 2, 3, 4].forEach((i) => { bsEl_("bs-step-" + i).hidden = i !== n; }); bsMsg_(""); }
function openBankSampleModal_() {
  const backdrop = bsEl_("bank-sample-modal-backdrop");
  Object.assign(bs_, { sender: "", raw: "", subject: "", how: "picked", sending: false });
  I18n.applyStatic(backdrop);
  bsEl_("bs-sender").value = "";
  bsEl_("bs-paste-text").value = "";
  bsEl_("bs-hide").value = "";
  bsEl_("bs-name").value = perfShareState_().label || "";
  bsEl_("bs-find").hidden = !(meta && meta.capabilities && meta.capabilities.bankEmails !== false);
  bsStep_(1);
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}
function bsSenderOrWarn_() {
  const sender = BankSample.parseSender(bsEl_("bs-sender").value);
  if (!sender) { bsMsg_(tr("bankSample.badSender")); return ""; }
  bs_.sender = sender;
  return sender;
}
function bsShowPreview_() {
  bsEl_("bs-confirm").checked = false;
  bsEl_("bs-send").disabled = true;
  bsRedo_();
  bsStep_(3);
}
// Hides again from the ORIGINAL text, so an earlier edit in the box is replaced (the person can edit after).
function bsRedo_() {
  const hide = bsEl_("bs-hide").value + "," + bsEl_("bs-name").value;   // the person's own first name is always hidden
  bsEl_("bs-preview").value = BankSample.redact(bs_.raw, { sender: bs_.sender, hide });
  bsEl_("bs-subject").textContent = BankSample.redact(bs_.subject, { sender: bs_.sender, hide });
  bsEl_("bs-subject").parentElement.hidden = !bs_.subject;   // a pasted e-mail has no subject line
}
bsEl_("bs-find").addEventListener("click", async () => {
  const sender = bsSenderOrWarn_();
  if (!sender) return;
  bsMsg_(tr("bankSample.finding"));
  try {
    const list = await callApi("listSampleEmails", { sender });
    const box = bsEl_("bs-list");
    box.textContent = "";
    if (!list.length) { bsMsg_(tr("bankSample.noneFound")); return; }
    list.forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "more-list-item";
      b.textContent = m.date + " · " + (m.subject || "-");
      b.addEventListener("click", async () => {
        bsMsg_(tr("bankSample.finding"));
        try {
          const got = await callApi("getSampleEmail", { id: m.id, sender });
          Object.assign(bs_, { raw: got.body || "", subject: got.subject || m.subject || "", how: "picked" });
          bsShowPreview_();
        } catch (e) { bsMsg_(tr("bankSample.openFailed")); }
      });
      box.appendChild(b);
    });
    bsEl_("bs-pick").hidden = false;
    bsEl_("bs-paste-box").hidden = true;
    bsStep_(2);
  } catch (e) { bsMsg_(e.message || tr("bankSample.noneFound")); }
});
bsEl_("bs-paste").addEventListener("click", () => {
  if (!bsSenderOrWarn_()) return;
  bsEl_("bs-pick").hidden = true;
  bsEl_("bs-paste-box").hidden = false;
  bsStep_(2);
});
bsEl_("bs-paste-go").addEventListener("click", () => {
  const raw = bsEl_("bs-paste-text").value;
  if (!raw.trim()) { bsMsg_(tr("bankSample.pasteEmpty")); return; }
  Object.assign(bs_, { raw, subject: "", how: "pasted" });
  bsShowPreview_();
});
bsEl_("bs-redo").addEventListener("click", bsRedo_);
bsEl_("bs-confirm").addEventListener("change", () => { bsEl_("bs-send").disabled = !bsEl_("bs-confirm").checked || bs_.sending; });
bsEl_("bs-back-2").addEventListener("click", () => bsStep_(1));
bsEl_("bs-back-3").addEventListener("click", () => bsStep_(2));
bsEl_("bs-another").addEventListener("click", () => bsStep_(1));
bsEl_("bs-close").addEventListener("click", () => { bsEl_("bank-sample-modal-backdrop").hidden = true; });
bsEl_("more-bank-sample-btn").addEventListener("click", openBankSampleModal_);
bsEl_("bs-send").addEventListener("click", async () => {
  if (bs_.sending || !bsEl_("bs-confirm").checked) return;
  bs_.sending = true;
  bsEl_("bs-send").disabled = true;
  bsMsg_(tr("bankSample.sending"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    // A plain fetch like the app-speed report: no sign-in on the owner's copy, and no retry that could send it twice.
    const res = await fetch(perfReportUrl_(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "reportBankSample", payload: {
        install: perfInstallId_(), label: PerfShare.cleanLabel(bsEl_("bs-name").value), sender: bs_.sender,
        subject: bsEl_("bs-subject").textContent, text: bsEl_("bs-preview").value, language: I18n.getLang(),
        app: appRelease_(), how: bs_.how
      } }),
      signal: controller.signal
    });
    const json = await res.json();
    if (json && json.ok) { bsStep_(4); return; }
    bsMsg_(json && json.code === "sample_busy" ? tr("bankSample.tooMany") : tr("bankSample.sendFailed"));
  } catch (e) {
    bsMsg_(tr("bankSample.sendFailed"));
  } finally {
    clearTimeout(timer);
    bs_.sending = false;
    bsEl_("bs-send").disabled = !bsEl_("bs-confirm").checked;
  }
});
document.getElementById("more-extras-btn").addEventListener("click", () => {
  document.getElementById("extras-off-list").textContent = tr("extras.offPrefix") + " " + extrasOff_().join(", ");
  document.getElementById("extras-copy-msg").textContent = "";
  document.getElementById("extras-modal-backdrop").hidden = false;
});
document.getElementById("extras-modal-close").addEventListener("click", () => { document.getElementById("extras-modal-backdrop").hidden = true; });
document.getElementById("extras-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "extras-modal-backdrop") e.target.hidden = true; });
document.getElementById("extras-copy-btn").addEventListener("click", async () => {
  const msg = document.getElementById("extras-copy-msg");
  try { await navigator.clipboard.writeText(new URL("setup/", location.href).href); msg.textContent = tr("extras.copied"); }
  catch (e) { msg.textContent = tr("extras.copyFailed"); }
});

// ---- Welcome questions (first open of an app made by the installer) + the tour ----
// The backend says `capabilities.onboarding` until the answers are saved (Onboarding.gs); the owner's own copy never asks.
// Soles stay the home currency: the currency question only chooses the quick buttons.
const WELCOME_FLAG_KEY = "etOnboarded";
// Soles first (the default main currency), then the world's 10 most-traded currencies; "More…" shows every other
// currency, alphabetically by name.
const WELCOME_TOP_CURRENCIES = ["PEN", "USD", "EUR", "JPY", "GBP", "CNY", "AUD", "CAD", "CHF", "HKD", "SGD"];
function welcomeCurrencyCodes_() {
  const shown = WELCOME_TOP_CURRENCIES.slice();
  // anything already picked stays visible even if it lives in the long list
  const picked = [welcome_.home].concat(welcome_.currencies).filter((c) => !shown.includes(c));
  if (!welcome_.more) return shown.concat(picked);
  const rest = CURRENCIES.map((c) => c.code).filter((c) => !shown.includes(c))
    .sort((a, b) => findCurrency(a).name.localeCompare(findCurrency(b).name, I18n.getLang()));
  return shown.concat(rest);
}
let welcome_ = null;
function welcomeEl_(id) { return document.getElementById(id); }
function maybeShowWelcome_() {
  const caps = (meta && meta.capabilities) || {};
  let done = false;
  try { done = localStorage.getItem(WELCOME_FLAG_KEY) === "1"; } catch (e) { /* storage blocked: ask again next time */ }
  if (!caps.onboarding || done || !welcomeEl_("welcome-overlay").hidden) return;
  startWelcome_(false);
}
// preview = true (More → Preview the welcome flow): the same screens, but nothing is sent or stored anywhere; leaving reloads the app.
function startWelcome_(preview) {
  const lang = I18n.getLang();
  welcomeEl_("welcome-preview-exit").hidden = !preview;
  welcome_ = { preview: !!preview, appLang: lang, lang, order: lang === "es" ? "dmy" : "mdy", home: "PEN", currencies: ["USD", "EUR"], lastTap: null, more: false,
    platforms: [], platformsCustom: [], platformsBatch: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    accounts: [], customBanks: [], links: {}, linksTouched: {}, batch: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), bankOpen: null, form: null };
  welcomeEl_("welcome-overlay").hidden = false;
  welcomeEl_("welcome-questions").hidden = false;
  welcomeEl_("welcome-accounts").hidden = true;
  welcomeEl_("welcome-platforms").hidden = true;
  welcomeEl_("welcome-tour").hidden = true;
  renderWelcomeQuestions_();
}
function renderWelcomeQuestions_() {
  const root = welcomeEl_("welcome-questions");
  I18n.applyStatic(root);
  welcomeEl_("welcome-preview-exit").textContent = tr("welcome.previewExit");
  root.querySelectorAll("[data-welcome-lang]").forEach((b) => b.classList.toggle("active", b.dataset.welcomeLang === welcome_.lang));
  root.querySelectorAll("[data-welcome-order]").forEach((b) => b.classList.toggle("active", b.dataset.welcomeOrder === welcome_.order));
  const box = welcomeEl_("welcome-currencies");
  box.innerHTML = "";
  welcomeEl_("welcome-main-label").textContent = tr("welcome.mainLabel", { code: welcome_.home });
  welcomeCurrencyCodes_().forEach((code) => {
    const isMain = code === welcome_.home;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "welcome-choice" + (isMain ? " active main" : welcome_.currencies.includes(code) ? " active" : "");
    b.textContent = `${isMain ? "★ " : ""}${findCurrency(code).flag} ${code}`;
    b.addEventListener("click", () => welcomeTapCurrency_(code));
    box.appendChild(b);
  });
  if (!welcome_.more) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "welcome-choice";
    more.textContent = tr("common.more");
    more.addEventListener("click", () => { welcome_.more = true; renderWelcomeQuestions_(); });
    box.appendChild(more);
  }
  welcomeEl_("welcome-error").textContent = "";
  welcomeEl_("wq-step").textContent = tr("welcome.step", { n: 1 });
}
// One tap picks or drops a currency; a second tap on the same one within 0.4 s makes it the MAIN currency (★).
// The main currency is always selected, and the old main one stays in the list as an ordinary currency.
function welcomeTapCurrency_(code) {
  const now = Date.now();
  const double = welcome_.lastTap && welcome_.lastTap.code === code && now - welcome_.lastTap.at < 400;
  welcome_.lastTap = double ? null : { code, at: now };
  if (double) {
    if (code !== welcome_.home) {
      const old = welcome_.home;
      welcome_.currencies = welcome_.currencies.filter((c) => c !== code);
      if (!welcome_.currencies.includes(old)) welcome_.currencies.unshift(old);
      welcome_.home = code;
      welcome_.currencies = welcome_.currencies.slice(0, 4);
    }
  } else if (code !== welcome_.home) {
    if (welcome_.currencies.includes(code)) welcome_.currencies = welcome_.currencies.filter((c) => c !== code);
    else if (welcome_.currencies.length < 4) welcome_.currencies.push(code);
  }
  renderWelcomeQuestions_();
}
document.querySelectorAll("[data-welcome-lang]").forEach((b) => b.addEventListener("click", () => {
  const fundsBefore = wpBankFunds_();
  welcome_.lang = b.dataset.welcomeLang;
  I18n.setLang(welcome_.lang);
  const fundsAfter = wpBankFunds_();   // a bank fund already picked keeps its pick, now worded in the new language
  welcome_.platforms = welcome_.platforms.map((n) => (fundsBefore.includes(n) ? fundsAfter[fundsBefore.indexOf(n)] : n));   // only the welcome text changes now; the rest of the app follows on the reload at the end
  renderWelcomeQuestions_();
}));
document.querySelectorAll("[data-welcome-order]").forEach((b) => b.addEventListener("click", () => { welcome_.order = b.dataset.welcomeOrder; renderWelcomeQuestions_(); }));
// ---- Welcome step 2: bank accounts (optional), bank by bank ----
// Nothing is saved until the last button of step 2: Back keeps everything typed in both steps. The server builds the
// final names (backend/Accounts.gs); the previews here follow the same rule.
const WA_KINDS = ["debit_pen", "debit_usd", "credit", "sueldo"];
const WA_RAILS = ["yape_pen", "yape_usd", "plin_pen", "plin_usd"];
const waEl_ = (id) => document.getElementById(id);
function waCatalog_() { return (meta && meta.bankCatalog) || { main: [], other: [], words: { en: {}, es: {} } }; }
function waShort_(bankName) {
  const c = waCatalog_();
  const b = c.main.concat(c.other).find((x) => x.name.toLowerCase() === String(bankName).toLowerCase());
  return b ? b.short : bankName;
}
function waWords_() { const c = waCatalog_(); return c.words[welcome_.lang] || c.words.en || {}; }
function waNameFor_(bankName, f) {
  const last4 = /^\d{4}$/.test(f.last4 || "") ? f.last4 : "";
  const show = !!f.showLast4 && !!last4;
  const base = (f.alias || "").trim() ? f.alias.trim() : `${waShort_(bankName)} ${waWords_()[f.kind] || ""}`.trim();
  return base + (show ? ` (${last4})` : "");
}
// Display names for every account typed so far, unique the same way the server makes them.
function waDisplayNames_() {
  const taken = {}, out = {};
  welcome_.accounts.forEach((a) => {
    let name = waNameFor_(a.bank, a);
    if (taken[name.toLowerCase()] && /^\d{4}$/.test(a.last4 || "") && !name.includes(`(${a.last4})`)) name += ` (${a.last4})`;
    let n = 2; const base = name;
    while (taken[name.toLowerCase()]) { name = `${base} ${n}`; n++; }
    taken[name.toLowerCase()] = true;
    out[a.cid] = name;
  });
  return out;
}
const waBanksOfList_ = (list) => list.slice().sort((x, y) => x.name.localeCompare(y.name, I18n.getLang()));

function showWelcomeStep_(step) {
  welcomeEl_("welcome-questions").hidden = step !== 1;
  welcomeEl_("welcome-accounts").hidden = step !== 2;
  welcomeEl_("welcome-platforms").hidden = step !== 3;
  welcomeEl_("welcome-overlay").scrollTop = 0;
  if (step === 2) { welcome_.bankOpen = null; welcome_.form = null; renderWelcomeAccounts_(); }
  else if (step === 3) renderWelcomePlatforms_();
  else renderWelcomeQuestions_();
}

function renderWelcomeAccounts_() {
  const root = waEl_("welcome-accounts");
  I18n.applyStatic(root);
  const inBank = !!welcome_.bankOpen;
  waEl_("wa-root").hidden = inBank;
  waEl_("wa-bank").hidden = !inBank;
  if (inBank) { renderWaBank_(); return; }
  waEl_("wa-step").textContent = tr("welcome.step", { n: 2 });
  const cat = waCatalog_();
  const count = (name) => welcome_.accounts.filter((a) => a.bank.toLowerCase() === name.toLowerCase()).length;
  const fill = (boxId, banks) => {
    const box = waEl_(boxId);
    box.innerHTML = "";
    banks.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const n = count(b.name);
      btn.className = "wa-bank" + (n ? " has" : "");
      const nm = document.createElement("span"); nm.textContent = b.name;
      const ct = document.createElement("span"); ct.className = "wa-bank-count"; ct.textContent = n ? tr("wa.count", { n }) : "›";
      btn.appendChild(nm); btn.appendChild(ct);
      btn.addEventListener("click", () => { welcome_.bankOpen = b.name; welcome_.form = null; renderWelcomeAccounts_(); });
      box.appendChild(btn);
    });
  };
  const known = new Set(cat.main.concat(cat.other).map((b) => b.name.toLowerCase()));
  const custom = welcome_.customBanks.filter((n) => !known.has(n.toLowerCase())).map((n) => ({ name: n, short: n }));
  fill("wa-main-banks", waBanksOfList_(cat.main));
  fill("wa-other-banks", waBanksOfList_(cat.other.concat(custom)));
  renderWaRails_();
  fillBankNote_(waEl_("wa-note"), welcome_.accounts.map((a) => a.bank));
  waEl_("wa-skip-btn").hidden = welcome_.accounts.length > 0;
  waEl_("wa-error").textContent = "";
}

// Yape works only with BCP accounts; Plin works with other banks, never BCP. Soles accounts for the _pen links, dollar accounts for _usd.
const isBcp_ = (bankName) => String(bankName || "").trim().toLowerCase() === "bcp";
// Credit cards are two-currency, so a card fits both Plin slots, whatever its bank (Plin can pay with a card). Debit accounts come first.
function waCandidates_(key) {
  const soles = key.endsWith("_pen"), yape = key.startsWith("yape");
  const debit = welcome_.accounts.filter((a) => (soles ? a.kind === "debit_pen" || a.kind === "sueldo" : a.kind === "debit_usd") && (yape ? isBcp_(a.bank) : !isBcp_(a.bank)));
  const cards = yape ? [] : welcome_.accounts.filter((a) => a.kind === "credit");
  return debit.concat(cards);
}
function renderWaRails_() {
  const box = waEl_("wa-rails");
  box.innerHTML = "";
  const names = waDisplayNames_();
  WA_RAILS.forEach((key) => {
    const cands = waCandidates_(key);
    // Linked by default: until the person decides, the first account that fits (Yape: a BCP account; Plin: another bank's) is selected.
    // (A debit account wins over a credit card; this is re-decided on every render until the person chooses.)
    if (!(key in welcome_.linksTouched) && cands.length) welcome_.links[key] = (cands.find((a) => a.kind !== "credit") || cands[0]).cid;
    if (welcome_.links[key] && !cands.some((a) => a.cid === welcome_.links[key])) welcome_.links[key] = "";
    const wrap = document.createElement("div");
    wrap.className = "wa-rail";
    const label = document.createElement("label");
    label.textContent = tr(`wa.rail.${key}`);
    const sel = document.createElement("select");
    const none = document.createElement("option"); none.value = ""; none.textContent = tr("wa.unlinked"); sel.appendChild(none);
    cands.forEach((a) => { const o = document.createElement("option"); o.value = a.cid; o.textContent = names[a.cid]; sel.appendChild(o); });
    sel.value = welcome_.links[key] || "";
    sel.disabled = !cands.length;
    sel.addEventListener("change", () => { welcome_.links[key] = sel.value; welcome_.linksTouched[key] = true; });
    wrap.appendChild(label); wrap.appendChild(sel);
    if (!cands.length) {
      const hint = document.createElement("p"); hint.className = "hint";
      hint.textContent = tr(key.startsWith("yape") ? "wa.railNeeds.yape" : "wa.railNeeds.plin", { currency: tr(key.endsWith("_pen") ? "wa.soles" : "wa.dollars") });
      wrap.appendChild(hint);
    }
    box.appendChild(wrap);
  });
}

function renderWaBank_() {
  const bank = welcome_.bankOpen;
  waEl_("wa-bank-name").textContent = bank;
  fillBankNote_(waEl_("wa-bank-note"), [bank]);
  const list = waEl_("wa-bank-accounts");
  list.innerHTML = "";
  const names = waDisplayNames_();
  const mine = welcome_.accounts.filter((a) => a.bank.toLowerCase() === bank.toLowerCase());
  if (!mine.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = tr("wa.noAccounts"); list.appendChild(p); }
  mine.forEach((a) => {
    const row = document.createElement("div");
    row.className = "wa-account";
    const left = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "wa-account-name"; nm.textContent = names[a.cid];
    const sub = document.createElement("div"); sub.className = "wa-account-sub"; sub.textContent = tr(`wa.kind.${a.kind}`);
    left.appendChild(nm); left.appendChild(sub);
    left.style.cursor = "pointer";
    left.addEventListener("click", () => { welcome_.form = { cid: a.cid, kind: a.kind, alias: a.alias, last4: a.last4, showLast4: a.showLast4 }; renderWaBank_(); });
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "wa-link"; rm.textContent = tr("wa.remove");
    rm.addEventListener("click", () => { welcome_.accounts = welcome_.accounts.filter((x) => x.cid !== a.cid); welcome_.form = null; renderWaBank_(); });
    row.appendChild(left); row.appendChild(rm);
    list.appendChild(row);
  });
  const f = welcome_.form;
  waEl_("wa-form").hidden = !f;
  waEl_("wa-add-account-btn").hidden = !!f;
  if (!f) return;
  const kinds = waEl_("wa-kinds");
  kinds.innerHTML = "";
  WA_KINDS.forEach((k) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "welcome-choice" + (f.kind === k ? " active" : ""); b.textContent = tr(`wa.kind.${k}`);
    b.addEventListener("click", () => { f.kind = k; renderWaBank_(); });
    kinds.appendChild(b);
  });
  waEl_("wa-alias").value = f.alias;
  waEl_("wa-alias").placeholder = waNameFor_(bank, { kind: f.kind, alias: "", last4: f.last4, showLast4: f.showLast4 });
  waEl_("wa-last4").value = f.last4;
  waEl_("wa-show4").checked = !!f.showLast4;
  waEl_("wa-form-error").textContent = "";
  waUpdatePreview_();
}
function waUpdatePreview_() {
  const f = welcome_.form; if (!f) return;
  waEl_("wa-preview").textContent = tr("wa.preview", { name: waNameFor_(welcome_.bankOpen, f) });
  waEl_("wa-alias").placeholder = waNameFor_(welcome_.bankOpen, { kind: f.kind, alias: "", last4: f.last4, showLast4: f.showLast4 });
}
waEl_("wa-alias").addEventListener("input", (e) => { welcome_.form.alias = e.target.value; waUpdatePreview_(); });
waEl_("wa-last4").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); welcome_.form.last4 = e.target.value; waUpdatePreview_(); });
waEl_("wa-show4").addEventListener("change", (e) => { welcome_.form.showLast4 = e.target.checked; waUpdatePreview_(); });
waEl_("wa-add-account-btn").addEventListener("click", () => { welcome_.form = { cid: null, kind: "debit_pen", alias: "", last4: "", showLast4: false }; renderWaBank_(); });
waEl_("wa-cancel-account-btn").addEventListener("click", () => { welcome_.form = null; renderWaBank_(); });
waEl_("wa-save-account-btn").addEventListener("click", () => {
  const f = welcome_.form;
  if (f.last4 && !/^\d{4}$/.test(f.last4)) { waEl_("wa-form-error").textContent = tr("wa.errLast4"); return; }
  const data = { bank: welcome_.bankOpen, kind: f.kind, alias: (f.alias || "").trim(), last4: f.last4 || "", showLast4: !!f.showLast4 && !!f.last4 };
  if (f.cid) Object.assign(welcome_.accounts.find((a) => a.cid === f.cid), data);
  else welcome_.accounts.push({ cid: "a" + Date.now() + Math.floor(Math.random() * 1000), ...data });
  welcome_.form = null;
  renderWaBank_();
});
waEl_("wa-bank-back").addEventListener("click", () => { welcome_.bankOpen = null; welcome_.form = null; renderWelcomeAccounts_(); });
waEl_("wa-add-bank-btn").addEventListener("click", () => {
  const name = (prompt(tr("accounts.bankPrompt")) || "").trim().slice(0, 60);
  if (!name) return;
  const cat = waCatalog_();
  const existing = cat.main.concat(cat.other).map((b) => b.name).concat(welcome_.customBanks).find((n) => n.toLowerCase() === name.toLowerCase());
  const use = existing || name;
  if (!existing) welcome_.customBanks.push(name);
  welcome_.bankOpen = use; welcome_.form = null;
  renderWelcomeAccounts_();
});
waEl_("wa-back-btn").addEventListener("click", () => showWelcomeStep_(1));
welcomeEl_("welcome-continue-btn").addEventListener("click", () => showWelcomeStep_(2));

// The end of step 2: check the Yape / Plin links, then on to step 3 (nothing is saved yet).
function waNext_() {
  const missing = WA_RAILS.filter((k) => waCandidates_(k).length && !welcome_.links[k]);
  if (welcome_.accounts.length && missing.length && !confirm(tr("wa.railsConfirm"))) return;
  showWelcomeStep_(3);
}

// Step 3 (optional): investment platforms, in groups. Brand names are the same in both languages; only a bank's fund arm
// ("BCP funds" / "Fondos BCP") is worded per language.
const wpBankFunds_ = () => ["BCP", "BBVA", "Interbank", "Scotiabank"].map((bank) => tr("wp.bankFund", { bank }));
const WP_GROUPS = [
  { title: "wp.g.brokers", names: () => ["Inteligo", "Hapi", "Trii", "eToro"] },
  { title: "wp.g.funds", names: () => ["Fintual", "Prestamype"] },
  { title: "wp.g.crypto", names: () => ["Binance", "Coinbase", "Bybit"] },
  { title: "wp.g.bankFunds", names: wpBankFunds_ }
];
const wpAllNames_ = () => WP_GROUPS.flatMap((g) => g.names()).concat(welcome_.platformsCustom);
function renderWelcomePlatforms_() {
  I18n.applyStatic(waEl_("welcome-platforms"));
  waEl_("wp-step").textContent = tr("welcome.step", { n: 3 });
  const box = waEl_("wp-chips");
  box.innerHTML = "";
  const chip = (name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "welcome-choice" + (welcome_.platforms.includes(name) ? " active" : "");
    b.textContent = name;
    b.addEventListener("click", () => {
      welcome_.platforms = welcome_.platforms.includes(name) ? welcome_.platforms.filter((n) => n !== name) : welcome_.platforms.concat(name);
      renderWelcomePlatforms_();
    });
    return b;
  };
  const group = (titleKey, names) => {
    if (!names.length) return;
    const h = document.createElement("h3");
    h.textContent = tr(titleKey);
    box.appendChild(h);
    const row = document.createElement("div");
    row.className = "welcome-currencies";
    names.forEach((n) => row.appendChild(chip(n)));
    box.appendChild(row);
  };
  WP_GROUPS.forEach((g) => group(g.title, g.names()));
  group("wp.g.yours", welcome_.platformsCustom);
  waEl_("wp-skip-btn").hidden = welcome_.platforms.length > 0;
  waEl_("wp-error").textContent = "";
}
function addWelcomePlatform_() {
  const input = waEl_("wp-input");
  const name = input.value.trim().slice(0, 40);
  if (!name) return;
  const existing = wpAllNames_().find((n) => n.toLowerCase() === name.toLowerCase());
  const use = existing || name;
  if (!existing) welcome_.platformsCustom.push(name);
  if (!welcome_.platforms.includes(use)) welcome_.platforms.push(use);
  input.value = "";
  renderWelcomePlatforms_();
}
waEl_("wp-add-btn").addEventListener("click", addWelcomePlatform_);
waEl_("wp-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addWelcomePlatform_(); } });
waEl_("wp-back-btn").addEventListener("click", () => showWelcomeStep_(2));

// The end of step 3: save the accounts, the platforms, then the answers of step 1 (marked "answered" last, so an interrupted save asks again).
async function finishWelcome_() {
  const btn = waEl_("wp-next-btn");
  btn.disabled = true; btn.textContent = tr("welcome.saving");
  const errEl = waEl_("wp-error");
  errEl.textContent = "";
  if (welcome_.preview) {   // preview: save nothing, just carry on to the rest of the flow
    btn.disabled = false; btn.textContent = tr("welcome.next");
    welcomeEl_("welcome-platforms").hidden = true;
    const toTourPreview = () => {
      if (perfShareState_().asked && !perfIsOwnerCopy_()) openTour_(true);
      else openPerfShareModal_(() => openTour_(true));
    };
    if (meta && meta.capabilities && meta.capabilities.bankEmails) openBankMailModal_({ welcome: true, onClose: toTourPreview });
    else toTourPreview();
    return;
  }
  try {
    if (welcome_.accounts.length) {
      await callApi("saveOnboardingAccounts", { batch: welcome_.batch, lang: welcome_.lang, links: welcome_.links,
        accounts: welcome_.accounts.map((a) => ({ cid: a.cid, bank: a.bank, kind: a.kind, alias: a.alias, last4: a.last4, showLast4: a.showLast4 })) });
    }
    if (welcome_.platforms.length) await callApi("saveOnboardingPlatforms", { batch: welcome_.platformsBatch, names: welcome_.platforms });
    await callApi("saveOnboarding", { language: welcome_.lang, dateOrder: welcome_.order, homeCurrency: welcome_.home, currencies: welcome_.currencies });
  } catch (err) {
    errEl.textContent = tr("wa.error");
    btn.disabled = false; btn.textContent = tr("welcome.next");
    return;
  }
  btn.disabled = false; btn.textContent = tr("welcome.next");
  try {
    localStorage.setItem("recentCurrencies", JSON.stringify([welcome_.home].concat(welcome_.currencies)));
    localStorage.setItem(WELCOME_FLAG_KEY, "1");
  } catch (e) { /* the server remembers it anyway */ }
  if (meta && meta.capabilities) meta.capabilities.onboarding = false;
  if (meta && meta.settings) meta.settings.default_currency = welcome_.home;   // totals and forms use it from here on
  document.getElementById("currency").value = welcome_.home;
  renderCurrencyChips("entry");
  I18n.saveLang(welcome_.lang);
  welcomeEl_("welcome-platforms").hidden = true;
  // The new accounts and platforms must show up in the app right away (entry form, Accounts & cards): reload on the way out.
  const reloadAfter = welcome_.lang !== welcome_.appLang || welcome_.accounts.length > 0 || welcome_.platforms.length > 0;
  const toTour = () => {
    if (perfShareState_().asked) openTour_(reloadAfter);
    else openPerfShareModal_(() => openTour_(reloadAfter));   // the last welcome question: share app speed with the owner
  };
  // Only when bank e-mail reading is on: tell the person which Google account's inbox is read, and how to get other banks' e-mails there.
  if (meta && meta.capabilities && meta.capabilities.bankEmails) openBankMailModal_({ welcome: true, onClose: toTour });
  else toTour();
}
waEl_("wa-next-btn").addEventListener("click", waNext_);
waEl_("wa-skip-btn").addEventListener("click", waNext_);
waEl_("wp-next-btn").addEventListener("click", finishWelcome_);
waEl_("wp-skip-btn").addEventListener("click", finishWelcome_);

let tour_ = null;
// The cards, in order. "bank" only exists when e-mail reading is on for this copy (capabilities.bankEmails is the backend's
// featureOn_('gmail'): false on a friend's app until they turned on bank transactions, always true on the owner's copy).
// The tour comes in two parts (owner's decision 2026-10-21): "basic" is what the welcome flow shows (and More → The basics); "pro" holds the
// advanced features (More → Pro features, or the button at the end of the basics).
function tourCards_(part) {
  if (part === "pro") {
    const caps = (meta && meta.capabilities) || {};
    const cards = ["invest", "loan", "repay", "programmed", "trips", "projections"];
    if (caps.bankEmails) cards.push("bank");
    cards.push("statements");
    return cards;
  }
  return ["flow", "add", "transfer", "overview", "budgets", "more"];
}
// The entry form's fields, explained under the first card: [the app's own field label, what it is for].
const TOUR_ITEMS = {
  add: [["field.amount", "tour.f.amount"], ["field.date", "tour.f.date"], ["field.currency", "tour.f.currency"], ["field.description", "tour.f.description"],
    ["field.paidBy", "tour.f.paidBy"], ["field.paymentMethod", "tour.f.paymentMethod"], ["split.toggle", "tour.f.split"], ["field.tags", "tour.f.tags"]]
};
// The tour is a row of cards the person swipes through sideways (scroll-snap); there is no Next button, so "Next step" inside the
// step-by-step card cannot be confused with it. Each card scrolls up and down on its own (so the next card always appears at its top),
// the dots stay fixed at the bottom (tap one to jump; press and hold them and slide your finger along them to scrub through the cards),
// the last card has the Done button, and only the card on screen plays its animation.
function openTour_(reloadAfter, part) {
  tour_ = { i: 0, part: part === "pro" ? "pro" : "basic", cards: tourCards_(part), reloadAfter: !!reloadAfter, slides: [], holding: false };
  welcomeEl_("welcome-overlay").hidden = false;
  welcomeEl_("welcome-overlay").classList.add("tour-mode");
  welcomeEl_("welcome-questions").hidden = true;
  welcomeEl_("welcome-tour").hidden = false;
  renderTour_();
}
function buildTourSlide_(key, n, total) {
  const slide = document.createElement("section");
  slide.className = "tour-slide";
  const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; slide.appendChild(e); return e; };
  add("p", "hint", tourStepLabel_(n, total));
  add("h2", "", tr(`tour.${key}.title`));
  let body = tr(`tour.${key}.body`);
  if (key === "more" && extrasOff_().length) body += tr("tour.more.extras");
  if (key === "statements" && !perfIsOwnerCopy_()) body += tr("tour.statements.bankHelp");   // the owner's own banks are already built in
  add("p", "welcome-body", body);
  const stage = add("div", "ts-stage");
  stage.hidden = true; stage.setAttribute("role", "img"); stage.setAttribute("aria-hidden", "true");
  const items = TOUR_ITEMS[key] || [];
  if (items.length) {
    const ul = add("ul", "welcome-items");
    items.forEach(([label, what]) => {
      const li = document.createElement("li");
      const b = document.createElement("b"); b.textContent = tr(label);
      li.appendChild(b); li.appendChild(document.createTextNode(": " + tr(what)));
      ul.appendChild(li);
    });
  }
  if (n === total - 1) {
    const done = add("button", "primary tour-done-btn", tr(tour_.part === "pro" ? "tour.doneShort" : "tour.done"));
    done.type = "button";
    done.addEventListener("click", closeTour_);
    if (tour_.part !== "pro") {   // the basics end with a way into the advanced features
      const pro = add("button", "tour-pro-btn", tr("tour.openPro"));
      pro.type = "button";
      pro.addEventListener("click", () => openTourPart_("pro"));
    }
  }
  return { el: slide, key, stage };
}
function tourStepLabel_(n, total) { return (tour_ && tour_.part === "pro" ? tr("tour.proTag") + " · " : "") + tr("tour.step", { n: n + 1, total }); }
// From the end of the basics straight into the Pro cards (the same overlay; closing it still reloads when the welcome flow asked for that).
function openTourPart_(part) {
  if (!tour_) return;
  const reload = tour_.reloadAfter;
  if (typeof TourScenes !== "undefined") TourScenes.stop();
  welcomeEl_("tour-dots").innerHTML = "";
  tour_ = { i: 0, part, cards: tourCards_(part), reloadAfter: reload, slides: [], holding: false };
  renderTour_();
  welcomeEl_("tour-track").scrollLeft = 0;
}
function renderTour_() {
  const track = welcomeEl_("tour-track");
  track.innerHTML = "";
  const total = tour_.cards.length;
  tour_.slides = tour_.cards.map((key, n) => { const sl = buildTourSlide_(key, n, total); track.appendChild(sl.el); return sl; });
  tour_.shown = -1;
  I18n.applyStatic(welcomeEl_("welcome-tour"));
  // Every card already shows its animation's starting picture, so a swipe never reveals an empty card (the one on screen plays from the start).
  tour_.slides.forEach((sl, n) => { if (n !== tour_.i) previewTourSlide_(sl); });
  showTourCard_(tour_.i, false);
  track.scrollLeft = tour_.i * track.clientWidth;
}
// The bottom bar never changes height (the hint and Skip are hidden with visibility, not removed), so nothing jumps between cards.
function tourChrome_(i) {
  const last = i === tour_.cards.length - 1;
  const dots = welcomeEl_("tour-dots");
  if (dots.children.length !== tour_.cards.length) dots.innerHTML = tour_.cards.map((_, n) => `<button type="button" class="welcome-dot" data-tour-dot="${n}" aria-label="${n + 1}"></button>`).join("");
  [...dots.children].forEach((d, n) => d.classList.toggle("active", n === i));
  welcomeEl_("tour-hint").style.visibility = i === 0 ? "visible" : "hidden";
  welcomeEl_("tour-skip-btn").style.visibility = last ? "hidden" : "visible";
}
function tourSceneCtx_() { return { tr, home: homeCur(), money: moneyFmt, period: monthBounds(new Date()).label }; }
function previewTourSlide_(sl) {
  if (typeof TourScenes !== "undefined") TourScenes.preview(sl.key, sl.stage, tourSceneCtx_());
}
// A smooth scroll that crosses more than one card is ignored by the browser while snapping is on (scroll-snap-stop), so a long jump
// (tapping a far dot) turns snapping off for the length of the slide and puts it back, exactly on the card, afterwards.
function scrollTourTo_(i) {
  const track = welcomeEl_("tour-track"), w = track.clientWidth;
  if (Math.abs(i - Math.round(track.scrollLeft / w)) <= 1) { track.scrollTo({ left: i * w, behavior: "smooth" }); return; }
  track.classList.add("fast");
  track.scrollTo({ left: i * w, behavior: "smooth" });
  clearTimeout(tour_.fastTimer);
  tour_.fastTimer = setTimeout(() => { track.scrollLeft = i * w; track.classList.remove("fast"); }, 600);
}
function showTourCard_(i, scroll) {
  if (!tour_ || i === tour_.shown) return;
  const track = welcomeEl_("tour-track");
  const before = tour_.shown;
  tour_.i = i; tour_.shown = i;
  tourChrome_(i);
  if (scroll) scrollTourTo_(i);
  // The animated mini scene (tour-scenes.js) plays only on the card on screen; the one just left goes back to its starting picture,
  // scrolled to its top, so it is ready for the next visit.
  if (before >= 0 && before !== i && tour_.slides[before]) { tour_.slides[before].el.scrollTop = 0; previewTourSlide_(tour_.slides[before]); }
  if (typeof TourScenes !== "undefined") TourScenes.play(tour_.slides[i].key, tour_.slides[i].stage, tourSceneCtx_());
}
document.getElementById("more-preview-welcome-btn").addEventListener("click", () => {
  if (!welcomeEl_("welcome-overlay").hidden) return;
  startWelcome_(true);
});
welcomeEl_("welcome-preview-exit").addEventListener("click", () => window.location.reload());   // nothing was stored, so a reload puts the app back exactly as it was
function closeTour_() {
  if (typeof TourScenes !== "undefined") TourScenes.stop();
  welcomeEl_("welcome-overlay").hidden = true;
  welcomeEl_("welcome-overlay").classList.remove("tour-mode");
  const reload = tour_ && tour_.reloadAfter;
  tour_ = null;
  if (reload) window.location.reload();
}
{
  const track = welcomeEl_("tour-track");
  let settle = null;
  const cardNow = () => Math.max(0, Math.min(tour_.cards.length - 1, Math.round(track.scrollLeft / track.clientWidth)));
  // The dots follow the card nearest the middle of the screen WHILE you swipe (a quick swipe through several cards never leaves the dot behind);
  // the card's animation starts only once the swipe settles.
  track.addEventListener("scroll", () => {
    clearTimeout(settle);
    if (!tour_ || !track.clientWidth) return;
    if (tour_.holding) return;   // running through the cards: only the dots follow until the finger is lifted
    if (!track.classList.contains("fast")) tourChrome_(cardNow());
    settle = setTimeout(() => { if (tour_ && track.clientWidth) { const n = cardNow(); tourChrome_(n); showTourCard_(n, false); } }, 90);
  }, { passive: true });
  let hold = null, suppressClick = false;   // hold = the finger on the bar
  welcomeEl_("tour-dots").addEventListener("click", (e) => {
    if (suppressClick) return;
    const d = e.target.closest("[data-tour-dot]"); if (d && tour_) { tour_.shown = -2; showTourCard_(Number(d.dataset.tourDot), true); }
  });
  // Press and hold the dots, then slide the finger along them (like the dots of a photo carousel): the dots swell, a bubble names the card, and the card
  // under your finger shows at once; lifting the finger lands on it. Animations stay quiet while you slide; the card you land on plays its own.
  const bar = document.querySelector(".tour-foot-row");
  const dotsEl = welcomeEl_("tour-dots");
  const bubble = welcomeEl_("tour-bubble");
  const nearestDot = (x) => {
    let best = 0, gap = Infinity;
    [...dotsEl.children].forEach((d, n) => { const r = d.getBoundingClientRect(); const g = Math.abs(r.left + r.width / 2 - x); if (g < gap) { gap = g; best = n; } });
    return best;
  };
  const showBubble = (idx, x) => {
    const foot = bar.parentElement.getBoundingClientRect();
    bubble.textContent = tourStepLabel_(idx, tour_.cards.length) + " · " + tr(`tour.${tour_.cards[idx]}.title`);
    bubble.hidden = false;
    const half = bubble.offsetWidth / 2;
    bubble.style.left = Math.max(half + 4, Math.min(foot.width - half - 4, x - foot.left)) + "px";
  };
  const scrubTo = (idx, x) => {
    if (idx !== hold.idx) { hold.idx = idx; tourChrome_(idx); track.scrollLeft = idx * track.clientWidth; }   // jumps at once (snapping is off meanwhile)
    showBubble(idx, x);
  };
  const beginScrub = (x) => {
    if (!hold || hold.scrubbing || !tour_) return;
    hold.scrubbing = true; tour_.holding = true;
    if (typeof TourScenes !== "undefined") TourScenes.stop();
    track.classList.add("fast"); bar.classList.add("scrubbing");
    try { bar.setPointerCapture(hold.pointerId); } catch (err) { /* older browsers: the finger is still tracked over the bar */ }
    scrubTo(nearestDot(x), x);
  };
  const endScrub = () => {
    if (!hold) return;
    const h = hold; hold = null;
    clearTimeout(h.timer);
    if (!h.scrubbing || !tour_) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 120);
    tour_.holding = false;
    bar.classList.remove("scrubbing"); bubble.hidden = true;
    track.scrollLeft = h.idx * track.clientWidth; track.classList.remove("fast");
    tour_.shown = -2;   // even if you land back on the card you started from, its animation starts again
    showTourCard_(h.idx, false);
  };
  bar.addEventListener("pointerdown", (e) => {
    if (!tour_ || (e.button != null && e.button > 0) || e.target.closest("#tour-skip-btn")) return;
    hold = { idx: tour_.i, scrubbing: false, startX: e.clientX, pointerId: e.pointerId, timer: null };
    hold.timer = setTimeout(() => beginScrub(e.clientX), 220);   // a short press-and-hold starts it (a plain tap on a dot still jumps to it)
  });
  bar.addEventListener("pointermove", (e) => {
    if (!hold || !tour_) return;
    if (!hold.scrubbing) { if (Math.abs(e.clientX - hold.startX) > 8) beginScrub(e.clientX); return; }   // sliding right away also starts it
    scrubTo(nearestDot(e.clientX), e.clientX);
  });
  ["pointerup", "pointercancel"].forEach((ev) => bar.addEventListener(ev, endScrub));
  bar.addEventListener("pointerleave", () => { if (hold && !hold.scrubbing) { clearTimeout(hold.timer); hold = null; } });   // the finger left before the hold began
  bar.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {   // arrow keys do the same as a swipe (handy on a computer)
    if (!tour_ || welcomeEl_("welcome-tour").hidden || welcomeEl_("welcome-overlay").hidden) return;
    if (e.key === "ArrowRight" && tour_.i < tour_.cards.length - 1) showTourCard_(tour_.i + 1, true);
    else if (e.key === "ArrowLeft" && tour_.i > 0) showTourCard_(tour_.i - 1, true);
  });
}
welcomeEl_("tour-skip-btn").addEventListener("click", closeTour_);
// More → How to use the app: one row, then a small choice between the two parts of the tour.
{
  const choice = document.getElementById("tour-choice-backdrop");
  const open = (part) => { choice.hidden = true; openTour_(false, part); };
  document.getElementById("more-tour-btn").addEventListener("click", () => { choice.hidden = false; });
  document.getElementById("tour-choice-basic").addEventListener("click", () => open("basic"));
  document.getElementById("tour-choice-pro").addEventListener("click", () => open("pro"));
  document.getElementById("tour-choice-close").addEventListener("click", () => { choice.hidden = true; });
}

// ---- Main currency (More → Main currency) ----
// Switching is reversible and rewrites no data: exchange rates are stored against a fixed base currency and the main
// currency is only the lens (backend/HomeCurrency.gs). If the new main currency has no rate on file yet, one question is asked.
let mainChange_ = null;
function mainCurrencyEl_(id) { return document.getElementById(id); }
function openMainCurrencyModal_() {
  mainCurrencyEl_("main-currency-current").textContent = tr("mainCur.current", { code: homeCur() });
  mainCurrencyEl_("main-currency-view").hidden = false;
  mainCurrencyEl_("main-currency-confirm").hidden = true;
  mainCurrencyEl_("main-currency-error").textContent = "";
  bringModalToFront_(mainCurrencyEl_("main-currency-backdrop"));
  mainCurrencyEl_("main-currency-backdrop").hidden = false;
}
async function startMainCurrencyChange_(code) {
  openMainCurrencyModal_();
  const err = mainCurrencyEl_("main-currency-error");
  if (code === homeCur()) { err.textContent = tr("mainCur.same"); return; }
  let pre;
  try { pre = await callApi("previewMainCurrencyChange", { currency: code }); }
  catch (e) { err.textContent = tr("mainCur.failed", { error: e.message }); return; }
  mainChange_ = { code, pre };
  mainCurrencyEl_("main-currency-confirm-text").textContent = tr("mainCur.confirm", { from: homeCur(), to: code });
  mainCurrencyEl_("main-currency-rate-row").hidden = !pre.needsRate;
  mainCurrencyEl_("main-currency-rate-label").textContent = tr("mainCur.rateQuestion", { from: homeCur(), to: code });
  mainCurrencyEl_("main-currency-rate").value = "";
  mainCurrencyEl_("main-currency-estimate").textContent = pre.estimatedBefore ? tr("mainCur.estimate", { month: pre.estimatedBefore, to: code }) : "";
  mainCurrencyEl_("main-currency-view").hidden = true;
  mainCurrencyEl_("main-currency-confirm").hidden = false;
}
document.getElementById("more-main-currency-btn").addEventListener("click", openMainCurrencyModal_);
mainCurrencyEl_("main-currency-close").addEventListener("click", () => { mainCurrencyEl_("main-currency-backdrop").hidden = true; });
mainCurrencyEl_("main-currency-backdrop").addEventListener("click", (e) => { if (e.target.id === "main-currency-backdrop") e.target.hidden = true; });
mainCurrencyEl_("main-currency-change-btn").addEventListener("click", () => { mainCurrencyEl_("main-currency-backdrop").hidden = true; openCurrencyModal("main-change"); });
mainCurrencyEl_("main-currency-cancel-btn").addEventListener("click", () => { mainChange_ = null; openMainCurrencyModal_(); });
mainCurrencyEl_("main-currency-apply-btn").addEventListener("click", async () => {
  if (!mainChange_) return;
  const err = mainCurrencyEl_("main-currency-error");
  const btn = mainCurrencyEl_("main-currency-apply-btn");
  const payload = { currency: mainChange_.code };
  if (mainChange_.pre.needsRate) {
    const rate = Number(mainCurrencyEl_("main-currency-rate").value);
    if (!(rate > 0)) { err.textContent = tr("mainCur.rateNeeded"); return; }
    payload.rate = rate;
  }
  btn.disabled = true; btn.textContent = tr("mainCur.switching"); err.textContent = "";
  try {
    await callApi("changeMainCurrency", payload);
  } catch (e) {
    err.textContent = tr("mainCur.failed", { error: e.message });
    btn.disabled = false; btn.textContent = tr("mainCur.apply");
    return;
  }
  try {
    const recents = [mainChange_.code].concat(getRecentCurrencies().filter((c) => c !== mainChange_.code)).slice(0, 5);
    localStorage.setItem("recentCurrencies", JSON.stringify(recents));
    localStorage.removeItem(STARTUP_CACHE_KEY);   // the saved first screen is in the old main currency
  } catch (e2) { /* storage blocked: the app reloads from the server anyway */ }
  window.location.reload();
});

// Release number at the bottom of the More tab.
(function showAppVersion() {
  const el = document.getElementById("more-app-version");
  const v = appRelease_();
  if (el && v) el.textContent = tr("more.version", { v });
})();

// Language picker (More tab). The choice is remembered on this phone; the app
// reloads so every screen is rebuilt in the new language.
(function setupLanguagePicker() {
  const select = document.getElementById("language-select");
  select.value = I18n.getLang();
  select.addEventListener("change", async () => {
    const lang = I18n.saveLang(select.value);
    // Also saved in the Sheet so the bot, alerts and e-mails speak the same
    // language; don't make the person wait long if the server is slow to wake.
    try { await Promise.race([callApi("setLanguage", { lang }), sleep(3000)]); } catch (err) { /* saved on the next app open */ }
    window.location.reload();
  });
})();
document.getElementById("devices-modal-close").addEventListener("click", () => { document.getElementById("devices-modal-backdrop").hidden = true; });

// ---- More → Bank emails: which Google account's inbox is read, and how to get a bank's emails there ----
// (specs/review-telegram-email.md § Bank emails guide). The same sheet is the "Got it" screen at the end of the welcome questions.
const bmEl_ = (id) => document.getElementById(id);
let bm_ = { onClose: null };

function openBankMailModal_(opts) {
  opts = opts || {};
  bm_.onClose = opts.onClose || null;
  const info = (meta && meta.emailInfo) || {};
  const backdrop = bmEl_("bank-mail-modal-backdrop");
  I18n.applyStatic(backdrop);
  bmEl_("bm-address").textContent = info.address || tr("bankMail.noAddress");
  bmEl_("bm-copy-btn").hidden = !info.address;
  bmEl_("bm-msg").textContent = "";
  bmEl_("bm-banks").textContent = (info.banks || []).length ? tr("bankMail.supported", { banks: info.banks.join(", ") }) : "";
  bmEl_("bm-done-btn").hidden = !opts.welcome;
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeBankMailModal_() {
  bmEl_("bank-mail-modal-backdrop").hidden = true;
  const done = bm_.onClose;
  bm_.onClose = null;
  if (done) done();
}

bmEl_("more-bank-mail-btn").addEventListener("click", () => openBankMailModal_());
bmEl_("bank-mail-close").addEventListener("click", closeBankMailModal_);
bmEl_("bm-done-btn").addEventListener("click", closeBankMailModal_);
bmEl_("bm-copy-btn").addEventListener("click", async () => {
  const info = (meta && meta.emailInfo) || {};
  try { await navigator.clipboard.writeText(info.address || ""); bmEl_("bm-msg").textContent = tr("bankMail.copied"); }
  catch (err) { bmEl_("bm-msg").textContent = tr("bankMail.copyFail"); }
});

// "We can't read this bank's emails yet": shown (on a friend's copy, where bank e-mail reading is on) next to accounts at a bank with no
// parsing rule, with a button to the "My bank isn't supported yet" sheet. The owner's own copy never shows it (he writes the rules).
function bankReadable_(name) {
  const list = (meta && meta.emailInfo && meta.emailInfo.banks) || [];
  return list.some((b) => b.toLowerCase() === String(name || "").trim().toLowerCase());
}
function fillBankNote_(el, bankNames) {
  el.innerHTML = "";
  const caps = (meta && meta.capabilities) || {};
  const names = [...new Set(bankNames.filter((n) => n && !bankReadable_(n)))];
  // A copy still on an older pinned backend sends no emailInfo: say nothing rather than call every bank unreadable.
  if (!caps.bankEmails || perfIsOwnerCopy_() || !names.length || !(meta && meta.emailInfo && meta.emailInfo.banks)) return;
  const p = document.createElement("p");
  p.className = "hint";
  p.style.fontWeight = "600";
  p.textContent = tr("bankNote.text", { banks: names.join(", ") });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "add-inline";
  btn.textContent = tr("bankNote.tell");
  btn.addEventListener("click", openBankSampleModal_);
  el.appendChild(p);
  el.appendChild(btn);
}
document.getElementById("devices-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "devices-modal-backdrop") e.target.hidden = true;
});
document.getElementById("devices-signout-others-btn").addEventListener("click", async () => {
  if (!confirm(tr("devices.confirmOthers"))) return;
  try {
    await callApi("revokeOtherSessions", {});
    openDevicesModal_();
  } catch (err) {
    document.getElementById("devices-error").textContent = err.message;
  }
});
document.getElementById("perf-back-btn").addEventListener("click", () => showScreen("more"));
document.getElementById("perf-clear-btn").addEventListener("click", () => {
  localStorage.removeItem(PERF_LOG_KEY);
  renderPerfScreen();
});
document.getElementById("perf-copy-btn").addEventListener("click", async () => {
  const btn = document.getElementById("perf-copy-btn");
  try {
    await navigator.clipboard.writeText(perfReportText_());
    btn.textContent = tr("perf.copied");
  } catch (err) {
    btn.textContent = tr("perf.copyFailed");
  }
  setTimeout(() => { btn.textContent = tr("perf.copy"); }, 2000);
});
document.getElementById("exchange-rates-back-btn").addEventListener("click", () => showScreen("more"));

// ---- Export data screen (More tab) ----
// The server builds the chosen files (Export.gs); the app only says which files
// and which dates. "Get my files" brings them to the phone, one Save button per
// file (a second tap, because iOS only opens its share sheet straight from a
// tap — not after a wait for the server). "Send to my email" is offered only
// when the backend has an address saved; the address can never come from here.

const EXPORT_PREFS_KEY = "exportPrefs";

function exportEl_(id) { return document.getElementById(id); }

function loadExportPrefs_() {
  try { return JSON.parse(localStorage.getItem(EXPORT_PREFS_KEY) || "{}") || {}; } catch (err) { return {}; }
}

function saveExportPrefs_() {
  try {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify({
      entries: exportEl_("export-entries-check").checked,
      backup: exportEl_("export-backup-check").checked,
      range: exportEl_("export-range").value,
      pending: exportEl_("export-pending-check").checked
    }));
  } catch (err) { /* private mode etc.: the screen works without it */ }
}

function showExportScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-export"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === "more");
  });
  const prefs = loadExportPrefs_();
  exportEl_("export-entries-check").checked = !!prefs.entries;
  exportEl_("export-backup-check").checked = !!prefs.backup;
  exportEl_("export-pending-check").checked = !!prefs.pending;
  if (["month", "year", "all", "custom"].includes(prefs.range)) exportEl_("export-range").value = prefs.range;
  exportEl_("export-status").textContent = "";
  exportEl_("export-ready").hidden = true;
  exportEl_("export-ready").textContent = "";
  refreshExportScreen_();
}

function refreshExportScreen_() {
  const entries = exportEl_("export-entries-check").checked;
  exportEl_("export-entries-options").hidden = !entries;
  exportEl_("export-custom-fields").hidden = exportEl_("export-range").value !== "custom";
  const any = entries || exportEl_("export-backup-check").checked;
  exportEl_("export-get-btn").disabled = !any;
  exportEl_("export-send-btn").hidden = !(meta && meta.capabilities && meta.capabilities.emailExport);
  exportEl_("export-send-btn").disabled = !any;
}

// The dates for the picked range, as YYYY-MM-DD (empty = no limit on that side).
function exportDateRange_() {
  const range = exportEl_("export-range").value;
  const today = todayLocalISO();
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  if (range === "month") {
    const last = new Date(y, m, 0).getDate();
    return { startDate: `${today.slice(0, 7)}-01`, endDate: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}` };
  }
  if (range === "year") return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
  if (range === "custom") return { startDate: exportEl_("export-start").value, endDate: exportEl_("export-end").value };
  return { startDate: "", endDate: "" };
}

// The files picked on screen, or null (after saying why) when the request is not valid yet.
function exportRequest_() {
  const status = exportEl_("export-status");
  const cards = [];
  if (exportEl_("export-entries-check").checked) cards.push("entries");
  if (exportEl_("export-backup-check").checked) cards.push("backup");
  if (!cards.length) return null;
  const range = exportDateRange_();
  if (cards.includes("entries") && exportEl_("export-range").value === "custom" && !range.startDate && !range.endDate) {
    status.style.color = "#d64545";
    status.textContent = tr("export.pickDates");
    return null;
  }
  return {
    cards, startDate: range.startDate, endDate: range.endDate,
    includePending: exportEl_("export-pending-check").checked
  };
}

function exportFileLabel_(f) {
  return tr(f.kind === "entries" ? "export.fileEntries" : "export.fileRecords", { name: f.name, n: f.rows === 1 ? 1 : f.rows.toLocaleString("en-US") });
}

async function getExportFiles_() {
  const req = exportRequest_();
  if (!req) return;
  const status = exportEl_("export-status");
  const ready = exportEl_("export-ready");
  const btn = exportEl_("export-get-btn");
  btn.disabled = true;
  ready.hidden = true;
  ready.textContent = "";
  status.style.color = "";
  status.textContent = tr("export.preparing");
  try {
    const res = await callApi("exportDownload", req);
    status.textContent = tr("export.ready");
    res.files.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "primary";
      b.style.marginTop = "8px";
      b.textContent = tr("export.save", { file: exportFileLabel_(f) });
      b.addEventListener("click", () => saveExportFile_(f));
      ready.appendChild(b);
    });
    ready.hidden = false;
  } catch (err) {
    status.style.color = "#d64545";
    status.textContent = err.message;
  } finally {
    refreshExportScreen_();
  }
}

// iPhone: the share sheet ("Save to Files") when the browser can share files;
// otherwise (desktop, older browsers) a normal download link.
async function saveExportFile_(f) {
  const status = exportEl_("export-status");
  status.style.color = "";
  const file = new File([f.text], f.name, { type: f.mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;   // closed the share sheet: not an error
    // anything else: fall through to the plain download below
  }
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    status.style.color = "#d64545";
    status.textContent = err.message;
  }
}

async function sendExport_() {
  const status = exportEl_("export-status");
  const btn = exportEl_("export-send-btn");
  const req = exportRequest_();
  if (!req) return;
  btn.disabled = true;
  status.style.color = "";
  status.textContent = tr("export.sending");
  try {
    const res = await callApi("exportData", req);
    const parts = res.files.map(exportFileLabel_);
    status.textContent = tr("export.sent", { files: parts.join(tr("export.and")) });
  } catch (err) {
    status.style.color = "#d64545";
    status.textContent = err.message;
  } finally {
    refreshExportScreen_();
  }
}

document.getElementById("more-export-btn").addEventListener("click", showExportScreen);
document.getElementById("export-back-btn").addEventListener("click", () => showScreen("more"));
["export-entries-check", "export-backup-check", "export-range", "export-pending-check"].forEach((id) => {
  exportEl_(id).addEventListener("change", () => { refreshExportScreen_(); saveExportPrefs_(); });
});
document.getElementById("export-get-btn").addEventListener("click", getExportFiles_);
document.getElementById("export-send-btn").addEventListener("click", sendExport_);

// ---- Performance log screen (More tab) ----

function showPerfScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-perf"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === "more");
  });
  renderPerfScreen();
}

function perfStats_(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const pick = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: v.length, median: pick(0.5), p90: pick(0.9), max: v[v.length - 1] };
}

function perfSummaryRows_() {
  let log = [];
  try { log = JSON.parse(localStorage.getItem(PERF_LOG_KEY) || "[]"); } catch (err) { /* empty */ }
  const groups = {};
  log.forEach((e) => {
    const key = `${e.kind === "startup" ? "◆ " : ""}${e.name}`;
    (groups[key] = groups[key] || []).push(e);
  });
  return Object.keys(groups).sort().map((key) => {
    const es = groups[key];
    const total = perfStats_(es.map((e) => e.totalMs));
    const server = perfStats_(es.map((e) => e.serverMs));
    return {
      name: key, total, server,
      cold: es.filter((e) => e.cold).length,
      retried: es.filter((e) => e.attempts > 1).length,
      failed: es.filter((e) => e.ok === false).length
    };
  });
}

function perfReportText_() {
  const rows = perfSummaryRows_();
  const first = (() => { try { return JSON.parse(localStorage.getItem(PERF_LOG_KEY) || "[]")[0]; } catch (e) { return null; } })();
  const lines = [`Performance report — since ${first ? new Date(first.t).toISOString() : "n/a"} — app ${document.querySelector('link[rel=stylesheet]').href.split("?v=")[1]}`,
    "name | n | median ms | p90 ms | max ms | server median ms | cold | retried | failed"];
  rows.forEach((r) => {
    lines.push([r.name, r.total.n, r.total.median, r.total.p90, r.total.max,
      r.server ? r.server.median : "-", r.cold, r.retried, r.failed].join(" | "));
  });
  return lines.join("\n");
}

function renderPerfScreen() {
  const box = document.getElementById("perf-summary");
  const rows = perfSummaryRows_();
  if (!rows.length) {
    box.innerHTML = `<div class="status-msg">${escapeHtml(tr("perf.empty"))}</div>`;
    return;
  }
  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  box.innerHTML = rows.map((r) => `
    <div class="perf-row">
      <div class="perf-name">${escapeHtml(r.name)} <span class="hint">×${r.total.n}</span></div>
      <div class="hint">${[tr("perf.median", { v: fmt(r.total.median) }), tr("perf.p90", { v: fmt(r.total.p90) }), tr("perf.max", { v: fmt(r.total.max) }),
        r.server ? tr("perf.server", { v: fmt(r.server.median) }) : "",
        r.cold ? tr("perf.cold", { n: r.cold }) : "", r.retried ? tr("perf.retried", { n: r.retried }) : "", r.failed ? tr("perf.failed", { n: r.failed }) : ""].filter(Boolean).join(" · ")}</div>
    </div>`).join("");
}

// ---- Exchange rates (More tab) ----

async function refreshExchangeRates() {
  const list = document.getElementById("exchange-rates-list");
  const emptyNote = document.getElementById("exchange-rates-empty-note");
  list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  let rates;
  try {
    rates = await callApi("listExchangeRates");
  } catch (err) {
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
    return;
  }

  list.innerHTML = "";
  emptyNote.hidden = rates.length > 0;

  rates.forEach((r) => {
    const row = document.createElement("div");
    row.className = "recurring-row";
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${findCurrency(r.currency).flag} ${r.currency}</div>
        <div class="recurring-row-sub">${r.month}</div>
      </div>
      <div class="recurring-row-amount">1 ${r.currency} = ${homeCur()} ${moneyFmt(r.rate)}</div>
    `;
    row.addEventListener("click", async () => {
      const newRate = await openRateModal(r.currency, r.month, /* required */ false, r.rate);
      if (newRate != null) refreshExchangeRates();
    });
    list.appendChild(row);
  });
}

// ---- Accounts & cards (More tab) ----
// The list reads meta.paymentMethods (already loaded for the entry form), and a
// save updates meta in place, so nothing is re-fetched. Cards show only the
// last 4 digits — the app never asks for a full number.

const PM_TYPES_ = ["credit", "debit", "cash", "transfer", "wallet"];
let pmModalState = null; // { id } while the window is open; id is null when adding

function showAccountsScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-accounts"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === "more");
  });
  renderAccountsList_();
  renderRailsCard_();
}

// Yape and Plin ride on a bank account, one per currency (Settings yape_pen, yape_usd, plin_pen, plin_usd). Changing a
// choice is saved at once.
function renderRailsCard_() {
  const box = document.getElementById("rails-card-selects");
  box.innerHTML = "";
  document.getElementById("rails-card-status").textContent = "";
  const settings = (meta && meta.settings) || {};
  ["yape_pen", "yape_usd", "plin_pen", "plin_usd"].forEach((key) => {
    const soles = key.endsWith("_pen");
    const wrap = document.createElement("div");
    wrap.className = "wa-rail";
    const label = document.createElement("label");
    label.textContent = tr(`wa.rail.${key}`);
    const sel = document.createElement("select");
    const none = document.createElement("option"); none.value = ""; none.textContent = tr("wa.unlinked"); sel.appendChild(none);
    const yape = key.startsWith("yape");
    const bankOf = (pm) => { const b = (meta.banks || []).find((x) => x.id === pm.bank_id); return b ? b.name : ""; };
    // Yape: BCP accounts only. Plin: any bank but BCP. A link already saved stays listed even if it breaks that rule.
    // Plin may also use any credit card (two-currency), so cards are listed in both of its slots.
    meta.paymentMethods
      .filter((pm) => String(settings[key] || "") === String(pm.id) || (!yape && pm.type === "credit" && !pmHidden_(pm)) || (pm.type === "debit" && !pmHidden_(pm) && (yape ? isBcp_(bankOf(pm)) : !isBcp_(bankOf(pm))) &&
        (!pm.alias_kind || (soles ? pm.alias_kind === "debit_pen" || pm.alias_kind === "sueldo" : pm.alias_kind === "debit_usd"))))
      .sort((a, b) => a.nickname.localeCompare(b.nickname))
      .forEach((pm) => { const o = document.createElement("option"); o.value = pm.id; o.textContent = pm.nickname; sel.appendChild(o); });
    sel.value = settings[key] || "";
    sel.addEventListener("change", async () => {
      const status = document.getElementById("rails-card-status");
      try {
        await callApi("saveRailLinks", { [key]: sel.value });
        meta.settings[key] = sel.value;
        status.textContent = tr("wa.saved");
      } catch (err) { status.textContent = err.message; }
    });
    wrap.appendChild(label); wrap.appendChild(sel);
    box.appendChild(wrap);
  });
}

function renderAccountsList_() {
  const list = document.getElementById("accounts-list");
  const bankName = (id) => { const b = (meta.banks || []).find((x) => x.id === id); return b ? b.name : ""; };
  const rows = meta.paymentMethods.slice().sort((a, b) => a.nickname.localeCompare(b.nickname));
  document.getElementById("accounts-empty-note").hidden = rows.length > 0;
  list.innerHTML = "";
  fillBankNote_(document.getElementById("accounts-bank-note"), rows.filter((pm) => pm.type === "credit" || pm.type === "debit").map((pm) => bankName(pm.bank_id)));
  // Three groups (owner, 2026-10-19): bank accounts + credit cards, wallets + cash + transfer, investment platforms.
  const groupOf = (pm) => (pm.type === "investment" ? "platform" : pm.type === "credit" || pm.type === "debit" ? "bank" : "wallet");
  ["bank", "wallet", "platform"].forEach((g) => rows.filter((pm) => groupOf(pm) === g).forEach((pm, i) => {
    if (i === 0) {
      const head = document.createElement("h3");
      head.className = "accounts-group-title";
      head.textContent = tr(`accounts.group.${g}`);
      list.appendChild(head);
    }
    const row = document.createElement("div");
    row.className = "recurring-row" + (pmHidden_(pm) ? " inactive" : "");
    const sub = [tr(`accounts.type.${pm.type}`), bankName(pm.bank_id), pmHidden_(pm) ? tr("accounts.hiddenTag") : ""].filter(Boolean).join(" · ");
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${escapeHtml(pm.nickname)}</div>
        <div class="recurring-row-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="recurring-row-amount">${pm.last_4 ? escapeHtml(tr("accounts.digits", { last4: pm.last_4 })) : ""}</div>
    `;
    row.addEventListener("click", () => openPmModal_(pm));
    list.appendChild(row);
  }));
}

function fillPmBankOptions_(selectedId) {
  const sel = document.getElementById("pm-bank");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = tr("accounts.noBank");
  sel.appendChild(none);
  (meta.banks || []).slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((b) => {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.name;
    sel.appendChild(o);
  });
  const add = document.createElement("option");
  add.value = "__add__";
  add.textContent = tr("accounts.addBank");
  sel.appendChild(add);
  sel.value = selectedId || "";
}

function openPmModal_(pm) {
  pmModalState = { id: pm ? pm.id : null, lastBank: pm ? pm.bank_id || "" : "" };
  document.getElementById("pm-modal-title").textContent = tr(pm ? "accounts.editTitle" : "accounts.addTitle");
  const typeSel = document.getElementById("pm-type");
  typeSel.innerHTML = "";
  // An investment platform keeps its type; it isn't offered for new accounts.
  const types = pm && pm.type === "investment" ? [...PM_TYPES_, "investment"] : PM_TYPES_;
  types.forEach((t) => {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = tr(`accounts.type.${t}`);
    typeSel.appendChild(o);
  });
  typeSel.value = pm ? pm.type : "credit";
  // A wallet tied to a bank account must not be added as a wallet: the bank account behind it is the account (owner's rule, 2026-10-18).
  const walletWarn = () => { document.getElementById("pm-wallet-warning").hidden = typeSel.value !== "wallet"; };
  typeSel.onchange = walletWarn;
  walletWarn();
  document.getElementById("pm-nickname").value = pm ? pm.nickname : "";
  document.getElementById("pm-last4").value = pm ? pm.last_4 || "" : "";
  fillPmBankOptions_(pmModalState.lastBank);
  document.getElementById("pm-form-error").textContent = "";
  // Delete / Hide only exist for an account that is already saved.
  document.getElementById("pm-manage").hidden = !pm;
  if (pm) document.getElementById("pm-hide-btn").textContent = tr(pmHidden_(pm) ? "accounts.show" : "accounts.hide");
  const backdrop = document.getElementById("pm-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  if (!pm) document.getElementById("pm-nickname").focus();
}

function closePmModal_() {
  document.getElementById("pm-modal-backdrop").hidden = true;
  pmModalState = null;
}

document.getElementById("pm-bank").addEventListener("change", async (e) => {
  if (!pmModalState) return;
  if (e.target.value !== "__add__") { pmModalState.lastBank = e.target.value; return; }
  const name = prompt(tr("accounts.bankPrompt"));
  if (!name || !name.trim()) { e.target.value = pmModalState.lastBank; return; }
  try {
    const bank = await callApi("addBank", { name: name.trim() });
    if (!meta.banks.some((b) => b.id === bank.id)) meta.banks.push(bank);
    pmModalState.lastBank = bank.id;
    fillPmBankOptions_(bank.id);
  } catch (err) {
    document.getElementById("pm-form-error").textContent = err.message;
    e.target.value = pmModalState.lastBank;
  }
});

document.getElementById("pm-last4").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
  if (digits !== e.target.value) e.target.value = digits;
});

document.getElementById("pm-save-btn").addEventListener("click", async () => {
  if (!pmModalState) return;
  const errorEl = document.getElementById("pm-form-error");
  errorEl.textContent = "";
  const nickname = document.getElementById("pm-nickname").value.trim();
  const last4 = document.getElementById("pm-last4").value.trim();
  if (!nickname) { errorEl.textContent = tr("accounts.errName"); return; }
  if (last4 && !/^\d{4}$/.test(last4)) { errorEl.textContent = tr("accounts.errLast4"); return; }
  const saveBtn = document.getElementById("pm-save-btn");
  saveBtn.disabled = true;
  try {
    const saved = await callApi("savePaymentMethod", {
      id: pmModalState.id || undefined,
      nickname,
      type: document.getElementById("pm-type").value,
      bank_id: document.getElementById("pm-bank").value === "__add__" ? "" : document.getElementById("pm-bank").value,
      last_4: last4
    });
    const i = meta.paymentMethods.findIndex((p) => p.id === saved.id);
    if (i >= 0) meta.paymentMethods[i] = { ...meta.paymentMethods[i], ...saved };
    else meta.paymentMethods.push(saved);
    // Rebuild the entry form's pickers without losing what's already chosen there.
    const keep = ["payment_method", "to_payment_method"].map((id) => document.getElementById(id).value);
    populatePaymentMethodOptions();
    populateToPaymentMethodOptions();
    ["payment_method", "to_payment_method"].forEach((id, k) => {
      const sel = document.getElementById(id);
      if (keep[k] && Array.from(sel.options).some((o) => o.value === keep[k])) sel.value = keep[k];
    });
    closePmModal_();
    renderAccountsList_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// After a hide / show / delete the pickers are rebuilt the same way a save does it.
function refreshAccountPickers_() {
  const keep = ["payment_method", "to_payment_method"].map((id) => document.getElementById(id).value);
  populatePaymentMethodOptions();
  populateToPaymentMethodOptions();
  ["payment_method", "to_payment_method"].forEach((id, k) => {
    const sel = document.getElementById(id);
    if (keep[k] && Array.from(sel.options).some((o) => o.value === keep[k])) sel.value = keep[k];
  });
}

document.getElementById("pm-hide-btn").addEventListener("click", async () => {
  if (!pmModalState || !pmModalState.id) return;
  const errorEl = document.getElementById("pm-form-error");
  errorEl.textContent = "";
  const pm = meta.paymentMethods.find((p) => p.id === pmModalState.id);
  if (!pm) return;
  try {
    const res = await callApi("setPaymentMethodHidden", { id: pm.id, hidden: !pmHidden_(pm) });
    pm.hidden = res.hidden;
    refreshAccountPickers_();
    closePmModal_();
    renderAccountsList_();
    renderRailsCard_();
  } catch (err) { errorEl.textContent = err.message; }
});

document.getElementById("pm-delete-btn").addEventListener("click", async () => {
  if (!pmModalState || !pmModalState.id) return;
  const errorEl = document.getElementById("pm-form-error");
  errorEl.textContent = "";
  const pm = meta.paymentMethods.find((p) => p.id === pmModalState.id);
  if (!pm || !confirm(tr("accounts.confirmDelete", { name: pm.nickname }))) return;
  try {
    await callApi("deletePaymentMethod", { id: pm.id });
    meta.paymentMethods = meta.paymentMethods.filter((p) => p.id !== pm.id);
    refreshAccountPickers_();
    closePmModal_();
    renderAccountsList_();
    renderRailsCard_();
  } catch (err) { errorEl.textContent = err.message; }   // in use: the message says so and points to Hide
});

document.getElementById("pm-modal-close").addEventListener("click", closePmModal_);
document.getElementById("pm-cancel-btn").addEventListener("click", closePmModal_);
document.getElementById("pm-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "pm-modal-backdrop") closePmModal_();
});
document.getElementById("more-accounts-btn").addEventListener("click", showAccountsScreen);
document.getElementById("accounts-back-btn").addEventListener("click", () => showScreen("more"));
document.getElementById("accounts-add-btn").addEventListener("click", () => openPmModal_(null));

// ---- More → Categories: create / change / hide / delete a category (top-level only, no sub-categories) ----

// The 8 colors the app has always used, then 8 more pastels — pastel so the emoji stays readable on every tile.
const CAT_SWATCHES_ = ["#F7C6D9", "#C9E4F7", "#FFE0B2", "#D9F2D9", "#E0D9F7", "#FFF3B0", "#F7D9C4", "#D9F7F0",
  "#FFCDD2", "#B3E5FC", "#C8E6C9", "#D1C4E9", "#FFE082", "#B2DFDB", "#F8BBD0", "#CFD8DC"];
// Suggested emojis by theme (strings split on spaces so multi-part emojis stay whole).
const CAT_EMOJI_GROUPS_ = [
  ["food", "🍽️ 🍔 🍕 🍣 🍜 🥗 🍝 🌮 🍞 🥐 🍰 🍦 ☕ 🍺 🍷 🥤 🛒 🥑 🍎 🥩"],
  ["home", "🏠 🛋️ 🛏️ 🔧 💡 🚿 🧹 🧺 📦 👕 👗 👟 👜 🎁 💄 💈 🪴 🔑 📱 💻"],
  ["transport", "🚗 🚕 🚌 🚇 🚲 🛵 ⛽ 🅿️ ✈️ 🧳 🏨 🏖️ ⛴️ 🚆 🗺️ ⛰️ 🚢 🛣️ 🛞 🚦"],
  ["health", "💊 🩺 🏥 🦷 👓 🧘 🏋️ ⚽ 🎾 🏊 🚴 🏃 🥊 ⛳ 🧴 💆 🩹 🏀 🏐 🎿"],
  ["fun", "🎬 🎮 🎵 🎤 🎨 📚 🎟️ 🎉 🎂 🎲 🎸 📷 🧩 🎭 🎳 🎯 🎡 🏕️ 🎣 🍿"],
  ["people", "👨‍👩‍👧 👶 🧒 👵 🐶 🐱 🐾 🐠 🎓 🏫 ✏️ 🎒 💍 👪 🐴 🐦 🐢 🧸 🍼 🤝"],
  ["money", "💰 💵 💳 🏦 📈 📉 🧾 💼 🏢 🧑‍💻 💸 🪙 🧮 📊 🏷️ 🧑‍🔧 🤑 💎 📑 🏧"],
  ["symbols", "⭐ ❤️ 🔥 ✨ 🌟 🔔 ⚡ ☀️ 🌙 🌈 🍀 🌸 🌳 💧 ☂️ 🔒 ⚙️ ❓ ✅ 🎈"]
];

let catModalState = null;   // { id, type, color }

function showCategoriesScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-categories"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.screen === "more"));
  renderCategoriesList_();
}

function renderCategoriesList_() {
  const list = document.getElementById("categories-list");
  list.innerHTML = "";
  ["expense", "income"].forEach((type) => {
    const head = document.createElement("h3");
    head.className = "accounts-group-title";
    head.textContent = tr(`categories.group.${type}`);
    list.appendChild(head);
    sortedCategories_(meta.categories.filter((c) => c.type === type)).forEach((c) => {
      const row = document.createElement("div");
      row.className = "recurring-row" + (catHidden_(c) ? " inactive" : "");
      row.innerHTML = `
        <div class="cat-preview" style="margin:0;">
          <span class="category-tile-icon" style="background:${escapeHtml(c.color || "#eee")};width:40px;height:40px;font-size:1.2rem;">${escapeHtml(c.icon || "•")}</span>
          <div>
            <div class="recurring-row-name">${escapeHtml(c.name)}</div>
            ${catHidden_(c) ? `<div class="recurring-row-sub">${escapeHtml(tr("categories.hiddenTag"))}</div>` : ""}
          </div>
        </div>`;
      row.addEventListener("click", () => openCatModal_(c));
      list.appendChild(row);
    });
  });
}

function updateCatPreview_() {
  const icon = document.getElementById("cat-emoji").value.trim() || "🏷️";
  const iconEl = document.getElementById("cat-preview-icon");
  iconEl.textContent = icon;
  iconEl.style.background = catModalState.color;
  document.getElementById("cat-preview-name").textContent = document.getElementById("cat-name").value.trim();
  document.querySelectorAll("#cat-emoji-groups .cat-emoji-btn").forEach((b) => b.classList.toggle("selected", b.textContent === icon));
  document.querySelectorAll("#cat-swatches .cat-swatch").forEach((b) => b.classList.toggle("selected", b.dataset.color === catModalState.color));
}

function buildCatPickers_() {
  const groups = document.getElementById("cat-emoji-groups");
  if (!groups.childElementCount) {
    CAT_EMOJI_GROUPS_.forEach(([key, emojis]) => {
      const title = document.createElement("div");
      title.className = "cat-emoji-group-title";
      title.textContent = tr(`categories.emojiGroup.${key}`);
      groups.appendChild(title);
      const row = document.createElement("div");
      row.className = "cat-emoji-row";
      emojis.split(" ").forEach((e) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cat-emoji-btn";
        b.textContent = e;
        b.addEventListener("click", () => { document.getElementById("cat-emoji").value = e; updateCatPreview_(); });
        row.appendChild(b);
      });
      groups.appendChild(row);
    });
  }
  const sw = document.getElementById("cat-swatches");
  if (!sw.childElementCount) {
    CAT_SWATCHES_.forEach((color, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cat-swatch";
      b.dataset.color = color;
      b.style.background = color;
      b.setAttribute("aria-label", tr("categories.colorLabel", { n: i + 1 }));
      b.addEventListener("click", () => { catModalState.color = color; updateCatPreview_(); });
      sw.appendChild(b);
    });
  }
}

function openCatModal_(cat) {
  // The pickers' titles are translated when first built; rebuild if the language changed since.
  const lang = I18n.getLang();
  if (document.getElementById("cat-emoji-groups").dataset.lang !== lang) {
    document.getElementById("cat-emoji-groups").innerHTML = "";
    document.getElementById("cat-emoji-groups").dataset.lang = lang;
  }
  buildCatPickers_();
  const used = new Set(meta.categories.map((c) => c.color));
  const unusedColor = CAT_SWATCHES_.find((c) => !used.has(c)) || CAT_SWATCHES_[meta.categories.length % CAT_SWATCHES_.length];
  catModalState = { id: cat ? cat.id : null, type: cat ? cat.type : "expense", color: cat ? (cat.color || unusedColor) : unusedColor };
  document.getElementById("cat-modal-title").textContent = tr(cat ? "categories.editTitle" : "categories.addTitle");
  // The type is chosen once, when the category is created; entries of one type only use categories of that type.
  document.getElementById("cat-type-field").hidden = !!cat;
  document.querySelectorAll("#cat-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === catModalState.type));
  document.getElementById("cat-name").value = cat ? cat.name : "";
  document.getElementById("cat-emoji").value = cat ? (cat.icon || "") : "";
  document.getElementById("cat-form-error").textContent = "";
  const manageable = !!cat && cat.key !== "other";
  document.getElementById("cat-manage").hidden = !manageable;
  if (manageable) document.getElementById("cat-hide-btn").textContent = tr(catHidden_(cat) ? "categories.show" : "categories.hide");
  updateCatPreview_();
  const backdrop = document.getElementById("cat-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  if (!cat) document.getElementById("cat-name").focus();
}

function closeCatModal_() {
  document.getElementById("cat-modal-backdrop").hidden = true;
  catModalState = null;
}

// Reloads the lists (every picker follows) and redraws this screen.
async function refreshCategoriesAfterChange_() {
  await loadMeta();
  renderCategoriesList_();
}

document.querySelectorAll("#cat-type-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (!catModalState) return;
    catModalState.type = tab.dataset.type;
    document.querySelectorAll("#cat-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
  });
});
document.getElementById("cat-name").addEventListener("input", () => catModalState && updateCatPreview_());
document.getElementById("cat-emoji").addEventListener("input", () => catModalState && updateCatPreview_());

document.getElementById("cat-save-btn").addEventListener("click", async () => {
  if (!catModalState) return;
  const errorEl = document.getElementById("cat-form-error");
  errorEl.textContent = "";
  const btn = document.getElementById("cat-save-btn");
  btn.disabled = true;
  try {
    await callApi("saveCategory", {
      id: catModalState.id || undefined,
      type: catModalState.type,
      name: document.getElementById("cat-name").value,
      icon: document.getElementById("cat-emoji").value.trim(),
      color: catModalState.color
    });
    closeCatModal_();
    await refreshCategoriesAfterChange_();
  } catch (err) { errorEl.textContent = err.message; }
  finally { btn.disabled = false; }
});

document.getElementById("cat-hide-btn").addEventListener("click", async () => {
  if (!catModalState || !catModalState.id) return;
  const errorEl = document.getElementById("cat-form-error");
  errorEl.textContent = "";
  const cat = meta.categories.find((c) => c.id === catModalState.id);
  if (!cat) return;
  try {
    await callApi("setCategoryHidden", { id: cat.id, hidden: !catHidden_(cat) });
    closeCatModal_();
    await refreshCategoriesAfterChange_();
  } catch (err) { errorEl.textContent = err.message; }
});

document.getElementById("cat-delete-btn").addEventListener("click", async () => {
  if (!catModalState || !catModalState.id) return;
  const errorEl = document.getElementById("cat-form-error");
  errorEl.textContent = "";
  const cat = meta.categories.find((c) => c.id === catModalState.id);
  if (!cat || !confirm(tr("categories.confirmDelete", { name: cat.name }))) return;
  try {
    await callApi("deleteCategory", { id: cat.id });
    closeCatModal_();
    await refreshCategoriesAfterChange_();
  } catch (err) { errorEl.textContent = err.message; }   // in use: the message says so and points to Hide
});

document.getElementById("cat-modal-close").addEventListener("click", closeCatModal_);
document.getElementById("cat-cancel-btn").addEventListener("click", closeCatModal_);
document.getElementById("cat-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "cat-modal-backdrop") closeCatModal_();
});
document.getElementById("more-categories-btn").addEventListener("click", showCategoriesScreen);
document.getElementById("categories-back-btn").addEventListener("click", () => showScreen("more"));
document.getElementById("categories-add-btn").addEventListener("click", () => openCatModal_(null));

// ---- Trips & events (More → Trips & events; see specs/trips-events.md) ----
// A trip or event is a named period that expenses can be linked to (one per
// expense), so its whole cost — including tickets paid months before — shows in
// one place. Only a lens: the expense keeps its own date, category and budgets.

function tripEmoji_(trip) {
  return trip.emoji || (trip.kind === "event" ? "🎉" : "✈️");
}

function tripLabel_(trip) {
  return `${tripEmoji_(trip)} ${trip.name}`;
}

// The small label on an entry row. A trip that no longer exists is skipped.
function tripPillHtml_(entry) {
  if (!entry.trip_id) return "";
  const trip = (meta.trips || []).find((t) => t.id === entry.trip_id);
  return trip ? `<span class="entry-tag entry-trip">${escapeHtml(tripLabel_(trip))}</span>` : "";
}

// The entry form's picker. Keeps whatever is chosen when it is rebuilt (a
// refresh while an edit is open must not change the pick).
function populateTripOptions_() {
  const sel = document.getElementById("entry-trip");
  fillTripOptions_(sel, sel.value);
  document.getElementById("trip-field").hidden = selectedType !== "expense" || !(meta.trips || []).length;
}

// Fills any trip/event <select> (the entry form's, the Programmed pop-up's) and keeps `keep` chosen.
function fillTripOptions_(sel, keep) {
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = tr("trips.none");
  sel.appendChild(none);
  const today = todayLocalISO();
  // Current and upcoming first (soonest first), then past ones (latest first).
  const trips = (meta.trips || []).slice();
  const open = trips.filter((t) => t.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = trips.filter((t) => t.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  open.concat(past).forEach((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = tripLabel_(t);
    sel.appendChild(o);
  });
  sel.value = keep || "";
  if (sel.value !== (keep || "")) sel.value = "";
}

// <option> HTML for a review card's trip picker, `selected` pre-chosen (same order as the entry form's).
function reviewTripOptions_(selected) {
  const holder = document.createElement("select");
  fillTripOptions_(holder, selected);
  // innerHTML carries only attributes, not the select's current value: mark the chosen option.
  Array.from(holder.options).forEach((o) => { if (o.value === holder.value && o.value) o.setAttribute("selected", ""); });
  return holder.innerHTML;
}

// The entry form pre-selects the trip/event whose dates include the entry's date — only when exactly
// one does, never over a choice the person made, and it follows the date until they choose.
let tripAutoPickedId_ = "";
let tripPickLocked_ = false;   // the person chose by hand (even "None"): leave it alone until the next entry
function autoPickTripForDate_() {
  if (selectedType !== "expense" || !entryFormIsNewEntry_() || tripPickLocked_) return;
  const sel = document.getElementById("entry-trip");
  const date = document.getElementById("date").value;
  const covering = (meta.trips || []).filter((t) => date >= t.start_date && date <= t.end_date);
  const target = covering.length === 1 ? covering[0].id : "";
  const followingAuto = tripAutoPickedId_ && sel.value === tripAutoPickedId_;
  if (sel.value === "" || followingAuto) {
    sel.value = target;
    tripAutoPickedId_ = target;
  }
}

document.getElementById("entry-trip").addEventListener("change", () => { tripAutoPickedId_ = ""; tripPickLocked_ = true; });
document.getElementById("date").addEventListener("input", autoPickTripForDate_);
document.getElementById("date").addEventListener("change", autoPickTripForDate_);

function setTripPick_(tripId) {
  const sel = document.getElementById("entry-trip");
  sel.value = tripId || "";
  if (sel.value !== (tripId || "")) sel.value = "";
}

let tripDetailId_ = null;
let editingTripId_ = null;
let tripKind_ = "trip";

// "Happening now", "Upcoming" and "Past" are decided by today's date.
function tripGroupOf_(trip, today) {
  if (trip.end_date < today) return "past";
  if (trip.start_date > today) return "upcoming";
  return "active";
}

function tripDatesText_(trip) {
  return trip.start_date === trip.end_date
    ? trip.start_date
    : tr("trips.dateRange", { start: trip.start_date, end: trip.end_date });
}

async function showTripsScreen() {
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-trips"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.screen === "more"));
  await refreshTripsList_();
}

// Reloads the list (with running totals) and keeps the form's picker in step.
async function refreshTripsList_() {
  const errorEl = document.getElementById("trips-error");
  errorEl.textContent = "";
  try {
    const trips = await callApi("listTrips", {});
    meta.trips = trips;
    populateTripOptions_();
    renderTripsList_(trips);
  } catch (err) {
    errorEl.textContent = tr("trips.loadFailed", { error: err.message });
  }
}

function renderTripsList_(trips) {
  const list = document.getElementById("trips-list");
  list.innerHTML = "";
  document.getElementById("trips-empty-note").hidden = trips.length > 0;
  const today = todayLocalISO();
  const groups = { active: [], upcoming: [], past: [] };
  trips.forEach((t) => groups[tripGroupOf_(t, today)].push(t));
  groups.active.sort((a, b) => a.end_date.localeCompare(b.end_date));
  groups.upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
  groups.past.sort((a, b) => b.end_date.localeCompare(a.end_date));
  ["active", "upcoming", "past"].forEach((g) => groups[g].forEach((t, i) => {
    if (i === 0) {
      const head = document.createElement("h3");
      head.className = "accounts-group-title";
      head.textContent = tr(`trips.group.${g}`);
      list.appendChild(head);
    }
    const row = document.createElement("div");
    row.className = "recurring-row";
    const sub = [tr(`trips.kind.${t.kind === "event" ? "event" : "trip"}`), tripDatesText_(t), tr("trips.entryCount", { n: t.entryCount || 0 }),
      t.estimateCount ? tr("trips.estimateCount", { n: t.estimateCount }) : ""].filter(Boolean).join(" · ");
    const budget = Number(t.budget_amount) > 0
      ? `<span class="original-amt">${escapeHtml(tr("trips.ofBudget", { cur: t.cur || homeCur(), amount: moneyFmt(t.budget_amount) }))}</span>`
      : "";
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${escapeHtml(tripLabel_(t))}</div>
        <div class="recurring-row-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="recurring-row-amount"><span class="primary-amt">${t.estimatedMain > 0.004 ? "≈ " : ""}${t.cur || homeCur()} ${moneyFmt(t.spentMain || 0)}</span>${budget}</div>
    `;
    row.addEventListener("click", () => showTripDetail_(t.id));
    list.appendChild(row);
  }));
}

async function showTripDetail_(id) {
  tripDetailId_ = id;
  document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-trip-detail"; });
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.screen === "more"));
  window.scrollTo(0, 0);
  const known = (meta.trips || []).find((t) => t.id === id);
  document.getElementById("trip-detail-title").textContent = known ? tripLabel_(known) : "";
  document.getElementById("trip-detail-sub").textContent = known ? `${tr(`trips.kind.${known.kind === "event" ? "event" : "trip"}`)} · ${tripDatesText_(known)}` : "";
  document.getElementById("trip-detail-body").innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  document.getElementById("trip-detail-entries-card").hidden = true;
  document.getElementById("trip-find-box").hidden = true;
  await refreshTripDetail_();
}

// Waits (a few seconds at most) for an edit that is still saving in the
// background, so the totals fetched next include it.
async function waitForEntryEditsToSave_() {
  for (let i = 0; i < 40 && entryEditFlushing_.size > 0; i++) await sleep(300);
}

async function refreshTripDetail_() {
  const id = tripDetailId_;
  if (!id) return;
  const errorEl = document.getElementById("trip-detail-error");
  errorEl.textContent = "";
  try {
    await waitForEntryEditsToSave_();
    const [detail, entries] = await Promise.all([
      callApi("getTripDetail", { id }),
      callApi("listEntries", { tripId: id })
    ]);
    if (tripDetailId_ !== id) return;   // moved on while loading
    renderTripDetail_(detail);
    // Overlay edits still waiting to be saved, and drop any entry just moved to another trip.
    const shown = applyQueuedEditOverlay_(entries).filter((e) => e.trip_id === id);
    document.getElementById("trip-detail-entries-card").hidden = false;
    renderEntriesInto_(document.getElementById("trip-detail-entries"), shown, "trips.noEntries");
  } catch (err) {
    document.getElementById("trip-detail-body").innerHTML = "";
    errorEl.textContent = tr("trips.loadFailed", { error: err.message });
  }
}

function renderTripDetail_(d) {
  const t = d.trip;
  document.getElementById("trip-detail-title").textContent = tripLabel_(t);
  document.getElementById("trip-detail-sub").textContent = `${tr(`trips.kind.${t.kind === "event" ? "event" : "trip"}`)} · ${tripDatesText_(t)}`;

  // Every figure on this screen is in the TRIP's own currency (chosen per trip), not necessarily the app's main one.
  const cur = d.currency || homeCur();
  let budgetHtml = "";
  if (Number(t.budget_amount) > 0) {
    if (d.budgetSpent == null) {
      budgetHtml = `<p class="hint">${escapeHtml(tr("trips.budgetNoRate", { cur }))}</p>`;
    } else {
      const budget = Number(t.budget_amount);
      const pct = Math.min(100, (d.budgetSpent / budget) * 100);
      const over = d.budgetSpent > budget;
      const cls = over ? " over" : (d.budgetSpent / budget >= 0.8 ? " warn" : "");
      const text = over
        ? tr("trips.budgetOver", { cur, amount: moneyFmt(d.budgetSpent - budget) })
        : tr("trips.budgetLeft", { cur, amount: moneyFmt(budget - d.budgetSpent) });
      budgetHtml = `
        <div class="budget-progress-track"><div class="budget-progress-fill${cls}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="budget-row-sub"><span>${escapeHtml(text)}</span><span>${escapeHtml(tr("trips.ofBudget", { cur, amount: moneyFmt(budget) }))}</span></div>`;
    }
  }

  const phase = (key, value) => `
    <div class="trip-phase"><div class="trip-phase-label">${escapeHtml(tr(key))}</div><div class="trip-phase-value">${cur} ${moneyFmt(value)}</div></div>`;
  const cats = d.byCategory.map((c) => `
    <div class="recurring-row trip-static-row">
      <div class="recurring-row-name">${c.icon ? escapeHtml(c.icon) + " " : ""}${escapeHtml(c.name)}</div>
      <div class="recurring-row-amount">${cur} ${moneyFmt(c.amount_pen)} <span class="original-amt">${Math.round(c.percent)}%</span></div>
    </div>`).join("");
  const days = d.byDay.map((x) => `
    <div class="recurring-row trip-static-row">
      <div class="recurring-row-name">${escapeHtml(x.date)}</div>
      <div class="recurring-row-amount">${cur} ${moneyFmt(x.amount_main)}</div>
    </div>`).join("");

  document.getElementById("trip-detail-body").innerHTML = `
    <div class="trip-total">${cur} ${moneyFmt(d.totalMain)}</div>
    <p class="hint" style="margin-top:2px;">${escapeHtml(tr("trips.total"))} · ${escapeHtml(tr("trips.entryCount", { n: d.entryCount }))}</p>
    ${d.estimatedMain > 0.004 ? `<p class="hint" style="margin-top:0;">${escapeHtml(tr("trips.paidEstimated", { cur, paid: moneyFmt(d.totalMain - d.estimatedMain), est: moneyFmt(d.estimatedMain) }))}</p>` : ""}
    ${budgetHtml}
    <div class="trip-phases">${phase("trips.before", d.before)}${phase("trips.during", d.during)}${phase("trips.after", d.after)}</div>
    <p class="hint">${escapeHtml(tr("trips.phaseHint"))}</p>
    ${d.missingRate > 0 ? `<p class="hint">${escapeHtml(tr("trips.missingRate", { n: d.missingRate }))}</p>` : ""}
    <div id="trip-detail-missing-rates"></div>
    ${cats ? `<h3 class="accounts-group-title">${escapeHtml(tr("trips.byCategory"))}</h3>${cats}` : ""}
    ${days ? `<h3 class="accounts-group-title">${escapeHtml(tr("trips.byDay"))}</h3>${days}` : ""}
    <div id="trip-detail-unlinked"></div>
    <div id="trip-detail-estimates"></div>
  `;
  renderTripUnlinked_(d);
  renderTripEstimates_(d);
  renderTripMissingRates_(d);
}

// Expenses that can't be converted yet: one "Set the rate" button per currency (at its earliest month, which
// also covers every later one). The rate pop-up opens by itself once per trip per visit to the app; cancelling
// it leaves the buttons here. After a rate is saved the trip is recalculated, and any rate still missing follows.
const tripRatePrompted_ = {};
function renderTripMissingRates_(d) {
  const box = document.getElementById("trip-detail-missing-rates");
  if (!box || !d.missingRates || !d.missingRates.length) return;
  d.missingRates.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-inline";
    btn.textContent = tr("trips.setRateRow", { currency: m.currency, month: m.month, n: m.count });
    btn.addEventListener("click", () => setTripDetailRate_(d.trip.id, m));
    box.appendChild(btn);
  });
  if (!tripRatePrompted_[d.trip.id]) {
    tripRatePrompted_[d.trip.id] = true;
    setTripDetailRate_(d.trip.id, d.missingRates[0]);
  }
}

async function setTripDetailRate_(tripId, m) {
  const rate = await openRateModal(m.currency, m.month, /* required */ false);
  if (rate == null || tripDetailId_ !== tripId) return;
  tripRatePrompted_[tripId] = false;   // ask again if another rate turns out to be missing
  await refreshTripDetail_();
}

// Payments that settled an estimate but are not part of the trip: one tap adds each (never automatic).
function renderTripUnlinked_(d) {
  const box = document.getElementById("trip-detail-unlinked");
  if (!d.unlinkedPayments || !d.unlinkedPayments.length) return;
  box.innerHTML = `<h3 class="accounts-group-title">${escapeHtml(tr("trips.unlinkedTitle"))}</h3><p class="hint">${escapeHtml(tr("trips.unlinkedHint"))}</p>`;
  d.unlinkedPayments.forEach((u) => {
    const row = document.createElement("div");
    row.className = "recurring-row trip-static-row";
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${escapeHtml(u.entry.description || u.item_description || "")}</div>
        <div class="recurring-row-sub">${escapeHtml(u.entry.date)} · ${escapeHtml(formatAmount(u.entry.amount, u.entry.currency))}</div>
      </div>
      <button type="button" class="add-inline">${escapeHtml(tr("trips.addToTrip"))}</button>`;
    row.querySelector("button").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await callApi("updateEntry", { id: u.entry.id, fields: { trip_id: d.trip.id } });
        await refreshTripDetail_();
      } catch (err) {
        document.getElementById("trip-detail-error").textContent = tr("trips.loadFailed", { error: err.message });
        ev.target.disabled = false;
      }
    });
    box.appendChild(row);
  });
}

// The estimates still waiting (unpaid one-time Programmed items in this trip). Tap one to change or delete it.
function renderTripEstimates_(d) {
  const box = document.getElementById("trip-detail-estimates");
  if (!d.estimates || !d.estimates.length) return;
  box.innerHTML = `<h3 class="accounts-group-title">${escapeHtml(tr("trips.estimates"))}</h3><p class="hint">${escapeHtml(tr("trips.estimatesHint"))}</p>`;
  d.estimates.forEach((e) => {
    const row = document.createElement("div");
    row.className = "recurring-row";
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${e.category_icon ? escapeHtml(e.category_icon) + " " : ""}${escapeHtml(e.description || e.category_name)}</div>
        <div class="recurring-row-sub">${escapeHtml(e.date)}${e.overdue ? " · " + escapeHtml(tr("trips.estimateOverdue")) : ""}</div>
      </div>
      <div class="recurring-row-amount">≈ ${escapeHtml(formatAmount(e.amount, e.currency))}<button type="button" class="add-inline trip-covered-btn">${escapeHtml(tr("trips.covered"))}</button></div>`;
    // "Covered": a real expense has replaced this estimate, so the estimate is deleted.
    row.querySelector(".trip-covered-btn").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(tr("trips.confirmCovered", { what: describeForConfirm_(e.description || e.category_name, formatAmount(e.amount, e.currency)) }))) return;
      ev.target.disabled = true;
      try {
        await callApi("deleteRecurringExpense", { id: e.id });
        await refreshTripDetail_();
      } catch (err) {
        document.getElementById("trip-detail-error").textContent = tr("trips.loadFailed", { error: err.message });
        ev.target.disabled = false;
      }
    });
    row.addEventListener("click", async () => {
      try {
        const items = await callApi("listRecurringExpenses");
        const item = items.find((x) => x.id === e.id);
        if (item) openRecurringModal(item);
      } catch (err) {
        document.getElementById("trip-detail-error").textContent = tr("trips.loadFailed", { error: err.message });
      }
    });
    box.appendChild(row);
  });
}

function openTripModal_(trip) {
  editingTripId_ = trip ? trip.id : null;
  tripKind_ = trip && trip.kind === "event" ? "event" : "trip";
  document.querySelectorAll("#trip-kind-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.kind === tripKind_));
  document.getElementById("trip-modal-title").textContent = tr(trip ? "trips.editTitle" : "trips.addTitle");
  document.getElementById("trip-form-error").textContent = "";
  document.getElementById("trip-name").value = trip ? trip.name : "";
  document.getElementById("trip-emoji").value = trip ? (trip.emoji || "") : "";
  document.getElementById("trip-start").value = trip ? trip.start_date : todayLocalISO();
  document.getElementById("trip-end").value = trip ? trip.end_date : todayLocalISO();
  document.getElementById("trip-budget").value = trip && Number(trip.budget_amount) > 0 ? trip.budget_amount : "";
  document.getElementById("trip-currency").value = trip ? (trip.currency || trip.budget_currency || homeCur()) : homeCur();
  document.getElementById("trip-alerts").value = trip && trip.alert_thresholds ? trip.alert_thresholds.split(",").join(", ") : "";
  renderCurrencyChips("trip");
  refreshTripRateWarning_(false);
  document.getElementById("trip-delete-btn").hidden = !trip;
  const backdrop = document.getElementById("trip-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

// A trip in a currency other than the app's main one converts everything else through the exchange rates, so
// it needs a rate for that currency. When one is missing the form says so (with a "Set one" link) and — only
// right after the person CHOOSES the currency (promptIfMissing) — opens the rate pop-up straight away, which
// they may cancel. The month checked is the trip's start month: a rate on or before it covers every later month.
async function refreshTripRateWarning_(promptIfMissing) {
  const warning = document.getElementById("trip-rate-warning");
  const currency = document.getElementById("trip-currency").value;
  if (currency === homeCur()) { warning.hidden = true; return; }
  const month = (document.getElementById("trip-start").value || todayLocalISO()).slice(0, 7);
  let hasRate;
  try {
    const { rate } = await callApi("getLatestRateOnOrBefore", { currency, month });
    hasRate = rate != null;
  } catch (err) {
    hasRate = true;   // don't nag over a network hiccup
  }
  if (document.getElementById("trip-currency").value !== currency) return;   // changed again while checking
  warning.hidden = hasRate;
  if (hasRate) return;
  document.getElementById("trip-rate-warning-text").textContent = tr("trips.noRate", { currency });
  if (promptIfMissing) await setTripCurrencyRate_(currency, month);
}

async function setTripCurrencyRate_(currency, month) {
  const rate = await openRateModal(currency, month, /* required */ false);
  if (rate != null) refreshTripRateWarning_(false);
}

document.getElementById("trip-rate-warning-link").addEventListener("click", () => {
  const currency = document.getElementById("trip-currency").value;
  const month = (document.getElementById("trip-start").value || todayLocalISO()).slice(0, 7);
  setTripCurrencyRate_(currency, month);
});
// A different start date can move the month that needs a rate.
document.getElementById("trip-start").addEventListener("change", () => refreshTripRateWarning_(false));

function closeTripModal_() {
  document.getElementById("trip-modal-backdrop").hidden = true;
  editingTripId_ = null;
}

// "Find expenses in these dates": lists the trip-less expenses inside the trip's dates, all ticked;
// only the ones still ticked when "Add selected" is tapped are linked.
document.getElementById("trip-find-btn").addEventListener("click", () => {
  const box = document.getElementById("trip-find-box");
  if (!tripDetailId_) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  loadTripFinder_(false);
});

// lookBack: also include the 12 months before the trip starts (offered by a button inside the box).
async function loadTripFinder_(lookBack) {
  const id = tripDetailId_;
  const box = document.getElementById("trip-find-box");
  box.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  const earlierBtn = () => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-inline";
    btn.textContent = tr("trips.findEarlier");
    btn.addEventListener("click", () => loadTripFinder_(true));
    return btn;
  };
  try {
    const found = await callApi("findTripCandidates", { id, lookBack: lookBack ? 12 : 0 });
    if (tripDetailId_ !== id) return;
    if (!found.entries.length) {
      box.innerHTML = `<p class="hint">${escapeHtml(tr("trips.findNone"))}</p>`;
      if (!lookBack) box.appendChild(earlierBtn());
      return;
    }
    // Expenses from BEFORE the trip start come unticked: most of them are everyday spending, not the trip.
    const tripStart = ((meta.trips || []).find((t) => t.id === id) || {}).start_date || "";
    box.innerHTML = `<p class="hint">${escapeHtml(tr(lookBack ? "trips.findEarlierHint" : "trips.findHint"))}</p>`;
    if (!lookBack) box.appendChild(earlierBtn());
    const rows = [];
    found.entries.forEach((e) => {
      const row = document.createElement("label");
      row.className = "recurring-row trip-find-row";
      row.innerHTML = `
        <input type="checkbox"${e.date < tripStart ? "" : " checked"}>
        <div class="trip-find-text">
          <div class="recurring-row-name">${e.category_icon ? escapeHtml(e.category_icon) + " " : ""}${escapeHtml(e.description || e.category_name)}</div>
          <div class="recurring-row-sub">${escapeHtml(e.date)}${e.category_name && e.description ? " · " + escapeHtml(e.category_name) : ""}</div>
        </div>
        <div class="recurring-row-amount">${escapeHtml(formatAmount(e.own_share, e.currency))}</div>`;
      rows.push({ e, input: row.querySelector("input") });
      box.appendChild(row);
    });
    if (found.total > found.entries.length) {
      const more = document.createElement("p");
      more.className = "hint";
      more.textContent = tr("trips.findMore", { n: found.entries.length, total: found.total });
      box.appendChild(more);
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "primary";
    const refreshLabel = () => {
      const n = rows.filter((r) => r.input.checked).length;
      addBtn.textContent = tr("trips.findAdd", { n });
      addBtn.disabled = n === 0;
    };
    rows.forEach((r) => r.input.addEventListener("change", refreshLabel));
    refreshLabel();
    addBtn.addEventListener("click", async () => {
      addBtn.disabled = true;
      try {
        await callApi("linkEntriesToTrip", { id, entryIds: rows.filter((r) => r.input.checked).map((r) => r.e.id) });
        box.hidden = true;
        await refreshTripDetail_();
      } catch (err) {
        document.getElementById("trip-detail-error").textContent = tr("trips.loadFailed", { error: err.message });
        addBtn.disabled = false;
      }
    });
    box.appendChild(addBtn);
  } catch (err) {
    box.innerHTML = `<p class="hint" style="color:#d64545;">${escapeHtml(tr("trips.loadFailed", { error: err.message }))}</p>`;
  }
}

document.getElementById("more-trips-btn").addEventListener("click", showTripsScreen);
document.getElementById("trips-back-btn").addEventListener("click", () => showScreen("more"));
document.getElementById("trips-add-btn").addEventListener("click", () => openTripModal_(null));
document.getElementById("trip-detail-back-btn").addEventListener("click", () => { tripDetailId_ = null; showTripsScreen(); });
document.getElementById("trip-detail-edit-btn").addEventListener("click", () => {
  const trip = (meta.trips || []).find((t) => t.id === tripDetailId_);
  if (trip) openTripModal_(trip);
});
document.getElementById("trip-modal-close").addEventListener("click", closeTripModal_);
document.getElementById("trip-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "trip-modal-backdrop") closeTripModal_();
});
document.querySelectorAll("#trip-kind-tabs .type-tab").forEach((tab) => tab.addEventListener("click", () => {
  tripKind_ = tab.dataset.kind;
  document.querySelectorAll("#trip-kind-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
}));
document.getElementById("trip-budget").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
});

document.getElementById("trip-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("trip-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("trip-save-btn");
  saveBtn.disabled = true;
  try {
    const budget = document.getElementById("trip-budget").value.trim();
    const fields = {
      name: document.getElementById("trip-name").value.trim(),
      kind: tripKind_,
      emoji: document.getElementById("trip-emoji").value.trim(),
      start_date: document.getElementById("trip-start").value,
      end_date: document.getElementById("trip-end").value,
      budget_amount: budget,
      currency: document.getElementById("trip-currency").value,
      budget_currency: budget ? document.getElementById("trip-currency").value : "",
      alert_thresholds: budget ? document.getElementById("trip-alerts").value.trim() : ""
    };
    // The server checks everything and answers in the person's language.
    if (editingTripId_) await callApi("updateTrip", Object.assign({ id: editingTripId_ }, fields));
    else await callApi("addTrip", fields);
    closeTripModal_();
    await refreshTripsList_();
    if (!document.getElementById("screen-trip-detail").hidden) await refreshTripDetail_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("trip-delete-btn").addEventListener("click", async () => {
  if (!editingTripId_) return;
  const trip = (meta.trips || []).find((t) => t.id === editingTripId_);
  if (!trip || !confirm(tr("trips.confirmDelete", { name: trip.name }))) return;
  const errorEl = document.getElementById("trip-form-error");
  try {
    await callApi("deleteTrip", { id: trip.id });
    closeTripModal_();
    tripDetailId_ = null;
    await showTripsScreen();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---- Recurring income/expenses ----

let editingRecurringId = null;
let recurringFrequency = "monthly";
let selectedRecurringCategoryId = null;

// Split state for the Programmed item modal — same shape as the entry
// form's own splitFriendIds/splitMode/customSplitAmounts, kept as a
// separate set of variables (and separate #recurring-split-* elements)
// since both modals' DOM never overlaps but their state must not either.
let recurringSplitFriendIds = new Set();
let recurringSplitMode = "equal";
let recurringCustomSplitAmounts = {};

function recurringFreqLabel_(re) {
  if (re.frequency === "once") {
    const d = new Date(re.date + "T00:00:00");
    return I18n.fmtDateMedium(d);
  }
  if (re.frequency === "yearly") return tr("recurring.freqYearly", { month: I18n.monthShort(re.month - 1), day: re.day });
  if (re.frequency === "custom") {
    // "Every 2 weeks, from 5 Oct 2026"
    const every = tr("recurring.every." + re.interval_unit, { n: re.interval });
    return every + tr("recurring.fromDate", { date: I18n.fmtDateMedium(new Date(re.start_date + "T00:00:00")) });
  }
  return tr("recurring.freqMonthly", { day: re.day });
}

// Same "big = my share, small/grey = total" treatment a split real
// expense gets (see CLAUDE.md) — split_total (from listRecurringExpenses)
// is 0 for the common unsplit case, so this collapses to the plain single
// line then.
function renderRecurringAmountHtml_(re) {
  const isIncome = re.category_type === "income";
  const hasSplit = re.split_total > 0.005;
  const ownAmount = hasSplit ? re.amount - re.split_total : re.amount;
  // "≈": a variable-amount item shows its current estimate, not a fixed price.
  const primary = `<span class="primary-amt">${isIncome ? "+" : ""}${re.variable ? "≈ " : ""}${formatAmount(ownAmount, re.currency)}</span>`;
  if (!hasSplit) return primary;
  return `${primary}<span class="original-amt">${tr("common.total")} ${formatAmount(re.amount, re.currency)}</span>`;
}

// Today as YYYY-MM-DD in the phone's own time zone (end dates are plain dates).
function localTodayISO_() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// A monthly/yearly item that no longer applies: paused, or its end date has
// passed (an end date of today still counts as running today). One-time items
// are never "past" here — a one-time item whose date went by may still be
// unpaid, so it stays visible. See specs/recurring.md.
function recurringIsPast_(re, todayISO) {
  if (re.frequency === "once") return false;
  return !re.active || (!!re.end_date && re.end_date < todayISO);
}

function recurringDateLabel_(iso) {
  return I18n.fmtDateMedium(new Date(iso + "T00:00:00"));
}

// " · Paused", " · Ended 30 Sep 2026" or " · Ends 30 Nov 2026" (still running).
function recurringStatusLabel_(re, todayISO) {
  if (re.frequency === "once") return "";
  if (!re.active) return tr("recurring.paused");
  if (!re.end_date) return "";
  return re.end_date < todayISO ? tr("recurring.ended", { date: recurringDateLabel_(re.end_date) }) : tr("recurring.ends", { date: recurringDateLabel_(re.end_date) });
}

function recurringTripTag_(re) {
  const trip = re.trip_id ? (meta.trips || []).find((t) => t.id === re.trip_id) : null;
  return trip ? escapeHtml(tr("recurring.tripTag", { trip: tripLabel_(trip) })) : "";
}

function renderRecurringRow_(re) {
  const isIncome = re.category_type === "income";
  const todayISO = localTodayISO_();
  const row = document.createElement("div");
  row.className = "recurring-row" + (recurringIsPast_(re, todayISO) || !re.active ? " inactive" : "");
  row.innerHTML = `
    <div>
      <div class="recurring-row-name">${re.category_icon ? re.category_icon + " " : ""}${escapeHtml(re.description || re.category_name)}</div>
      <div class="recurring-row-sub">${escapeHtml(re.category_name)} · ${recurringFreqLabel_(re)}${re.variable ? tr("recurring.variableTag") : ""}${recurringStatusLabel_(re, todayISO)}${re.split_total > 0.005 ? tr("recurring.splitTag") : ""}${recurringTripTag_(re)}</div>
    </div>
    <div class="recurring-row-amount${isIncome ? " income" : ""}">${isIncome ? sensitiveHtml_(renderRecurringAmountHtml_(re)) : renderRecurringAmountHtml_(re)}</div>
  `;
  row.addEventListener("click", () => openRecurringModal(re));
  return row;
}

// The past (ended / paused) recurring items sit behind a button, closed until
// asked for. Stays open while the owner edits one, closes on leaving the app.
let showPastRecurring = false;

function renderRecurringPastToggle_(count) {
  const btn = document.getElementById("recurring-past-toggle");
  const section = document.getElementById("recurring-past-section");
  btn.hidden = count === 0;
  if (count === 0) showPastRecurring = false;
  section.hidden = !showPastRecurring;
  btn.textContent = showPastRecurring
    ? tr("recurring.hidePast", { n: count })
    : tr("recurring.showPast", { n: count });
}

document.getElementById("recurring-past-toggle").addEventListener("click", () => {
  showPastRecurring = !showPastRecurring;
  const count = document.getElementById("recurring-past-list").children.length;
  renderRecurringPastToggle_(count);
});

async function refreshRecurringExpenses() {
  const list = document.getElementById("recurring-list");
  const emptyNote = document.getElementById("recurring-empty-note");
  const onetimeList = document.getElementById("recurring-onetime-list");
  const onetimeEmptyNote = document.getElementById("recurring-onetime-empty-note");
  list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  onetimeList.innerHTML = "";
  let items;
  try {
    items = await callApi("listRecurringExpenses");
  } catch (err) {
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
    return;
  }

  const todayISO = localTodayISO_();
  const allRecurring = items.filter((re) => re.frequency !== "once");
  const recurring = allRecurring.filter((re) => !recurringIsPast_(re, todayISO));
  // Most recently ended first; paused ones (no end date) after them.
  const past = allRecurring.filter((re) => recurringIsPast_(re, todayISO))
    .sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""));
  const onetime = items.filter((re) => re.frequency === "once");

  document.getElementById("recurring-income-toggle").hidden = !items.some((re) => re.category_type === "income");
  syncIncomeToggles_();
  list.innerHTML = "";
  emptyNote.textContent = allRecurring.length ? tr("recurring.noCurrent") : tr("recurring.empty");
  emptyNote.hidden = recurring.length > 0;
  recurring.forEach((re) => list.appendChild(renderRecurringRow_(re)));

  const pastList = document.getElementById("recurring-past-list");
  pastList.innerHTML = "";
  past.forEach((re) => pastList.appendChild(renderRecurringRow_(re)));
  renderRecurringPastToggle_(past.length);

  onetimeList.innerHTML = "";
  onetimeEmptyNote.hidden = onetime.length > 0;
  onetime.forEach((re) => onetimeList.appendChild(renderRecurringRow_(re)));
}

const MONTH_NAMES_SHORT = Array.from({ length: 12 }, (_, i) => I18n.monthShort(i, true));   // capitalised in Spanish: every use starts a label

function populateRecurringCategoryChips() {
  const container = document.getElementById("recurring-category-chips");
  container.innerHTML = "";
  sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === "expense" || c.type === "income"), selectedRecurringCategoryId))
    .forEach((c) => {
      const chip = document.createElement("div");
      chip.className = "tag-chip" + (selectedRecurringCategoryId === c.id ? " selected" : "");
      chip.textContent = (c.icon ? c.icon + " " : "") + c.name;
      chip.addEventListener("click", () => {
        selectedRecurringCategoryId = c.id;
        populateRecurringCategoryChips();
        toggleRecurringSplitFieldVisibility();
      });
      container.appendChild(chip);
    });
}

// A split only makes sense for an expense-type category (Entry Splits
// itself is expense-only — see CLAUDE.md), same rule the entry form's own
// toggleSplitFieldVisibility applies. Recurring items also allow income
// categories, where this field simply never appears.
function toggleRecurringSplitFieldVisibility() {
  const cat = meta.categories.find((c) => c.id === selectedRecurringCategoryId);
  // Shown from the start on a NEW item (no category picked yet): it used to
  // appear only after an expense category was chosen, far down a long chip list,
  // so creating a shared recurring expense looked like it had no such option
  // (owner, 2026-10-19). Hidden only once an income category is picked.
  const show = !cat || cat.type === "expense";
  document.getElementById("recurring-split-field").hidden = !show;
  if (!show) resetRecurringSplitState();
  syncRecurringTripField_();
}

// The trip/event picker shows only for a one-time item in an expense category, and only when a trip exists.
function syncRecurringTripField_() {
  const cat = meta.categories.find((c) => c.id === selectedRecurringCategoryId);
  const show = recurringFrequency === "once" && (!cat || cat.type === "expense") && (meta.trips || []).length > 0;
  document.getElementById("recurring-trip-field").hidden = !show;
  if (!show) document.getElementById("recurring-trip").value = "";
}

function resetRecurringSplitState() {
  recurringSplitFriendIds = new Set();
  recurringSplitMode = "equal";
  recurringCustomSplitAmounts = {};
  document.getElementById("recurring-split-toggle").checked = false;
  document.getElementById("recurring-split-detail").hidden = true;
  document.querySelectorAll("#recurring-split-mode-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === "equal");
  });
  renderRecurringSplitFriendChips();
  renderRecurringSplitRows();
  document.getElementById("recurring-split-summary").textContent = "";
  document.getElementById("recurring-split-error").textContent = "";
}

function renderRecurringSplitFriendChips() {
  const container = document.getElementById("recurring-split-friend-chips");
  container.innerHTML = "";
  meta.friends.forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "tag-chip" + (recurringSplitFriendIds.has(f.id) ? " selected" : "");
    chip.textContent = f.name;
    chip.addEventListener("click", () => {
      if (recurringSplitFriendIds.has(f.id)) {
        recurringSplitFriendIds.delete(f.id);
        delete recurringCustomSplitAmounts[f.id];
      } else {
        recurringSplitFriendIds.add(f.id);
      }
      renderRecurringSplitFriendChips();
      renderRecurringSplitRows();
      renderRecurringSplitSummary();
    });
    container.appendChild(chip);
  });
}

// Only custom mode needs a row per friend — equal mode's amounts are
// computed, not typed (same as the entry form's own split rows).
function renderRecurringSplitRows() {
  const container = document.getElementById("recurring-split-rows");
  container.innerHTML = "";
  if (recurringSplitMode !== "custom") return;

  Array.from(recurringSplitFriendIds).forEach((id) => {
    const friend = meta.friends.find((f) => f.id === id);
    if (!friend) return;

    const row = document.createElement("div");
    row.className = "split-row";

    const name = document.createElement("span");
    name.className = "split-row-name";
    name.textContent = friend.name;

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "0.00";
    input.value = recurringCustomSplitAmounts[id] || "";
    input.addEventListener("input", (e) => {
      recurringCustomSplitAmounts[id] = e.target.value;
      renderRecurringSplitSummary();
    });

    row.appendChild(name);
    row.appendChild(input);
    container.appendChild(row);
  });
}

function renderRecurringSplitSummary() {
  const summaryEl = document.getElementById("recurring-split-summary");
  const errorEl = document.getElementById("recurring-split-error");
  errorEl.textContent = "";

  const amount = parseFloat(document.getElementById("recurring-amount").value) || 0;
  const currency = (document.getElementById("recurring-currency").value || homeCur()).toUpperCase();
  const friendIds = Array.from(recurringSplitFriendIds);

  if (friendIds.length === 0) {
    summaryEl.textContent = tr("split.pickWho");
    return;
  }

  if (recurringSplitMode === "equal") {
    const { shareEach, ownerShare } = computeEqualShares(amount, friendIds);
    summaryEl.textContent = tr("split.summaryEqual", { cur: currency, each: moneyFmt(shareEach), own: moneyFmt(ownerShare) });
  } else {
    const assigned = friendIds.reduce((sum, id) => sum + (parseFloat(recurringCustomSplitAmounts[id]) || 0), 0);
    const remaining = amount - assigned;
    summaryEl.textContent = tr("recSplit.summaryCustom", { cur: currency, assigned: moneyFmt(assigned), total: moneyFmt(amount), left: moneyFmt(Math.max(remaining, 0)) });
    if (remaining < -0.004) errorEl.textContent = tr("split.errorOver");
  }
}

function getRecurringSplitPayload() {
  const amount = parseFloat(document.getElementById("recurring-amount").value) || 0;
  const friendIds = Array.from(recurringSplitFriendIds);

  if (recurringSplitMode === "equal") {
    const { shareEach } = computeEqualShares(amount, friendIds);
    return friendIds.map((id) => ({ friend_id: id, amount: shareEach }));
  }
  return friendIds
    .map((id) => ({ friend_id: id, amount: parseFloat(recurringCustomSplitAmounts[id]) || 0 }))
    .filter((s) => s.amount > 0);
}

// Mirrors the entry form's validateSplitIfEnabled — called from the save
// handler before anything is written. Returns the split array to save, or
// null when the toggle is off (meaning "clear any existing split").
function validateRecurringSplitIfEnabled() {
  if (document.getElementById("recurring-split-field").hidden) return null;
  if (!document.getElementById("recurring-split-toggle").checked) return [];

  const amount = parseFloat(document.getElementById("recurring-amount").value) || 0;
  const friendIds = Array.from(recurringSplitFriendIds);
  if (friendIds.length === 0) {
    throw new Error(tr("split.errNoFriend"));
  }

  const splits = getRecurringSplitPayload();
  const assigned = splits.reduce((sum, s) => sum + s.amount, 0);
  if (recurringSplitMode === "custom" && assigned <= 0) {
    throw new Error(tr("split.errNoAmount"));
  }
  if (assigned - amount > 0.004) {
    throw new Error(tr("split.errOverTotal"));
  }
  return splits;
}

document.getElementById("recurring-split-toggle").addEventListener("change", (e) => {
  document.getElementById("recurring-split-detail").hidden = !e.target.checked;
  renderRecurringSplitFriendChips();
  renderRecurringSplitRows();
  renderRecurringSplitSummary();
});

document.querySelectorAll("#recurring-split-mode-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    recurringSplitMode = tab.dataset.mode;
    document.querySelectorAll("#recurring-split-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderRecurringSplitRows();
    renderRecurringSplitSummary();
  });
});

document.getElementById("recurring-split-add-friend-btn").addEventListener("click", async () => {
  const name = prompt(tr("prompt.friendName"));
  if (!name || !name.trim()) return;
  const friend = await callApi("addFriend", { name: name.trim() });
  meta.friends.push(friend);
  refreshFriendChips_();
  recurringSplitFriendIds.add(friend.id);
  renderRecurringSplitFriendChips();
  renderRecurringSplitRows();
  renderRecurringSplitSummary();
});

// A monthly/yearly item has ONE date field, "Starts on" (a native
// <input type="date">, the same control the main entry form uses). Its
// day (and, for yearly, month) are read from that date on save — there is
// no separate "day of month" picker (two dates side by side was
// confusing). A one-time item is different: its real date is its own
// field (#recurring-occurrence-date), used as-is, and it has no start/end.
let recurringStartStandIn = "";
let recurringStandInItem = null;
function setRecurringFrequency_(freq) {
  recurringFrequency = freq;
  document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.frequency === freq);
  });
  const isOnce = freq === "once";
  document.getElementById("recurring-once-fields").hidden = !isOnce;
  document.getElementById("recurring-window-fields").hidden = isOnce;
  document.getElementById("recurring-custom-fields").hidden = freq !== "custom";
  // A variable amount makes sense for a monthly item or one with its own interval.
  const canBeVariable = freq === "monthly" || freq === "custom";
  document.getElementById("recurring-variable-field").hidden = !canBeVariable;
  if (!canBeVariable) document.getElementById("recurring-variable-toggle").checked = false;
  syncRecurringVariableUi_();
  syncRecurringTripField_();
  if (isOnce) {
    // Any date is allowed, past or future (owner, 2026-10-19): a one-time item may stand for something
    // already paid by a friend, so it is no longer limited to today onwards.
    document.getElementById("recurring-occurrence-date").removeAttribute("min");
    return;
  }
  document.getElementById("recurring-start-hint").textContent =
    freq === "yearly" ? tr("recModal.yearlyHint") : freq === "custom" ? tr("recModal.customStartHint") : tr("recModal.monthlyHint");
}

document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setRecurringFrequency_(tab.dataset.frequency));
});

// The variable-amount part of the modal (see specs/recurring.md): a tick box,
// the words that identify the payments, and a hint saying what the app
// currently expects. For a variable item the Amount field is only the starting
// estimate, used until the first payment is recognised.
let editingRecurringItem = null;

function syncRecurringVariableUi_() {
  const fieldHidden = document.getElementById("recurring-variable-field").hidden;
  const on = !fieldHidden && document.getElementById("recurring-variable-toggle").checked;
  document.getElementById("recurring-variable-detail").hidden = !on;
  document.getElementById("recurring-amount-label").textContent = on ? tr("recModal.startingEstimate") : tr("field.amount");
  const re = editingRecurringItem;
  const hint = document.getElementById("recurring-variable-hint");
  if (!on) { hint.textContent = ""; return; }
  hint.textContent = re && re.variable && re.payments_used > 0
    ? tr("recModal.variableHintLive", { n: re.payments_used, cur: re.currency, amount: moneyFmt(re.amount), low: moneyFmt(re.amount_low), high: moneyFmt(re.amount_high) })
    : tr("recModal.variableHintNew");
}

document.getElementById("recurring-variable-toggle").addEventListener("change", syncRecurringVariableUi_);

// re: an existing item to edit. prefill: a suggestion from "Look for variable
// payments" (a NEW item whose fields start filled in; nothing is saved until Save).
async function openRecurringModal(re, prefill) {
  editingRecurringId = re ? re.id : null;
  editingRecurringItem = re || null;
  if (!prefill) pendingSuggestionBox_ = null;
  const src = re || prefill || null;
  document.getElementById("recurring-modal-title").textContent = re ? tr("recModal.editItem") : tr("recModal.addItem");
  document.getElementById("recurring-form-error").textContent = "";
  document.getElementById("recurring-description").value = src ? src.description : "";

  selectedRecurringCategoryId = src ? src.category_id : null;
  populateRecurringCategoryChips();

  // A variable item shows what was typed (its estimate is shown in the hint).
  document.getElementById("recurring-amount").value = src ? (src.variable && src.base_amount != null ? src.base_amount : src.amount) : "";
  document.getElementById("recurring-currency").value = src ? src.currency : homeCur();
  renderCurrencyChips("recurring");

  const frequency = re ? re.frequency : "monthly";
  document.getElementById("recurring-variable-toggle").checked = !!(prefill || (re && re.variable));
  document.getElementById("recurring-match-words").value = src && src.match_words ? src.match_words : "";
  fillTripOptions_(document.getElementById("recurring-trip"), re && re.trip_id ? re.trip_id : "");
  setRecurringFrequency_(frequency);
  document.getElementById("recurring-interval").value = re && re.frequency === "custom" ? re.interval : 1;
  document.getElementById("recurring-interval-unit").value = re && re.frequency === "custom" ? re.interval_unit : "weeks";
  document.getElementById("recurring-occurrence-date").value =
    frequency === "once" && re && re.date ? re.date : todayLocalISO();
  // Monthly/yearly: "Starts on" is the one date. An older item saved before
  // start dates existed has none; show its day/month in this year purely so
  // the field isn't empty, and remember it was only a stand-in so saving
  // without touching it keeps the item with no start (no history dropped).
  let startValue = re ? (re.start_date || "") : todayLocalISO();
  recurringStartStandIn = "";
  recurringStandInItem = re;
  if (re && frequency !== "once" && !re.start_date) {
    const now = new Date();
    const monthNum = frequency === "yearly" ? (re.month || 1) : now.getMonth() + 1;
    // A day like the 31st is clamped to the month's real length for display
    // only; the saved day stays the item's own (see the save handler).
    const day = Math.min(re.day || 1, new Date(now.getFullYear(), monthNum, 0).getDate());
    startValue = `${now.getFullYear()}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    recurringStartStandIn = startValue;
  } else if (!re && prefill) {
    // A proposal from "Look for variable payments": the bill already existed
    // before today, so treat it like an older item with no start date — show
    // this month's occurrence on its usual day as a stand-in; untouched, it
    // saves with no start date and that exact day (past payments keep counting).
    const now = new Date();
    const day = Math.min(prefill.day || 1, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    startValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    recurringStartStandIn = startValue;
    recurringStandInItem = { frequency: "monthly", day: prefill.day || 1, month: 1 };
  }
  document.getElementById("recurring-start-date").value = startValue;
  document.getElementById("recurring-active-checkbox").checked = re ? re.active : true;
  document.getElementById("recurring-delete-btn").hidden = !re;
  document.getElementById("recurring-end-date").value = re ? (re.end_date || "") : "";
  renderRecurringSkips_(re);

  // "Find past entries" only makes sense for an item that already exists
  // (it searches by this item's own id) — reset any previous search's
  // results each time the modal reopens, on a different item or the same
  // one, rather than showing stale candidates from before.
  document.getElementById("recurring-link-section").hidden = !re;
  document.getElementById("recurring-link-results").hidden = true;
  document.getElementById("recurring-link-list").innerHTML = "";
  document.getElementById("recurring-link-selected-btn").hidden = true;

  // Start clean, same as the entry form: an expense category shows the
  // field; anything else hides it.
  resetRecurringSplitState();
  toggleRecurringSplitFieldVisibility();

  const backdrop = document.getElementById("recurring-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;

  // Loaded after the modal is already showing, same reasoning as
  // startEditEntry's own split fetch not blocking the (already-visible)
  // entry form — always lands in Custom mode, the one mode that can
  // represent exactly what's stored regardless of whether it was
  // originally entered as Equal or Custom.
  if (re && re.split_total > 0.005) {
    const splits = await callApi("getRecurringExpenseSplits", { recurringExpenseId: re.id });
    if (splits.length) applyRecurringSplitRows_(splits);
  }
  // A proposal for a bill the owner usually shares (e.g. the gas paid for the
  // whole flat) starts with the same friends and the latest amounts.
  if (!re && prefill && prefill.split && prefill.split.length) applyRecurringSplitRows_(prefill.split);
}

// Shows these splits [{friend_id, amount}] in the modal, in Custom mode.
function applyRecurringSplitRows_(splits) {
  recurringSplitMode = "custom";
  document.querySelectorAll("#recurring-split-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === "custom"));
  splits.forEach((s) => {
    recurringSplitFriendIds.add(s.friend_id);
    recurringCustomSplitAmounts[s.friend_id] = String(s.amount);
  });
  document.getElementById("recurring-split-toggle").checked = true;
  document.getElementById("recurring-split-detail").hidden = false;
  renderRecurringSplitFriendChips();
  renderRecurringSplitRows();
  renderRecurringSplitSummary();
}

// Skipped months of the item being edited, each with an Undo.
function renderRecurringSkips_(re) {
  const section = document.getElementById("recurring-skips-section");
  const list = document.getElementById("recurring-skips-list");
  const months = re && re.skipped_months ? re.skipped_months : [];
  section.hidden = months.length === 0;
  list.innerHTML = "";
  months.forEach((m) => {
    const [y, mm] = m.split("-").map(Number);
    const row = document.createElement("div");
    row.className = "skipped-month-row";
    row.innerHTML = `<span>${MONTH_NAMES_SHORT[mm - 1]} ${y}</span><button type="button" class="add-inline">${tr("recModal.undoSkip")}</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      try {
        await callApi("unskipRecurringOccurrence", { id: re.id, month: m });
        re.skipped_months = re.skipped_months.filter((x) => x !== m);
        renderRecurringSkips_(re);
        refreshRecurringExpenses();
        refreshExpectedRecurring();
      } catch (err) {
        // Shown as an alert too — the line under the form is below the fold in
        // this tall modal, so a failed undo looked like "it just didn't save".
        document.getElementById("recurring-form-error").textContent = err.message;
        alert(tr("recModal.undoSkipFailed", { error: err.message }));
      }
    });
    list.appendChild(row);
  });
}

function closeRecurringModal() {
  document.getElementById("recurring-modal-backdrop").hidden = true;
  editingRecurringId = null;
  editingRecurringItem = null;
}

document.getElementById("add-recurring-btn").addEventListener("click", () => openRecurringModal(null));
document.getElementById("recurring-modal-close").addEventListener("click", closeRecurringModal);
document.getElementById("recurring-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "recurring-modal-backdrop") closeRecurringModal();
});

// "Find past entries for this" — searches Entries already in this item's
// own category for ones that look like its own history but the normal
// day/currency/amount heuristic doesn't catch (see
// findRecurringLinkCandidates in RecurringExpenses.gs; deliberately a
// plain, explainable score — amount closeness plus a shared description
// word — never an AI call). Nothing gets linked until the owner checks
// boxes and taps "Link selected," below.
document.getElementById("recurring-find-matches-btn").addEventListener("click", async () => {
  if (!editingRecurringId) return;
  const btn = document.getElementById("recurring-find-matches-btn");
  const resultsEl = document.getElementById("recurring-link-results");
  const listEl = document.getElementById("recurring-link-list");
  const emptyNote = document.getElementById("recurring-link-empty-note");
  const linkBtn = document.getElementById("recurring-link-selected-btn");

  btn.disabled = true;
  btn.textContent = tr("recModal.searching");
  try {
    const { candidates } = await callApi("findRecurringLinkCandidates", { recurringExpenseId: editingRecurringId });
    resultsEl.hidden = false;
    listEl.innerHTML = "";
    emptyNote.hidden = candidates.length > 0;
    linkBtn.hidden = candidates.length === 0;

    candidates.forEach((c) => {
      const row = document.createElement("label");
      row.className = "link-candidate-row";
      // Only a genuinely confident match (a description word shared AND
      // the amount close, score >= 1.3 — see findRecurringLinkCandidates)
      // starts checked. A candidate that only cleared the looser amount
      // floor (real cases seen: an unrelated phone-bill or accessory
      // purchase that merely happened to cost about the same) starts
      // unchecked instead — the sort already puts it near the bottom, but
      // relying on the owner to notice and uncheck 60 rows one by one
      // isn't a safe enough default for something that writes a link.
      const confident = c.score >= 1.3;
      row.innerHTML = `
        <input type="checkbox" value="${c.id}" ${confident ? "checked" : ""}>
        <div class="link-candidate-text">
          <div class="link-candidate-date">${c.date} · ${c.currency} ${moneyFmt(c.amount)}${confident ? "" : ` <span class="hint">${tr("recModal.lessCertain")}</span>`}</div>
          <div class="link-candidate-desc">${escapeHtml(c.description || tr("review.noDescription"))}</div>
        </div>
      `;
      listEl.appendChild(row);
    });
  } catch (err) {
    resultsEl.hidden = false;
    listEl.innerHTML = `<div class="status-msg">${escapeHtml(tr("recModal.searchFailed", { error: err.message }))}</div>`;
    emptyNote.hidden = true;
    linkBtn.hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = tr("recModal.findMatches");
  }
});

document.getElementById("recurring-link-selected-btn").addEventListener("click", async () => {
  if (!editingRecurringId) return;
  const linkBtn = document.getElementById("recurring-link-selected-btn");
  const checked = Array.from(document.querySelectorAll("#recurring-link-list input[type=checkbox]:checked"));
  const entryIds = checked.map((el) => el.value);
  if (!entryIds.length) return;

  linkBtn.disabled = true;
  try {
    await callApi("linkEntriesToRecurring", { recurringExpenseId: editingRecurringId, entryIds });
    // Remove the now-linked rows rather than re-running the whole search —
    // they'd no longer come back anyway (linked entries are excluded),
    // and this reads as immediate confirmation of what just happened.
    checked.forEach((el) => el.closest(".link-candidate-row").remove());
    const remaining = document.querySelectorAll("#recurring-link-list .link-candidate-row").length;
    document.getElementById("recurring-link-empty-note").hidden = remaining > 0;
    linkBtn.hidden = remaining === 0;
    refreshExpectedRecurring();
  } catch (err) {
    document.getElementById("recurring-form-error").textContent = err.message;
  } finally {
    linkBtn.disabled = false;
  }
});

// "Look for variable payments" (see suggestVariableRecurring in
// RecurringExpenses.gs): proposals only. "Add…" opens the normal add form with
// the fields filled in; nothing exists until the owner taps Save. "Not now"
// hides a proposal on this phone (remembered, but only here).
const DISMISSED_VARIABLE_KEY = "dismissedVariableSuggestions";
let pendingSuggestionBox_ = null;

function dismissedVariableSuggestions_() {
  try { return JSON.parse(localStorage.getItem(DISMISSED_VARIABLE_KEY) || "[]"); } catch (e) { return []; }
}

function dismissVariableSuggestion_(key) {
  try { localStorage.setItem(DISMISSED_VARIABLE_KEY, JSON.stringify(dismissedVariableSuggestions_().concat(key))); } catch (e) { /* private mode: it just comes back next time */ }
}

function renderVariableSuggestions_(suggestions) {
  const list = document.getElementById("recurring-suggest-list");
  const dismissed = dismissedVariableSuggestions_();
  const shown = suggestions.filter((s) => !dismissed.includes(s.key));
  list.innerHTML = "";
  document.getElementById("recurring-suggest-empty").hidden = shown.length > 0;
  shown.forEach((s) => {
    const box = document.createElement("div");
    box.className = "expected-recurring-entry";
    // A bill the owner usually pays for others too (e.g. the gas for the whole
    // flat): same "big = my share, small grey = total" treatment a split real
    // expense gets, plus who it is shared with.
    const names = (s.split || []).map((f) => f.name).filter(Boolean).join(", ");
    const sharedLine = s.shared
      ? `<span class="hint" style="display:block;">${escapeHtml(tr("recurring.suggestShared", { names: names || "—" }))}</span>`
      : "";
    const amountHtml = s.shared
      ? `≈ ${s.currency} ${moneyFmt(s.own_avg_amount)}<span class="original-amt">${tr("common.total")} ${s.currency} ${moneyFmt(s.avg_amount)}</span>`
      : `≈ ${s.currency} ${moneyFmt(s.avg_amount)}`;
    box.innerHTML = `
      <div class="expected-recurring-item">
        <span class="expected-recurring-item-label">${s.category_icon ? s.category_icon + " " : ""}${escapeHtml(s.description)}
          <span class="hint" style="display:block;">${escapeHtml(tr("recurring.suggestSub", { category: s.category_name, day: s.typical_day, n: s.months_seen, cur: s.currency, min: moneyFmt(s.min_amount), max: moneyFmt(s.max_amount) }))}</span>
          ${sharedLine}
        </span>
        <span class="expected-recurring-item-amount">${amountHtml}</span>
      </div>
      <div class="expected-recurring-actions">
        <button type="button" data-act="add">${tr("recurring.suggestAdd")}</button>
        <button type="button" data-act="dismiss">${tr("recurring.suggestDismiss")}</button>
      </div>`;
    box.querySelector('[data-act="add"]').addEventListener("click", () => {
      pendingSuggestionBox_ = box;   // removed from the list once the item is actually saved
      openRecurringModal(null, {
        category_id: s.category_id, description: s.description, amount: s.avg_amount,
        currency: s.currency, day: s.typical_day, match_words: s.match_words, split: s.shared ? s.split : []
      });
    });
    box.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
      dismissVariableSuggestion_(s.key);
      box.remove();
      document.getElementById("recurring-suggest-empty").hidden = list.children.length > 0;
    });
    list.appendChild(box);
  });
}

document.getElementById("recurring-suggest-btn").addEventListener("click", async () => {
  const btn = document.getElementById("recurring-suggest-btn");
  const list = document.getElementById("recurring-suggest-list");
  btn.disabled = true;
  btn.textContent = tr("recModal.searching");
  try {
    const { suggestions } = await callApi("suggestVariableRecurring");
    renderVariableSuggestions_(suggestions);
  } catch (err) {
    document.getElementById("recurring-suggest-empty").hidden = true;
    list.innerHTML = `<div class="status-msg">${escapeHtml(tr("recModal.searchFailed", { error: err.message }))}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = tr("recurring.suggestBtn");
  }
});

document.getElementById("recurring-amount").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
  if (document.getElementById("recurring-split-toggle").checked) renderRecurringSplitSummary();
});

document.getElementById("recurring-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("recurring-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("recurring-save-btn");
  saveBtn.disabled = true;

  try {
    const description = document.getElementById("recurring-description").value.trim();
    const amount = parseFloat(document.getElementById("recurring-amount").value);
    const currency = document.getElementById("recurring-currency").value.toUpperCase();
    // One-time: its own date field. Monthly/yearly: the "Starts on" date.
    const startDate = document.getElementById("recurring-start-date").value;
    const occurrenceDate = recurringFrequency === "once"
      ? document.getElementById("recurring-occurrence-date").value
      : startDate;
    const active = document.getElementById("recurring-active-checkbox").checked;

    if (!selectedRecurringCategoryId) throw new Error(tr("error.pickCategory"));
    if (!amount || amount <= 0) throw new Error(tr("error.validAmount"));
    if (!occurrenceDate) throw new Error(tr("recModal.pickDate"));

    // Validated up front, same as the entry form — a bad split blocks the
    // save entirely rather than saving the item and silently dropping a
    // broken split. null means the field isn't even shown (non-expense
    // category); [] means shown but the toggle is off (clears any
    // existing split).
    const splits = validateRecurringSplitIfEnabled();

    const fields = {
      category_id: selectedRecurringCategoryId,
      description,
      amount,
      currency,
      frequency: recurringFrequency,
      active,
      // Blank clears; the server checks they are real dates and in order.
      // An untouched stand-in (older item with no start) stays "no start".
      start_date: recurringFrequency === "once" || startDate === recurringStartStandIn ? "" : startDate,
      end_date: recurringFrequency === "once" ? "" : document.getElementById("recurring-end-date").value,
      // Variable amount: a monthly item or one with its own interval; the server checks the words.
      variable: (recurringFrequency === "monthly" || recurringFrequency === "custom") && document.getElementById("recurring-variable-toggle").checked,
      match_words: document.getElementById("recurring-match-words").value.trim(),
      // "Other": every N days/weeks/months/years from the start date (the server checks them).
      interval: recurringFrequency === "custom" ? document.getElementById("recurring-interval").value.trim() : "",
      interval_unit: recurringFrequency === "custom" ? document.getElementById("recurring-interval-unit").value : "",
      // Always sent so clearing it works; the server keeps it only for a one-time expense item.
      trip_id: recurringFrequency === "once" ? document.getElementById("recurring-trip").value : ""
    };
    if (recurringFrequency === "once") {
      fields.date = occurrenceDate; // real date, full year — a single occurrence
      fields.day = "";
      fields.month = "";
    } else {
      fields.day = parseInt(occurrenceDate.slice(8, 10), 10);
      fields.month = parseInt(occurrenceDate.slice(5, 7), 10);
      fields.date = "";
      if (startDate === recurringStartStandIn && recurringStandInItem && recurringStandInItem.frequency === recurringFrequency) {
        // Untouched stand-in: keep the item's own day/month exactly as stored.
        fields.day = recurringStandInItem.day;
        fields.month = recurringStandInItem.month;
      }
    }

    let recurringExpenseId = editingRecurringId;
    if (editingRecurringId) {
      await callApi("updateRecurringExpense", Object.assign({ id: editingRecurringId }, fields));
    } else {
      const created = await callApi("addRecurringExpense", fields);
      recurringExpenseId = created.id;
    }
    // Always sent, even as [] — that's how a previously-split item gets
    // its split cleared when the toggle is turned back off, same as the
    // entry form's own saveEntrySplits call.
    if (splits !== null) {
      await callApi("saveRecurringExpenseSplits", { recurringExpenseId, splits });
    }
    closeRecurringModal();
    if (pendingSuggestionBox_) {
      const list = document.getElementById("recurring-suggest-list");
      pendingSuggestionBox_.remove();
      pendingSuggestionBox_ = null;
      document.getElementById("recurring-suggest-empty").hidden = list.children.length > 0;
    }
    refreshRecurringExpenses();
    if (!document.getElementById("screen-trip-detail").hidden) refreshTripDetail_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("recurring-delete-btn").addEventListener("click", async () => {
  if (!editingRecurringId) return;
  const recLabel = document.getElementById("recurring-description").value.trim();
  const recAmount = document.getElementById("recurring-amount").value.trim();
  const recCurrency = document.getElementById("recurring-currency").value;
  if (!confirm(tr("recModal.confirmDelete", { what: describeForConfirm_(recLabel, recAmount ? `${recCurrency} ${recAmount}` : "") }))) return;
  const id = editingRecurringId;
  closeRecurringModal();
  await callApi("deleteRecurringExpense", { id });
  refreshRecurringExpenses();
  if (!document.getElementById("screen-trip-detail").hidden) refreshTripDetail_();
});

// ---- Programmed income is hidden by default ----
// Income amounts (a salary, say) can be sensitive, so every programmed-income
// amount renders as "••••" until the owner taps "Show income amounts". One
// shared switch (a class on <body>) covers the "Programmed this month" card
// and the Programmed income/expenses screen, so no list needs re-drawing — and
// an open group keeps its place. Not remembered: each app launch starts hidden.
function sensitiveHtml_(realHtml) {
  return `<span class="sens-real">${realHtml}</span><span class="sens-mask primary-amt" aria-hidden="true">••••</span>`;
}

function syncIncomeToggles_() {
  const revealed = document.body.classList.contains("income-revealed");
  document.querySelectorAll(".income-toggle-btn").forEach((btn) => {
    btn.textContent = tr(revealed ? "income.hide" : "income.show");
  });
}

document.querySelectorAll(".income-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.body.classList.toggle("income-revealed");
    syncIncomeToggles_();
  });
});

// ---- "Programmed this month" (Entries tab) ----

// A group's summary row is purely a toggle for its own detail list — no
// confirm/discard anywhere here. The actual entry only ever gets created
// the normal way (email arrives, review queue, confirm) — this is just a
// heads-up of what the server hasn't matched to a real entry yet, and it
// drops off there on its own once that match exists.
// prefetchedGroups: see loadMeta's comment above.
async function refreshExpectedRecurring(prefetchedGroups) {
  const card = document.getElementById("expected-recurring-card");
  const container = document.getElementById("expected-recurring-groups");
  let groups;
  if (prefetchedGroups) {
    groups = prefetchedGroups;
  } else {
    try {
      ({ groups } = await callApi("listExpectedRecurringItems"));
    } catch (err) {
      // Logged rather than swallowed outright — this card hiding with no
      // sign anything went wrong (a slow cold start, a dropped connection)
      // has looked, from the outside, identical to "nothing programmed
      // this month" with nothing in the console to tell the two apart.
      console.error("refreshExpectedRecurring failed:", err);
      card.hidden = true;
      return;
    }
  }

  if (!groups.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  container.innerHTML = "";
  document.getElementById("expected-income-toggle").hidden = !groups.some((g) => g.type === "income");
  syncIncomeToggles_();

  groups.forEach((g) => {
    const group = document.createElement("div");
    group.className = "expected-recurring-group";

    const isPen = g.currency === homeCur();
    const isIncome = g.type === "income";
    const sign = isIncome ? "+" : "";
    let amountHtml;
    if (isPen) {
      amountHtml = `<span class="primary-amt">${sign}${homeCur()} ${moneyFmt(g.total)}</span>`;
    } else if (g.totalPen != null) {
      amountHtml = `<span class="primary-amt">${sign}${homeCur()} ${moneyFmt(g.totalPen)}</span>` +
        `<span class="original-amt">${findCurrency(g.currency).flag} ${g.currency} ${moneyFmt(g.total)}</span>`;
    } else {
      amountHtml = `<span class="primary-amt">⚠️ ${findCurrency(g.currency).flag} ${g.currency} ${moneyFmt(g.total)}</span>` +
        `<span class="original-amt">${tr("expected.needsRate")}</span>`;
    }

    const detail = document.createElement("div");
    detail.className = "expected-recurring-detail";
    detail.hidden = true;
    // Each item and its two buttons sit together in one bordered box, so it's
    // obvious which item a button belongs to.
    detail.innerHTML = g.items.map((item) => {
      const itemAmt = `${item.overdue ? "⚠️ " : ""}${tr("expected.day", { day: item.day })} · ${g.currency} ${item.estimated ? "≈ " : ""}${moneyFmt(item.amount)}`;
      return `
      <div class="expected-recurring-entry${item.overdue ? " overdue" : ""}">
        <div class="expected-recurring-item">
          <span class="expected-recurring-item-label">${item.category_icon ? item.category_icon + " " : ""}${escapeHtml(item.category_name)}${item.description ? " — " + escapeHtml(item.description) : ""}</span>
          <span class="expected-recurring-item-amount">${isIncome ? sensitiveHtml_(itemAmt) : itemAmt}</span>
        </div>
        <div class="expected-recurring-actions">
          <button type="button" data-act="paid" data-id="${item.id}">${tr("expected.markPaid")}</button>
          <button type="button" data-act="skip" data-id="${item.id}">${tr("expected.skipMonth")}</button>
        </div>
      </div>`;
    }).join("");
    detail.querySelectorAll(".expected-recurring-actions button").forEach((btn) => {
      const item = g.items.find((i) => i.id === btn.dataset.id);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.act === "skip") skipRecurringThisMonth_(item);
        else openPaidPicker_(item, g.currency);
      });
    });

    const summary = document.createElement("div");
    summary.className = "expected-recurring-summary";
    summary.innerHTML = `
      <span class="expected-recurring-summary-label">${tr("expected.count", { n: g.items.length })}</span>
      <span class="expected-recurring-amount${isIncome ? " income" : ""}">${isIncome ? sensitiveHtml_(amountHtml) : amountHtml}</span>
    `;
    summary.addEventListener("click", () => { detail.hidden = !detail.hidden; });

    group.appendChild(summary);
    group.appendChild(detail);
    container.appendChild(group);
  });
}

// "Skip this month": that one occurrence stops counting as expected (here, in
// Budgets and in Projections); the item itself and its other months are
// untouched, and it can be undone from the item's edit screen.
async function skipRecurringThisMonth_(item) {
  const label = item.description || item.category_name;
  if (!confirm(tr("expected.confirmSkip", { label }))) return;
  try {
    await callApi("skipRecurringOccurrence", { id: item.id, month: todayLocalISO().slice(0, 7) });
    await refreshExpectedRecurring();
    refreshRecurringExpenses();
  } catch (err) {
    alert(tr("expected.skipFailed", { error: err.message }));
  }
}

// "Mark as paid…": a manual override for when automatic matching (same
// category and currency, about the same amount, within a few days) missed the
// real payment. Pick the entry that paid it; automatic matching stays on.
async function openPaidPicker_(item, currency) {
  const backdrop = document.getElementById("paid-picker-modal-backdrop");
  const list = document.getElementById("paid-picker-list");
  const errorEl = document.getElementById("paid-picker-error");
  errorEl.textContent = "";
  list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  document.getElementById("paid-picker-empty").hidden = true;
  document.getElementById("paid-picker-title").textContent = tr("paid.title");
  document.getElementById("paid-picker-hint").textContent =
    tr("paid.hint", { name: item.description || item.category_name, cur: currency, amount: moneyFmt(item.amount) });
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  try {
    const entries = await callApi("listEntriesForRecurringMonth", { id: item.id, month: todayLocalISO().slice(0, 7) });
    list.innerHTML = "";
    document.getElementById("paid-picker-empty").hidden = entries.length > 0;
    const topCount = entries.filter((e) => e.is_top).length;
    const addHeading = (text) => {
      const h = document.createElement("p");
      h.className = "hint";
      h.style.cssText = "margin:8px 0 4px;font-weight:600;";
      h.textContent = text;
      list.appendChild(h);
    };
    entries.forEach((e, i) => {
      if (topCount && i === 0) addHeading(tr("paid.mostSimilar"));
      if (topCount && i === topCount) addHeading(tr("paid.allMonth"));
      const row = document.createElement("div");
      row.className = "link-candidate-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <div class="link-candidate-text">
          <div class="link-candidate-date">${e.date} · ${e.currency} ${moneyFmt(e.amount)}</div>
          <div class="link-candidate-desc">${escapeHtml(e.description || e.category_name || tr("review.noDescription"))}</div>
        </div>`;
      row.addEventListener("click", async () => {
        try {
          await callApi("linkEntryToRecurring", { entryId: e.id, recurringExpenseId: item.id });
          backdrop.hidden = true;
          await refreshExpectedRecurring();
        } catch (err) {
          errorEl.textContent = err.message;
        }
      });
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = "";
    errorEl.textContent = tr("paid.loadFailed", { error: err.message });
  }
}
document.getElementById("paid-picker-close").addEventListener("click", () => {
  document.getElementById("paid-picker-modal-backdrop").hidden = true;
});
document.getElementById("paid-picker-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "paid-picker-modal-backdrop") e.target.hidden = true;
});

// ---- Projections ----
//
// Income: recurring income for the period, plus any already-confirmed
// income entries in it that aren't already explained by a recurring one
// (a bonus or paycheck registered in advance) — never averaged from past
// months, since a category with nothing recurring and nothing yet
// confirmed for the period genuinely isn't known yet.
//
// Expense/investment: recurring for the period, plus a year-to-date rate
// (confirmed spend since Jan 1, excluding whatever's already explained by
// a recurring item, divided by complete months elapsed) projected across
// however many months the period covers.
//
// The top summary and the "By category" list below both come from the
// exact same per-category numbers (listCategoryProjections/getProjections
// share one calculation on the backend), so they can never disagree with
// each other — and any category with a manual override uses that instead
// of the calculation, in both places, until it's reset.

async function refreshProjectionsScreen() {
  // Same reasoning as refreshBudgets()' own renderPeriodSelector() call —
  // without it, moving the period with the arrows while ON the
  // Projections tab silently refreshed the projected figures below but
  // left the "September 2026" label itself frozen, reading as if nothing
  // had happened at all.
  renderPeriodSelector();
  await Promise.all([refreshProjections(), refreshProjectionCategories()]);
}

// The last projections shown are kept on this phone (per period) and painted at
// once on the next open, with an "Updating…" line while the live ones load —
// the same idea as the saved start-up bundle for Entries. Cleared on sign-out.
const PROJECTIONS_CACHE_KEY = "projectionsCache";
const PROJECTIONS_CACHE_MAX_PERIODS = 6;

function projectionsCacheKey_() {
  const p = projectionPeriodPayload_();
  return `${p.displayPeriodType}|${p.anchorDate}`;
}

function loadProjectionsCache_(key, part) {
  try {
    const c = JSON.parse(localStorage.getItem(PROJECTIONS_CACHE_KEY));
    // Category names come from the server already translated, so another
    // language's copy is not shown.
    if (!c || c.lang !== I18n.getLang()) return null;
    const entry = c.periods && c.periods[key];
    return (entry && entry[part]) || null;
  } catch (err) {
    return null;
  }
}

function saveProjectionsCache_(key, part, value) {
  try {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(PROJECTIONS_CACHE_KEY)); } catch (err) { c = null; }
    if (!c || c.lang !== I18n.getLang() || !c.periods) c = { lang: I18n.getLang(), periods: {} };
    const entry = c.periods[key] || {};
    entry[part] = value;
    delete c.periods[key];
    c.periods[key] = entry;   // most recently used goes last
    const keys = Object.keys(c.periods);
    while (keys.length > PROJECTIONS_CACHE_MAX_PERIODS) delete c.periods[keys.shift()];
    localStorage.setItem(PROJECTIONS_CACHE_KEY, JSON.stringify(c));
  } catch (err) {
    // Storage full/unavailable — the tab just shows "Loading…" each time, as before.
  }
}

// One "Updating…" line above the category list while either part is refreshing.
let projectionsUpdating_ = 0;
function setProjectionsUpdating_(on) {
  let note = document.getElementById("projections-updating");
  if (!note) {
    note = document.createElement("div");
    note.id = "projections-updating";
    note.className = "status-msg";
    document.getElementById("projections-body").before(note);
  }
  projectionsUpdating_ = Math.max(0, projectionsUpdating_ + (on ? 1 : -1));
  note.textContent = tr("projections.updating");
  note.hidden = projectionsUpdating_ === 0;
}

async function refreshProjections() {
  const body = document.getElementById("projections-body");
  const monthLabel = document.getElementById("projections-month-label");
  const methodNote = document.getElementById("projections-method-note");
  const cacheKey = projectionsCacheKey_();
  const cached = loadProjectionsCache_(cacheKey, "summary");
  if (cached) {
    renderProjectionsSummary_(cached);
  } else {
    body.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
    monthLabel.textContent = "";
    methodNote.textContent = "";
  }

  let p;
  setProjectionsUpdating_(true);
  try {
    p = await callApi("getProjections", projectionPeriodPayload_());
  } catch (err) {
    // With saved numbers on screen, keep them rather than replace them with an error.
    if (!cached) body.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
    return;
  } finally {
    setProjectionsUpdating_(false);
  }
  // The owner moved to another period while this was loading.
  if (cacheKey !== projectionsCacheKey_()) return;
  saveProjectionsCache_(cacheKey, "summary", p);
  renderProjectionsSummary_(p);
}

function renderProjectionsSummary_(p) {
  const body = document.getElementById("projections-body");
  const monthLabel = document.getElementById("projections-month-label");
  const methodNote = document.getElementById("projections-method-note");

  // The server names the month in English; yearly keeps the plain year.
  const projectedPeriod = p.periodType === "yearly" ? p.monthLabel : I18n.fmtMonthYear(periodType === "month" ? periodAnchor : new Date(), true);
  monthLabel.textContent = tr("projections.projectedFor", { period: projectedPeriod });

  // Rolled up from the same actual+programmed(+expected) figures each
  // category's own row and drill-down show (redesigned 2026-09-16,
  // replacing "from recurring items + from your year-to-date rate" —
  // this summary now matches that same reality-aware model instead of a
  // flat full-period estimate). Only shown when the type's own total is
  // nonzero — otherwise it's just "PEN 0.00 confirmed + PEN 0.00
  // programmed," which tells the reader nothing the summary above didn't
  // already.
  const breakdownLines = [];
  if (p.income > 0) {
    breakdownLines.push(tr("projections.lineIncome", { actual: formatPen(p.incomeActual), programmed: formatPen(p.incomeProgrammed) }));
  }
  if (p.expenses > 0) {
    breakdownLines.push(tr("projections.lineExpenses", { actual: formatPen(p.expensesActual), programmed: formatPen(p.expensesProgrammed), expected: formatPen(p.expensesExpected) }));
  }
  if (p.investments > 0) {
    breakdownLines.push(tr("projections.lineInvestments", { actual: formatPen(p.investmentsActual), programmed: formatPen(p.investmentsProgrammed), expected: formatPen(p.investmentsExpected) }));
  }

  body.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">${tr("summary.income")}</span>
        <span class="summary-value income">${formatPen(p.income)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">${tr("summary.expenses")}</span>
        <span class="summary-value expense">${formatPen(p.expenses)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">${tr("summary.investments")}</span>
        <span class="summary-value investment">${formatPen(p.investments)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">${tr("summary.net")}</span>
        <span class="summary-value">${formatPen(p.net)}</span>
      </div>
    </div>
    ${breakdownLines.map((line) => `<p class="projections-breakdown">${line}</p>`).join("")}
  `;
  methodNote.textContent = tr("projections.method");
  projectionDefaultMethod = p.defaultMethod || "balanced";
  document.getElementById("projections-method-btn").textContent = tr("projections.methodBtn", { name: projectionMethodLabel_(projectionDefaultMethod) });
}

// {displayPeriodType, anchorDate} matching whatever the shared period
// selector (Month/Year) is currently showing — All-time/Custom fall back
// to the current month server-side, since neither means anything for a
// forward-looking projection.
function projectionPeriodPayload_() {
  const anchorDate = `${periodAnchor.getFullYear()}-${pad2(periodAnchor.getMonth() + 1)}-01`;
  return { displayPeriodType: periodType, anchorDate };
}

// Three explicit lines per category (added 2026-09-16, replacing the old
// single collapsed "🔁 X programmed + 📈 Y expected" sub-label) — Actual
// (confirmed so far this period), Programmed (remaining recurring not yet
// matched to a real entry), Expected (the YTD rate, pro-rated to just the
// days left) — chosen specifically so Actual + Programmed + Expected always
// sums to what's left in the period, matching the same three numbers the
// category's own drill-down now shows (see renderProjectionSplit_ and
// renderProjectionDrilldownAmount_, below). An override replaces
// Programmed/Expected with one "Manually set" remaining line, same as the
// drill-down. Income has no Expected line at all — see the per-category
// rule in CLAUDE.md, it's never had a YTD-rate concept to pro-rate.
//
// Each line reads icon, then amount, then label — left-aligned under the
// category name rather than spread to the row's own right edge (changed
// 2026-09-16) — with many categories stacked for a general overview, an
// icon of fixed width puts every line's amount at the same horizontal
// position regardless of which category it's under, so the actual/
// programmed/expected FIGURES themselves are what lines up down the
// page, not just each row's own label/total pairing.
function projectionRowLine_(icon, amount, label) {
  return `<div><span class="projection-line-icon">${icon}</span><span class="projection-line-amount">${formatPen(amount)}</span><span class="projection-line-label">${label}</span></div>`;
}

function projectionRowBreakdown_(c) {
  const isIncome = c.category_type === "income";
  const lines = [projectionRowLine_("✅", c.actualPen, tr("projections.actual"))];
  if (c.hasOverride) {
    lines.push(projectionRowLine_("✏️", c.remainingTotalPen, tr("projections.remainingManual")));
  } else {
    lines.push(projectionRowLine_("🔁", c.programmedRemainingPen, tr("projections.programmed")));
    if (!isIncome) {
      lines.push(projectionRowLine_("📈", c.expectedRemainingPen, tr("projections.expected")));
    }
  }
  return lines.join("");
}

async function refreshProjectionCategories() {
  const list = document.getElementById("projections-categories-list");
  const cacheKey = projectionsCacheKey_();
  const cached = loadProjectionsCache_(cacheKey, "categories");
  if (cached) renderProjectionCategories_(cached);
  else list.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;

  let result;
  setProjectionsUpdating_(true);
  try {
    result = await callApi("listCategoryProjections", projectionPeriodPayload_());
  } catch (err) {
    if (!cached) list.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
    return;
  } finally {
    setProjectionsUpdating_(false);
  }
  // The owner moved to another period while this was loading.
  if (cacheKey !== projectionsCacheKey_()) return;
  saveProjectionsCache_(cacheKey, "categories", result);
  renderProjectionCategories_(result);
}

function renderProjectionCategories_(result) {
  const list = document.getElementById("projections-categories-list");
  const emptyNote = document.getElementById("projections-categories-empty-note");
  const categories = result.categories;
  list.innerHTML = "";
  emptyNote.hidden = categories.length > 0;

  categories.forEach((c) => {
    const isIncome = c.category_type === "income";
    const row = document.createElement("div");
    row.className = "recurring-row projection-row-expanded";
    row.innerHTML = `
      <div class="projection-row-top">
        <div class="recurring-row-name">${c.category_icon ? c.category_icon + " " : ""}${escapeHtml(c.category_name)}</div>
        <div class="recurring-row-amount${isIncome ? " income" : ""}">${isIncome ? "+" : ""}${formatPen(c.totalPen)}</div>
      </div>
      <div class="projection-row-breakdown">${projectionRowBreakdown_(c)}</div>
    `;
    row.addEventListener("click", () => openCategoryProjectionDrilldown_(c));
    list.appendChild(row);
  });
}

// Month/Year only, mirroring the backend's own projectionPeriodBounds_
// fallback (All-time/Custom project as the current month server-side, so
// there's nothing period-specific to reflect for them here either).
function projectionBoundsForDisplay_() {
  if (periodType === "year") {
    const y = periodAnchor.getFullYear();
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: String(y), periodType: "yearly" };
  }
  const mb = monthBounds(periodAnchor);
  return { startDate: mb.startDate, endDate: mb.endDate, label: mb.label, periodType: "monthly" };
}

async function openCategoryProjectionDrilldown_(categoryProjection) {
  currentDrilldown = { refetch: () => openCategoryProjectionDrilldown_(categoryProjection) };
  drilldownBudget = null;
  drilldownProjection = categoryProjection;
  drilldownProjectionDetail = null;
  // Lets the owner browse to a different month/year without closing the
  // drill-down first — same movePeriod the main selector's own arrows use,
  // just reloading this open drill-down afterward instead of only the
  // background list. All-time/Custom have no "next" to move to here
  // either (Projections falls back to the current month for both,
  // server-side), same as the main selector hiding its own arrows then.
  const navVisible = periodType === "month" || periodType === "year";
  document.getElementById("drilldown-period-prev").hidden = !navVisible;
  document.getElementById("drilldown-period-next").hidden = !navVisible;
  document.getElementById("drilldown-menu-btn").hidden = true;
  document.getElementById("drilldown-menu").hidden = true;
  document.getElementById("drilldown-categories").hidden = true;
  document.getElementById("drilldown-chart").hidden = true;
  document.getElementById("drilldown-chart-svg").innerHTML = "";
  document.getElementById("drilldown-chart-legend-2").textContent = tr("drill.projectedLegend");
  document.getElementById("drilldown-projection-row").hidden = true;   // only shown for a hand-set figure, once the detail has loaded
  document.getElementById("drilldown-projection-amount").textContent = "…";
  ["drilldown-projection-actual-row", "drilldown-projection-annual-note", "drilldown-projection-total-row"].forEach((id) => { document.getElementById(id).hidden = true; });
  document.getElementById("drilldown-projection-override-note").hidden = true;
  document.getElementById("drilldown-projection-split").hidden = true;
  document.getElementById("drilldown-projection-programmed-detail").hidden = true;
  document.getElementById("drilldown-projection-expected-detail").hidden = true;

  const bounds = projectionBoundsForDisplay_();
  const payload = {
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    type: categoryProjection.category_type,
    categoryId: categoryProjection.category_id
  };

  // Both requests start together (the chart/detail one is not awaited), so the
  // wait is the slower of the two rather than their sum.
  loadAndRenderProjectionChart_(categoryProjection);
  await openDrilldownWithPayload_(
    payload,
    `${categoryProjection.category_icon ? categoryProjection.category_icon + " " : ""}${categoryProjection.category_name}`,
    `${bounds.label} · ${tr("drill.projectedLegend")}`
  );
}

// Fetches this category's projection detail (breakdown + daily actual
// series) for whatever period the shared selector is showing, and draws
// the chart — kept separate from the entries fetch above (and not
// awaited there) so a slow/failed chart never blocks the transaction
// list from showing, same reasoning as loadAndRenderBudgetChart_.
async function loadAndRenderProjectionChart_(categoryProjection) {
  const chartEl = document.getElementById("drilldown-chart");
  try {
    const detail = await callApi(
      "getCategoryProjectionDetail",
      Object.assign({ categoryId: categoryProjection.category_id }, projectionPeriodPayload_())
    );
    // The drill-down may have been closed, or moved on to a different
    // category, while this was in flight.
    if (!drilldownProjection || drilldownProjection.category_id !== categoryProjection.category_id) return;
    drilldownProjectionDetail = detail;
    renderProjectionChart_(detail);
    renderProjectionDrilldownAmount_(detail);
    chartEl.hidden = false;
  } catch (err) {
    chartEl.hidden = true;
  }
}

// "Projected remaining" — redesigned 2026-09-16 so it's a plain sum of
// the two lines below it (Programmed remaining + Expected remaining)
// rather than a separate "total minus actual" subtraction computed here
// in JS — the backend now does this once (remainingTotalPen in
// computeAllCategoryProjections_) so the three numbers can never drift
// apart the way "the trace lines say one thing, the total says another"
// used to be possible if this math and that math diverged. An override
// still replaces it outright (remainingTotalPen already accounts for
// that server-side: max(0, override − actual so far)). Tapping it still
// opens the override editor for the FULL period's total (`amountPen`,
// unchanged), not this remaining figure — see openProjectionOverrideModal_.
function renderProjectionDrilldownAmount_(detail) {
  const p = detail.projection;
  // Merged with Expected (owner, 2026-10-21): "Projected remaining" was just Programmed + Expected, so with nothing programmed it repeated Expected.
  // Now Actual + Programmed + Expected = Total, and the Total row is the one you tap to set a figure by hand. Only a hand-set figure
  // (which replaces Programmed and Expected) still gets its own "✏️ Remaining · Manually set" row, the same words as the By-category list.
  document.getElementById("drilldown-projection-row").hidden = !p.hasOverride;
  document.getElementById("drilldown-projection-remaining-label").textContent = "✏️ " + tr("projections.remainingManual");
  document.getElementById("drilldown-projection-amount").textContent = formatPen(p.remainingTotalPen);
  document.getElementById("drilldown-projection-override-note").hidden = true;

  // Actual, what is left, and their sum: so the numbers add up where they can be seen.
  document.getElementById("drilldown-projection-actual-row").hidden = false;
  document.getElementById("drilldown-projection-actual-amount").textContent = formatPen(p.actualPen);
  const annualNote = document.getElementById("drilldown-projection-annual-note");
  annualNote.hidden = !(p.annualInPeriodPen > 0.005);
  annualNote.textContent = p.annualInPeriodPen > 0.005 ? tr("drill.annualAside", { amount: formatPen(p.annualInPeriodPen) }) : "";
  document.getElementById("drilldown-projection-total-row").hidden = false;
  document.getElementById("drilldown-projection-total-amount").textContent = formatPen(p.totalPen);

  renderProjectionSplit_(detail);
}

// "Programmed" (recurring, not yet matched to a real entry) vs.
// "expected" (the year-to-date rate, pro-rated to the days actually left)
// — redesigned 2026-09-16 so both are genuinely forward-looking and sum
// to "Projected remaining" above, instead of being the FULL period's
// total regardless of what's already happened. Shown for expense/
// investment whenever not manually overridden (an override already
// replaces both with one clear figure above it) — even a 0 is worth
// showing now, since "Programmed: PEN 0.00" is itself the answer to
// "did it already recognize I paid this?". Both trace back on tap:
// "Programmed" expands to the still-outstanding recurring items (see
// computeCategoryProgrammedBreakdown_, which now excludes anything
// already matched to a confirmed entry), "Expected" expands to the same
// month-by-month YTD breakdown as before, PLUS a bridge line showing how
// the full monthly rate gets pro-rated down to just the remaining days.
//
// Income still gets "Programmed" (fixed 2026-09-22 — it was being hidden
// entirely, along with Expected, by one shared gate) since a recurring
// income item not yet matched to a real entry is exactly as real a
// figure as it is for an expense/investment category, and the "By
// category" row above this drill-down already shows it. Income just
// never gets "Expected" — its second bucket isn't a year-to-date GUESS
// the way expense/investment's is (see CLAUDE.md's per-category rule),
// so that one row/trace-back stays hidden for income specifically,
// rather than showing a meaningless "PEN 0.00" next to a real figure.
function renderProjectionSplit_(detail) {
  const p = detail.projection;
  const splitEl = document.getElementById("drilldown-projection-split");
  const isIncome = p.category_type === "income";
  const show = !p.hasOverride;
  splitEl.hidden = !show;
  document.getElementById("drilldown-projection-programmed-detail").hidden = true;
  document.getElementById("drilldown-projection-expected-detail").hidden = true;
  document.getElementById("drilldown-projection-expected-row").hidden = isIncome;
  // Which predictor this category uses (its own choice or the default) — with a way to change it.
  document.getElementById("drilldown-projection-method-row").hidden = isIncome;
  if (!isIncome) {
    document.getElementById("drilldown-projection-method-label").textContent =
      tr("projections.methodRow", { name: projectionMethodLabel_(p.method) + (p.methodIsOwn ? "" : tr("pmm.defaultTag")) });
  }
  if (!show) return;

  document.getElementById("drilldown-projection-programmed-amount").textContent = formatPen(p.programmedRemainingPen);

  const programmedItemsEl = document.getElementById("drilldown-projection-programmed-items");
  const programmed = detail.programmedBreakdown;
  programmedItemsEl.innerHTML = (programmed && programmed.items.length)
    ? programmed.items.map((item) => `
      <div class="projection-month-row">
        <span>${escapeHtml(item.description || p.category_name)}${item.occurrences > 1 ? ` · ${item.occurrences}×` : ""}</span>
        <span>${formatPen(item.amountPen)}</span>
      </div>
    `).join("")
    : `<div class="projection-month-row"><span>${escapeHtml(tr("projections.nothingOutstanding"))}</span></div>`;

  if (isIncome) return; // no Expected row/YTD breakdown to trace for income

  document.getElementById("drilldown-projection-expected-amount").textContent = formatPen(p.expectedRemainingPen);

  const breakdown = detail.ytdBreakdown;
  const formulaEl = document.getElementById("drilldown-projection-expected-formula");
  const monthsEl = document.getElementById("drilldown-projection-expected-months");
  // Seasonality: when past years show this time of year runs noticeably above
  // or below an average month, the "× days left" line says so and shows the
  // adjusted sum instead of the plain one (see "Seasonality" in Projections.gs).
  const lastYearMethod = p.methodUsed === "last_year";
  const seasonal = !lastYearMethod && p.seasonalYears > 0 && Math.abs(p.seasonalFactor - 1) >= 0.03;
  // "months left": every remaining day counts 1 / (the days of ITS month), so a
  // whole month is always 1 — whether it has 28 days or 31.
  const monthsLeftText = (p.monthsLeft || 0).toFixed(2);
  const prorationLine = () => {
    if (lastYearMethod) return tr("projections.formulaLastYear", { year: p.lastYearYear, base: formatPen(p.baseAmountPen), amount: formatPen(p.expectedRemainingPen) });
    if (!seasonal) return tr("projections.formulaProrated", { rate: formatPen(p.levelPerMonth), months: monthsLeftText, n: p.daysLeft, amount: formatPen(p.expectedRemainingPen) });
    return tr(p.seasonalFactor > 1 ? "projections.seasonHigh" : "projections.seasonLow", {
      pct: Math.round(Math.abs(p.seasonalFactor - 1) * 100),
      years: (p.seasonalYearList || []).join(", "),
      level: formatPen(p.levelPerMonth),
      factor: p.seasonalFactor.toFixed(2),
      months: monthsLeftText,
      n: p.daysLeft,
      amount: formatPen(p.expectedRemainingPen)
    });
  };
  if (!breakdown || !breakdown.monthsElapsed) {
    formulaEl.textContent = tr("projections.notEnoughHistory");
    monthsEl.innerHTML = "";
    return;
  }

  // The window is the last 12 complete months, so it can cross a year: "Nov 2025".
  const monthLabel = (monthKey) => `${MONTH_NAMES_SHORT[parseInt(monthKey.slice(5, 7), 10) - 1]} ${monthKey.slice(0, 4)}`;
  const firstMonth = monthLabel(breakdown.months[0].monthKey);
  const lastMonth = monthLabel(breakdown.months[breakdown.months.length - 1].monthKey);
  const span = breakdown.months.length === 1 ? firstMonth : `${firstMonth}–${lastMonth}`;
  // The bridge (added 2026-09-16): the month-by-month table below still
  // explains the full monthly RATE, unchanged — this second line is what
  // turns that rate into the "Expected" figure actually shown above,
  // pro-rated down to just the days left in the period being viewed
  // (daysLeft — the same count the chart's own "N days left" caption
  // uses) instead of a full month's worth on top of whatever's already
  // happened.
  formulaEl.innerHTML = `
    ${p.methodFallback ? `<div style="margin-bottom:4px;">${escapeHtml(tr("projections.methodFallback", { method: projectionMethodLabel_(p.method), used: projectionMethodLabel_(p.methodUsed) }))}</div>` : ""}
    <div>${escapeHtml(lastYearMethod ? tr("projections.formulaBasedLastYear", { year: p.lastYearYear }) : tr("projections.formulaBased", { total: formatPen(breakdown.totalPen), n: breakdown.monthsElapsed, span, rate: formatPen(breakdown.ratePerMonth) }))}</div>
    <div style="margin-top:4px;">${escapeHtml(prorationLine())}</div>
    ${breakdown.annualExcludedCount > 0 ? `<div style="margin-top:4px;">${escapeHtml(tr("projections.annualLeftOut", { amount: formatPen(breakdown.annualExcludedPen), n: breakdown.annualExcludedCount }))}</div>` : ""}
  `;

  monthsEl.innerHTML = breakdown.months.map((m) => `
    <div class="projection-month-row">
      <span>${monthLabel(m.monthKey)}</span>
      <span>${formatPen(m.amountPen)}</span>
    </div>
  `).join("");
}

document.getElementById("drilldown-projection-programmed-row").addEventListener("click", () => {
  const detailEl = document.getElementById("drilldown-projection-programmed-detail");
  detailEl.hidden = !detailEl.hidden;
});

document.getElementById("drilldown-projection-expected-row").addEventListener("click", () => {
  const detailEl = document.getElementById("drilldown-projection-expected-detail");
  detailEl.hidden = !detailEl.hidden;
});

["drilldown-projection-row", "drilldown-projection-total-row"].forEach((id) => document.getElementById(id).addEventListener("click", () => {
  if (!drilldownProjection || !drilldownProjectionDetail) return;
  openProjectionOverrideModal_(drilldownProjection, drilldownProjectionDetail);
}));

// ---- Projection method picker (2026-10-19) ----
// The owner chooses what predicts his expenses best: six presets + custom, a
// default for every category, a choice per category, "use this for every
// category", and a replay of the last 12 months showing which would have been
// closest (see ProjectionMethods.gs). Nothing here computes a forecast; it only
// chooses and explains.
const PROJECTION_PRESET_IDS = ["balanced", "steady", "recent", "seasonal", "last_year", "ytd"];
let projectionDefaultMethod = "balanced";
let pmmState = null;   // { categoryId, categoryName, defaultMethod, selected }

function projectionMethodLabel_(id) {
  if (PROJECTION_PRESET_IDS.includes(id)) return tr("projMethod." + id + ".name");
  const m = /^custom:(\d+):(\d+)$/.exec(id || "");
  if (m) return Number(m[2]) === 0 ? tr("projMethod.customLabelNoSeason", { months: m[1] }) : tr("projMethod.customLabel", { months: m[1], n: Number(m[2]) });
  return tr("projMethod.balanced.name");
}

function pmmIsCustom_(id) { return /^custom:/.test(id || ""); }

function pmmCustomId_() {
  return `custom:${document.getElementById("pmm-window").value}:${document.getElementById("pmm-years").value}`;
}

function renderPmmOptions_() {
  const box = document.getElementById("pmm-options");
  box.innerHTML = "";
  const rows = [];
  if (pmmState.categoryId) rows.push({ id: "", name: tr("pmm.useDefault", { name: projectionMethodLabel_(pmmState.defaultMethod) }), desc: "" });
  PROJECTION_PRESET_IDS.forEach((id) => rows.push({ id, name: tr("projMethod." + id + ".name"), desc: tr("projMethod." + id + ".desc") }));
  rows.push({ id: "custom", name: tr("projMethod.custom.name"), desc: tr("projMethod.custom.desc") });
  rows.forEach((row) => {
    const selected = row.id === "custom" ? pmmIsCustom_(pmmState.selected) : row.id === pmmState.selected;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pmm-option" + (selected ? " selected" : "");
    btn.innerHTML = `<div class="pmm-option-name">${escapeHtml(row.name)}</div>${row.desc ? `<div class="pmm-option-desc">${escapeHtml(row.desc)}</div>` : ""}`;
    btn.addEventListener("click", () => {
      pmmState.selected = row.id === "custom" ? pmmCustomId_() : row.id;
      renderPmmOptions_();
    });
    box.appendChild(btn);
  });
  document.getElementById("pmm-custom").hidden = !pmmIsCustom_(pmmState.selected);
  document.getElementById("pmm-apply-all").hidden = !!pmmState.categoryId;
}

function fillPmmSelects_(customId) {
  const m = /^custom:(\d+):(\d+)$/.exec(customId || "");
  const win = document.getElementById("pmm-window");
  const years = document.getElementById("pmm-years");
  win.innerHTML = [3, 6, 12, 24].map((n) => `<option value="${n}">${escapeHtml(tr("pmm.windowOption", { n }))}</option>`).join("");
  years.innerHTML = [0, 1, 2, 3, 5].map((n) => `<option value="${n}">${escapeHtml(n === 0 ? tr("pmm.seasonNone") : tr("pmm.seasonYears", { n }))}</option>`).join("");
  win.value = m ? m[1] : "12";
  years.value = m ? m[2] : "3";
}

// opts: { categoryId?, categoryName?, ownMethod? ("" = uses the default) }
async function openProjectionMethodModal_(opts) {
  let settings;
  try {
    settings = await callApi("getProjectionMethodSettings");
  } catch (err) {
    alert(tr("drill.loadFailed", { error: err.message }));
    return;
  }
  projectionDefaultMethod = settings.defaultMethod;
  const categoryId = opts && opts.categoryId ? opts.categoryId : "";
  pmmState = {
    categoryId,
    categoryName: categoryId ? opts.categoryName : "",
    defaultMethod: settings.defaultMethod,
    selected: categoryId ? (settings.overrides[categoryId] || "") : settings.defaultMethod
  };
  document.getElementById("pmm-title").textContent = categoryId ? tr("pmm.titleCategory", { name: pmmState.categoryName }) : tr("pmm.title");
  document.getElementById("pmm-hint").textContent = categoryId ? tr("pmm.hintCategory") : tr("pmm.hintGlobal");
  document.getElementById("pmm-error").textContent = "";
  document.getElementById("pmm-compare-results").hidden = true;
  document.getElementById("pmm-apply-best").hidden = true;
  document.getElementById("pmm-apply-best-result").textContent = "";
  fillPmmSelects_(pmmState.selected);
  renderPmmOptions_();
  const backdrop = document.getElementById("pm-modal-backdrop-method");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeProjectionMethodModal_() {
  document.getElementById("pm-modal-backdrop-method").hidden = true;
  pmmState = null;
}

// After a method changed: redraw Projections and, if a category's detail is open, reload it.
async function afterProjectionMethodChange_() {
  const reopen = drilldownProjection && currentDrilldown && currentDrilldown.refetch ? currentDrilldown.refetch : null;
  refreshProjectionsScreen();
  if (reopen) reopen();
}

document.getElementById("projections-method-btn").addEventListener("click", () => openProjectionMethodModal_({}));
document.getElementById("drilldown-projection-method-btn").addEventListener("click", () => {
  if (!drilldownProjection) return;
  openProjectionMethodModal_({ categoryId: drilldownProjection.category_id, categoryName: drilldownProjection.category_name });
});
document.getElementById("pmm-close").addEventListener("click", closeProjectionMethodModal_);
document.getElementById("pm-modal-backdrop-method").addEventListener("click", (e) => {
  if (e.target.id === "pm-modal-backdrop-method") closeProjectionMethodModal_();
});
["pmm-window", "pmm-years"].forEach((id) => document.getElementById(id).addEventListener("change", () => {
  if (pmmState && pmmIsCustom_(pmmState.selected)) pmmState.selected = pmmCustomId_();
}));

document.getElementById("pmm-save").addEventListener("click", async () => {
  if (!pmmState) return;
  const errorEl = document.getElementById("pmm-error");
  errorEl.textContent = "";
  try {
    const payload = pmmState.categoryId ? { categoryId: pmmState.categoryId, method: pmmState.selected } : { method: pmmState.selected };
    await callApi("setProjectionMethod", payload);
    closeProjectionMethodModal_();
    afterProjectionMethodChange_();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("pmm-apply-all").addEventListener("click", async () => {
  if (!pmmState || pmmState.categoryId) return;
  if (!confirm(tr("pmm.applyAllConfirm", { name: projectionMethodLabel_(pmmState.selected) }))) return;
  try {
    await callApi("applyProjectionMethodToAll", { method: pmmState.selected });
    closeProjectionMethodModal_();
    afterProjectionMethodChange_();
  } catch (err) {
    document.getElementById("pmm-error").textContent = err.message;
  }
});

function pmmPct_(x) { return Math.round(x * 100); }

// "Which would have worked best for me?" — one category (from its own screen)
// or every category (from the main one).
document.getElementById("pmm-compare-btn").addEventListener("click", async () => {
  if (!pmmState) return;
  const btn = document.getElementById("pmm-compare-btn");
  const results = document.getElementById("pmm-compare-results");
  const table = document.getElementById("pmm-compare-table");
  const cats = document.getElementById("pmm-compare-cats");
  const applyBest = document.getElementById("pmm-apply-best");
  const categoryId = pmmState.categoryId;
  btn.disabled = true;
  results.hidden = false;
  table.innerHTML = `<div class="status-msg">${escapeHtml(tr("common.loading"))}</div>`;
  cats.innerHTML = "";
  applyBest.hidden = true;
  document.getElementById("pmm-apply-best-result").textContent = "";
  try {
    const res = await callApi("compareProjectionMethods", categoryId ? { categoryId } : {});
    document.getElementById("pmm-compare-hint").textContent = tr("pmm.compareHint", { n: res.monthsBack });
    const nameOf = projectionMethodLabel_;
    const row = (m, bestId, inUseId) => `
      <div class="pmm-table-row${m.id === bestId ? " best" : ""}">
        <span>${escapeHtml(nameOf(m.id))}${m.id === bestId ? `<span class="pmm-badge">${escapeHtml(tr("pmm.bestBadge"))}</span>` : ""}${m.id === inUseId ? `<span class="pmm-badge">${escapeHtml(tr("pmm.currentBadge"))}</span>` : ""}</span>
        <span>${m.errorPct == null || (m.months != null && m.months < res.minMonths) ? escapeHtml(tr("pmm.noData")) : escapeHtml(tr("pmm.errorValue", { pct: pmmPct_(m.errorPct) }))}</span>
      </div>`;
    if (categoryId) {
      const c = res.categories[0];
      if (!c || !c.enough) {
        table.innerHTML = `<p class="hint">${escapeHtml(tr("pmm.notEnough", { n: res.minMonths }))}</p>`;
        return;
      }
      table.innerHTML = c.methods.map((m) => row(m, c.best, c.current)).join("");
      if (c.best !== c.current) {
        const use = document.createElement("button");
        use.type = "button";
        use.className = "add-inline";
        use.textContent = tr("pmm.useThis", { name: nameOf(c.best) });
        use.addEventListener("click", async () => {
          try {
            await callApi("setProjectionMethod", { categoryId, method: c.best === res.defaultMethod ? "" : c.best });
            closeProjectionMethodModal_();
            afterProjectionMethodChange_();
          } catch (err) {
            document.getElementById("pmm-error").textContent = err.message;
          }
        });
        cats.appendChild(use);
      }
      return;
    }
    // Every category: the overall picture, then who would gain by switching.
    if (!res.overall.length) {
      table.innerHTML = `<p class="hint">${escapeHtml(tr("pmm.notEnough", { n: res.minMonths }))}</p>`;
      return;
    }
    const sorted = res.overall.slice().sort((a, b) => a.errorPct - b.errorPct);
    table.innerHTML = `<p class="hint">${escapeHtml(tr("pmm.bestOverall", { name: nameOf(res.overallBest), pct: pmmPct_(sorted[0].errorPct) }))}</p>` +
      sorted.map((m) => row(m, res.overallBest, res.defaultMethod)).join("");
    const gainers = res.categories.filter((c) => c.enough && c.best && c.best !== c.current && c.gain >= 0.05);
    cats.innerHTML = gainers.map((c) => `<div class="pmm-cat-row">${escapeHtml(tr("pmm.catSuggestion", { name: c.category_name, best: nameOf(c.best), current: nameOf(c.current), pct: pmmPct_(c.gain) }))}</div>`).join("");
    applyBest.hidden = gainers.length === 0;
  } catch (err) {
    table.innerHTML = `<div class="status-msg">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</div>`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("pmm-apply-best").addEventListener("click", async () => {
  if (!pmmState) return;
  if (!confirm(tr("pmm.useBestEachConfirm"))) return;
  const resultEl = document.getElementById("pmm-apply-best-result");
  try {
    const res = await callApi("applyBestProjectionMethods");
    document.getElementById("pmm-apply-best").hidden = true;
    resultEl.textContent = res.changed.length ? tr("pmm.applied", { n: res.changed.length }) : tr("pmm.appliedNone");
    afterProjectionMethodChange_();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

// Draws actual cumulative spend for the category (solid, through today —
// same truncation rule as the budget chart) against a straight
// "convergence" line from today's actual total to the full period's
// projected total, rather than a recurring-aware staircase (there's no
// schedule to trace here, just one number to reach by period end).
function renderProjectionChart_(detail) {
  const bounds = detail.bounds;
  const days = enumeratePeriodDates_(bounds.startDate, bounds.endDate);
  const n = days.length;

  let running = 0;
  const actualPoints = days.map((d) => {
    running += (detail.dailyActualPen && detail.dailyActualPen[d]) || 0;
    return running;
  });

  const todayStr = todayLocalISO();
  const actualEndIdx = todayStr < bounds.startDate ? -1 : (todayStr > bounds.endDate ? n - 1 : days.indexOf(todayStr));
  const actualSoFar = actualEndIdx >= 0 ? actualPoints[actualEndIdx] : 0;
  // The dashed "Projected" line's endpoint, the target line, and the
  // caption below all now match "Projected remaining" exactly (redesigned
  // 2026-09-16): actual so far plus what's genuinely still expected
  // (Programmed + Expected, pro-rated to the days left) — not the old
  // flat full-period figure, which could visibly disagree with the
  // Programmed/Expected/Projected-remaining rows shown right below the
  // chart once those switched to the same remaining-based math.
  const projectedTotal = actualSoFar + detail.projection.remainingTotalPen;
  const startIdx = Math.max(actualEndIdx, 0);
  const convergenceTarget = Math.max(projectedTotal, actualSoFar);

  // The dashed line used to be one straight segment from today's actual
  // to the period-end target — implying spend arrives in one smooth,
  // even drip. It's really two different things: a known "Programmed"
  // item lands on its own real calendar day (a bump), while everything
  // else in between is a smooth guess. Built as a vertex per
  // still-outstanding occurrence — a flat ramp up to its day, then a
  // vertical jump by that occurrence's own amount — ending on the exact
  // same `convergenceTarget` the flat reference line/caption already use,
  // so the two can never visually disagree. An occurrence at or before
  // today (overdue, still unmatched) clamps to today's own x position —
  // there's no "before today" on this line to place it on, so it shows
  // as an immediate jump right at the start instead. Degrades to the old
  // 2-point straight segment when there's nothing programmed left.
  //
  // Still bumps under a manual override (fixed 2026-09-22 — the first
  // version of this skipped bumps entirely whenever hasOverride, on the
  // theory that an override "replaces" Programmed/Expected. That's true
  // for what the ROW shows, but the backend still computes real
  // programmedBreakdown.occurrences regardless of an override — a known
  // recurring payment due on its own real calendar day doesn't stop
  // being real just because the owner overrode the period's TOTAL. The
  // smooth portion between bumps becomes "whatever's left of the
  // override after the known bumps" instead of the YTD rate — still
  // converges on the same override-derived `convergenceTarget` either
  // way, so this can't visually contradict the override note/caption.
  const p = detail.projection;
  const occurrences = (detail.programmedBreakdown && detail.programmedBreakdown.occurrences) || [];
  const programmedTotal = occurrences.reduce((sum, occ) => sum + occ.amountPen, 0);
  const daysLeft = Math.max(n - 1 - startIdx, 0);
  const smoothRemaining = p.hasOverride
    ? Math.max(0, convergenceTarget - actualSoFar - programmedTotal)
    : p.expectedRemainingPen;
  const expectedPerDay = daysLeft > 0 ? smoothRemaining / daysLeft : 0;

  const convergenceVertices = [[startIdx, actualSoFar]];
  let cumulativeProgrammed = 0;
  occurrences.forEach((occ) => {
    const idx = Math.max(days.indexOf(occ.date), startIdx);
    if (idx < 0) return;
    const cumulativeExpected = expectedPerDay * (idx - startIdx);
    convergenceVertices.push([idx, actualSoFar + cumulativeExpected + cumulativeProgrammed]);
    cumulativeProgrammed += occ.amountPen;
    convergenceVertices.push([idx, actualSoFar + cumulativeExpected + cumulativeProgrammed]);
  });
  convergenceVertices.push([n - 1, convergenceTarget]);

  const maxY = Math.max(projectedTotal, actualSoFar, ...actualPoints, 1) * 1.08;
  const W = 300, H = 130;
  const marginLeft = 34, marginTop = 8, marginBottom = 14;
  const plotRight = W, plotBottom = H - marginBottom;
  const plotWidth = plotRight - marginLeft;
  const plotHeight = plotBottom - marginTop;
  const xFor = (i) => marginLeft + (n <= 1 ? 0 : (i / (n - 1)) * plotWidth);
  const yFor = (v) => plotBottom - (v / maxY) * plotHeight;

  const actualPath = actualPoints
    .slice(0, actualEndIdx + 1)
    .map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`)
    .join(" ");
  const convergencePath = convergenceVertices.map(([i, v]) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const targetLineY = yFor(projectedTotal).toFixed(1);

  const axes = buildChartAxesSvg_(days, n, maxY, bounds.periodType, marginLeft, marginTop, plotRight, plotBottom, xFor, yFor);

  document.getElementById("drilldown-chart-svg").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${axes.gridlinesSvg}
      ${axes.axisBordersSvg}
      ${axes.yTicksSvg}
      ${axes.xTicksSvg}
      <line x1="${marginLeft}" y1="${targetLineY}" x2="${plotRight}" y2="${targetLineY}" style="stroke:var(--border);stroke-width:1" />
      <polyline points="${convergencePath}" style="fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3" />
      <polyline points="${actualPath}" style="fill:none;stroke:var(--accent);stroke-width:2" />
    </svg>
  `.trim();

  const note = document.getElementById("drilldown-chart-pace-note");
  if (actualEndIdx < 0) {
    note.textContent = tr("projections.notStarted");
  } else if (actualEndIdx >= n - 1) {
    note.textContent = tr("projections.ended");
  } else {
    const daysLeft = n - 1 - actualEndIdx;
    const remaining = Math.max(0, projectedTotal - actualSoFar);
    note.textContent = tr("projections.daysLeft", { amount: formatPen(remaining), n: daysLeft });
  }
}

// ---- Projections: editing a category's projected total ----

let projectionOverrideState = null; // { categoryId, periodKey, actualPen }
let projectionOverrideMode = "total"; // "total" | "remaining" — see setProjectionOverrideMode_

// An override is always stored as one number: the FULL period's total
// (setProjectionOverride's own `amount` — unchanged by this). "Remaining"
// mode is purely a second way to TYPE that same number — the input shows
// total − actualPen instead, and gets converted back to a total right
// before saving (see the save handler below) — because in practice it's
// often easier to think "I know I've got about PEN 300 left to spend
// this month" than to first do the arithmetic to a full-period total by
// hand. Switching tabs mid-edit converts whatever's currently typed
// instead of discarding it, so toggling back and forth never loses an
// in-progress edit.
function setProjectionOverrideMode_(newMode) {
  const input = document.getElementById("projection-override-value-input");
  const typed = parseFloat(input.value);
  if (!isNaN(typed) && projectionOverrideState) {
    const actual = projectionOverrideState.actualPen;
    const total = projectionOverrideMode === "total" ? typed : actual + typed;
    input.value = Math.max(0, newMode === "total" ? total : total - actual).toFixed(2);
  }
  projectionOverrideMode = newMode;
  document.querySelectorAll("#projection-override-mode-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === newMode);
  });
  document.getElementById("projection-override-mode-hint").textContent = newMode === "total"
    ? tr("projOverride.hintTotal", { actual: formatPen(projectionOverrideState.actualPen) })
    : tr("projOverride.hintRemaining", { actual: formatPen(projectionOverrideState.actualPen) });
}

document.querySelectorAll("#projection-override-mode-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setProjectionOverrideMode_(tab.dataset.mode));
});

function openProjectionOverrideModal_(categoryProjection, detail) {
  projectionOverrideState = {
    categoryId: categoryProjection.category_id,
    periodKey: detail.bounds.periodKey,
    actualPen: detail.projection.actualPen
  };
  document.getElementById("projection-override-modal-title").textContent = tr("projOverride.title");
  document.getElementById("projection-override-modal-subtitle").textContent =
    tr(detail.projection.hasOverride ? "projOverride.subtitleManual" : "projOverride.subtitleCalculated", { category: categoryProjection.category_name, amount: formatPen(detail.projection.amountPen) });
  document.getElementById("projection-override-value-input").value = detail.projection.amountPen.toFixed(2);
  document.getElementById("projection-override-form-error").textContent = "";
  document.getElementById("projection-override-reset-btn").hidden = !detail.projection.hasOverride;
  setProjectionOverrideMode_("total");

  const backdrop = document.getElementById("projection-override-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeProjectionOverrideModal_() {
  document.getElementById("projection-override-modal-backdrop").hidden = true;
  projectionOverrideState = null;
}

document.getElementById("projection-override-modal-close").addEventListener("click", closeProjectionOverrideModal_);
document.getElementById("projection-override-cancel-btn").addEventListener("click", closeProjectionOverrideModal_);
document.getElementById("projection-override-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "projection-override-modal-backdrop") closeProjectionOverrideModal_();
});

document.getElementById("projection-override-value-input").addEventListener("input", (e) => {
  const sanitized = sanitizeAmountInputValue(e.target.value);
  if (sanitized !== e.target.value) e.target.value = sanitized;
});

// Re-fetches whatever's currently visible that could show this number —
// the open drill-down's own chart/amount, the category list, and the top
// summary (all three otherwise would keep showing the pre-edit figure
// until the next unrelated refresh).
function refreshProjectionAfterOverrideChange_() {
  if (drilldownProjection) loadAndRenderProjectionChart_(drilldownProjection);
  refreshProjectionCategories();
  refreshProjections();
}

document.getElementById("projection-override-save-btn").addEventListener("click", async () => {
  if (!projectionOverrideState) return;
  const errorEl = document.getElementById("projection-override-form-error");
  errorEl.textContent = "";
  const typed = parseFloat(document.getElementById("projection-override-value-input").value);
  if (isNaN(typed) || typed < 0) {
    errorEl.textContent = tr("error.validAmount");
    return;
  }
  // The override is always stored as the full period's total, regardless
  // of which mode was used to type it — "remaining" mode is converted
  // back here, the one place it actually matters.
  const amount = projectionOverrideMode === "total" ? typed : projectionOverrideState.actualPen + typed;
  const saveBtn = document.getElementById("projection-override-save-btn");
  saveBtn.disabled = true;
  try {
    await callApi("setProjectionOverride", {
      categoryId: projectionOverrideState.categoryId,
      periodKey: projectionOverrideState.periodKey,
      amount
    });
    closeProjectionOverrideModal_();
    refreshProjectionAfterOverrideChange_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("projection-override-reset-btn").addEventListener("click", async () => {
  if (!projectionOverrideState) return;
  const { categoryId, periodKey } = projectionOverrideState;
  closeProjectionOverrideModal_();
  await callApi("deleteProjectionOverride", { categoryId, periodKey });
  refreshProjectionAfterOverrideChange_();
});

(function setupUpdateCheck() {
  const banner = document.getElementById("update-banner");
  let knownVersion = null;

  async function checkForUpdate() {
    try {
      const res = await fetch("version.json?cb=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      if (knownVersion === null) {
        knownVersion = data.version;
        return;
      }
      if (data.version !== knownVersion) {
        banner.textContent = tr("banner.update");   // re-set so a screen reader announces it
        banner.hidden = false;
        // Pushes the save-failed banner down below this one instead of
        // the two overlapping — both are position:fixed/top:0 (see
        // renderSaveFailedBanner_, which does the same check the other
        // way round for whichever banner appears second).
        renderSaveFailedBanner_();
      }
    } catch (err) {
      // Offline or a network hiccup — not worth surfacing, next check retries.
    }
  }

  banner.addEventListener("click", () => {
    saveEntryDraftNow_();   // a half-typed new entry survives the reload (restored at startup)
    location.href = location.pathname + "?cb=" + Date.now();
  });

  checkForUpdate();
  setInterval(checkForUpdate, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
})();

// ---- Loans (Phase 5.2) ----
// Read-only for now — net balance per friend, split into "owes you" /
// "you owe" by the sign of that net, plus tap-through to the friend's
// full loan history. Recording a new standalone loan, settlements, and
// forgiving a loan are later Phase 5 steps (see CLAUDE.md's Build phases
// table); this only reflects loans the split-entry UI already created.

async function refreshLoans() {
  const balances = await callApi("listLoanBalances", {});

  // A friend can be owed in one currency and owe in another (e.g. they owe
  // you PEN but you owe them USD), so each section takes only that
  // direction's currency lines and a friend can appear in both. Balances
  // stay in their own currency — nothing here converts. net_pen (from the
  // backend, null with no rate on file) is used only to order rows.
  const sectionFor = (sign) => balances
    .map((b) => {
      const lines = b.balances.filter((l) => sign * l.net > 0);
      const penSize = lines.reduce((sum, l) => sum + (l.net_pen == null ? 0 : Math.abs(l.net_pen)), 0);
      return { friend_id: b.friend_id, friend_name: b.friend_name, has_overdue: b.has_overdue, lines, penSize };
    })
    .filter((row) => row.lines.length)
    .sort((x, y) => y.penSize - x.penSize);

  const owedToMe = sectionFor(1);
  const iOwe = sectionFor(-1);

  renderLoanBalanceList_("loans-owed-to-me-list", "loans-owed-to-me-empty-note", owedToMe, "owed-to-me");
  renderLoanBalanceList_("loans-i-owe-list", "loans-i-owe-empty-note", iOwe, "i-owe");

  renderLoanTotals_("loans-owed-to-me-total-row", "loans-owed-to-me-total", owedToMe, "owed-to-me");
  renderLoanTotals_("loans-i-owe-total-row", "loans-i-owe-total", iOwe, "i-owe");
}

// "PEN 1,200.00" — the "+" only on the owed-to-you side, same convention
// as income elsewhere; never a "-" on the you-owe side, since the section
// already says the direction.
function formatLoanAmount_(currency, amount, kind) {
  return `${kind === "owed-to-me" ? "+" : ""}${currency} ${moneyFmt(Math.abs(amount))}`;
}

// One line per currency, PEN first (the backend already orders each
// friend's lines that way; totals get the same order here).
function sortCurrencies_(list) {
  return list.sort((a, b) => (a === homeCur() ? -1 : b === homeCur() ? 1 : a < b ? -1 : 1));
}

// Total per currency, summed from the exact per-friend lines shown
// underneath so it can never disagree with them.
function renderLoanTotals_(rowId, valueId, rows, kind) {
  const row = document.getElementById(rowId);
  row.hidden = rows.length === 0;
  if (!rows.length) return;

  const totals = {};
  rows.forEach((r) => r.lines.forEach((l) => {
    totals[l.currency] = (totals[l.currency] || 0) + Math.abs(l.net);
  }));
  document.getElementById(valueId).innerHTML = sortCurrencies_(Object.keys(totals))
    .map((cur) => `<div>${formatLoanAmount_(cur, totals[cur], kind)}</div>`)
    .join("");
}

function renderLoanBalanceList_(listId, emptyNoteId, rows, kind) {
  const list = document.getElementById(listId);
  const emptyNote = document.getElementById(emptyNoteId);
  list.innerHTML = "";

  if (rows.length === 0) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  rows.forEach((r) => {
    const amounts = r.lines.map((l) => `<div>${formatLoanAmount_(l.currency, l.net, kind)}</div>`).join("");
    const row = document.createElement("div");
    row.className = "loan-row";
    row.innerHTML = `
      <span class="loan-row-name">${r.has_overdue ? "⚠️ " : ""}${escapeHtml(r.friend_name)}</span>
      <span class="loan-row-amount ${kind}">${amounts}</span>
    `;
    row.addEventListener("click", () => openLoanDetail(r.friend_id, r.friend_name));
    list.appendChild(row);
  });
}

async function openLoanDetail(friendId, friendName) {
  // Same pattern every other drill-down uses (see openBudgetDrilldown,
  // openCategoryProjectionDrilldown_) — lets refreshAfterPopupEdit(),
  // below, reload this same friend's sheet after editing a linked
  // expense in the popup it opens, without this file needing to know
  // that a loan detail sheet is what triggered it.
  currentDrilldown = { refetch: () => openLoanDetail(friendId, friendName) };

  const loans = await callApi("getFriendLoanDetail", { friendId });
  document.getElementById("loan-detail-title").textContent = friendName;

  const outstanding = loans.filter((l) => l.status !== "forgiven" && l.remaining > 0.004);
  const netByCurrency = {};
  outstanding.forEach((l) => {
    if (!netByCurrency[l.currency]) netByCurrency[l.currency] = 0;
    netByCurrency[l.currency] += l.direction === "they_owe_me" ? l.remaining : -l.remaining;
  });
  const netParts = Object.keys(netByCurrency)
    .filter((cur) => Math.abs(netByCurrency[cur]) > 0.004)
    .map((cur) => {
      const n = netByCurrency[cur];
      return (n > 0 ? "+" : "") + `${cur} ${moneyFmt(n)}`;
    });
  document.getElementById("loan-detail-subtitle").textContent = netParts.length
    ? tr("loanDetail.net", { parts: netParts.join(" · ") })
    : tr("loanDetail.settled");

  // Friend-level, not per-loan — recordRepayment (Loans.gs) figures out
  // on its own which loan(s) an amount actually applies to (see
  // openRepaymentModal, below), so there's nothing left to pick here
  // beyond which currency, when there's more than one.
  const repayBtn = document.getElementById("record-repayment-btn");
  repayBtn.hidden = netParts.length === 0;
  repayBtn.onclick = () => openRepaymentModal(friendId, friendName, netByCurrency);

  const list = document.getElementById("loan-detail-list");
  const emptyNote = document.getElementById("loan-detail-empty-note");
  const paidToggle = document.getElementById("loan-detail-paid-toggle");
  const paidList = document.getElementById("loan-detail-paid-list");
  list.innerHTML = "";
  paidList.innerHTML = "";
  // Always starts collapsed — a friend with a long settled history
  // shouldn't reopen already expanded just because it was left open once.
  paidList.hidden = true;

  // "Pending" (still owed, not forgiven) vs. "Already paid" (fully repaid
  // or forgiven) — split into two sections (added 2026-09-22) so a long
  // history of settled loans doesn't bury the ones that still need
  // action. Already-paid stays collapsed behind its own toggle by
  // default, same reasoning.
  const pending = loans.filter((l) => l.status !== "forgiven" && l.remaining > 0.004);
  const alreadyPaid = loans.filter((l) => l.status === "forgiven" || l.remaining <= 0.004);

  if (loans.length === 0) {
    emptyNote.textContent = tr("loanDetail.empty");
    emptyNote.hidden = false;
  } else if (pending.length === 0) {
    emptyNote.textContent = tr("loanDetail.nothingPending");
    emptyNote.hidden = false;
  } else {
    emptyNote.hidden = true;
    pending.forEach((l) => list.appendChild(buildLoanDetailRow_(l, friendId, friendName)));
  }

  paidToggle.hidden = alreadyPaid.length === 0;
  paidToggle.textContent = tr("loanDetail.showPaid", { n: alreadyPaid.length });
  paidToggle.onclick = () => {
    const showing = !paidList.hidden;
    if (showing) {
      paidList.hidden = true;
      paidToggle.textContent = tr("loanDetail.showPaid", { n: alreadyPaid.length });
    } else {
      if (!paidList.children.length) {
        alreadyPaid.forEach((l) => paidList.appendChild(buildLoanDetailRow_(l, friendId, friendName)));
      }
      paidList.hidden = false;
      paidToggle.textContent = tr("loanDetail.hidePaid");
    }
  };

  const backdrop = document.getElementById("loan-detail-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

// Shared by openLoanDetail's two sections (pending / already paid) so a
// row looks and behaves identically in either — only which list it lands
// in differs.
function buildLoanDetailRow_(l, friendId, friendName) {
  const kind = l.direction === "they_owe_me" ? "owed-to-me" : "i-owe";
  const sign = l.direction === "they_owe_me" ? "+" : "";
  const statusNote = l.status === "forgiven"
    ? (l.forgiveness_entry_id ? tr("loanDetail.forgivenRecorded") : tr("loanDetail.forgiven"))
    : l.remaining <= 0.004
      ? tr("loanDetail.fullyRepaid")
      : [
          l.overdue ? tr("loanDetail.overdueSince", { date: l.due_date }) : "",
          l.settled > 0.004 ? tr("loanDetail.repaidSoFar", { cur: l.currency, amount: moneyFmt(l.settled) }) : ""
        ].filter(Boolean).join(" · ");

  // Every row is tappable, but to different places: a standalone cash
  // loan (origin='cash') opens the loan edit/delete form (5.3's own
  // modal); an entry-derived one (origin='entry') opens the actual
  // expense it came from, in the same edit pop-up Overview/Budgets/
  // Projections drill-downs already use — editing IT is what changes
  // the loan, since saveEntrySplits recalculates the loan from that
  // expense's own splits every time it's saved (see Loans.gs). There's
  // no "edit the loan row directly" for that case; it would just get
  // overwritten the next time the expense itself is touched.
  const row = document.createElement("div");
  row.className = "loan-detail-row editable";
  row.innerHTML = `
    <div class="loan-detail-row-top">
      <span class="loan-detail-row-desc">${escapeHtml(l.description || (l.origin === "entry" ? tr("loanDetail.sharedExpense") : tr("loan.word")))}<span class="loan-detail-row-chevron">›</span></span>
      <span class="loan-detail-row-amount ${kind}">${sign}${l.currency} ${moneyFmt(l.remaining > 0.004 ? l.remaining : l.amount)}</span>
    </div>
    <div class="loan-detail-row-meta">${l.date}${statusNote ? " · " + statusNote : ""}</div>
  `;
  if (l.origin === "cash") {
    row.addEventListener("click", () => openLoanModal(l, { id: friendId, name: friendName }));
  } else {
    row.addEventListener("click", () => openLinkedEntryFromLoan_(l.entry_id));
  }

  // Forgiving applies to either kind of loan — it doesn't touch the
  // loan's own amount/currency/etc (unlike editing), just marks it
  // written off, so it isn't restricted by origin the way editing is.
  // Not shown once nothing's left to forgive, or it's already
  // forgiven.
  if (l.status !== "forgiven" && l.remaining > 0.004) {
    const forgiveBtn = document.createElement("button");
    forgiveBtn.type = "button";
    forgiveBtn.className = "add-inline loan-detail-forgive-btn";
    forgiveBtn.textContent = tr("loanDetail.forgive");
    forgiveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openForgiveModal(l, { id: friendId, name: friendName });
    });
    row.appendChild(forgiveBtn);
  }

  return row;
}

// Loading state is brief enough (one small API call) not to need its own
// spinner — errEl reuses the same slot the rest of this sheet has none
// of, so a failure (e.g. the entry was since deleted some other way)
// shows up as a plain alert rather than silently doing nothing.
async function openLinkedEntryFromLoan_(entryId) {
  try {
    const entry = await callApi("getEntry", { id: entryId });
    if (!entry) throw new Error(tr("loanDetail.expenseNotFound"));
    if (blockedWhileSavingEdit_(entry.id)) return;
    openEditPopup(entry);
  } catch (err) {
    alert(err.message);
  }
}

function closeLoanDetail() {
  document.getElementById("loan-detail-modal-backdrop").hidden = true;
  currentDrilldown = null;
}

document.getElementById("loan-detail-modal-close").addEventListener("click", closeLoanDetail);
document.getElementById("loan-detail-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "loan-detail-modal-backdrop") closeLoanDetail();
});

// ---- Add / edit loan (Phase 5.3) ----
// A standalone cash loan — money lent/borrowed directly, not tied to any
// expense. Always lands as `origin: 'cash'` (see addLoan/updateLoan in
// Loans.gs), distinct from the loans the split-entry UI creates with
// `origin: 'entry'`, which aren't editable from here at all (see
// openLoanDetail's `editable` check, above) — those are edited by
// editing the expense itself.

let loanDirection = "they_owe_me";
let editingLoanId = null;
// Set when this modal was opened from a friend's loan-detail sheet, so a
// save/delete can refresh that sheet's contents too, not just the main
// Loans tab list underneath it.
let loanModalReturnFriend = null;

function populateLoanFriendOptions() {
  const select = document.getElementById("loan-friend");
  select.innerHTML = "";
  meta.friends.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    select.appendChild(opt);
  });
  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = tr("common.addFriend");
  select.appendChild(addOpt);
}

document.getElementById("loan-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt(tr("prompt.friendName"));
  e.target.value = meta.friends.length ? meta.friends[0].id : "";
  if (name && name.trim()) {
    const friend = await callApi("addFriend", { name: name.trim() });
    meta.friends.push(friend);
    refreshFriendChips_();
    populateLoanFriendOptions();
    document.getElementById("loan-friend").value = friend.id;
  }
});

function populateLoanPaymentMethodOptions() {
  const select = document.getElementById("loan-payment-method");
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = tr("form.noneAccount");
  select.appendChild(noneOpt);
  meta.paymentMethods.filter((pm) => !pmHidden_(pm)).forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });
}

function setLoanDirection_(direction) {
  loanDirection = direction;
  document.querySelectorAll("#loan-direction-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.direction === direction);
  });
}

document.querySelectorAll("#loan-direction-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setLoanDirection_(tab.dataset.direction));
});

// `loan` is null to add a new one, or an existing loan (from
// getFriendLoanDetail) to edit it. `returnFriend` is {id, name} when
// opened from that friend's detail sheet, so it can be refreshed after.
function openLoanModal(loan, returnFriend) {
  editingLoanId = loan ? loan.id : null;
  loanModalReturnFriend = returnFriend || null;

  document.getElementById("loan-modal-title").textContent = loan ? tr("loanModal.edit") : tr("loanModal.add");
  document.getElementById("loan-delete-btn").hidden = !loan;
  document.getElementById("loan-form-error").textContent = "";
  populateLoanFriendOptions();
  populateLoanPaymentMethodOptions();
  document.getElementById("loan-friend").value = loan ? loan.friend_id : (meta.friends.length ? meta.friends[0].id : "");
  setLoanDirection_(loan ? loan.direction : "they_owe_me");
  document.getElementById("loan-amount").value = loan ? loan.amount : "";
  document.getElementById("loan-currency").value = loan ? loan.currency : homeCur();
  renderCurrencyChips("loan");
  const entryDate = loan ? loan.date : todayLocalISO();
  document.getElementById("loan-date").value = entryDate;
  document.getElementById("loan-due-date").value = loan ? (loan.due_date || "") : defaultDueDate_(entryDate);
  document.getElementById("loan-payment-method").value = loan ? (loan.payment_method_id || "") : "";
  document.getElementById("loan-description").value = loan ? (loan.description || "") : "";

  const backdrop = document.getElementById("loan-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeLoanModal() {
  document.getElementById("loan-modal-backdrop").hidden = true;
  editingLoanId = null;
}

// After a save/delete: the main Loans list always refreshes, and if this
// modal was reached through a friend's detail sheet (still open
// underneath it), that gets refreshed too rather than left showing
// stale data.
async function refreshAfterLoanModalChange_() {
  refreshEntriesInBackground_();
  await refreshLoans();
  if (loanModalReturnFriend) {
    await openLoanDetail(loanModalReturnFriend.id, loanModalReturnFriend.name);
  }
}

document.getElementById("add-loan-btn").addEventListener("click", () => openLoanModal(null, null));
document.getElementById("loan-modal-close").addEventListener("click", closeLoanModal);
document.getElementById("loan-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "loan-modal-backdrop") closeLoanModal();
});

document.getElementById("loan-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("loan-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("loan-save-btn");

  try {
    const friendId = document.getElementById("loan-friend").value;
    const amount = parseFloat(document.getElementById("loan-amount").value);
    const currency = document.getElementById("loan-currency").value.toUpperCase();
    const date = document.getElementById("loan-date").value;
    const dueDate = document.getElementById("loan-due-date").value;
    const paymentMethodId = document.getElementById("loan-payment-method").value;
    const description = document.getElementById("loan-description").value.trim();

    if (!friendId || friendId === "__add__") throw new Error(tr("error.pickFriend"));
    if (!amount || amount <= 0) throw new Error(tr("error.validAmount"));
    if (!date) throw new Error(tr("error.dateRequired"));

    saveBtn.disabled = true;
    const fields = {
      friend_id: friendId,
      direction: loanDirection,
      amount,
      currency,
      date,
      due_date: dueDate,
      payment_method_id: paymentMethodId,
      description
    };
    if (editingLoanId) {
      await callApi("updateLoan", { id: editingLoanId, ...fields });
    } else {
      await callApi("addLoan", fields);
    }
    closeLoanModal();
    await refreshAfterLoanModalChange_();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("loan-delete-btn").addEventListener("click", async () => {
  if (!editingLoanId) return;
  const loanFriend = document.getElementById("loan-friend");
  const loanWho = loanFriend && loanFriend.selectedOptions[0] ? loanFriend.selectedOptions[0].textContent : "";
  const loanDesc = document.getElementById("loan-description").value.trim();
  const loanAmt = document.getElementById("loan-amount").value.trim();
  const loanCur = document.getElementById("loan-currency").value;
  if (!confirm(tr("loanModal.confirmDelete", { what: describeForConfirm_(loanDesc || loanWho, loanAmt ? `${loanCur} ${loanAmt}` : "", loanDesc && loanWho ? loanWho : "") }))) return;
  const errorEl = document.getElementById("loan-form-error");
  errorEl.textContent = "";

  try {
    await callApi("deleteLoan", { id: editingLoanId });
    closeLoanModal();
    await refreshAfterLoanModalChange_();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---- Settlements / repayments (Phase 5.4, consolidated 2026-09-17) ----
// Recording a repayment is friend-+-currency-level, not single-loan — the
// backend (recordRepayment in Loans.gs) works out on its own which
// loan(s) it applies to via a two-phase FIFO: first netting opposite-
// direction debt (e.g. a loan they gave you cancels against the oldest
// expenses you covered for them), then applying the real amount to
// whatever's left. Never touches Entries, income/expense totals, or
// budgets directly (per CLAUDE.md's Settlements section) — except for the
// one deliberate exception below (an overpayment becoming real income).

let repaymentFriendId = null;
let repaymentFriendName = null;
let repaymentNetByCurrency = {};
let repaymentCurrency = null;
// 'they_owe_me' or 'i_owe_them' — which debt this repayment pays down,
// always derived from the sign of the friend's net in the selected
// currency, never picked directly (see openRepaymentModal).
let repaymentDirection = null;
let editingSettlementId = null;
// Set only while the overpayment section is showing — the amount still
// needs a category before it can become a real income entry.
let pendingOverpay = null;

function populateSettlementPaymentMethodOptions() {
  const select = document.getElementById("settlement-payment-method");
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = tr("form.noneAccount");
  select.appendChild(noneOpt);
  meta.paymentMethods.filter((pm) => !pmHidden_(pm)).forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });
}

// `type` is "income" (they overpaid you) or "expense" (you overpaid
// them) — mirror images, see recordRepayment/createOverpaymentEntry_ in
// Loans.gs.
function populateOverpayCategoryOptions(type) {
  document.getElementById("settlement-overpay-category-label").textContent =
    tr("settle.categoryOf", { type: TYPE_LABELS[type].toLowerCase() });
  populateCategoryOptionsForSelect_("settlement-overpay-category", type);
}

function renderSettlementCurrencyChips_() {
  const container = document.getElementById("settlement-currency-chips");
  const currencies = Object.keys(repaymentNetByCurrency);
  container.hidden = currencies.length < 2;
  container.innerHTML = "";
  currencies.forEach((cur) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "currency-chip" + (cur === repaymentCurrency ? " active" : "");
    chip.innerHTML = `<span>${findCurrency(cur).flag}</span><span>${cur}</span>`;
    chip.addEventListener("click", () => switchRepaymentCurrency_(cur));
    container.appendChild(chip);
  });
}

function settlementFriendContext_() {
  const net = repaymentNetByCurrency[repaymentCurrency] || 0;
  const amount = Math.abs(net);
  return repaymentDirection === "they_owe_me"
    ? tr("settle.contextTheyOwe", { name: repaymentFriendName, cur: repaymentCurrency, amount: moneyFmt(amount) })
    : tr("settle.contextIOwe", { name: repaymentFriendName, cur: repaymentCurrency, amount: moneyFmt(amount) });
}

// Back to "add a new repayment" — the default state the form opens in,
// and where "Cancel edit" returns it to without closing the whole modal.
function resetSettlementForm_() {
  editingSettlementId = null;
  document.getElementById("settlement-save-btn").textContent = tr("settle.save");
  document.getElementById("settlement-cancel-edit-btn").hidden = true;
  document.getElementById("settlement-delete-btn").hidden = true;
  document.getElementById("settlement-form-error").textContent = "";
  document.getElementById("settlement-amount").value = Math.abs(repaymentNetByCurrency[repaymentCurrency] || 0).toFixed(2);
  document.getElementById("settlement-date").value = todayLocalISO();
  document.getElementById("settlement-payment-method").value = "";
  document.getElementById("settlement-form").hidden = false;
  document.getElementById("settlement-overpay-section").hidden = true;
  pendingOverpay = null;
}

function loadSettlementIntoForm_(s) {
  editingSettlementId = s.id;
  document.getElementById("settlement-save-btn").textContent = tr("settle.saveChanges");
  document.getElementById("settlement-cancel-edit-btn").hidden = false;
  document.getElementById("settlement-delete-btn").hidden = false;
  document.getElementById("settlement-form-error").textContent = "";
  document.getElementById("settlement-amount").value = s.amount;
  document.getElementById("settlement-date").value = s.date;
  document.getElementById("settlement-payment-method").value = s.payment_method_id || "";
}

function renderSettlementList_(settlements) {
  const list = document.getElementById("settlement-list");
  const emptyNote = document.getElementById("settlement-list-empty-note");
  list.innerHTML = "";

  if (settlements.length === 0) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  settlements.forEach((s) => {
    const pm = meta.paymentMethods.find((p) => p.id === s.payment_method_id);
    const row = document.createElement("div");
    const isOffset = !!s.offset_loan_id;
    row.className = "loan-detail-row" + (isOffset ? "" : " editable");

    const desc = isOffset
      ? tr("settle.offsetAgainst", { desc: escapeHtml(s.offset_loan_description) })
      : `${s.date}${pm ? " · " + escapeHtml(pm.nickname) : ""}`;

    row.innerHTML = `
      <div class="loan-detail-row-top">
        <span class="loan-detail-row-desc">${desc}${isOffset ? "" : '<span class="loan-detail-row-chevron">›</span>'}</span>
        <span class="loan-detail-row-amount i-owe">${repaymentCurrency} ${moneyFmt(s.amount)}</span>
      </div>
      <div class="loan-detail-row-meta">${escapeHtml(s.loan_description)}${isOffset ? " · " + s.date : ""}</div>
    `;
    if (!isOffset) {
      row.addEventListener("click", () => loadSettlementIntoForm_(s));
    }
    list.appendChild(row);
  });
}

async function refreshSettlementList_() {
  const settlements = await callApi("listSettlementsForFriendCurrency", {
    friendId: repaymentFriendId,
    currency: repaymentCurrency
  });
  renderSettlementList_(settlements);
}

async function switchRepaymentCurrency_(currency) {
  repaymentCurrency = currency;
  repaymentDirection = (repaymentNetByCurrency[currency] || 0) > 0 ? "they_owe_me" : "i_owe_them";
  renderSettlementCurrencyChips_();
  document.getElementById("settlement-friend-context").textContent = settlementFriendContext_();
  resetSettlementForm_();
  await refreshSettlementList_();
}

// `netByCurrency` comes straight from openLoanDetail's own already-loaded
// loan list (see there) — no extra fetch needed just to open this.
async function openRepaymentModal(friendId, friendName, netByCurrency) {
  repaymentFriendId = friendId;
  repaymentFriendName = friendName;
  repaymentNetByCurrency = netByCurrency;

  document.getElementById("settlement-modal-title").textContent = tr("transfer.kind.repayment");
  populateSettlementPaymentMethodOptions();

  const currencies = Object.keys(netByCurrency);
  await switchRepaymentCurrency_(currencies[0]);

  const backdrop = document.getElementById("settlement-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeSettlementModal() {
  document.getElementById("settlement-modal-backdrop").hidden = true;
  editingSettlementId = null;
  // Closed without picking a category for the extra: nothing is lost — the
  // server already saved it as a pending entry. Say so and show it.
  if (pendingOverpay) {
    const p = pendingOverpay;
    pendingOverpay = null;
    alert(tr(p.entryType === "income" ? "settle.extraSavedIncome" : "settle.extraSavedExpense", { cur: p.currency, amount: moneyFmt(p.amount) }));
    refreshReviewQueue().catch(() => {});
  }
}

async function refreshAfterSettlementChange_() {
  refreshEntriesInBackground_();
  await refreshLoans();
  await openLoanDetail(repaymentFriendId, repaymentFriendName);
}

document.getElementById("settlement-modal-close").addEventListener("click", closeSettlementModal);
document.getElementById("settlement-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "settlement-modal-backdrop") closeSettlementModal();
});
document.getElementById("settlement-cancel-edit-btn").addEventListener("click", resetSettlementForm_);

document.getElementById("settlement-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("settlement-form-error");
  errorEl.textContent = "";

  // Checked while the modal is still open, so a typo is shown right there.
  const amount = parseFloat(document.getElementById("settlement-amount").value);
  const date = document.getElementById("settlement-date").value;
  const paymentMethodId = document.getElementById("settlement-payment-method").value;
  if (!amount || amount <= 0) { errorEl.textContent = tr("error.validAmount"); return; }
  if (!date) { errorEl.textContent = tr("error.dateRequired"); return; }

  // Everything from here on runs after the modal has closed — the owner
  // doesn't sit and wait for the server. A failure is reported with an alert
  // (the modal is gone), and the lists are re-fetched so they show the truth.
  // Captured first: closing the modal resets the editing state.
  const settlementId = editingSettlementId;
  const friendId = repaymentFriendId;
  const friendName = repaymentFriendName;
  const direction = repaymentDirection;
  const currency = repaymentCurrency;
  closeSettlementModal();

  try {
    if (settlementId) {
      // Fixing a specific real settlement's own typo — doesn't re-run
      // FIFO, just corrects that one row (see updateSettlement in
      // Loans.gs).
      await callApi("updateSettlement", { id: settlementId, amount, date, payment_method_id: paymentMethodId });
      await refreshAfterSettlementChange_();
      return;
    }

    const result = await callApi("recordRepayment", {
      friend_id: friendId,
      direction,
      amount,
      currency,
      date,
      payment_method_id: paymentMethodId
    });

    refreshEntriesInBackground_();
    await refreshLoans();
    await openLoanDetail(friendId, friendName);

    if (result.overpaid > 0.004) {
      // Mirror images: they overpaying YOU is your income; YOU overpaying
      // them is your expense (paid_by: "me", no split — see
      // createOverpaymentEntry_ in Loans.gs). Needs the owner's category
      // pick, so the modal comes back, showing just that step.
      const isIncome = direction === "they_owe_me";
      pendingOverpay = { amount: result.overpaid, currency: result.currency, date, paymentMethodId, entryType: isIncome ? "income" : "expense" };
      document.getElementById("settlement-overpay-note").textContent = isIncome
        ? tr("settle.overpaidIncome", { name: friendName, cur: result.currency, amount: moneyFmt(result.overpaid) })
        : tr("settle.overpaidExpense", { name: friendName, cur: result.currency, amount: moneyFmt(result.overpaid) });
      populateOverpayCategoryOptions(pendingOverpay.entryType);
      document.getElementById("settlement-overpay-error").textContent = "";
      document.getElementById("settlement-form").hidden = true;
      document.getElementById("settlement-overpay-section").hidden = false;
      const backdrop = document.getElementById("settlement-modal-backdrop");
      bringModalToFront_(backdrop);
      backdrop.hidden = false;
    }
  } catch (err) {
    alert(tr("settle.saveFailed", { error: err.message }));
    refreshAfterSettlementChange_().catch(() => {});
  }
});

document.getElementById("settlement-delete-btn").addEventListener("click", async () => {
  if (!editingSettlementId) return;
  const repAmt = document.getElementById("settlement-amount").value.trim();
  const repDate = document.getElementById("settlement-date").value;
  if (!confirm(tr("settle.confirmDelete", { what: describeForConfirm_(repaymentFriendName || "", repAmt ? `${repaymentCurrency} ${repAmt}` : "", repDate) }))) return;

  // Closes first, finishes in the background (same as the save button).
  const settlementId = editingSettlementId;
  closeSettlementModal();
  try {
    await callApi("deleteSettlement", { id: settlementId });
    await refreshAfterSettlementChange_();
  } catch (err) {
    alert(tr("settle.saveFailed", { error: err.message }));
    refreshAfterSettlementChange_().catch(() => {});
  }
});

document.getElementById("settlement-overpay-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("settlement-overpay-error");
  errorEl.textContent = "";
  if (!pendingOverpay) return;
  const categoryId = document.getElementById("settlement-overpay-category").value;
  if (!categoryId) { errorEl.textContent = tr("error.pickCategory"); return; }

  const saveBtn = document.getElementById("settlement-overpay-save-btn");
  saveBtn.disabled = true;
  try {
    const action = pendingOverpay.entryType === "income" ? "recordOverpaymentIncome" : "recordOverpaymentExpense";
    await callApi(action, {
      friend_id: repaymentFriendId,
      amount: pendingOverpay.amount,
      currency: pendingOverpay.currency,
      date: pendingOverpay.date,
      payment_method_id: pendingOverpay.paymentMethodId,
      category_id: categoryId
    });
    pendingOverpay = null;   // resolved: no "saved in your review queue" notice
    closeSettlementModal();
    await refreshEntryList();
    refreshReviewQueue().catch(() => {});
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- Forgiving a loan (Phase 5.5) ----
// Applies to either kind of loan and either direction (see "🙏 Forgive"
// in openLoanDetail, above) — a status change, not an edit, so it isn't
// origin-restricted the way updateLoan is. Optionally converts whatever
// was still outstanding into a real expense or income entry, mirroring
// the same direction logic recordRepayment's overpayment handling uses
// (see forgiveLoan in Loans.gs).

let forgiveLoanTarget = null;
let forgiveReturnFriend = null;

function populateCategoryOptionsForSelect_(selectId, type) {
  const select = document.getElementById(selectId);
  select.innerHTML = "";
  sortedCategories_(pickableCategories_(meta.categories.filter((c) => c.type === type))).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = (c.icon ? c.icon + " " : "") + c.name;
    select.appendChild(opt);
  });
}

function openForgiveModal(loan, returnFriend) {
  forgiveLoanTarget = loan;
  forgiveReturnFriend = returnFriend;

  document.getElementById("forgive-form-error").textContent = "";
  document.getElementById("forgive-context").textContent =
    tr("forgive.context", { name: loan.description || tr("loan.word"), cur: loan.currency, amount: moneyFmt(loan.remaining) });

  const hasBalance = loan.remaining > 0.004;
  const checkbox = document.getElementById("forgive-convert-checkbox");
  // No opt-out any more: forgiving a debt always registers what was still
  // owed as an expense/income entry (see forgiveLoan in Loans.gs), so the
  // checkbox stays hidden and checked.
  const convertRow = checkbox.closest(".checkbox-row");
  convertRow.hidden = true;
  checkbox.checked = hasBalance;

  // "Convert to expense" when the owner is the one being owed and
  // writing it off (that's their own spending); "convert to income"
  // when someone else is the one forgiving what the owner owed them
  // (that's free money from the owner's side) — same direction logic as
  // an overpayment.
  const entryType = loan.direction === "they_owe_me" ? "expense" : "income";
  document.getElementById("forgive-convert-label").textContent = tr(entryType === "expense" ? "forgive.convert" : "forgive.convertIncome");
  if (hasBalance) {
    document.getElementById("forgive-context").textContent +=
      tr(entryType === "expense" ? "forgive.recordedExpense" : "forgive.recordedIncome");
  }
  populateCategoryOptionsForSelect_("forgive-category", entryType);
  document.getElementById("forgive-date").value = todayLocalISO();
  document.getElementById("forgive-convert-fields").hidden = !hasBalance || !checkbox.checked;

  const backdrop = document.getElementById("forgive-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeForgiveModal() {
  document.getElementById("forgive-modal-backdrop").hidden = true;
  forgiveLoanTarget = null;
}

document.getElementById("forgive-modal-close").addEventListener("click", closeForgiveModal);
document.getElementById("forgive-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "forgive-modal-backdrop") closeForgiveModal();
});
document.getElementById("forgive-convert-checkbox").addEventListener("change", (e) => {
  document.getElementById("forgive-convert-fields").hidden = !e.target.checked;
});

document.getElementById("forgive-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("forgive-form-error");
  errorEl.textContent = "";
  if (!forgiveLoanTarget) return;

  const convert = forgiveLoanTarget.remaining > 0.004;
  const categoryId = document.getElementById("forgive-category").value;
  const date = document.getElementById("forgive-date").value;
  if (convert && !categoryId) { errorEl.textContent = tr("error.pickCategory"); return; }
  if (convert && !date) { errorEl.textContent = tr("error.dateRequired"); return; }

  const saveBtn = document.getElementById("forgive-save-btn");
  saveBtn.disabled = true;
  try {
    await callApi("forgiveLoan", {
      id: forgiveLoanTarget.id,
      convert,
      category_id: categoryId,
      date
    });
    const returnFriend = forgiveReturnFriend;
    closeForgiveModal();
    await refreshLoans();
    if (returnFriend) await openLoanDetail(returnFriend.id, returnFriend.name);
    if (convert) await refreshEntryList();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- Review queue: Mark as repayment / Convert to loan (Phase 5.7) ----
// Email parsing only catches money the owner sent OUT (expenses); a pending
// INCOME comes from a "Te Yapearon" photo or a manual entry. Either way the
// direction follows the entry's type, so there's nothing to pick. For a
// pending EXPENSE:
// - "Mark as repayment" means the owner paying this money down what THEY
//   owed the friend — direction 'i_owe_them', through the exact same
//   recordRepayment FIFO + offset engine the Loans tab's own "Record
//   repayment" uses (see CLAUDE.md's Settlements section).
// - "Convert to loan" means the owner lending this money to the friend
//   — direction 'they_owe_me' (the friend now owes it back), through the
//   same addLoan as the Loans tab's "+ Add loan" (including its own
//   +7-day due-date default when none's given).
// For a pending INCOME the friend is on the other side: "Mark as repayment" =
// they pay back what they owed (they_owe_me paid down, and refused with
// nothing written if no such debt exists — require_owed), "Convert to loan"
// = they lent it to the owner (i_owe_them).
// Either way, the pending entry itself is discarded afterward — it was
// never really an expense/income, so it shouldn't become a confirmed one.

let reviewTransferEntry = null;
let reviewTransferMode = null; // "repay" | "loan"

function populateReviewTransferFriendOptions() {
  const select = document.getElementById("review-transfer-friend");
  select.innerHTML = "";
  meta.friends.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    select.appendChild(opt);
  });
  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = tr("common.addFriend");
  select.appendChild(addOpt);
}

document.getElementById("review-transfer-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt(tr("prompt.friendName"));
  e.target.value = meta.friends.length ? meta.friends[0].id : "";
  if (name && name.trim()) {
    const friend = await callApi("addFriend", { name: name.trim() });
    meta.friends.push(friend);
    refreshFriendChips_();
    populateReviewTransferFriendOptions();
    document.getElementById("review-transfer-friend").value = friend.id;
  }
});

function populateReviewTransferPaymentMethodOptions() {
  const select = document.getElementById("review-transfer-payment-method");
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = tr("form.noneAccount");
  select.appendChild(noneOpt);
  meta.paymentMethods.filter((pm) => !pmHidden_(pm)).forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });
}

function openReviewTransferModal(entry, mode) {
  reviewTransferEntry = entry;
  reviewTransferMode = mode;

  document.getElementById("review-transfer-modal-title").textContent =
    mode === "repay" ? tr("review.repayTitle") : tr("review.loanTitle");
  // Say which way the money moves — it follows the entry's type (an income
  // is money that came IN, so the friend is the one paying/lending).
  const incoming = entry.type === "income";
  document.getElementById("review-transfer-context").textContent =
    `${entry.description || tr("review.transactionFallback")} · ${entry.currency} ${moneyFmt(entry.amount)}` +
    (incoming
      ? (mode === "repay" ? tr("review.contextRepay") : tr("review.contextLoan"))
      : "");
  document.getElementById("review-transfer-form-error").textContent = "";

  populateReviewTransferFriendOptions();
  populateReviewTransferPaymentMethodOptions();
  document.getElementById("review-transfer-friend").value = meta.friends.length ? meta.friends[0].id : "";
  document.getElementById("review-transfer-amount").value = entry.amount;
  document.getElementById("review-transfer-date").value = entry.date;
  document.getElementById("review-transfer-payment-method").value = "";
  // Both modes now generate a `transfer` Entry for the real money moved
  // (see CLAUDE.md's Loans/Settlements sections) — this description feeds
  // that entry either way, pre-filled from the original pending
  // transaction but editable, so a custom description actually sticks
  // instead of silently falling back to the pending entry's own text.
  document.getElementById("review-transfer-description").value = entry.description || "";
  document.getElementById("review-transfer-save-btn").textContent =
    mode === "repay" ? tr("review.repayTitle") : tr("review.loanTitle");

  const backdrop = document.getElementById("review-transfer-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

function closeReviewTransferModal() {
  document.getElementById("review-transfer-modal-backdrop").hidden = true;
  reviewTransferEntry = null;
  reviewTransferMode = null;
}

document.getElementById("review-transfer-modal-close").addEventListener("click", closeReviewTransferModal);
document.getElementById("review-transfer-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "review-transfer-modal-backdrop") closeReviewTransferModal();
});

document.getElementById("review-transfer-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("review-transfer-form-error");
  errorEl.textContent = "";
  if (!reviewTransferEntry) return;

  const friendId = document.getElementById("review-transfer-friend").value;
  const friendName = (meta.friends.find((f) => f.id === friendId) || {}).name || "";
  const amount = parseFloat(document.getElementById("review-transfer-amount").value);
  const date = document.getElementById("review-transfer-date").value;
  const paymentMethodId = document.getElementById("review-transfer-payment-method").value;

  if (!friendId || friendId === "__add__") { errorEl.textContent = tr("error.pickFriend"); return; }
  if (!amount || amount <= 0) { errorEl.textContent = tr("error.validAmount"); return; }
  if (!date) { errorEl.textContent = tr("error.dateRequired"); return; }

  const saveBtn = document.getElementById("review-transfer-save-btn");
  saveBtn.disabled = true;
  try {
    const entryId = reviewTransferEntry.id;
    const currency = reviewTransferEntry.currency;
    const description = document.getElementById("review-transfer-description").value.trim() ||
      reviewTransferEntry.description || "";

    // An expense is money the owner sent out; an income is money that came in
    // — the friend is then the one repaying (they_owe_me paid down) or
    // lending (i_owe_them). An income with no debt on record is refused by the
    // backend (require_owed) before anything is written, so the entry stays.
    const incoming = reviewTransferEntry.type === "income";
    if (reviewTransferMode === "repay") {
      const result = await callApi("recordRepayment", {
        friend_id: friendId,
        direction: incoming ? "they_owe_me" : "i_owe_them",
        amount,
        currency,
        date,
        payment_method_id: paymentMethodId,
        description,
        require_owed: incoming
      });
      await callApi("discardEntry", { id: entryId });
      if (result.overpaid > 0.004) {
        alert(tr(incoming ? "review.overpaidIncoming" : "review.overpaidOutgoing", { name: friendName, cur: currency, amount: moneyFmt(result.overpaid) }));
      }
    } else {
      await callApi("addLoan", {
        friend_id: friendId,
        direction: incoming ? "i_owe_them" : "they_owe_me",
        amount,
        currency,
        date,
        payment_method_id: paymentMethodId,
        description
      });
      await callApi("discardEntry", { id: entryId });
    }

    closeReviewTransferModal();
    refreshEntriesInBackground_();
    await refreshReviewQueue();
    refreshLoans().catch(() => {});
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- Account balances (Overview) ----
// See Balances.gs. Not period-based — always "right now" — so it's fetched
// when Overview is shown (and after a balance edit), not on every period
// change.

let balanceModalPmId = null;
let balanceModalData = null;

async function refreshBalances() {
  const list = document.getElementById("balances-list");
  const emptyNote = document.getElementById("balances-empty-note");
  const rows = await callApi("listPaymentMethodBalances", {});
  balancesCache = rows;
  list.innerHTML = "";
  emptyNote.hidden = rows.length > 0;
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "balance-row";
    const [main, ...others] = r.balances;
    const otherText = others.filter((b) => Math.abs(b.amount) > 0.004).map((b) => formatSignedBalance_(b.amount, b.currency)).join(" · ");
    row.innerHTML = `
      <div class="balance-row-name">${escapeHtml(r.nickname)}<span class="loan-detail-row-chevron">›</span>${r.bank_name ? `<div class="balance-row-meta">${escapeHtml(r.bank_name)}</div>` : ""}</div>
      <div class="balance-row-amount ${main.amount < 0 ? "negative" : ""}">${formatSignedBalance_(main.amount, main.currency)}${otherText ? `<div class="balance-row-meta">${escapeHtml(otherText)}</div>` : ""}</div>
    `;
    row.addEventListener("click", () => openBalanceModal(r.id));
    list.appendChild(row);
  });

  // Net per currency across every tracked account (a credit card's
  // negative balance nets against positive ones). No cross-currency
  // conversion — each currency stands on its own.
  const totals = {};
  rows.forEach((r) => r.balances.forEach((b) => { totals[b.currency] = (totals[b.currency] || 0) + b.amount; }));
  const codes = Object.keys(totals).sort((a, b) => (a === homeCur() ? -1 : b === homeCur() ? 1 : a < b ? -1 : 1));
  const totalsWrap = document.getElementById("balances-totals");
  const totalsLines = document.getElementById("balances-totals-lines");
  totalsLines.innerHTML = "";
  totalsWrap.hidden = codes.length === 0;
  codes.forEach((code) => {
    const amount = Math.round(totals[code] * 100) / 100;
    const line = document.createElement("div");
    line.className = "balances-totals-line" + (amount < 0 ? " negative" : "");
    line.innerHTML = `<span>${code === homeCur() ? "" : findCurrency(code).flag + " "}${code}</span><span>${formatSignedBalance_(amount, code)}</span>`;
    totalsLines.appendChild(line);
  });
}

let balancesCache = [];

// ---- Investments card ----
// Net cash put into each platform, per currency (Investments.gs). Tap a
// platform to list its deposits/withdrawals underneath.
async function refreshInvestments() {
  const card = document.getElementById("investments-card");
  const list = document.getElementById("investments-list");
  const rows = await callApi("listInvestmentPlatforms", {});
  card.hidden = rows.length === 0;
  list.innerHTML = "";
  rows.forEach((r) => {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "balance-row";
    const lines = r.lines.length
      ? r.lines.map((l) => formatSignedBalance_(l.amount, l.currency)).join(" · ")
      : tr("invest.nothingYet");
    row.innerHTML = `
      <div class="balance-row-name">${escapeHtml(r.nickname)}<span class="loan-detail-row-chevron">›</span></div>
      <div class="balance-row-amount">${escapeHtml(lines)}</div>
    `;
    const detail = document.createElement("div");
    detail.hidden = true;
    row.addEventListener("click", async () => {
      if (!detail.hidden) { detail.hidden = true; return; }
      detail.hidden = false;
      detail.innerHTML = `<p class="hint">${escapeHtml(tr("common.loading"))}</p>`;
      const moves = await callApi("getPaymentMethodMovements", { paymentMethodId: r.id });
      detail.innerHTML = moves.length ? "" : `<p class="hint">${escapeHtml(tr("invest.noMoves"))}</p>`;
      moves.forEach((m) => {
        const item = document.createElement("div");
        item.className = "loan-detail-row";
        const kind = tr(m.signed > 0 ? "investment.deposit" : "investment.withdrawal");
        item.innerHTML = `
          <div class="loan-detail-row-top">
            <span class="loan-detail-row-desc">${escapeHtml(m.description || kind)}</span>
            <span class="loan-detail-row-amount">${formatSignedBalance_(m.signed, m.currency)}</span>
          </div>
          <div class="loan-detail-row-meta">${m.date} · ${kind}${m.other_account ? tr(m.signed > 0 ? "invest.fromAccount" : "invest.toAccount", { account: escapeHtml(m.other_account) }) : ""}</div>
        `;
        detail.appendChild(item);
      });
    });
    wrap.appendChild(row);
    wrap.appendChild(detail);
    list.appendChild(wrap);
  });
}

function formatSignedBalance_(amount, currency) {
  return `${amount < 0 ? "−" : ""}${currency} ${moneyFmt(Math.abs(amount))}`;
}

// `pmId` set → that account's detail; null → "+ Add balance" (pick any
// account that isn't tracked yet).
async function openBalanceModal(pmId) {
  balanceModalPmId = pmId;
  document.getElementById("balance-form-error").textContent = "";
  document.getElementById("balance-check-input").value = "";
  document.getElementById("balance-check-result").textContent = "";

  const pickerWrap = document.getElementById("balance-account-picker-wrap");
  const picker = document.getElementById("balance-account-picker");
  if (!pmId) {
    // Every account is listed, including ones that already have a
    // balance — picking one of those loads its existing rows, so adding
    // another currency to it works from here too.
    picker.innerHTML = "";
    meta.paymentMethods.filter((pm) => pm.type !== "investment" && !pmHidden_(pm)).forEach((pm) => {
      const opt = document.createElement("option");
      opt.value = pm.id;
      const tracked = balancesCache.some((b) => b.id === pm.id);
      opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "") + (tracked ? " ✓" : "");
      picker.appendChild(opt);
    });
    if (!meta.paymentMethods.length) {
      alert(tr("balance.noAccounts"));
      return;
    }
    pickerWrap.hidden = false;
    document.getElementById("balance-modal-title").textContent = tr("balance.addTitle");
    balanceModalData = null;
    document.getElementById("balance-current").hidden = true;
    document.getElementById("balance-movements-wrap").hidden = true;
    document.getElementById("balance-clear-btn").hidden = true;
    picker.onchange = () => { loadBalanceRowsFor_(picker.value); renderBalanceRows_(); };
    loadBalanceRowsFor_(picker.value);
  } else {
    pickerWrap.hidden = true;
    balanceModalData = balancesCache.find((b) => b.id === pmId);
    document.getElementById("balance-modal-title").textContent = balanceModalData.nickname;
    document.getElementById("balance-current").hidden = false;
    document.getElementById("balance-clear-btn").hidden = false;
    balanceFormRows = balanceModalData.openings.map((o) => ({
      amount: String(Math.abs(o.amount)),
      negative: o.amount < 0,
      currency: o.currency,
      date: o.date || todayLocalISO()
    }));
    renderBalanceCurrentLines_();
  }
  renderBalanceRows_();

  const backdrop = document.getElementById("balance-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;

  if (pmId) await loadBalanceMovements_(pmId);
}

function renderBalanceCurrentLines_() {
  const el = document.getElementById("balance-current-lines");
  el.innerHTML = "";
  balanceModalData.balances.forEach((b, i) => {
    if (i > 0 && Math.abs(b.amount) <= 0.004) return;
    const line = document.createElement("div");
    line.className = "balance-current-line" + (b.amount < 0 ? " negative" : "");
    line.textContent = formatSignedBalance_(b.amount, b.currency);
    el.appendChild(line);
  });
  const sel = document.getElementById("balance-check-currency");
  sel.innerHTML = balanceModalData.balances.map((b) => `<option value="${b.currency}">${b.currency}</option>`).join("");
  sel.hidden = balanceModalData.balances.length < 2;
}

async function loadBalanceMovements_(pmId) {
  const wrap = document.getElementById("balance-movements-wrap");
  const list = document.getElementById("balance-movements");
  list.innerHTML = `<p class="hint">${escapeHtml(tr("common.loading"))}</p>`;
  wrap.hidden = false;
  const moves = await callApi("getPaymentMethodMovements", { paymentMethodId: pmId });
  if (balanceModalPmId !== pmId) return;
  list.innerHTML = "";
  if (!moves.length) {
    list.innerHTML = `<p class="hint">${escapeHtml(tr("balance.nothingSince"))}</p>`;
    return;
  }
  moves.forEach((m) => {
    const row = document.createElement("div");
    row.className = "loan-detail-row";
    const label = m.description || TYPE_LABELS[m.type] || m.type;
    const extra = m.type === "transfer" && m.other_account ? tr(m.signed < 0 ? "balance.moveTo" : "balance.moveFrom", { account: escapeHtml(m.other_account) }) : "";
    row.innerHTML = `
      <div class="loan-detail-row-top">
        <span class="loan-detail-row-desc">${escapeHtml(label)}</span>
        <span class="loan-detail-row-amount ${m.signed > 0 ? "owed-to-me" : "i-owe"}">${m.signed > 0 ? "+" : "−"}${m.currency} ${moneyFmt(Math.abs(m.signed))}</span>
      </div>
      <div class="loan-detail-row-meta">${m.date} · ${m.type}${extra}</div>
    `;
    list.appendChild(row);
  });
}

let balanceFormRows = [];

// Rows for the form: the account's saved balances if it has any, else one
// blank PEN row.
function loadBalanceRowsFor_(pmId) {
  const existing = balancesCache.find((b) => b.id === pmId);
  balanceFormRows = existing
    ? existing.openings.map((o) => ({
        amount: String(Math.abs(o.amount)),
        negative: o.amount < 0,
        currency: o.currency,
        date: o.date || todayLocalISO()
      }))
    : [{ amount: "", negative: false, currency: homeCur(), date: todayLocalISO() }];
}

function renderBalanceRows_() {
  const wrap = document.getElementById("balance-rows");
  wrap.innerHTML = "";
  balanceFormRows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "balance-form-row";
    const currencyOpts = CURRENCIES.map((c) => `<option value="${c.code}"${c.code === row.currency ? " selected" : ""}>${c.flag} ${c.code}</option>`).join("");
    el.innerHTML = `
      <div class="balance-form-row-main">
        <input type="text" inputmode="decimal" class="balance-row-amount-input" placeholder="0.00" value="${escapeHtml(row.amount)}">
        <select class="balance-row-currency-select">${currencyOpts}</select>
        ${balanceFormRows.length > 1 ? `<button type="button" class="balance-row-remove" aria-label="${escapeHtml(tr("balance.remove"))}">✕</button>` : ""}
      </div>
      <label class="checkbox-row"><input type="checkbox" class="balance-row-negative"${row.negative ? " checked" : ""}><span>${tr("balance.negative")}</span></label>
      <label class="balance-row-date-label">${tr("balance.fromDate")}</label>
      <input type="date" class="balance-row-date" value="${row.date}">
    `;
    el.querySelector(".balance-row-amount-input").addEventListener("input", (e) => { row.amount = e.target.value; });
    el.querySelector(".balance-row-currency-select").addEventListener("change", (e) => { row.currency = e.target.value; });
    el.querySelector(".balance-row-negative").addEventListener("change", (e) => { row.negative = e.target.checked; });
    el.querySelector(".balance-row-date").addEventListener("change", (e) => { row.date = e.target.value; });
    const rm = el.querySelector(".balance-row-remove");
    if (rm) rm.addEventListener("click", () => { balanceFormRows.splice(i, 1); renderBalanceRows_(); });
    wrap.appendChild(el);
  });
}

document.getElementById("balance-add-row-btn").addEventListener("click", () => {
  const used = new Set(balanceFormRows.map((r) => r.currency));
  const next = ["USD", homeCur(), "EUR"].find((c) => !used.has(c)) || "USD";
  balanceFormRows.push({ amount: "", negative: false, currency: next, date: todayLocalISO() });
  renderBalanceRows_();
});

function closeBalanceModal() {
  document.getElementById("balance-modal-backdrop").hidden = true;
  balanceModalPmId = null;
  balanceModalData = null;
}

document.getElementById("add-balance-btn").addEventListener("click", () => openBalanceModal(null));
document.getElementById("balance-modal-close").addEventListener("click", closeBalanceModal);
document.getElementById("balance-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "balance-modal-backdrop") closeBalanceModal();
});

// "Check against my app": compares what the real app/statement shows with
// what this app computes, in the account's own (starting-balance)
// currency, and says which way the gap goes — nothing is saved.
document.getElementById("balance-check-currency").addEventListener("change", () => document.getElementById("balance-check-input").dispatchEvent(new Event("input")));
document.getElementById("balance-check-input").addEventListener("input", (e) => {
  const result = document.getElementById("balance-check-result");
  const text = e.target.value.trim().replace(/,/g, "").replace(/[−–]/g, "-");
  if (!text || !balanceModalData) { result.textContent = ""; return; }
  const actual = parseFloat(text);
  if (isNaN(actual)) { result.textContent = ""; return; }
  const main = balanceModalData.balances.find((b) => b.currency === document.getElementById("balance-check-currency").value) || balanceModalData.balances[0];
  const diff = Math.round((actual - main.amount) * 100) / 100;
  if (Math.abs(diff) < 0.005) {
    result.style.color = "var(--income)";
    result.textContent = tr("balance.matches");
  } else {
    result.style.color = "#d64545";
    result.textContent = diff > 0
      ? tr("balance.more", { cur: main.currency, amount: moneyFmt(diff) })
      : tr("balance.less", { cur: main.currency, amount: moneyFmt(-diff) });
  }
});

document.getElementById("balance-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("balance-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("balance-save-btn");
  try {
    const pmId = balanceModalPmId || document.getElementById("balance-account-picker").value;
    if (!pmId) throw new Error(tr("balance.pickAccount"));
    const seen = new Set();
    const balances = balanceFormRows.map((row) => {
      const text = String(row.amount).trim().replace(/,/g, "").replace(/[−–]/g, "-");
      const parsed = parseFloat(text);
      if (!text || isNaN(parsed)) throw new Error(tr("balance.enterStarting", { cur: row.currency }));
      if (!row.date) throw new Error(tr("balance.pickFromDate", { cur: row.currency }));
      if (seen.has(row.currency)) throw new Error(tr("balance.listedTwice", { cur: row.currency }));
      seen.add(row.currency);
      // Typed minus or the checkbox both mean negative; never double-negate.
      return { currency: row.currency, amount: row.negative ? -Math.abs(parsed) : parsed, date: row.date };
    });
    saveBtn.disabled = true;
    await callApi("setPaymentMethodOpeningBalance", { id: pmId, balances });
    closeBalanceModal();
    await refreshBalances();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("balance-clear-btn").addEventListener("click", async () => {
  if (!balanceModalPmId) return;
  if (!confirm(tr("balance.confirmStop"))) return;
  const pmId = balanceModalPmId;
  try {
    await callApi("setPaymentMethodOpeningBalance", { id: pmId, balances: [] });
    closeBalanceModal();
    await refreshBalances();
  } catch (err) {
    document.getElementById("balance-form-error").textContent = err.message;
  }
});

// ---- Split a bill by items ----
// A sheet opened from the expense form's split section. The maths lives in
// bill-split.js (tested on its own); this is only the screen. "Use this split"
// fills the normal form: amount = bill + tip, split switched on in Custom mode
// with each friend's total — the entry is then saved the usual way, so
// category, account, date and the debts all go through the existing flow.
let billState = null;
let billItemsEdited = false;    // items typed/changed/inserted by hand since the last photo read
let billApplied = false;        // "Use this split" was pressed in this form session
let billNextId = 1;
let billShowAllFriends = false;

function newBillState_() {
  return {
    total: "",
    people: new Set(),
    items: [],
    adjs: [],
    // A percent and a fixed amount are different numbers — each keeps its own
    // value, so "100" typed as an amount can't turn into 100% on switching tabs.
    tip: { type: "percent", percent: "", amount: "", mode: "proportional" }
  };
}

function billFriendName_(id) {
  if (id === "me") return tr("common.me");
  const f = meta.friends.find((x) => x.id === id);
  return f ? f.name : "?";
}

function billPeopleKeys_() {
  return ["me", ...Array.from(billState.people)];
}

function billInput_() {
  return {
    people: billPeopleKeys_(),
    items: billState.items.map((it) => ({
      id: it.id, name: it.name, people: Array.from(it.people),
      price: it.discount && it.price ? "-" + it.price : it.price     // a discount line is a negative line
    })),
    adjustments: billState.adjs.map((a) => ({
      name: a.name,
      amount: (a.kind === "discount" ? -1 : 1) * (parseFloat(a.amount) || 0),
      mode: a.mode
    })),
    tip: { type: billState.tip.type, mode: billState.tip.mode, value: billState.tip.type === "percent" ? billState.tip.percent : billState.tip.amount },
    printedTotal: billState.total
  };
}

// The stored form of a bill (see backend/EntryBills.gs): plain JSON, versioned,
// holding only what the person typed — never the computed amounts.
function billToJSON_() {
  return {
    v: 1,
    total: billState.total,
    people: Array.from(billState.people),
    items: billState.items.map((it) => ({ id: it.id, name: it.name, price: it.price, people: Array.from(it.people), discount: !!it.discount })),
    adjs: billState.adjs.map((a) => ({ id: a.id, kind: a.kind, name: a.name, amount: a.amount, mode: a.mode })),
    tip: { type: billState.tip.type, percent: billState.tip.percent, amount: billState.tip.amount, mode: billState.tip.mode }
  };
}

// Friends deleted since the bill was saved are quietly dropped.
function billFromJSON_(j) {
  const known = new Set(meta.friends.map((f) => f.id));
  const st = newBillState_();
  st.total = String(j.total || "");
  st.people = new Set((j.people || []).filter((id) => known.has(id)));
  st.items = (j.items || []).map((it) => ({
    id: it.id, name: it.name || "", price: String(it.price || ""), discount: !!it.discount,
    people: new Set((it.people || []).filter((id) => id === "me" || st.people.has(id)))
  }));
  st.adjs = (j.adjs || []).map((a) => ({ id: a.id, kind: a.kind === "charge" ? "charge" : "discount", name: a.name || "", amount: String(a.amount || ""), mode: a.mode === "equal" ? "equal" : "proportional" }));
  const t = j.tip || {};
  st.tip = { type: t.type === "amount" ? "amount" : "percent", percent: String(t.percent || ""), amount: String(t.amount || ""), mode: t.mode === "equal" ? "equal" : "proportional" };
  billNextId = Math.max(billNextId, ...st.items.map((x) => Number(x.id) || 0), ...st.adjs.map((x) => Number(x.id) || 0)) + 1;
  return st;
}

// Does what the bill works out to still equal the entry as it stands in the
// form (its amount and each friend's share)? False after the amount or the
// split was changed by hand since the bill was saved.
function billMatchesForm_() {
  const res = BillSplit.compute(billInput_());
  if (!res.ok) return false;
  const amountCents = Math.round((parseFloat(document.getElementById("amount").value) || 0) * 100);
  if (amountCents !== res.grandCents) return false;
  if (!document.getElementById("split-toggle").checked) return Array.from(billState.people).every((id) => res.perPerson[id].total === 0);
  const now = {};
  getSplitPayload().forEach((x) => { now[x.friend_id] = Math.round(x.amount * 100); });
  return Array.from(billState.people).every((id) => (now[id] || 0) === res.perPerson[id].total) &&
    Object.keys(now).every((id) => billState.people.has(id));
}

async function openBillModal() {
  let loadedSaved = false;
  // Reopening a saved entry: fetch the bill that was stored with it (on demand,
  // so the entry list never has to carry it).
  if (!billState && editingEntryId) {
    const btn = document.getElementById("bill-open-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = tr("bill.loadingSaved");
    try {
      const r = await callApi("getEntryBill", { entryId: editingEntryId });
      if (r && r.bill) { billState = billFromJSON_(r.bill); loadedSaved = true; }
    } catch (err) {
      /* no saved bill (or it could not be read) — start a blank one */
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  if (!billState) {
    billState = newBillState_();
    document.getElementById("bill-photo-status").hidden = true;
    document.getElementById("bill-photo-raw").hidden = true;
  }
  document.getElementById("bill-currency").textContent = (document.getElementById("currency").value || homeCur()).toUpperCase();
  document.getElementById("bill-total").value = billState.total;
  syncBillTabs_();
  renderBillPeople_();
  renderBillItems_();
  renderBillAdjs_();
  recomputeBill_();
  const stale = document.getElementById("bill-stale-note");
  stale.hidden = !(loadedSaved && !billMatchesForm_());
  document.getElementById("bill-modal-backdrop").hidden = false;
}

function closeBillModal() {
  document.getElementById("bill-modal-backdrop").hidden = true;
}

function syncBillTabs_() {
  document.querySelectorAll("#bill-tip-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.v === billState.tip.type));
  document.querySelectorAll("#bill-tip-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.v === billState.tip.mode));
  const isPercent = billState.tip.type === "percent";
  const cur = (document.getElementById("currency").value || homeCur()).toUpperCase();
  document.getElementById("bill-tip-label").textContent = isPercent ? tr("bill.tipPercentLabel") : tr("bill.tipAmountLabel", { cur });
  const box = document.getElementById("bill-tip-value");
  box.placeholder = isPercent ? "e.g. 10" : "0.00";
  box.value = isPercent ? billState.tip.percent : billState.tip.amount;
}

function renderBillPeople_() {
  const box = document.getElementById("bill-people-chips");
  box.innerHTML = "";
  const sorted = meta.friends.slice().sort((a, b) =>
    (billState.people.has(b.id) - billState.people.has(a.id)) || (b.last_used || "").localeCompare(a.last_used || ""));
  const LIMIT = 10;
  const shown = billShowAllFriends ? sorted : sorted.slice(0, Math.max(LIMIT, billState.people.size));
  shown.forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "tag-chip" + (billState.people.has(f.id) ? " selected" : "");
    chip.textContent = f.name;
    chip.addEventListener("click", () => {
      if (billState.people.has(f.id)) {
        billState.people.delete(f.id);
        billState.items.forEach((it) => it.people.delete(f.id));
      } else {
        billState.people.add(f.id);
      }
      renderBillPeople_();
      renderBillItems_();
      recomputeBill_();
    });
    box.appendChild(chip);
  });
  if (sorted.length > shown.length || billShowAllFriends) {
    const more = document.createElement("div");
    more.className = "tag-chip more-chip";
    more.textContent = billShowAllFriends ? tr("common.less") : tr("common.more");
    more.addEventListener("click", () => { billShowAllFriends = !billShowAllFriends; renderBillPeople_(); });
    box.appendChild(more);
  }
}

function renderBillItems_() {
  const box = document.getElementById("bill-items");
  box.innerHTML = "";
  const keys = billPeopleKeys_();
  billState.items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "bill-item";

    const line = document.createElement("div");
    line.className = "bill-item-line";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "bill-item-name";
    name.placeholder = tr("bill.placeholderItem");
    name.value = it.name;
    name.addEventListener("input", () => { it.name = name.value; billItemsEdited = true; });
    const price = document.createElement("input");
    price.type = "text";
    price.inputMode = "decimal";
    price.className = "bill-item-price";
    price.placeholder = "0.00";
    price.value = it.price;
    price.addEventListener("input", (e) => {
      const clean = sanitizeAmountInputValue(e.target.value);
      if (clean !== e.target.value) e.target.value = clean;
      it.price = clean;
      billItemsEdited = true;
      recomputeBill_();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bill-item-remove";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      billState.items = billState.items.filter((x) => x !== it);
      billItemsEdited = true;
      renderBillItems_();
      recomputeBill_();
    });
    line.append(name, price, del);

    const chips = document.createElement("div");
    chips.className = "tags-list";
    if (it.discount) {
      // A discount line printed under a dish: it comes off the item above and
      // is shared by whoever shares THAT item, so it has no people of its own.
      row.classList.add("bill-item-discount");
      name.placeholder = tr("bill.placeholderDiscount");
      const idx = billState.items.indexOf(it);
      let parent = null;
      for (let i = idx - 1; i >= 0; i--) if (!billState.items[i].discount) { parent = billState.items[i]; break; }
      const note = document.createElement("div");
      note.className = "hint bill-discount-note";
      note.textContent = parent ? tr("bill.comesOff", { name: parent.name || tr("bill.itemAbove") }) : tr("bill.needsItemAbove");
      chips.appendChild(note);
    } else {
      const everyone = keys.every((k) => it.people.has(k));
      const all = document.createElement("div");
      all.className = "tag-chip" + (everyone ? " selected" : "");
      all.textContent = tr("bill.everyone");
      all.addEventListener("click", () => {
        if (everyone) it.people.clear(); else keys.forEach((k) => it.people.add(k));
        renderBillItems_();
        recomputeBill_();
      });
      chips.appendChild(all);
      keys.forEach((k) => {
        const chip = document.createElement("div");
        chip.className = "tag-chip" + (it.people.has(k) ? " selected" : "");
        chip.textContent = billFriendName_(k);
        chip.addEventListener("click", () => {
          if (it.people.has(k)) it.people.delete(k); else it.people.add(k);
          renderBillItems_();
          recomputeBill_();
        });
        chips.appendChild(chip);
      });
    }
    // The number pad has no minus key, so a line is marked as a discount here.
    const disc = document.createElement("div");
    disc.className = "tag-chip bill-discount-toggle" + (it.discount ? " selected" : "");
    disc.textContent = tr("bill.discountLine");
    disc.addEventListener("click", () => {
      it.discount = !it.discount;
      billItemsEdited = true;
      renderBillItems_();
      recomputeBill_();
    });
    chips.appendChild(disc);
    // A new line right under this one — order matters, because a discount line
    // comes off the item above it.
    const ins = document.createElement("div");
    ins.className = "tag-chip bill-insert-chip";
    ins.textContent = tr("bill.insertLine");
    ins.addEventListener("click", () => {
      const at = billState.items.indexOf(it) + 1;
      billState.items.splice(at, 0, { id: billNextId++, name: "", price: "", people: new Set() });
      billItemsEdited = true;
      renderBillItems_();
      recomputeBill_();
      const names = document.querySelectorAll("#bill-items .bill-item-name");
      if (names[at]) names[at].focus();
    });
    chips.appendChild(ins);

    row.append(line, chips);
    box.appendChild(row);
  });
}

function addBillItem_() {
  billItemsEdited = true;
  billState.items.push({ id: billNextId++, name: "", price: "", people: new Set() });
  renderBillItems_();
  recomputeBill_();
  const names = document.querySelectorAll("#bill-items .bill-item-name");
  if (names.length) names[names.length - 1].focus();
}

function renderBillAdjs_() {
  const box = document.getElementById("bill-adjs");
  box.innerHTML = "";
  billState.adjs.forEach((a) => {
    const row = document.createElement("div");
    row.className = "bill-item bill-adj";

    const line = document.createElement("div");
    line.className = "bill-item-line";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "bill-item-name";
    name.placeholder = a.kind === "discount" ? tr("bill.placeholderDiscount") : tr("bill.placeholderCharge");
    name.value = a.name;
    name.addEventListener("input", () => { a.name = name.value; billItemsEdited = true; });
    const amt = document.createElement("input");
    amt.type = "text";
    amt.inputMode = "decimal";
    amt.className = "bill-item-price";
    amt.placeholder = "0.00";
    amt.value = a.amount;
    amt.addEventListener("input", (e) => {
      const clean = sanitizeAmountInputValue(e.target.value);
      if (clean !== e.target.value) e.target.value = clean;
      a.amount = clean;
      billItemsEdited = true;
      recomputeBill_();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bill-item-remove";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      billState.adjs = billState.adjs.filter((x) => x !== a);
      billItemsEdited = true;
      renderBillAdjs_();
      recomputeBill_();
    });
    line.append(name, amt, del);

    const tabs = document.createElement("div");
    tabs.className = "type-tabs budget-period-tabs";
    [["proportional", tr("bill.byOrdered")], ["equal", tr("split.equal")]].forEach(([v, label]) => {
      const t = document.createElement("div");
      t.className = "type-tab" + (a.mode === v ? " active" : "");
      t.textContent = label;
      t.addEventListener("click", () => {
        a.mode = v;
        tabs.querySelectorAll(".type-tab").forEach((x) => x.classList.toggle("active", x === t));
        recomputeBill_();
      });
      tabs.appendChild(t);
    });

    row.append(line, tabs);
    box.appendChild(row);
  });
}

function recomputeBill_() {
  const res = BillSplit.compute(billInput_());
  const cur = (document.getElementById("currency").value || homeCur()).toUpperCase();
  const fmt = (cents) => `${cur} ${moneyFmt(cents / 100)}`;

  const check = document.getElementById("bill-check");
  // The bill total is BEFORE discounts: items (+ any extra charge) must match
  // it; discounts come off afterwards, then the tip.
  const chargesCents = res.preDiscountCents - res.itemsCents;
  const counted = chargesCents ? tr("bill.countedCharges", { items: fmt(res.itemsCents), charges: fmt(chargesCents) }) : tr("bill.counted", { items: fmt(res.itemsCents) });
  const lead = chargesCents ? tr("bill.leadCharges", { counted, total: fmt(res.preDiscountCents) }) : tr("bill.leadPlain", { items: fmt(res.itemsCents) });
  if (res.printedCents > 0) {
    if (res.diffCents === 0) {
      check.className = "hint bill-check-ok";
      check.textContent = tr("bill.checkOk", { counted, printed: fmt(res.printedCents) }) +
        (res.discountsCents ? tr("bill.checkAfterDiscounts", { discounts: fmt(res.discountsCents), bill: fmt(res.billCents) }) : "");
    } else {
      check.className = "hint bill-check-bad";
      check.textContent = res.diffCents > 0
        ? tr("bill.checkShort", { lead, printed: fmt(res.printedCents), diff: fmt(res.diffCents) })
        : tr("bill.checkTooMuch", { lead, printed: fmt(res.printedCents), diff: fmt(-res.diffCents) });
    }
  } else {
    check.className = "hint";
    check.textContent = res.itemsCents ? tr("bill.itemsSoFar", { items: fmt(res.itemsCents) }) : "";
  }

  const out = document.getElementById("bill-result");
  out.innerHTML = "";
  if (res.itemsCents) {
    billPeopleKeys_().forEach((k) => {
      const p = res.perPerson[k];
      const row = document.createElement("div");
      row.className = "bill-result-row";
      const left = document.createElement("div");
      const nm = document.createElement("div");
      nm.textContent = billFriendName_(k);
      const sub = document.createElement("div");
      sub.className = "bill-result-sub";
      const bits = [tr("bill.subItems", { v: moneyFmt(p.items / 100) })];
      if (p.adjustments) bits.push(tr("bill.subAdjustments", { sign: p.adjustments < 0 ? "−" : "+", v: moneyFmt(Math.abs(p.adjustments) / 100) }));
      if (p.tip) bits.push(tr("bill.subTip", { v: moneyFmt(p.tip / 100) }));
      sub.textContent = bits.join(" · ");
      left.append(nm, sub);
      const right = document.createElement("strong");
      right.textContent = fmt(p.total);
      row.append(left, right);
      out.appendChild(row);
    });
    if (res.tipCents) {
      const t = document.createElement("p");
      t.className = "hint";
      t.textContent = tr("bill.tipTotal", { tip: fmt(res.tipCents), total: fmt(res.grandCents) });
      out.appendChild(t);
    }
  }
  // Live line under the tip box: what the typed tip actually comes to, so a
  // slip like 100 instead of 10 is obvious right where it is typed.
  const preview = document.getElementById("bill-tip-preview");
  const tipTyped = billState.tip.type === "percent" ? billState.tip.percent : billState.tip.amount;
  if (!tipTyped || !res.tipCents) {
    preview.className = "hint";
    preview.textContent = res.billCents > 0 ? tr("bill.tipBase", { bill: fmt(res.billCents) }) : "";
  } else {
    const pct = res.billCents > 0 ? (res.tipCents / res.billCents) * 100 : 0;
    const odd = pct > 30;
    preview.className = "hint" + (odd ? " bill-check-bad" : "");
    preview.textContent = billState.tip.type === "percent"
      ? tr("bill.tipPctOf", { pct: tipTyped, bill: fmt(res.billCents), tip: fmt(res.tipCents), odd: odd ? tr("bill.tipOdd") : "" })
      : tr("bill.tipIs", { tip: fmt(res.tipCents), pct: pct.toFixed(1), bill: fmt(res.billCents), odd: odd ? tr("bill.tipOdd") : "" });
  }
  const err = document.getElementById("bill-error");
  // Only the blocking reason that isn't already visible above.
  err.textContent = res.ok ? "" : res.errors.filter((e) => e !== tr("bill.err.dontAddUp")).join(" ");
  document.getElementById("bill-apply").disabled = !res.ok;
  return res;
}

function applyBillToForm_() {
  const res = recomputeBill_();
  if (!res.ok) return;
  const amountEl = document.getElementById("amount");
  amountEl.value = (res.grandCents / 100).toFixed(2);
  amountEl.dispatchEvent(new Event("input"));

  const friendIds = Array.from(billState.people).filter((id) => res.perPerson[id].total > 0);
  splitFriendIds = new Set(friendIds);
  customSplitAmounts = {};
  friendIds.forEach((id) => { customSplitAmounts[id] = (res.perPerson[id].total / 100).toFixed(2); });
  customOwnAmount = (res.perPerson.me.total / 100).toFixed(2);
  splitMode = "custom";
  splitFriendsExpanded = false;
  const on = friendIds.length > 0;
  document.getElementById("split-toggle").checked = on;
  document.getElementById("split-detail").hidden = !on;
  document.querySelectorAll("#split-mode-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === "custom"));
  renderSplitFriendChips();
  renderSplitRows();
  renderSplitSummary();
  billApplied = true;
  closeBillModal();
}

document.getElementById("bill-open-btn").addEventListener("click", openBillModal);
document.getElementById("bill-modal-close").addEventListener("click", closeBillModal);
document.getElementById("bill-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "bill-modal-backdrop") closeBillModal();
});
document.getElementById("bill-apply").addEventListener("click", applyBillToForm_);
document.getElementById("bill-add-item").addEventListener("click", addBillItem_);
document.getElementById("bill-add-discount").addEventListener("click", () => {
  billItemsEdited = true;
  billState.adjs.push({ id: billNextId++, kind: "discount", name: "", amount: "", mode: "proportional" });
  renderBillAdjs_();
  recomputeBill_();
});
document.getElementById("bill-add-charge").addEventListener("click", () => {
  billItemsEdited = true;
  billState.adjs.push({ id: billNextId++, kind: "charge", name: "", amount: "", mode: "proportional" });
  renderBillAdjs_();
  recomputeBill_();
});
document.getElementById("bill-add-friend").addEventListener("click", async () => {
  const name = prompt(tr("prompt.friendName"));
  if (!name || !name.trim()) return;
  const friend = await callApi("addFriend", { name: name.trim() });
  friend.last_used = todayLocalISO();
  meta.friends.push(friend);
  refreshFriendChips_();
  billState.people.add(friend.id);
  renderBillPeople_();
  renderBillItems_();
  recomputeBill_();
});
document.getElementById("bill-total").addEventListener("input", (e) => {
  const clean = sanitizeAmountInputValue(e.target.value);
  if (clean !== e.target.value) e.target.value = clean;
  billState.total = clean;
  recomputeBill_();
});
document.getElementById("bill-tip-value").addEventListener("input", (e) => {
  const clean = sanitizeAmountInputValue(e.target.value);
  if (clean !== e.target.value) e.target.value = clean;
  if (billState.tip.type === "percent") billState.tip.percent = clean; else billState.tip.amount = clean;
  recomputeBill_();
});
document.querySelectorAll("#bill-tip-type-tabs .type-tab").forEach((t) => t.addEventListener("click", () => {
  billState.tip.type = t.dataset.v; syncBillTabs_(); recomputeBill_();
}));
document.querySelectorAll("#bill-tip-mode-tabs .type-tab").forEach((t) => t.addEventListener("click", () => {
  billState.tip.mode = t.dataset.v; syncBillTabs_(); recomputeBill_();
}));


// ---- Reading a receipt photo (step 3) ----
// All on the phone: the photo is shrunk and cleaned up on a canvas, read by
// self-hosted tesseract.js (docs/vendor/tesseract/), and the text goes through
// ReceiptParse (receipt-parse.js). Nothing is uploaded and the photo is not
// kept. The result only FILLS the sheet — items still have to be assigned to
// people, and the sheet's own total check catches a misread line.
let tesseractLoading_ = null;

function loadTesseract_() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading_) {
    tesseractLoading_ = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "vendor/tesseract/tesseract.min.js";
      el.onload = resolve;
      el.onerror = () => { tesseractLoading_ = null; reject(new Error(tr("photo.loadFailed"))); };
      document.head.appendChild(el);
    });
  }
  return tesseractLoading_;
}

// Finds the paper in the photo (the big bright region) so the table, hand or
// background around it never reaches the reader. Returns the whole photo when
// no clear paper stands out.
async function receiptPaperBox_(bmp) {
  const sw = 200, sh = Math.max(1, Math.round(bmp.height * sw / bmp.width));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, sw, sh);
  const d = x.getImageData(0, 0, sw, sh).data;
  const g = new Uint8Array(sw * sh);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) { g[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); hist[g[p]]++; }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  const tot = sw * sh;
  for (let t = 0; t < 256; t++) {            // Otsu: the brightness that best splits paper from background
    wB += hist[t];
    if (!wB) continue;
    const wF = tot - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  const col = new Array(sw).fill(0), row = new Array(sh).fill(0);
  for (let y = 0; y < sh; y++) for (let xx = 0; xx < sw; xx++) if (g[y * sw + xx] > thr) { col[xx]++; row[y]++; }
  const cm = Math.max(...col), rm = Math.max(...row);
  const cx = col.map((v, i) => (v > cm * 0.3 ? i : -1)).filter((i) => i >= 0);
  const ry = row.map((v, i) => (v > rm * 0.3 ? i : -1)).filter((i) => i >= 0);
  const whole = { x: 0, y: 0, w: bmp.width, h: bmp.height };
  if (!cx.length || !ry.length) return whole;
  const pad = 0.015;
  const x0 = Math.max(0, cx[0] / sw - pad), x1 = Math.min(1, (cx[cx.length - 1] + 1) / sw + pad);
  const y0 = Math.max(0, ry[0] / sh - pad), y1 = Math.min(1, (ry[ry.length - 1] + 1) / sh + pad);
  const box = { x: Math.round(x0 * bmp.width), y: Math.round(y0 * bmp.height), w: Math.round((x1 - x0) * bmp.width), h: Math.round((y1 - y0) * bmp.height) };
  return box.w > 0.92 * bmp.width && box.h > 0.92 * bmp.height ? whole : box;
}

// Greyscale + contrast stretch, optionally cropped to the paper. Tried on 16 real
// photos: cropping read more receipts than not cropping, but not the SAME ones —
// so the reader tries the crop first and the whole photo second (see readBillPhoto_).
async function prepareReceiptImage_(file, opts) {
  opts = opts || { crop: false, maxLong: 2000 };
  const bmp = await createImageBitmap(file);   // applies the photo's rotation
  const box = opts.crop ? await receiptPaperBox_(bmp) : { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const scale = Math.min(opts.crop ? Math.min(1500 / box.w, 3200 / box.h) : (opts.maxLong || 2000) / Math.max(box.w, box.h), 3);
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  // stretch between the 2nd and 98th percentile
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.max(0, Math.min(255, Math.round(((d[i] - lo) * 255) / span)));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- two reads, then a merge -------------------------------------------------
// Pass 1 reads the whole receipt. Pass 2 re-reads ONLY the number columns
// (cropped, so no table or margin noise around them) — that is where thermal
// printers' dotted zeros get misread as 8 or 9. For every number the more
// confident of the two readings is kept. Words the reader itself is unsure
// about AND that are 1-3 characters long (the "A A e" junk picked up from the
// table at the edge) are dropped.
const RECEIPT_NUM_WORD = /^[-\dOolI.,]*\d[-\dOolI.,]*$/;
const RECEIPT_AMOUNT_WORD = /^\d{1,6}[.,]\d{2,3}$/;

function receiptLines_(data) {
  return ((data && data.blocks) || [])
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
    .map((l) => ({
      y0: l.bbox.y0, y1: l.bbox.y1,
      words: (l.words || []).map((w) => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1 }))
        .filter((w) => w.text && w.text.trim())
    }));
}

function receiptJunkWord_(w) {
  const letters = w.text.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñü0-9]/g, "");
  if (!letters) return true;                                   // "—", "*", ":" on their own
  if (RECEIPT_NUM_WORD.test(w.text)) return false;             // numbers are never junk here
  return letters.length <= 3 && w.conf < 45;
}

function receiptLineText_(words, height) {
  let out = "";
  words.forEach((w, i) => {
    if (i) out += w.x0 - words[i - 1].x1 > height * 1.5 ? "   " : " ";
    out += w.text;
  });
  return out;
}

function trailingNumberRun_(words) {
  let n = 0;
  while (n < words.length && RECEIPT_NUM_WORD.test(words[words.length - 1 - n].text)) n++;
  return n;
}

function mergeReceiptPasses_(lines1, lines2) {
  return lines1.map((l1) => {
    const h1 = Math.max(1, l1.y1 - l1.y0);
    let best = null, bestOverlap = 0;
    lines2.forEach((l2) => {
      const overlap = Math.min(l1.y1, l2.y1) - Math.max(l1.y0, l2.y0);
      const ratio = overlap / Math.max(1, Math.min(h1, l2.y1 - l2.y0));
      if (ratio > bestOverlap) { bestOverlap = ratio; best = l2; }
    });
    let words = l1.words.slice();
    if (best && bestOverlap >= 0.5) {
      const n1 = trailingNumberRun_(words), n2 = trailingNumberRun_(best.words);
      const k = Math.min(n1, n2, 3);
      if (k >= 1) {
        const left = words.slice(0, words.length - k);
        const mine = words.slice(words.length - k);
        const theirs = best.words.slice(best.words.length - k);
        // the more confident reading of each number (ties go to the digits-only pass)
        const chosen = mine.map((w, i) => (theirs[i].conf >= w.conf ? theirs[i] : w));
        words = left.concat(chosen);
      }
    }
    return receiptLineText_(words.filter((w) => !receiptJunkWord_(w)), h1);
  }).join("\n");
}

async function recognizeReceiptText_(canvas, onProgress) {
  await loadTesseract_();
  const base = new URL("vendor/tesseract/", location.href).href;
  const worker = await Tesseract.createWorker("spa", 1, {
    workerPath: base + "worker.min.js",
    corePath: base,
    langPath: base,
    logger: (m) => { if (m && m.status && onProgress) onProgress(m); }
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
    const first = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const lines1 = receiptLines_(first.data);
    if (!lines1.length) return first.data.text || "";
    try {
      // Where do the amounts start? (a little left of the leftmost amount column,
      // to take in a quantity column)
      const xs = lines1.flatMap((l) => l.words).filter((w) => RECEIPT_AMOUNT_WORD.test(w.text)).map((w) => w.x0).sort((a, b) => a - b);
      if (xs.length >= 4) {
        const startX = Math.max(0, Math.round(xs[Math.floor(xs.length * 0.15)] - canvas.width * 0.075));
        const strip = document.createElement("canvas");
        strip.width = canvas.width - startX;
        strip.height = canvas.height;
        strip.getContext("2d").drawImage(canvas, startX, 0, strip.width, strip.height, 0, 0, strip.width, strip.height);
        const second = await worker.recognize(strip, {}, { blocks: true });
        return mergeReceiptPasses_(lines1, receiptLines_(second.data));
      }
    } catch (err) {
      /* the second read is only an improvement — fall back to the first */
    }
    return mergeReceiptPasses_(lines1, []);
  } finally {
    await worker.terminate();
  }
}

// Puts what was read into the open sheet (replacing what was there only after
// asking, if the sheet already has items).
function applyReceiptToBill_(parsed, opts) {
  opts = opts || {};
  if (!opts.noConfirm && billState.items.some((it) => it.price) && !confirm(tr("photo.confirmReplace"))) return false;
  // Lines that are unchanged keep who shared them (matched by name + price).
  const previous = billState.items.slice();
  const keepPeople = (it) => {
    if (!opts.keepAssignments || it.discount) return new Set();
    const at = previous.findIndex((o) => !o.discount && o.name.trim().toLowerCase() === it.name.trim().toLowerCase() && o.price === it.price);
    if (at < 0) return new Set();
    return new Set(previous.splice(at, 1)[0].people);
  };
  billState.items = parsed.items.map((it) => ({ id: billNextId++, name: it.name, price: it.price, people: keepPeople(it), discount: it.discount }));
  billItemsEdited = false;
  billState.adjs = [
    ...parsed.charges.map((c) => ({ id: billNextId++, kind: "charge", name: c.name, amount: c.amount, mode: "proportional" })),
    ...parsed.discounts.map((d) => ({ id: billNextId++, kind: "discount", name: d.name, amount: d.amount, mode: "proportional" }))
  ];
  if (parsed.total) {
    billState.total = parsed.total;
    document.getElementById("bill-total").value = parsed.total;
  }
  renderBillItems_();
  renderBillAdjs_();
  recomputeBill_();
  return true;
}

function billPhotoSay_(text, bad) {
  const status = document.getElementById("bill-photo-status");
  status.hidden = false;
  status.textContent = text;
  status.className = "hint" + (bad ? " bill-check-bad" : "");
}

// Reads a receipt photo: tries it cropped to the paper first and, if the result
// doesn't add up to its own printed total, the whole photo second (they fail on
// different receipts); returns the better reading {text, parsed, reconciled}.
async function readReceiptFile_(file, say) {
  say = say || (() => {});
  const attempts = [{ crop: true }, { crop: false, maxLong: 2000 }];
  let best = null;
  for (let i = 0; i < attempts.length; i++) {
    const canvas = await prepareReceiptImage_(file, attempts[i]);
    const first = !window.Tesseract;
    say(i ? tr("photo.retry") : first ? tr("photo.loadingReader") : tr("photo.reading"));
    const text = await recognizeReceiptText_(canvas, (m) => {
      if (m.status === "recognizing text") say(tr(i ? "photo.readingAgainPct" : "photo.readingPct", { pct: Math.round((m.progress || 0) * 100) }));
      else if (/loading/i.test(m.status)) say(tr("photo.loadingReader"));
    });
    const parsed = ReceiptParse.parseReceipt(text);
    const f = ReceiptParse.fit(parsed);
    // better = adds up > closer to the total > more items
    const score = (f.reconciled ? 1e9 : 0) - (f.known ? f.gap : 1e7) + parsed.items.length * 0.01;
    if (!best || score > best.score) best = { text, parsed, score, reconciled: f.reconciled, attempt: i };
    if (best.reconciled) break;
  }
  return best;
}

async function readBillPhoto_(file) {
  const btn = document.getElementById("bill-photo-btn");
  const say = billPhotoSay_;
  btn.disabled = true;
  try {
    say(tr("photo.preparing"));
    const best = await readReceiptFile_(file, say);
    document.getElementById("bill-photo-text").value = best.text;
    document.getElementById("bill-photo-raw").hidden = false;
    const parsed = best.parsed;
    if (!parsed.items.length) {
      say(tr("photo.noItems"), true);
      return;
    }
    if (!applyReceiptToBill_(parsed)) { say(tr("photo.leftAsWas")); return; }
    const dishes = parsed.items.filter((i) => !i.discount).length;
    const notes = parsed.warnings.length ? " " + parsed.warnings.join(" ") : "";
    say(tr("photo.readN", { n: dishes, notes }), parsed.warnings.length > 0);
  } catch (err) {
    say(err.message || tr("photo.couldntRead"), true);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("bill-photo-btn").addEventListener("click", () => document.getElementById("bill-photo-input").click());
document.getElementById("bill-photo-reparse").addEventListener("click", () => {
  const parsed = ReceiptParse.parseReceipt(document.getElementById("bill-photo-text").value);
  if (!parsed.items.length) { billPhotoSay_(tr("photo.textNoItems"), true); return; }
  if (billItemsEdited && !confirm(tr("photo.confirmOverwrite"))) return;
  applyReceiptToBill_(parsed, { noConfirm: true, keepAssignments: true });
  const dishes = parsed.items.filter((i) => !i.discount).length;
  billPhotoSay_(tr("photo.reworked", { n: dishes }) + (parsed.warnings.length ? " " + parsed.warnings.join(" ") : ""), parsed.warnings.length > 0);
});
document.getElementById("bill-photo-input").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";           // picking the same photo again must work
  if (file) readBillPhoto_(file);
});


// ---- One calendar for a start AND an end date (2026-10-19) ----
// Wherever the app asks for "from … to …" (a trip's dates, a Programmed item's start/end, Overview's custom
// period, Export's custom range) a single field shows the whole range and opens ONE calendar pop-up: tap the
// first day, then the last. The two real <input type="date"> elements stay in the page, hidden, as the
// values every existing handler already reads and writes — so nothing that uses them had to change.
// See specs/trips-events.md § Dates in one calendar.

// What a tap on a day does (pure, so it is tested on its own):
//  - nothing chosen yet, or a finished range → that day starts a new range (no end);
//  - a start but no end: a day BEFORE the start becomes the new start; the same day or later is the end
//    (the same day twice = a one-day range).
function rangeTap_(state, iso) {
  const start = state.start || "", end = state.end || "";
  if (!start || end) return { start: iso, end: "" };
  if (iso < start) return { start: iso, end: "" };
  return { start, end: iso };
}

function rangeFmt_(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return I18n.fmtDateMedium(new Date(y, m - 1, d));   // built from parts: new Date("YYYY-MM-DD") is UTC and can land a day early
}

// The text on the field. noEnd: "single" = a missing end date means one day (trips); "open" = no end date.
function rangeSummary_(noEnd, start, end) {
  if (!start && !end) return "";
  if (!start) return tr("range.until", { end: rangeFmt_(end) });
  if (!end) return noEnd === "single" ? rangeFmt_(start) : tr("range.fromOpen", { start: rangeFmt_(start) });
  if (end === start && noEnd === "single") return rangeFmt_(start);
  return tr("range.span", { start: rangeFmt_(start), end: rangeFmt_(end) });
}

const RANGE_WEEKDAY_KEYS_ = ["range.wd1", "range.wd2", "range.wd3", "range.wd4", "range.wd5", "range.wd6", "range.wd7"];   // Monday first
let rangeDom_ = null;
let rangeSession_ = null;   // { cfg, startEl, endEl, state, viewY, viewM }

function ensureRangeDom_() {
  if (rangeDom_) return rangeDom_;
  const backdrop = document.createElement("div");
  backdrop.id = "range-picker-backdrop";
  backdrop.className = "currency-modal-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <div class="currency-modal range-modal">
      <div class="currency-modal-header">
        <span id="range-title"></span>
        <button type="button" id="range-close" class="currency-modal-close">✕</button>
      </div>
      <div class="range-nav">
        <button type="button" data-step="-12" aria-label="−12">«</button>
        <button type="button" data-step="-1" aria-label="−1">‹</button>
        <span id="range-month"></span>
        <button type="button" data-step="1" aria-label="+1">›</button>
        <button type="button" data-step="12" aria-label="+12">»</button>
      </div>
      <div class="range-weekdays">${RANGE_WEEKDAY_KEYS_.map((k) => `<span>${escapeHtml(tr(k))}</span>`).join("")}</div>
      <div class="range-grid" id="range-grid"></div>
      <p class="hint" id="range-summary"></p>
      <div class="range-actions">
        <button type="button" class="add-inline" id="range-remove-end">${escapeHtml(tr("range.removeEnd"))}</button>
        <button type="button" class="add-inline" id="range-clear">${escapeHtml(tr("range.clear"))}</button>
      </div>
      <button type="button" class="primary" id="range-done">${escapeHtml(tr("range.done"))}</button>
    </div>`;
  document.body.appendChild(backdrop);
  const dom = {
    backdrop, title: backdrop.querySelector("#range-title"), month: backdrop.querySelector("#range-month"),
    grid: backdrop.querySelector("#range-grid"), summary: backdrop.querySelector("#range-summary"),
    removeEnd: backdrop.querySelector("#range-remove-end"), clear: backdrop.querySelector("#range-clear"),
    done: backdrop.querySelector("#range-done")
  };
  const close = () => { backdrop.hidden = true; rangeSession_ = null; };
  backdrop.querySelector("#range-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const s = rangeSession_;
    if (!s) return;
    const moved = new Date(s.viewY, s.viewM - 1 + Number(b.dataset.step), 1);
    s.viewY = moved.getFullYear();
    s.viewM = moved.getMonth() + 1;
    renderRange_();
  }));
  dom.removeEnd.addEventListener("click", () => { if (rangeSession_) { rangeSession_.state.end = ""; renderRange_(); } });
  dom.clear.addEventListener("click", () => { if (rangeSession_) { rangeSession_.state = { start: "", end: "" }; renderRange_(); } });
  dom.done.addEventListener("click", () => {
    const s = rangeSession_;
    if (!s) return;
    // Written to the real inputs, which then tell every existing listener ("change") as if typed.
    s.startEl.value = s.state.start;
    s.endEl.value = s.state.end;
    [s.startEl, s.endEl].forEach((el) => { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    close();
  });
  rangeDom_ = dom;
  return dom;
}

function renderRange_() {
  const s = rangeSession_, dom = rangeDom_;
  if (!s || !dom) return;
  const { start, end } = s.state;
  dom.month.textContent = I18n.fmtMonthYear(new Date(s.viewY, s.viewM - 1, 1));
  dom.grid.innerHTML = "";
  const first = new Date(s.viewY, s.viewM - 1, 1);
  const lead = (first.getDay() + 6) % 7;                       // Monday = 0
  const days = new Date(s.viewY, s.viewM, 0).getDate();
  const today = todayLocalISO();
  for (let i = 0; i < lead; i++) dom.grid.appendChild(document.createElement("span"));
  for (let d = 1; d <= days; d++) {
    const iso = `${s.viewY}-${String(s.viewM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = d;
    b.className = "range-day"
      + (iso === start ? " is-start" : "") + (iso === end ? " is-end" : "")
      + (start && end && iso > start && iso < end ? " in-range" : "")
      + (iso === today ? " is-today" : "");
    b.addEventListener("click", () => { s.state = rangeTap_(s.state, iso); renderRange_(); });
    dom.grid.appendChild(b);
  }
  const cfg = s.cfg;
  dom.summary.textContent = !start
    ? tr("range.promptStart")
    : !end
      ? tr(cfg.noEnd === "single" ? "range.promptEndSingle" : "range.promptEndOpen")
      : rangeSummary_(cfg.noEnd, start, end);
  // visibility, not `hidden`: the pop-up must keep its height, or the days jump under the finger between taps
  dom.removeEnd.style.visibility = end ? "visible" : "hidden";
  dom.clear.style.visibility = cfg.startRequired || (!start && !end) ? "hidden" : "visible";
  dom.done.disabled = !!cfg.startRequired && !start;
}

function openDateRangePicker_(cfg, startEl, endEl) {
  const dom = ensureRangeDom_();
  const state = { start: startEl.value || "", end: endEl.value || "" };
  const anchor = state.start || state.end || todayLocalISO();
  rangeSession_ = { cfg, startEl, endEl, state, viewY: Number(anchor.slice(0, 4)), viewM: Number(anchor.slice(5, 7)) };
  dom.title.textContent = tr(cfg.titleKey);
  bringModalToFront_(dom.backdrop);
  dom.backdrop.hidden = false;
  renderRange_();
}

// Replaces a pair of date inputs by one field. cfg: { startId, endId, titleKey, startRequired, noEnd }.
// The inputs stay (hidden) as the stored values; assigning `.value` from code refreshes the field too.
function attachDateRange_(cfg) {
  const startEl = document.getElementById(cfg.startId), endEl = document.getElementById(cfg.endId);
  const field = document.createElement("button");
  field.type = "button";
  field.className = "range-field";
  startEl.insertAdjacentElement("beforebegin", field);
  startEl.hidden = true;
  endEl.hidden = true;
  const refresh = () => {
    const text = rangeSummary_(cfg.noEnd, startEl.value, endEl.value);
    field.textContent = text || tr("range.choose");
    field.classList.toggle("empty", !text);
  };
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  [startEl, endEl].forEach((el) => {
    Object.defineProperty(el, "value", {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(v) { nativeValue.set.call(this, v); refresh(); }
    });
  });
  field.addEventListener("click", () => openDateRangePicker_(cfg, startEl, endEl));
  refresh();
}

attachDateRange_({ startId: "custom-start", endId: "custom-end", titleKey: "period.dates", startRequired: false, noEnd: "open" });
attachDateRange_({ startId: "export-start", endId: "export-end", titleKey: "period.dates", startRequired: false, noEnd: "open" });
attachDateRange_({ startId: "trip-start", endId: "trip-end", titleKey: "trips.dates", startRequired: true, noEnd: "single" });
attachDateRange_({ startId: "recurring-start-date", endId: "recurring-end-date", titleKey: "recModal.dates", startRequired: true, noEnd: "open" });

init();
