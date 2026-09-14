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
let editingEntryId = null;

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
document.getElementById("amount").addEventListener("input", (e) => {
  let value = e.target.value.replace(/,/g, ".");
  value = value.replace(/[^\d.]/g, "");
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, "");
  }
  if (value !== e.target.value) e.target.value = value;
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
  selectCurrency(entry.currency);

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
  if (ICON_PICKER_TYPES.includes(selectedType)) {
    showCategoryPicker();
  }
}

document.getElementById("cancel-edit-btn").addEventListener("click", cancelEdit);
document.getElementById("cancel-edit-btn-2").addEventListener("click", cancelEdit);

document.getElementById("delete-entry-btn").addEventListener("click", async () => {
  if (!editingEntryId) return;
  if (!confirm("Delete this entry? This can't be undone.")) return;
  await callApi("discardEntry", { id: editingEntryId });
  exitEditMode();
  await refreshEntryList();
  if (ICON_PICKER_TYPES.includes(selectedType)) {
    showCategoryPicker();
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- Review queue (entries caught automatically from email) ----

async function refreshReviewQueue() {
  const entries = await callApi("listPendingEntries", {});
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
      </div>
      <div class="review-item-actions">
        <button type="button" class="review-confirm-btn">✅ Confirm</button>
        <button type="button" class="review-discard-btn">❌ Discard</button>
      </div>
    `;

    item.querySelector(".review-confirm-btn").addEventListener("click", async () => {
      const categoryId = item.querySelector(".review-category").value;
      const description = item.querySelector(".review-description").value.trim();
      if (!categoryId) {
        alert("Pick a category first.");
        return;
      }
      await callApi("updateEntry", { id: entry.id, fields: { category_id: categoryId, description } });
      await callApi("confirmEntry", { id: entry.id });
      await refreshReviewQueue();
      await refreshEntryList();
    });

    item.querySelector(".review-discard-btn").addEventListener("click", async () => {
      if (!confirm("Discard this transaction? This can't be undone.")) return;
      await callApi("discardEntry", { id: entry.id });
      await refreshReviewQueue();
    });

    list.appendChild(item);
  });
}

// ---- Screens / bottom nav ----

const FALLBACK_PALETTE = ["#C9E4F7", "#F7C6D9", "#D9F2D9", "#FFE0B2", "#E0D9F7", "#FFF3B0", "#F7D9C4", "#D9F7F0"];

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.hidden = el.id !== `screen-${name}`;
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });
  if (name === "overview") refreshOverview();
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
  refreshOverview();
}

document.getElementById("period-prev").addEventListener("click", () => movePeriod(-1));
document.getElementById("period-next").addEventListener("click", () => movePeriod(1));

document.querySelectorAll(".period-type-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    periodType = chip.dataset.periodType;
    renderPeriodSelector();
    if (periodType !== "custom") refreshOverview();
  });
});

document.getElementById("custom-start").addEventListener("change", refreshOverview);
document.getElementById("custom-end").addEventListener("change", refreshOverview);

// Swipe left/right over the Overview screen to move a month/year at a
// time — same touch-gesture spirit as pull-to-refresh below.
(function setupPeriodSwipe() {
  const el = document.getElementById("screen-overview");
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
})();

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

function formatPen(n) {
  return `PEN ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

async function openBreakdownDrilldown(kind, item) {
  const bounds = getPeriodBounds();
  const backdrop = document.getElementById("drilldown-modal-backdrop");
  const title = document.getElementById("drilldown-title");
  const subtitle = document.getElementById("drilldown-subtitle");
  const list = document.getElementById("drilldown-list");

  title.textContent = `${item.icon ? item.icon + " " : ""}${item.name}`;
  subtitle.textContent = `${bounds.label} · ${overviewType === "expense" ? "Expense" : "Income"}`;
  list.innerHTML = '<div class="status-msg">Loading…</div>';
  backdrop.hidden = false;

  const payload = { startDate: bounds.startDate, endDate: bounds.endDate, type: overviewType };
  if (kind === "category") payload.categoryId = item.id;
  else if (kind === "tag") payload.tagId = item.id;
  else if (kind === "paymentMethod") payload.paymentMethodId = item.id;

  try {
    const entries = await callApi("listEntries", payload);
    renderDrilldownEntries(entries);
  } catch (err) {
    list.innerHTML = `<div class="status-msg">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
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
    const penLine = entry.currency !== "PEN" && entry.amount_pen != null
      ? `<span class="pen-amt">(PEN ${Number(entry.amount_pen).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>`
      : "";

    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div class="entry-left">
        <div class="entry-category">${marker}${categoryName(entry.category_id)}</div>
        ${entry.description ? `<div class="entry-desc">${escapeHtml(entry.description)}</div>` : ""}
        <div class="entry-meta">${entry.date} · ${paidByLabel(entry.paid_by)}</div>
      </div>
      <div class="entry-amount">
        <span class="primary-amt">${formatAmount(entry.amount, entry.currency)}</span>${penLine}
      </div>
    `;
    list.appendChild(row);
  });
}

document.getElementById("drilldown-modal-close").addEventListener("click", () => {
  document.getElementById("drilldown-modal-backdrop").hidden = true;
});
document.getElementById("drilldown-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "drilldown-modal-backdrop") {
    document.getElementById("drilldown-modal-backdrop").hidden = true;
  }
});

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
    await refreshReviewQueue();
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
      if (!document.getElementById("screen-overview").hidden) {
        await refreshOverview();
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

init();
