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
// True while editing an entry that was type "expense" when the edit
// started — lets the submit handler still clear its splits/loans if the
// owner changes its type away from expense mid-edit, even though the
// split field itself is hidden (and selectedType no longer "expense") by
// the time they hit Save.
let editingEntryWasSplittable = false;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apps Script's free Web App "falls asleep" after a period of inactivity —
// the first request after that can take 20+ seconds to wake it up, and
// sometimes the slow/cold response comes back looking like a CORS failure.
// Retrying clears it up once the backend is warm.
async function callApi(action, payload, attempt = 1) {
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
        body: JSON.stringify({ accessCode: getAccessCode(), action, payload: payload || {} }),
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
      return callApi(action, payload, attempt + 1);
    }
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  if (!json.ok) throw new Error(json.error || "Unknown error");
  return json.data;
}

function todayLocalISO() {
  const d = new Date();
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
  setAccessCode(code);
  await init();
});

// ---- Meta loading & form population ----

async function loadMeta() {
  meta = await callApi("getMeta", {});
  populateCategoryOptions();
  populateCategoryPicker();
  populatePaidByOptions();
  populatePaymentMethodOptions();
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
    selectField.hidden = false;
  }

  document.getElementById("category-picker").hidden = true;
  document.getElementById("entry-form").hidden = false;
  toggleSplitFieldVisibility();

  const amountInput = document.getElementById("amount");
  amountInput.focus();
}

function getCategoryId() {
  if (ICON_PICKER_TYPES.includes(selectedType)) return selectedCategoryId;
  return document.getElementById("category").value;
}

document.getElementById("change-category-btn").addEventListener("click", showCategoryPicker);

// Income keeps its own list (Payors — a client, employer, "Nexus
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

  meta.paymentMethods.forEach((pm) => {
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
  splitFriendIds = new Set();
  splitMode = "equal";
  customSplitAmounts = {};
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

function renderSplitFriendChips() {
  const container = document.getElementById("split-friend-chips");
  container.innerHTML = "";
  meta.friends.forEach((f) => {
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
  });
}

// Only custom mode needs a row per friend — equal mode's amounts are
// computed, not typed, so there's nothing to show below the chips there.
function renderSplitRows() {
  const container = document.getElementById("split-rows");
  container.innerHTML = "";
  if (splitMode !== "custom") return;

  Array.from(splitFriendIds).forEach((id) => {
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
    input.value = customSplitAmounts[id] || "";
    input.addEventListener("input", (e) => {
      customSplitAmounts[id] = e.target.value;
      renderSplitSummary();
    });

    row.appendChild(name);
    row.appendChild(input);
    container.appendChild(row);
  });
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
    const assigned = friendIds.reduce((sum, id) => sum + (parseFloat(customSplitAmounts[id]) || 0), 0);
    const remaining = amount - assigned;
    summaryEl.textContent = `${currency} ${moneyFmt(assigned)} of ${currency} ${moneyFmt(amount)} assigned · ${currency} ${moneyFmt(Math.max(remaining, 0))} left to you`;
    if (remaining < -0.004) errorEl.textContent = "That's more than the total amount.";
  }
}

function getSplitPayload() {
  const amount = parseFloat(document.getElementById("amount").value) || 0;
  const friendIds = Array.from(splitFriendIds);

  if (splitMode === "equal") {
    const { shareEach } = computeEqualShares(amount, friendIds);
    return friendIds.map((id) => ({ friend_id: id, amount: shareEach }));
  }
  return friendIds
    .map((id) => ({ friend_id: id, amount: parseFloat(customSplitAmounts[id]) || 0 }))
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
  if (splitMode === "custom" && assigned <= 0) {
    throw new Error("Enter at least one friend's amount.");
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
  meta.friends.push(friend);
  splitFriendIds.add(friend.id);
  renderSplitFriendChips();
  renderSplitRows();
  renderSplitSummary();
});

document.getElementById("amount").addEventListener("input", () => {
  if (document.getElementById("split-toggle").checked) renderSplitSummary();
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

  try {
    const date = document.getElementById("date").value;
    const amount = parseFloat(document.getElementById("amount").value);
    const currency = document.getElementById("currency").value.toUpperCase();
    const categoryId = getCategoryId();
    const description = document.getElementById("description").value.trim();
    const paidBy = document.getElementById("paid_by").value;
    const paymentMethodId = document.getElementById("payment_method").value;
    // Same condition togglePaymentMethodVisibility() uses to show the
    // field — income always carries a payment method (which account
    // received it), an expense/investment/transfer only when the owner
    // themselves paid.
    const usesPaymentMethod = selectedType === "income" || paidBy === "me";

    if (!date) throw new Error("Date is required.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!categoryId) throw new Error("Pick a category.");
    if (usesPaymentMethod && !paymentMethodId) throw new Error("Pick a payment method.");
    const splits = validateSplitIfEnabled();

    // A future-dated save that's a plain, fully-owned transaction (not a
    // transfer between the owner's own accounts, not shared with a friend
    // — those need real Entry/Splits machinery this doesn't have) becomes
    // a Programmed, one-time item instead of a confirmed Entry, so it
    // never shows in "Recent entries" until it's actually real. Only for
    // a genuinely new save — editing an existing real entry into a future
    // date doesn't retroactively un-become a real entry. A split expense
    // needs the same real Entry/Splits machinery a friend-paid one does,
    // even when the owner themselves paid, so it's excluded here too.
    const isFutureDate = !editingEntryId && date > todayLocalISO();
    const canProgram = isFutureDate && selectedType !== "transfer" &&
      (selectedType === "income" || paidBy === "me") && !splits;
    let programmedInstead = false;

    if (editingEntryId) {
      await ensureExchangeRate(currency, date);
      await callApi("updateEntry", {
        id: editingEntryId,
        fields: {
          type: selectedType,
          date,
          amount,
          currency,
          category_id: categoryId,
          description,
          paid_by: paidBy,
          payment_method_id: usesPaymentMethod ? paymentMethodId : ""
        }
      });
      // Sent for an expense, even with an empty list — that's how turning
      // the split toggle back off on an already-split entry clears its
      // splits and linked loan(s) on save (saveEntrySplits in Loans.gs
      // replaces whatever was there before from scratch). Also sent when
      // the entry WAS an expense before this edit but got switched to a
      // different type just now, so its old splits/loans get cleared
      // instead of silently orphaned.
      if (selectedType === "expense" || editingEntryWasSplittable) {
        await callApi("saveEntrySplits", { entryId: editingEntryId, splits: splits || [] });
      }
      exitEditMode();
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
        amount,
        currency,
        category_id: categoryId,
        description,
        paid_by: paidBy,
        payment_method_id: usesPaymentMethod ? paymentMethodId : "",
        tag_ids: Array.from(selectedTagIds)
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
        await callApi("saveEntrySplits", { entryId: created.id, splits: splits || [] });
      }
    }

    document.getElementById("amount").value = "";
    document.getElementById("description").value = "";
    selectedTagIds.clear();
    populateTags();
    resetSplitState();

    await refreshEntryList();
    refreshExpectedRecurring();

    if (editingViaPopup) {
      await refreshAfterPopupEdit();
    } else if (programmedInstead) {
      // Stays on the (now-cleared) form instead of jumping back to the
      // category picker like a normal save does — that jump would hide
      // #form-error, along with it the only sign this became a Programmed
      // item instead of a real entry, before the owner ever saw it.
      showFormNotice_(`Programmed for ${date} — see More → Programmed income/expenses. It'll turn into a real entry once it actually happens.`);
    } else if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    }
  } catch (err) {
    errorEl.textContent = err.message;
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
function renderEntryAmountHtml(entry) {
  if (entry.currency === "PEN") {
    return `<span class="primary-amt">PEN ${moneyFmt(entry.amount)}</span>`;
  }

  const originalLine = `<span class="original-amt">${formatAmount(entry.amount, entry.currency)}</span>`;

  if (entry.amount_pen == null) {
    // No PEN value on file for this one (can happen on an older imported
    // entry whose month never got a rate entered) — fall back to the
    // original amount as the primary line rather than showing nothing.
    return `<span class="primary-amt">${formatAmount(entry.amount, entry.currency)}</span>`;
  }

  return `<span class="primary-amt">PEN ${moneyFmt(entry.amount_pen)}</span>${originalLine}`;
}

function findCategory(id) {
  return meta.categories.find((cat) => cat.id === id);
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

async function refreshEntryList() {
  const entries = await callApi("listEntries", {});
  const list = document.getElementById("entry-list");
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<div class="status-msg">No entries yet — add your first one above.</div>';
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "entry";

    const cat = findCategory(entry.category_id);
    const categoryMarker = cat && cat.icon
      ? `<span class="entry-cat-icon" style="background:${cat.color || "#eee"}">${cat.icon}</span>`
      : `<span class="type-dot" data-type="${entry.type}"></span>`;

    const left = document.createElement("div");
    left.className = "entry-left";
    left.innerHTML = `
      <div class="entry-category">${categoryMarker}${categoryName(entry.category_id)}</div>
      ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
      <div class="entry-meta">${entry.date} · ${paidByLabel(entry)}</div>
    `;

    const amount = document.createElement("div");
    amount.className = "entry-amount";
    amount.innerHTML = renderEntryAmountHtml(entry);

    row.appendChild(left);
    row.appendChild(amount);
    row.addEventListener("click", () => startEditEntry(entry));
    list.appendChild(row);
  });
}

// ---- Editing a previously confirmed entry ----

async function startEditEntry(entry) {
  editingEntryId = entry.id;
  editingEntryWasSplittable = entry.type === "expense";

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

  document.getElementById("amount").value = entry.amount;
  document.getElementById("date").value = entry.date;
  document.getElementById("description").value = entry.description || "";
  selectCurrency(entry.currency, "entry");

  document.getElementById("paid_by").value = entry.paid_by;
  togglePaymentMethodVisibility();
  if (entry.type === "income" || entry.paid_by === "me") {
    document.getElementById("payment_method").value = entry.payment_method_id || "";
  }

  document.getElementById("tags-field").hidden = true;
  document.getElementById("tags-edit-note").hidden = false;

  // showDetailForm (above) already showed/hid #split-field via
  // toggleSplitFieldVisibility; for a non-expense entry that also cleared
  // the split state, so there's nothing more to do. For an expense, start
  // from a clean slate and pull in whatever's actually on file — always
  // loaded as "custom" regardless of how it was originally entered, since
  // that's the one mode that can represent exactly what's stored without
  // having to guess whether it started as an equal split.
  resetSplitState();
  if (entry.type === "expense") {
    const splits = await callApi("getEntrySplits", { entryId: entry.id });
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

  document.getElementById("edit-mode-banner").hidden = false;
  document.getElementById("submit-btn").textContent = "Update entry";
  document.getElementById("cancel-edit-btn-2").hidden = false;
  document.getElementById("delete-entry-btn").hidden = false;

  document.getElementById("entry-form").scrollIntoView({ behavior: "smooth" });
}

function exitEditMode() {
  editingEntryId = null;
  editingEntryWasSplittable = false;
  document.getElementById("edit-mode-banner").hidden = true;
  document.getElementById("submit-btn").textContent = "Save entry";
  document.getElementById("cancel-edit-btn-2").hidden = true;
  document.getElementById("delete-entry-btn").hidden = true;
  document.getElementById("tags-field").hidden = false;
  document.getElementById("tags-edit-note").hidden = true;
  resetSplitState();
}

function cancelEdit() {
  exitEditMode();
  document.getElementById("amount").value = "";
  document.getElementById("description").value = "";
  if (editingViaPopup) {
    closeEditPopup();
  } else if (ICON_PICKER_TYPES.includes(selectedType)) {
    showCategoryPicker();
  }
}

document.getElementById("cancel-edit-btn-2").addEventListener("click", cancelEdit);

document.getElementById("delete-entry-btn").addEventListener("click", async () => {
  if (!editingEntryId) return;
  if (!confirm("Delete this entry? This can't be undone.")) return;
  await callApi("discardEntry", { id: editingEntryId });
  exitEditMode();
  await refreshEntryList();
  refreshExpectedRecurring();
  if (editingViaPopup) {
    await refreshAfterPopupEdit();
  } else if (ICON_PICKER_TYPES.includes(selectedType)) {
    showCategoryPicker();
  }
});

// ---- Editing as a pop-up (from an Overview drill-down) ----
// Reuses the exact same entry-card (type tabs, category picker, form) by
// physically relocating it into the pop-up's body, instead of duplicating
// all of that logic in a second form. Moving a DOM node preserves its
// event listeners, so everything above keeps working unchanged.

function openEditPopup(entry) {
  document.getElementById("edit-entry-modal-body").appendChild(document.getElementById("entry-card"));
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

async function refreshReviewQueue() {
  await flushQueuedReviewActions_();
  const queuedIds = new Set(getQueuedReviewActions_().map((a) => a.id));
  const entries = (await callApi("listPendingEntries", {})).filter((e) => !queuedIds.has(e.id));
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
      <div class="review-item-fields">
        <select class="review-category">
          <option value="">Pick a category…</option>
          ${categoryOptions}
        </select>
        <input class="review-description" type="text" value="${escapeHtml(entry.description || "")}" placeholder="Description">
        <input class="review-amount" type="text" inputmode="decimal" value="${entry.amount}" placeholder="Amount">
      </div>
      <div class="review-item-actions">
        <button type="button" class="review-confirm-btn">✅ Confirm</button>
        <button type="button" class="review-discard-btn">❌ Discard</button>
      </div>
    `;

    const amountInput = item.querySelector(".review-amount");
    amountInput.addEventListener("input", (e) => {
      const sanitized = sanitizeAmountInputValue(e.target.value);
      if (sanitized !== e.target.value) e.target.value = sanitized;
    });

    const confirmBtn = item.querySelector(".review-confirm-btn");
    const discardBtn = item.querySelector(".review-discard-btn");

    confirmBtn.addEventListener("click", async () => {
      const categoryId = item.querySelector(".review-category").value;
      const description = item.querySelector(".review-description").value.trim();
      const amountStr = amountInput.value.trim();
      const amount = parseFloat(amountStr);

      if (!categoryId) {
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
      const fields = { category_id: categoryId, description, amount };
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
      if (!confirm("Discard this transaction? This can't be undone.")) return;

      queueReviewAction_(entry.id, "discard", null);
      item.remove();
      document.getElementById("review-count").textContent = list.children.length;
      if (list.children.length === 0) document.getElementById("review-queue-card").hidden = true;

      applyReviewAction_({ id: entry.id, action: "discard", fields: null }).catch(() => {
        // Stays queued, same as above.
      });
    });

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
  document.getElementById("drilldown-chart-legend-2").textContent = "Pace to stay in budget";

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
      endDate: p.endDate
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

  const recurringByDate = {};
  (data.recurringOccurrences || []).forEach((o) => {
    recurringByDate[o.date] = (recurringByDate[o.date] || 0) + o.amount;
  });
  const recurringDays = Object.keys(recurringByDate).sort();

  // Each recurring expense's day is a datapoint at its cumulative amount
  // so far — a straight line connects 0 (period start) to the first one,
  // each to the next, and the last to the budget amount at period end,
  // rather than a flat-then-vertical staircase. Same logic either way,
  // monthly or yearly — it just runs over whatever `days`/`recurringDays`
  // cover for that period.
  const paceVertices = [[0, 0]];
  let recurringRunning = 0;
  recurringDays.forEach((d) => {
    const idx = days.indexOf(d);
    if (idx === -1) return;
    recurringRunning += recurringByDate[d];
    paceVertices.push([idx, recurringRunning]);
  });
  const lastIdx = n - 1;
  // If recurring expenses alone already reach (or exceed) the budget, the
  // line just goes flat for the rest rather than sloping downward.
  const finalTarget = Math.max(budgetAmount, recurringRunning);
  const lastVertex = paceVertices[paceVertices.length - 1];
  if (lastVertex[0] === lastIdx) lastVertex[1] = finalTarget;
  else paceVertices.push([lastIdx, finalTarget]);

  const maxY = Math.max(budgetAmount, recurringRunning, ...actualPoints, 1) * 1.08;

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
    const cat = findCategory(entry.category_id);
    const marker = cat && cat.icon
      ? `<span class="entry-cat-icon" style="background:${cat.color || "#eee"}">${cat.icon}</span>`
      : `<span class="type-dot" data-type="${entry.type}"></span>`;

    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div class="entry-left">
        <div class="entry-category">${marker}${categoryName(entry.category_id)}</div>
        ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
        <div class="entry-meta">${entry.date} · ${paidByLabel(entry)}</div>
      </div>
      <div class="entry-amount">
        ${renderEntryAmountHtml(entry)}
      </div>
    `;
    // Opens the same edit form used everywhere else, but as a pop-up on
    // top of this sheet — no need to leave Overview or close the
    // drill-down to fix a transaction.
    row.addEventListener("click", () => openEditPopup(entry));
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
  if (!confirm("Delete this budget? This can't be undone.")) return;
  const id = drilldownBudget.id;
  closeDrilldown();
  await callApi("deleteBudget", { id });
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
  if (!confirm("Delete this budget? This can't be undone.")) return;
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

async function init() {
  if (!getAccessCode()) {
    showSetupScreen();
    return;
  }

  document.getElementById("setup-screen").hidden = true;
  document.getElementById("app").hidden = true;
  document.getElementById("loading-screen").hidden = false;
  document.getElementById("date").value = todayLocalISO();
  renderCurrencyChips("entry");

  try {
    await loadMeta();
    await refreshEntryList();
    await refreshReviewQueue();
    await refreshExpectedRecurring();
    if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    } else {
      showDetailForm(null);
    }
    renderPeriodSelector();
    document.getElementById("loading-screen").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("bottom-nav").hidden = false;
  } catch (err) {
    document.getElementById("loading-screen").hidden = true;
    if (err.message === "Invalid access code") {
      localStorage.removeItem("accessCode");
      showSetupScreen("That code wasn't accepted. Try again.");
    } else {
      document.getElementById("app").hidden = false;
      document.getElementById("bottom-nav").hidden = false;
      document.getElementById("entry-list").innerHTML =
        `<div class="status-msg">Couldn't load data: ${escapeHtml(err.message)}</div>`;
    }
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
document.getElementById("exchange-rates-back-btn").addEventListener("click", () => showScreen("more"));

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

function recurringFreqLabel_(re) {
  if (re.frequency === "once") {
    const d = new Date(re.date + "T00:00:00");
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  if (re.frequency === "yearly") return `Yearly, ${MONTH_NAMES_SHORT[re.month - 1]} ${re.day}`;
  return `Monthly, day ${re.day}`;
}

function renderRecurringRow_(re) {
  const isIncome = re.category_type === "income";
  const row = document.createElement("div");
  row.className = "recurring-row" + (re.active ? "" : " inactive");
  row.innerHTML = `
    <div>
      <div class="recurring-row-name">${re.category_icon ? re.category_icon + " " : ""}${escapeHtml(re.description || re.category_name)}</div>
      <div class="recurring-row-sub">${escapeHtml(re.category_name)} · ${recurringFreqLabel_(re)}${re.active ? "" : " · Paused"}</div>
    </div>
    <div class="recurring-row-amount${isIncome ? " income" : ""}">${isIncome ? "+" : ""}${formatAmount(re.amount, re.currency)}</div>
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
      });
      container.appendChild(chip);
    });
}

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

function openRecurringModal(re) {
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

  // "Find past entries" only makes sense for an item that already exists
  // (it searches by this item's own id) — reset any previous search's
  // results each time the modal reopens, on a different item or the same
  // one, rather than showing stale candidates from before.
  document.getElementById("recurring-link-section").hidden = !re;
  document.getElementById("recurring-link-results").hidden = true;
  document.getElementById("recurring-link-list").innerHTML = "";
  document.getElementById("recurring-link-selected-btn").hidden = true;

  const backdrop = document.getElementById("recurring-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
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

    const fields = {
      category_id: selectedRecurringCategoryId,
      description,
      amount,
      currency,
      frequency: recurringFrequency,
      active
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

    if (editingRecurringId) {
      await callApi("updateRecurringExpense", Object.assign({ id: editingRecurringId }, fields));
    } else {
      await callApi("addRecurringExpense", fields);
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
  if (!confirm("Delete this item? This can't be undone.")) return;
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
async function refreshExpectedRecurring() {
  const card = document.getElementById("expected-recurring-card");
  const container = document.getElementById("expected-recurring-groups");
  let groups;
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
    let amountHtml;
    if (isPen) {
      amountHtml = `<span class="primary-amt">PEN ${moneyFmt(g.total)}</span>`;
    } else if (g.totalPen != null) {
      amountHtml = `<span class="primary-amt">PEN ${moneyFmt(g.totalPen)}</span>` +
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
    `).join("");

    const summary = document.createElement("div");
    summary.className = "expected-recurring-summary";
    summary.innerHTML = `
      <span class="expected-recurring-summary-label">🔁 ${g.items.length} programmed</span>
      <span class="expected-recurring-amount">${amountHtml}</span>
    `;
    summary.addEventListener("click", () => { detail.hidden = !detail.hidden; });

    group.appendChild(summary);
    group.appendChild(detail);
    container.appendChild(group);
  });
}

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
// Income never gets this split (matches the "By category" row's own
// isIncome gate) — its baseAmountPen isn't a year-to-date GUESS the way
// expense/investment's is, it's already-confirmed income the server just
// hasn't matched to a recurring item yet (see CLAUDE.md's per-category
// rule). Calling that "Expected" alongside "Programmed" implied it was a
// similar kind of estimate, when it's just as real/certain as the
// recurring portion — so for income the whole total shows as one plain
// figure instead.
function renderProjectionSplit_(detail) {
  const p = detail.projection;
  const splitEl = document.getElementById("drilldown-projection-split");
  const isExpenseOrInvestment = p.category_type === "expense" || p.category_type === "investment";
  const show = isExpenseOrInvestment && !p.hasOverride;
  splitEl.hidden = !show;
  document.getElementById("drilldown-projection-programmed-detail").hidden = true;
  document.getElementById("drilldown-projection-expected-detail").hidden = true;
  if (!show) return;

  document.getElementById("drilldown-projection-programmed-amount").textContent = formatPen(p.programmedRemainingPen);
  document.getElementById("drilldown-projection-expected-amount").textContent = formatPen(p.expectedRemainingPen);

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
  const convergenceVertices = [[startIdx, actualSoFar], [n - 1, convergenceTarget]];

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

let projectionOverrideState = null; // { categoryId, periodKey }

function openProjectionOverrideModal_(categoryProjection, detail) {
  projectionOverrideState = { categoryId: categoryProjection.category_id, periodKey: detail.bounds.periodKey };
  document.getElementById("projection-override-modal-title").textContent = "Edit projected total";
  document.getElementById("projection-override-modal-subtitle").textContent =
    `${categoryProjection.category_name} — currently ${detail.projection.hasOverride ? "manually set" : "calculated"} at ${formatPen(detail.projection.amountPen)}.`;
  document.getElementById("projection-override-value-input").value = detail.projection.amountPen.toFixed(2);
  document.getElementById("projection-override-form-error").textContent = "";
  document.getElementById("projection-override-reset-btn").hidden = !detail.projection.hasOverride;

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
  const amount = parseFloat(document.getElementById("projection-override-value-input").value);
  if (isNaN(amount) || amount < 0) {
    errorEl.textContent = "Enter a valid amount.";
    return;
  }
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
        banner.hidden = false;
      }
    } catch (err) {
      // Offline or a network hiccup — not worth surfacing, next check retries.
    }
  }

  banner.addEventListener("click", () => {
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

  const owedToMe = balances
    .filter((b) => !b.needs_rate && b.display_amount > 0)
    .sort((a, b) => b.net_pen - a.net_pen);
  const iOwe = balances
    .filter((b) => !b.needs_rate && b.display_amount < 0)
    .sort((a, b) => a.net_pen - b.net_pen);
  const needsRate = balances.filter((b) => b.needs_rate);

  renderLoanBalanceList_("loans-owed-to-me-list", "loans-owed-to-me-empty-note", owedToMe, "owed-to-me");
  renderLoanBalanceList_("loans-i-owe-list", "loans-i-owe-empty-note", iOwe, "i-owe");

  const needsRateCard = document.getElementById("loans-needs-rate-card");
  needsRateCard.hidden = needsRate.length === 0;
  if (needsRate.length) {
    const list = document.getElementById("loans-needs-rate-list");
    list.innerHTML = "";
    needsRate.forEach((b) => {
      const row = document.createElement("div");
      row.className = "loan-row";
      row.innerHTML = `<span class="loan-row-name">${escapeHtml(b.friend_name)}</span>`;
      row.addEventListener("click", () => openLoanDetail(b.friend_id, b.friend_name));
      list.appendChild(row);
    });
  }
}

function renderLoanBalanceList_(listId, emptyNoteId, balances, kind) {
  const list = document.getElementById(listId);
  const emptyNote = document.getElementById(emptyNoteId);
  list.innerHTML = "";

  if (balances.length === 0) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  balances.forEach((b) => {
    const amount = Math.abs(b.display_amount);
    const label = kind === "owed-to-me"
      ? `+${b.display_currency} ${moneyFmt(amount)}`
      : `${b.display_currency} ${moneyFmt(amount)}`;

    const row = document.createElement("div");
    row.className = "loan-row";
    row.innerHTML = `
      <span class="loan-row-name">${escapeHtml(b.friend_name)}</span>
      <span class="loan-row-amount ${kind}">${label}</span>
    `;
    row.addEventListener("click", () => openLoanDetail(b.friend_id, b.friend_name));
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
  list.innerHTML = "";

  if (loans.length === 0) {
    emptyNote.hidden = false;
  } else {
    emptyNote.hidden = true;
    loans.forEach((l) => {
      const kind = l.direction === "they_owe_me" ? "owed-to-me" : "i-owe";
      const sign = l.direction === "they_owe_me" ? "+" : "";
      const statusNote = l.status === "forgiven"
        ? "Forgiven"
        : l.remaining <= 0.004
          ? "Fully repaid"
          : l.settled > 0.004
            ? `${l.currency} ${moneyFmt(l.settled)} repaid so far`
            : "";

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

      list.appendChild(row);
    });
  }

  const backdrop = document.getElementById("loan-detail-modal-backdrop");
  bringModalToFront_(backdrop);
  backdrop.hidden = false;
}

// Loading state is brief enough (one small API call) not to need its own
// spinner — errEl reuses the same slot the rest of this sheet has none
// of, so a failure (e.g. the entry was since deleted some other way)
// shows up as a plain alert rather than silently doing nothing.
async function openLinkedEntryFromLoan_(entryId) {
  try {
    const entry = await callApi("getEntry", { id: entryId });
    if (!entry) throw new Error("That expense couldn't be found — it may have been deleted.");
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
  document.getElementById("loan-date").value = loan ? loan.date : todayLocalISO();
  document.getElementById("loan-due-date").value = loan ? (loan.due_date || "") : "";
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
  if (!confirm("Delete this loan? This can't be undone.")) return;
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
  const select = document.getElementById("settlement-overpay-category");
  select.innerHTML = "";
  meta.categories.filter((c) => c.type === type).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = (c.icon ? c.icon + " " : "") + c.name;
    select.appendChild(opt);
  });
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
  pendingOverpay = null;
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
        ? `${repaymentFriendName} paid ${result.currency} ${moneyFmt(result.overpaid)} more than they owed — recording it as income.`
        : `You paid ${repaymentFriendName} ${result.currency} ${moneyFmt(result.overpaid)} more than you owed — recording it as an expense.`;
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
  if (!confirm("Delete this repayment? This can't be undone.")) return;

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
    closeSettlementModal();
    await refreshEntryList();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

init();
