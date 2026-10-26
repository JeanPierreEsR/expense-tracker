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
  // Passwords that opened a statement, newest first. Each file tries them silently one by one before asking (banks usually use one
  // password for every file, and a person with two banks has two), so a dozen statements need typing it once. Memory only: forgotten
  // when this screen is left, never stored.
  let sessionPasswords = [];

  // ---- helpers ----

  function fmtDate(iso, withYear) {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return I18n.fmtMonthDay(d, withYear);
  }

  // Anything the app is working on shows this: a small spinning ring and what it is doing, in the place where the person tapped
  // (the same quiet look as the app's other "Loading…" and "Saving…" lines, plus the ring so it is clearly moving).
  function loadingHtml(text) {
    return `<div class="stmt-loading" role="status" aria-live="polite"><span class="stmt-spinner" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div>`;
  }
  function setBusy(btn, text) { btn.innerHTML = `<span class="stmt-spinner" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>${escapeHtml(text)}`; }

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
    if (result.accountKey) return result.accountKey;   // a spreadsheet: the person named the account
    if (result.kind === "ahorramas") return `AHORRA-${Object.keys(result.balances)[0]}`;
    return String((result.account && result.account.last4) || "");
  }

  // ---- screen navigation (same pattern as the other More sub-screens) ----

  // The Statements card and the Import data card open this one screen; `mode` ("bank" | "import") only changes what is shown
  // (the wording and the cards that are about bank e-mail) — the reading, the review and the saving are the same engine.
  let screenMode = "bank";

  function setScreenMode(mode) {
    screenMode = mode;
    $("screen-statements").dataset.mode = mode;
    $("statement-file-input").accept = mode === "import"
      ? ".csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/pdf,.pdf,.csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    updateReviewButton();
  }

  function showStatementsScreen(mode) {
    const next = mode === "import" ? "import" : "bank";
    if (next !== screenMode) {
      // A bank statement and another app's file never travel in the same upload: leaving one side clears what was read on it.
      clearRun();
      stepNow = 1;
    }
    setScreenMode(next);
    // A finished run starts over from step 1; a run still in progress keeps its step (the person may have only switched tabs).
    if (stepNow === 4 || !usable.length) { if (stepNow === 4) clearRun(); stepNow = 1; }
    pastOpen = false;
    sessionPasswords = [];
    batchesShown = BATCHES_FIRST;
    findFirstUse = null;   // decided again once the coverage list is in
    $("statement-find-card").hidden = !(typeof meta !== "undefined" && meta && meta.capabilities && meta.capabilities.bankEmails !== false);
    document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-statements"; });
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.screen === "more");
    });
    refreshStatementCoverage();
    refreshStatementGaps();
    refreshStatementBatches();
    refreshStatementInbox();
    renderSteps();
  }

  // ---- the four steps: Upload > Check > Preview > Done ----
  // One screen, four steps, one next button per step (owner's design, 2026-10-26). The reading, planning and saving engine below is
  // unchanged: the cards it uses are only regrouped into steps. A step is a plain <div id="stmt-step-N">; `stepNow` says which shows.
  // "Past uploads and differences" (Recent uploads + Gaps) is a side panel, not a step.
  let stepNow = 1;
  let pastOpen = false;
  let savedThisRun = false;   // a save (or an undo) happened in this run: step 4 has something to show

  function stmtCards() { return Array.from($("statement-results").children); }
  // Distinct statements that can go on to the preview (a spreadsheet may yield several entries in `usable`).
  function readyCount() { return new Set(usable.map((u) => u.group || u.file)).size; }

  function canGoTo(n) {
    if (n === 1) return true;
    if (n === 2) return stmtCards().length > 0;
    if (n === 3) return usable.length > 0;
    return savedThisRun;
  }

  function clearRun() {
    $("statement-results").innerHTML = "";
    $("statement-history").innerHTML = "";
    $("statement-plan-status").innerHTML = "";
    $("statement-review-status").innerHTML = "";
    $("stmt-s4-waiting").innerHTML = "";
    usable = [];
    historyPlan = null;
    addedAccounts = [];
    savedThisRun = false;
  }

  function showStep(n) {
    stepNow = n;
    pastOpen = false;
    renderSteps();
    window.scrollTo(0, 0);
    if (n === 3 && !historyPlan && usable.length) runHistoryPlan();   // the plan is read-only, so it is built on arrival: no extra button
    if (n === 4) renderWaiting();
  }

  function renderSteps() {
    const names = ["stmt.step.upload", "stmt.step.check", "stmt.step.preview", "stmt.step.done"];
    $("stmt-stepper").hidden = pastOpen;
    $("stmt-stepper").innerHTML = names.map((key, i) => {
      const n = i + 1;
      const cls = n === stepNow ? "on" : (n < stepNow ? "done" : "");
      const can = n === stepNow || canGoTo(n);
      return `<button type="button" class="stmt-pill ${cls}" data-step="${n}" ${can ? "" : "disabled"} aria-current="${n === stepNow ? "step" : "false"}">${n < stepNow ? "✓ " : `${n} `}${escapeHtml(tr(key))}</button>`;
    }).join("");
    [1, 2, 3, 4].forEach((n) => { $("stmt-step-" + n).hidden = pastOpen || n !== stepNow; });
    $("statement-past").hidden = !pastOpen;
    updateStepUi();
  }

  // Counts and buttons that depend on what was read so far.
  function updateStepUi() {
    const total = stmtCards().length, ready = readyCount();
    $("stmt-s2-count").textContent = total ? tr("stmt.s2.count", { ready, total }) + (ready < total ? " " + tr("stmt.s2.skipped") : "") : tr("stmt.s2.none");
    const next = $("stmt-next-2");
    next.hidden = !usable.length;
    next.textContent = tr("stmt.s2.next", { n: ready });
    const cont = $("stmt-step1-continue");
    cont.hidden = !total;
    cont.textContent = tr("stmt.s1.continue", { n: total });
    $("statement-history-btn").textContent = tr(screenMode === "import" ? "imp.histButton" : "hist.button", { n: usable.length });
    // pills that became (un)reachable
    document.querySelectorAll("#stmt-stepper .stmt-pill").forEach((b) => { const n = Number(b.dataset.step); b.disabled = !(n === stepNow || canGoTo(n)); });
  }

  // Step 4: the accounts that still need a statement (the coverage list, shortened to what is left to do).
  function renderWaiting() {
    const box = $("stmt-s4-waiting");
    const left = screenMode === "import" || !coverage ? [] : coverage.accounts.filter((a) => a.status === "due" || a.status === "never");
    box.innerHTML = left.length
      ? `<p class="stmt-s4-label">${escapeHtml(tr("stmt.s4.waiting"))}</p>` + left.map((a) => `<div class="stmt-row"><div class="stmt-row-main"><div class="stmt-row-title">${escapeHtml(a.label)}</div><div class="stmt-row-sub">${escapeHtml(tr(a.status === "due" ? "stmt.statusDue" : "stmt.statusNever"))}</div></div></div>`).join("")
      : "";
  }

  // ---- inbox (statements that arrived by email) ----

  let inbox = [];

  async function refreshStatementInbox() {
    const list = $("statement-inbox-list");
    list.innerHTML = `${loadingHtml(tr("common.loading"))}`;
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
  async function fetchAndReadInboxItem(id, sender) {
    const att = await callApi("getStatementAttachment", { id });
    const bin = atob(att.base64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const file = new File([bytes], att.name, { type: "application/pdf" });
    file.inboxId = id;
    const item = inbox.find((i) => i.id === id);
    file.senderAddress = sender !== undefined ? sender : ((item && item.sender) || "");
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    await readStatementFile(file);
  }

  async function openInboxItem(id, btn) {
    if (!inbox.find((i) => i.id === id)) return;
    btn.disabled = true; setBusy(btn, tr("stmt.fetching"));
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
      setBusy(btn, tr("stmt.openingN", { i: n + 1, n: waiting.length }));
      try { await fetchAndReadInboxItem(waiting[n].id); }
      catch (err) { failed.push(`${waiting[n].bank} (${waiting[n].received}): ${err && err.message ? err.message : err}`); }
    }
    btn.disabled = false; btn.textContent = label;
    $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failed.length) alert(tr("stmt.fetchFailedList") + "\n" + failed.join("\n"));
  }

  // ---- find statements in Gmail (on demand: pick a period, tick what to read) ----

  let found = [];   // last findStatementEmails result's items

  // Find statements is a catch-up tool: it is used once to bring in history (and again for a new bank or a gap), while new statements
  // arrive in the Inbox by themselves. So it is OPEN ("Start here") only while no statement was ever processed, and otherwise
  // a one-line link that opens it. It stays in its place in step 1 (after the Inbox and "From this phone"). Decided once per visit
  // (when the coverage list first arrives), so the card never jumps while the person is working.
  let findFirstUse = null;
  function placeFindCard() {
    if (findFirstUse !== null || !coverage || !coverage.accounts.length) return;
    findFirstUse = coverage.accounts.every((a) => !a.last);
    $("statement-find-start").hidden = !findFirstUse;
    $("statement-find-body").hidden = !findFirstUse;
    $("statement-find-toggle").hidden = findFirstUse;
    renderCoverage();   // the "look for older ones" links depend on this decision
  }
  function openFindCard() {
    $("statement-find-body").hidden = false;
    $("statement-find-toggle").hidden = true;
    $("statement-find-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function findStatements() {
    const btn = $("statement-find-btn"), out = $("statement-find-results");
    btn.disabled = true;
    out.innerHTML = loadingHtml(tr("find.searching"));
    try { found = (await callApi("findStatementEmails", { months: Number($("statement-find-months").value) })).items; }
    catch (err) { out.innerHTML = `<p class="hint">${escapeHtml(tr("find.failed", { error: err && err.message ? err.message : err }))}</p>`; btn.disabled = false; return; }
    btn.disabled = false;
    renderFound();
  }

  function renderFound() {
    const out = $("statement-find-results");
    if (!found.length) { out.innerHTML = `<p class="hint">${escapeHtml(tr("find.none"))}</p>`; return; }
    const groups = [];
    found.forEach((f, i) => {
      let g = groups.find((x) => x.sender === f.sender);
      if (!g) { g = { sender: f.sender, name: f.bank || f.sender_name || f.sender, known: f.known, items: [] }; groups.push(g); }
      g.items.push(Object.assign({ i }, f));
    });
    // Known banks first: those are the ones the app can read for sure.
    groups.sort((a, b) => (b.known ? 1 : 0) - (a.known ? 1 : 0));
    out.innerHTML = `<p class="hint">${escapeHtml(tr("find.found", { n: found.length }))} ${escapeHtml(tr("find.hintNote"))}</p><div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice" id="statement-find-all"></button></div>` + groups.map((g, gi) => {
      const rows = g.items.map((f) => `<label class="stmt-find-row">
        <input type="checkbox" class="stmt-find-pick" data-i="${f.i}" data-g="${gi}" checked>
        <span><strong>${escapeHtml(fmtDate(f.received, true))}</strong> · ${escapeHtml(f.attachment_name)} · ${f.size_kb} KB${f.status === "processed" ? ` · ${escapeHtml(tr("find.alreadyRead"))}` : ""}</span></label>`).join("");
      return `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(g.name)} <button type="button" class="add-inline stmt-find-group" data-g="${gi}"></button></div>
        <div class="stmt-row-sub">${escapeHtml(g.sender)} · ${escapeHtml(tr(g.known ? "find.known" : "find.unknown"))}</div>${rows}</div></div>`;
    }).join("") + `<div class="stmt-find-read-wrap"><button type="button" class="primary" id="statement-find-read"></button></div>`;
    updateFindReadButton();
  }

  function pickedFound() {
    return Array.from(document.querySelectorAll(".stmt-find-pick:checked")).map((el) => found[Number(el.dataset.i)]).filter(Boolean);
  }

  function updateFindReadButton() {
    const btn = $("statement-find-read");
    if (!btn || btn.dataset.busy) return;
    const n = pickedFound().length;
    const tg = $("statement-find-all");
    document.querySelectorAll(".stmt-find-group").forEach((b) => {
      const boxes = document.querySelectorAll(`.stmt-find-pick[data-g="${b.dataset.g}"]`);
      b.textContent = tr(Array.from(boxes).every((x) => x.checked) ? "find.deselectAll" : "find.selectAll");
    });
    if (tg) tg.textContent = tr(n === found.length ? "find.deselectAll" : "find.selectAll");
    btn.textContent = n ? tr("find.read", { n }) : tr("find.readNone");
    btn.disabled = !n;
  }

  // Ticked statements go into the inbox (so they are marked processed afterwards like any other), then are opened one after another:
  // the password that opened the first is tried silently on the rest.
  async function readPickedFound() {
    const picks = pickedFound(), btn = $("statement-find-read");
    if (!picks.length) return;
    btn.dataset.busy = "1"; btn.disabled = true; setBusy(btn, tr("find.adding"));
    let added;
    try { added = await callApi("addStatementsToInbox", { items: picks.map((p) => ({ message_id: p.message_id, attachment_name: p.attachment_name })) }); }
    catch (err) { delete btn.dataset.busy; updateFindReadButton(); alert(tr("find.addFailed", { error: err && err.message ? err.message : err })); return; }
    await refreshStatementInbox();
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    const failed = [];
    for (let n = 0; n < added.ids.length; n++) {
      setBusy(btn, tr("stmt.openingN", { i: n + 1, n: added.ids.length }));
      try { await fetchAndReadInboxItem(added.ids[n], (added.senders || {})[added.ids[n]] || ""); }
      catch (err) { failed.push(`${picks[n] ? picks[n].attachment_name : ""}: ${err && err.message ? err.message : err}`); }
    }
    delete btn.dataset.busy;
    updateFindReadButton();
    $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failed.length) alert(tr("stmt.fetchFailedList") + "\n" + failed.join("\n"));
  }

  $("statement-find-btn").addEventListener("click", findStatements);
  $("statement-find-toggle").addEventListener("click", openFindCard);
  $("statement-coverage-list").addEventListener("click", (e) => { if (e.target.closest(".stmt-older-link")) openFindCard(); });
  $("statement-find-results").addEventListener("change", (e) => { if (e.target.classList.contains("stmt-find-pick")) updateFindReadButton(); });
  $("statement-find-results").addEventListener("click", (e) => {
    if (e.target.id === "statement-find-read") readPickedFound();
    if (e.target.classList.contains("stmt-find-group")) {
      const boxes = document.querySelectorAll(`.stmt-find-pick[data-g="${e.target.dataset.g}"]`), all = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !all; });
      updateFindReadButton();
    }
    if (e.target.id === "statement-find-all") {
      const boxes = document.querySelectorAll(".stmt-find-pick"), all = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !all; });
      updateFindReadButton();
    }
  });

  // ---- gaps (notes saved when a balance is set from a statement) ----

  async function refreshStatementGaps() {
    const list = $("statement-gaps-list");
    list.innerHTML = `${loadingHtml(tr("common.loading"))}`;
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
    list.innerHTML = `${loadingHtml(tr("common.loading"))}`;
    try {
      coverage = await callApi("listStatementCoverage", {});
    } catch (err) {
      list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`;
      return;
    }
    renderCoverage();
    placeFindCard();
    if (stepNow === 4) renderWaiting();   // the list that says which accounts still need a statement
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
          ${a.status === "never" && findFirstUse === false && !$("statement-find-card").hidden ? `<button type="button" class="add-inline stmt-older-link">${escapeHtml(tr("find.olderLink"))}</button>` : ""}
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

  // ---- "Send this statement": a statement the app cannot read goes to the owner as TEXT, with every digit turned into a 9 ----
  // Friends' copies only (the owner's own banks are built in). The PDF and its password never leave the phone: this works on the rows the reader
  // already extracted (docs/statement-sample.js turns every digit into 9 and nothing else; the screen says so). No preview step (owner, 2026-10-23).
  // The owner's backend (StatementSamples.gs) turns digits into 9 a second time and keeps the text in the Sheet tab "Statement Samples".
  // The FULL version (2026-10-26): when a statement was already sent the normal way (digits hidden) and still does not add up, the card offers a second
  // button that sends the same text with the real digits and each cell's exact position. It needs a ticked box, and only appears for a statement that
  // was sent before (on this card now, or earlier: the phone remembers a short fingerprint of what it sent, never the text).
  const ss_ = { rows: null, kind: "unrecognised", sending: false, sender: "", onSent: null, full: false };
  const ssEl_ = (id) => $(id);
  function ssMsg_(t) { ssEl_("ss-msg").textContent = t || ""; }
  function ssStep_(n) { [1, 2].forEach((i) => { ssEl_("ss-step-" + i).hidden = i !== n; }); ssMsg_(""); }
  function sampleKey_(rows) {
    let h = 5381;
    const s = rows.map((r) => (r.cells || []).map((c) => String(c.str).replace(/[0-8]/g, "9")).join("|")).join("\n");
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + rows.length;
  }
  function sampleSentList_() { try { return JSON.parse(localStorage.getItem("stmtSampleSent") || "[]"); } catch (e) { return []; } }
  function sampleSentMark_(key) {
    try { localStorage.setItem("stmtSampleSent", JSON.stringify([key].concat(sampleSentList_().filter((k) => k !== key)).slice(0, 60))); } catch (e) { /* the full-version button then only shows on this card */ }
  }
  function offerSample(body, rows, kind, sender) {
    if (!rows || !rows.length || perfIsOwnerCopy_()) return;
    const key = sampleKey_(rows);
    const verdictOf = () => body.querySelector(".stmt-verdict");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-inline";
    btn.textContent = tr("stmtSample.offer");
    const fullBtn = document.createElement("button");
    fullBtn.type = "button";
    fullBtn.className = "add-inline";
    fullBtn.textContent = tr("stmtSample.fullOffer");
    // Once sent, the card stops saying "layout not recognized" and says the statement is with JP (a friend saw the old verdict and thought nothing had gone out).
    const onSent = () => {
      const verdict = verdictOf();
      if (verdict) { verdict.className = "stmt-verdict good"; verdict.textContent = tr("stmtSample.sentVerdict"); }
      const hint = body.querySelector(".hint");
      if (hint) hint.textContent = tr("stmtSample.sentHint");
      btn.remove();
      sampleSentMark_(key);
      body.appendChild(fullBtn);
    };
    const onFullSent = () => {
      const verdict = verdictOf();
      if (verdict) { verdict.className = "stmt-verdict good"; verdict.textContent = tr("stmtSample.fullSentVerdict"); }
      fullBtn.remove();
    };
    btn.addEventListener("click", () => openSampleModal(rows, kind, sender, onSent));
    fullBtn.addEventListener("click", () => openSampleModal(rows, kind, sender, onFullSent, true));
    if (sampleSentList_().includes(key)) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = tr("stmtSample.sentBefore");
      body.appendChild(note);
      body.appendChild(fullBtn);
    } else body.appendChild(btn);
  }
  function openSampleModal(rows, kind, sender, onSent, full) {
    Object.assign(ss_, { rows, kind, sending: false, sender: sender || "", onSent: onSent || null, full: !!full });
    const backdrop = ssEl_("statement-sample-backdrop");
    I18n.applyStatic(backdrop);
    ssEl_("ss-full-box").hidden = !full;
    ssEl_("ss-normal-intro").hidden = !!full;
    ssEl_("ss-normal-privacy").hidden = !!full;
    ssEl_("ss-consent").checked = false;
    ssEl_("ss-bank").value = "";
    ssEl_("ss-name").value = perfShareState_().label || "";
    ssEl_("ss-send").disabled = false;
    ssStep_(1);
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
  }
  ssEl_("ss-close").addEventListener("click", () => { ssEl_("statement-sample-backdrop").hidden = true; });
  ssEl_("ss-done").addEventListener("click", () => { ssEl_("statement-sample-backdrop").hidden = true; });
  ssEl_("ss-send").addEventListener("click", async () => {
    if (ss_.sending) return;
    if (!PerfShare.cleanLabel(ssEl_("ss-bank").value)) { ssMsg_(tr("stmtSample.bankMissing")); return; }
    if (ss_.full && !ssEl_("ss-consent").checked) { ssMsg_(tr("stmtSample.fullConsentMissing")); return; }
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
          kind: ss_.kind, text: (ss_.sender ? "E-mail sender: " + ss_.sender + "\n" : "") + StatementSample.rowsToText(ss_.rows, { full: ss_.full }), language: I18n.getLang(), app: appRelease_(),
          ...(ss_.full ? { full: true, consent: true } : {})
        } }),
        signal: controller.signal
      });
      const json = await res.json();
      if (json && json.ok) {
        // The sender address is the key to the "your bank is ready" message (same list as for bank e-mail samples).
        if (ss_.sender && typeof BankSample !== "undefined" && typeof bankSentSave_ === "function") bankSentSave_(BankSample.rememberSender(bankSentList_(), ss_.sender, Date.now()));
        if (ss_.onSent) ss_.onSent();
        ssStep_(2);
        return;
      }
      ssMsg_(json && json.code === "sample_busy" ? tr("bankSample.tooMany") : tr("bankSample.sendFailed"));
    } catch (e) {
      ssMsg_(tr("bankSample.sendFailed"));
    } finally {
      clearTimeout(timer);
      ss_.sending = false;
      ssEl_("ss-send").disabled = false;
    }
  });

  // ---- reading a file and showing the result ----

  function resultCardShell(fileName) {
    const card = document.createElement("div");
    card.className = "stmt-result";
    card.innerHTML = `<div class="stmt-result-name">${escapeHtml(fileName)}</div><div class="stmt-result-body">${loadingHtml(tr("stmt.reading"))}</div>
      <button type="button" class="stmt-result-remove">${escapeHtml(tr("stmt.removeFile"))}</button>`;
    card.querySelector(".stmt-result-remove").addEventListener("click", () => removeResultCard(card, fileName));
    $("statement-results").prepend(card);
    // Reading starts: the person moves on to step 2 by themselves (from the inbox, a file, or the Gmail search alike).
    if (stepNow === 1 || pastOpen) showStep(2); else updateStepUi();
    return card.querySelector(".stmt-result-body");
  }

  // Takes one file out of this session's list (it is only on the phone; the PDF itself is never kept).
  function removeResultCard(card, fileName) {
    const had = usable.some((u) => (u.group || u.file) === fileName);
    card.remove();
    if (!had) { updateReviewButton(); return; }
    usable = usable.filter((u) => (u.group || u.file) !== fileName);
    // The plan's statement/line numbers refer to the list — any change makes an open plan stale.
    historyPlan = null;
    $("statement-history").innerHTML = "";
    updateReviewButton();
  }

  function coverageNotes(result) {
    if (!coverage || !result.period || !result.period.end) return [];
    const acct = coverage.accounts.find((a) => a.key === accountKeyOf(result));
    const notes = [];
    if (!acct) {
      if (result.kind === "csv") return notes;   // a spreadsheet is for an account the person picked, so it is always one of theirs
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

  function renderResult(body, result, rows, file, title) {
    const sender = (file && file.senderAddress) || "";
    if (!result.kind) {
      body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.layoutUnknown"))}</p><p class="hint">${escapeHtml((result.errors || [tr("stmt.layoutUnsupported")])[0])}</p><p class="hint">${escapeHtml(tr("table.tryExport"))}</p>`;
      offerSample(body, rows, "unrecognised", sender);
      return;
    }
    let verdict;
    if (!result.ok) verdict = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.verdictBad"))}</p>`;
    else if (result.kind === "csv") verdict = `<p class="stmt-verdict warn">${escapeHtml(tr(screenMode === "import" ? "imp.tableVerdict" : "table.verdict"))}</p>`;
    else if (result.verified === false) verdict = `<p class="stmt-verdict warn">${escapeHtml(tr("stmt.verdictWarn"))}</p>`;
    else verdict = `<p class="stmt-verdict good">${escapeHtml(tr("stmt.verdictGood"))}</p>`;

    const warnNotes = (result.warnings || []).map((w) => `<p class="stmt-note warn">${escapeHtml(w)}</p>`).join("");
    const notes = warnNotes + coverageNotes(result).map(([cls, msg]) => `<p class="stmt-note ${cls}">${msg}</p>`).join("");
    const period = result.period && result.period.end ? `${fmtDate(result.period.start, true)} – ${fmtDate(result.period.end, true)}` : "—";
    const balances = Object.entries(result.balances || {}).map(([cur, b]) => {
      const rows = [];
      if (b.opening !== null && b.opening !== undefined) rows.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.opening", { cur }))}</span><span>${escapeHtml(fmtMoney(cur, b.opening))}</span></div>`);
      if (b.closing !== null && b.closing !== undefined) rows.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.closing", { cur }))}</span><span>${escapeHtml(fmtMoney(cur, b.closing))}</span></div>`);
      return rows.join("");
    }).join("");
    const errors = (result.errors || []).slice(0, 6).map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    // A big spreadsheet can hold thousands of lines: the first ones are enough to judge a reading, and the page stays light.
    const SHOW_LINES = 200;
    const allLines = result.lines || [];
    const lines = allLines.slice(0, SHOW_LINES).map((l) =>
      `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`
    ).join("") + (allLines.length > SHOW_LINES ? `<p class="hint">${escapeHtml(tr("table.moreLines", { n: allLines.length - SHOW_LINES }))}</p>` : "");

    body.innerHTML = `${title ? `<div class="stmt-result-name">${escapeHtml(title)}</div>` : ""}${verdict}${notes}
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.period"))}</span><span>${escapeHtml(period)}</span></div>
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.linesRead"))}</span><span>${(result.lines || []).length}</span></div>
      ${balances}
      ${errors ? `<ul class="stmt-errors">${errors}</ul>` : ""}
      ${lines ? `<details class="stmt-lines"><summary>${escapeHtml(tr("stmt.showLines", { n: (result.lines || []).length }))}</summary>${lines}</details>` : ""}`;
    if (!result.ok) offerSample(body, rows, "unverified", sender);   // a layout we know but cannot make add up: the owner wants to see it too
  }

  async function readStatementFile(file) {
    const body = resultCardShell(file.name);
    let cancelled = false;
    let nextTry = 0, lastTried = null, asked = false, typed = null;
    try {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const rows = await StatementParsers.readPdfRows(pdfjs, data, {
        onPassword: async (reason) => {
          // First: every password that already opened a statement this visit, silently, before bothering the person.
          if (nextTry < sessionPasswords.length) { lastTried = sessionPasswords[nextTry++]; return lastTried; }
          // The silent tries failing are not the person's mistake, so the first prompt reads "protected", not "didn't work".
          const pw = await askStatementPassword(file.name, sessionPasswords.length && !asked ? 1 : reason);
          asked = true;
          if (pw === null) cancelled = true; else typed = pw;
          return pw;
        }
      });
      // The one that opened this file goes to the front: it is the likeliest for the next file.
      const opened = typed !== null ? typed : lastTried;
      if (opened !== null) sessionPasswords = [opened].concat(sessionPasswords.filter((p) => p !== opened));
      const result = StatementParsers.parseStatement(rows);
      renderResult(body, result, rows, file);
      if (result.kind && result.ok) {
        // A statement that came from Gmail and was read: its sender is a bank this app now knows (the 15-minute check finds its next ones).
        if (file.inboxId) callApi("rememberStatementSender", { id: file.inboxId }).catch(() => {});
        // A re-read of the same file replaces its earlier reading.
        usable = usable.filter((u) => (u.group || u.file) !== file.name);
        usable.push({ file: file.name, result, inboxId: file.inboxId || "" });
        // The plan's statement/line numbers refer to THIS list — any change makes an open plan stale.
        historyPlan = null;
        $("statement-history").innerHTML = "";
        updateReviewButton();
      }
    } catch (err) {
      if (cancelled) body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("stmt.skippedNoPw"))}</p>`;
      else body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    }
  }


  // ---- spreadsheet statements: CSV / Excel (docs/statement-table.js) ----
  // The person picks the account (the file has no digits to recognize it by) and confirms which column is which; the guess is made from
  // the header words and the values. What they confirm is remembered IN THE SHEET (tab "Statement Formats", backend/StatementFormats.gs)
  // under the file's header words and a name they can give it, so every later file with the same layout — a bank's CSV, a Spendee
  // export — needs no questions, on any device. A file that holds several accounts (an app's "Wallet" column) asks which of the person's
  // accounts each name is, and remembers that too.

  const isTableFile = (f) => /\.(csv|tsv|txt|xlsx|xls)$/i.test(f.name) || /csv|spreadsheet|excel/i.test(f.type || "");
  const TABLE_BIG_FILE = 1500;   // lines: past this the screen warns that reading and saving take a while
  const NO_ACCOUNT_KEY = "NOACCOUNT";   // an import saved with no account (backend: STMT_NO_ACCOUNT_KEY_)
  const normName = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

  function tableErrorText(err) {
    const code = err && err.message;
    const key = { "xls-unreadable": "table.errLegacy", "xls-encrypted": "table.errProtected", "xlsx-not-zip": "table.errBroken", "xlsx-no-inflate": "table.errNoInflate", "xlsx-no-sheet": "table.errEmpty", "table-empty": "table.errEmpty" }[code];
    return key ? tr(key) : (code || String(err));
  }

  // The account the statement's lines belong to: its last four digits when it has them, else its id (backend: stmtPmForKey_).
  function tableAccountKey(pm) {
    const last = String(pm.last_4 || "").trim();
    return /^\d{1,4}$/.test(last) ? ("0000" + last).slice(-4) : "ACCT-" + pm.id;
  }

  function tableAccounts() {
    return ((typeof meta !== "undefined" && meta && meta.paymentMethods) || []).filter((pm) => (pm.type === "debit" || pm.type === "credit" || pm.type === "wallet") && !pmHidden_(pm));
  }

  function columnLetter(i) { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; }

  async function readTableFile(file) {
    const body = resultCardShell(file.name);
    try {
      const rows = await StatementTable.readTable(new Uint8Array(await file.arrayBuffer()), file.name);
      if (rows.length < 2) throw new Error("table-empty");
      await renderTableMapping(body, rows, file);
    } catch (err) {
      body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(tableErrorText(err))}</p>`;
    }
  }

  async function renderTableMapping(body, rows, file) {
    const accounts = tableAccounts();
    // Import data never needs an account (a person may be trying the app before setting any up): its entries are saved with none.
    // Statements still do — a bank's statement is about one account (balances, gaps, coverage).
    const noneOk = screenMode === "import";
    if (!accounts.length && !noneOk) { body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(tr("table.noAccounts"))}</p>`; return; }
    const guess = StatementTable.guessMapping(rows, {});
    const sig = StatementTable.signature(guess, rows);
    const width = guess.headers.length;
    const state = { m: { ...guess }, accountId: "", map: {}, source: "new", label: "", uses: 0, catChoice: {}, catNames: {}, catCustom: {}, catInfo: [], catItems: [], catSaved: {}, catKey: "" };

    // Where do the columns come from: this layout saved on the server, a layout the app knows by name, or the guess.
    let saved = null;
    try { saved = await callApi("getStatementFormat", { signature: sig }); } catch (e) { /* offline or an older backend: just the guess */ }
    const known = StatementTable.recognize(guess.headers);
    const fromSource = saved && saved.found ? saved.mapping : (known ? known.mapping : null);
    if (fromSource) {
      ["date", "description", "amount", "out", "in", "currency", "account", "category", "type"].forEach((f) => {
        if (typeof fromSource[f] === "number") state.m[f] = fromSource[f] >= 0 && fromSource[f] < width ? fromSource[f] : -1;
      });
      ["dateOrder", "decimal", "sign", "currencyFixed", "source"].forEach((f) => { if (fromSource[f]) state.m[f] = fromSource[f]; });
    }
    if (saved && saved.found) {
      state.source = "saved"; state.label = saved.label || ""; state.uses = saved.uses || 0;
      state.map = { ...(saved.accounts || {}) };
      state.catSaved = { ...(saved.categories || {}) };
      if (state.map["*"] && accounts.some((a) => a.id === state.map["*"])) state.accountId = state.map["*"];
    } else if (known) {
      state.source = "known"; state.label = known.name;
    }
    const remembered = state.source !== "new";
    // Statements reads a bank's files and Import data reads another app's: an app's export is told from a bank's by its layout
    // (known or saved as one) or by carrying a category column. Each screen refuses the other's files.
    const looksLikeApp = state.source === "known" || state.m.source === "app" || state.m.category >= 0;
    if (screenMode !== "import" && looksLikeApp) {
      body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("imp.blockedBank"))}</p>
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice imp-go">${escapeHtml(tr("imp.openImport"))}</button></div>`;
      body.querySelector(".imp-go").addEventListener("click", () => { showStatementsScreen("import"); window.scrollTo(0, 0); });
      return;
    }
    state.m.source = screenMode === "import" ? "app" : "";   // the screen decides: an import is always an app's export, a statement never
    if (!state.accountId) {
      const fileDigits = (file.name.match(/\d{4}/g) || []);
      const hit = accounts.find((a) => fileDigits.includes(String(a.last_4 || "").padStart(4, "0"))) || (accounts.length === 1 ? accounts[0] : null);
      if (hit) state.accountId = hit.id;
    }

    const colName = (i) => {
      const h = guess.headers[i];
      return h ? tr("table.colNamed", { letter: columnLetter(i), name: h }) : tr("table.colBlank", { letter: columnLetter(i) });
    };
    const colOptions = (selected, allowNone) => (allowNone ? `<option value="-1">${escapeHtml(tr("table.none"))}</option>` : "") +
      Array.from({ length: width }, (_, i) => `<option value="${i}"${i === selected ? " selected" : ""}>${escapeHtml(colName(i))}</option>`).join("");
    const sel = (cls, label, inner) => `<label>${escapeHtml(label)}</label><select class="tm-${cls}">${inner}</select>`;
    const currencyOptions = (selected) => CURRENCIES.map((c) => `<option value="${c.code}"${c.code === selected ? " selected" : ""}>${c.code}</option>`).join("");
    const accountOptions = (selectedId, extra) => `<option value="">${escapeHtml(tr(noneOk ? "imp.noAccountOption" : "table.pickAccount"))}</option>` + (extra || "") +
      accounts.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === selectedId ? " selected" : ""}>${escapeHtml(a.nickname + (a.last_4 ? ` (${a.last_4})` : ""))}</option>`).join("");

    const banner = state.source === "known" ? tr("table.layoutKnown", { name: state.label })
      : state.source === "saved" ? (state.label ? tr("table.layoutSaved", { name: state.label }) : tr("table.layoutSavedUnnamed"))
      : tr("table.layoutNew");
    body.innerHTML = `<div class="tm-root">
      <p class="stmt-note ${remembered ? "ok" : "info"}">${escapeHtml(banner)}${state.source === "saved" ? ` <button type="button" class="add-inline tm-forget">${escapeHtml(tr("table.forget"))}</button>` : ""}</p>
      <p class="hint">${escapeHtml(tr(screenMode === "import" ? "imp.tableHint" : "table.hint"))}</p>
      <div class="tm-single">${sel("account", tr(noneOk ? "imp.account" : "table.account"), accountOptions(state.accountId))}</div>
      <div class="tm-multi" hidden><p class="hint">${escapeHtml(tr("table.accountsHint"))}</p><div class="tm-values"></div></div>
      ${sel("date", tr("table.colDate"), colOptions(state.m.date, false))}
      ${sel("desc", tr("table.colDesc"), colOptions(state.m.description, true))}
      ${sel("mode", tr("table.amounts"), `<option value="one">${escapeHtml(tr("table.amountOne"))}</option><option value="two">${escapeHtml(tr("table.amountTwo"))}</option>`)}
      <div class="tm-one">${sel("amount", tr("table.colAmount"), colOptions(state.m.amount, true))}
        ${sel("sign", tr("table.sign"), `<option value="negative">${escapeHtml(tr("table.signNeg"))}</option><option value="positive">${escapeHtml(tr("table.signPos"))}</option>`)}</div>
      <div class="tm-two" hidden>${sel("out", tr("table.colOut"), colOptions(state.m.out, true))}${sel("in", tr("table.colIn"), colOptions(state.m.in, true))}</div>
      <details class="stmt-lines"><summary>${escapeHtml(tr("table.more"))}</summary>
        <label>${escapeHtml(tr("table.layoutName"))}</label><input type="text" class="tm-name" maxlength="60" placeholder="${escapeHtml(tr("table.layoutNameHint"))}" value="${escapeHtml(state.label)}">
        ${sel("acol", tr("table.colAccount"), colOptions(state.m.account, true))}
        <div${screenMode === "import" ? "" : " hidden"}>${sel("cat", tr("table.colCategory"), colOptions(state.m.category, true))}</div>
        ${sel("type", tr("table.colType"), colOptions(state.m.type, true))}
        ${sel("currency", tr("table.colCurrency"), colOptions(state.m.currency, true))}
        ${sel("fixed", tr("table.currencyFixed"), currencyOptions(state.m.currencyFixed || homeCur()))}
        ${sel("order", tr("table.dateOrder"), `<option value="dmy">${escapeHtml(tr("table.dmy"))}</option><option value="mdy">${escapeHtml(tr("table.mdy"))}</option>`)}
        ${sel("decimal", tr("table.decimal"), `<option value=".">1,234.56</option><option value=",">1.234,56</option>`)}
      </details>
      <div class="tm-preview"></div>
      <div class="tm-cats"></div>
      <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice tm-use">${escapeHtml(tr("table.use"))}</button></div></div>`;

    const root = body.querySelector(".tm-root");
    const $q = (cls) => root.querySelector(".tm-" + cls);
    const setVal = (cls, v) => { $q(cls).value = String(v); };
    const multi = () => state.m.account >= 0;
    const pm = () => accounts.find((a) => a.id === state.accountId) || null;
    const pmById = (id) => accounts.find((a) => a.id === id) || null;
    const currentMapping = () => ({ ...state.m, currencyFixed: $q("fixed").value });

    // A guessed account for a name in the file: the app account whose nickname equals it or contains it (or the other way round).
    function guessAccountFor(value) {
      const v = normName(value);
      if (!v) return "";
      const hit = accounts.find((a) => normName(a.nickname) === v) || accounts.find((a) => normName(a.nickname).includes(v) || v.includes(normName(a.nickname)));
      return hit ? hit.id : "";
    }
    function renderValues() {
      const box = root.querySelector(".tm-values");
      if (!multi()) { box.innerHTML = ""; return; }
      const values = StatementTable.distinctValues(rows, state.m, state.m.account);
      values.forEach((v) => { if (state.map[v.value] === undefined || (state.map[v.value] !== "skip" && !pmById(state.map[v.value]))) { const g = guessAccountFor(v.value); if (g) state.map[v.value] = g; else delete state.map[v.value]; } });
      box.innerHTML = values.map((v) => `<div class="tm-value" data-value="${escapeHtml(v.value)}"><label>${escapeHtml(tr("table.valueLines", { value: v.value, n: v.count }))}</label>
        <select class="tm-vacct">${accountOptions(state.map[v.value], `<option value="skip"${state.map[v.value] === "skip" ? " selected" : ""}>${escapeHtml(tr("table.skipValue"))}</option>`)}</select></div>`).join("");
    }
    function syncControlsFromState() {
      const two = state.m.out >= 0 && state.m.in >= 0;
      setVal("mode", two ? "two" : "one");
      root.querySelector(".tm-one").hidden = two;
      root.querySelector(".tm-two").hidden = !two;
      setVal("sign", state.m.sign || "negative");
      setVal("order", state.m.dateOrder || "dmy");
      setVal("decimal", state.m.decimal || ".");
      setVal("fixed", state.m.currencyFixed || homeCur());
      root.querySelector(".tm-single").hidden = multi();
      root.querySelector(".tm-multi").hidden = !multi();
    }
    // The lines that will be used: for a multi-account file only the names the person assigned (or has not decided yet).
    const skippedCategory = (l) => !!l.category && state.catChoice[(l.amount > 0 ? "income" : "expense") + ":" + StatementTable.catNorm(l.category)] === "skip";
    function usableLines(all0) {
      const all = all0.filter((l) => !skippedCategory(l));   // lines of a category the person chose not to import
      if (!multi()) return { lines: all, undecided: 0 };
      const names = new Set(all.map((l) => l.account));
      let undecided = 0;
      if (!noneOk) names.forEach((n) => { if (!state.map[n]) undecided++; });   // an import may leave a name with no account
      return { lines: all.filter((l) => (noneOk || state.map[l.account]) && state.map[l.account] !== "skip"), undecided };
    }
    // ---- the merge of the file's categories with the person's own (backend/StatementCategories.gs) ----
    // Each name in the file, per type, is matched to one of the person's categories, or will be created, or left without one. The server
    // proposes; whatever the person chose before for this layout wins; every row can be changed. The NAME that remains is the file's by
    // default (people are used to the names of their old app); it can be typed over, and a category the app depends on (Bank fees…)
    // keeps its own name.
    const myCategories = (type) => sortedCategories_(pickableCategories_((meta.categories || []).filter((c) => c.type === type)));
    let catTimer = null;
    function fileCategoryNames() {
      if (state.m.category < 0) return [];
      const r = StatementTable.applyMapping(rows, currentMapping());
      const counts = new Map();
      r.lines.forEach((l) => {
        if (!l.category || l.transfer) return;
        const type = l.amount > 0 ? "income" : "expense";
        const k = type + "\u0000" + l.category;
        if (!counts.has(k)) counts.set(k, { type, name: l.category, count: 0 });
        counts.get(k).count++;
      });
      return [...counts.values()];
    }
    function scheduleCategories() {
      clearTimeout(catTimer);
      catTimer = setTimeout(loadCategories, 250);
    }
    const catInfo = (id) => (state.catInfo || []).find((c) => c.id === id) || null;
    // The name a row should carry, given where it points. A category that already answers to the file's name (in either language) or that
    // the app depends on keeps its own; any other existing category, and a new one, takes the file's name.
    function defaultNameFor(it, choice) {
      if (choice === "create") return it.name;
      if (choice === "") return "";
      const info = catInfo(choice);
      if (!info) return it.name;
      const norm = StatementTable.catNorm(it.name);
      return info.protected || info.names.indexOf(norm) !== -1 ? info.name : it.name;
    }
    async function loadCategories() {
      const names = fileCategoryNames();
      const sigNames = JSON.stringify(names);
      if (sigNames === state.catKey) return;
      state.catKey = sigNames;
      if (!names.length) { state.catItems = []; renderCategories(); return; }
      root.querySelector(".tm-cats").innerHTML = loadingHtml(tr("table.catLoading"));
      let res = { items: [], categories: [] };
      try { res = await callApi("suggestCategoryMap", { names }); } catch (e) { /* no suggestions: every name is left as it is */ }
      if (JSON.stringify(fileCategoryNames()) !== sigNames) return;   // the mapping changed while waiting: a newer call is on its way
      state.catItems = res.items || [];
      state.catInfo = res.categories || [];
      const valid = (c) => c === "create" || c === "" || state.catInfo.some((x) => x.id === c);   // "skip" is never remembered: leaving lines out is decided per file
      state.catItems.forEach((it) => {
        const remembered = state.catSaved[it.key];
        if (state.catChoice[it.key] === undefined) {
          state.catChoice[it.key] = remembered !== undefined && valid(remembered) ? remembered : (it.action === "match" ? it.categoryId : it.action === "create" ? "create" : "");
          const info = catInfo(state.catChoice[it.key]);
          const keepApp = state.catSaved["~rename:" + it.key] === false;   // the person chose to keep the app's name last time
          const mine = state.catSaved["~name:" + it.key];                   // …or typed a name of their own, which the category may already have
          const alreadyMine = !!(info && mine && info.names.indexOf(StatementTable.catNorm(mine)) !== -1);
          state.catNames[it.key] = (keepApp || alreadyMine) && info ? info.name : defaultNameFor(it, state.catChoice[it.key]);
          const custom = state.catSaved["~custom:" + it.key];                // a new category the person named themselves last time
          if (state.catChoice[it.key] === "create" && custom) { state.catCustom[it.key] = true; state.catNames[it.key] = custom; }
        }
      });
      renderCategories();
    }
    // What a row will do to its category's name: { from, to } for a rename, else null.
    function renameOf(it) {
      const info = catInfo(state.catChoice[it.key]);
      const to = String(state.catNames[it.key] || "").replace(/\s+/g, " ").trim();
      if (!info || info.protected || !to || info.names.indexOf(StatementTable.catNorm(to)) !== -1) return null;
      return { from: info.name, to };
    }
    // A name that exists in both types (in the file or in the app) gets its type in brackets, so "Other (income)" and "Other (expense)"
    // can be told apart.
    function ambiguousNames() {
      const seen = new Map();
      const add = (name, type) => { const k = StatementTable.catNorm(name); if (!k) return; if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(type); };
      state.catItems.forEach((it) => add(it.name, it.type));
      (state.catInfo || []).forEach((c) => add(c.name, c.type));
      return new Set([...seen].filter(([, types]) => types.size > 1).map(([k]) => k));
    }
    const shownName = (name, type) => ambiguousNames().has(StatementTable.catNorm(name)) ? `${name} ${tr(type === "income" ? "table.catIncomeTag" : "table.catExpenseTag")}` : name;
    function categorySummary() {
      let used = 0, created = 0, left = 0, renamed = 0, skipped = 0;
      state.catItems.forEach((it) => {
        const c = state.catChoice[it.key];
        if (c === "create") created++; else if (c === "") left++; else if (c === "skip") skipped++; else { used++; if (renameOf(it)) renamed++; }
      });
      return tr(renamed ? "table.catSummaryRenamed" : "table.catSummary", { used, renamed, created, left }) + (skipped ? " · " + tr("table.catSummarySkipped", { n: skipped }) : "");
    }
    // What the row will do, said from the file's side: the file's category is the subject, the person's existing one is what it joins.
    // What the "Goes into" list shows for a row: a category as it is, the same category renamed to the file's name ("ren:<id>"), a new category
    // with the file's name ("create") or one the person names ("custom"), none, or leave the lines out.
    function selectValue(it) {
      const c = state.catChoice[it.key];
      if (c === "create") return state.catCustom[it.key] ? "custom" : "create";
      if (c === "" || c === "skip") return c;
      return renameOf(it) ? "ren:" + c : c;
    }
    function rowHint(it) {
      const c = state.catChoice[it.key];
      if (c === "skip") return tr("table.catSkipHint", { n: it.count });
      if (c === "") return tr(it.why === "retired" ? "table.catWhyRetired" : "table.catLeaveHint");
      const typed = String(state.catNames[it.key] || "").replace(/\s+/g, " ").trim() || it.name;
      if (c === "create") return tr("table.catWhyNew", { name: shownName(typed, it.type) });
      const info = catInfo(c);
      if (!info) return "";
      if (info.protected) return tr("table.catKeepsName", { name: shownName(info.name, it.type) });
      const rn = renameOf(it);
      if (rn) return tr(info.entries ? "table.catWillRename" : "table.catWillRenameEmpty", { from: shownName(rn.from, it.type), to: shownName(rn.to, it.type), n: info.entries || 0 });
      return tr("table.catGoesInto", { name: shownName(info.name, it.type) });
    }
    function renderCategories() {
      const box = root.querySelector(".tm-cats");
      if (!state.catItems.length) { box.innerHTML = ""; return; }
      const rowHtml = (it) => {
        const cur = state.catChoice[it.key];
        const selVal = selectValue(it);
        const norm = StatementTable.catNorm(it.name);
        const opts = myCategories(it.type).map((c) => {
          const info = catInfo(c.id) || {};
          const n = info.entries ? ` · ${tr("categories.entryCount", { n: info.entries })}` : "";
          // The suggested category (or the one a remembered choice renames) is offered twice: renamed to the file's name, and as it is.
          const renamable = (c.id === it.categoryId || selVal === "ren:" + c.id) && !info.protected && info.names && info.names.indexOf(norm) === -1;
          return (renamable ? `<option value="ren:${escapeHtml(c.id)}"${selVal === "ren:" + c.id ? " selected" : ""}>${escapeHtml(tr("table.catOptRename", { from: c.name, to: shownName(it.name, it.type) }) + n)}</option>` : "") +
            `<option value="${escapeHtml(c.id)}"${selVal === c.id ? " selected" : ""}>${escapeHtml(c.name + n)}</option>`;
        }).join("");
        const nameInput = selVal === "custom" ? `<label>${escapeHtml(tr("table.catCustomLabel"))}</label><input type="text" class="tm-cname" maxlength="40" aria-label="${escapeHtml(tr("table.catName"))}" value="${escapeHtml(state.catNames[it.key] || "")}">` : "";
        const note = it.why === "retired" ? `<p class="stmt-note warn" style="margin:6px 0">${escapeHtml(tr("table.catLoanNote"))}</p>` : "";
        return `<div class="tm-cat-row" data-key="${escapeHtml(it.key)}" style="margin-bottom:14px">
          <div><span class="hint" style="margin-right:6px">${escapeHtml(tr("table.catFromFile"))}</span><strong>${escapeHtml(shownName(it.name, it.type))}</strong> <span class="hint">· ${escapeHtml(tr("table.catLines", { n: it.count }))}</span></div>
          ${note}
          <label>${escapeHtml(tr("table.catGoesIntoLabel"))}</label>
          <select class="tm-cchoice"><optgroup label="${escapeHtml(tr("table.catYours"))}">${opts}</optgroup>
            <option value="create"${selVal === "create" ? " selected" : ""}>${escapeHtml(tr("table.catCreate", { name: it.name }))}</option>
            <option value="custom"${selVal === "custom" ? " selected" : ""}>${escapeHtml(tr("table.catCustom"))}</option>
            <option value=""${selVal === "" ? " selected" : ""}>${escapeHtml(tr("table.catLeave"))}</option>
            <option value="skip"${selVal === "skip" ? " selected" : ""}>${escapeHtml(tr("table.catSkip"))}</option></select>
          ${nameInput}
          <p class="hint tm-cat-hint" style="margin:2px 0 0">${escapeHtml(rowHint(it))}</p></div>`;
      };
      const groupHtml = (type) => {
        const items = state.catItems.filter((it) => it.type === type);
        return items.length ? `<h4 class="accounts-group-title">${escapeHtml(tr(type === "income" ? "table.catGroupIncome" : "table.catGroupExpense"))}</h4>${items.map(rowHtml).join("")}` : "";
      };
      const open = !Object.keys(state.catSaved).length && state.catItems.some((it) => state.catChoice[it.key] === "create" || renameOf(it) || it.why === "retired");
      box.innerHTML = `<p class="stmt-note info tm-cat-summary">${escapeHtml(categorySummary())}</p>
        <details class="stmt-lines tm-cat-details"${open ? " open" : ""}><summary>${escapeHtml(tr("table.catReview"))}</summary>${groupHtml("expense")}${groupHtml("income")}
          <p class="hint">${escapeHtml(tr("table.catEdit"))}</p></details>`;
    }
    // The names to send with the save: a new category's chosen name, and an existing category's new name when it is being renamed.
    function namesToSend() {
      const out = {};
      state.catItems.forEach((it) => {
        const c = state.catChoice[it.key];
        if (c === "create") { const n = String(state.catNames[it.key] || "").replace(/\s+/g, " ").trim(); if (n && n !== it.name) out[it.key] = n; }
        else if (c !== "" && c !== "skip") { const rn = renameOf(it); if (rn) out[it.key] = rn.to; }
      });
      return out;
    }
    // Remembered per name: did the person let the app's category be renamed (true) or keep its own name (false)?
    const withoutSkips = (choices) => Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== "skip"));
    function renameFlags() {
      const out = {};
      state.catItems.forEach((it) => { if (state.catChoice[it.key] === "create") out["~custom:" + it.key] = state.catCustom[it.key] ? String(state.catNames[it.key] || "").trim() : ""; });
      state.catItems.forEach((it) => {
        const c = state.catChoice[it.key], info = catInfo(c);
        if (c && c !== "create" && info && !info.protected && info.names.indexOf(StatementTable.catNorm(it.name)) === -1) {
          const rn = renameOf(it);
          out["~rename:" + it.key] = !!rn;
          out["~name:" + it.key] = rn ? rn.to : "";   // what the person chose to call it, so the next file does not rename it back to the file's name
        }
      });
      return out;
    }
    function refreshCategoryRow(row) {
      const it = state.catItems.find((x) => x.key === row.dataset.key);
      row.querySelector(".tm-cat-hint").textContent = rowHint(it);
      root.querySelector(".tm-cat-summary").textContent = categorySummary();
    }
    function renderPreview() {
      const m = currentMapping();
      const r = StatementTable.applyMapping(rows, m);
      const { lines, undecided } = usableLines(r.lines);
      const box = root.querySelector(".tm-preview");
      const use = root.querySelector(".tm-use");
      if (!r.lines.length) {
        box.innerHTML = `<p class="stmt-note warn">${escapeHtml(tr("table.noLines"))}</p>`;
        use.disabled = true;
        return;
      }
      const needCategory = screenMode === "import" && state.m.category < 0;   // another app's export names a category for every line
      use.disabled = needCategory || (multi() ? (undecided > 0 || !lines.length) : (!noneOk && !pm()));
      // Not blocking, only a heads-up: with accounts set up, a person usually wants the entries on one of them.
      const noAccountNote = noneOk && !needCategory && !multi() && !pm() ? `<p class="stmt-note info">${escapeHtml(tr(accounts.length ? "imp.noAccountWarn" : "imp.noAccountsInfo"))}</p>` : "";
      const totals = {};
      lines.forEach((l) => { const t = totals[l.currency] || (totals[l.currency] = { out: 0, in: 0 }); if (l.amount < 0) t.out += -l.amount; else t.in += l.amount; });
      const sum = (key) => Object.keys(totals).sort().filter((c) => totals[c][key] > 0).map((c) => fmtMoney(c, totals[c][key])).join(" + ") || "—";
      const dates = lines.map((l) => l.date).sort();
      box.innerHTML = `<div class="stmt-kv"><span>${escapeHtml(lines.length ? tr("table.previewLines", { n: lines.length, from: fmtDate(dates[0], true), to: fmtDate(dates[dates.length - 1], true) }) : "—")}</span><span></span></div>
        <div class="stmt-kv"><span>${escapeHtml(tr("table.out"))}</span><span>${escapeHtml(sum("out"))}</span></div>
        <div class="stmt-kv"><span>${escapeHtml(tr("table.in"))}</span><span>${escapeHtml(sum("in"))}</span></div>
        ${r.skipped.some((x) => x.reason !== "transfer") ? `<p class="hint">${escapeHtml(tr("table.skipped", { n: r.skipped.filter((x) => x.reason !== "transfer").length }))}</p>` : ""}
        ${r.skipped.some((x) => x.reason === "transfer") ? `<p class="stmt-note warn">${escapeHtml(tr("table.transferNoDirection", { n: r.skipped.filter((x) => x.reason === "transfer").length }))}</p>` : ""}
        ${lines.some((l) => l.transfer) ? `<p class="stmt-note info">${escapeHtml(tr("table.transfersMarked", { n: lines.filter((l) => l.transfer).length }))}</p>` : ""}
        ${needCategory ? `<p class="stmt-note warn">${escapeHtml(tr("imp.needCategory"))}</p>` : ""}
        ${noAccountNote}
        ${multi() && undecided ? `<p class="stmt-note warn">${escapeHtml(tr("table.pickEach"))}</p>` : ""}
        ${r.lines.length > TABLE_BIG_FILE ? `<p class="stmt-note warn">${escapeHtml(tr("table.bigFile", { n: r.lines.length }))}</p>` : ""}
        <p class="hint">${escapeHtml(tr("table.checkSigns"))}</p>
        ${lines.slice(0, 5).map((l) => `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`).join("")}`;
    }
    function applyAccountGuess() {
      // A card's purchases are usually positive: re-guess the sign for the chosen account, but only for a layout nobody has confirmed.
      const a = pm();
      if (a && !remembered) state.m.sign = StatementTable.guessMapping(rows, { isCard: a.type === "credit" }).sign;
    }
    root.addEventListener("change", (e) => {
      const cls = (e.target.className.match(/tm-(\w+)/) || [])[1];
      if (!cls) return;
      const v = e.target.value;
      if (cls === "account") { state.accountId = v; applyAccountGuess(); syncControlsFromState(); }
      else if (cls === "vacct") { const val = e.target.closest(".tm-value").dataset.value; if (v) state.map[val] = v; else delete state.map[val]; }
      else if (cls === "date") state.m.date = Number(v);
      else if (cls === "desc") state.m.description = Number(v);
      else if (cls === "amount") state.m.amount = Number(v);
      else if (cls === "sign") state.m.sign = v;
      else if (cls === "out") state.m.out = Number(v);
      else if (cls === "in") state.m.in = Number(v);
      else if (cls === "currency") state.m.currency = Number(v);
      else if (cls === "acol") { state.m.account = Number(v); renderValues(); syncControlsFromState(); }
      else if (cls === "type") state.m.type = Number(v);
      else if (cls === "cchoice") {
        const row = e.target.closest(".tm-cat-row"), it = state.catItems.find((x) => x.key === row.dataset.key);
        state.catCustom[it.key] = false;
        if (v === "custom") { state.catChoice[it.key] = "create"; state.catCustom[it.key] = true; if (!state.catNames[it.key]) state.catNames[it.key] = it.name; }
        else if (v === "create") { state.catChoice[it.key] = "create"; state.catNames[it.key] = it.name; }
        else if (v === "" || v === "skip") { state.catChoice[it.key] = v; state.catNames[it.key] = ""; }
        else if (v.indexOf("ren:") === 0) { state.catChoice[it.key] = v.slice(4); state.catNames[it.key] = it.name; }   // the category takes the file's name
        else { state.catChoice[it.key] = v; state.catNames[it.key] = (catInfo(v) || {}).name || it.name; }                // an existing category keeps its own
        renderCategories();
        if (v === "custom") { const box = root.querySelector(`.tm-cat-row[data-key="${CSS.escape(it.key)}"] .tm-cname`); if (box) { box.focus(); box.select(); } }
        renderPreview();   // lines of a category left out change the totals
        return;
      }
      else if (cls === "cname") { const row = e.target.closest(".tm-cat-row"); state.catNames[row.dataset.key] = e.target.value; refreshCategoryRow(row); return; }
      else if (cls === "cat") state.m.category = Number(v);
      else if (cls === "order") state.m.dateOrder = v;
      else if (cls === "decimal") state.m.decimal = v;
      else if (cls === "mode") {
        if (v === "two") {
          // Money out starts at the amount column (or the guess); money in at the next numeric column that is not already taken.
          const numeric = Array.from({ length: width }, (_, i) => i).filter((i) => {
            const vals = rows.slice(guess.headerRow + 1).map((r) => r[i]).filter((x) => x !== "" && x !== undefined);
            return vals.length && vals.filter((x) => !isNaN(StatementTable.parseAmount(x, state.m.decimal || "."))).length >= vals.length * 0.8;
          }).filter((i) => i !== state.m.date);
          const was = state.m.amount;
          state.m.amount = -1;
          if (state.m.out < 0) state.m.out = guess.out >= 0 ? guess.out : (was >= 0 ? was : (numeric[0] ?? 0));
          if (state.m.in < 0) state.m.in = guess.in >= 0 ? guess.in : (numeric.find((i) => i !== state.m.out) ?? Math.min(width - 1, state.m.out + 1));
        } else { state.m.out = -1; state.m.in = -1; if (state.m.amount < 0) state.m.amount = guess.amount >= 0 ? guess.amount : Math.min(width - 1, state.m.date + 2); }
        syncControlsFromState();
        setVal("out", state.m.out); setVal("in", state.m.in); setVal("amount", state.m.amount);
      }
      renderPreview();
      scheduleCategories();
    });
    root.addEventListener("input", (e) => {
      if (!e.target.classList.contains("tm-cname")) return;
      const row = e.target.closest(".tm-cat-row");
      state.catNames[row.dataset.key] = e.target.value;
      refreshCategoryRow(row);
    });
    const forget = root.querySelector(".tm-forget");
    if (forget) forget.addEventListener("click", async () => {
      forget.disabled = true;
      try { await callApi("deleteStatementFormat", { signature: sig }); } catch (e) { /* it stays remembered; nothing else breaks */ }
      await renderTableMapping(body, rows, file);
    });
    root.querySelector(".tm-use").addEventListener("click", async () => {
      const m = currentMapping();
      const { lines } = usableLines(StatementTable.applyMapping(rows, m).lines);
      if (!lines.length) return;
      // Lines go to their account: the one picked, or — for a file with an account column — the account each name was matched to.
      const byAccount = new Map();
      lines.forEach((l) => {
        let id = multi() ? state.map[l.account] : state.accountId;
        if (id === "skip") return;
        if (!id || !pmById(id)) { if (!noneOk) return; id = ""; }   // an import keeps the lines with no account
        if (!byAccount.has(id)) byAccount.set(id, []);
        byAccount.get(id).push(l);
      });
      if (!byAccount.size) { if (!multi() && !noneOk) root.querySelector(".tm-account").focus(); return; }
      const results = [];
      byAccount.forEach((accLines, id) => {
        const a = pmById(id);   // null: the lines have no account
        const dates = accLines.map((l) => l.date).sort();
        const accountKey = a ? tableAccountKey(a) : NO_ACCOUNT_KEY;
        results.push({ name: byAccount.size > 1 ? `${file.name} · ${a ? a.nickname : tr("imp.noAccountOption")}` : file.name,
          result: { kind: "csv", ok: true, verified: false, accountKey, account: { last4: /^\d{4}$/.test(accountKey) ? accountKey : "" }, holder: "",
            period: { start: dates[0], end: dates[dates.length - 1] }, balances: {}, lines: accLines, warnings: [], source: state.m.source === "app" ? "app" : "", categoryMap: withoutSkips(state.catChoice), categoryNames: namesToSend() } });
      });
      // Remember the layout in the Sheet, under the name the person gave it (else the known name, else the account's name).
      const typed = $q("name").value.trim();
      const label = typed || state.label || (byAccount.size === 1 && pmById([...byAccount.keys()][0]) ? pmById([...byAccount.keys()][0]).nickname : "") || "";
      const accountsToSave = multi() ? { ...state.map } : { "*": state.accountId };
      callApi("saveStatementFormat", { signature: sig, label, accounts: accountsToSave, categories: { ...state.catSaved, ...withoutSkips(state.catChoice), ...renameFlags() },
        mapping: { date: m.date, description: m.description, amount: m.amount, out: m.out, in: m.in, currency: m.currency, account: m.account, category: m.category, type: m.type,
          dateOrder: m.dateOrder, decimal: m.decimal, sign: m.sign, currencyFixed: m.currencyFixed, source: m.source || "" } }).catch(() => {});
      // A re-read of the same file replaces its earlier reading.
      usable = usable.filter((u) => (u.group || u.file) !== file.name);
      results.forEach((r) => usable.push({ file: r.name, group: file.name, result: r.result, inboxId: "" }));
      historyPlan = null;
      $("statement-history").innerHTML = "";
      updateReviewButton();
      body.innerHTML = results.map(() => `<div class="tm-result"></div>`).join("");
      results.forEach((r, i) => renderResult(body.children[i], r.result, null, file, byAccount.size > 1 ? r.name : ""));
    });
    renderValues();
    loadCategories();
    syncControlsFromState();
    setVal("out", state.m.out); setVal("in", state.m.in); setVal("amount", state.m.amount); setVal("desc", state.m.description); setVal("date", state.m.date); setVal("currency", state.m.currency);
    setVal("acol", state.m.account); setVal("cat", state.m.category); setVal("type", state.m.type);
    if (state.accountId && !remembered) applyAccountGuess();
    syncControlsFromState();
    renderPreview();
  }

  async function handleStatementFiles(files) {
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    for (const f of Array.from(files)) {   // one at a time: easy on a phone's memory
      if (screenMode === "import" && !isTableFile(f)) {
        const body = resultCardShell(f.name);
        body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("imp.blockedPdf"))}</p>
          <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice imp-go">${escapeHtml(tr("imp.openStatements"))}</button></div>`;
        body.querySelector(".imp-go").addEventListener("click", () => { showStatementsScreen("bank"); window.scrollTo(0, 0); });
        continue;
      }
      await (isTableFile(f) ? readTableFile(f) : readStatementFile(f));
    }
  }

  // ---- review (read-only) ----

  // (The name is from before the steps: it now refreshes the counts, the "Next" buttons and the step pills.)
  function updateReviewButton() {
    updateStepUi();
  }

  // What the server is sent for an analysis (never the file): each statement's account key, period, balances and lines.
  function statementsForAnalysis() {
    return usable.map(({ result }) => ({
      key: accountKeyOf(result),
      kind: result.kind,
      source: result.source || "",   // "app" = an app's export: no bank-wording rules on the server
      bank: result.bank || "", accountLast4: (result.account && result.account.last4) || "",   // an account the app does not have yet is proposed from these (never a full number)
      holder: result.holder || "",   // the name printed on the statement: how the app learns the person's own name (backend/OwnerNames.gs)
      period: result.period,
      balances: result.balances,
      verified: !!(result.ok && result.verified !== false),
      lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section, category: l.category, transfer: l.transfer }))
    }));
  }

  // ---- "Fill my history": one approval for everything, no per-line choices (backend/StatementHistory.gs) ----

  let historyPlan = null;   // { actions, summary } from planStatementHistory, for the statements read right now

  async function runHistoryPlan() {
    const btn = $("statement-history-btn");
    const out = $("statement-history");
    btn.disabled = true;
    $("statement-review-status").innerHTML = "";   // an old "Saved" / "Undone" message is not about this run
    $("statement-plan-status").innerHTML = "";
    out.innerHTML = loadingHtml(tr("hist.planning")) + `<p class="hint">${escapeHtml(tr("hist.keepOpen"))}</p>`;
    try {
      historyPlan = await callApi("planStatementHistory", { statements: statementsForAnalysis() });
      historyPlan.platform = new Map();    // index into summary.aside -> investment platform the person picked (else the guess is used)
      historyPlan.incMode = new Map();     // index into summary.incomeLines -> "transfer" | "investment" | "review" | "leave" (absent = income, the default)
      historyPlan.outMode = new Map();     // index into summary.peopleOut -> "review" or "leave" (absent = spending, the default)
      historyPlan.openPeople = new Set();  // people whose lines are showing
      historyPlan.chosen = new Map();      // index into summary.aside -> "cash" (spending/income) or "transfer", what the person counted after all
      historyPlan.exchanges = [];          // lines linked as a currency exchange: { out: {stmt, line}, in: {stmt, line} }
      historyPlan.openGroups = new Set();  // groups of similar lines whose individual lines are showing
      historyPlan.asideOpen = false;
      // A line that looks like an entry already in the app goes to Needs review by default (the person decides there whether it is
      // a duplicate); tapping the button again leaves it out instead.
      (historyPlan.summary.aside || []).forEach((a, i) => { if (a.reason === "possible" && a.optInReview) historyPlan.chosen.set(i, "review"); });
      historyPlan.bal = new Set();         // balance checks (index into historyPlan.checks) the person wants set from the statement
      historyPlan.checks = balanceChecks(historyPlan.balance_checks || []);
      renderHistoryPlan();
    } catch (err) {
      historyPlan = null;
      out.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("hist.planFailed"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- balances: what each account's balance would become, from the statements read ----
  // One statement per account and currency can set the balance: the NEWEST one (an older one would be replaced by it at once, and the
  // gap it reports is measured from the balance on file, so two together would count the same difference twice). The older ones only
  // show whether the app agreed with the bank on their date.
  function balanceChecks(checks) {
    const newest = {};
    checks.forEach((c) => {
      const k = accountKeyOf(usable[c.stmt].result) + "|" + c.currency;
      if (!newest[k] || c.end > newest[k].end) newest[k] = c;
    });
    return checks.map((c) => ({ ...c, newest: newest[accountKeyOf(usable[c.stmt].result) + "|" + c.currency] === c }));
  }

  function balanceAction(c) {
    return c.direction === "forward" && typeof c.unexplained === "number"
      ? { type: "set_balance", stmt: c.stmt, currency: c.currency, gap: c.unexplained, app_balance: c.appAtEnd }
      : { type: "set_balance", stmt: c.stmt, currency: c.currency };
  }

  function settableChecks() { return historyPlan.checks.map((c, i) => ({ c, i })).filter(({ c }) => c.canSet && c.newest); }

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
    const taken = {}, takenOut = {}, takenInc = {};
    p.chosen.forEach((mode, i) => { taken[lineKey(aside[i])] = true; });
    const outs = p.summary.peopleOut || [], incs = p.summary.incomeLines || [];
    p.outMode.forEach((mode, j) => { takenOut[lineKey(outs[j])] = true; });
    p.incMode.forEach((mode, k) => { takenInc[lineKey(incs[k])] = true; });
    const kept = p.actions.filter((a) => {
      if (a.stmt === undefined) return true;                 // a transfer pair carries out/in instead of stmt/line
      const k = lineKey(a);
      return !linked[k] && !(a.type === "wait" && taken[k]) && !(a.type === "add_history_expense" && takenOut[k]) && !(a.type === "add_history_income" && takenInc[k]);
    });
    const optIns = [];
    // The action each choice stands for on a line that is counted by default (a payment you made to a person, or income).
    const choiceAction = (line, mode) => (mode === "transfer" ? line.optInTransfer : mode === "investment" ? line.optInInvestment : mode === "review" ? line.optInReview : line.optInLeave);
    p.outMode.forEach((mode, j) => { const action = choiceAction(outs[j], mode); if (action && !linked[lineKey(action)]) optIns.push(action); });
    p.incMode.forEach((mode, k) => { const action = choiceAction(incs[k], mode); if (action && !linked[lineKey(action)]) optIns.push(action); });
    p.chosen.forEach((mode, i) => {
      let action = mode === "transfer" ? aside[i].optInTransfer : mode === "investment" ? aside[i].optInInvestment : mode === "review" ? aside[i].optInReview : aside[i].optIn;
      if (action && mode === "investment") action = { ...action, platformId: platformOf(i) };
      if (action && !linked[lineKey(action)]) optIns.push(action);
    });
    const exchanges = p.exchanges.map((x) => ({ type: "record_exchange", out: { stmt: x.out.stmt, line: x.out.line }, in: { stmt: x.in.stmt, line: x.in.line } }));
    const balances = settableChecks().filter(({ i }) => p.bal.has(i)).map(({ c }) => balanceAction(c));   // after the entries, as the apply expects
    return kept.concat(optIns, exchanges, balances);
  }

  // What the summary shows, worked out from the final list of actions so it always matches what will be saved.
  function historyCounts() {
    const c = { expenses: 0, income: 0, refunds: 0, refundIncome: 0, transfers: 0, legs: 0, investments: 0, pendingInvestments: 0, pending: 0, left: 0, exchanges: 0, fees: 0, linked: 0, balances: 0, spent: {} };
    historyActions().forEach((a) => {
      if (a.type === "add_history_expense") {
        const l = usable[a.stmt].result.lines[a.line];
        c.expenses++;
        c.spent[l.currency] = Math.round(((c.spent[l.currency] || 0) + Math.abs(l.amount)) * 100) / 100;
      } else if (a.type === "add_history_income") c.income++;
      else if (a.type === "add_history_reversal") c.refunds++;
      else if (a.type === "add_history_refund") c.refundIncome++;
      else if (a.type === "record_transfer") c.transfers++;
      else if (a.type === "record_transfer_leg") c.legs++;
      else if (a.type === "add_history_investment") { c.investments++; if (!a.platformId) c.pendingInvestments++; }
      else if (a.type === "add_history_pending") c.pending++;
      else if (a.type === "ignore") c.left++;
      else if (a.type === "record_exchange") c.exchanges++;
      else if (a.type === "record_fee") c.fees++;
      else if (a.type === "set_balance") c.balances++;
      else if (["link", "assign_account", "complete_transfer"].includes(a.type)) c.linked++;
    });
    c.entries = c.expenses + c.income + c.refunds + c.refundIncome + c.transfers + c.legs + c.investments + c.pending + 2 * c.exchanges + c.fees;
    c.reviewTotal = c.legs + c.pending + c.pendingInvestments;   // entries that will wait in Needs review for the person to finish
    return c;
  }

  // ---- currency exchange: two lines in different currencies recorded as an exchange, not an expense and an income ----

  function pairTitle(out, inn) { return `${fmtMoney(out.currency, Math.abs(out.amount))} → ${fmtMoney(inn.currency, inn.amount)}`; }
  function pairSub(out, inn) {
    return `${escapeHtml(fmtDate(out.date, true))} “${escapeHtml(out.description)}” · ${escapeHtml(out.account)} / ${escapeHtml(fmtDate(inn.date, true))} “${escapeHtml(inn.description)}” · ${escapeHtml(inn.account)}`;
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
        ? shown.map((c, i) => `<button type="button" class="stmt-match-row" data-i="${i}">${escapeHtml(fmtDate(c.date, true))} · ${escapeHtml(c.description)} · ${escapeHtml(fmtMoney(c.currency, c.amount))} · ${escapeHtml(c.account)}</button>`).join("")
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
  // Each line can be counted as spending/income, as a transfer (one side of it; the other end completes when that account's
  // statement arrives) or as an investment (money into a platform, or a withdrawal). `chosen` maps the line's index in
  // summary.aside to "cash", "transfer" or "investment"; `platform` holds the platform picked for an investment (else the guess).

  function modeButton(attrs, on, label) {
    return `<button type="button" class="stmt-choice ${on ? "on" : ""}" ${attrs}>${on ? "✓ " : ""}${escapeHtml(label)}</button>`;
  }

  function platformSelect(attrs, current) {
    const platforms = historyPlan.summary.platforms || [];
    if (!platforms.length) return "";
    return `<select class="stmt-platform" ${attrs} style="margin-top:6px"><option value="">${escapeHtml(tr("hist.aside.platformNone"))}</option>${platforms.map((pl) => `<option value="${escapeHtml(pl.id)}" ${pl.id === current ? "selected" : ""}>${escapeHtml(pl.name)}</option>`).join("")}</select>`;
  }

  function platformOf(i) {
    const p = historyPlan, a = p.summary.aside[i];
    return p.platform.has(i) ? p.platform.get(i) : ((a.optInInvestment && a.optInInvestment.platformId) || "");
  }

  function asideHtml() {
    const p = historyPlan, aside = p.summary.aside || [], chosen = p.chosen;
    const shown = aside.filter((a) => a.reason !== "person");   // people have their own group above
    if (!shown.length) return "";
    const rendered = {};
    const rows = aside.map((a, i) => {
      if (a.reason === "person") return "";
      const inflow = a.amount > 0;
      const cashLabel = tr(inflow ? "hist.aside.addIncome" : "hist.aside.addExpense");
      const invLabel = tr(inflow ? "hist.aside.addWithdrawal" : "hist.aside.addInvestment");
      const maybe = a.maybe ? `<div class="stmt-line-sub" style="padding-left:0">${escapeHtml(tr("hist.aside.maybe", { entry: `${fmtDate(a.maybe.date, true)} · ${a.maybe.description || ""} · ${fmtMoney(a.maybe.currency, a.maybe.amount)}${a.maybe.account ? " · " + a.maybe.account : ""}` }))}</div>` : "";
      const buttonsFor = (m, mi) => (m.optIn ? modeButton(`data-aside="${mi}" data-mode="cash"`, chosen.get(mi) === "cash", cashLabel) : "")
        + modeButton(`data-aside="${mi}" data-mode="transfer"`, chosen.get(mi) === "transfer", tr("hist.aside.addTransfer"))
        + (m.optInInvestment ? modeButton(`data-aside="${mi}" data-mode="investment"`, chosen.get(mi) === "investment", invLabel) : "")
        + (m.optInReview ? modeButton(`data-aside="${mi}" data-mode="review"`, chosen.get(mi) === "review", tr("hist.people.review")) : "");
      if (a.group) {
        if (rendered[a.group]) return "";
        rendered[a.group] = true;
        const members = aside.map((m, mi) => ({ m, mi })).filter(({ m }) => m.group === a.group);
        const allIn = (mode) => members.every(({ mi }) => chosen.get(mi) === mode);
        const amounts = members.map(({ m }) => Math.abs(m.amount));
        const sum = members.reduce((t, { m }) => t + m.amount, 0);
        const lo = Math.min(...amounts), hi = Math.max(...amounts);
        const range = lo === hi ? fmtMoney(a.currency, lo) : `${fmtMoney(a.currency, lo)} – ${fmtMoney(a.currency, hi).replace(/^[A-Z]{3} /, "")}`;
        const n = members.length;
        const groupButtons = (a.optIn ? modeButton(`data-agroup="${a.group}" data-mode="cash"`, allIn("cash"), tr(inflow ? "hist.aside.addAllIncome" : "hist.aside.addAllExpense", { n })) : "")
          + modeButton(`data-agroup="${a.group}" data-mode="transfer"`, allIn("transfer"), tr("hist.aside.addAllTransfer", { n }))
          + (a.optInInvestment ? modeButton(`data-agroup="${a.group}" data-mode="investment"`, allIn("investment"), tr(inflow ? "hist.aside.addAllWithdrawal" : "hist.aside.addAllInvestment", { n })) : "");
        const groupPlatform = allIn("investment") ? platformSelect(`data-pgroup="${a.group}"`, platformOf(members[0].mi)) : "";
        // The same lines one by one, for a person who does not want them decided together: each has its own buttons.
        const each = members.map(({ m, mi }) => lineRow({ date: m.date, description: m.description, amount: m.amount, currency: m.currency },
          `<div class="stmt-choices" style="padding-left:0">${buttonsFor(m, mi)}</div>${chosen.get(mi) === "investment" ? platformSelect(`data-pidx="${mi}"`, platformOf(mi)) : ""}`)).join("");
        const opened = p.openGroups.has(a.group);
        return lineRow({ date: a.date, description: `${a.description} × ${n}`, amount: sum, currency: a.currency },
          `${escapeHtml(tr("hist.aside.groupSub", { n, amounts: range, account: a.account }))}<div class="stmt-choices" style="padding-left:0">${groupButtons}</div>${groupPlatform}
            <details data-gopen="${a.group}" ${opened ? "open" : ""}><summary class="hint">${escapeHtml(tr("hist.aside.showEach", { n }))}</summary>${each}</details>`);
      }
      const buttons = `<div class="stmt-choices" style="padding-left:0">${buttonsFor(a, i)}</div>${chosen.get(i) === "investment" ? platformSelect(`data-pidx="${i}"`, platformOf(i)) : ""}`;
      return lineRow({ date: a.date, description: a.description, amount: a.amount, currency: a.currency }, `${escapeHtml(a.account)}${maybe}${buttons}`);
    }).join("");
    return `<details class="stmt-group" id="statement-history-aside" ${p.asideOpen ? "open" : ""}><summary>${escapeHtml(tr("hist.aside.title", { n: shown.length }))}</summary>
      <p class="hint">${escapeHtml(tr("hist.aside.hint"))}</p>${rows}</details>`;
  }

  // ---- "Payments with people": wallet payments (Yape, Plin…) grouped by person ----
  // What YOU paid is spending by default (it can be sent to Needs review or left out); what THEY paid you is not counted by default
  // (it can be counted as income or sent to Needs review). Opening a person shows each line with its own buttons, and a person has
  // bulk buttons for all of their lines in one direction.

  function sumLabel(list) {
    const by = {};
    list.forEach((x) => { by[x.currency] = (by[x.currency] || 0) + Math.abs(Number(x.amount)); });
    return Object.keys(by).sort().map((cur) => fmtMoney(cur, Math.round(by[cur] * 100) / 100)).join(" + ");
  }

  function peopleGroups() {
    const p = historyPlan, aside = p.summary.aside || [], outs = p.summary.peopleOut || [];
    const map = new Map();
    const get = (key, name) => { if (!map.has(key)) map.set(key, { key, name, out: [], inn: [] }); return map.get(key); };
    outs.forEach((o, j) => get(o.person, o.personName).out.push(j));
    aside.forEach((a, i) => { if (a.reason === "person") get(a.person, a.personName).inn.push(i); });
    const groups = Array.from(map.values());
    groups.forEach((g) => {
      g.total = g.out.reduce((t, j) => t + Math.abs(outs[j].amount), 0) + g.inn.reduce((t, i) => t + Math.abs(aside[i].amount), 0);
    });
    groups.sort((x, y) => (x.key === "" ? 1 : 0) - (y.key === "" ? 1 : 0) || y.total - x.total);   // "other wallet payments" last
    return groups;
  }

  function peopleHtml() {
    const p = historyPlan, aside = p.summary.aside || [], outs = p.summary.peopleOut || [];
    const groups = peopleGroups();
    if (!groups.length) return "";
    const nLines = groups.reduce((t, g) => t + g.out.length + g.inn.length, 0);
    const rows = groups.map((g) => {
      const outLines = g.out.map((j) => outs[j]), inLines = g.inn.map((i) => aside[i]);
      const parts = [];
      if (g.out.length) parts.push(tr("hist.people.sumOut", { n: g.out.length, amount: sumLabel(outLines) }));
      if (g.inn.length) parts.push(tr("hist.people.sumIn", { n: g.inn.length, amount: sumLabel(inLines) }));
      const bulk = (dir, mode, label, idx, state) => modeButton(`data-pbulk="${escapeHtml(g.key)}" data-dir="${dir}" data-mode="${mode}"`, idx.length > 0 && idx.every(state), label);
      const outBulk = g.out.length
        ? bulk("out", "review", tr("hist.people.allOutReview", { n: g.out.length }), g.out, (j) => p.outMode.get(j) === "review")
          + bulk("out", "transfer", tr("hist.people.allOutTransfer", { n: g.out.length }), g.out, (j) => p.outMode.get(j) === "transfer")
          + bulk("out", "leave", tr("hist.people.allOutLeave", { n: g.out.length }), g.out, (j) => p.outMode.get(j) === "leave") : "";
      const inBulk = g.inn.length
        ? bulk("in", "cash", tr("hist.people.allInIncome", { n: g.inn.length }), g.inn, (i) => p.chosen.get(i) === "cash")
          + bulk("in", "transfer", tr("hist.people.allInTransfer", { n: g.inn.length }), g.inn, (i) => p.chosen.get(i) === "transfer")
          + bulk("in", "review", tr("hist.people.allInReview", { n: g.inn.length }), g.inn, (i) => p.chosen.get(i) === "review") : "";
      const outRows = g.out.map((j) => {
        const o = outs[j], m = p.outMode.get(j);
        return lineRow({ date: o.date, description: o.description, amount: o.amount, currency: o.currency },
          `${escapeHtml(o.account)}<div class="stmt-choices" style="padding-left:0">${modeButton(`data-pout="${j}" data-mode="spending"`, !m, tr("hist.people.spending"))}${modeButton(`data-pout="${j}" data-mode="transfer"`, m === "transfer", tr("hist.aside.addTransfer"))}${modeButton(`data-pout="${j}" data-mode="investment"`, m === "investment", tr("hist.aside.addInvestment"))}${modeButton(`data-pout="${j}" data-mode="review"`, m === "review", tr("hist.people.review"))}${modeButton(`data-pout="${j}" data-mode="leave"`, m === "leave", tr("hist.people.leave"))}</div>`);
      }).join("");
      const inRows = g.inn.map((i) => {
        const a = aside[i], m = p.chosen.get(i);
        return lineRow({ date: a.date, description: a.description, amount: a.amount, currency: a.currency },
          `${escapeHtml(a.account)}<div class="stmt-choices" style="padding-left:0">${modeButton(`data-aside="${i}" data-mode="cash"`, m === "cash", tr("hist.aside.addIncome"))}${modeButton(`data-aside="${i}" data-mode="transfer"`, m === "transfer", tr("hist.aside.addTransfer"))}${modeButton(`data-aside="${i}" data-mode="investment"`, m === "investment", tr("hist.aside.addWithdrawal"))}${modeButton(`data-aside="${i}" data-mode="review"`, m === "review", tr("hist.people.review"))}</div>${m === "investment" ? platformSelect(`data-pidx="${i}"`, platformOf(i)) : ""}`);
      }).join("");
      const name = g.name || tr("hist.people.other");
      return `<details class="stmt-group" data-ppkey="${escapeHtml(g.key)}" ${p.openPeople.has(g.key) ? "open" : ""}><summary>${escapeHtml(name)} <span class="stmt-count">${g.out.length + g.inn.length}</span></summary>
        <p class="hint">${escapeHtml(parts.join(" · "))}</p>
        <div class="stmt-choices" style="padding-left:0">${outBulk}${inBulk}</div>${outRows}${inRows}</details>`;
    }).join("");
    return `<details class="stmt-group" id="statement-history-people" ${p.peopleOpen ? "open" : ""}><summary>${escapeHtml(tr("hist.people.title", { n: nLines }))}</summary>
      <p class="hint">${escapeHtml(tr("hist.people.hint"))}</p>${rows}</details>`;
  }

  // ---- "Income lines": income that is counted by default (a salary…) can be classified in any other way too ----

  function incomeHtml() {
    const p = historyPlan, incs = p.summary.incomeLines || [];
    if (!incs.length) return "";
    const rows = incs.map((l, k) => {
      const m = p.incMode.get(k);
      return lineRow({ date: l.date, description: l.description, amount: l.amount, currency: l.currency },
        `${escapeHtml(l.account)}<div class="stmt-choices" style="padding-left:0">${modeButton(`data-pinc="${k}" data-mode="income"`, !m, tr("hist.income.income"))}${modeButton(`data-pinc="${k}" data-mode="transfer"`, m === "transfer", tr("hist.aside.addTransfer"))}${modeButton(`data-pinc="${k}" data-mode="investment"`, m === "investment", tr("hist.aside.addWithdrawal"))}${modeButton(`data-pinc="${k}" data-mode="review"`, m === "review", tr("hist.people.review"))}${modeButton(`data-pinc="${k}" data-mode="leave"`, m === "leave", tr("hist.people.leave"))}</div>`);
    }).join("");
    return `<details class="stmt-group" id="statement-history-income" ${p.incomeOpen ? "open" : ""}><summary>${escapeHtml(tr("hist.income.title", { n: incs.length }))}</summary>
      <p class="hint">${escapeHtml(tr("hist.income.hint"))}</p>${rows}</details>`;
  }

  function acctOfCheck(c) {
    const r = usable[c.stmt].result;
    return c.accountName || accountKeyOf(r);
  }

  // One row per statement and currency: the closing balance, what the app showed that day, the difference and what it is made of.
  function balanceRowHtml(c, i) {
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
      if (c.canSet && c.newest && c.direction === "forward" && c.unexplained) verdict += `<p class="hint">${escapeHtml(tr("gaps.willNote", { amount: signed(c.currency, c.unexplained) }))}</p>`;
    }
    let choice = "";
    if (c.canSet && !c.newest) choice = `<p class="hint">${escapeHtml(tr("bal.olderHere"))}</p>`;
    else if (c.canSet) choice = `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-bal="${i}"`, historyPlan.bal.has(i), tr(c.direction === "untracked" ? "stmt.choice.startTracking" : "stmt.choice.setBalance"))}</div>`;
    return `<div class="stmt-line2"><div class="stmt-pair-title">${escapeHtml(acctOfCheck(c))} · ${escapeHtml(c.currency)}</div>${lines.join("")}${verdict}${choice}</div>`;
  }

  function balancesHtml() {
    const p = historyPlan, checks = p.checks || [];
    if (!checks.length) return "";
    const can = settableChecks();
    const allOn = can.length > 0 && can.every(({ i }) => p.bal.has(i));
    const all = can.length > 1 ? `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-balall="1"`, allOn, tr("bal.setAll", { n: can.length }))}</div>` : "";
    return `<details class="stmt-group" id="statement-history-balances" ${p.balOpen ? "open" : ""}><summary>${escapeHtml(tr("bal.title", { n: checks.length }))}</summary>
      <p class="hint">${escapeHtml(tr("bal.hint"))}</p>${all}${checks.map((c, i) => balanceRowHtml(c, i)).join("")}</details>`;
  }

  // ---- accounts the statements name that the app does not have yet (backend/StatementAccounts.gs) ----
  // The plan proposes them with defaults; one tap adds them and reads the statements again. They can be changed afterwards in
  // More → Accounts, cards & platforms, which is where the "added" note points.
  let addedAccounts = [];   // accounts added from the statements on this screen: [{ id, nickname }]

  function newAccountsHtml(proposals) {
    if (!proposals.length) return "";
    const items = proposals.map((a) => `<li><strong>${escapeHtml(a.nickname)}</strong> · ${escapeHtml(tr(a.type === "credit" ? "acct.typeCredit" : "acct.typeDebit"))} · ${escapeHtml(a.bank)} · …${escapeHtml(a.last4)}</li>`).join("");
    return `<div class="stmt-new-accounts" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px">
      <p class="stmt-verdict warn" style="margin-top:0">${escapeHtml(tr("acct.newTitle", { n: proposals.length }))}</p>
      <ul style="list-style:disc;margin:6px 0;padding-left:20px">${items}</ul>
      <p class="hint">${escapeHtml(tr("acct.newHint", { n: proposals.length }))}</p>
      <button type="button" class="primary" id="statement-add-accounts">${escapeHtml(tr("acct.addBtn", { n: proposals.length }))}</button></div>`;
  }

  function addedAccountsHtml() {
    if (!addedAccounts.length) return "";
    return `<div class="stmt-note ok" style="margin-bottom:12px"><p style="margin:0 0 6px">${escapeHtml(tr("acct.added", { n: addedAccounts.length, names: addedAccounts.map((a) => a.nickname).join(", ") }))}</p>
      <p class="hint" style="margin:0 0 6px">${escapeHtml(tr("acct.addedHint"))}</p>
      <button type="button" class="add-inline" id="statement-open-accounts">${escapeHtml(tr("acct.review"))}</button></div>`;
  }

  async function addProposedAccounts() {
    const btn = $("statement-add-accounts");
    if (!btn || !historyPlan) return;
    const proposals = (historyPlan.summary && historyPlan.summary.newAccounts) || [];
    btn.disabled = true;
    btn.textContent = tr("acct.adding");
    try {
      const res = await callApi("createStatementAccounts", { accounts: proposals.map((a) => ({ last4: a.last4, bank: a.bank, kind: a.kind })) });
      addedAccounts = addedAccounts.concat(res.created || []);
      if (typeof loadMeta === "function") await loadMeta();   // the new accounts are known to the rest of the app from now on
      await runHistoryPlan();                                   // the statements are read again, now with their account
    } catch (err) {
      btn.disabled = false;
      btn.textContent = tr("acct.addBtn", { n: proposals.length });
      alert(err.message || String(err));
    }
  }

  function renderHistoryPlan() {
    const out = $("statement-history");
    const { actions, summary } = historyPlan;
    const left = summary.leftOut, c = historyCounts();
    const lines = [];
    if (c.expenses) lines.push(tr("hist.sum.expenses", { n: c.expenses, total: moneyTotals(c.spent) }));
    if (c.income) lines.push(tr("hist.sum.income", { n: c.income }));
    if (c.refunds) lines.push(tr("hist.sum.refunds", { n: c.refunds }));
    if (c.refundIncome) lines.push(tr("hist.sum.refundIncome", { n: c.refundIncome }));
    if (c.transfers) lines.push(tr("hist.sum.transfers", { n: c.transfers }));
    if (c.legs) lines.push(tr("hist.sum.legs", { n: c.legs }));
    if (c.investments) lines.push(tr("hist.sum.investments", { n: c.investments }));
    if (c.exchanges) lines.push(tr("hist.sum.exchanges", { n: c.exchanges }));
    if (c.fees) lines.push(tr("hist.sum.fees", { n: c.fees }));
    if (c.pending) lines.push(tr("hist.sum.pending", { n: c.pending }));
    if (c.left) lines.push(tr("hist.sum.left", { n: c.left }));
    if (c.linked) lines.push(tr("hist.sum.linked", { n: c.linked }));
    if (c.balances) lines.push(tr("hist.sum.balances", { n: c.balances }));
    const proposals = summary.newAccounts || [];
    const proposedKeys = new Set(proposals.map((p) => p.key));
    const stillUnknown = (summary.unknownAccounts || []).filter((k) => !proposedKeys.has(k));
    const notes = [];
    if (c.reviewTotal) notes.push(tr("hist.sum.pendingTotal", { n: c.reviewTotal }));
    if (left.waiting) notes.push(tr("hist.left.waiting", { n: left.waiting }));
    if (left.possible) notes.push(tr("hist.left.possible", { n: left.possible }));
    if (left.noAccount && stillUnknown.length) notes.push(tr("hist.left.noAccount", { n: left.noAccount, keys: stillUnknown.join(", ") }));
    if (left.handled) notes.push(tr("hist.left.handled", { n: left.handled }));
    const pre = newAccountsHtml(proposals) + addedAccountsHtml();
    const noteHtml = notes.map((t) => `<p class="stmt-note info">${escapeHtml(t)}</p>`).join("") + peopleHtml() + incomeHtml() + asideHtml() + (summary.candidates.length ? exchangeHtml() : "") + balancesHtml();
    if (!actions.length && !(summary.aside || []).length && !(summary.peopleOut || []).length && !(historyPlan.checks || []).length) {
      out.innerHTML = pre + (proposals.length ? "" : `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>`) + noteHtml;
      return;
    }
    if (!c.entries) {
      // Nothing to add. Lines waiting for their other statement can still be remembered so they pair up later, and balances set.
      out.innerHTML = pre + `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>${lines.length ? `<ul style="list-style:disc;margin:6px 0;padding-left:20px">${lines.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}${noteHtml}
        ${historyActions().length ? `<button type="button" class="${c.balances ? "primary" : "stmt-choice"}" id="statement-history-save">${escapeHtml(tr(c.balances ? "hist.saveBalances" : "hist.remember"))}</button>` : ""}`;
      return;
    }
    const range = summary.from && summary.to ? `<p class="hint">${escapeHtml(tr("hist.range", { from: fmtDate(summary.from, true), to: fmtDate(summary.to, true) }))}</p>` : "";
    out.innerHTML = pre + `<p class="stmt-verdict good">${escapeHtml(tr("hist.ready"))}</p>
      <ul style="list-style:disc;margin:6px 0;padding-left:20px">${lines.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      ${range}<p class="hint">${escapeHtml(tr(usable.some((u) => u.result.lines.some((l) => l.category)) ? "hist.noCategoryUnlessNamed" : "hist.noCategory"))}</p>${noteHtml}
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
    btn.insertAdjacentHTML("afterend", loadingHtml(tr("hist.saving")));   // right where the person tapped, not in a box further down
    btn.hidden = true;
    status.innerHTML = "";
    const payload = (dryRun) => ({
      dryRun,
      filename: `History ${usable.map((u) => u.file).join(", ")}`.slice(0, 200),
      statements: usable.map(({ file, result }) => ({
        key: accountKeyOf(result), kind: result.kind, source: result.source || "", period: result.period, file_name: file,
        verified: !!(result.ok && result.verified !== false), balances: result.balances,
        lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section, category: l.category, transfer: l.transfer }))
      })),
      inboxIds: usable.map((u) => u.inboxId).filter(Boolean),
      categoryMap: Object.assign({}, ...usable.map((u) => u.result.categoryMap || {})),
      categoryNames: Object.assign({}, ...usable.map((u) => u.result.categoryNames || {})),   // the name each of those categories should carry   // the person's choice for each category name of a spreadsheet
      actions: historyActions()
    });
    try {
      await callApi("applyStatementDecisions", payload(true));   // validates first, writes nothing
      const res = await callApi("applyStatementDecisions", payload(false));
      lastBatchId = res.batchId;
      const made = res.created.transfers + res.created.fees + res.created.purchases + (res.created.income || 0) + (res.created.reversals || 0) + (res.created.investments || 0) + (res.created.pending || 0);
      // Say what did NOT happen too: entries waiting for the person in Needs review, and lines that were not added.
      const used = new Set(historyActions().filter((a) => a.type !== "wait" && a.stmt !== undefined).map(lineKey));
      const notAdded = (historyPlan.summary.aside || []).filter((a) => !used.has(lineKey(a))).length + historyCounts().left;
      const waiting = res.pendingCount || 0;
      const outcome = (waiting ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedPending", { n: waiting }))}</p><div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-goreview-btn">${escapeHtml(tr("added.goReview"))}</button></div>` : "")
        + (notAdded ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedNotAdded", { n: notAdded }))}</p>` : "")
        + (res.categoriesGuessed ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedGuessed", { n: res.categoriesGuessed }))}</p>` : "")
        + (res.categoriesFiled ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategories", { n: res.categoriesFiled }))}</p>` : "")
        + ((res.categoriesRenamed || []).length ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesRenamed", { n: res.categoriesRenamed.length, names: res.categoriesRenamed.map((r) => `${r.from} → ${r.to}`).join(", ") }))}</p>` : "")
        + ((res.categoriesCreatedNames || []).length ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesCreated", { n: res.categoriesCreatedNames.length, names: res.categoriesCreatedNames.join(", ") }))}</p>` : "")
        + (res.categoriesMissed ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesMissed", { n: res.categoriesMissed, names: (res.categoryMissedNames || []).join(", ") }))}</p>` : "");
      status.innerHTML = `<div class="stmt-result"><p class="stmt-verdict good">${escapeHtml(made ? tr("hist.saved", { n: made }) : tr("stmt.saved"))}</p>
        ${addedAccountsHtml()}${outcome}${rateNeedsHtml(res.rateNeeds)}
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-added-btn" data-batch="${escapeHtml(res.batchId)}">${escapeHtml(tr("added.button"))}</button>${(res.created.purchases || 0) > 0 ? `<button type="button" class="stmt-choice stmt-tidy-btn">${escapeHtml(tr("tidy.fromStatements"))}</button>` : ""}</div>
        <button type="button" class="cancel-edit-btn" id="stmt-undo-btn">${escapeHtml(tr("stmt.undoUpload"))}</button></div>`;
      historyPlan = null;
      addedAccounts = [];
      $("statement-history").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementGaps();
      refreshStatementBatches();
      refreshStatementInbox();
      refreshOtherScreens();
      savedThisRun = true;
      showStep(4);
    } catch (err) {
      // The failure stays on the Preview step, where the Add button is.
      $("statement-plan-status").innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.nothingSaved"))}</p><p class="hint">${escapeHtml(err.message)}</p>`;
      renderHistoryPlan();   // brings the Add button back and drops the loading line
    }
  }

  function lineRow(l, sub) {
    return `<div class="stmt-line2">
      <div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>
      ${sub ? `<div class="stmt-line-sub">${sub}</div>` : ""}
    </div>`;
  }

  function signed(cur, n) {
    return `${cur} ${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  async function refreshOtherScreens() {
    // A save or an undo can create categories on the server ("Bank fees", "Refunds", "Investments"); the phone only knows the ones
    // it loaded at start, so entries in a new one would show as "(unknown category)" until the app is reloaded. Load them again first.
    try { if (typeof loadMeta === "function") await loadMeta(); } catch (e) { /* the lists still refresh */ }
    ["refreshReviewQueue", "refreshEntryList", "refreshExpectedRecurring", "refreshBalances"].forEach((n) => {
      try { if (typeof window[n] === "function") { const r = window[n](); if (r && r.catch) r.catch(() => {}); } } catch (e) { /* best effort */ }
    });
  }

  // ---- "See what it added": the entries one upload created, grouped, each one opening the normal entry screen ----

  let addedBatch = null;

  function addedGroupOf(e) {
    if (e.status === "pending") return "pending";   // not counted yet: it waits for the person in Needs review
    const cat = typeof findCategory === "function" ? findCategory(e.category_id) : null;
    const key = cat ? String(cat.key || "") : "";   // the key, not the name: the name can be shown in Spanish
    if (e.type === "investment") return "investments";
    if (e.type === "transfer") return e.payment_method_id && e.to_payment_method_id ? "transfers" : "openTransfers";
    if (e.type === "income") return key === "refunds" ? "refundIncome" : "income";
    if (Number(e.amount) < 0) return "refunds";
    return key === "bank_fees" ? "fees" : "spending";
  }

  // The sign a pending entry reads with: money in is +, money out is −. A transfer with only its "To" filled came in; an investment stored
  // negative is a withdrawal (money back).
  function pendingSigned(e) {
    const a = Math.abs(Number(e.amount));
    if (e.type === "income") return a;
    if (e.type === "transfer") return e.to_payment_method_id && !e.payment_method_id ? a : -a;
    if (e.type === "investment") return Number(e.amount) < 0 ? a : -a;
    return -a;
  }

  const ADDED_ORDER = ["pending", "spending", "income", "refunds", "refundIncome", "transfers", "openTransfers", "investments", "fees"];

  async function loadAdded() {
    const body = $("statement-added-body");
    const [entries, details] = await Promise.all([
      callApi("listEntries", { importBatchId: addedBatch }),
      callApi("getStatementBatchDetails", { batchId: addedBatch })
    ]);
    if (addedBatch === null) return;   // closed while loading
    // An upload can have created a category this phone has not loaded yet (Refunds, Bank fees): load them before naming groups.
    if (entries.some((e) => e.category_id && typeof findCategory === "function" && !findCategory(e.category_id))) { try { await loadMeta(); } catch (err) { /* groups fall back to plain income/spending */ } }
    const groups = {};
    entries.forEach((e) => { (groups[addedGroupOf(e)] = groups[addedGroupOf(e)] || []).push(e); });
    const money = (list) => {
      const by = {};
      list.forEach((e) => { by[e.currency] = (by[e.currency] || 0) + Math.abs(Number(e.amount)); });
      return Object.keys(by).sort().map((cur) => fmtMoney(cur, Math.round(by[cur] * 100) / 100)).join(" + ");
    };
    const stmts = details.statements.map((s) => `<div class="stmt-row-sub">${escapeHtml(tr("added.statementLine", { label: s.label, from: fmtDate(s.period_start, true), to: fmtDate(s.period_end, true), n: s.lines_total }))}</div>`).join("");
    const summary = entries.length
      ? `<p class="stmt-verdict good">${escapeHtml(tr("added.total", { n: entries.length }))}</p>`
      : `<p class="stmt-verdict warn">${escapeHtml(tr("added.none"))}</p>`;
    body.innerHTML = `${summary}${details.statements.length ? `<details class="stmt-group"><summary>${escapeHtml(tr("added.statements", { n: details.statements.length }))}</summary>${stmts}</details>` : ""}<div id="added-groups"></div>`;
    const box = body.querySelector("#added-groups");
    ADDED_ORDER.filter((k) => groups[k]).forEach((k) => {
      const det = document.createElement("details");
      det.className = "stmt-group";
      det.open = k === "pending" || k === "spending" || ADDED_ORDER.filter((x) => groups[x]).length <= 2;
      det.innerHTML = `<summary>${escapeHtml(tr("added.group." + k))} <span class="stmt-count">${groups[k].length}</span> · ${escapeHtml(money(groups[k]))}</summary><div class="added-list"></div>`;
      box.appendChild(det);
      if (k === "pending") {
        // Not opened here: they are finished in Needs review (Confirm, or Mark as repayment / Convert to loan, or pick a platform).
        det.querySelector(".added-list").innerHTML = `<p class="hint">${escapeHtml(tr("added.pendingHint"))}</p>`
          + groups[k].map((e) => lineRow({ date: e.date, description: e.description, amount: pendingSigned(e), currency: e.currency }, escapeHtml(tr("added.pendingType." + e.type)))).join("")
          + `<div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-goreview-btn">${escapeHtml(tr("added.goReview"))}</button></div>`;
      } else {
        renderEntriesInto_(det.querySelector(".added-list"), groups[k]);   // the app's own entry rows: tap one to open it
      }
    });
    const extra = [];
    if (details.waiting.length) {
      extra.push(`<details class="stmt-group"><summary>${escapeHtml(tr("added.waiting", { n: details.waiting.length }))}</summary><p class="hint">${escapeHtml(tr("added.waitingHint"))}</p>${details.waiting.map((w) => lineRow({ date: w.date, description: w.description, amount: w.amount, currency: w.currency }, escapeHtml(w.account))).join("")}</details>`);
    }
    if (details.changedEntries) extra.push(`<p class="hint">${escapeHtml(tr("added.changed", { n: details.changedEntries }))}</p>`);
    body.insertAdjacentHTML("beforeend", extra.join(""));
  }

  async function openAdded(batchId) {
    const backdrop = $("statement-added-backdrop");
    addedBatch = batchId;
    $("statement-added-body").innerHTML = loadingHtml(tr("common.loading"));
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
    // After an entry is edited or deleted in its pop-up, the app asks the open sheet to reload itself.
    currentDrilldown = { refetch: () => loadAdded().catch(() => {}) };
    try { await loadAdded(); }
    catch (err) { $("statement-added-body").innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; }
  }

  function closeAdded() {
    $("statement-added-backdrop").hidden = true;
    addedBatch = null;
    currentDrilldown = null;
  }

  async function undoBatch(batchId, trigger) {
    if (!confirm(tr("stmt.confirmUndo"))) return;
    // The Undo buttons sit in Recent uploads (a side panel) or in step 4: the result is always shown in step 4.
    savedThisRun = true;
    showStep(4);
    // Show the loading line in the row that was tapped as well (it is out of sight when the panel is closed, harmless then).
    const slot = trigger && trigger.closest(".stmt-row") ? trigger.closest(".stmt-row").querySelector(".stmt-undo-progress") : null;
    if (slot) slot.innerHTML = loadingHtml(tr("stmt.undoing"));
    // Show that something is happening and stop a second tap: a second Undo running at the same time was never meant to be.
    const buttons = Array.from(document.querySelectorAll("#stmt-undo-btn, .stmt-undo-row"));
    buttons.forEach((b) => { b.disabled = true; });
    $("statement-review-status").innerHTML = loadingHtml(tr("stmt.undoing"));
    try {
      const r = await callApi("undoStatementBatch", { batchId });
      $("statement-review-status").innerHTML = `<p class="stmt-verdict good">${escapeHtml(tr("stmt.undone", { n: r.deletedEntries, r: r.reverted }))}</p>${r.categoriesRemoved ? `<p class="stmt-note info">${escapeHtml(tr("stmt.undoneCategories", { n: r.categoriesRemoved }))}</p>` : ""}${r.categoriesKept ? `<p class="stmt-note info">${escapeHtml(tr("stmt.undoneCategoriesKept", { n: r.categoriesKept }))}</p>` : ""}${r.categoriesRenamedBack ? `<p class="stmt-note info">${escapeHtml(tr("stmt.undoneRenamed", { n: r.categoriesRenamedBack }))}</p>` : ""}`;
      lastBatchId = null;
      historyPlan = null;
      $("statement-history").innerHTML = "";
      coverage = null;
      refreshStatementCoverage();
      refreshStatementGaps();
      refreshStatementBatches();
      refreshOtherScreens();
    } catch (err) {
      // The server may still be working (or have stopped part-way): say so, and show what Recent uploads says now.
      $("statement-review-status").innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.undoFailed", { error: err.message }))}</p><p class="hint">${escapeHtml(tr("stmt.undoCheck"))}</p>`;
      buttons.forEach((b) => { b.disabled = false; });
      if (slot) slot.innerHTML = "";
      refreshStatementBatches();
      refreshOtherScreens();
    }
  }

  // Five uploads at first; "Show more" adds ten each tap (a long history would make the list endless). Back to five when the screen is opened.
  const BATCHES_FIRST = 5, BATCHES_STEP = 10;
  let batchesShown = BATCHES_FIRST;

  async function refreshStatementBatches() {
    const box = $("statement-batches");
    try {
      const batches = await callApi("listStatementBatches", { limit: batchesShown, kind: screenMode === "import" ? "import" : "statement" });
      const more = batches.length >= batchesShown   // as many as were asked for: there may be older ones
        ? `<div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice" id="statement-batches-more">${escapeHtml(tr("stmt.showMore"))}</button></div>` : "";
      box.innerHTML = (batches.length ? batches.map((b) => `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(fmtDate(b.processed_at, true))}</div>
        <div class="stmt-row-sub">${escapeHtml(b.statements.join(", "))}</div>
        <div class="stmt-row-sub">${escapeHtml(tr("stmt.batchCounts", { n: b.entriesCreated, c: b.entriesChanged }))}</div><div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-added-btn" data-batch="${escapeHtml(b.batchId)}">${escapeHtml(tr("added.button"))}</button></div><div class="stmt-undo-progress"></div></div>
        <button type="button" class="cancel-edit-btn stmt-undo-row" data-batch="${escapeHtml(b.batchId)}" style="width:auto;padding:6px 12px;">${escapeHtml(tr("stmt.undo"))}</button>
        ${b.spreadsheet ? `<div><button type="button" class="add-inline stmt-move-row" data-batch="${escapeHtml(b.batchId)}">${escapeHtml(tr(screenMode === "import" ? "imp.moveToStatements" : "imp.moveToImport"))}</button></div>` : ""}</div>`).join("") : `<p class="hint">${escapeHtml(tr(screenMode === "import" ? "imp.noRecent" : "stmt.noUploads"))}</p>`) + more;
    } catch (err) {
      box.innerHTML = `<p class="hint">Couldn't load: ${escapeHtml(err.message)}</p>`;
    }
  }

  // exposed for testing in the browser
  window.__statements = { handleStatementFiles, readStatementFile, renderCoverage, runHistoryPlan, saveHistory, setCoverage: (c) => { coverage = c; }, setUsable: (u) => { usable = u; historyPlan = null; updateReviewButton(); } };

  // ---- wiring ----

  $("statement-batches").addEventListener("click", async (e) => {
    const mv = e.target.closest(".stmt-move-row");
    if (mv) {   // a spreadsheet upload filed on the wrong side: move it to the other list (the entries it made are not touched)
      mv.disabled = true;
      try { await callApi("setBatchOrigin", { batchId: mv.dataset.batch, origin: screenMode === "import" ? "statement" : "import" }); } catch (err) { alert(err.message || String(err)); }
      refreshStatementBatches();
      refreshStatementCoverage();
      return;
    }
    if (!e.target.closest("#statement-batches-more")) return;
    batchesShown += BATCHES_STEP;
    refreshStatementBatches();
  });
  $("more-statements-btn").addEventListener("click", () => showStatementsScreen("bank"));
  $("more-import-btn").addEventListener("click", () => showStatementsScreen("import"));
  $("statement-to-import-btn").addEventListener("click", () => { showStatementsScreen("import"); window.scrollTo(0, 0); });
  $("statement-to-bank-btn").addEventListener("click", () => { showStatementsScreen("bank"); window.scrollTo(0, 0); });
  $("statements-back-btn").addEventListener("click", () => { sessionPasswords = []; showScreen("more"); });
  $("statement-file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length) handleStatementFiles(files);
    e.target.value = ""; // lets the same file be picked again
  });
  $("statement-history-btn").addEventListener("click", runHistoryPlan);
  // the four steps
  $("stmt-stepper").addEventListener("click", (e) => {
    const b = e.target.closest(".stmt-pill");
    if (b && !b.disabled && Number(b.dataset.step) !== stepNow) showStep(Number(b.dataset.step));
  });
  $("stmt-step1-continue").addEventListener("click", () => showStep(2));
  $("stmt-next-2").addEventListener("click", () => showStep(3));
  $("stmt-add-more").addEventListener("click", () => showStep(1));
  $("stmt-back-3").addEventListener("click", () => showStep(2));
  $("stmt-another").addEventListener("click", () => { clearRun(); showStep(1); });
  $("statement-past-btn").addEventListener("click", () => { pastOpen = true; renderSteps(); window.scrollTo(0, 0); });
  $("statement-past-back").addEventListener("click", () => { pastOpen = false; renderSteps(); window.scrollTo(0, 0); });
  $("statement-history").addEventListener("click", (e) => {
    if (e.target.closest("#statement-history-save")) { saveHistory(); return; }
    if (e.target.closest("#statement-add-accounts")) { addProposedAccounts(); return; }
    if (e.target.closest("#statement-open-accounts")) { $("more-accounts-btn").click(); return; }
    if (!historyPlan) return;
    const one = e.target.closest("[data-aside]"), grp = e.target.closest("[data-agroup]");
    const pout = e.target.closest("[data-pout]"), pbulk = e.target.closest("[data-pbulk]"), pinc = e.target.closest("[data-pinc]");
    const bal = e.target.closest("[data-bal]"), balAll = e.target.closest("[data-balall]");
    const link = e.target.closest("[data-xlink]"), unlink = e.target.closest("[data-xunlink]"), manual = e.target.closest("[data-xmanual]");
    const aside = historyPlan.summary.aside || [];
    if (bal) {
      const i = Number(bal.dataset.bal);
      if (historyPlan.bal.has(i)) historyPlan.bal.delete(i); else historyPlan.bal.add(i);
      historyPlan.balOpen = true;
    } else if (balAll) {
      const can = settableChecks(), allOn = can.every(({ i }) => historyPlan.bal.has(i));
      can.forEach(({ i }) => { if (allOn) historyPlan.bal.delete(i); else historyPlan.bal.add(i); });
      historyPlan.balOpen = true;
    } else if (one) {
      const i = Number(one.dataset.aside), mode = one.dataset.mode;
      if (historyPlan.chosen.get(i) === mode) historyPlan.chosen.delete(i); else historyPlan.chosen.set(i, mode);
    } else if (pout) {
      // A payment YOU made to a person: spending (the default, no entry in the map), or sent to Needs review, or left out.
      const j = Number(pout.dataset.pout), mode = pout.dataset.mode;
      if (mode === "spending" || historyPlan.outMode.get(j) === mode) historyPlan.outMode.delete(j); else historyPlan.outMode.set(j, mode);
    } else if (pinc) {
      const k = Number(pinc.dataset.pinc), mode = pinc.dataset.mode;
      if (mode === "income" || historyPlan.incMode.get(k) === mode) historyPlan.incMode.delete(k); else historyPlan.incMode.set(k, mode);
    } else if (pbulk) {
      // All of one person's lines in one direction: all on, or (when all already were) all back to the default.
      const key = pbulk.dataset.pbulk, dir = pbulk.dataset.dir, mode = pbulk.dataset.mode;
      const g = peopleGroups().find((x) => x.key === key);
      if (g && dir === "out") {
        const allOn = g.out.every((j) => historyPlan.outMode.get(j) === mode);
        g.out.forEach((j) => { if (allOn) historyPlan.outMode.delete(j); else historyPlan.outMode.set(j, mode); });
      } else if (g) {
        const allOn = g.inn.every((i) => historyPlan.chosen.get(i) === mode);
        g.inn.forEach((i) => { if (allOn) historyPlan.chosen.delete(i); else historyPlan.chosen.set(i, mode); });
      }
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
  $("statement-history").addEventListener("change", (e) => {
    if (!historyPlan || !e.target.classList || !e.target.classList.contains("stmt-platform")) return;
    const aside = historyPlan.summary.aside || [];
    if (e.target.dataset.pidx !== undefined) historyPlan.platform.set(Number(e.target.dataset.pidx), e.target.value);
    else if (e.target.dataset.pgroup !== undefined) aside.forEach((a, i) => { if (a.group === Number(e.target.dataset.pgroup)) historyPlan.platform.set(i, e.target.value); });
    renderHistoryPlan();
  });
  $("statement-history").addEventListener("toggle", (e) => {
    if (!historyPlan) return;
    if (e.target.id === "statement-history-aside") historyPlan.asideOpen = e.target.open;
    if (e.target.id === "statement-history-balances") historyPlan.balOpen = e.target.open;
    if (e.target.id === "statement-history-people") historyPlan.peopleOpen = e.target.open;
    if (e.target.id === "statement-history-income") historyPlan.incomeOpen = e.target.open;
    if (e.target.dataset && e.target.dataset.ppkey !== undefined) {
      if (e.target.open) historyPlan.openPeople.add(e.target.dataset.ppkey); else historyPlan.openPeople.delete(e.target.dataset.ppkey);
    }
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
  $("statement-review-status").addEventListener("click", (e) => {
    if (e.target.id === "stmt-undo-btn" && lastBatchId) undoBatch(lastBatchId);
    if (e.target.closest("#statement-open-accounts")) $("more-accounts-btn").click();
  });
  $("statement-added-close").addEventListener("click", closeAdded);
  // "Go to Needs review": the card at the top of the Entries tab, where pending entries are finished.
  document.addEventListener("click", (e) => {
    if (!(e.target.closest && e.target.closest(".stmt-goreview-btn"))) return;
    closeAdded();
    const tab = document.querySelector('.nav-btn[data-screen="entries"]');
    if (tab) tab.click();
    setTimeout(() => { const card = document.getElementById("review-queue-card"); if (card && !card.hidden) card.scrollIntoView({ behavior: "smooth", block: "start" }); }, 400);
  });
  // "Tidy my history" in the saved message opens the same screen as More → Tidy my history.
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".stmt-tidy-btn")) document.getElementById("more-tidy-btn").click(); });
  // The same button sits in Recent uploads and in the "saved" message after a save.
  document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest(".stmt-added-btn"); if (b) openAdded(b.dataset.batch); });
  $("statement-batches").addEventListener("click", (e) => { const b = e.target.closest(".stmt-undo-row"); if (b) undoBatch(b.dataset.batch, b); });
  $("statement-password-ok").addEventListener("click", () => closeStatementPassword($("statement-password-input").value));
  $("statement-password-cancel").addEventListener("click", () => closeStatementPassword(null));
  $("statement-password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeStatementPassword($("statement-password-input").value);
  });
})();
