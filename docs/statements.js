// Statements screen (More → Statements).
//
// Milestone 2 adds a read-only REVIEW: the lines read from the statements are
// sent to the server (analyzeStatements), which says what matches an entry
// already in the app, what doesn't, which lines are one transfer between two
// of the owner's accounts, and possible matches — shown grouped. Still nothing
// is saved.
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
  let usable = [];           // statements read OK this session: [{ file, result }]
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
    refreshStatementBatches();
    refreshStatementInbox();
  }

  // ---- inbox (statements that arrived by email) ----

  let inbox = [];

  async function refreshStatementInbox() {
    const list = $("statement-inbox-list");
    list.innerHTML = '<p class="hint">Loading…</p>';
    try { inbox = (await callApi("listStatementInbox", {})).items; }
    catch (err) { list.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`; return; }
    if (!inbox.length) { list.innerHTML = '<p class="hint">Nothing waiting. New statements from your banks show up here.</p>'; return; }
    list.innerHTML = inbox.map((i) => {
      const done = i.status === "processed";
      const note = done ? "✅ Processed" : (i.probably_processed ? `Probably already processed (you processed this account on ${fmtDate(i.last_processed, true)})` : "🟡 Not processed");
      return `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(i.bank)} · received ${escapeHtml(fmtDate(i.received, true))}</div>
        <div class="stmt-row-sub">${escapeHtml(note)} · ${i.size_kb} KB</div>
        <div class="stmt-choices" style="padding-left:0">
          <button type="button" class="stmt-choice stmt-inbox-open" data-id="${escapeHtml(i.id)}">Open</button>
          ${done ? "" : `<button type="button" class="stmt-choice stmt-inbox-dismiss" data-id="${escapeHtml(i.id)}">Dismiss</button>`}
        </div></div></div>`;
    }).join("");
  }

  async function openInboxItem(id, btn) {
    const item = inbox.find((i) => i.id === id);
    if (!item) return;
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const att = await callApi("getStatementAttachment", { id });
      const bin = atob(att.base64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const file = new File([bytes], att.name, { type: "application/pdf" });
      file.inboxId = id;
      if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
      await readStatementFile(file);
      $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      alert("Couldn't fetch that statement: " + (err && err.message ? err.message : err));
    }
    btn.disabled = false; btn.textContent = "Open";
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
        <span class="stmt-chip ${a.status}">${a.inbox_waiting ? `🟡 ${a.inbox_waiting} in inbox` : `${icon} ${text}`}</span>
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
      const result = StatementParsers.parseStatement(rows);
      renderResult(body, result);
      if (result.kind && result.ok) {
        // A re-read of the same file replaces its earlier reading.
        usable = usable.filter((u) => u.file !== file.name);
        usable.push({ file: file.name, result, inboxId: file.inboxId || "" });
        // The review's statement/line numbers refer to THIS list — any change makes an open review stale.
        review = null;
        $("statement-review").innerHTML = '<p class="hint">Statements changed — press "Review" to compare them again.</p>';
        updateReviewButton();
      }
    } catch (err) {
      if (cancelled) body.innerHTML = '<p class="stmt-verdict warn">Skipped — no password entered.</p>';
      else body.innerHTML = `<p class="stmt-verdict bad">✗ Couldn't read this file</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    }
  }

  async function handleStatementFiles(files) {
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    for (const f of Array.from(files)) await readStatementFile(f); // one at a time: easy on a phone's memory
  }

  // ---- review (read-only) ----

  function updateReviewButton() {
    const card = $("statement-review-card");
    card.hidden = usable.length === 0;
    $("statement-review-btn").textContent = `Review ${usable.length} statement${usable.length === 1 ? "" : "s"}`;
    $("statement-review-hint").textContent = "Compares the lines with the entries already in the app. Nothing is saved.";
  }

  async function runReview() {
    const btn = $("statement-review-btn");
    const out = $("statement-review");
    btn.disabled = true;
    out.innerHTML = '<p class="hint">Comparing with your entries…</p>';
    try {
      const analysis = await callApi("analyzeStatements", {
        statements: usable.map(({ result }) => ({
          key: accountKeyOf(result),
          kind: result.kind,
          period: result.period,
          balances: result.balances,
          verified: !!(result.ok && result.verified !== false),
          lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section }))
        }))
      });
      review = null;
      renderReview(analysis);
    } catch (err) {
      out.innerHTML = `<p class="stmt-verdict bad">✗ Couldn't compare</p><p class="hint">${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  function lineRow(l, sub) {
    return `<div class="stmt-line2">
      <div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>
      ${sub ? `<div class="stmt-line-sub">${sub}</div>` : ""}
    </div>`;
  }

  function entryText(e) {
    // A transfer has two ends; anything else has the one account it was paid with.
    const where = e.type === "transfer"
      ? `${e.account ? escapeHtml(e.account) : "?"} → ${e.to_account ? escapeHtml(e.to_account) : "?"}`
      : (e.account ? escapeHtml(e.account) : "no account");
    return `${escapeHtml(fmtDate(e.date))} · ${escapeHtml(e.description || "(no description)")} · ${escapeHtml(fmtMoney(e.currency, e.amount))}${e.category ? " · " + escapeHtml(e.category) : ""} · ${where}`;
  }

  // ---- interactive review (milestone 3) ----
  //
  // The review builds one "item" per decision the owner can make. Each item has
  // choices (buttons); nothing is written until Save, which sends every chosen
  // action as ONE batch that can be undone in one step.

  let review = null;      // { analysis, items, sel, cat, matchEntry, open }
  let lastBatchId = null; // the upload just saved (for Undo)

  function group(title, items, hint, open, key) {
    if (!items.length) return "";
    const isOpen = review && review.open.has(key) ? review.open.get(key) : open;
    return `<details class="stmt-group" data-gkey="${escapeHtml(key)}" ${isOpen ? "open" : ""}><summary>${escapeHtml(title)} <span class="stmt-count">${items.length}</span></summary>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}${items.join("")}</details>`;
  }

  function isPeoplePayment(l) { return /^(YAPE|PLIN)\b/i.test(String(l.description || "").trim()) || /^(YAPE|PLIN)[-.]/i.test(String(l.description || "")); }

  function buildItems(analysis) {
    const sts = analysis.statements;
    const acct = (si) => (sts[si].account ? sts[si].account.nickname : `unknown account (${sts[si].key})`);
    const items = [];
    sts.forEach((st, si) => {
      st.lines.forEach((l, li) => {
        const where = acct(si);
        const id = `${si}:${li}`;
        const base = { id, si, li, line: l, where };
        if (l.status === "handled") { items.push({ ...base, kind: "handled" }); return; }
        if (l.status === "completes") {
          items.push({ ...base, kind: "completes", choices: [["complete", "Complete it"]],
            build: () => ({ type: "complete_transfer", stmt: si, line: li, entryId: l.completesTransfer.entry.id, side: l.completesTransfer.side }) });
          return;
        }
        if (l.status === "matched") {
          if (l.entryHadNoAccount) {
            items.push({ ...base, kind: "assign", choices: [["assign", "Assign account"]],
              build: () => ({ type: "assign_account", stmt: si, line: li, entryId: l.entry.id }) });
          } else {
            items.push({ ...base, kind: "matched", auto: () => ({ type: "link", stmt: si, line: li, entryId: l.entry.id }) });
          }
          return;
        }
        if (l.pairedWith) {
          const pw = l.pairedWith;
          if (pw.stored) {
            // The other half was left "waiting" in an earlier upload.
            const thisIsOut = l.amount < 0;
            items.push({ ...base, kind: "pair", outIsThis: thisIsOut, fromEarlier: true,
              partner: { date: pw.date, description: pw.description, amount: pw.amount, currency: pw.currency }, partnerAcct: pw.account,
              choices: [["record", "Record"]],
              build: () => (thisIsOut
                ? { type: "record_transfer", out: { stmt: si, line: li }, in: { stored: pw.lineKey } }
                : { type: "record_transfer", out: { stored: pw.lineKey }, in: { stmt: si, line: li } }) });
          } else if (l.amount < 0) {
            items.push({ ...base, kind: "pair", outIsThis: true, partner: sts[pw.statement].lines[pw.line], partnerAcct: acct(pw.statement),
              choices: [["record", "Record"]],
              build: () => ({ type: "record_transfer", out: { stmt: si, line: li }, in: { stmt: pw.statement, line: pw.line } }) });
          }
          return;
        }
        if (l.guess === "fee") {
          items.push({ ...base, kind: "fee", choices: [["record", "Record"]], build: () => ({ type: "record_fee", stmt: si, line: li }) });
          return;
        }
        if (l.possible) {
          items.push({ ...base, kind: "possible", choices: [["match", "Yes, same"]],
            build: () => ({ type: "match", stmt: si, line: li, entryId: l.possible.entry.id, overwriteAccount: true }) });
          return;
        }
        if (l.waiting) {
          items.push({ ...base, kind: "waiting", choices: [["wait", "Leave waiting"], ["ignore", "Ignore"]],
            build: (choice) => ({ type: choice === "wait" ? "wait" : "ignore", stmt: si, line: li }) });
          return;
        }
        if (l.reversal) {
          const rv = l.reversal;
          const target = rv.candidates.find((c) => c.sameMonth) || rv.candidates[0] || null;
          const choices = [];
          if (rv.candidates.length) choices.push(["cancel", "Cancel the charge"]);
          choices.push(["refund", "Refund income"], ["ignore", "Ignore"]);
          items.push({ ...base, kind: "reversal", choices, suggested: target && target.sameMonth ? "cancel" : "refund",
            build: (choice, r) => {
              if (choice === "cancel") return { type: "cancel_charge", stmt: si, line: li, entryId: r.cancelEntry.get(id) || target.entry.id };
              if (choice === "refund") return { type: "add_income", stmt: si, line: li, category: rv.refundCategoryId, description: "Refund: " + l.description.replace(/^\s*REV\.?\s*/i, "") };
              return { type: "ignore", stmt: si, line: li };
            } });
          return;
        }
        if (l.guess === "income") {
          items.push({ ...base, kind: "income", choices: [["add", "Add as income"], ["match", "Match…"], ["ignore", "Ignore"]],
            build: (choice, r) => {
              if (choice === "add") return { type: "add_income", stmt: si, line: li, category: r.cat.has(id) ? r.cat.get(id) : ((l.suggestion && l.suggestion.categoryId) || "") };
              if (choice === "match") return { type: "match", stmt: si, line: li, entryId: r.matchEntry.get(id) };
              return { type: "ignore", stmt: si, line: li };
            } });
          return;
        }
        // a purchase not in the app
        items.push({ ...base, kind: "purchase", choices: [["add", "Add"], ["match", "Match…"], ["ignore", "Ignore"]],
          build: (choice, r) => {
            if (choice === "add") return { type: "add_purchase", stmt: si, line: li, category: r.cat.get(id) !== undefined ? r.cat.get(id) : ((l.suggestion && l.suggestion.categoryId) || "") };
            if (choice === "match") return { type: "match", stmt: si, line: li, entryId: r.matchEntry.get(id) };
            return { type: "ignore", stmt: si, line: li };
          } });
      });
    });
    (analysis.balance_checks || []).forEach((c) => {
      items.push({ id: `bal:${c.stmt}:${c.currency}`, kind: "balance", check: c, where: acct(c.stmt),
        choices: c.canSet ? [["set", c.direction === "untracked" ? "Start tracking with this balance" : "Set balance to statement"]] : null,
        build: () => ({ type: "set_balance", stmt: c.stmt, currency: c.currency }) });
    });
    return items;
  }

  function signed(cur, n) {
    return `${cur} ${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function balanceHtml(it) {
    const c = it.check, chosen = review.sel.get(it.id);
    const lines = [`<div class="stmt-kv"><span>Statement closing (${escapeHtml(fmtDate(c.end, true))})</span><span>${escapeHtml(fmtMoney(c.currency, c.closing))}</span></div>`];
    let verdict = "";
    if (c.direction === "untracked") {
      verdict = `<p class="stmt-note info">${escapeHtml(c.reason)}</p>`;
    } else {
      lines.push(`<div class="stmt-kv"><span>In the app at that date</span><span>${escapeHtml(fmtMoney(c.currency, c.appAtEnd))}</span></div>`);
      lines.push(`<div class="stmt-kv"><span>Difference</span><span>${escapeHtml(signed(c.currency, c.diff))}</span></div>`);
      if (c.diff === 0) {
        verdict = `<p class="stmt-note ok">✓ Matches to the cent.</p>`;
      } else if (c.direction === "forward") {
        const parts = [];
        if (c.notInApp.lines) parts.push(`${signed(c.currency, c.notInApp.net)} from ${c.notInApp.lines} line${c.notInApp.lines === 1 ? "" : "s"} not in the app`);
        if (c.pending.lines) parts.push(`${signed(c.currency, c.pending.net)} from ${c.pending.lines} pending purchase${c.pending.lines === 1 ? "" : "s"} (counted once confirmed)`);
        verdict = c.unexplained === 0
          ? `<p class="stmt-note ok">✓ Fully explained: ${escapeHtml(parts.join(" and "))}.</p>`
          : `<p class="stmt-note warn">${parts.length ? escapeHtml(parts.join(" and ")) + ". " : ""}<b>${escapeHtml(signed(c.currency, c.unexplained))} is unexplained</b> — something in the app differs from this statement.</p>`;
      } else if (c.direction === "backward") {
        verdict = `<p class="stmt-note info">${escapeHtml(c.reason)} The app's figure at that date is worked back from that newer balance, so a difference means entries dated after ${escapeHtml(fmtDate(c.end))} are missing or wrong — the next statement will show which.</p>`;
      } else {
        verdict = `<p class="stmt-note info">${escapeHtml(c.reason)}</p>`;
      }
      if (c.canSet) verdict += `<p class="hint">${escapeHtml(c.reason)} Setting it makes the app agree with the statement from ${escapeHtml(fmtDate(c.end))} on; earlier entries stop counting because the balance already includes them. You can ignore lines and still set it.</p>`;
    }
    const btn = it.choices ? `<div class="stmt-choices" style="padding-left:0">${it.choices.map(([k, label]) =>
      `<button type="button" class="stmt-choice ${chosen === k ? "on" : ""}" data-item="${escapeHtml(it.id)}" data-choice="${k}">${chosen === k ? "✓ " : ""}${escapeHtml(label)}</button>`).join("")}</div>` : "";
    return `<div class="stmt-line2"><div class="stmt-pair-title">${escapeHtml(it.where)} · ${escapeHtml(c.currency)}</div>${lines.join("")}${verdict}${btn}</div>`;
  }

  function itemHtml(it) {
    if (it.kind === "balance") return balanceHtml(it);
    const l = it.line, where = escapeHtml(it.where);
    const chosen = review.sel.get(it.id);
    let sub = "";
    if (it.kind === "completes") {
      const fill = l.completesTransfer.side === "to" ? "the receiving account (To)" : "the sending account (From)";
      sub = `${where} would become ${fill} of: ${entryText(l.completesTransfer.entry)}`;
    } else if (it.kind === "assign") {
      sub = `${where} → ${entryText(l.entry)}`;
    } else if (it.kind === "fee") {
      sub = where;
    } else if (it.kind === "possible") {
      const why = l.possible.shareOf ? `looks like your 1/${l.possible.shareOf} share of this bill` : "same amount and date, but assigned to another account";
      sub = `${where} — ${why}: ${entryText(l.possible.entry)}`;
    } else if (it.kind === "waiting") {
      sub = `${where} — looks like a transfer or card payment; its other side isn't in these statements`;
    } else if (it.kind === "reversal") {
      const rv = l.reversal;
      sub = `${where} — money back on the card (a reversal or refund).`;
      if (!rv.candidates.length) sub += " No matching charge found in the last 45 days, so it can only be a refund.";
      else if (chosen === "cancel") {
        const cur = review.cancelEntry.get(it.id) || (rv.candidates.find((c) => c.sameMonth) || rv.candidates[0]).entry.id;
        sub += `<br>cancels: ${entryText(rv.candidates.find((c) => c.entry.id === cur).entry)} — adds a pending negative expense`;
      } else if (chosen === "refund") sub += " Adds pending income in the Refunds category.";
      else sub += ` Best match: ${entryText(rv.candidates[0].entry)}${rv.candidates[0].sameMonth ? "" : " (an earlier month)"}.`;
    } else if (it.kind === "income") {
      sub = `${where}${l.suggestion ? ` — suggested category: <b>${escapeHtml(l.suggestion.categoryName)}</b> (${escapeHtml(l.suggestion.reason)})` : ""}`;
      if (chosen === "match" && review.matchEntry.has(it.id)) sub += `<br>matched to: ${escapeHtml(review.matchEntryText.get(it.id) || "")}`;
    } else if (it.kind === "purchase") {
      sub = `${where} — ${l.suggestion ? `suggested category: <b>${escapeHtml(l.suggestion.categoryName)}</b> (${escapeHtml(l.suggestion.reason)})` : "no category suggestion"}`;
      if (chosen === "match" && review.matchEntry.has(it.id)) sub += `<br>matched to: ${escapeHtml(review.matchEntryText.get(it.id) || "")}`;
    } else if (it.kind === "handled") {
      const h = l.handled;
      sub = `${where} — already handled (${escapeHtml(h.outcome)})${h.entry ? ": " + entryText(h.entry) : ""}`;
    } else if (it.kind === "matched") {
      sub = `${where} → ${entryText(l.entry)}${l.viaTotal ? " · matched on the bill total in its description" : ""}`;
    }
    let head;
    if (it.kind === "pair") {
      const fromAcct = it.outIsThis ? it.where : it.partnerAcct, toAcct = it.outIsThis ? it.partnerAcct : it.where;
      head = `<div class="stmt-pair-title">${escapeHtml(fromAcct)} → ${escapeHtml(toAcct)} · ${escapeHtml(fmtMoney(l.currency, Math.abs(l.amount)))}</div><div class="stmt-line-sub" style="padding-left:0">${escapeHtml(fmtDate(l.date))} “${escapeHtml(l.description)}” / ${escapeHtml(fmtDate(it.partner.date))} “${escapeHtml(it.partner.description)}”${it.fromEarlier ? " — the other half is from an earlier upload" : ""}</div>`;
    } else {
      head = `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>${sub ? `<div class="stmt-line-sub">${sub}</div>` : ""}`;
    }
    let controls = "";
    if (it.choices) {
      controls = `<div class="stmt-choices">${it.choices.map(([k, label]) =>
        `<button type="button" class="stmt-choice ${chosen === k ? "on" : ""}" data-item="${escapeHtml(it.id)}" data-choice="${k}">${chosen === k ? "✓ " : ""}${escapeHtml(label)}</button>`).join("")}`;
      if ((it.kind === "purchase" || it.kind === "income") && chosen === "add") {
        const cur = review.cat.has(it.id) ? review.cat.get(it.id) : ((l.suggestion && l.suggestion.categoryId) || "");
        const cats = it.kind === "income" ? (review.analysis.income_categories || []) : review.analysis.categories;
        controls += `<select class="stmt-cat" data-item="${escapeHtml(it.id)}"><option value="">No category (decide later)</option>${cats.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === cur ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>`;
      }
      if (it.kind === "reversal" && chosen === "cancel" && l.reversal.candidates.length > 1) {
        const cur = review.cancelEntry.get(it.id) || (l.reversal.candidates.find((c) => c.sameMonth) || l.reversal.candidates[0]).entry.id;
        controls += `<select class="stmt-cancel" data-item="${escapeHtml(it.id)}">${l.reversal.candidates.map((c) => `<option value="${escapeHtml(c.entry.id)}" ${c.entry.id === cur ? "selected" : ""}>${escapeHtml(entryPlain(c.entry))} (${escapeHtml(c.entry.status)})</option>`).join("")}</select>`;
      }
      controls += "</div>";
    }
    return `<div class="stmt-line2">${head}${controls}</div>`;
  }

  function selectedActions() {
    const actions = [];
    review.items.forEach((it) => {
      const choice = review.sel.get(it.id);
      if (choice && it.build) {
        if (choice === "match" && (it.kind === "purchase" || it.kind === "income") && !review.matchEntry.get(it.id)) return; // no entry picked yet
        actions.push(it.build(choice, review));
      } else if (it.auto) actions.push(it.auto());
    });
    return actions;
  }

  function summarize(actions) {
    const n = (t) => actions.filter((a) => a.type === t).length;
    const parts = [];
    if (n("record_transfer")) parts.push(`${n("record_transfer")} transfer${n("record_transfer") === 1 ? "" : "s"} between your accounts`);
    if (n("record_fee")) parts.push(`${n("record_fee")} bank fee${n("record_fee") === 1 ? "" : "s"}`);
    if (n("cancel_charge")) parts.push(`${n("cancel_charge")} charge${n("cancel_charge") === 1 ? "" : "s"} cancelled by a pending negative expense`);
    if (n("add_income")) parts.push(`${n("add_income")} income entr${n("add_income") === 1 ? "y" : "ies"} added as pending`);
    if (n("add_purchase")) parts.push(`${n("add_purchase")} purchase${n("add_purchase") === 1 ? "" : "s"} added as pending`);
    if (n("complete_transfer")) parts.push(`${n("complete_transfer")} transfer${n("complete_transfer") === 1 ? "" : "s"} completed`);
    if (n("assign_account")) parts.push(`the account set on ${n("assign_account")} existing entr${n("assign_account") === 1 ? "y" : "ies"}`);
    const matched = actions.filter((a) => a.type === "match").length;
    if (matched) parts.push(`${matched} line${matched === 1 ? "" : "s"} matched to existing entries`);
    if (n("set_balance")) parts.push(`the balance set from the statement on ${n("set_balance")} account${n("set_balance") === 1 ? "" : "s"}`);
    if (n("ignore")) parts.push(`${n("ignore")} line${n("ignore") === 1 ? "" : "s"} ignored`);
    if (n("wait")) parts.push(`${n("wait")} left waiting for the other statement`);
    return parts;
  }

  function renderReview(analysis) {
    if (!review || review.analysis !== analysis) {
      review = { analysis, items: buildItems(analysis), sel: new Map(), cat: new Map(), cancelEntry: new Map(), matchEntry: new Map(), matchEntryText: new Map(), open: new Map() };
    }
    const out = $("statement-review");
    const by = (kind) => review.items.filter((i) => i.kind === kind);
    const html = (kind) => by(kind).map(itemHtml);
    const c = analysis.counts;
    const actions = selectedActions();
    const chosenCount = actions.filter((a) => a.type !== "link").length;
    const summary = summarize(actions);
    out.innerHTML = `
      <p class="stmt-verdict good">${c.lines} lines · ${c.matched + c.completes} already in the app · ${c.handled} handled before · ${c.unregistered} not there yet</p>
      <div class="stmt-quick">
        <button type="button" class="stmt-choice" id="stmt-apply-suggested">✨ Apply suggested</button>
        <button type="button" class="stmt-choice" id="stmt-ignore-income">Ignore income except interest</button>
        <button type="button" class="stmt-choice" id="stmt-ignore-people">Ignore payments to people under 50</button>
      </div>
      <p class="hint">"Apply suggested" selects the safe ones: transfers, fees, completing transfers, setting accounts, and reversals (which still land as pending entries). Purchases and possible matches are always your call. Nothing is saved until you press Save.</p>
      ${group("Balance check", html("balance"), "The statement's closing balance against what the app says at that date. Your newest registered balance always wins over an older statement.", true, "balance")}
      ${group("Transfers between your accounts", html("pair"), "Each is ONE transfer (money moving between two of your accounts), not an expense or income.", true, "pair")}
      ${group("Completes a transfer you already recorded", html("completes"), "You recorded one end of these transfers earlier; this statement is the other end.", true, "completes")}
      ${group("Bank fees", html("fee"), "Small taxes and card insurance — filed under Bank fees.", true, "fee")}
      ${group("Purchases not in the app", html("purchase"), "Add = a pending entry in your review queue. Match… = this line IS an entry you already have.", true, "purchase")}
      ${group("Possible matches to confirm", html("possible"), "", true, "possible")}
      ${group("Waiting for the other statement", html("waiting"), "These look like money moving between accounts, but the other account's statement isn't here.", true, "waiting")}
      ${group("Matched entries that have no account yet", html("assign"), "These entries match a statement line but don't say which account they were paid with.", false, "assign")}
      ${group("Reversals and refunds", html("reversal"), "Money back on a card. In the same month it cancels the charge (a pending negative expense); from an earlier month it becomes pending Refunds income. Either way it waits in your review queue.", true, "reversal")}
      ${group("Income lines", html("income"), "Mostly repayments you don't register — Ignore remembers that. Add as income is for things like interest earned (it lands as a pending entry).", true, "income")}
      ${group("Handled before", html("handled"), "", false, "handled")}
      ${group("Already in the app", html("matched"), "", false, "matched")}
      <div class="stmt-savebar">
        <div class="stmt-save-summary">${summary.length ? escapeHtml(summary.join(" · ")) : "Nothing selected yet."}</div>
        <button type="button" class="primary" id="stmt-save-btn">${chosenCount ? `Save ${chosenCount} change${chosenCount === 1 ? "" : "s"}` : "Mark statements as processed"}</button>
      </div>`;
  }

  function rerender() { if (review) renderReview(review.analysis); }

  function toggleChoice(itemId, choice) {
    const it = review.items.find((i) => i.id === itemId);
    if (!it) return;
    if (review.sel.get(itemId) === choice) { review.sel.delete(itemId); rerender(); return; }
    if ((it.kind === "purchase" || it.kind === "income") && choice === "match") {
      pickEntryFor(it).then((e) => {
        if (!e) return;
        review.matchEntry.set(itemId, e.id);
        review.matchEntryText.set(itemId, entryPlain(e));
        review.sel.set(itemId, "match");
        rerender();
      });
      return;
    }
    review.sel.set(itemId, choice);
    rerender();
  }

  function entryPlain(e) {
    return `${fmtDate(e.date)} · ${e.description || "(no description)"} · ${fmtMoney(e.currency, e.amount)}`;
  }

  // "Match…" — pick which existing entry this statement line is.
  function pickEntryFor(it) {
    return new Promise(async (resolve) => {
      const backdrop = $("statement-match-backdrop");
      const list = $("statement-match-list");
      $("statement-match-title").textContent = `${fmtDate(it.line.date)} · ${it.line.description} · ${fmtMoney(it.line.currency, it.line.amount)}`;
      list.innerHTML = '<p class="hint">Looking for entries around that date…</p>';
      bringModalToFront_(backdrop);
      backdrop.hidden = false;
      const close = (val) => { backdrop.hidden = true; list.onclick = null; $("statement-match-cancel").onclick = null; resolve(val); };
      $("statement-match-cancel").onclick = () => close(null);
      let entries = [];
      try { entries = await callApi("getEntriesNear", { date: it.line.date, days: 10, currency: it.line.currency }); }
      catch (err) { list.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`; return; }
      if (!entries.length) { list.innerHTML = '<p class="hint">No entries in that currency within 10 days.</p>'; return; }
      list.innerHTML = entries.map((e, i) => `<button type="button" class="stmt-match-row" data-i="${i}">${entryText(e)}</button>`).join("");
      list.onclick = (ev) => { const b = ev.target.closest(".stmt-match-row"); if (b) close(entries[Number(b.dataset.i)]); };
    });
  }

  function applySuggested() {
    review.items.forEach((it) => {
      if (["pair", "completes", "fee", "assign"].includes(it.kind)) review.sel.set(it.id, it.choices[0][0]);
      else if (it.kind === "reversal") review.sel.set(it.id, it.suggested);
    });
    rerender();
  }
  // Interest is the one kind of income worth registering — leave those for the owner to decide.
  function ignoreIncome() { review.items.filter((i) => i.kind === "income" && !i.line.suggestion).forEach((it) => review.sel.set(it.id, "ignore")); rerender(); }
  function ignorePeople() {
    review.items.filter((i) => i.kind === "purchase" && isPeoplePayment(i.line) && Math.abs(i.line.amount) < 50).forEach((it) => review.sel.set(it.id, "ignore"));
    rerender();
  }

  function buildSavePayload(dryRun) {
    return {
      dryRun,
      filename: `Statements ${usable.map((u) => u.file).join(", ")}`.slice(0, 200),
      statements: usable.map(({ file, result }) => ({
        key: accountKeyOf(result), kind: result.kind, period: result.period, file_name: file,
        verified: !!(result.ok && result.verified !== false), balances: result.balances,
        lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section }))
      })),
      inboxIds: usable.map((u) => u.inboxId).filter(Boolean),
      actions: selectedActions()
    };
  }

  async function saveReview() {
    const btn = $("stmt-save-btn");
    const status = $("statement-review-status");
    const actions = selectedActions();
    const parts = summarize(actions);
    const msg = (parts.length ? "This will:\n • " + parts.join("\n • ") : "This will only mark these statements as processed.") +
      "\n\nEverything can be undone in one step afterwards. Continue?";
    if (!confirm(msg)) return;
    btn.disabled = true;
    status.innerHTML = '<p class="hint">Saving…</p>';
    try {
      const check = await callApi("applyStatementDecisions", buildSavePayload(true)); // validates first, writes nothing
      if (check.warnings && check.warnings.length) status.innerHTML = `<p class="stmt-note warn">${escapeHtml(check.warnings.join(" "))}</p>`;
      const res = await callApi("applyStatementDecisions", buildSavePayload(false));
      lastBatchId = res.batchId;
      const made = res.created.transfers + res.created.fees + res.created.purchases + (res.created.income || 0) + (res.created.reversals || 0);
      status.innerHTML = `<div class="stmt-result"><p class="stmt-verdict good">✓ Saved</p>
        <p class="hint">${made} entr${made === 1 ? "y" : "ies"} created (${res.created.transfers} transfers, ${res.created.fees} fees, ${res.created.purchases} pending purchases, ${res.created.income || 0} pending income, ${res.created.reversals || 0} reversals), ${res.changed} existing entr${res.changed === 1 ? "y" : "ies"} updated, ${res.linesRemembered} lines remembered, ${res.statementsRecorded} statement${res.statementsRecorded === 1 ? "" : "s"} recorded as processed.</p>
        <button type="button" class="cancel-edit-btn" id="stmt-undo-btn">Undo this upload</button></div>`;
      $("statement-review").innerHTML = '<p class="hint">Saved. Press "Review" again to see these lines marked as handled.</p>';
      review = null;
      coverage = null;
      refreshStatementCoverage();
      refreshStatementBatches();
      refreshStatementInbox();
      refreshOtherScreens();
    } catch (err) {
      status.innerHTML = `<p class="stmt-verdict bad">✗ Nothing was saved</p><p class="hint">${escapeHtml(err.message)}</p>`;
      btn.disabled = false;
    }
  }

  // The review queue, entry list, "Programmed this month" card and balances live
  // in app.js and only reload when their own screen asks; reload them now so
  // what a save/undo just did shows up without restarting the app.
  function refreshOtherScreens() {
    ["refreshReviewQueue", "refreshEntryList", "refreshExpectedRecurring", "refreshBalances"].forEach((n) => {
      try { if (typeof window[n] === "function") { const r = window[n](); if (r && r.catch) r.catch(() => {}); } } catch (e) { /* best effort */ }
    });
  }

  async function undoBatch(batchId) {
    if (!confirm("Undo this upload? The entries it created are deleted, the changes it made are reverted, and its statements are un-marked as processed.")) return;
    try {
      const r = await callApi("undoStatementBatch", { batchId });
      $("statement-review-status").innerHTML = `<p class="stmt-verdict good">↩ Undone — ${r.deletedEntries} entries removed, ${r.reverted} changes reverted.</p>`;
      lastBatchId = null;
      review = null;
      $("statement-review").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementBatches();
      refreshOtherScreens();
    } catch (err) {
      alert("Couldn't undo: " + err.message);
    }
  }

  async function refreshStatementBatches() {
    const box = $("statement-batches");
    try {
      const batches = await callApi("listStatementBatches", {});
      box.innerHTML = batches.length ? batches.map((b) => `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(fmtDate(b.processed_at, true))}</div>
        <div class="stmt-row-sub">${escapeHtml(b.statements.join(", "))}</div>
        <div class="stmt-row-sub">${b.entriesCreated} entries created · ${b.entriesChanged} changed</div></div>
        <button type="button" class="cancel-edit-btn stmt-undo-row" data-batch="${escapeHtml(b.batchId)}" style="width:auto;padding:6px 12px;">Undo</button></div>`).join("") : '<p class="hint">No uploads yet.</p>';
    } catch (err) {
      box.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`;
    }
  }

  // exposed for testing in the browser
  window.__statements = { handleStatementFiles, readStatementFile, renderCoverage, renderReview, runReview, saveReview, selectedActions: () => selectedActions(), applySuggested, setCoverage: (c) => { coverage = c; } };

  // ---- wiring ----

  $("more-statements-btn").addEventListener("click", showStatementsScreen);
  $("statements-back-btn").addEventListener("click", () => showScreen("more"));
  $("statement-file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length) handleStatementFiles(files);
    e.target.value = ""; // lets the same file be picked again
  });
  $("statement-review-btn").addEventListener("click", runReview);
  $("statement-inbox-list").addEventListener("click", async (e) => {
    const open = e.target.closest(".stmt-inbox-open"), dis = e.target.closest(".stmt-inbox-dismiss");
    if (open) openInboxItem(open.dataset.id, open);
    else if (dis && confirm("Dismiss this statement? It disappears from the inbox (it is not deleted from your email).")) {
      try { await callApi("dismissStatement", { id: dis.dataset.id }); } catch (err) { alert("Couldn't dismiss: " + err.message); }
      refreshStatementInbox(); refreshStatementCoverage();
    }
  });
  $("statement-review").addEventListener("click", (e) => {
    if (!review) return;
    const t = e.target;
    const btn = t.closest("button");
    if (!btn) return;
    if (btn.id === "stmt-apply-suggested") applySuggested();
    else if (btn.id === "stmt-ignore-income") ignoreIncome();
    else if (btn.id === "stmt-ignore-people") ignorePeople();
    else if (btn.id === "stmt-save-btn") saveReview();
    else if (btn.classList.contains("stmt-choice") && btn.dataset.item) toggleChoice(btn.dataset.item, btn.dataset.choice);
  });
  $("statement-review").addEventListener("change", (e) => {
    if (e.target.classList && e.target.classList.contains("stmt-cat") && review) review.cat.set(e.target.dataset.item, e.target.value);
    if (e.target.classList && e.target.classList.contains("stmt-cancel") && review) { review.cancelEntry.set(e.target.dataset.item, e.target.value); rerender(); }
  });
  $("statement-review").addEventListener("toggle", (e) => {
    if (review && e.target.dataset && e.target.dataset.gkey) review.open.set(e.target.dataset.gkey, e.target.open);
  }, true);
  $("statement-review-status").addEventListener("click", (e) => { if (e.target.id === "stmt-undo-btn" && lastBatchId) undoBatch(lastBatchId); });
  $("statement-batches").addEventListener("click", (e) => { const b = e.target.closest(".stmt-undo-row"); if (b) undoBatch(b.dataset.batch); });
  $("statement-password-ok").addEventListener("click", () => closeStatementPassword($("statement-password-input").value));
  $("statement-password-cancel").addEventListener("click", () => closeStatementPassword(null));
  $("statement-password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeStatementPassword($("statement-password-input").value);
  });
})();
