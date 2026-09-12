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

function getAccessCode() {
  return localStorage.getItem("accessCode") || "";
}

function setAccessCode(code) {
  localStorage.setItem("accessCode", code);
}

async function callApi(action, payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ accessCode: getAccessCode(), action, payload: payload || {} })
  });
  const json = await res.json();
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
    const categoryId = document.getElementById("category").value;
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
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---- Entry list ----

function formatAmount(amount, currency) {
  return `${currency} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function categoryName(id) {
  const c = meta.categories.find((cat) => cat.id === id);
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

    const left = document.createElement("div");
    left.className = "entry-left";
    left.innerHTML = `
      <div class="entry-category"><span class="type-dot" data-type="${entry.type}"></span>${categoryName(entry.category_id)}</div>
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
  document.getElementById("app").hidden = false;
  document.getElementById("date").value = todayLocalISO();

  try {
    await loadMeta();
    await refreshEntryList();
  } catch (err) {
    if (err.message === "Invalid access code") {
      localStorage.removeItem("accessCode");
      showSetupScreen("That code wasn't accepted. Try again.");
    } else {
      document.getElementById("entry-list").innerHTML =
        `<div class="status-msg">Couldn't load data: ${escapeHtml(err.message)}</div>`;
    }
  }
}

init();
