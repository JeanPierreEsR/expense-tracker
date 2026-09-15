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

  const amountInput = document.getElementById("amount");
  amountInput.focus();
}

function getCategoryId() {
  if (ICON_PICKER_TYPES.includes(selectedType)) return selectedCategoryId;
  return document.getElementById("category").value;
}

document.getElementById("change-category-btn").addEventListener("click", showCategoryPicker);

function populatePaidByOptions() {
  const select = document.getElementById("paid_by");
  select.innerHTML = "";
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
  const paidBy = document.getElementById("paid_by").value;
  document.getElementById("payment-method-field").hidden = paidBy !== "me";
}

// ---- Type tabs ----

document.querySelectorAll("#entry-type-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    selectedType = tab.dataset.type;
    document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t === tab));
    populateCategoryOptions();
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

    if (!date) throw new Error("Date is required.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!categoryId) throw new Error("Pick a category.");
    if (paidBy === "me" && !paymentMethodId) throw new Error("Pick a payment method.");

    await ensureExchangeRate(currency, date);

    if (editingEntryId) {
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
          payment_method_id: paidBy === "me" ? paymentMethodId : ""
        }
      });
      exitEditMode();
    } else {
      await callApi("createEntry", {
        type: selectedType,
        date,
        amount,
        currency,
        category_id: categoryId,
        description,
        paid_by: paidBy,
        payment_method_id: paidBy === "me" ? paymentMethodId : "",
        tag_ids: Array.from(selectedTagIds)
      });
    }

    document.getElementById("amount").value = "";
    document.getElementById("description").value = "";
    selectedTagIds.clear();
    populateTags();

    await refreshEntryList();
    refreshExpectedRecurring();

    if (editingViaPopup) {
      await refreshAfterPopupEdit();
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

function paidByLabel(paidBy) {
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
      <div class="entry-meta">${entry.date} · ${paidByLabel(entry.paid_by)}</div>
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

function startEditEntry(entry) {
  editingEntryId = entry.id;

  selectedType = entry.type;
  document.querySelectorAll("#entry-type-tabs .type-tab").forEach((t) => t.classList.toggle("active", t.dataset.type === entry.type));
  populateCategoryOptions();

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
  if (entry.paid_by === "me") {
    document.getElementById("payment_method").value = entry.payment_method_id || "";
  }

  document.getElementById("tags-field").hidden = true;
  document.getElementById("tags-edit-note").hidden = false;

  document.getElementById("edit-mode-banner").hidden = false;
  document.getElementById("submit-btn").textContent = "Update entry";
  document.getElementById("cancel-edit-btn-2").hidden = false;
  document.getElementById("delete-entry-btn").hidden = false;

  document.getElementById("entry-form").scrollIntoView({ behavior: "smooth" });
}

function exitEditMode() {
  editingEntryId = null;
  document.getElementById("edit-mode-banner").hidden = true;
  document.getElementById("submit-btn").textContent = "Save entry";
  document.getElementById("cancel-edit-btn-2").hidden = true;
  document.getElementById("delete-entry-btn").hidden = true;
  document.getElementById("tags-field").hidden = false;
  document.getElementById("tags-edit-note").hidden = true;
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
  if (name === "projections") refreshProjections();
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
// Bound to both screens now that they share one period selector — swiping
// to change the period works "just as in Overview" from Budgets too.
["screen-overview", "screen-budgets"].forEach((screenId) => {
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
  document.getElementById("drilldown-menu-btn").hidden = true;
  document.getElementById("drilldown-menu").hidden = true;
  document.getElementById("drilldown-categories").hidden = true;
  document.getElementById("drilldown-chart").hidden = true;

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
  document.getElementById("drilldown-menu-btn").hidden = false;
  document.getElementById("drilldown-menu").hidden = true;

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

  const paceVertices = [[0, 0]];
  let recurringRunning = 0;
  recurringDays.forEach((d) => {
    const idx = days.indexOf(d);
    if (idx === -1) return;
    paceVertices.push([idx, recurringRunning]);
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

  // Y-axis: 4 evenly spaced labels from 0 up to the top of the scale,
  // rounded to whole numbers — the exact currency and decimals are
  // already shown in the header/pace note, so the axis stays compact.
  const yTicksSvg = [0, 1, 2, 3].map((i) => {
    const value = (maxY * i) / 3;
    const y = yFor(value).toFixed(1);
    return `
      <line x1="${marginLeft - 3}" y1="${y}" x2="${marginLeft}" y2="${y}" style="stroke:var(--border);stroke-width:1" />
      <text x="${marginLeft - 6}" y="${y}" dy="2.5" text-anchor="end" style="font-size:7.5px;fill:var(--muted)">${Math.round(value).toLocaleString("en-US")}</text>
    `;
  }).join("");

  // X-axis ticks: weekly through a monthly period, quarterly through a
  // yearly one — found by matching actual calendar dates in `days` rather
  // than a fixed day-count, so it's correct regardless of month length or
  // which dates a yearly budget's quarters actually fall on.
  const axisYear = p.startDate.slice(0, 4);
  let xTickIndices;
  if (p.effectivePeriodType === "yearly") {
    xTickIndices = [1, 4, 7, 10]
      .map((m) => days.indexOf(`${axisYear}-${pad2(m)}-01`))
      .filter((i) => i !== -1);
  } else {
    xTickIndices = [];
    for (let i = 0; i < n; i += 7) xTickIndices.push(i);
  }
  const xTicksSvg = xTickIndices.map((i) => {
    const x = xFor(i).toFixed(1);
    const label = p.effectivePeriodType === "yearly"
      ? MONTH_NAMES_SHORT[parseInt(days[i].slice(5, 7), 10) - 1]
      : String(parseInt(days[i].slice(8, 10), 10));
    return `
      <line x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 3}" style="stroke:var(--border);stroke-width:1" />
      <text x="${x}" y="${plotBottom + 11}" text-anchor="middle" style="font-size:7.5px;fill:var(--muted)">${label}</text>
    `;
  }).join("");

  document.getElementById("drilldown-chart-svg").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${plotBottom}" style="stroke:var(--border);stroke-width:1" />
      <line x1="${marginLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" style="stroke:var(--border);stroke-width:1" />
      ${yTicksSvg}
      ${xTicksSvg}
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
        <div class="entry-meta">${entry.date} · ${paidByLabel(entry.paid_by)}</div>
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
}

document.getElementById("drilldown-modal-close").addEventListener("click", closeDrilldown);
document.getElementById("drilldown-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "drilldown-modal-backdrop") closeDrilldown();
});

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
      hasRate = !!(await callApi("getExchangeRate", { currency, month }));
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

async function refreshRecurringExpenses() {
  const list = document.getElementById("recurring-list");
  const emptyNote = document.getElementById("recurring-empty-note");
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  let items;
  try {
    items = await callApi("listRecurringExpenses");
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  list.innerHTML = "";
  emptyNote.hidden = items.length > 0;

  items.forEach((re) => {
    const freqLabel = re.frequency === "yearly"
      ? `Yearly, ${MONTH_NAMES_SHORT[re.month - 1]} ${re.day}`
      : `Monthly, day ${re.day}`;
    const isIncome = re.category_type === "income";
    const row = document.createElement("div");
    row.className = "recurring-row" + (re.active ? "" : " inactive");
    row.innerHTML = `
      <div>
        <div class="recurring-row-name">${re.category_icon ? re.category_icon + " " : ""}${escapeHtml(re.description || re.category_name)}</div>
        <div class="recurring-row-sub">${escapeHtml(re.category_name)} · ${freqLabel}${re.active ? "" : " · Paused"}</div>
      </div>
      <div class="recurring-row-amount${isIncome ? " income" : ""}">${isIncome ? "+" : ""}${formatAmount(re.amount, re.currency)}</div>
    `;
    row.addEventListener("click", () => openRecurringModal(re));
    list.appendChild(row);
  });
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

function setRecurringFrequency_(freq) {
  recurringFrequency = freq;
  document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.frequency === freq);
  });
  const isYearly = freq === "yearly";
  document.getElementById("recurring-month-label").hidden = !isYearly;
  document.getElementById("recurring-month").hidden = !isYearly;
}

document.querySelectorAll("#recurring-frequency-tabs .type-tab").forEach((tab) => {
  tab.addEventListener("click", () => setRecurringFrequency_(tab.dataset.frequency));
});

function openRecurringModal(re) {
  editingRecurringId = re ? re.id : null;
  document.getElementById("recurring-modal-title").textContent = re ? "Edit recurring item" : "Add recurring item";
  document.getElementById("recurring-form-error").textContent = "";
  document.getElementById("recurring-description").value = re ? re.description : "";

  selectedRecurringCategoryId = re ? re.category_id : null;
  populateRecurringCategoryChips();

  document.getElementById("recurring-amount").value = re ? re.amount : "";
  document.getElementById("recurring-currency").value = re ? re.currency : "PEN";
  renderCurrencyChips("recurring");

  setRecurringFrequency_(re ? re.frequency : "monthly");
  document.getElementById("recurring-day").value = re ? re.day : 1;
  document.getElementById("recurring-month").value = re ? re.month : 1;
  document.getElementById("recurring-active-checkbox").checked = re ? re.active : true;
  document.getElementById("recurring-delete-btn").hidden = !re;

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
    const day = Math.min(31, Math.max(1, parseInt(document.getElementById("recurring-day").value, 10) || 1));
    const month = Math.min(12, Math.max(1, parseInt(document.getElementById("recurring-month").value, 10) || 1));
    const active = document.getElementById("recurring-active-checkbox").checked;

    if (!selectedRecurringCategoryId) throw new Error("Pick a category.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");

    const fields = {
      category_id: selectedRecurringCategoryId,
      description,
      amount,
      currency,
      frequency: recurringFrequency,
      day,
      month,
      active
    };

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
  if (!confirm("Delete this recurring item? This can't be undone.")) return;
  const id = editingRecurringId;
  closeRecurringModal();
  await callApi("deleteRecurringExpense", { id });
  refreshRecurringExpenses();
});

// ---- "Expected this month" (Entries tab) ----

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
      <div class="expected-recurring-item">
        <span class="expected-recurring-item-label">${item.category_icon ? item.category_icon + " " : ""}${escapeHtml(item.category_name)}${item.description ? " — " + escapeHtml(item.description) : ""}</span>
        <span class="expected-recurring-item-amount">Day ${item.day} · ${g.currency} ${moneyFmt(item.amount)}</span>
      </div>
    `).join("");

    const summary = document.createElement("div");
    summary.className = "expected-recurring-summary";
    summary.innerHTML = `
      <span class="expected-recurring-summary-label">🔁 ${g.items.length} expected</span>
      <span class="expected-recurring-amount">${amountHtml}</span>
    `;
    summary.addEventListener("click", () => { detail.hidden = !detail.hidden; });

    group.appendChild(summary);
    group.appendChild(detail);
    container.appendChild(group);
  });
}

// ---- Projections ----

async function refreshProjections() {
  const body = document.getElementById("projections-body");
  const monthLabel = document.getElementById("projections-month-label");
  const methodNote = document.getElementById("projections-method-note");
  body.innerHTML = '<div class="status-msg">Loading…</div>';
  monthLabel.textContent = "";
  methodNote.textContent = "";

  let p;
  try {
    p = await callApi("getProjections");
  } catch (err) {
    body.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  monthLabel.textContent = `Projected for ${p.monthLabel}`;

  // Only worth a breakdown line when at least one recurring item actually
  // contributed to that figure — otherwise it's just "0 + the same total
  // again", which tells the reader nothing they don't already see above.
  const breakdownLines = [];
  if (p.incomeFromRecurring > 0) {
    breakdownLines.push(`Income: ${formatPen(p.incomeFromRecurring)} from recurring items + ${formatPen(p.incomeFromAverage)} from your recent average.`);
  }
  if (p.expensesFromRecurring > 0) {
    breakdownLines.push(`Expenses: ${formatPen(p.expensesFromRecurring)} from recurring items + ${formatPen(p.expensesFromAverage)} from your recent average.`);
  }
  if (p.investmentsFromRecurring > 0) {
    breakdownLines.push(`Investments: ${formatPen(p.investmentsFromRecurring)} from recurring items + ${formatPen(p.investmentsFromAverage)} from your recent average.`);
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
  methodNote.textContent = `Each figure uses a category's recurring income/expenses when it has any, and the average of your last ${p.averageMonths} complete months otherwise — never both, so nothing is counted twice.`;
}

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

init();
