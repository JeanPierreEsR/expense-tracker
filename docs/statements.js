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
  // The password that last opened a statement, tried silently on the next ones (banks usually use one password for every
  // file) so a dozen statements need typing it once. Memory only: forgotten when this screen is left, never stored.
  let sessionPassword = null;

  // ---- helpers ----

  function fmtDate(iso, withYear) {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return I18n.fmtMonthDay(d, withYear);
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
    sessionPassword = null;
    document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-statements"; });
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.screen === "more");
    });
    refreshStatementCoverage();
    refreshStatementGaps();
    refreshStatementBatches();
    refreshStatementInbox();
  }

  // ---- inbox (statements that arrived by email) ----

  let inbox = [];

  async function refreshStatementInbox() {
    const list = $("statement-inbox-list");
    list.innerHTML = `<p class="hint">${escapeHtml(tr("common.loading"))}</p>`;
    try { inbox = (await callApi("listStatementInbox", {})).items; }
    catch (err) { list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; return; }
    if (!inbox.length) { list.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.inboxEmpty"))}</p>`; return; }
    const waitingCount = inbox.filter((i) => i.status === "new").length;
    const openAll = waitingCount > 1
      ? `<div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-inbox-open-all">${escapeHtml(tr("stmt.openAll", { n: waitingCount }))}</button></div>`
      : "";
    list.innerHTML = openAll + inbox.map((i) => {
      const done = i.status === "processed";
      const note = done ? tr("stmt.processed") : (i.probably_processed ? tr("stmt.probablyProcessed", { date: fmtDate(i.last_processed, true) }) : tr("stmt.notProcessed"));
      return `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(tr("stmt.received", { bank: i.bank, date: fmtDate(i.received, true) }))}</div>
        <div class="stmt-row-sub">${escapeHtml(note)} · ${i.size_kb} KB</div>
        <div class="stmt-choices" style="padding-left:0">
          <button type="button" class="stmt-choice stmt-inbox-open" data-id="${escapeHtml(i.id)}">${escapeHtml(tr("stmt.open"))}</button>
          ${done ? "" : `<button type="button" class="stmt-choice stmt-inbox-dismiss" data-id="${escapeHtml(i.id)}">${escapeHtml(tr("stmt.dismiss"))}</button>`}
        </div></div></div>`;
    }).join("");
  }

  // Fetches one inbox statement from Gmail and reads it (asks its password). Throws on failure.
  async function fetchAndReadInboxItem(id) {
    const att = await callApi("getStatementAttachment", { id });
    const bin = atob(att.base64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const file = new File([bytes], att.name, { type: "application/pdf" });
    file.inboxId = id;
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    await readStatementFile(file);
  }

  async function openInboxItem(id, btn) {
    if (!inbox.find((i) => i.id === id)) return;
    btn.disabled = true; btn.textContent = tr("stmt.fetching");
    try {
      await fetchAndReadInboxItem(id);
      $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      alert(tr("stmt.fetchFailed", { error: err && err.message ? err.message : err }));
    }
    btn.disabled = false; btn.textContent = tr("stmt.open");
  }

  // Opens every statement still waiting in the inbox, one after another (easy on a phone's memory;
  // each asks its own password). One that fails to fetch is reported at the end, the rest continue.
  async function openAllInboxItems(btn) {
    const waiting = inbox.filter((i) => i.status === "new");
    if (!waiting.length) return;
    const label = btn.textContent;
    btn.disabled = true;
    const failed = [];
    for (let n = 0; n < waiting.length; n++) {
      btn.textContent = tr("stmt.openingN", { i: n + 1, n: waiting.length });
      try { await fetchAndReadInboxItem(waiting[n].id); }
      catch (err) { failed.push(`${waiting[n].bank} (${waiting[n].received}): ${err && err.message ? err.message : err}`); }
    }
    btn.disabled = false; btn.textContent = label;
    $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failed.length) alert(tr("stmt.fetchFailedList") + "\n" + failed.join("\n"));
  }

  // ---- gaps (notes saved when a balance is set from a statement) ----

  async function refreshStatementGaps() {
    const list = $("statement-gaps-list");
    list.innerHTML = `<p class="hint">${escapeHtml(tr("common.loading"))}</p>`;
    let res;
    try { res = await callApi("listStatementGaps", {}); }
    catch (err) { list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; return; }
    if (!res.gaps.length) { list.innerHTML = `<p class="hint">${escapeHtml(tr("gaps.empty"))}</p>`; return; }
    list.innerHTML = res.gaps.map((g) => {
      const open = g.status === "open";
      const what = tr(g.gap < 0 ? "gaps.less" : "gaps.more", { amount: fmtMoney(g.currency, Math.abs(g.gap)) });
      const compare = g.app_balance === null ? "" : tr("gaps.compare", { closing: fmtMoney(g.currency, g.closing), app: fmtMoney(g.currency, g.app_balance) });
      const resolvedLine = open ? "" : [tr("gaps.resolvedOn", { date: fmtDate(g.resolved_at, true) }), g.note].filter(Boolean).join(" · ");
      return `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(tr("gaps.rowTitle", { account: g.account_label, date: fmtDate(g.period_end, true) }))}</div>
        <div class="stmt-row-sub">${escapeHtml(what)}</div>
        ${compare ? `<div class="stmt-row-sub">${escapeHtml(compare)}</div>` : ""}
        ${resolvedLine ? `<div class="stmt-row-sub">${escapeHtml(resolvedLine)}</div>` : ""}
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-gap-toggle" data-id="${escapeHtml(g.id)}" data-open="${open ? "1" : ""}">${escapeHtml(tr(open ? "gaps.resolve" : "gaps.reopen"))}</button></div>
      </div><span class="stmt-chip ${open ? "warn" : "resolved"}">${escapeHtml(signed(g.currency, g.gap))}</span></div>`;
    }).join("");
  }

  async function toggleGap(id, isOpen, btn) {
    const payload = { id, resolved: isOpen };
    if (isOpen) {
      const note = prompt(tr("gaps.notePrompt"), "");
      if (note === null) return;           // cancelled
      payload.note = note;
    }
    btn.disabled = true;
    try { await callApi("resolveStatementGap", payload); }
    catch (err) { alert(tr("gaps.failed", { error: err.message })); }
    coverage = null;
    refreshStatementGaps();
    refreshStatementCoverage();
  }

  // ---- coverage list ----

  const STATUS_LABEL = {
    ok: ["✅", () => tr("stmt.statusOk")],
    due: ["🔴", () => tr("stmt.statusDue")],
    never: ["⚪", () => tr("stmt.statusNever")]
  };

  async function refreshStatementCoverage() {
    const list = $("statement-coverage-list");
    list.innerHTML = `<p class="hint">${escapeHtml(tr("common.loading"))}</p>`;
    try {
      coverage = await callApi("listStatementCoverage", {});
    } catch (err) {
      list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`;
      return;
    }
    renderCoverage();
  }

  function renderCoverage() {
    const list = $("statement-coverage-list");
    if (!coverage || !coverage.accounts.length) {
      list.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.noAccounts"))}</p>`;
      return;
    }
    list.innerHTML = coverage.accounts.map((a) => {
      const [icon, textFn] = STATUS_LABEL[a.status] || STATUS_LABEL.never;
      const text = textFn();
      const last = a.last
        ? tr("stmt.lastLine", { start: fmtDate(a.last.period_start), end: fmtDate(a.last.period_end, true), when: fmtDate(a.last.processed_at), unverified: a.last.verified ? "" : tr("stmt.unverified") })
        : tr("stmt.nothingProcessed");
      const next = a.next_expected ? tr("stmt.nextExpected", { date: fmtDate(a.next_expected) }) : "";
      return `<div class="stmt-row">
        <div class="stmt-row-main">
          <div class="stmt-row-title">${escapeHtml(a.label)}</div>
          <div class="stmt-row-sub">${escapeHtml(last)}</div>
          ${next ? `<div class="stmt-row-sub">${escapeHtml(next)}</div>` : ""}
          ${a.open_gaps ? `<div class="stmt-row-sub" style="color:#8a5300">${escapeHtml(tr("gaps.coverageOpen", { n: a.open_gaps }))}</div>` : ""}
        </div>
        <span class="stmt-chip ${a.status}">${a.inbox_waiting ? escapeHtml(tr("stmt.inInbox", { n: a.inbox_waiting })) : `${icon} ${escapeHtml(text)}`}</span>
      </div>`;
    }).join("");
  }

  // ---- pdf.js (loaded on first use) ----

  function loadPdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        const site = (p) => (window.etSiteUrl ? window.etSiteUrl(p) : p);   // vendor/ lives on the main site, one folder up from stable/
        s.src = `${site("vendor/pdfjs/pdf.min.js")}?v=${APP_VERSION}`;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${site("vendor/pdfjs/pdf.worker.min.js")}?v=${APP_VERSION}`;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromise = null; reject(new Error(tr("stmt.pdfLoadFailed"))); };
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
        ? tr("stmt.pwWrong")
        : tr("stmt.pwProtected");
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

  // ---- "Send this statement": a statement the app cannot read goes to the owner as TEXT, with the private details hidden ----
  // Friends' copies only (the owner's own banks are built in). The PDF and its password never leave the phone: this works on the rows the reader
  // already extracted (docs/statement-sample.js hides what it can, the person reads the whole text, and only then is it sent). The owner's backend
  // (StatementSamples.gs) hides digits and addresses a second time and keeps the text in the Sheet tab "Statement Samples".
  const ss_ = { rows: null, kind: "unrecognised", sending: false };
  const ssEl_ = (id) => $(id);
  function ssMsg_(t) { ssEl_("ss-msg").textContent = t || ""; }
  function ssStep_(n) { [1, 2, 3].forEach((i) => { ssEl_("ss-step-" + i).hidden = i !== n; }); ssMsg_(""); }
  function offerSample(body, rows, kind) {
    if (!rows || !rows.length || perfIsOwnerCopy_()) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-inline";
    btn.textContent = tr("stmtSample.offer");
    btn.addEventListener("click", () => openSampleModal(rows, kind));
    body.appendChild(btn);
  }
  function openSampleModal(rows, kind) {
    Object.assign(ss_, { rows, kind, sending: false });
    const backdrop = ssEl_("statement-sample-backdrop");
    I18n.applyStatic(backdrop);
    ssEl_("ss-bank").value = "";
    ssEl_("ss-hide").value = "";
    ssEl_("ss-name").value = perfShareState_().label || "";
    ssStep_(1);
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
  }
  function ssRedo() {
    const hide = ssEl_("ss-hide").value + "," + ssEl_("ss-name").value;   // the person's own first name is always hidden
    const text = StatementSample.rowsToText(ss_.rows, { hide });
    ssEl_("ss-preview").value = text;
    ssEl_("ss-size").textContent = tr("stmtSample.size", { chars: text.length.toLocaleString("en-US"), lines: text.split("\n").length.toLocaleString("en-US") });
  }
  ssEl_("ss-show").addEventListener("click", () => {
    if (!PerfShare.cleanLabel(ssEl_("ss-bank").value)) { ssMsg_(tr("stmtSample.bankMissing")); return; }
    ssEl_("ss-confirm").checked = false;
    ssEl_("ss-send").disabled = true;
    ssRedo();
    ssStep_(2);
  });
  ssEl_("ss-redo").addEventListener("click", ssRedo);
  ssEl_("ss-confirm").addEventListener("change", () => { ssEl_("ss-send").disabled = !ssEl_("ss-confirm").checked || ss_.sending; });
  ssEl_("ss-back").addEventListener("click", () => ssStep_(1));
  ssEl_("ss-close").addEventListener("click", () => { ssEl_("statement-sample-backdrop").hidden = true; });
  ssEl_("ss-done").addEventListener("click", () => { ssEl_("statement-sample-backdrop").hidden = true; });
  ssEl_("ss-send").addEventListener("click", async () => {
    if (ss_.sending || !ssEl_("ss-confirm").checked) return;
    ss_.sending = true;
    ssEl_("ss-send").disabled = true;
    ssMsg_(tr("bankSample.sending"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);   // a whole statement is a bigger upload than an e-mail
    try {
      // A plain fetch like the e-mail samples and the app-speed reports: no sign-in on the owner's copy, and no retry that could send it twice.
      const res = await fetch(perfReportUrl_(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "reportStatementSample", payload: {
          install: perfInstallId_(), label: PerfShare.cleanLabel(ssEl_("ss-name").value), bank: PerfShare.cleanLabel(ssEl_("ss-bank").value),
          kind: ss_.kind, text: ssEl_("ss-preview").value, language: I18n.getLang(), app: appRelease_()
        } }),
        signal: controller.signal
      });
      const json = await res.json();
      if (json && json.ok) { ssStep_(3); return; }
      ssMsg_(json && json.code === "sample_busy" ? tr("bankSample.tooMany") : tr("bankSample.sendFailed"));
    } catch (e) {
      ssMsg_(tr("bankSample.sendFailed"));
    } finally {
      clearTimeout(timer);
      ss_.sending = false;
      ssEl_("ss-send").disabled = !ssEl_("ss-confirm").checked;
    }
  });

  // ---- reading a file and showing the result ----

  function resultCardShell(fileName) {
    const card = document.createElement("div");
    card.className = "stmt-result";
    card.innerHTML = `<div class="stmt-result-name">${escapeHtml(fileName)}</div><div class="stmt-result-body"><p class="hint">${escapeHtml(tr("stmt.reading"))}</p></div>`;
    $("statement-results").prepend(card);
    return card.querySelector(".stmt-result-body");
  }

  function coverageNotes(result) {
    if (!coverage || !result.period || !result.period.end) return [];
    const acct = coverage.accounts.find((a) => a.key === accountKeyOf(result));
    const notes = [];
    if (!acct) {
      notes.push(["warn", escapeHtml(tr("stmt.noteNotTracked", { key: accountKeyOf(result) || tr("stmt.noteUnknown") }))]);
      return notes;
    }
    notes.push(["info", escapeHtml(tr("stmt.noteAccount", { label: acct.label }))]);
    const last = acct.last;
    if (!last) return notes;
    if (result.period.end === last.period_end) {
      notes.push(["warn", escapeHtml(tr("stmt.noteSamePeriod", { date: fmtDate(last.processed_at, true) }))]);
    } else if (result.period.end < last.period_end) {
      notes.push(["warn", escapeHtml(tr("stmt.noteOlder", { date: fmtDate(last.period_end, true) }))]);
    } else {
      notes.push(["ok", escapeHtml(tr("stmt.noteNewer", { date: fmtDate(last.period_end, true) }))]);
      if (result.period.start && result.period.start > addDaysISO(last.period_end, 1)) {
        notes.push(["warn", escapeHtml(tr("stmt.noteGap", { from: fmtDate(addDaysISO(last.period_end, 1)), to: fmtDate(addDaysISO(result.period.start, -1)) }))]);
      }
    }
    return notes;
  }

  function renderResult(body, result, rows) {
    if (!result.kind) {
      body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.layoutUnknown"))}</p><p class="hint">${escapeHtml((result.errors || [tr("stmt.layoutUnsupported")])[0])}</p>`;
      offerSample(body, rows, "unrecognised");
      return;
    }
    let verdict;
    if (!result.ok) verdict = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.verdictBad"))}</p>`;
    else if (result.verified === false) verdict = `<p class="stmt-verdict warn">${escapeHtml(tr("stmt.verdictWarn"))}</p>`;
    else verdict = `<p class="stmt-verdict good">${escapeHtml(tr("stmt.verdictGood"))}</p>`;

    const notes = coverageNotes(result).map(([cls, msg]) => `<p class="stmt-note ${cls}">${msg}</p>`).join("");
    const period = result.period && result.period.end ? `${fmtDate(result.period.start, true)} – ${fmtDate(result.period.end, true)}` : "—";
    const balances = Object.entries(result.balances || {}).map(([cur, b]) => {
      const rows = [];
      if (b.opening !== null && b.opening !== undefined) rows.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.opening", { cur }))}</span><span>${escapeHtml(fmtMoney(cur, b.opening))}</span></div>`);
      if (b.closing !== null && b.closing !== undefined) rows.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.closing", { cur }))}</span><span>${escapeHtml(fmtMoney(cur, b.closing))}</span></div>`);
      return rows.join("");
    }).join("");
    const errors = (result.errors || []).slice(0, 6).map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    const lines = (result.lines || []).map((l) =>
      `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`
    ).join("");

    body.innerHTML = `${verdict}${notes}
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.period"))}</span><span>${escapeHtml(period)}</span></div>
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.linesRead"))}</span><span>${(result.lines || []).length}</span></div>
      ${balances}
      ${errors ? `<ul class="stmt-errors">${errors}</ul>` : ""}
      ${lines ? `<details class="stmt-lines"><summary>${escapeHtml(tr("stmt.showLines", { n: (result.lines || []).length }))}</summary>${lines}</details>` : ""}`;
    if (!result.ok) offerSample(body, rows, "unverified");   // a layout we know but cannot make add up: the owner wants to see it too
  }

  async function readStatementFile(file) {
    const body = resultCardShell(file.name);
    let cancelled = false;
    let triedSession = false, asked = false, typed = null;
    try {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const rows = await StatementParsers.readPdfRows(pdfjs, data, {
        onPassword: async (reason) => {
          // First ask of this file: the password that opened the last one, without bothering the person.
          if (!triedSession && sessionPassword !== null) { triedSession = true; return sessionPassword; }
          // The silent try failing is not the person's mistake, so the first prompt reads "protected", not "didn't work".
          const pw = await askStatementPassword(file.name, triedSession && !asked ? 1 : reason);
          asked = true;
          if (pw === null) cancelled = true; else typed = pw;
          return pw;
        }
      });
      if (typed !== null) sessionPassword = typed;   // it opened the file, so it is worth trying on the next one
      const result = StatementParsers.parseStatement(rows);
      renderResult(body, result, rows);
      if (result.kind && result.ok) {
        // A re-read of the same file replaces its earlier reading.
        usable = usable.filter((u) => u.file !== file.name);
        usable.push({ file: file.name, result, inboxId: file.inboxId || "" });
        // The review's statement/line numbers refer to THIS list — any change makes an open review stale.
        const hadReview = !!review;
        review = null;
        historyPlan = null;
        $("statement-history").innerHTML = "";
        // Only a comparison that was open needs telling that it is out of date; to someone who has not compared anything it is noise.
        $("statement-review").innerHTML = hadReview ? `<p class="hint">${escapeHtml(tr("stmt.changedPressReview"))}</p>` : "";
        updateReviewButton();
      }
    } catch (err) {
      if (cancelled) body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("stmt.skippedNoPw"))}</p>`;
      else body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
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
    $("statement-review-btn").textContent = tr("stmt.reviewButton", { n: usable.length });
    $("statement-review-hint").textContent = tr("stmt.reviewHint");
  }

  // What the server is sent for an analysis (never the file): each statement's account key, period, balances and lines.
  function statementsForAnalysis() {
    return usable.map(({ result }) => ({
      key: accountKeyOf(result),
      kind: result.kind,
      period: result.period,
      balances: result.balances,
      verified: !!(result.ok && result.verified !== false),
      lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section }))
    }));
  }

  // ---- "Fill my history": one approval for everything, no per-line choices (backend/StatementHistory.gs) ----

  let historyPlan = null;   // { actions, summary } from planStatementHistory, for the statements read right now

  async function runHistoryPlan() {
    const btn = $("statement-history-btn");
    const out = $("statement-history");
    btn.disabled = true;
    out.innerHTML = `<p class="hint">${escapeHtml(tr("hist.planning"))}</p>`;
    try {
      historyPlan = await callApi("planStatementHistory", { statements: statementsForAnalysis() });
      historyPlan.chosen = new Map();      // index into summary.aside -> "cash" (spending/income) or "transfer", what the person counted after all
      historyPlan.exchanges = [];          // lines linked as a currency exchange: { out: {stmt, line}, in: {stmt, line} }
      historyPlan.openGroups = new Set();  // groups of similar lines whose individual lines are showing
      historyPlan.asideOpen = false;
      renderHistoryPlan();
    } catch (err) {
      historyPlan = null;
      out.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("hist.planFailed"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  function moneyTotals(spent) {
    return Object.keys(spent).sort().map((cur) => fmtMoney(cur, spent[cur])).join(" + ");
  }

  // ---- the plan's actions, with the person's choices applied ----
  // A set-aside line counted after all replaces its "wait" (if it had one) with the action that imports it; two lines linked
  // as a currency exchange lose whatever action they had and become one `record_exchange`.
  function lineKey(ref) { return `${ref.stmt}:${ref.line}`; }
  function linkedKeys() {
    const linked = {};
    historyPlan.exchanges.forEach((x) => { linked[lineKey(x.out)] = true; linked[lineKey(x.in)] = true; });
    return linked;
  }

  function historyActions() {
    const p = historyPlan, aside = p.summary.aside || [];
    const linked = linkedKeys();
    const taken = {};
    p.chosen.forEach((mode, i) => { taken[lineKey(aside[i])] = true; });
    const kept = p.actions.filter((a) => {
      if (a.stmt === undefined) return true;                 // a transfer pair carries out/in instead of stmt/line
      const k = lineKey(a);
      return !linked[k] && !(a.type === "wait" && taken[k]);
    });
    const optIns = [];
    p.chosen.forEach((mode, i) => {
      const action = mode === "transfer" ? aside[i].optInTransfer : aside[i].optIn;
      if (action && !linked[lineKey(action)]) optIns.push(action);
    });
    const exchanges = p.exchanges.map((x) => ({ type: "record_exchange", out: { stmt: x.out.stmt, line: x.out.line }, in: { stmt: x.in.stmt, line: x.in.line } }));
    return kept.concat(optIns, exchanges);
  }

  // What the summary shows, worked out from the final list of actions so it always matches what will be saved.
  function historyCounts() {
    const c = { expenses: 0, income: 0, refunds: 0, transfers: 0, legs: 0, exchanges: 0, fees: 0, linked: 0, spent: {} };
    historyActions().forEach((a) => {
      if (a.type === "add_history_expense") {
        const l = usable[a.stmt].result.lines[a.line];
        c.expenses++;
        c.spent[l.currency] = Math.round(((c.spent[l.currency] || 0) + Math.abs(l.amount)) * 100) / 100;
      } else if (a.type === "add_history_income") c.income++;
      else if (a.type === "add_history_reversal") c.refunds++;
      else if (a.type === "record_transfer") c.transfers++;
      else if (a.type === "record_transfer_leg") c.legs++;
      else if (a.type === "record_exchange") c.exchanges++;
      else if (a.type === "record_fee") c.fees++;
      else if (["link", "assign_account", "complete_transfer"].includes(a.type)) c.linked++;
    });
    c.entries = c.expenses + c.income + c.refunds + c.transfers + c.legs + 2 * c.exchanges + c.fees;
    return c;
  }

  // ---- currency exchange: two lines in different currencies recorded as an exchange, not an expense and an income ----

  function pairTitle(out, inn) { return `${fmtMoney(out.currency, Math.abs(out.amount))} → ${fmtMoney(inn.currency, inn.amount)}`; }
  function pairSub(out, inn) {
    return `${escapeHtml(fmtDate(out.date))} “${escapeHtml(out.description)}” · ${escapeHtml(out.account)} / ${escapeHtml(fmtDate(inn.date))} “${escapeHtml(inn.description)}” · ${escapeHtml(inn.account)}`;
  }
  function candidateAt(ref) { return historyPlan.summary.candidates.find((c) => c.stmt === ref.stmt && c.line === ref.line); }

  function exchangeHtml() {
    const p = historyPlan, linked = linkedKeys();
    const suggestions = (p.summary.exchangeSuggestions || []).map((s, i) => ({ s, i })).filter(({ s }) => !linked[lineKey(s.out)] && !linked[lineKey(s.in)]);
    const done = p.exchanges.map((x, i) => {
      const o = candidateAt(x.out), n = candidateAt(x.in);
      return `<div class="stmt-line2"><div class="stmt-pair-title">${escapeHtml(pairTitle(o, n))}</div><div class="stmt-line-sub" style="padding-left:0">${pairSub(o, n)}</div>
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice on" data-xunlink="${i}">✓ ${escapeHtml(tr("hist.xch.unlink"))}</button></div></div>`;
    }).join("");
    const suggested = suggestions.map(({ s, i }) =>
      `<div class="stmt-line2"><div class="stmt-pair-title">${escapeHtml(pairTitle(s.out, s.in))}</div><div class="stmt-line-sub" style="padding-left:0">${pairSub(s.out, s.in)}</div>
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice" data-xlink="${i}">${escapeHtml(tr("hist.xch.link"))}</button></div></div>`).join("");
    const open = p.xchOpen === undefined ? (suggestions.length > 0 || p.exchanges.length > 0) : p.xchOpen;
    return `<details class="stmt-group" id="statement-history-xch" ${open ? "open" : ""}><summary>${escapeHtml(tr("hist.xch.title"))}${suggestions.length ? ` <span class="stmt-count">${suggestions.length}</span>` : ""}</summary>
      <p class="hint">${escapeHtml(tr("hist.xch.hint"))}</p>${done}${suggested}
      <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice" data-xmanual="1">${escapeHtml(tr("hist.xch.manual"))}</button></div></details>`;
  }

  // The picker: first the line where money left, then the line where it arrived in another currency.
  function openExchangePicker() {
    const p = historyPlan, linked = linkedKeys();
    const backdrop = $("statement-exchange-backdrop"), list = $("statement-exchange-list"), filter = $("statement-exchange-filter");
    let step = 1, out = null, shown = [];
    const close = () => { backdrop.hidden = true; list.onclick = null; filter.oninput = null; $("statement-exchange-cancel").onclick = null; };
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      let items = p.summary.candidates.filter((c) => !linked[lineKey(c)] && (step === 1 ? c.amount < 0 : (c.amount > 0 && c.currency !== out.currency)));
      if (q) items = items.filter((c) => `${c.description} ${c.account}`.toLowerCase().includes(q));
      if (step === 1) items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      else items.sort((a, b) => Math.abs(new Date(a.date) - new Date(out.date)) - Math.abs(new Date(b.date) - new Date(out.date)));
      shown = items.slice(0, 60);
      $("statement-exchange-title").textContent = tr(step === 1 ? "hist.xch.pickOut" : "hist.xch.pickIn");
      list.innerHTML = shown.length
        ? shown.map((c, i) => `<button type="button" class="stmt-match-row" data-i="${i}">${escapeHtml(fmtDate(c.date))} · ${escapeHtml(c.description)} · ${escapeHtml(fmtMoney(c.currency, c.amount))} · ${escapeHtml(c.account)}</button>`).join("")
        : `<p class="hint">${escapeHtml(tr("hist.xch.none"))}</p>`;
    };
    list.onclick = (ev) => {
      const b = ev.target.closest(".stmt-match-row");
      if (!b) return;
      const c = shown[Number(b.dataset.i)];
      if (step === 1) { out = c; step = 2; filter.value = ""; draw(); return; }
      p.exchanges.push({ out: { stmt: out.stmt, line: out.line }, in: { stmt: c.stmt, line: c.line } });
      p.xchOpen = true;
      close();
      renderHistoryPlan();
    };
    filter.oninput = draw;
    $("statement-exchange-cancel").onclick = close;
    filter.value = "";
    draw();
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
  }

  // ---- the set-aside lines: one row each, or one row for a run of similar lines (same wording, amount within 10%) ----
  // Each line can be counted as spending/income OR as a transfer (one side of it; the other end completes when that account's
  // statement arrives). `chosen` maps the line's index in summary.aside to "cash" or "transfer".

  function modeButton(attrs, on, label) {
    return `<button type="button" class="stmt-choice ${on ? "on" : ""}" ${attrs}>${on ? "✓ " : ""}${escapeHtml(label)}</button>`;
  }

  function asideHtml() {
    const p = historyPlan, aside = p.summary.aside || [], chosen = p.chosen;
    if (!aside.length) return "";
    const rendered = {};
    const rows = aside.map((a, i) => {
      const cashLabel = tr(a.amount > 0 ? "hist.aside.addIncome" : "hist.aside.addExpense");
      const maybe = a.maybe ? `<div class="stmt-line-sub" style="padding-left:0">${escapeHtml(tr("hist.aside.maybe", { entry: `${fmtDate(a.maybe.date)} · ${a.maybe.description || ""} · ${fmtMoney(a.maybe.currency, a.maybe.amount)}${a.maybe.account ? " · " + a.maybe.account : ""}` }))}</div>` : "";
      if (a.group) {
        if (rendered[a.group]) return "";
        rendered[a.group] = true;
        const members = aside.map((m, mi) => ({ m, mi })).filter(({ m }) => m.group === a.group);
        const allIn = (mode) => members.every(({ mi }) => chosen.get(mi) === mode);
        const amounts = members.map(({ m }) => Math.abs(m.amount));
        const sum = members.reduce((t, { m }) => t + m.amount, 0);
        const lo = Math.min(...amounts), hi = Math.max(...amounts);
        const range = lo === hi ? fmtMoney(a.currency, lo) : `${fmtMoney(a.currency, lo)} – ${fmtMoney(a.currency, hi).replace(/^[A-Z]{3} /, "")}`;
        const groupButtons = (a.optIn ? modeButton(`data-agroup="${a.group}" data-mode="cash"`, allIn("cash"), tr(a.amount > 0 ? "hist.aside.addAllIncome" : "hist.aside.addAllExpense", { n: members.length })) : "")
          + modeButton(`data-agroup="${a.group}" data-mode="transfer"`, allIn("transfer"), tr("hist.aside.addAllTransfer", { n: members.length }));
        // The same lines one by one, for a person who does not want them decided together: each has its own buttons.
        const each = members.map(({ m, mi }) => lineRow({ date: m.date, description: m.description, amount: m.amount, currency: m.currency },
          `<div class="stmt-choices" style="padding-left:0">${m.optIn ? modeButton(`data-aside="${mi}" data-mode="cash"`, chosen.get(mi) === "cash", cashLabel) : ""}${modeButton(`data-aside="${mi}" data-mode="transfer"`, chosen.get(mi) === "transfer", tr("hist.aside.addTransfer"))}</div>`)).join("");
        const opened = p.openGroups.has(a.group);
        return lineRow({ date: a.date, description: `${a.description} × ${members.length}`, amount: sum, currency: a.currency },
          `${escapeHtml(tr("hist.aside.groupSub", { n: members.length, amounts: range, account: a.account }))}<div class="stmt-choices" style="padding-left:0">${groupButtons}</div>
            <details data-gopen="${a.group}" ${opened ? "open" : ""}><summary class="hint">${escapeHtml(tr("hist.aside.showEach", { n: members.length }))}</summary>${each}</details>`);
      }
      const buttons = `<div class="stmt-choices" style="padding-left:0">${a.optIn ? modeButton(`data-aside="${i}" data-mode="cash"`, chosen.get(i) === "cash", cashLabel) : ""}${modeButton(`data-aside="${i}" data-mode="transfer"`, chosen.get(i) === "transfer", tr("hist.aside.addTransfer"))}</div>`;
      return lineRow({ date: a.date, description: a.description, amount: a.amount, currency: a.currency }, `${escapeHtml(a.account)}${maybe}${buttons}`);
    }).join("");
    return `<details class="stmt-group" id="statement-history-aside" ${p.asideOpen ? "open" : ""}><summary>${escapeHtml(tr("hist.aside.title", { n: aside.length }))}</summary>
      <p class="hint">${escapeHtml(tr("hist.aside.hint"))}</p>${rows}</details>`;
  }

  function renderHistoryPlan() {
    const out = $("statement-history");
    const { actions, summary } = historyPlan;
    const left = summary.leftOut, c = historyCounts();
    const lines = [];
    if (c.expenses) lines.push(tr("hist.sum.expenses", { n: c.expenses, total: moneyTotals(c.spent) }));
    if (c.income) lines.push(tr("hist.sum.income", { n: c.income }));
    if (c.refunds) lines.push(tr("hist.sum.refunds", { n: c.refunds }));
    if (c.transfers) lines.push(tr("hist.sum.transfers", { n: c.transfers }));
    if (c.legs) lines.push(tr("hist.sum.legs", { n: c.legs }));
    if (c.exchanges) lines.push(tr("hist.sum.exchanges", { n: c.exchanges }));
    if (c.fees) lines.push(tr("hist.sum.fees", { n: c.fees }));
    if (c.linked) lines.push(tr("hist.sum.linked", { n: c.linked }));
    const notes = [];
    if (left.fromPeople) notes.push(tr("hist.left.people", { n: left.fromPeople }));
    if (left.waiting) notes.push(tr("hist.left.waiting", { n: left.waiting }));
    if (left.possible) notes.push(tr("hist.left.possible", { n: left.possible }));
    if (left.noAccount) notes.push(tr("hist.left.noAccount", { n: left.noAccount, keys: summary.unknownAccounts.join(", ") }));
    if (left.handled) notes.push(tr("hist.left.handled", { n: left.handled }));
    const noteHtml = notes.map((t) => `<p class="stmt-note info">${escapeHtml(t)}</p>`).join("") + asideHtml() + (summary.candidates.length ? exchangeHtml() : "");
    if (!actions.length && !(summary.aside || []).length) {
      out.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>${noteHtml}`;
      return;
    }
    if (!c.entries) {
      // Nothing to add. Lines waiting for their other statement can still be remembered so they pair up later.
      out.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>${noteHtml}
        ${historyActions().length ? `<button type="button" class="stmt-choice" id="statement-history-save">${escapeHtml(tr("hist.remember"))}</button>` : ""}`;
      return;
    }
    const range = summary.from && summary.to ? `<p class="hint">${escapeHtml(tr("hist.range", { from: fmtDate(summary.from, true), to: fmtDate(summary.to, true) }))}</p>` : "";
    out.innerHTML = `<p class="stmt-verdict good">${escapeHtml(tr("hist.ready"))}</p>
      <ul style="list-style:disc;margin:6px 0;padding-left:20px">${lines.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      ${range}<p class="hint">${escapeHtml(tr("hist.noCategory"))}</p>${noteHtml}
      <button type="button" class="primary" id="statement-history-save">${escapeHtml(tr("hist.add"))}</button>`;
  }

  // Foreign-currency months the save created entries for that have no exchange rate of their own yet.
  function rateNeedsHtml(needs) {
    if (!needs || !needs.months || !needs.months.length) return "";
    const list = needs.months.map((m) => `${m.currency} ${I18n.fmtMonthYear(new Date(`${m.month}-01T00:00:00`))}`).join(", ");
    const none = needs.noRate && needs.noRate.length;
    return `<p class="stmt-note warn">${escapeHtml(tr(none ? "hist.rates.none" : "hist.rates.some", { list: none ? needs.noRate.join(", ") : list }))}</p>`;
  }

  async function saveHistory() {
    if (!historyPlan || !historyActions().length) return;
    const btn = $("statement-history-save");
    const status = $("statement-review-status");
    const adding = historyCounts().entries;
    if (!confirm(tr(adding ? "hist.confirm" : "hist.confirmKeep", { n: adding }) + "\n\n" + tr("stmt.confirmUndoable"))) return;
    btn.disabled = true;
    status.innerHTML = `<p class="hint">${escapeHtml(tr("hist.saving"))}</p>`;
    const payload = (dryRun) => ({
      dryRun,
      filename: `History ${usable.map((u) => u.file).join(", ")}`.slice(0, 200),
      statements: usable.map(({ file, result }) => ({
        key: accountKeyOf(result), kind: result.kind, period: result.period, file_name: file,
        verified: !!(result.ok && result.verified !== false), balances: result.balances,
        lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section }))
      })),
      inboxIds: usable.map((u) => u.inboxId).filter(Boolean),
      actions: historyActions()
    });
    try {
      await callApi("applyStatementDecisions", payload(true));   // validates first, writes nothing
      const res = await callApi("applyStatementDecisions", payload(false));
      lastBatchId = res.batchId;
      const made = res.created.transfers + res.created.fees + res.created.purchases + (res.created.income || 0) + (res.created.reversals || 0);
      status.innerHTML = `<div class="stmt-result"><p class="stmt-verdict good">${escapeHtml(made ? tr("hist.saved", { n: made }) : tr("stmt.saved"))}</p>
        ${rateNeedsHtml(res.rateNeeds)}
        <button type="button" class="cancel-edit-btn" id="stmt-undo-btn">${escapeHtml(tr("stmt.undoUpload"))}</button></div>`;
      historyPlan = null;
      $("statement-history").innerHTML = "";
      review = null;
      $("statement-review").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementGaps();
      refreshStatementBatches();
      refreshStatementInbox();
      refreshOtherScreens();
    } catch (err) {
      status.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.nothingSaved"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
      btn.disabled = false;
    }
  }

  async function runReview() {
    const btn = $("statement-review-btn");
    const out = $("statement-review");
    btn.disabled = true;
    out.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.comparing"))}</p>`;
    try {
      const analysis = await callApi("analyzeStatements", { statements: statementsForAnalysis() });
      review = null;
      renderReview(analysis);
    } catch (err) {
      out.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.compareFailed"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
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
      : (e.account ? escapeHtml(e.account) : escapeHtml(tr("stmt.noAccount")));
    return `${escapeHtml(fmtDate(e.date))} · ${escapeHtml(e.description || tr("review.noDescription"))} · ${escapeHtml(fmtMoney(e.currency, e.amount))}${e.category ? " · " + escapeHtml(e.category) : ""} · ${where}`;
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

  // The word the server stored for a line that was handled before, in the current language.
  function outcomeLabel_(outcome) {
    return ["added", "completed", "matched", "recorded", "reversed", "waiting", "ignored"].includes(outcome) ? tr("stmt.outcome." + outcome) : outcome;
  }

  function isPeoplePayment(l) { return /^(YAPE|PLIN)\b/i.test(String(l.description || "").trim()) || /^(YAPE|PLIN)[-.]/i.test(String(l.description || "")); }

  function buildItems(analysis) {
    const sts = analysis.statements;
    const acct = (si) => (sts[si].account ? sts[si].account.nickname : tr("stmt.unknownAccount", { key: sts[si].key }));
    const items = [];
    sts.forEach((st, si) => {
      st.lines.forEach((l, li) => {
        const where = acct(si);
        const id = `${si}:${li}`;
        const base = { id, si, li, line: l, where };
        if (l.status === "handled") { items.push({ ...base, kind: "handled" }); return; }
        if (l.status === "completes") {
          items.push({ ...base, kind: "completes", choices: [["complete", tr("stmt.choice.complete")]],
            build: () => ({ type: "complete_transfer", stmt: si, line: li, entryId: l.completesTransfer.entry.id, side: l.completesTransfer.side }) });
          return;
        }
        if (l.status === "matched") {
          if (l.entryHadNoAccount) {
            items.push({ ...base, kind: "assign", choices: [["assign", tr("stmt.choice.assign")]],
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
              choices: [["record", tr("stmt.choice.record")]],
              build: () => (thisIsOut
                ? { type: "record_transfer", out: { stmt: si, line: li }, in: { stored: pw.lineKey } }
                : { type: "record_transfer", out: { stored: pw.lineKey }, in: { stmt: si, line: li } }) });
          } else if (l.amount < 0) {
            items.push({ ...base, kind: "pair", outIsThis: true, partner: sts[pw.statement].lines[pw.line], partnerAcct: acct(pw.statement),
              choices: [["record", tr("stmt.choice.record")]],
              build: () => ({ type: "record_transfer", out: { stmt: si, line: li }, in: { stmt: pw.statement, line: pw.line } }) });
          }
          return;
        }
        if (l.guess === "fee") {
          items.push({ ...base, kind: "fee", choices: [["record", tr("stmt.choice.record")]], build: () => ({ type: "record_fee", stmt: si, line: li }) });
          return;
        }
        if (l.possible) {
          items.push({ ...base, kind: "possible", choices: [["match", tr("stmt.choice.yesSame")]],
            build: () => ({ type: "match", stmt: si, line: li, entryId: l.possible.entry.id, overwriteAccount: true }) });
          return;
        }
        if (l.waiting) {
          // It may really be an ordinary purchase (or income) the app mistook for a transfer: let the owner add it as one.
          const asIncome = l.amount > 0;
          items.push({ ...base, kind: "waiting",
            choices: [["wait", tr("stmt.choice.leaveWaiting")], ["add", tr(asIncome ? "stmt.choice.addIncome" : "stmt.choice.addExpense")], ["ignore", tr("stmt.choice.ignore")]],
            build: (choice, r) => {
              if (choice === "add") {
                const category = r.cat.get(id) !== undefined ? r.cat.get(id) : ((l.suggestion && l.suggestion.categoryId) || "");
                return { type: asIncome ? "add_income" : "add_purchase", stmt: si, line: li, category };
              }
              return { type: choice === "wait" ? "wait" : "ignore", stmt: si, line: li };
            } });
          return;
        }
        if (l.reversal) {
          const rv = l.reversal;
          const target = rv.candidates.find((c) => c.sameMonth) || rv.candidates[0] || null;
          const choices = [];
          if (rv.candidates.length) choices.push(["cancel", tr("stmt.choice.cancelCharge")]);
          choices.push(["refund", tr("stmt.choice.refundIncome")], ["ignore", tr("stmt.choice.ignore")]);
          items.push({ ...base, kind: "reversal", choices, suggested: target && target.sameMonth ? "cancel" : "refund",
            build: (choice, r) => {
              if (choice === "cancel") return { type: "cancel_charge", stmt: si, line: li, entryId: r.cancelEntry.get(id) || target.entry.id };
              if (choice === "refund") return { type: "add_income", stmt: si, line: li, category: rv.refundCategoryId, description: tr("stmt.refundPrefix") + l.description.replace(/^\s*REV\.?\s*/i, "") };
              return { type: "ignore", stmt: si, line: li };
            } });
          return;
        }
        if (l.guess === "income") {
          items.push({ ...base, kind: "income", choices: [["add", tr("stmt.choice.addIncome")], ["match", tr("stmt.choice.match")], ["ignore", tr("stmt.choice.ignore")]],
            build: (choice, r) => {
              if (choice === "add") return { type: "add_income", stmt: si, line: li, category: r.cat.has(id) ? r.cat.get(id) : ((l.suggestion && l.suggestion.categoryId) || "") };
              if (choice === "match") return { type: "match", stmt: si, line: li, entryId: r.matchEntry.get(id) };
              return { type: "ignore", stmt: si, line: li };
            } });
          return;
        }
        // a purchase not in the app
        items.push({ ...base, kind: "purchase", choices: [["add", tr("stmt.choice.add")], ["match", tr("stmt.choice.match")], ["ignore", tr("stmt.choice.ignore")]],
          build: (choice, r) => {
            if (choice === "add") return { type: "add_purchase", stmt: si, line: li, category: r.cat.get(id) !== undefined ? r.cat.get(id) : ((l.suggestion && l.suggestion.categoryId) || "") };
            if (choice === "match") return { type: "match", stmt: si, line: li, entryId: r.matchEntry.get(id) };
            return { type: "ignore", stmt: si, line: li };
          } });
      });
    });
    (analysis.balance_checks || []).forEach((c) => {
      items.push({ id: `bal:${c.stmt}:${c.currency}`, kind: "balance", check: c, where: acct(c.stmt),
        choices: c.canSet ? [["set", c.direction === "untracked" ? tr("stmt.choice.startTracking") : tr("stmt.choice.setBalance")]] : null,
        build: () => (c.direction === "forward" && typeof c.unexplained === "number" ? { type: "set_balance", stmt: c.stmt, currency: c.currency, gap: c.unexplained, app_balance: c.appAtEnd } : { type: "set_balance", stmt: c.stmt, currency: c.currency }) });
    });
    return items;
  }

  function signed(cur, n) {
    return `${cur} ${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function balanceHtml(it) {
    const c = it.check, chosen = review.sel.get(it.id);
    const lines = [`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balClosing", { date: fmtDate(c.end, true) }))}</span><span>${escapeHtml(fmtMoney(c.currency, c.closing))}</span></div>`];
    let verdict = "";
    if (c.direction === "untracked") {
      verdict = `<p class="stmt-note info">${escapeHtml(c.reason)}</p>`;
    } else {
      lines.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balInApp"))}</span><span>${escapeHtml(fmtMoney(c.currency, c.appAtEnd))}</span></div>`);
      lines.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balDiff"))}</span><span>${escapeHtml(signed(c.currency, c.diff))}</span></div>`);
      if (c.diff === 0) {
        verdict = `<p class="stmt-note ok">${escapeHtml(tr("stmt.balMatches"))}</p>`;
      } else if (c.direction === "forward") {
        const parts = [];
        if (c.notInApp.lines) parts.push(tr("stmt.balNotInApp", { amount: signed(c.currency, c.notInApp.net), n: c.notInApp.lines }));
        if (c.pending.lines) parts.push(tr("stmt.balPending", { amount: signed(c.currency, c.pending.net), n: c.pending.lines }));
        verdict = c.unexplained === 0
          ? `<p class="stmt-note ok">${escapeHtml(tr("stmt.balExplained", { parts: parts.join(tr("common.and")) }))}</p>`
          : `<p class="stmt-note warn">${parts.length ? escapeHtml(parts.join(tr("common.and"))) + ". " : ""}<b>${escapeHtml(tr("stmt.balUnexplainedBold", { amount: signed(c.currency, c.unexplained) }))}</b>${escapeHtml(tr("stmt.balUnexplainedRest"))}</p>`;
      } else if (c.direction === "backward") {
        verdict = `<p class="stmt-note info">${escapeHtml(tr("stmt.balBackward", { reason: c.reason, date: fmtDate(c.end) }))}</p>`;
      } else {
        verdict = `<p class="stmt-note info">${escapeHtml(c.reason)}</p>`;
      }
      if (c.canSet) verdict += `<p class="hint">${escapeHtml(tr("stmt.balCanSet", { reason: c.reason, date: fmtDate(c.end) }))}</p>`;
      if (c.canSet && c.direction === "forward" && c.unexplained) verdict += `<p class="hint">${escapeHtml(tr("gaps.willNote", { amount: signed(c.currency, c.unexplained) }))}</p>`;
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
      const fill = l.completesTransfer.side === "to" ? tr("stmt.fillTo") : tr("stmt.fillFrom");
      sub = tr("stmt.itemCompletes", { where, fill, entry: entryText(l.completesTransfer.entry) });
    } else if (it.kind === "assign") {
      sub = `${where} → ${entryText(l.entry)}`;
    } else if (it.kind === "fee") {
      sub = where;
    } else if (it.kind === "possible") {
      const why = l.possible.shareOf ? tr("stmt.possibleShare", { n: l.possible.shareOf }) : tr("stmt.possibleOther");
      sub = tr("stmt.itemPossible", { where, why, entry: entryText(l.possible.entry) });
    } else if (it.kind === "waiting") {
      sub = tr("stmt.itemWaiting", { where });
      if (l.suggestion) sub += " — " + tr("stmt.itemSuggestedShort", { cat: escapeHtml(l.suggestion.categoryName), reason: escapeHtml(l.suggestion.reason) });
    } else if (it.kind === "reversal") {
      const rv = l.reversal;
      sub = tr("stmt.itemReversal", { where });
      if (!rv.candidates.length) sub += tr("stmt.reversalNoCharge");
      else if (chosen === "cancel") {
        const cur = review.cancelEntry.get(it.id) || (rv.candidates.find((c) => c.sameMonth) || rv.candidates[0]).entry.id;
        sub += tr("stmt.reversalCancels", { entry: entryText(rv.candidates.find((c) => c.entry.id === cur).entry) });
      } else if (chosen === "refund") sub += tr("stmt.reversalRefund");
      else sub += tr("stmt.reversalBest", { entry: entryText(rv.candidates[0].entry), earlier: rv.candidates[0].sameMonth ? "" : tr("stmt.earlierMonth") });
    } else if (it.kind === "income") {
      sub = `${where}${l.suggestion ? " — " + tr("stmt.itemSuggestedShort", { cat: escapeHtml(l.suggestion.categoryName), reason: escapeHtml(l.suggestion.reason) }) : ""}`;
      if (chosen === "match" && review.matchEntry.has(it.id)) sub += tr("stmt.matchedTo", { text: escapeHtml(review.matchEntryText.get(it.id) || "") });
    } else if (it.kind === "purchase") {
      sub = `${where} — ${l.suggestion ? tr("stmt.itemSuggestedShort", { cat: escapeHtml(l.suggestion.categoryName), reason: escapeHtml(l.suggestion.reason) }) : tr("stmt.itemNoSuggestion")}`;
      if (chosen === "match" && review.matchEntry.has(it.id)) sub += tr("stmt.matchedTo", { text: escapeHtml(review.matchEntryText.get(it.id) || "") });
    } else if (it.kind === "handled") {
      const h = l.handled;
      sub = tr("stmt.itemHandled", { where, outcome: escapeHtml(outcomeLabel_(h.outcome)), entry: h.entry ? ": " + entryText(h.entry) : "" });
    } else if (it.kind === "matched") {
      sub = `${where} → ${entryText(l.entry)}${l.viaTotal ? escapeHtml(tr("stmt.viaTotal")) : ""}`;
    }
    let head;
    if (it.kind === "pair") {
      const fromAcct = it.outIsThis ? it.where : it.partnerAcct, toAcct = it.outIsThis ? it.partnerAcct : it.where;
      head = `<div class="stmt-pair-title">${escapeHtml(fromAcct)} → ${escapeHtml(toAcct)} · ${escapeHtml(fmtMoney(l.currency, Math.abs(l.amount)))}</div><div class="stmt-line-sub" style="padding-left:0">${escapeHtml(fmtDate(l.date))} “${escapeHtml(l.description)}” / ${escapeHtml(fmtDate(it.partner.date))} “${escapeHtml(it.partner.description)}”${it.fromEarlier ? escapeHtml(tr("stmt.otherHalf")) : ""}</div>`;
    } else {
      head = `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>${sub ? `<div class="stmt-line-sub">${sub}</div>` : ""}`;
    }
    let controls = "";
    if (it.choices) {
      controls = `<div class="stmt-choices">${it.choices.map(([k, label]) =>
        `<button type="button" class="stmt-choice ${chosen === k ? "on" : ""}" data-item="${escapeHtml(it.id)}" data-choice="${k}">${chosen === k ? "✓ " : ""}${escapeHtml(label)}</button>`).join("")}`;
      if ((it.kind === "purchase" || it.kind === "income" || it.kind === "waiting") && chosen === "add") {
        const cur = review.cat.has(it.id) ? review.cat.get(it.id) : ((l.suggestion && l.suggestion.categoryId) || "");
        const cats = l.amount > 0 ? (review.analysis.income_categories || []) : review.analysis.categories;
        controls += `<select class="stmt-cat" data-item="${escapeHtml(it.id)}"><option value="">${escapeHtml(tr("stmt.noCategory"))}</option>${cats.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === cur ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>`;
      }
      if (it.kind === "reversal" && chosen === "cancel" && l.reversal.candidates.length > 1) {
        const cur = review.cancelEntry.get(it.id) || (l.reversal.candidates.find((c) => c.sameMonth) || l.reversal.candidates[0]).entry.id;
        controls += `<select class="stmt-cancel" data-item="${escapeHtml(it.id)}">${l.reversal.candidates.map((c) => `<option value="${escapeHtml(c.entry.id)}" ${c.entry.id === cur ? "selected" : ""}>${escapeHtml(entryPlain(c.entry))} (${escapeHtml(statusLabel_(c.entry.status))})</option>`).join("")}</select>`;
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
    if (n("record_transfer")) parts.push(tr("stmt.sum.transfer", { n: n("record_transfer") }));
    if (n("record_fee")) parts.push(tr("stmt.sum.fee", { n: n("record_fee") }));
    if (n("cancel_charge")) parts.push(tr("stmt.sum.cancel", { n: n("cancel_charge") }));
    if (n("add_income")) parts.push(tr("stmt.sum.income", { n: n("add_income") }));
    if (n("add_purchase")) parts.push(tr("stmt.sum.purchase", { n: n("add_purchase") }));
    if (n("complete_transfer")) parts.push(tr("stmt.sum.complete", { n: n("complete_transfer") }));
    if (n("assign_account")) parts.push(tr("stmt.sum.assign", { n: n("assign_account") }));
    const matched = actions.filter((a) => a.type === "match").length;
    if (matched) parts.push(tr("stmt.sum.match", { n: matched }));
    if (n("set_balance")) parts.push(tr("stmt.sum.balance", { n: n("set_balance") }));
    if (n("ignore")) parts.push(tr("stmt.sum.ignore", { n: n("ignore") }));
    if (n("wait")) parts.push(tr("stmt.sum.wait", { n: n("wait") }));
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
      <p class="stmt-verdict good">${escapeHtml(tr("stmt.counts", { lines: c.lines, inApp: c.matched + c.completes, handled: c.handled, notYet: c.unregistered }))}</p>
      <div class="stmt-quick">
        <button type="button" class="stmt-choice" id="stmt-apply-suggested">${escapeHtml(tr("stmt.applySuggested"))}</button>
        <button type="button" class="stmt-choice" id="stmt-ignore-income">${escapeHtml(tr("stmt.ignoreIncome"))}</button>
        <button type="button" class="stmt-choice" id="stmt-ignore-people">${escapeHtml(tr("stmt.ignorePeople"))}</button>
      </div>
      <p class="hint">${escapeHtml(tr("stmt.quickHint"))}</p>
      ${group(tr("stmt.group.balance"), html("balance"), tr("stmt.group.balanceHint"), true, "balance")}
      ${group(tr("stmt.group.pair"), html("pair"), tr("stmt.group.pairHint"), true, "pair")}
      ${group(tr("stmt.group.completes"), html("completes"), tr("stmt.group.completesHint"), true, "completes")}
      ${group(tr("stmt.group.fee"), html("fee"), tr("stmt.group.feeHint"), true, "fee")}
      ${group(tr("stmt.group.purchase"), html("purchase"), tr("stmt.group.purchaseHint"), true, "purchase")}
      ${group(tr("stmt.group.possible"), html("possible"), "", true, "possible")}
      ${group(tr("stmt.group.waiting"), html("waiting"), tr("stmt.group.waitingHint"), true, "waiting")}
      ${group(tr("stmt.group.assign"), html("assign"), tr("stmt.group.assignHint"), false, "assign")}
      ${group(tr("stmt.group.reversal"), html("reversal"), tr("stmt.group.reversalHint"), true, "reversal")}
      ${group(tr("stmt.group.income"), html("income"), tr("stmt.group.incomeHint"), true, "income")}
      ${group(tr("stmt.group.handled"), html("handled"), "", false, "handled")}
      ${group(tr("stmt.group.matched"), html("matched"), "", false, "matched")}
      <div class="stmt-savebar">
        <div class="stmt-save-summary">${summary.length ? escapeHtml(summary.join(" · ")) : escapeHtml(tr("stmt.nothingSelected"))}</div>
        <button type="button" class="primary" id="stmt-save-btn">${escapeHtml(chosenCount ? tr("stmt.saveN", { n: chosenCount }) : tr("stmt.markProcessed"))}</button>
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
    return `${fmtDate(e.date)} · ${e.description || tr("review.noDescription")} · ${fmtMoney(e.currency, e.amount)}`;
  }

  // "Match…" — pick which existing entry this statement line is.
  function pickEntryFor(it) {
    return new Promise(async (resolve) => {
      const backdrop = $("statement-match-backdrop");
      const list = $("statement-match-list");
      $("statement-match-title").textContent = `${fmtDate(it.line.date)} · ${it.line.description} · ${fmtMoney(it.line.currency, it.line.amount)}`;
      list.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.lookingForEntries"))}</p>`;
      bringModalToFront_(backdrop);
      backdrop.hidden = false;
      const close = (val) => { backdrop.hidden = true; list.onclick = null; $("statement-match-cancel").onclick = null; resolve(val); };
      $("statement-match-cancel").onclick = () => close(null);
      let entries = [];
      try {
        entries = await callApi("getEntriesNear", {
          date: it.line.date, amount: it.line.amount, currency: it.line.currency,
          description: it.line.description, kind: it.kind
        });
      }
      catch (err) { list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; return; }
      if (!entries.length) { list.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.noEntriesMonth"))}</p>`; return; }
      // Backend order: the 10 most similar first (is_top), then everything else by date.
      const heading = (t) => `<p class="hint" style="margin:8px 0 4px;font-weight:600;">${t}</p>`;
      const topCount = entries.filter((e) => e.is_top).length;
      list.innerHTML = (topCount ? heading(escapeHtml(tr("paid.mostSimilar"))) : "") + entries.map((e, i) =>
        (topCount && i === topCount && entries.length > topCount ? heading(escapeHtml(tr("paid.allMonth"))) : "") +
        `<button type="button" class="stmt-match-row" data-i="${i}">${entryText(e)}</button>`).join("");
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
    const msg = (parts.length ? tr("stmt.confirmWill") + "\n • " + parts.join("\n • ") : tr("stmt.confirmOnly")) +
      "\n\n" + tr("stmt.confirmUndoable");
    if (!confirm(msg)) return;
    btn.disabled = true;
    status.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.saving"))}</p>`;
    try {
      const check = await callApi("applyStatementDecisions", buildSavePayload(true)); // validates first, writes nothing
      if (check.warnings && check.warnings.length) status.innerHTML = `<p class="stmt-note warn">${escapeHtml(check.warnings.join(" "))}</p>`;
      const res = await callApi("applyStatementDecisions", buildSavePayload(false));
      lastBatchId = res.batchId;
      const made = res.created.transfers + res.created.fees + res.created.purchases + (res.created.income || 0) + (res.created.reversals || 0);
      const savedParts = [
        tr("stmt.savedCreated", { n: made, t: res.created.transfers, f: res.created.fees, p: res.created.purchases, i: res.created.income || 0, r: res.created.reversals || 0 }),
        tr("stmt.savedUpdated", { n: res.changed }), tr("stmt.savedRemembered", { n: res.linesRemembered }), tr("stmt.savedRecorded", { n: res.statementsRecorded })];
      status.innerHTML = `<div class="stmt-result"><p class="stmt-verdict good">${escapeHtml(tr("stmt.saved"))}</p>
        <p class="hint">${escapeHtml(savedParts.join(", "))}.</p>
        <button type="button" class="cancel-edit-btn" id="stmt-undo-btn">${escapeHtml(tr("stmt.undoUpload"))}</button></div>`;
      $("statement-review").innerHTML = `<p class="hint">${escapeHtml(tr("stmt.savedPressReview"))}</p>`;
      review = null;
      historyPlan = null;
      $("statement-history").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementGaps();
      refreshStatementBatches();
      refreshStatementInbox();
      refreshOtherScreens();
    } catch (err) {
      status.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.nothingSaved"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
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
    if (!confirm(tr("stmt.confirmUndo"))) return;
    // Show that something is happening and stop a second tap: a second Undo running at the same time was never meant to be.
    const buttons = Array.from(document.querySelectorAll("#stmt-undo-btn, .stmt-undo-row"));
    buttons.forEach((b) => { b.disabled = true; });
    $("statement-review-status").innerHTML = `<p class="hint">${escapeHtml(tr("stmt.undoing"))}</p>`;
    try {
      const r = await callApi("undoStatementBatch", { batchId });
      $("statement-review-status").innerHTML = `<p class="stmt-verdict good">${escapeHtml(tr("stmt.undone", { n: r.deletedEntries, r: r.reverted }))}</p>`;
      lastBatchId = null;
      review = null;
      historyPlan = null;
      $("statement-history").innerHTML = "";
      $("statement-review").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementGaps();
      refreshStatementBatches();
      refreshOtherScreens();
    } catch (err) {
      // The server may still be working (or have stopped part-way): say so, and show what Recent uploads says now.
      $("statement-review-status").innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.undoFailed", { error: err.message }))}</p><p class="hint">${escapeHtml(tr("stmt.undoCheck"))}</p>`;
      buttons.forEach((b) => { b.disabled = false; });
      refreshStatementBatches();
      refreshOtherScreens();
    }
  }

  async function refreshStatementBatches() {
    const box = $("statement-batches");
    try {
      const batches = await callApi("listStatementBatches", {});
      box.innerHTML = batches.length ? batches.map((b) => `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(fmtDate(b.processed_at, true))}</div>
        <div class="stmt-row-sub">${escapeHtml(b.statements.join(", "))}</div>
        <div class="stmt-row-sub">${escapeHtml(tr("stmt.batchCounts", { n: b.entriesCreated, c: b.entriesChanged }))}</div></div>
        <button type="button" class="cancel-edit-btn stmt-undo-row" data-batch="${escapeHtml(b.batchId)}" style="width:auto;padding:6px 12px;">${escapeHtml(tr("stmt.undo"))}</button></div>`).join("") : `<p class="hint">${escapeHtml(tr("stmt.noUploads"))}</p>`;
    } catch (err) {
      box.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`;
    }
  }

  // exposed for testing in the browser
  window.__statements = { handleStatementFiles, readStatementFile, renderCoverage, renderReview, runReview, saveReview, runHistoryPlan, saveHistory, selectedActions: () => selectedActions(), applySuggested, setCoverage: (c) => { coverage = c; }, setUsable: (u) => { usable = u; historyPlan = null; updateReviewButton(); } };

  // ---- wiring ----

  $("more-statements-btn").addEventListener("click", showStatementsScreen);
  $("statements-back-btn").addEventListener("click", () => { sessionPassword = null; showScreen("more"); });
  $("statement-file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length) handleStatementFiles(files);
    e.target.value = ""; // lets the same file be picked again
  });
  $("statement-review-btn").addEventListener("click", runReview);
  $("statement-history-btn").addEventListener("click", runHistoryPlan);
  $("statement-history").addEventListener("click", (e) => {
    if (e.target.closest("#statement-history-save")) { saveHistory(); return; }
    if (!historyPlan) return;
    const one = e.target.closest("[data-aside]"), grp = e.target.closest("[data-agroup]");
    const link = e.target.closest("[data-xlink]"), unlink = e.target.closest("[data-xunlink]"), manual = e.target.closest("[data-xmanual]");
    const aside = historyPlan.summary.aside || [];
    if (one) {
      const i = Number(one.dataset.aside), mode = one.dataset.mode;
      if (historyPlan.chosen.get(i) === mode) historyPlan.chosen.delete(i); else historyPlan.chosen.set(i, mode);
    } else if (grp) {
      // One tap for a run of similar lines: all on in that way, or (when all already were) all off.
      const mode = grp.dataset.mode;
      const idx = aside.map((a, i) => (a.group === Number(grp.dataset.agroup) ? i : -1)).filter((i) => i >= 0);
      const allOn = idx.every((i) => historyPlan.chosen.get(i) === mode);
      idx.forEach((i) => { if (allOn) historyPlan.chosen.delete(i); else historyPlan.chosen.set(i, mode); });
    } else if (link) {
      const s = historyPlan.summary.exchangeSuggestions[Number(link.dataset.xlink)];
      historyPlan.exchanges.push({ out: { stmt: s.out.stmt, line: s.out.line }, in: { stmt: s.in.stmt, line: s.in.line } });
      historyPlan.xchOpen = true;
    } else if (unlink) {
      historyPlan.exchanges.splice(Number(unlink.dataset.xunlink), 1);
    } else if (manual) {
      openExchangePicker();
      return;
    } else {
      return;
    }
    renderHistoryPlan();
  });
  $("statement-history").addEventListener("toggle", (e) => {
    if (!historyPlan) return;
    if (e.target.id === "statement-history-aside") historyPlan.asideOpen = e.target.open;
    if (e.target.id === "statement-history-xch") historyPlan.xchOpen = e.target.open;
    if (e.target.dataset && e.target.dataset.gopen) {
      const g = Number(e.target.dataset.gopen);
      if (e.target.open) historyPlan.openGroups.add(g); else historyPlan.openGroups.delete(g);
    }
  }, true);
  $("statement-inbox-list").addEventListener("click", async (e) => {
    const open = e.target.closest(".stmt-inbox-open"), dis = e.target.closest(".stmt-inbox-dismiss"), all = e.target.closest(".stmt-inbox-open-all");
    if (all) openAllInboxItems(all);
    else if (open) openInboxItem(open.dataset.id, open);
    else if (dis && confirm(tr("stmt.confirmDismiss"))) {
      try { await callApi("dismissStatement", { id: dis.dataset.id }); } catch (err) { alert(tr("stmt.dismissFailed", { error: err.message })); }
      refreshStatementInbox(); refreshStatementCoverage();
    }
  });
  $("statement-gaps-list").addEventListener("click", (e) => {
    const b = e.target.closest(".stmt-gap-toggle");
    if (b) toggleGap(b.dataset.id, !!b.dataset.open, b);
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
