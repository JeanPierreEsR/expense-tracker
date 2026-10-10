// The Web App URL isn't secret by itself — the ACCESS_CODE is what protects
// writes. That code lives only in this browser's localStorage, never here.
const API_URL = "https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec";

const TYPE_LABELS = {
  expense: "Expense",
  income: "Income",
  investment: "Investment",
  transfer: "Transfer"
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
  { code: "PEN", flag: "🇵🇪", name: "Peruvian Sol" },
  { code: "USD", flag: "🇺🇸", name: "US Dollar" },
  { code: "EUR", flag: "🇪🇺", name: "Euro" },
  { code: "ARS", flag: "🇦🇷", name: "Argentine Peso" },
  { code: "MXN", flag: "🇲🇽", name: "Mexican Peso" },
  { code: "BRL", flag: "🇧🇷", name: "Brazilian Real" },
  { code: "CLP", flag: "🇨🇱", name: "Chilean Peso" },
  { code: "COP", flag: "🇨🇴", name: "Colombian Peso" },
  { code: "BOB", flag: "🇧🇴", name: "Bolivian Boliviano" },
  { code: "UYU", flag: "🇺🇾", name: "Uruguayan Peso" },
  { code: "PYG", flag: "🇵🇾", name: "Paraguayan Guaraní" },
  { code: "VES", flag: "🇻🇪", name: "Venezuelan Bolívar" },
  { code: "GTQ", flag: "🇬🇹", name: "Guatemalan Quetzal" },
  { code: "CRC", flag: "🇨🇷", name: "Costa Rican Colón" },
  { code: "PAB", flag: "🇵🇦", name: "Panamanian Balboa" },
  { code: "DOP", flag: "🇩🇴", name: "Dominican Peso" },
  { code: "HNL", flag: "🇭🇳", name: "Honduran Lempira" },
  { code: "NIO", flag: "🇳🇮", name: "Nicaraguan Córdoba" },
  { code: "CUP", flag: "🇨🇺", name: "Cuban Peso" },
  { code: "GBP", flag: "🇬🇧", name: "British Pound" },
  { code: "CAD", flag: "🇨🇦", name: "Canadian Dollar" },
  { code: "CHF", flag: "🇨🇭", name: "Swiss Franc" },
  { code: "JPY", flag: "🇯🇵", name: "Japanese Yen" },
  { code: "CNY", flag: "🇨🇳", name: "Chinese Yuan" },
  { code: "KRW", flag: "🇰🇷", name: "South Korean Won" },
  { code: "INR", flag: "🇮🇳", name: "Indian Rupee" },
  { code: "AUD", flag: "🇦🇺", name: "Australian Dollar" },
  { code: "NZD", flag: "🇳🇿", name: "New Zealand Dollar" },
  { code: "SGD", flag: "🇸🇬", name: "Singapore Dollar" },
  { code: "HKD", flag: "🇭🇰", name: "Hong Kong Dollar" },
  { code: "SEK", flag: "🇸🇪", name: "Swedish Krona" },
  { code: "NOK", flag: "🇳🇴", name: "Norwegian Krone" },
  { code: "DKK", flag: "🇩🇰", name: "Danish Krone" },
  { code: "PLN", flag: "🇵🇱", name: "Polish Złoty" },
  { code: "TRY", flag: "🇹🇷", name: "Turkish Lira" },
  { code: "ZAR", flag: "🇿🇦", name: "South African Rand" },
  { code: "AED", flag: "🇦🇪", name: "UAE Dirham" },
  { code: "THB", flag: "🇹🇭", name: "Thai Baht" },
  { code: "RUB", flag: "🇷🇺", name: "Russian Ruble" },
  { code: "ILS", flag: "🇮🇱", name: "Israeli Shekel" }
];

const DEFAULT_RECENT_CURRENCIES = ["PEN", "USD", "EUR", "ARS", "MXN"];

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
  return [...DEFAULT_RECENT_CURRENCIES];
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
  return { input: "currency", chips: "currency-chips" };
}

function selectCurrency(code, target) {
  const resolvedTarget = target || currencyPickerTarget;
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
  moreChip.textContent = "More…";
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
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "Device";
  const standalone = navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  return `${kind} · ${standalone ? "home-screen app" : "browser"}`;
}

// What this phone keeps about the signed-in owner: the session key, any old
// stored code, and the cached financial data / drafts (so a signed-out device
// holds nothing).
function clearLocalSignIn_() {
  localStorage.removeItem("sessionToken");
  localStorage.removeItem("accessCode");
  localStorage.removeItem(STARTUP_CACHE_KEY);
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

async function callApi(action, payload, attempt = 1, startedAt = performance.now()) {
  if (attempt === 1 && ONCE_ACTIONS.has(action) && !(payload && payload._requestId)) {
    payload = { ...(payload || {}), _requestId: newRequestId_() };
  }
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
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(getSessionToken()
          ? { sessionToken: getSessionToken(), action, payload: payload || {} }
          : { accessCode: getAccessCode(), action, payload: payload || {} }),
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
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  perfRecordCall_(action, performance.now() - startedAt, attempt, json.serverMs, json.coldInstance, !!json.ok);
  if (!json.ok && json.error === "Invalid access code" && getSessionToken()) {
    // This device's session was ended (signed out from another device, the
    // sheet menu, or unused for 90 days): go back to the sign-in screen.
    clearLocalSignIn_();
    showSignedOutScreen_("You were signed out on this device. Enter your access code to sign in again.");
  }
  if (!json.ok) throw new Error(json.error || "Unknown error");
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
    return JSON.parse(localStorage.getItem(STARTUP_CACHE_KEY));
  } catch (err) {
    return null;
  }
}

function saveStartupCache_(bundle) {
  try {
    localStorage.setItem(STARTUP_CACHE_KEY, JSON.stringify(bundle));
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
    const log = JSON.parse(localStorage.getItem(PERF_LOG_KEY) || "[]");
    log.push(entry);
    localStorage.setItem(PERF_LOG_KEY, JSON.stringify(log.slice(-PERF_LOG_MAX)));
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

function showSetupScreen(message) {
  document.getElementById("app").hidden = true;
  const setup = document.getElementById("setup-screen");
  setup.hidden = false;
  document.getElementById("setup-error").textContent = message || "";
}

document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("setup-code-input").value.trim();
  if (!code) return;
  const errorEl = document.getElementById("setup-error");
  errorEl.textContent = "Signing in…";
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

async function loadMeta(prefetchedMeta, skipFormPopulate) {
  meta = prefetchedMeta || await callApi("getMeta", {});
  if (skipFormPopulate) return;
  populateCategoryOptions();
  populateCategoryPicker();
  populatePaidByOptions();
  populatePaymentMethodOptions();
  populateToPaymentMethodOptions();
  populateTags();
  renderSplitFriendChips();
}

function populateCategoryOptions() {
  const select = document.getElementById("category");
  select.innerHTML = "";
  meta.categories
    .filter((c) => c.type === selectedType)
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
  meta.categories
    .filter((c) => c.type === selectedType)
    .forEach((c) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "category-tile";
      tile.innerHTML = `
        <span class="category-tile-icon" style="background:${c.color || "#eee"}">${c.icon || "•"}</span>
        <span class="category-tile-name">${escapeHtml(c.name)}</span>
      `;
      tile.addEventListener("click", () => showDetailForm(c));
      grid.appendChild(tile);
    });
}

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
    label.textContent = "Received from";
    meta.payors.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    const addOpt = document.createElement("option");
    addOpt.value = "__add_payor__";
    addOpt.textContent = "+ Add payor…";
    select.appendChild(addOpt);
  } else {
    label.textContent = "Paid by";
    const meOpt = document.createElement("option");
    meOpt.value = "me";
    meOpt.textContent = "Me";
    select.appendChild(meOpt);

    meta.friends.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      select.appendChild(opt);
    });

    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = "+ Add friend…";
    select.appendChild(addOpt);
  }

  togglePaymentMethodVisibility();
}

function populatePaymentMethodOptions() {
  const select = document.getElementById("payment_method");
  select.innerHTML = "";

  if (meta.paymentMethods.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No payment methods yet";
    select.appendChild(opt);
  }

  // Investment platforms are never a "paid with" account — they're only
  // ever the destination of an investment entry (see Investments.gs).
  meta.paymentMethods.filter((pm) => pm.type !== "investment").forEach((pm) => {
    const opt = document.createElement("option");
    opt.value = pm.id;
    opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "");
    select.appendChild(opt);
  });

  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = "+ Add payment method…";
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
  noneOpt.textContent = selectedType === "investment" ? "Pick a platform…" : "None";
  select.appendChild(noneOpt);
  // An investment's "To" is a platform; a transfer's is a real account.
  const wantPlatforms = selectedType === "investment";
  meta.paymentMethods.filter((pm) => (pm.type === "investment") === wantPlatforms).forEach((pm) => {
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
    if (from) text = to ? `from ${from} to ${to}` : `from ${from}`;
    else if (to) text = `into ${to}`;
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
    opt.textContent = "None (money comes from outside)";
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
    selectedType === "transfer" || isInvestment ? "From" :
    selectedType === "income" ? "Received at" :
    "Payment method";
  document.getElementById("to-payment-method-field").hidden = selectedType !== "transfer" && !isInvestment;
  document.getElementById("to-payment-method-label").textContent = isInvestment ? "Platform" : "To (account it goes into)";
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
    (!editingEntryId || editingEntryOriginalType === "expense" || editingEntryOriginalType === "transfer");
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
  addOpt.textContent = "+ Add friend…";
  select.appendChild(addOpt);
  if (previous && previous !== "__add__" && meta.friends.some((f) => f.id === previous)) select.value = previous;
}

document.getElementById("repayment-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt("Friend's name:");
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
    document.getElementById("repayment-overpay-category-label").textContent = `Category if ${iPaid ? "you paid" : "they paid"} extra (${iPaid ? "expense" : "income"})`;
  }
  document.getElementById("repayment-hint").textContent = isLoan
    ? (iPaid
      ? "You lent them this money, so they now owe you it back. It is not an expense."
      : "They lent you this money, so you now owe them it back. It is not income.")
    : (iPaid
      ? "Pays down what you owe them. It is not an expense — only your debt balance changes."
      : "Pays down what they owe you. It is not income — only their debt balance changes.");

  // This replaces the transfer's own fields: no "Paid by", no "To" — just
  // the one account the money moved through.
  document.getElementById("paid-by-label").hidden = true;
  document.getElementById("paid_by").hidden = true;
  document.getElementById("to-payment-method-field").hidden = true;
  document.getElementById("payment-method-field").hidden = false;
  document.getElementById("payment-method-label").textContent = iPaid ? "Paid from (account)" : "Received into (account)";
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
    toggle.textContent = "Less";
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

  toggle.textContent = "More…";
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

  addRow("me", "Me", () => customOwnAmount, (v) => { customOwnAmount = v; });
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
  const currency = (document.getElementById("currency").value || "PEN").toUpperCase();
  const friendIds = Array.from(splitFriendIds);

  if (friendIds.length === 0) {
    summaryEl.textContent = "Pick who else this is shared with.";
    return;
  }

  if (splitMode === "equal") {
    const { shareEach, ownerShare } = computeEqualShares(amount, friendIds);
    summaryEl.textContent = `${currency} ${moneyFmt(shareEach)} each · ${currency} ${moneyFmt(ownerShare)} to you`;
  } else {
    const shares = computeCustomShares();
    // Empty boxes show what they'd get, as their placeholder.
    Object.keys(splitInputEls).forEach((k) => {
      splitInputEls[k].placeholder = shares.openKeys.includes(k) && !shares.over ? moneyFmt(shares.amounts[k]) : "0.00";
    });
    if (shares.over) {
      summaryEl.textContent = "";
      errorEl.textContent = "That's more than the total amount.";
    } else if (shares.unassigned) {
      summaryEl.textContent = "";
      errorEl.textContent = `Everyone's filled in, but it adds up to ${currency} ${moneyFmt(amount - shares.unassigned / 100)}, not ${currency} ${moneyFmt(amount)}. Clear one box to let it take the rest.`;
    } else {
      const friendsTotal = friendIds.reduce((sum, id) => sum + (shares.amounts[id] || 0), 0);
      summaryEl.textContent = `${currency} ${moneyFmt(friendsTotal)} of ${currency} ${moneyFmt(amount)} to friends · ${currency} ${moneyFmt(shares.amounts.me)} to you`;
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
    throw new Error("Pick at least one friend to split with, or turn the split toggle off.");
  }

  const splits = getSplitPayload();
  const assigned = splits.reduce((sum, s) => sum + s.amount, 0);
  if (splitMode === "custom") {
    const shares = computeCustomShares();
    if (shares.over) throw new Error("The split adds up to more than the total amount.");
    if (shares.unassigned) throw new Error("The amounts don't add up to the total — clear one box to let it take the rest.");
    if (assigned <= 0) throw new Error("Enter at least one friend's amount.");
  }
  if (assigned - amount > 0.004) {
    throw new Error("The split adds up to more than the total amount.");
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
  const name = prompt("Friend's name:");
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
    ? "Money coming back from the platform to your account."
    : "Money you put into the platform.";
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
    const name = prompt("Friend's name:");
    e.target.value = "me";
    if (name && name.trim()) {
      const friend = await callApi("addFriend", { name: name.trim() });
      meta.friends.push(friend);
      refreshFriendChips_();
      populatePaidByOptions();
      document.getElementById("paid_by").value = friend.id;
    }
  } else if (e.target.value === "__add_payor__") {
    const name = prompt("Payor's name (e.g. a client or employer):");
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

document.getElementById("payment_method").addEventListener("change", async (e) => {
  if (e.target.value === "__add__") {
    const nickname = prompt("Payment method name (e.g. \"BCP Visa\"):");
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

    const type = prompt("Type: credit, debit, cash, transfer, or wallet?", "credit") || "credit";
    const last4 = prompt("Last 4 digits (leave blank if none):") || "";
    const pm = await callApi("addPaymentMethod", { nickname: trimmed, type: type.trim(), last_4: last4.trim() });
    meta.paymentMethods.push(pm);
    populatePaymentMethodOptions();
    populateToPaymentMethodOptions();
    document.getElementById("payment_method").value = pm.id;
  }
});

document.getElementById("add-tag-btn").addEventListener("click", async () => {
  const name = prompt("New tag name:");
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

async function ensureExchangeRate(currency, dateStr) {
  if (currency === "PEN") return;
  const month = dateStr.slice(0, 7);
  const existing = await callApi("getExchangeRate", { currency, month });
  if (existing) return;

  const rate = await openRateModal(currency, month, /* required */ true);
  if (rate == null) {
    throw new Error("An exchange rate is required to save this entry.");
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
  document.getElementById("rate-left-label").textContent = inverted ? "1 PEN" : `1 ${currency}`;
  document.getElementById("rate-right-label").textContent = inverted ? currency : "PEN";
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
    document.getElementById("rate-modal-title").textContent = `Exchange rate — ${currency}`;
    document.getElementById("rate-modal-subtitle").textContent = existingRate != null
      ? `Editing the rate on file for ${currency} in ${month}.`
      : `No rate on file for ${currency} in ${month} yet.`;
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
    errorEl.textContent = "Enter a valid number.";
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
      if (!confirm(`This rate (${rate}) is ${pct}% ${rate > prev ? "higher" : "lower"} than the previous one (${prev}). Save it anyway?`)) {
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
      throw new Error("From and To can't be the same account.");
    }
    if (selectedType === "investment" && !toPaymentMethodId && !editingEntryId) {
      throw new Error("Pick the platform.");
    }
    const isWithdrawal = selectedType === "investment" && investmentDirection === "withdrawal";

    if (!date) throw new Error("Date is required.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    const isInvestmentEntry = selectedType === "investment";
    if (!isRepayment && !isInvestmentEntry && !categoryId) throw new Error("Pick a category.");
    // Investments send no category at all — the server files them under its default.
    const categoryField = isInvestmentEntry ? {} : { category_id: categoryId };
    if (selectedType === "transfer" && !isRepayment && !paymentMethodId && !toPaymentMethodId) {
      throw new Error("Pick the account the money leaves (From) or the one it goes into (To).");
    }
    // A transfer may have only a "To" (money arriving from outside the app).
    if (usesPaymentMethod && !paymentMethodId && !(selectedType === "transfer" && toPaymentMethodId)) throw new Error("Pick a payment method.");
    const splits = validateSplitIfEnabled();
    const tagIds = Array.from(selectedTagIds);

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
      if (!friendId || friendId === "__add__") throw new Error("Pick a friend.");
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
        const kind = direction === "they_owe_me" ? "income" : "an expense";
        extraNote = overpayCategoryId
          ? ` ${currency} ${moneyFmt(result.overpaid)} was more than the debt, so it was also recorded as ${kind}.`
          : ` ${currency} ${moneyFmt(result.overpaid)} was more than the debt — it's in your review queue as ${kind}, waiting for a category.`;
        refreshReviewQueue().catch(() => {});
      }
      refreshLoans().catch(() => {});
      showFormNotice_(isLoanKind
        ? `Loan ${direction === "they_owe_me" ? "to" : "from"} ${friendName} recorded.`
        : `Repayment ${direction === "they_owe_me" ? "from" : "to"} ${friendName} recorded.${extraNote}`);
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
          to_payment_method_id: toPaymentMethodId
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
        to_payment_method_id: toPaymentMethodId
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
        active: true
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
        tag_ids: tagIds
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
      showFormNotice_(`Programmed for ${date} — see More → Programmed income/expenses. It'll turn into a real entry once it actually happens.`);
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
      alert("Your entry was saved, but the split with your friend(s) was NOT. Open it in Recent entries and save the split again. Don't add the entry a second time.");
    } else if (billSaveFailed) {
      alert("Your entry and its split were saved, but the bill's item list could not be kept, so you won't be able to edit its items later. Don't add the entry a second time.");
    }
  } catch (err) {
    errorEl.textContent = writesDone
      ? "Saved — but the screen couldn't refresh (" + err.message + "). Pull down or reopen the app to see it. Don't add it again."
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
  const flag = currency === "PEN" ? "" : findCurrency(currency).flag + " ";
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

  if (entry.currency === "PEN") {
    if (!hasSplit) {
      return `<span class="primary-amt">PEN ${moneyFmt(entry.amount)}</span>`;
    }
    const totalLine = `<span class="original-amt">Total PEN ${moneyFmt(entry.amount)}</span>`;
    return `<span class="primary-amt">PEN ${moneyFmt(entry.own_share)}</span>${totalLine}`;
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
    return `<span class="primary-amt">PEN ${moneyFmt(entry.amount_pen)}</span>${originalLine}`;
  }

  const primaryPen = entry.own_share_pen != null ? entry.own_share_pen : entry.amount_pen;
  const ownShareLine = `<span class="original-amt">${formatAmount(entry.own_share, entry.currency)}</span>`;
  const totalLine = `<span class="original-amt">Total ${formatAmount(entry.amount, entry.currency)}</span>`;
  return `<span class="primary-amt">PEN ${moneyFmt(primaryPen)}</span>${ownShareLine}${totalLine}`;
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
      ? (paidThem ? `Repayment to ${l.friend}` : `Repayment from ${l.friend}`)
      : (paidThem ? `Loan from ${l.friend}` : `Loan to ${l.friend}`);
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
    ? (withdrawal ? `Withdrawal from ${escapeHtml(platform)}` : `Investment in ${escapeHtml(platform)}`)
    : `${withdrawal ? "Withdrawal" : "Investment"} — ${escapeHtml(categoryName(entry.category_id))}`;
  const metaText = account ? `${withdrawal ? "received at" : "from"} ${escapeHtml(account)}` : "no account set";
  return { title: `${marker}${title}`, meta: metaText };
}

function categoryName(id) {
  const c = findCategory(id);
  return c ? c.name : "(unknown category)";
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
  if (paidBy === "me") return "Me";
  const f = meta.friends.find((fr) => fr.id === paidBy);
  return f ? f.name : paidBy;
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
    ? `<div class="entry-queue-status">💾 Saving…</div>`
    : entry._queueStatus === "failed"
      ? `<div class="entry-queue-status entry-queue-failed">⚠️ Couldn't save — tap to retry</div>`
      : "";

  const left = document.createElement("div");
  left.className = "entry-left";
  left.innerHTML = `
    <div class="entry-category">${headline.title}</div>
    ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
    <div class="entry-meta">${entry.date} · ${headline.meta}</div>
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
  btn.textContent = "Load more";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Loading…";
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
      btn.textContent = "Load more";
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

// Re-renders the already-fetched entry list with the current queued-edit
// overlay applied — no network call. Used whenever a background edit's
// status changes (see flushEntryEdit_), so the "Saving…"/"Couldn't save"
// tag updates immediately.
function renderEntryListFromCache_() {
  const list = document.getElementById("entry-list");
  const entries = applyQueuedEditOverlay_(lastRenderedEntries_);
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<div class="status-msg">No entries yet — add your first one above.</div>';
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
const SEARCH_CACHE_VERSION = 2;          // bump to drop every phone's saved copy
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
      searchIndexError = err.message || "unknown error";
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
  document.getElementById("entry-search-hint").textContent = "Updating…";
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
    hint.textContent = `Type at least ${SEARCH_MIN_CHARS} letters…`;
    return;
  }
  if (!searchIndex) {
    hint.textContent = searchIndexError
      ? `Couldn't load your entries for search (${searchIndexError}). Keep typing to retry.`
      : "Loading all your entries for instant search… (first time only)";
    return;
  }

  const words = normalizeSearchText_(term).split(/\s+/).filter(Boolean);
  const matches = searchIndex.filter((e) => words.every((w) => e._s.indexOf(w) !== -1));
  hint.textContent = matches.length === 0
    ? ""
    : `${matches.length} matching ${matches.length === 1 ? "entry" : "entries"} — tap one to edit.`;

  if (matches.length === 0) {
    box.innerHTML = `<div class="status-msg">No entries match “${escapeHtml(term)}”.</div>`;
    return;
  }
  matches.slice(0, searchShown).forEach((entry) => box.appendChild(buildSearchRow_(entry)));
  if (matches.length > searchShown) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "cancel-edit-btn search-show-more";
    more.textContent = `Show more (${matches.length - searchShown} left)`;
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
    hint.textContent = "Reloading everything…";
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
    tagIds: [...selectedTagIds]
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
  selectCurrency(d.currency || "PEN", "entry");
  if (d.date) { document.getElementById("date").value = d.date; entryDateTouched_ = true; }
  if (d.paidBy) document.getElementById("paid_by").value = d.paidBy;
  togglePaymentMethodVisibility();
  // A transfer's "From" may legitimately be None (blank).
  if (d.paymentMethodId || d.type === "transfer") document.getElementById("payment_method").value = d.paymentMethodId || "";
  document.getElementById("to_payment_method").value = d.toPaymentMethodId || "";
  selectedTagIds.clear();
  (d.tagIds || []).forEach((id) => selectedTagIds.add(id));
  populateTags();
  showFormNotice_("↩️ Restored the entry you were typing — it wasn't saved yet. Clear the amount and description to drop it.");
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
    if (typed && !confirm("Cancel this entry? What you've typed will be discarded.")) return;
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
    document.getElementById("payment_method").value = entry.payment_method_id || "";
  }
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

  document.getElementById("edit-mode-banner").hidden = false;
  document.getElementById("submit-btn").textContent = "Update entry";
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
  document.getElementById("submit-btn").textContent = "Save entry";
  document.getElementById("cancel-edit-btn-2").hidden = true;
  document.getElementById("delete-entry-btn").hidden = true;
  selectedTagIds.clear();
  populateTags();
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
  selectCurrency("PEN", "entry");
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
  let confirmText = `Delete ${editingEntrySummary_ || "this entry"}? This can't be undone.`;
  if (["transfer", "expense", "income"].includes(editingEntryOriginalType)) {
    const links = await callApi("getEntryRepaymentLinks", { id: editingEntryId });
    if (links.forgiveness) {
      const f = links.forgiveness;
      confirmText = `This entry records you forgiving ${f.friend}'s debt. Deleting it also undoes the forgiveness, so ${f.direction === "they_owe_me" ? "they owe you" : "you owe them"} that amount again. Continue?`;
    }
    if (links.loan) {
      alert("This entry is the money movement of a loan — delete or edit that loan from the Loans tab instead.");
      return;
    }
    if (links.repayment) {
      const r = links.repayment;
      confirmText = `This is a repayment ${r.direction === "they_owe_me" ? "from" : "to"} ${r.friend} (${r.currency} ${moneyFmt(r.total)}). ` +
        `Deleting it also cancels the repayment, so ${r.direction === "they_owe_me" ? "they owe you" : "you owe them"} that amount again. Continue?`;
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
  document.getElementById("edit-entry-modal-title").textContent = "Edit transaction";
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
  document.getElementById("edit-entry-modal-title").textContent = "Confirm transaction";
  document.getElementById("edit-mode-banner").textContent = "✏️ Confirming entry";
  document.getElementById("submit-btn").textContent = "Confirm entry";
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
  const head = label ? `"${label}"` : "this item";
  const detail = [amountText, extra].filter(Boolean).join(", ");
  return detail ? `${head} (${detail})` : head;
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
    alert("Still saving your last change to this entry — try again in a moment.");
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
  if (merged.currency === "PEN") {
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
  banner.textContent = failed.length === 1
    ? "⚠️ 1 entry couldn't save — tap to review"
    : `⚠️ ${failed.length} entries couldn't save — tap to review`;
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
    alert("That entry isn't in the currently loaded list — scroll Recent entries to find it, or pull down to refresh.");
  }
});

// <option>s for a transfer's From/To pickers in the review queue — every
// payment method, with a blank "not set" first (both ends are optional).
// Investment platforms only (Payment Methods of type "investment") — the
// pending-investment row's one remaining decision when everything else was
// already set through Telegram.
function investmentPlatformOptions_(selectedId) {
  const opts = meta.paymentMethods.filter((pm) => pm.type === "investment").map((pm) =>
    `<option value="${pm.id}" ${pm.id === selectedId ? "selected" : ""}>${escapeHtml(pm.nickname)}</option>`
  );
  return `<option value="">Pick the platform…</option>` + opts.join("");
}

function transferAccountOptions_(selectedId, blankLabel) {
  const opts = meta.paymentMethods.map((pm) =>
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
    el.textContent = `🔄 Checking for new ${noun}…`;
    el.hidden = false;
  } else if (state === "failed") {
    el.textContent = `⚠️ Couldn't confirm — showing the last known ${noun}. Pull down to retry.`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}
function setReviewCheckStatus_(state) {
  setCheckStatus_("review-check-status", state, "review items");
}
function setEntriesCheckStatus_(state) {
  setCheckStatus_("entries-check-status", state, "entries");
}
function setMetaCheckStatus_(state) {
  setCheckStatus_("meta-check-status", state, "categories & accounts");
}
function setRecurringCheckStatus_(state) {
  setCheckStatus_("recurring-check-status", state, "programmed items");
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

    const categoryOptions = meta.categories
      .filter((c) => c.type === entry.type)
      .map((c) => `<option value="${c.id}" ${c.id === entry.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");

    item.innerHTML = `
      <div class="review-item-top">
        <div>
          <div class="review-item-desc">${escapeHtml(entry.description || "(no description)")}</div>
          <div class="review-item-meta">${entry.date} · ${entry.type}</div>
        </div>
        <div class="review-item-amount">${formatAmount(entry.amount, entry.currency)}</div>
      </div>
      ${(entry.twins || []).length ? `<div class="review-dup-warning">⚠️ Possible duplicate — same day, amount and merchant as ${(entry.twins || []).map((t) => `"${escapeHtml(t.description || "an entry")}" (${t.status})`).join(", ")}. Discard if it's a copy; confirm if it's a real repeat.</div>` : ""}
      <div class="review-item-fields">
        ${entry.type === "investment" ? "" : `<select class="review-category">
          <option value="">Pick a category…</option>
          ${categoryOptions}
        </select>`}
        <input class="review-description" type="text" value="${escapeHtml(entry.description || "")}" placeholder="Description">
        <input class="review-amount" type="text" inputmode="decimal" value="${Math.abs(Number(entry.amount))}" placeholder="Amount">
        ${entry.type === "transfer" ? `
        <label class="review-transfer-label">⬆️ From</label>
        <select class="review-from">${transferAccountOptions_(entry.payment_method_id, "Pick the account it left…")}</select>
        <label class="review-transfer-label">⬇️ To</label>
        <select class="review-to">${transferAccountOptions_(entry.to_payment_method_id, "Pick the account it went into…")}</select>` : ""}
        ${entry.type === "investment" ? `
        <label class="review-transfer-label">📈 Platform${Number(entry.amount) < 0 ? " (withdrawal — money coming back)" : ""}</label>
        <select class="review-platform">${investmentPlatformOptions_(entry.to_payment_method_id)}</select>
        ${Number(entry.amount) < 0 ? `
        <label class="review-transfer-label">⬇️ Received at</label>
        <select class="review-land">${transferAccountOptions_(entry.payment_method_id, "Pick the account…")}</select>` : ""}` : ""}
      </div>
      <div class="review-item-actions">
        <button type="button" class="review-confirm-btn">✅ Confirm</button>
        <button type="button" class="review-discard-btn">❌ Discard</button>
      </div>
      ${entry.type === "expense" ? `
      <div class="review-item-secondary-actions">
        <button type="button" class="add-inline review-split-btn">🔀 Split</button>
        <button type="button" class="add-inline review-repay-btn">💰 Mark as repayment</button>
        <button type="button" class="add-inline review-loan-btn">🤝 Convert to loan</button>
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
        alert("Pick a category first.");
        return;
      }
      if (!amountStr || isNaN(amount) || amount <= 0) {
        alert("Enter a valid amount.");
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
          alert("From and To can't be the same account.");
          return;
        }
        fields.payment_method_id = fromId;
        fields.to_payment_method_id = toId;
      }
      if (entry.type === "investment") {
        const platformId = item.querySelector(".review-platform").value;
        if (!platformId) {
          alert("Pick the platform first — an investment only counts once it has one.");
          return;
        }
        fields.to_payment_method_id = platformId;
        const landEl = item.querySelector(".review-land");
        if (landEl) fields.payment_method_id = landEl.value;
      }
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
      if (!confirm(`Discard ${describeForConfirm_(entry.description || "", formatAmount(entry.amount, entry.currency), entry.date)}? This can't be undone.`)) return;

      queueReviewAction_(entry.id, "discard", null);
      item.remove();
      document.getElementById("review-count").textContent = list.children.length;
      if (list.children.length === 0) document.getElementById("review-queue-card").hidden = true;

      applyReviewAction_({ id: entry.id, action: "discard", fields: null }).catch(() => {
        // Stays queued, same as above.
      });
    });

    // Phase 5.7's three deferred review-queue actions — only ever shown
    // for a pending expense (never a plain internal transfer, which is
    // always the owner's own account-to-account move, never a friend
    // transaction; see EmailParser.gs). Unlike Confirm/Discard, above,
    // these don't use the offline-optimistic queue — they're rarer,
    // multi-step actions (picking a friend, a split, etc.) that don't
    // reduce to "retry this fields object blindly," so they just call the
    // API directly and surface an error if it fails, same as every other
    // modal in this app.
    if (entry.type === "expense") {
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
          alert("This entry was already confirmed, changed or removed elsewhere — refreshing the list.");
          refreshReviewQueue().catch(() => {});
          return null;
        }
        const amt = parseFloat(amountInput.value.trim());
        const rowCategory = item.querySelector(".review-category").value;
        const rowDescription = item.querySelector(".review-description").value.trim();
        const amountEdited = !isNaN(amt) && amt > 0 && amt !== Math.abs(Number(entry.amount));
        return Object.assign({}, fresh, {
          category_id: rowCategory && rowCategory !== (entry.category_id || "") ? rowCategory : (fresh.category_id || rowCategory),
          description: rowDescription !== (entry.description || "") ? rowDescription : (fresh.description || ""),
          amount: amountEdited ? amt : fresh.amount
        });
      };
      const withRowEdits = (open) => async () => {
        const merged = await entryWithRowEdits();
        if (merged) open(merged);
      };
      item.querySelector(".review-split-btn").addEventListener("click", withRowEdits((e) => openConfirmPendingPopup(e)));
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

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.screen));
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
    label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
  };
}

function yearBounds(d) {
  const y = d.getFullYear();
  return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: String(y) };
}

function getPeriodBounds() {
  if (periodType === "month") return monthBounds(periodAnchor);
  if (periodType === "year") return yearBounds(periodAnchor);
  if (periodType === "alltime") return { startDate: null, endDate: null, label: "All-time" };
  if (periodType === "custom") {
    const start = document.getElementById("custom-start").value;
    const end = document.getElementById("custom-end").value;
    return { startDate: start || null, endDate: end || null, label: "Custom range" };
  }
  return { startDate: null, endDate: null, label: "" };
}

function renderPeriodSelector() {
  const bounds = getPeriodBounds();
  document.getElementById("period-label").textContent = bounds.label;

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
  return `PEN ${moneyFmt(n)}`;
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
    excludedNote.textContent = `${data.excludedCount} entr${data.excludedCount === 1 ? "y" : "ies"} excluded — missing an exchange rate for that month.`;
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
      name: `Others (${rest.length})`,
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
    listEl.innerHTML = '<div class="status-msg">Nothing here yet.</div>';
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
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  bringModalToFront_(backdrop);
  backdrop.hidden = false;

  try {
    const entries = await callApi("listEntries", payload);
    renderDrilldownEntries(entries);
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
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

  const bounds = getPeriodBounds();

  const payload = { startDate: bounds.startDate, endDate: bounds.endDate, type: overviewType };
  if (kind === "category") payload.categoryId = item.id;
  else if (kind === "tag") payload.tagId = item.id;
  else if (kind === "paymentMethod") payload.paymentMethodId = item.id;

  await openDrilldownWithPayload_(
    payload,
    `${item.icon ? item.icon + " " : ""}${item.name}`,
    `${bounds.label} · ${overviewType === "expense" ? "Expense" : "Income"}`
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
  // "Projected" (not "Pace to stay in budget") since the dashed line
  // stopped being an even pace toward the flat budget cap and became the
  // same expected+programmed forecast Projections draws (2026-09-22) —
  // the cap itself is still shown, just as its own separate flat
  // reference line (budgetLineY, below), so the wording only needs to
  // describe THIS line.
  document.getElementById("drilldown-chart-legend-2").textContent = "Projected";

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
    categoriesEl.textContent = budget.category_ids.map((id) => {
      const cat = meta.categories.find((c) => c.id === id);
      return cat ? `${cat.icon ? cat.icon + " " : ""}${cat.name}` : "";
    }).filter(Boolean).join(", ");
  } else {
    categoriesEl.hidden = true;
  }

  const p = budget.progress;

  // budget.category_ids is null for an "All expense categories" budget —
  // omitting categoryIds entirely then matches every category, same as
  // no filter at all.
  const payload = { startDate: p.startDate, endDate: p.endDate, type: "expense" };
  if (budget.category_ids) payload.categoryIds = budget.category_ids;

  await openDrilldownWithPayload_(
    payload,
    `${budget.category_icon ? budget.category_icon + " " : ""}${budget.category_name}`,
    `${p.effectivePeriodType === "yearly" ? "Year" : "Month"} · Budget ${budget.currency} ${moneyFmt(p.effectiveAmount)}`
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
  const periodWord = p.effectivePeriodType === "yearly" ? "year" : "month";

  if (remaining <= 0) {
    note.textContent = `You're already over budget for this ${periodWord}.`;
    return;
  }

  const discretionary = remaining - upcomingRecurring;
  const daysLeft = days.filter((d) => d >= today).length;

  if (discretionary <= 0) {
    note.textContent = `${budget.currency} ${moneyFmt(upcomingRecurring)} in upcoming recurring expenses uses up what's left — nothing free to spend for the rest of this ${periodWord}.`;
    return;
  }

  const perDay = discretionary / Math.max(daysLeft, 1);
  const recurringPart = upcomingRecurring > 0
    ? ` after ${budget.currency} ${moneyFmt(upcomingRecurring)} in upcoming recurring expenses`
    : "";
  note.textContent = `${budget.currency} ${moneyFmt(discretionary)} left to spend freely${recurringPart} — about ${budget.currency} ${moneyFmt(perDay)}/day for the ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`;
}

function renderDrilldownEntries(entries) {
  const list = document.getElementById("drilldown-list");
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<div class="status-msg">No transactions in this period.</div>';
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
        <div class="entry-meta">${entry.date} · ${headline.meta}</div>
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
  if (!confirm(`Delete the ${drilldownBudget.period_type === "yearly" ? "yearly" : "monthly"} budget ${describeForConfirm_(drilldownBudget.name || drilldownBudget.category_name || "", drilldownBudget.currency ? `${drilldownBudget.currency} ${moneyFmt(drilldownBudget.amount)}` : "")}? This can't be undone.`)) return;
  const id = drilldownBudget.id;
  closeDrilldown();
  try {
    await callApi("deleteBudget", { id });
  } catch (err) {
    // The dialog is already closed — without this the failure (offline, slow
    // network) was invisible and the budget just reappeared on next refresh.
    alert("Couldn't delete the budget (" + err.message + "). It's still there — try again.");
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
  meta.categories
    .filter((c) => c.type === "expense")
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
  if (currency === "PEN") {
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
  if (!hasRate) document.getElementById("budget-rate-warning-currency").textContent = currency;
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
  document.getElementById("budget-modal-title").textContent = budget ? "Edit budget" : "Add budget";
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
  document.getElementById("budget-currency").value = budget ? budget.currency : "PEN";
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
      throw new Error("Pick at least one category.");
    }
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");

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
  if (!confirm(`Delete the ${budgetPeriodType === "yearly" ? "yearly" : "monthly"} budget ${describeForConfirm_(budgetLabel, b && b.currency ? `${b.currency} ${moneyFmt(b.amount)}` : "")}? This can't be undone.`)) return;
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
      `<div class="status-msg">Couldn't refresh: ${escapeHtml(err.message)}</div>`;
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
      ? "Needs an exchange rate for " + b.currency
      : `${b.currency} ${moneyFmt(p.spent)} / ${amountLabel}`;
    const periodLabel = (p.effectivePeriodType === "yearly" ? "this year" : "this month") +
      (p.annualized ? " (monthly × 12)" : "");

    if (b.currency !== "PEN" && p.rate != null) {
      fxNotes.push(`1 ${b.currency} = ${moneyFmt(p.rate)} PEN — ${b.category_name}`);
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
    summaryNote.textContent = `${summary.excludedCount} budget${summary.excludedCount === 1 ? "" : "s"} excluded — missing an exchange rate.`;
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
    if (/wrong|too many/i.test(err.message)) {
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
    if (err.message === "Invalid access code") {
      // Keep showing cached data under a now-invalid code, and every
      // action would keep silently failing — surface it instead.
      clearLocalSignIn_();
      showSignedOutScreen_("That code wasn't accepted. Try again.");
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
      `<div class="status-msg">Couldn't load data: ${escapeHtml(err.message)}</div>`;
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
  showSignedOutScreen_("Signed out. Enter your access code to sign in again.");
}

document.getElementById("more-signout-btn").addEventListener("click", async () => {
  if (!confirm("Sign out of this device? Its saved data and any unsaved entry are removed from this phone; you'll need your access code to sign in again.")) return;
  await signOutThisDevice_();
});

function formatSessionTime_(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function openDevicesModal_() {
  const backdrop = document.getElementById("devices-modal-backdrop");
  const list = document.getElementById("devices-list");
  const errorEl = document.getElementById("devices-error");
  const statusEl = document.getElementById("devices-status");
  errorEl.textContent = "";
  statusEl.textContent = "";
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
  // Still holding the old stored code (the background switch-over hasn't worked
  // yet)? Try it now, so the list below is right.
  if (!getSessionToken() && getAccessCode()) await migrateLegacyCodeToSession_();
  statusEl.textContent = getSessionToken()
    ? "✅ This phone is signed in with a session key (the access code is not stored here)."
    : "⚠️ This phone is still using the access code directly. It will switch to a session key the next time the app opens with a connection.";
  let sessions;
  try {
    sessions = await callApi("listSessions", {});
  } catch (err) {
    list.innerHTML = "";
    errorEl.textContent = "Couldn't load the list: " + err.message;
    return;
  }
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = '<p class="hint">No signed-in devices yet. This device is using the access code directly and will sign in the next time the app opens.</p>';
  }
  sessions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "skipped-month-row";
    row.innerHTML = `
      <div>
        <div>${escapeHtml(s.device_name || "Device")}${s.current ? ' <span class="hint">(this device)</span>' : ""}</div>
        <div class="hint">Last used ${escapeHtml(formatSessionTime_(s.last_used_at))}</div>
      </div>
      <button type="button" class="add-inline">${s.current ? "Sign out" : "Sign out"}</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      const label = s.current ? "this device" : `"${s.device_name}"`;
      if (!confirm(`Sign out ${label}? It stops working immediately.`)) return;
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
document.getElementById("devices-modal-close").addEventListener("click", () => { document.getElementById("devices-modal-backdrop").hidden = true; });
document.getElementById("devices-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "devices-modal-backdrop") e.target.hidden = true;
});
document.getElementById("devices-signout-others-btn").addEventListener("click", async () => {
  if (!confirm("Sign out all your other devices? Only this one stays signed in.")) return;
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
    btn.textContent = "Copied ✓";
  } catch (err) {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => { btn.textContent = "Copy report"; }, 2000);
});
document.getElementById("exchange-rates-back-btn").addEventListener("click", () => showScreen("more"));

// ---- Export data screen (More tab) ----
// The server builds the chosen files and emails them to the address saved in
// the backend (Export.gs) — the app only says which files and which dates, so
// there is nothing to download on the phone and no way to point the data at
// another address from here.

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
  refreshExportScreen_();
}

function refreshExportScreen_() {
  const entries = exportEl_("export-entries-check").checked;
  exportEl_("export-entries-options").hidden = !entries;
  exportEl_("export-custom-fields").hidden = exportEl_("export-range").value !== "custom";
  exportEl_("export-send-btn").disabled = !(entries || exportEl_("export-backup-check").checked);
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

async function sendExport_() {
  const status = exportEl_("export-status");
  const btn = exportEl_("export-send-btn");
  const cards = [];
  if (exportEl_("export-entries-check").checked) cards.push("entries");
  if (exportEl_("export-backup-check").checked) cards.push("backup");
  if (!cards.length) return;
  const range = exportDateRange_();
  if (cards.includes("entries") && exportEl_("export-range").value === "custom" && !range.startDate && !range.endDate) {
    status.style.color = "#d64545";
    status.textContent = "Pick a From and/or To date for the custom range.";
    return;
  }
  btn.disabled = true;
  status.style.color = "";
  status.textContent = "Preparing and sending… this can take up to a minute for All time.";
  try {
    const res = await callApi("exportData", {
      cards, startDate: range.startDate, endDate: range.endDate,
      includePending: exportEl_("export-pending-check").checked
    });
    const parts = res.files.map((f) => f.kind === "entries"
      ? `${f.name} (${f.rows.toLocaleString()} entries)`
      : `${f.name} (${f.rows.toLocaleString()} records)`);
    status.textContent = `✓ Sent to your email: ${parts.join(" and ")}.`;
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
    box.innerHTML = '<div class="status-msg">Nothing recorded yet — use the app for a while, then come back.</div>';
    return;
  }
  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  box.innerHTML = rows.map((r) => `
    <div class="perf-row">
      <div class="perf-name">${escapeHtml(r.name)} <span class="hint">×${r.total.n}</span></div>
      <div class="hint">median ${fmt(r.total.median)} · p90 ${fmt(r.total.p90)} · max ${fmt(r.total.max)}${
        r.server ? ` · server ${fmt(r.server.median)}` : ""}${
        r.cold ? ` · ${r.cold} cold` : ""}${r.retried ? ` · ${r.retried} retried` : ""}${r.failed ? ` · ${r.failed} failed` : ""}</div>
    </div>`).join("");
}

// ---- Exchange rates (More tab) ----

async function refreshExchangeRates() {
  const list = document.getElementById("exchange-rates-list");
  const emptyNote = document.getElementById("exchange-rates-empty-note");
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  let rates;
  try {
    rates = await callApi("listExchangeRates");
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
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
      <div class="recurring-row-amount">1 ${r.currency} = PEN ${moneyFmt(r.rate)}</div>
    `;
    row.addEventListener("click", async () => {
      const newRate = await openRateModal(r.currency, r.month, /* required */ false, r.rate);
      if (newRate != null) refreshExchangeRates();
    });
    list.appendChild(row);
  });
}

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
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  if (re.frequency === "yearly") return `Yearly, ${MONTH_NAMES_SHORT[re.month - 1]} ${re.day}`;
  return `Monthly, day ${re.day}`;
}

// Same "big = my share, small/grey = total" treatment a split real
// expense gets (see CLAUDE.md) — split_total (from listRecurringExpenses)
// is 0 for the common unsplit case, so this collapses to the plain single
// line then.
function renderRecurringAmountHtml_(re) {
  const isIncome = re.category_type === "income";
  const hasSplit = re.split_total > 0.005;
  const ownAmount = hasSplit ? re.amount - re.split_total : re.amount;
  const primary = `<span class="primary-amt">${isIncome ? "+" : ""}${formatAmount(ownAmount, re.currency)}</span>`;
  if (!hasSplit) return primary;
  return `${primary}<span class="original-amt">Total ${formatAmount(re.amount, re.currency)}</span>`;
}

function renderRecurringRow_(re) {
  const isIncome = re.category_type === "income";
  const row = document.createElement("div");
  row.className = "recurring-row" + (re.active ? "" : " inactive");
  row.innerHTML = `
    <div>
      <div class="recurring-row-name">${re.category_icon ? re.category_icon + " " : ""}${escapeHtml(re.description || re.category_name)}</div>
      <div class="recurring-row-sub">${escapeHtml(re.category_name)} · ${recurringFreqLabel_(re)}${re.active ? "" : " · Paused"}${re.split_total > 0.005 ? " · Split" : ""}</div>
    </div>
    <div class="recurring-row-amount${isIncome ? " income" : ""}">${renderRecurringAmountHtml_(re)}</div>
  `;
  row.addEventListener("click", () => openRecurringModal(re));
  return row;
}

async function refreshRecurringExpenses() {
  const list = document.getElementById("recurring-list");
  const emptyNote = document.getElementById("recurring-empty-note");
  const onetimeList = document.getElementById("recurring-onetime-list");
  const onetimeEmptyNote = document.getElementById("recurring-onetime-empty-note");
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  onetimeList.innerHTML = "";
  let items;
  try {
    items = await callApi("listRecurringExpenses");
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const recurring = items.filter((re) => re.frequency !== "once");
  const onetime = items.filter((re) => re.frequency === "once");

  list.innerHTML = "";
  emptyNote.hidden = recurring.length > 0;
  recurring.forEach((re) => list.appendChild(renderRecurringRow_(re)));

  onetimeList.innerHTML = "";
  onetimeEmptyNote.hidden = onetime.length > 0;
  onetime.forEach((re) => onetimeList.appendChild(renderRecurringRow_(re)));
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function populateRecurringCategoryChips() {
  const container = document.getElementById("recurring-category-chips");
  container.innerHTML = "";
  meta.categories
    .filter((c) => c.type === "expense" || c.type === "income")
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
  const show = cat && cat.type === "expense";
  document.getElementById("recurring-split-field").hidden = !show;
  if (!show) resetRecurringSplitState();
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
  const currency = (document.getElementById("recurring-currency").value || "PEN").toUpperCase();
  const friendIds = Array.from(recurringSplitFriendIds);

  if (friendIds.length === 0) {
    summaryEl.textContent = "Pick who else this is shared with.";
    return;
  }

  if (recurringSplitMode === "equal") {
    const { shareEach, ownerShare } = computeEqualShares(amount, friendIds);
    summaryEl.textContent = `${currency} ${moneyFmt(shareEach)} each · ${currency} ${moneyFmt(ownerShare)} to you`;
  } else {
    const assigned = friendIds.reduce((sum, id) => sum + (parseFloat(recurringCustomSplitAmounts[id]) || 0), 0);
    const remaining = amount - assigned;
    summaryEl.textContent = `${currency} ${moneyFmt(assigned)} of ${currency} ${moneyFmt(amount)} assigned · ${currency} ${moneyFmt(Math.max(remaining, 0))} left to you`;
    if (remaining < -0.004) errorEl.textContent = "That's more than the total amount.";
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
    throw new Error("Pick at least one friend to split with, or turn the split toggle off.");
  }

  const splits = getRecurringSplitPayload();
  const assigned = splits.reduce((sum, s) => sum + s.amount, 0);
  if (recurringSplitMode === "custom" && assigned <= 0) {
    throw new Error("Enter at least one friend's amount.");
  }
  if (assigned - amount > 0.004) {
    throw new Error("The split adds up to more than the total amount.");
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
  const name = prompt("Friend's name:");
  if (!name || !name.trim()) return;
  const friend = await callApi("addFriend", { name: name.trim() });
  meta.friends.push(friend);
  refreshFriendChips_();
  recurringSplitFriendIds.add(friend.id);
  renderRecurringSplitFriendChips();
  renderRecurringSplitRows();
  renderRecurringSplitSummary();
});

// The day/month picker is a native <input type="date"> — the same
// control (and, on a phone, the same tap-to-open calendar) the main
// entry form's own date field uses — rather than plain number inputs.
// For monthly/yearly, only the day (or day+month) actually gets stored;
// the year is a throwaway placeholder (today's) purely so the input
// holds a valid date to pick from. A monthly item whose day is 29-31
// still needs a month with enough days to expose that date in the
// calendar UI, hence the hint text below the field. A one-time item is
// different — its real year matters (it only ever happens once), so the
// picker's actual value is used as-is, with no day/month extraction.
function setRecurringFrequency_(freq) {
  recurringFrequency = freq;
  document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.frequency === freq);
  });
  const dateInput = document.getElementById("recurring-occurrence-date");
  const todayIso = todayLocalISO();
  // Start/end dates only make sense for an item that repeats.
  document.getElementById("recurring-window-fields").hidden = freq === "once";
  if (freq === "once") {
    document.getElementById("recurring-occurrence-date-label").textContent = "Date";
    document.getElementById("recurring-occurrence-date-hint").textContent =
      "A single future payment — once it happens and gets confirmed as a real entry, it drops off the \"Programmed this month\" list on its own.";
    dateInput.min = todayIso;
    return;
  }
  dateInput.removeAttribute("min");
  const isYearly = freq === "yearly";
  document.getElementById("recurring-occurrence-date-label").textContent = isYearly ? "Day and month" : "Day of month";
  document.getElementById("recurring-occurrence-date-hint").textContent = isYearly
    ? "Pick any date — its day and month repeat every year (the year itself is ignored)."
    : "Pick any date — only the day is used (a 31st lands on the last day of shorter months). Browse to a longer month to pick a late day.";
}

document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setRecurringFrequency_(tab.dataset.frequency));
});

async function openRecurringModal(re) {
  editingRecurringId = re ? re.id : null;
  document.getElementById("recurring-modal-title").textContent = re ? "Edit programmed item" : "Add programmed item";
  document.getElementById("recurring-form-error").textContent = "";
  document.getElementById("recurring-description").value = re ? re.description : "";

  selectedRecurringCategoryId = re ? re.category_id : null;
  populateRecurringCategoryChips();

  document.getElementById("recurring-amount").value = re ? re.amount : "";
  document.getElementById("recurring-currency").value = re ? re.currency : "PEN";
  renderCurrencyChips("recurring");

  const frequency = re ? re.frequency : "monthly";
  setRecurringFrequency_(frequency);
  if (frequency === "once") {
    // Real year matters here — a one-time item only ever happens once,
    // unlike monthly/yearly's throwaway neutral-year placeholder below.
    document.getElementById("recurring-occurrence-date").value = re && re.date ? re.date : todayLocalISO();
  } else {
    const neutralYear = new Date().getFullYear();
    const day = String(re ? re.day : 1).padStart(2, "0");
    const month = String(re ? re.month : 1).padStart(2, "0");
    document.getElementById("recurring-occurrence-date").value = `${neutralYear}-${month}-${day}`;
  }
  document.getElementById("recurring-active-checkbox").checked = re ? re.active : true;
  document.getElementById("recurring-delete-btn").hidden = !re;
  document.getElementById("recurring-start-date").value = re ? (re.start_date || "") : "";
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
    if (splits.length) {
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
  }
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
    row.innerHTML = `<span>${MONTH_NAMES_SHORT[mm - 1]} ${y}</span><button type="button" class="add-inline">Undo skip</button>`;
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
        alert("Couldn't undo the skip (" + err.message + ").");
      }
    });
    list.appendChild(row);
  });
}

function closeRecurringModal() {
  document.getElementById("recurring-modal-backdrop").hidden = true;
  editingRecurringId = null;
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
  btn.textContent = "Searching…";
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
          <div class="link-candidate-date">${c.date} · ${c.currency} ${moneyFmt(c.amount)}${confident ? "" : ' <span class="hint">(less certain)</span>'}</div>
          <div class="link-candidate-desc">${escapeHtml(c.description || "(no description)")}</div>
        </div>
      `;
      listEl.appendChild(row);
    });
  } catch (err) {
    resultsEl.hidden = false;
    listEl.innerHTML = `<div class="status-msg">Couldn't search: ${escapeHtml(err.message)}</div>`;
    emptyNote.hidden = true;
    linkBtn.hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔎 Find past entries for this";
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
    const occurrenceDate = document.getElementById("recurring-occurrence-date").value;
    const active = document.getElementById("recurring-active-checkbox").checked;

    if (!selectedRecurringCategoryId) throw new Error("Pick a category.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!occurrenceDate) throw new Error("Pick a date.");

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
      start_date: recurringFrequency === "once" ? "" : document.getElementById("recurring-start-date").value,
      end_date: recurringFrequency === "once" ? "" : document.getElementById("recurring-end-date").value
    };
    if (recurringFrequency === "once") {
      fields.date = occurrenceDate; // real date, full year — a single occurrence
      fields.day = "";
      fields.month = "";
    } else {
      fields.day = parseInt(occurrenceDate.slice(8, 10), 10);
      fields.month = parseInt(occurrenceDate.slice(5, 7), 10);
      fields.date = "";
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
    refreshRecurringExpenses();
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
  if (!confirm(`Delete the programmed item ${describeForConfirm_(recLabel, recAmount ? `${recCurrency} ${recAmount}` : "")}? Its skipped months go with it. This can't be undone.`)) return;
  const id = editingRecurringId;
  closeRecurringModal();
  await callApi("deleteRecurringExpense", { id });
  refreshRecurringExpenses();
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

  groups.forEach((g) => {
    const group = document.createElement("div");
    group.className = "expected-recurring-group";

    const isPen = g.currency === "PEN";
    const isIncome = g.type === "income";
    const sign = isIncome ? "+" : "";
    let amountHtml;
    if (isPen) {
      amountHtml = `<span class="primary-amt">${sign}PEN ${moneyFmt(g.total)}</span>`;
    } else if (g.totalPen != null) {
      amountHtml = `<span class="primary-amt">${sign}PEN ${moneyFmt(g.totalPen)}</span>` +
        `<span class="original-amt">${findCurrency(g.currency).flag} ${g.currency} ${moneyFmt(g.total)}</span>`;
    } else {
      amountHtml = `<span class="primary-amt">⚠️ ${findCurrency(g.currency).flag} ${g.currency} ${moneyFmt(g.total)}</span>` +
        `<span class="original-amt">Needs an exchange rate</span>`;
    }

    const detail = document.createElement("div");
    detail.className = "expected-recurring-detail";
    detail.hidden = true;
    detail.innerHTML = g.items.map((item) => `
      <div class="expected-recurring-item${item.overdue ? " overdue" : ""}">
        <span class="expected-recurring-item-label">${item.category_icon ? item.category_icon + " " : ""}${escapeHtml(item.category_name)}${item.description ? " — " + escapeHtml(item.description) : ""}</span>
        <span class="expected-recurring-item-amount">${item.overdue ? "⚠️ " : ""}Day ${item.day} · ${g.currency} ${moneyFmt(item.amount)}</span>
      </div>
      <div class="expected-recurring-actions">
        <button type="button" data-act="paid" data-id="${item.id}">✓ Mark as paid…</button>
        <button type="button" data-act="skip" data-id="${item.id}">⏭ Skip this month</button>
      </div>
    `).join("");
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
      <span class="expected-recurring-summary-label">🔁 ${g.items.length} programmed</span>
      <span class="expected-recurring-amount${isIncome ? " income" : ""}">${amountHtml}</span>
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
  if (!confirm(`Skip "${label}" for this month? It stops counting as expected for this month only. You can undo it from the item's edit screen.`)) return;
  try {
    await callApi("skipRecurringOccurrence", { id: item.id, month: todayLocalISO().slice(0, 7) });
    await refreshExpectedRecurring();
    refreshRecurringExpenses();
  } catch (err) {
    alert("Couldn't skip it (" + err.message + ").");
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
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  document.getElementById("paid-picker-empty").hidden = true;
  document.getElementById("paid-picker-title").textContent = "Mark as paid";
  document.getElementById("paid-picker-hint").textContent =
    `Which entry this month paid "${item.description || item.category_name}" (${currency} ${moneyFmt(item.amount)})? Most similar first, then everything this month by date.`;
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
      if (topCount && i === 0) addHeading("Most similar");
      if (topCount && i === topCount) addHeading("All of the month, by date");
      const row = document.createElement("div");
      row.className = "link-candidate-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <div class="link-candidate-text">
          <div class="link-candidate-date">${e.date} · ${e.currency} ${moneyFmt(e.amount)}</div>
          <div class="link-candidate-desc">${escapeHtml(e.description || e.category_name || "(no description)")}</div>
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
    errorEl.textContent = "Couldn't load entries: " + err.message;
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

async function refreshProjections() {
  const body = document.getElementById("projections-body");
  const monthLabel = document.getElementById("projections-month-label");
  const methodNote = document.getElementById("projections-method-note");
  body.innerHTML = '<div class="status-msg">Loading…</div>';
  monthLabel.textContent = "";
  methodNote.textContent = "";

  let p;
  try {
    p = await callApi("getProjections", projectionPeriodPayload_());
  } catch (err) {
    body.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  monthLabel.textContent = `Projected for ${p.monthLabel}`;

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
    breakdownLines.push(`Income: ${formatPen(p.incomeActual)} confirmed + ${formatPen(p.incomeProgrammed)} programmed.`);
  }
  if (p.expenses > 0) {
    breakdownLines.push(`Expenses: ${formatPen(p.expensesActual)} confirmed + ${formatPen(p.expensesProgrammed)} programmed + ${formatPen(p.expensesExpected)} expected.`);
  }
  if (p.investments > 0) {
    breakdownLines.push(`Investments: ${formatPen(p.investmentsActual)} confirmed + ${formatPen(p.investmentsProgrammed)} programmed + ${formatPen(p.investmentsExpected)} expected.`);
  }

  body.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">Income</span>
        <span class="summary-value income">${formatPen(p.income)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Expenses</span>
        <span class="summary-value expense">${formatPen(p.expenses)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Investments</span>
        <span class="summary-value investment">${formatPen(p.investments)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Net</span>
        <span class="summary-value">${formatPen(p.net)}</span>
      </div>
    </div>
    ${breakdownLines.map((line) => `<p class="projections-breakdown">${line}</p>`).join("")}
  `;
  methodNote.textContent = "Each figure is what's already confirmed this period, plus what's still programmed (recurring, not yet matched to a real entry) and, for expenses and investments, still expected (a year-to-date rate, pro-rated to the days left).";
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
  const lines = [projectionRowLine_("✅", c.actualPen, "Actual")];
  if (c.hasOverride) {
    lines.push(projectionRowLine_("✏️", c.remainingTotalPen, "Remaining · Manually set"));
  } else {
    lines.push(projectionRowLine_("🔁", c.programmedRemainingPen, "Programmed"));
    if (!isIncome) {
      lines.push(projectionRowLine_("📈", c.expectedRemainingPen, "Expected"));
    }
  }
  return lines.join("");
}

async function refreshProjectionCategories() {
  const list = document.getElementById("projections-categories-list");
  const emptyNote = document.getElementById("projections-categories-empty-note");
  list.innerHTML = '<div class="status-msg">Loading…</div>';

  let result;
  try {
    result = await callApi("listCategoryProjections", projectionPeriodPayload_());
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
    return;
  }

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
  document.getElementById("drilldown-chart-legend-2").textContent = "Projected";
  document.getElementById("drilldown-projection-row").hidden = false;
  document.getElementById("drilldown-projection-amount").textContent = "…";
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

  await openDrilldownWithPayload_(
    payload,
    `${categoryProjection.category_icon ? categoryProjection.category_icon + " " : ""}${categoryProjection.category_name}`,
    `${bounds.label} · Projected`
  );

  loadAndRenderProjectionChart_(categoryProjection);
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
  document.getElementById("drilldown-projection-amount").textContent = formatPen(p.remainingTotalPen);
  document.getElementById("drilldown-projection-override-note").hidden = !p.hasOverride;

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
    : `<div class="projection-month-row"><span>Nothing outstanding — already matched to a confirmed entry, or nothing due this period.</span></div>`;

  if (isIncome) return; // no Expected row/YTD breakdown to trace for income

  document.getElementById("drilldown-projection-expected-amount").textContent = formatPen(p.expectedRemainingPen);

  const breakdown = detail.ytdBreakdown;
  const formulaEl = document.getElementById("drilldown-projection-expected-formula");
  const monthsEl = document.getElementById("drilldown-projection-expected-months");
  if (!breakdown || !breakdown.monthsElapsed) {
    formulaEl.textContent = "Not enough history yet to break this down.";
    monthsEl.innerHTML = "";
    return;
  }

  const monthLabel = (monthKey) => MONTH_NAMES_SHORT[parseInt(monthKey.slice(5, 7), 10) - 1];
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
    <div>Based on ${formatPen(breakdown.totalPen)} spent over ${breakdown.monthsElapsed} month${breakdown.monthsElapsed === 1 ? "" : "s"} (${span}) → ${formatPen(breakdown.ratePerMonth)}/month.</div>
    <div style="margin-top:4px;">${formatPen(breakdown.ratePerMonth)}/month × ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left ÷ 30 → ${formatPen(p.expectedRemainingPen)} still expected.</div>
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

document.getElementById("drilldown-projection-row").addEventListener("click", () => {
  if (!drilldownProjection || !drilldownProjectionDetail) return;
  openProjectionOverrideModal_(drilldownProjection, drilldownProjectionDetail);
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
    note.textContent = "This period hasn't started yet.";
  } else if (actualEndIdx >= n - 1) {
    note.textContent = "This period has ended.";
  } else {
    const daysLeft = n - 1 - actualEndIdx;
    const remaining = Math.max(0, projectedTotal - actualSoFar);
    note.textContent = `${formatPen(remaining)} projected for the ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`;
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
    ? `Includes the ${formatPen(projectionOverrideState.actualPen)} already actual this period.`
    : `What's left to happen — the ${formatPen(projectionOverrideState.actualPen)} already actual gets added automatically.`;
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
  document.getElementById("projection-override-modal-title").textContent = "Edit projected total";
  document.getElementById("projection-override-modal-subtitle").textContent =
    `${categoryProjection.category_name} — currently ${detail.projection.hasOverride ? "manually set" : "calculated"} at ${formatPen(detail.projection.amountPen)} total.`;
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
    errorEl.textContent = "Enter a valid amount.";
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
        banner.textContent = "🔄 New version available — tap to reload";   // re-set so a screen reader announces it
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
  return list.sort((a, b) => (a === "PEN" ? -1 : b === "PEN" ? 1 : a < b ? -1 : 1));
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
    ? `Net: ${netParts.join(" · ")}`
    : "All settled up.";

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
    emptyNote.textContent = "No loans with this friend yet.";
    emptyNote.hidden = false;
  } else if (pending.length === 0) {
    emptyNote.textContent = "Nothing pending — see already paid below.";
    emptyNote.hidden = false;
  } else {
    emptyNote.hidden = true;
    pending.forEach((l) => list.appendChild(buildLoanDetailRow_(l, friendId, friendName)));
  }

  paidToggle.hidden = alreadyPaid.length === 0;
  paidToggle.textContent = `📜 Show ${alreadyPaid.length} already paid`;
  paidToggle.onclick = () => {
    const showing = !paidList.hidden;
    if (showing) {
      paidList.hidden = true;
      paidToggle.textContent = `📜 Show ${alreadyPaid.length} already paid`;
    } else {
      if (!paidList.children.length) {
        alreadyPaid.forEach((l) => paidList.appendChild(buildLoanDetailRow_(l, friendId, friendName)));
      }
      paidList.hidden = false;
      paidToggle.textContent = "📜 Hide already paid";
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
    ? (l.forgiveness_entry_id ? "Forgiven · recorded in your entries" : "Forgiven")
    : l.remaining <= 0.004
      ? "Fully repaid"
      : [
          l.overdue ? `⚠️ Overdue since ${l.due_date}` : "",
          l.settled > 0.004 ? `${l.currency} ${moneyFmt(l.settled)} repaid so far` : ""
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
      <span class="loan-detail-row-desc">${escapeHtml(l.description || (l.origin === "entry" ? "Shared expense" : "Loan"))}<span class="loan-detail-row-chevron">›</span></span>
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
    forgiveBtn.textContent = "🙏 Forgive";
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
    if (!entry) throw new Error("That expense couldn't be found — it may have been deleted.");
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
  addOpt.textContent = "+ Add friend…";
  select.appendChild(addOpt);
}

document.getElementById("loan-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt("Friend's name:");
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
  noneOpt.textContent = "None";
  select.appendChild(noneOpt);
  meta.paymentMethods.forEach((pm) => {
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

  document.getElementById("loan-modal-title").textContent = loan ? "Edit loan" : "Add loan";
  document.getElementById("loan-delete-btn").hidden = !loan;
  document.getElementById("loan-form-error").textContent = "";
  populateLoanFriendOptions();
  populateLoanPaymentMethodOptions();
  document.getElementById("loan-friend").value = loan ? loan.friend_id : (meta.friends.length ? meta.friends[0].id : "");
  setLoanDirection_(loan ? loan.direction : "they_owe_me");
  document.getElementById("loan-amount").value = loan ? loan.amount : "";
  document.getElementById("loan-currency").value = loan ? loan.currency : "PEN";
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

    if (!friendId || friendId === "__add__") throw new Error("Pick a friend.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!date) throw new Error("Date is required.");

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
  if (!confirm(`Delete the loan ${describeForConfirm_(loanDesc || loanWho, loanAmt ? `${loanCur} ${loanAmt}` : "", loanDesc && loanWho ? loanWho : "")}? This can't be undone.`)) return;
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
  noneOpt.textContent = "None";
  select.appendChild(noneOpt);
  meta.paymentMethods.forEach((pm) => {
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
    `Category (${type})`;
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
    ? `${repaymentFriendName} owes you ${repaymentCurrency} ${moneyFmt(amount)}`
    : `You owe ${repaymentFriendName} ${repaymentCurrency} ${moneyFmt(amount)}`;
}

// Back to "add a new repayment" — the default state the form opens in,
// and where "Cancel edit" returns it to without closing the whole modal.
function resetSettlementForm_() {
  editingSettlementId = null;
  document.getElementById("settlement-save-btn").textContent = "Save repayment";
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
  document.getElementById("settlement-save-btn").textContent = "Save changes";
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
      ? `↔ Offset against "${escapeHtml(s.offset_loan_description)}"`
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

  document.getElementById("settlement-modal-title").textContent = "Repayments";
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
    alert(`The extra ${p.currency} ${moneyFmt(p.amount)} is saved in your review queue as ${p.entryType === "income" ? "income" : "an expense"} — categorize it there.`);
    refreshReviewQueue().catch(() => {});
  }
}

async function refreshAfterSettlementChange_() {
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
  const saveBtn = document.getElementById("settlement-save-btn");

  try {
    const amount = parseFloat(document.getElementById("settlement-amount").value);
    const date = document.getElementById("settlement-date").value;
    const paymentMethodId = document.getElementById("settlement-payment-method").value;

    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!date) throw new Error("Date is required.");

    saveBtn.disabled = true;

    if (editingSettlementId) {
      // Fixing a specific real settlement's own typo — doesn't re-run
      // FIFO, just corrects that one row (see updateSettlement in
      // Loans.gs).
      await callApi("updateSettlement", { id: editingSettlementId, amount, date, payment_method_id: paymentMethodId });
      closeSettlementModal();
      await refreshAfterSettlementChange_();
      return;
    }

    const result = await callApi("recordRepayment", {
      friend_id: repaymentFriendId,
      direction: repaymentDirection,
      amount,
      currency: repaymentCurrency,
      date,
      payment_method_id: paymentMethodId
    });

    // The loan-side effects are already committed at this point — show
    // them right away regardless of whether there's overpayment left to
    // resolve, rather than waiting on that separate step. openLoanDetail
    // brings ITS OWN modal to front, which would otherwise bury this one
    // (still open, and still what the owner's actively working in) —
    // bring this one back to front immediately after.
    await refreshLoans();
    await openLoanDetail(repaymentFriendId, repaymentFriendName);
    bringModalToFront_(document.getElementById("settlement-modal-backdrop"));
    await refreshSettlementList_();

    if (result.overpaid > 0.004) {
      // Mirror images: they overpaying YOU is your income; YOU overpaying
      // them is your expense (paid_by: "me", no split — see
      // createOverpaymentEntry_ in Loans.gs).
      const isIncome = repaymentDirection === "they_owe_me";
      pendingOverpay = { amount: result.overpaid, currency: result.currency, date, paymentMethodId, entryType: isIncome ? "income" : "expense" };
      document.getElementById("settlement-overpay-note").textContent = isIncome
        ? `${repaymentFriendName} paid ${result.currency} ${moneyFmt(result.overpaid)} more than they owed — recording it as income. Pick a category now, or close this and categorize it later from your review queue (it's already saved there).`
        : `You paid ${repaymentFriendName} ${result.currency} ${moneyFmt(result.overpaid)} more than you owed — recording it as an expense. Pick a category now, or close this and categorize it later from your review queue (it's already saved there).`;
      populateOverpayCategoryOptions(pendingOverpay.entryType);
      document.getElementById("settlement-overpay-error").textContent = "";
      document.getElementById("settlement-form").hidden = true;
      document.getElementById("settlement-overpay-section").hidden = false;
    } else {
      closeSettlementModal();
    }
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("settlement-delete-btn").addEventListener("click", async () => {
  if (!editingSettlementId) return;
  const repAmt = document.getElementById("settlement-amount").value.trim();
  const repDate = document.getElementById("settlement-date").value;
  if (!confirm(`Delete the repayment with ${describeForConfirm_(repaymentFriendName || "", repAmt ? `${repaymentCurrency} ${repAmt}` : "", repDate)}? This can't be undone.`)) return;

  try {
    await callApi("deleteSettlement", { id: editingSettlementId });
    closeSettlementModal();
    await refreshAfterSettlementChange_();
  } catch (err) {
    document.getElementById("settlement-form-error").textContent = err.message;
  }
});

document.getElementById("settlement-overpay-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("settlement-overpay-error");
  errorEl.textContent = "";
  if (!pendingOverpay) return;
  const categoryId = document.getElementById("settlement-overpay-category").value;
  if (!categoryId) { errorEl.textContent = "Pick a category."; return; }

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
  meta.categories.filter((c) => c.type === type).forEach((c) => {
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
    `${loan.description || "Loan"} · ${loan.currency} ${moneyFmt(loan.remaining)} remaining`;

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
  document.getElementById("forgive-convert-label").textContent = `Convert remaining balance to ${entryType === "expense" ? "an expense" : "income"}`;
  if (hasBalance) {
    document.getElementById("forgive-context").textContent +=
      ` — this will be recorded as ${entryType === "expense" ? "an expense" : "income"} in the category below.`;
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
  if (convert && !categoryId) { errorEl.textContent = "Pick a category."; return; }
  if (convert && !date) { errorEl.textContent = "Date is required."; return; }

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
// Every pending entry email parsing catches is money the owner sent out
// (there's no deposit/income detection built — see CLAUDE.md's Email
// automation section), so both actions have a fixed, known direction —
// there's nothing to pick:
// - "Mark as repayment" means the owner paying this money down what THEY
//   owed the friend — direction 'i_owe_them', through the exact same
//   recordRepayment FIFO + offset engine the Loans tab's own "Record
//   repayment" uses (see CLAUDE.md's Settlements section).
// - "Convert to loan" means the owner lending this money to the friend
//   — direction 'they_owe_me' (the friend now owes it back), through the
//   same addLoan as the Loans tab's "+ Add loan" (including its own
//   +7-day due-date default when none's given).
// Either way, the pending entry itself is discarded afterward — it was
// never really an expense, so it shouldn't become a confirmed one.

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
  addOpt.textContent = "+ Add friend…";
  select.appendChild(addOpt);
}

document.getElementById("review-transfer-friend").addEventListener("change", async (e) => {
  if (e.target.value !== "__add__") return;
  const name = prompt("Friend's name:");
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
  noneOpt.textContent = "None";
  select.appendChild(noneOpt);
  meta.paymentMethods.forEach((pm) => {
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
    mode === "repay" ? "Mark as repayment" : "Convert to loan";
  document.getElementById("review-transfer-context").textContent =
    `${entry.description || "Transaction"} · ${entry.currency} ${moneyFmt(entry.amount)}`;
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
    mode === "repay" ? "Mark as repayment" : "Convert to loan";

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

  if (!friendId || friendId === "__add__") { errorEl.textContent = "Pick a friend."; return; }
  if (!amount || amount <= 0) { errorEl.textContent = "Enter a valid amount."; return; }
  if (!date) { errorEl.textContent = "Date is required."; return; }

  const saveBtn = document.getElementById("review-transfer-save-btn");
  saveBtn.disabled = true;
  try {
    const entryId = reviewTransferEntry.id;
    const currency = reviewTransferEntry.currency;
    const description = document.getElementById("review-transfer-description").value.trim() ||
      reviewTransferEntry.description || "";

    if (reviewTransferMode === "repay") {
      const result = await callApi("recordRepayment", {
        friend_id: friendId,
        direction: "i_owe_them",
        amount,
        currency,
        date,
        payment_method_id: paymentMethodId,
        description
      });
      await callApi("discardEntry", { id: entryId });
      if (result.overpaid > 0.004) {
        alert(`Marked as a repayment to ${friendName} — ${currency} ${moneyFmt(result.overpaid)} was more than they were owed. The extra is in your review queue, waiting for a category.`);
      }
    } else {
      await callApi("addLoan", {
        friend_id: friendId,
        direction: "they_owe_me",
        amount,
        currency,
        date,
        payment_method_id: paymentMethodId,
        description
      });
      await callApi("discardEntry", { id: entryId });
    }

    closeReviewTransferModal();
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
  const codes = Object.keys(totals).sort((a, b) => (a === "PEN" ? -1 : b === "PEN" ? 1 : a < b ? -1 : 1));
  const totalsWrap = document.getElementById("balances-totals");
  const totalsLines = document.getElementById("balances-totals-lines");
  totalsLines.innerHTML = "";
  totalsWrap.hidden = codes.length === 0;
  codes.forEach((code) => {
    const amount = Math.round(totals[code] * 100) / 100;
    const line = document.createElement("div");
    line.className = "balances-totals-line" + (amount < 0 ? " negative" : "");
    line.innerHTML = `<span>${code === "PEN" ? "" : findCurrency(code).flag + " "}${code}</span><span>${formatSignedBalance_(amount, code)}</span>`;
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
      : "Nothing yet";
    row.innerHTML = `
      <div class="balance-row-name">${escapeHtml(r.nickname)}<span class="loan-detail-row-chevron">›</span></div>
      <div class="balance-row-amount">${escapeHtml(lines)}</div>
    `;
    const detail = document.createElement("div");
    detail.hidden = true;
    row.addEventListener("click", async () => {
      if (!detail.hidden) { detail.hidden = true; return; }
      detail.hidden = false;
      detail.innerHTML = '<p class="hint">Loading…</p>';
      const moves = await callApi("getPaymentMethodMovements", { paymentMethodId: r.id });
      detail.innerHTML = moves.length ? "" : '<p class="hint">No deposits or withdrawals yet.</p>';
      moves.forEach((m) => {
        const item = document.createElement("div");
        item.className = "loan-detail-row";
        const kind = m.signed > 0 ? "Deposit" : "Withdrawal";
        item.innerHTML = `
          <div class="loan-detail-row-top">
            <span class="loan-detail-row-desc">${escapeHtml(m.description || kind)}</span>
            <span class="loan-detail-row-amount">${formatSignedBalance_(m.signed, m.currency)}</span>
          </div>
          <div class="loan-detail-row-meta">${m.date} · ${kind}${m.other_account ? ` · ${m.signed > 0 ? "from" : "to"} ${escapeHtml(m.other_account)}` : ""}</div>
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
    meta.paymentMethods.filter((pm) => pm.type !== "investment").forEach((pm) => {
      const opt = document.createElement("option");
      opt.value = pm.id;
      const tracked = balancesCache.some((b) => b.id === pm.id);
      opt.textContent = pm.nickname + (pm.last_4 ? ` (${pm.last_4})` : "") + (tracked ? " ✓" : "");
      picker.appendChild(opt);
    });
    if (!meta.paymentMethods.length) {
      alert("No accounts yet. Use \"+ Add payment method…\" on the entry form first.");
      return;
    }
    pickerWrap.hidden = false;
    document.getElementById("balance-modal-title").textContent = "Add account balance";
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
  list.innerHTML = '<p class="hint">Loading…</p>';
  wrap.hidden = false;
  const moves = await callApi("getPaymentMethodMovements", { paymentMethodId: pmId });
  if (balanceModalPmId !== pmId) return;
  list.innerHTML = "";
  if (!moves.length) {
    list.innerHTML = '<p class="hint">Nothing since the starting date.</p>';
    return;
  }
  moves.forEach((m) => {
    const row = document.createElement("div");
    row.className = "loan-detail-row";
    const label = m.description || (m.type === "transfer" ? "Transfer" : m.type[0].toUpperCase() + m.type.slice(1));
    const extra = m.type === "transfer" && m.other_account ? ` · ${m.signed < 0 ? "to" : "from"} ${escapeHtml(m.other_account)}` : "";
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
    : [{ amount: "", negative: false, currency: "PEN", date: todayLocalISO() }];
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
        ${balanceFormRows.length > 1 ? '<button type="button" class="balance-row-remove" aria-label="Remove">✕</button>' : ""}
      </div>
      <label class="checkbox-row"><input type="checkbox" class="balance-row-negative"${row.negative ? " checked" : ""}><span>Negative — I owe this (e.g. a credit card)</span></label>
      <label class="balance-row-date-label">From date</label>
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
  const next = ["USD", "PEN", "EUR"].find((c) => !used.has(c)) || "USD";
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
    result.textContent = "✓ Matches — no difference.";
  } else {
    result.style.color = "#d64545";
    result.textContent = diff > 0
      ? `Your app shows ${main.currency} ${moneyFmt(diff)} MORE than tracked here — likely a top-up, income or refund not logged yet.`
      : `Your app shows ${main.currency} ${moneyFmt(-diff)} LESS than tracked here — likely a purchase or fee not logged yet.`;
  }
});

document.getElementById("balance-save-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("balance-form-error");
  errorEl.textContent = "";
  const saveBtn = document.getElementById("balance-save-btn");
  try {
    const pmId = balanceModalPmId || document.getElementById("balance-account-picker").value;
    if (!pmId) throw new Error("Pick an account.");
    const seen = new Set();
    const balances = balanceFormRows.map((row) => {
      const text = String(row.amount).trim().replace(/,/g, "").replace(/[−–]/g, "-");
      const parsed = parseFloat(text);
      if (!text || isNaN(parsed)) throw new Error(`Enter the starting balance for ${row.currency} (0 is fine).`);
      if (!row.date) throw new Error(`Pick the from date for ${row.currency}.`);
      if (seen.has(row.currency)) throw new Error(`${row.currency} is listed twice.`);
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
  if (!confirm("Stop tracking this account's balances? Its entries aren't touched.")) return;
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
  if (id === "me") return "Me";
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
    btn.textContent = "Loading the saved bill…";
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
  document.getElementById("bill-currency").textContent = (document.getElementById("currency").value || "PEN").toUpperCase();
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
  const cur = (document.getElementById("currency").value || "PEN").toUpperCase();
  document.getElementById("bill-tip-label").textContent = isPercent ? "Tip percent (%)" : `Tip amount (${cur})`;
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
    more.textContent = billShowAllFriends ? "Less" : "More…";
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
    name.placeholder = "Item";
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
      name.placeholder = "Discount";
      const idx = billState.items.indexOf(it);
      let parent = null;
      for (let i = idx - 1; i >= 0; i--) if (!billState.items[i].discount) { parent = billState.items[i]; break; }
      const note = document.createElement("div");
      note.className = "hint bill-discount-note";
      note.textContent = parent ? `↳ comes off “${parent.name || "the item above"}” (shared by whoever shares it)` : "↳ needs an item above it";
      chips.appendChild(note);
    } else {
      const everyone = keys.every((k) => it.people.has(k));
      const all = document.createElement("div");
      all.className = "tag-chip" + (everyone ? " selected" : "");
      all.textContent = "Everyone";
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
    disc.textContent = "− Discount line";
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
    ins.textContent = "+ Insert a line below";
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
    name.placeholder = a.kind === "discount" ? "Discount" : "Extra charge";
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
    [["proportional", "By what each ordered"], ["equal", "Equal"]].forEach(([v, label]) => {
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
  const cur = (document.getElementById("currency").value || "PEN").toUpperCase();
  const fmt = (cents) => `${cur} ${moneyFmt(cents / 100)}`;

  const check = document.getElementById("bill-check");
  // The bill total is BEFORE discounts: items (+ any extra charge) must match
  // it; discounts come off afterwards, then the tip.
  const chargesCents = res.preDiscountCents - res.itemsCents;
  const counted = chargesCents ? `Items ${fmt(res.itemsCents)} + charges ${fmt(chargesCents)}` : `Items ${fmt(res.itemsCents)}`;
  const lead = chargesCents ? `${counted} comes to ${fmt(res.preDiscountCents)}` : `Items add up to ${fmt(res.itemsCents)}`;
  if (res.printedCents > 0) {
    if (res.diffCents === 0) {
      check.className = "hint bill-check-ok";
      check.textContent = `✓ ${counted} = bill total ${fmt(res.printedCents)}` +
        (res.discountsCents ? ` · after discounts −${fmt(res.discountsCents)}: ${fmt(res.billCents)}` : "");
    } else {
      check.className = "hint bill-check-bad";
      check.textContent = res.diffCents > 0
        ? `${lead}, but the bill says ${fmt(res.printedCents)} — ${fmt(res.diffCents)} short. A missing item, or add an extra charge.`
        : `${lead}, but the bill says ${fmt(res.printedCents)} — ${fmt(-res.diffCents)} too much. Check a price.`;
    }
  } else {
    check.className = "hint";
    check.textContent = res.itemsCents ? `Items so far: ${fmt(res.itemsCents)}. Enter the bill total above to check them.` : "";
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
      const bits = [`items ${moneyFmt(p.items / 100)}`];
      if (p.adjustments) bits.push(`${p.adjustments < 0 ? "−" : "+"}${moneyFmt(Math.abs(p.adjustments) / 100)} adjustments`);
      if (p.tip) bits.push(`+${moneyFmt(p.tip / 100)} tip`);
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
      t.textContent = `Tip ${fmt(res.tipCents)} · you pay the restaurant ${fmt(res.grandCents)} in total.`;
      out.appendChild(t);
    }
  }
  // Live line under the tip box: what the typed tip actually comes to, so a
  // slip like 100 instead of 10 is obvious right where it is typed.
  const preview = document.getElementById("bill-tip-preview");
  const tipTyped = billState.tip.type === "percent" ? billState.tip.percent : billState.tip.amount;
  if (!tipTyped || !res.tipCents) {
    preview.className = "hint";
    preview.textContent = res.billCents > 0 ? `Tip is taken on ${fmt(res.billCents)} (the bill after discounts).` : "";
  } else {
    const pct = res.billCents > 0 ? (res.tipCents / res.billCents) * 100 : 0;
    const odd = pct > 30;
    preview.className = "hint" + (odd ? " bill-check-bad" : "");
    preview.textContent = billState.tip.type === "percent"
      ? `${tipTyped}% of ${fmt(res.billCents)} = ${fmt(res.tipCents)}${odd ? " — that's a very large tip, is that right?" : ""}`
      : `${fmt(res.tipCents)} is ${pct.toFixed(1)}% of ${fmt(res.billCents)}${odd ? " — that's a very large tip, is that right?" : ""}`;
  }
  const err = document.getElementById("bill-error");
  // Only the blocking reason that isn't already visible above.
  err.textContent = res.ok ? "" : res.errors.filter((e) => !/don't add up/.test(e)).join(" ");
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
  const name = prompt("Friend's name:");
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
      el.onerror = () => { tesseractLoading_ = null; reject(new Error("Couldn't load the photo reader. Check your connection and try again.")); };
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
  if (!opts.noConfirm && billState.items.some((it) => it.price) && !confirm("Replace the items already in the sheet with the ones read from the photo?")) return false;
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
    say(i ? "That didn't add up — reading it again another way…" : first ? "Loading the reader (first time only, a few MB)…" : "Reading the photo…");
    const text = await recognizeReceiptText_(canvas, (m) => {
      if (m.status === "recognizing text") say(`${i ? "Reading it again" : "Reading the photo"}… ${Math.round((m.progress || 0) * 100)}%`);
      else if (/loading/i.test(m.status)) say("Loading the reader (first time only, a few MB)…");
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
    say("Preparing the photo…");
    const best = await readReceiptFile_(file, say);
    document.getElementById("bill-photo-text").value = best.text;
    document.getElementById("bill-photo-raw").hidden = false;
    const parsed = best.parsed;
    if (!parsed.items.length) {
      say("Couldn't find items in that photo. Try again with the whole receipt flat, in good light — or add the items by hand. (The text it read is below.)", true);
      return;
    }
    if (!applyReceiptToBill_(parsed)) { say("Left the sheet as it was."); return; }
    const dishes = parsed.items.filter((i) => !i.discount).length;
    const notes = parsed.warnings.length ? " " + parsed.warnings.join(" ") : "";
    say(`Read ${dishes} item${dishes === 1 ? "" : "s"}. Check every line against the receipt, fix what's wrong, then tap who shared each one.${notes}`, parsed.warnings.length > 0);
  } catch (err) {
    say(err.message || "Couldn't read that photo.", true);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("bill-photo-btn").addEventListener("click", () => document.getElementById("bill-photo-input").click());
document.getElementById("bill-photo-reparse").addEventListener("click", () => {
  const parsed = ReceiptParse.parseReceipt(document.getElementById("bill-photo-text").value);
  if (!parsed.items.length) { billPhotoSay_("No items could be found in that text — check it and try again.", true); return; }
  if (billItemsEdited && !confirm("This replaces the items you changed by hand below with what the text says. Continue?")) return;
  applyReceiptToBill_(parsed, { noConfirm: true, keepAssignments: true });
  const dishes = parsed.items.filter((i) => !i.discount).length;
  billPhotoSay_(`Worked out ${dishes} item${dishes === 1 ? "" : "s"} again from your text.` + (parsed.warnings.length ? " " + parsed.warnings.join(" ") : ""), parsed.warnings.length > 0);
});
document.getElementById("bill-photo-input").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";           // picking the same photo again must work
  if (file) readBillPhoto_(file);
});


init();
