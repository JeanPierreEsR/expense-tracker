// Statements screen (More → Statements).
//
// Milestone 1: (1) the "Statement coverage" list — which statement was
// processed last for each account and when the next one is expected — and
// (2) upload + reading: pick statement PDFs, they are read ON THIS DEVICE
// (pdf.js, self-hosted under vendor/pdfjs), every reading verifies itself,
// and the result is shown. NOTHING on this screen writes data; the file
// never leaves the device. Loaded after app.js and uses its globals
// (callApi, escapeHtml, bringModalToFront_).

(function () {
  const $ = (id) => document.getElementById(id);
  const APP_VERSION = ((document.querySelector('script[src^="app.js"]') || {}).getAttribute
    ? (document.querySelector('script[src^="app.js"]').getAttribute("src").split("?v=")[1] || "")
    : "");

  let coverage = null;       // last listStatementCoverage result
  let pdfjsPromise = null;   // pdf.js is loaded only when first needed

  // ---- helpers ----

  function fmtDate(iso, withYear) {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  }

  function fmtMoney(currency, n) {
    const sign = n < 0 ? "−" : "";
    return `${sign}${currency} ${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function addDaysISO(iso, n) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // The account a statement belongs to is the last four digits of the account
  // or card number printed on it (a product without a number is keyed by its
  // currency) — the same key the backend's coverage list uses.
  function accountKeyOf(result) {
    if (result.kind === "ahorramas") return `AHORRA-${Object.keys(result.balances)[0]}`;
    return String((result.account && result.account.last4) || "");
  }

  // ---- screen navigation (same pattern as the other More sub-screens) ----

  function showStatementsScreen() {
    document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-statements"; });
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.screen === "more");
    });
    refreshStatementCoverage();
  }

  // ---- coverage list ----

  const STATUS_LABEL = {
    ok: ["✅", "Up to date"],
    due: ["🔴", "Newer statement due"],
    never: ["⚪", "None processed yet"]
  };

  async function refreshStatementCoverage() {
    const list = $("statement-coverage-list");
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
      coverage = await callApi("listStatementCoverage", {});
    } catch (err) {
      list.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`;
      return;
    }
    renderCoverage();
  }

  function renderCoverage() {
    const list = $("statement-coverage-list");
    if (!coverage || !coverage.accounts.length) {
      list.innerHTML = '<p class="hint">No accounts to track yet.</p>';
      return;
    }
    list.innerHTML = coverage.accounts.map((a) => {
      const [icon, text] = STATUS_LABEL[a.status] || STATUS_LABEL.never;
      const last = a.last
        ? `Last: ${fmtDate(a.last.period_start)} – ${fmtDate(a.last.period_end, true)} · processed ${fmtDate(a.last.processed_at)}${a.last.verified ? "" : " · ⚠ couldn't be verified"}`
        : "Nothing processed yet";
      const next = a.next_expected ? `Next expected ≈ ${fmtDate(a.next_expected)}` : "";
      return `<div class="stmt-row">
        <div class="stmt-row-main">
          <div class="stmt-row-title">${escapeHtml(a.label)}</div>
          <div class="stmt-row-sub">${escapeHtml(last)}</div>
          ${next ? `<div class="stmt-row-sub">${escapeHtml(next)}</div>` : ""}
        </div>
        <span class="stmt-chip ${a.status}">${icon} ${text}</span>
      </div>`;
    }).join("");
  }

  // ---- pdf.js (loaded on first use) ----

  function loadPdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `vendor/pdfjs/pdf.min.js?v=${APP_VERSION}`;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = `vendor/pdfjs/pdf.worker.min.js?v=${APP_VERSION}`;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromise = null; reject(new Error("Couldn't load the PDF reader.")); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  // ---- password prompt (asked every time; never stored) ----

  let passwordResolve = null;

  function askStatementPassword(fileName, reason) {
    return new Promise((resolve) => {
      passwordResolve = resolve;
      $("statement-password-file").textContent = fileName;
      $("statement-password-msg").textContent = reason === 2
        ? "That password didn't work. Try again."
        : "This PDF is password-protected.";
      $("statement-password-input").value = "";
      const backdrop = $("statement-password-backdrop");
      bringModalToFront_(backdrop);
      backdrop.hidden = false;
      setTimeout(() => $("statement-password-input").focus(), 50);
    });
  }

  function closeStatementPassword(value) {
    $("statement-password-backdrop").hidden = true;
    $("statement-password-input").value = ""; // never keep it around
    const resolve = passwordResolve;
    passwordResolve = null;
    if (resolve) resolve(value);
  }

  // ---- reading a file and showing the result ----

  function resultCardShell(fileName) {
    const card = document.createElement("div");
    card.className = "stmt-result";
    card.innerHTML = `<div class="stmt-result-name">${escapeHtml(fileName)}</div><div class="stmt-result-body"><p class="hint">Reading… (a big statement can take a few seconds)</p></div>`;
    $("statement-results").prepend(card);
    return card.querySelector(".stmt-result-body");
  }

  function coverageNotes(result) {
    if (!coverage || !result.period || !result.period.end) return [];
    const acct = coverage.accounts.find((a) => a.key === accountKeyOf(result));
    const notes = [];
    if (!acct) {
      notes.push(["warn", `Not one of your tracked accounts (${escapeHtml(accountKeyOf(result) || "unknown")}).`]);
      return notes;
    }
    notes.push(["info", `Account: ${escapeHtml(acct.label)}`]);
    const last = acct.last;
    if (!last) return notes;
    if (result.period.end === last.period_end) {
      notes.push(["warn", `Already processed on ${escapeHtml(fmtDate(last.processed_at, true))} — this is the same period.`]);
    } else if (result.period.end < last.period_end) {
      notes.push(["warn", `Older than the last statement you processed (it ended ${escapeHtml(fmtDate(last.period_end, true))}).`]);
    } else {
      notes.push(["ok", `Newer than the last one processed (ended ${escapeHtml(fmtDate(last.period_end, true))}).`]);
      if (result.period.start && result.period.start > addDaysISO(last.period_end, 1)) {
        notes.push(["warn", `Gap: ${escapeHtml(fmtDate(addDaysISO(last.period_end, 1)))} to ${escapeHtml(fmtDate(addDaysISO(result.period.start, -1)))} isn't covered by any statement.`]);
      }
    }
    return notes;
  }

  function renderResult(body, result) {
    if (!result.kind) {
      body.innerHTML = `<p class="stmt-verdict bad">✗ Layout not recognised</p><p class="hint">${escapeHtml((result.errors || ["This statement isn't one of the supported layouts yet."])[0])}</p>`;
      return;
    }
    let verdict;
    if (!result.ok) verdict = '<p class="stmt-verdict bad">✗ Not usable — the numbers don\'t add up</p>';
    else if (result.verified === false) verdict = '<p class="stmt-verdict warn">⚠ Read, but it couldn\'t be verified (this kind of statement has no balance to check against)</p>';
    else verdict = '<p class="stmt-verdict good">✓ Read and checked — every total adds up</p>';

    const notes = coverageNotes(result).map(([cls, msg]) => `<p class="stmt-note ${cls}">${msg}</p>`).join("");
    const period = result.period && result.period.end ? `${fmtDate(result.period.start, true)} – ${fmtDate(result.period.end, true)}` : "—";
    const balances = Object.entries(result.balances || {}).map(([cur, b]) => {
      const rows = [];
      if (b.opening !== null && b.opening !== undefined) rows.push(`<div class="stmt-kv"><span>${cur} opening</span><span>${escapeHtml(fmtMoney(cur, b.opening))}</span></div>`);
      if (b.closing !== null && b.closing !== undefined) rows.push(`<div class="stmt-kv"><span>${cur} closing</span><span>${escapeHtml(fmtMoney(cur, b.closing))}</span></div>`);
      return rows.join("");
    }).join("");
    const errors = (result.errors || []).slice(0, 6).map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    const lines = (result.lines || []).map((l) =>
      `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`
    ).join("");

    body.innerHTML = `${verdict}${notes}
      <div class="stmt-kv"><span>Period</span><span>${escapeHtml(period)}</span></div>
      <div class="stmt-kv"><span>Lines read</span><span>${(result.lines || []).length}</span></div>
      ${balances}
      ${errors ? `<ul class="stmt-errors">${errors}</ul>` : ""}
      ${lines ? `<details class="stmt-lines"><summary>Show the ${(result.lines || []).length} lines</summary>${lines}</details>` : ""}`;
  }

  async function readStatementFile(file) {
    const body = resultCardShell(file.name);
    let cancelled = false;
    try {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const rows = await StatementParsers.readPdfRows(pdfjs, data, {
        onPassword: async (reason) => {
          const pw = await askStatementPassword(file.name, reason);
          if (pw === null) cancelled = true;
          return pw;
        }
      });
      renderResult(body, StatementParsers.parseStatement(rows));
    } catch (err) {
      if (cancelled) body.innerHTML = '<p class="stmt-verdict warn">Skipped — no password entered.</p>';
      else body.innerHTML = `<p class="stmt-verdict bad">✗ Couldn't read this file</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    }
  }

  async function handleStatementFiles(files) {
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    for (const f of Array.from(files)) await readStatementFile(f); // one at a time: easy on a phone's memory
  }

  // exposed for testing in the browser
  window.__statements = { handleStatementFiles, readStatementFile, renderCoverage, setCoverage: (c) => { coverage = c; } };

  // ---- wiring ----

  $("more-statements-btn").addEventListener("click", showStatementsScreen);
  $("statements-back-btn").addEventListener("click", () => showScreen("more"));
  $("statement-file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length) handleStatementFiles(files);
    e.target.value = ""; // lets the same file be picked again
  });
  $("statement-password-ok").addEventListener("click", () => closeStatementPassword($("statement-password-input").value));
  $("statement-password-cancel").addEventListener("click", () => closeStatementPassword(null));
  $("statement-password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeStatementPassword($("statement-password-input").value);
  });
})();
