// The Web App URL isn't secret by itself — the ACCESS_CODE is what protects
// writes. That code lives only in this browser's localStorage, never here.
const API_URL = "https://script.google.com/macros/s/AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g/exec";

const TYPE_LABELS = {
  expense: "Expense",
  income: "Income",
  investment: "Investment",
  transfer: "Transfer"
};

let meta = null;
let selectedType = "expense";
let selectedTagIds = new Set();
let selectedCategoryId = null;

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

function selectCurrency(code) {
  document.getElementById("currency").value = code;
  bumpRecentCurrency(code);
  renderCurrencyChips();
  closeCurrencyModal();
}

function renderCurrencyChips() {
  const container = document.getElementById("currency-chips");
  const current = document.getElementById("currency").value;
  container.innerHTML = "";

  getRecentCurrencies().forEach((code) => {
    const cur = findCurrency(code);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "currency-chip" + (code === current ? " active" : "");
    chip.innerHTML = `<span>${cur.flag}</span><span>${cur.code}</span>`;
    chip.addEventListener("click", () => selectCurrency(code));
    container.appendChild(chip);
  });

  const moreChip = document.createElement("button");
  moreChip.type = "button";
  moreChip.className = "currency-chip more";
  moreChip.textContent = "More…";
  moreChip.addEventListener("click", openCurrencyModal);
  container.appendChild(moreChip);
}

function openCurrencyModal() {
  document.getElementById("currency-modal-backdrop").hidden = false;
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
    row.addEventListener("click", () => selectCurrency(c.code));
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
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ accessCode: getAccessCode(), action, payload: payload || {} })
    });
    json = await res.json();
  } catch (networkErr) {
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

document.querySelectorAll(".type-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    selectedType = tab.dataset.type;
    document.querySelectorAll(".type-tab").forEach((t) => t.classList.toggle("active", t === tab));
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
    const type = prompt("Type: credit, debit, cash, transfer, or wallet?", "credit") || "credit";
    const last4 = prompt("Last 4 digits (leave blank if none):") || "";
    const pm = await callApi("addPaymentMethod", { nickname: nickname.trim(), type: type.trim(), last_4: last4.trim() });
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

// ---- Currency & exchange rate ----

async function ensureExchangeRate(currency, dateStr) {
  if (currency === "PEN") return;
  const month = dateStr.slice(0, 7);
  const existing = await callApi("getExchangeRate", { currency, month });
  if (existing) return;

  const rateStr = prompt(
    `No exchange rate on file for ${currency} in ${month}.\n1 ${currency} = how many PEN?`
  );
  const rate = parseFloat(rateStr);
  if (!rateStr || isNaN(rate) || rate <= 0) {
    throw new Error("An exchange rate is required to save this entry.");
  }
  await callApi("setExchangeRate", { currency, month, rate });
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

    if (!date) throw new Error("Date is required.");
    if (!amount || amount <= 0) throw new Error("Enter a valid amount.");
    if (!categoryId) throw new Error("Pick a category.");
    if (paidBy === "me" && !paymentMethodId) throw new Error("Pick a payment method.");

    await ensureExchangeRate(currency, date);

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

    document.getElementById("amount").value = "";
    document.getElementById("description").value = "";
    selectedTagIds.clear();
    populateTags();

    await refreshEntryList();

    if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    }
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---- Entry list ----

function formatAmount(amount, currency) {
  const flag = findCurrency(currency).flag;
  return `${flag} ${currency} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    const penLine = entry.currency !== "PEN" && entry.amount_pen != null
      ? `<span class="pen-amt">(PEN ${Number(entry.amount_pen).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>`
      : "";
    amount.innerHTML = `<span class="primary-amt">${formatAmount(entry.amount, entry.currency)}</span>${penLine}`;

    row.appendChild(left);
    row.appendChild(amount);
    list.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
  renderCurrencyChips();

  try {
    await loadMeta();
    await refreshEntryList();
    if (ICON_PICKER_TYPES.includes(selectedType)) {
      showCategoryPicker();
    } else {
      showDetailForm(null);
    }
    document.getElementById("loading-screen").hidden = true;
    document.getElementById("app").hidden = false;
  } catch (err) {
    document.getElementById("loading-screen").hidden = true;
    if (err.message === "Invalid access code") {
      localStorage.removeItem("accessCode");
      showSetupScreen("That code wasn't accepted. Try again.");
    } else {
      document.getElementById("app").hidden = false;
      document.getElementById("entry-list").innerHTML =
        `<div class="status-msg">Couldn't load data: ${escapeHtml(err.message)}</div>`;
    }
  }
}

init();
