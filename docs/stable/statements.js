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
  let screenLoaded = Promise.resolve();   // the screen's first lists; a file picked before they arrive waits for them (else it was lost)
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

  // The real tutorial's ending after a save that left lines without a category: with their number when the backend counted them.
  function tidyDoneText_(imp, btn) {
    const n = btn && btn.dataset.n !== "" ? Number(btn.dataset.n) : NaN;
    if (!(n > 0)) return tr(imp ? "rt.imp.doneTidy" : "rt.stmt.doneTidy");
    if (n === 1) return tr(imp ? "rt.imp.doneTidyOne" : "rt.stmt.doneTidyOne");
    return tr(imp ? "rt.imp.doneTidyMany" : "rt.stmt.doneTidyMany", { n });
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

  // The "Bank statements" and "Import from another app" rows of My data open this one screen; `mode` ("bank" | "import") only changes what is shown
  // (the wording and the cards that are about bank e-mail) — the reading, the review and the saving are the same engine.
  let screenMode = "bank";

  function setScreenMode(mode) {
    screenMode = mode;
    $("screen-statements").dataset.mode = mode;
    ["bank", "import"].forEach((m) => {   // the two-way switch at the top shows which side this is
      const tab = $("stmt-mode-" + m);
      tab.classList.toggle("active", m === mode);
      tab.setAttribute("aria-selected", m === mode ? "true" : "false");
    });
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
    $("statement-matrix-card").open = false;   // folded again each visit
    setStatusOpen(false);   // the accounts list starts folded: one line says how many are up to date
    inboxOpen = null; inboxEarlierOpen = false;   // the Inbox decides again from what is in it
    sessionPasswords = [];
    batchesShown = BATCHES_FIRST;
    findFirstUse = null;   // decided again once the coverage list is in
    $("statement-find-card").hidden = !(typeof meta !== "undefined" && meta && meta.capabilities && meta.capabilities.bankEmails !== false);
    document.querySelectorAll(".screen").forEach((el) => { el.hidden = el.id !== "screen-statements"; });
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.screen === "more");
    });
    const loaded = [refreshStatementCoverage(), refreshStatementGaps(), refreshStatementBatches(), refreshStatementInbox()];
    screenLoaded = Promise.allSettled(loaded);
    renderSteps();
    // Loading standard: the tabs and "Loading…" first; everything below appears together once it has all arrived.
    $("stmt-head-card").dataset.loading = tr("common.loading");
    $("screen-statements").classList.add("stmt-opening");
    Promise.allSettled(loaded).then(() => $("screen-statements").classList.remove("stmt-opening"));
    if (next === "import") offerImportTip_();
    Promise.allSettled(loaded).then(() => {   // loading standard: offered once the status line and the Inbox have arrived
      if (screenMode !== next || $("screen-statements").hidden) return;
      if (next === "bank") offerBankTip_();
      watchStmtIdle_();
    });
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
  function readyCount() { return new Set(usable.map(slotOf)).size; }
  // Each card (one picked file) has its own slot: files are told apart by it, never by their name. Interbank's app names every
  // statement "account_sumary.pdf", so three accounts picked together counted as one and two were silently left out (owner, 2026-11-11).
  let slotSeq = 0;
  function slotOf(u) { return u.slot || u.group || u.file; }
  function sameStatement(a, b) {
    return a.kind === b.kind && accountKeyOf(a) === accountKeyOf(b) && JSON.stringify(a.period) === JSON.stringify(b.period) && (a.lines || []).length === (b.lines || []).length;
  }

  // Files picked but not read yet (they are read one at a time, and each gets its card only when its turn comes) and the one being
  // read now: while any is left, the counter says so and the preview waits (owner, 2026-11-11: 9 picked, the screen said "6 of 6").
  let filesQueued = 0, filesReading = 0;
  // The phone's file picker was opened and has not handed anything over yet: an iPhone prepares (copies, downloads from iCloud) every
  // picked file before the page hears of any, so for a while the app cannot know how many are coming (owner, 2026-11-11: "5 of 5"
  // with four still on their way). Until the files arrive, or the picker is cancelled, the preview waits too.
  let pickerWaiting = false, pickerTimer = null;
  function setPickerWaiting(on) {
    pickerWaiting = on;
    clearTimeout(pickerTimer);
    if (on) pickerTimer = setTimeout(() => setPickerWaiting(false), 180000);   // never locked for good if the phone sends neither files nor "cancel"
    updateStepUi();
  }
  function readingBusy() { return filesQueued + filesReading > 0 || pickerWaiting; }

  function canGoTo(n) {
    if (n === 1) return true;
    if (n === 2) return stmtCards().length > 0;
    if (n === 3) return usable.length > 0 && !readingBusy();
    return savedThisRun;
  }

  function setStatusOpen(open) {
    $("statement-coverage-list").hidden = !open;
    $("stmt-status-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("stmt-status-toggle").classList.toggle("open", open);
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
    linkedAccounts = [];
    Object.keys(acctAnswer).forEach((k) => delete acctAnswer[k]);
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
    $("stmt-head-card").hidden = pastOpen;   // the past list has its own Back: never two arrows
    $("stmt-stepper").innerHTML = names.map((key, i) => {
      const n = i + 1;
      const cls = n === stepNow ? "on" : (n < stepNow ? "done" : "");
      const can = n === stepNow || canGoTo(n);
      return `<button type="button" class="stmt-pill ${cls}" data-step="${n}" ${can ? "" : "disabled"} aria-current="${n === stepNow ? "step" : "false"}">${n < stepNow ? "✓ " : `${n} `}${escapeHtml(tr(key))}</button>`;
    }).join("");
    [1, 2, 3, 4].forEach((n) => { $("stmt-step-" + n).hidden = pastOpen || n !== stepNow; });
    renderDigitsNudge();
    $("statement-past").hidden = !pastOpen;
    updateStepUi();
  }

  // Counts and buttons that depend on what was read so far.
  function updateStepUi() {
    const total = stmtCards().length + filesQueued, ready = readyCount(), busy = readingBusy();
    // A spreadsheet waits for its "Use these lines" even when everything is already set (a saved layout, its accounts remembered): say so.
    const waiting = !!$("statement-results").querySelector(".tm-use");
    $("stmt-s2-count").textContent = busy && !(filesQueued + filesReading) ? tr("stmt.s2.waitingPicker") : busy ? tr("stmt.s2.reading", { done: total - filesQueued - filesReading, total }) : total ? tr("stmt.s2.count", { ready, total }) + (ready < total ? " " + tr(waiting ? "stmt.s2.waitingUse" : "stmt.s2.skipped") : "") : tr("stmt.s2.none");
    const next = $("stmt-next-2");
    next.hidden = !usable.length;
    next.disabled = busy;
    next.textContent = tr(screenMode === "import" ? "stmt.s2.nextFile" : "stmt.s2.next", { n: ready });   // another app's export is a file, not a statement (Tomás, 2026-11-21)
    $("stmt-add-more").textContent = tr(screenMode === "import" ? "stmt.s2.addMoreFiles" : "stmt.s2.addMore");
    $("stmt-another").textContent = tr(screenMode === "import" ? "stmt.s4.anotherFile" : "stmt.s4.another");
    const s1wait = $("stmt-s1-waiting");
    s1wait.hidden = !busy;
    if (busy) s1wait.textContent = $("stmt-s2-count").textContent;
    const cont = $("stmt-step1-continue");
    cont.hidden = !total;
    cont.textContent = tr("stmt.s1.continue", { n: total });
    $("statement-history-btn").textContent = tr(screenMode === "import" ? "imp.histButton" : "hist.button", { n: usable.length });
    // pills that became (un)reachable
    document.querySelectorAll("#stmt-stepper .stmt-pill").forEach((b) => { const n = Number(b.dataset.step); b.disabled = !(n === stepNow || canGoTo(n)); });
  }

  // Cards and bank accounts with no last 4 digits (owner, 2026-11-23, after a tester's report): a statement is matched to its account by those
  // digits, so without them the statement looks like a NEW account. Step 1 names them, each with a button to its own window.
  function digitlessAccounts() {
    return ((typeof meta !== "undefined" && meta && meta.paymentMethods) || []).filter((pm) => (pm.type === "debit" || pm.type === "credit")
      && !/^\d{4}$/.test(String(pm.last_4 || "").trim()) && !pmHidden_(pm) && !/^(Practice account|Cuenta de práctica)$/i.test(String(pm.nickname || "").trim()));
  }
  function renderDigitsNudge() {
    const card = $("stmt-digits-card");
    if (!card) return;
    const list = digitlessAccounts();
    card.hidden = !list.length || stepNow !== 1 || pastOpen;
    if (card.hidden) { card.innerHTML = ""; return; }
    card.innerHTML = `<p class="stmt-note warn" style="margin-top:0">${escapeHtml(tr("stmt.digits.title", { n: list.length }))}</p>
      <p class="hint" style="margin:0 0 6px">${escapeHtml(tr("stmt.digits.hint", { n: list.length }))}</p>
      ${list.map((pm) => `<div class="stmt-kv" style="align-items:center"><span>${escapeHtml(pm.nickname)}</span><button type="button" class="add-inline stmt-digits-add" data-id="${escapeHtml(pm.id)}">${escapeHtml(tr("stmt.digits.add"))}</button></div>`).join("")}`;
  }
  window.stmtDigitsNudgeRefresh_ = renderDigitsNudge;   // app.js calls it once an account's save has landed

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

  // The Inbox box is compact (owner's design, 2026-10-26): a header line with a count chip; open on its own only when something is NEW;
  // statements already read — and those that only look read ("probably processed": received before the account's last processed one) —
  // sit in a fold inside it, so a box with nothing to do costs one line.
  let inboxOpen = null;          // null = decide from the list (open when there is something new); true/false = the person chose
  let inboxEarlierOpen = false;  // the "Already read" fold

  const isNewItem = (i) => i.status === "new" && !i.probably_processed;

  function inboxRow(i) {
    const done = i.status === "processed";
    const note = done ? tr("stmt.processed") : (i.probably_processed ? tr("stmt.probablyProcessed", { date: fmtDate(i.last_processed, true) }) : tr("stmt.notProcessed"));
    return `<div class="stmt-row"><div class="stmt-row-main">
        <div class="stmt-row-title">${escapeHtml(tr("stmt.received", { bank: i.account || i.bank, date: fmtDate(i.received, true) }))}</div>
        <div class="stmt-row-sub">${escapeHtml(note)} · ${i.link ? escapeHtml(tr("stmt.viaLink")) : `${i.size_kb} KB`}</div>
        <div class="stmt-choices" style="padding-left:0">
          <button type="button" class="stmt-choice stmt-inbox-open" data-id="${escapeHtml(i.id)}">${escapeHtml(tr("stmt.open"))}</button>
          <button type="button" class="stmt-choice stmt-inbox-see" data-id="${escapeHtml(i.id)}">${escapeHtml(tr("stmt.view.seeShort"))}</button>
          ${done ? "" : `<button type="button" class="stmt-choice stmt-inbox-dismiss" data-id="${escapeHtml(i.id)}">${escapeHtml(tr("stmt.dismiss"))}</button>`}
        </div></div></div>`;
  }

  function setInboxOpen(open) {
    $("stmt-inbox-body").hidden = !open;
    $("stmt-inbox-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("stmt-inbox-toggle").classList.toggle("open", open);
  }

  function renderInbox() {
    const list = $("statement-inbox-list"), chip = $("stmt-inbox-chip");
    const fresh = inbox.filter(isNewItem), earlier = inbox.filter((i) => !isNewItem(i));
    const looksRead = earlier.filter((i) => i.status === "new").length;   // not marked processed, but received before the last processed statement
    chip.className = "stmt-chip " + (fresh.length ? "warn" : "info");
    chip.textContent = fresh.length ? tr("stmt.inbox.new", { n: fresh.length })
      : (looksRead ? tr("stmt.inbox.noneProbably", { n: looksRead }) : tr(earlier.length ? "stmt.inbox.none" : "stmt.inbox.empty"));
    const openAll = fresh.length > 1
      ? `<div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-inbox-open-all">${escapeHtml(tr("stmt.openAll", { n: fresh.length }))}</button></div>`
      : "";
    const nothing = fresh.length ? "" : `<p class="hint">${escapeHtml(tr(earlier.length ? "stmt.inbox.nothingNew" : "stmt.inboxEmpty"))}</p>`;
    const fold = earlier.length
      ? `<button type="button" class="add-inline stmt-inbox-earlier-toggle">${inboxEarlierOpen ? "⌄" : "›"} ${escapeHtml(tr("stmt.inbox.earlier", { n: earlier.length }))}</button>${inboxEarlierOpen ? earlier.map(inboxRow).join("") : ""}`
      : "";
    list.innerHTML = nothing + openAll + fresh.map(inboxRow).join("") + fold;
    setInboxOpen(inboxOpen === null ? fresh.length > 0 : inboxOpen);
  }

  async function refreshStatementInbox() {
    const list = $("statement-inbox-list");
    list.innerHTML = `${loadingHtml(tr("common.loading"))}`;
    try { inbox = (await callApi("listStatementInbox", {})).items; }
    catch (err) { list.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; setInboxOpen(true); return; }
    renderInbox();
  }

  // Fetches one inbox statement from Gmail and reads it (asks its password). Throws on failure.
  // `queued`: it was counted in filesQueued when a batch started ("Open all", "Read selected"), so the Check step said "N of 9" from the
  // first tap (owner, 2026-11-11). Counted as being read from the download on, not only once the PDF is in hand.
  async function fetchAndReadInboxItem(id, sender, queued) {
    if (queued) filesQueued--;
    filesReading++;
    try { await fetchAndReadInboxItemNow(id, sender); } finally { filesReading--; updateStepUi(); }
  }
  async function fetchAndReadInboxItemNow(id, sender) {
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
      showAppMessage_(tr("stmt.fetchFailed", { error: err && err.message ? err.message : err }));
    }
    btn.disabled = false; btn.textContent = tr("stmt.open");
  }

  // Opens every statement still waiting in the inbox, one after another (easy on a phone's memory;
  // each asks its own password). One that fails to fetch is reported at the end, the rest continue.
  async function openAllInboxItems(btn) {
    const waiting = inbox.filter(isNewItem);   // the ones that look already read stay in the fold: open them one by one if wanted
    if (!waiting.length) return;
    const label = btn.textContent;
    btn.disabled = true;
    const failed = [];
    filesQueued += waiting.length;
    updateStepUi();
    for (let n = 0; n < waiting.length; n++) {
      setBusy(btn, tr("stmt.openingN", { i: n + 1, n: waiting.length }));
      try { await fetchAndReadInboxItem(waiting[n].id, undefined, true); }
      catch (err) { failed.push(`${waiting[n].bank} (${waiting[n].received}): ${err && err.message ? err.message : err}`); }
    }
    btn.disabled = false; btn.textContent = label;
    $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failed.length) showAppMessage_(tr("stmt.fetchFailedList") + "\n" + failed.join("\n"));
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
    filesQueued += picks.length;   // counted from the tap: the Check step says "N of M" while they are fetched
    updateStepUi();
    let added;
    try { added = await callApi("addStatementsToInbox", { items: picks.map((p) => ({ message_id: p.message_id, attachment_name: p.attachment_name })) }); }
    catch (err) { filesQueued -= picks.length; updateStepUi(); delete btn.dataset.busy; updateFindReadButton(); showAppMessage_(tr("find.addFailed", { error: err && err.message ? err.message : err })); return; }
    filesQueued -= picks.length - added.ids.length;   // only what really went into the Inbox is read
    updateStepUi();
    await refreshStatementInbox();
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    const failed = [];
    for (let n = 0; n < added.ids.length; n++) {
      setBusy(btn, tr("stmt.openingN", { i: n + 1, n: added.ids.length }));
      try { await fetchAndReadInboxItem(added.ids[n], (added.senders || {})[added.ids[n]] || "", true); }
      catch (err) { failed.push(`${picks[n] ? picks[n].attachment_name : ""}: ${err && err.message ? err.message : err}`); }
    }
    delete btn.dataset.busy;
    updateFindReadButton();
    $("statement-results").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failed.length) showAppMessage_(tr("stmt.fetchFailedList") + "\n" + failed.join("\n"));
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

  // ---- statements by month (accounts × months; a fold inside Past uploads) ----

  async function refreshStatementMatrix() {
    const box = $("statement-matrix");
    box.innerHTML = loadingHtml(tr("common.loading"));
    let res;
    try { res = await callApi("getStatementMonthMatrix", {}); }
    catch (err) { box.innerHTML = `<p class="hint">${escapeHtml(tr("drill.loadFailed", { error: err.message }))}</p>`; return; }
    if (!res.accounts.length) { box.innerHTML = `<p class="hint">${escapeHtml(tr("matrix.empty"))}</p>`; return; }
    const head = res.months.map((ym) => {
      const [y, m] = ym.split("-").map(Number);
      return `<th>${escapeHtml(I18n.monthShort(m - 1, true))}<br>${String(y).slice(2)}</th>`;
    }).join("");
    const body = res.accounts.map((a) => `<tr><th class="stmt-matrix-acct">${escapeHtml(a.label)}</th>${res.months.map((ym) => {
      const n = a.cells[ym] || 0;
      if (n) return `<td class="has">✓${n > 1 ? `<small>${n}</small>` : ""}</td>`;
      return ym > a.first && ym < a.last ? `<td class="hole">–</td>` : `<td></td>`;
    }).join("")}</tr>`).join("");
    box.innerHTML = `<div class="stmt-matrix-scroll"><table class="stmt-matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    const sc = box.querySelector(".stmt-matrix-scroll");
    sc.scrollLeft = sc.scrollWidth;   // lands on the newest months
  }
  $("statement-matrix-card").addEventListener("toggle", (e) => { if (e.target.open) refreshStatementMatrix(); });

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
      const what = g.likely ? tr("gaps.likely", { amount: signed(g.currency, g.gap), items: g.likely })
        : tr(g.gap < 0 ? "gaps.less" : "gaps.more", { amount: fmtMoney(g.currency, Math.abs(g.gap)) });
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
      const note = await askTextApp_(tr("gaps.notePrompt"), tr("gaps.resolve"));
      if (note === null) return;           // cancelled
      payload.note = note;
    }
    btn.disabled = true;
    try { await callApi("resolveStatementGap", payload); }
    catch (err) { showAppMessage_(tr("gaps.failed", { error: err.message })); }
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
    $("stmt-status-text").textContent = tr("common.loading");
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

  // The one line above the Upload block: how many accounts are up to date. Tapping it shows the whole list (renderCoverage).
  function renderStatusLine() {
    const line = $("stmt-status-text");
    if (!coverage) { line.textContent = tr("common.loading"); return; }
    const m = coverage.accounts.length, ok = coverage.accounts.filter((a) => a.status === "ok").length;
    if (!m) { line.textContent = tr("stmt.noAccounts"); return; }
    const icon = ok === m ? "✅" : (coverage.accounts.some((a) => a.status === "due") ? "🔴" : "⚪");
    line.textContent = `${icon} ${tr(ok === m ? "stmt.status.all" : "stmt.status.some", { n: m, ok })}`;
  }

  function renderCoverage() {
    const list = $("statement-coverage-list");
    renderStatusLine();
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
      guidedLift_(backdrop);   // (asked during a real tutorial: above its dimmed screen)
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
    guidedLift_(backdrop);
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
    const slot = "s" + (++slotSeq);
    card.innerHTML = `<div class="stmt-result-name">${escapeHtml(fileName)}</div><div class="stmt-result-body">${loadingHtml(tr("stmt.reading"))}</div>
      <button type="button" class="stmt-result-remove">${escapeHtml(tr("stmt.removeFile"))}</button>`;
    card.querySelector(".stmt-result-remove").addEventListener("click", () => removeResultCard(card, slot));
    $("statement-results").prepend(card);
    // Reading starts: the person moves on to step 2 by themselves (from the inbox, a file, or the Gmail search alike).
    if (stepNow === 1 || pastOpen) showStep(2); else updateStepUi();
    realStmtFileChosen_();
    const body = card.querySelector(".stmt-result-body");
    body.dataset.slot = slot;
    return body;
  }

  // Takes one file out of this session's list (it is only on the phone; the PDF itself is never kept).
  function removeResultCard(card, slot) {
    const had = usable.some((u) => slotOf(u) === slot);
    card.remove();
    if (!had) { updateReviewButton(); return; }
    usable = usable.filter((u) => slotOf(u) !== slot);
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

  // Which account a reading belongs to, as a bold line at the top of its card (a person can hold several accounts at one bank).
  // The app's own name for the account when it is one of the tracked ones; otherwise what the statement itself says (name and last digits).
  function accountHeader(result) {
    const key = accountKeyOf(result);
    const acct = coverage && key ? coverage.accounts.find((a) => a.key === key) : null;
    let label = acct ? acct.label : "";
    if (!label && result.newAccount) label = tr("imp.newAcctHeader", { name: result.newAccount.name });   // an account the save will create
    if (!label && result.kind !== "csv" && result.account && result.account.label) {
      label = result.account.label + (result.account.last4 ? ` …${result.account.last4}` : "");
    }
    return label ? `<div class="stmt-acct">${escapeHtml(label)}</div>` : "";
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

    const warnNotes = (result.warnings || []).map((w) => `<p class="stmt-note warn">${escapeHtml(w)}</p>`).join("")
      + (result.skippedBeforeHistory ? `<p class="stmt-note info">${escapeHtml(tr(result.skippedBeforeHistory === 1 ? "stmt.noteBeforeHistoryOne" : "stmt.noteBeforeHistory",
        { n: result.skippedBeforeHistory, date: fmtDate(result.historyStart, true) }))}</p>` : "");
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

    body.innerHTML = `${title ? `<div class="stmt-result-name">${escapeHtml(title)}</div>` : ""}${accountHeader(result)}${verdict}${notes}
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.period"))}</span><span>${escapeHtml(period)}</span></div>
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.linesRead"))}</span><span>${(result.lines || []).length}</span></div>
      ${balances}
      ${errors ? `<ul class="stmt-errors">${errors}</ul>` : ""}
      ${lines ? `<details class="stmt-lines"><summary>${escapeHtml(tr("stmt.showLines", { n: (result.lines || []).length }))}</summary>${lines}</details>` : ""}`;
    if (!result.ok) offerSample(body, rows, "unverified", sender);   // a layout we know but cannot make add up: the owner wants to see it too
  }

  // A spreadsheet with several accounts is ONE file: one card, its accounts listed inside (owner, 2026-11-21: seven cards titled with the
  // same file name read as seven files).
  function renderTableResults(body, results) {
    const all = results.flatMap((r) => r.lines || []);
    const dates = all.map((l) => l.date).sort();
    const lineHtml = (l) => `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`;
    const label = (r) => {
      if (r.newAccount) return tr("imp.newAcctHeader", { name: r.newAccount.name });
      if (r.accountKey === NO_ACCOUNT_KEY) return tr("imp.noAccountOption");
      const pm = ((meta && meta.paymentMethods) || []).find((a) => tableAccountKey(a) === r.accountKey);
      return pm ? pm.nickname : r.accountKey;
    };
    body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr(screenMode === "import" ? "imp.tableVerdict" : "table.verdict"))}</p>
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.period"))}</span><span>${escapeHtml(dates.length ? `${fmtDate(dates[0], true)} – ${fmtDate(dates[dates.length - 1], true)}` : "—")}</span></div>
      <div class="stmt-kv"><span>${escapeHtml(tr("stmt.linesRead"))}</span><span>${all.length}</span></div>
      <h4 class="accounts-group-title">${escapeHtml(tr("table.secAccounts"))} · ${results.length}</h4>
      ${results.map((r) => { const ls = r.lines || [], ds = ls.map((l) => l.date).sort(); return `<div class="tm-acct-sum"><div class="stmt-kv"><strong>${escapeHtml(label(r))}</strong><span>${escapeHtml(tr("table.catLines", { n: ls.length }))}</span></div>
        <div class="hint">${escapeHtml(ds.length ? `${fmtDate(ds[0], true)} – ${fmtDate(ds[ds.length - 1], true)}` : "")}</div>
        <details class="stmt-lines"><summary>${escapeHtml(tr("stmt.showLines", { n: ls.length }))}</summary>${ls.slice(0, 200).map(lineHtml).join("")}${ls.length > 200 ? `<p class="hint">${escapeHtml(tr("table.moreLines", { n: ls.length - 200 }))}</p>` : ""}</details></div>`; }).join("")}`;
  }

  // The day the person's history starts = their earliest entry, from the phone's copy of the entries (app.js `searchIndex`, loaded
  // if it is not yet). SIP's CTS statement lists every movement since the account opened; the older ones are left out (owner,
  // 2026-11-20). No entries, or the copy cannot be loaded: '' (nothing is left out).
  async function historyStartDate() {
    try {
      if (!Array.isArray(searchIndex)) await syncSearchIndex_();
      let first = "";
      (searchIndex || []).forEach((e) => { const d = String(e.date || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!first || d < first)) first = d; });
      return first;
    } catch (err) { return ""; }
  }

  // The password side of opening one PDF: every password that already opened a statement this visit is tried silently first, then the
  // person is asked. `remember()` after it opened puts the one that worked first (the likeliest for the next file).
  function pdfPasswordTries(fileName) {
    let nextTry = 0, lastTried = null, asked = false, typed = null;
    const tries = {
      cancelled: false,
      onPassword: async (reason) => {
        if (nextTry < sessionPasswords.length) { lastTried = sessionPasswords[nextTry++]; return lastTried; }
        // The silent tries failing are not the person's mistake, so the first prompt reads "protected", not "didn't work".
        const pw = await askStatementPassword(fileName, sessionPasswords.length && !asked ? 1 : reason);
        asked = true;
        if (pw === null) tries.cancelled = true; else typed = pw;
        return pw;
      },
      remember: () => {
        const opened = typed !== null ? typed : lastTried;
        if (opened !== null) sessionPasswords = [opened].concat(sessionPasswords.filter((p) => p !== opened));
      }
    };
    return tries;
  }

  async function readStatementFile(file) {
    const body = resultCardShell(file.name);
    const pw = pdfPasswordTries(file.name);
    try {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const rows = await StatementParsers.readPdfRows(pdfjs, data, { onPassword: pw.onPassword });
      pw.remember();
      let result = StatementParsers.parseStatement(rows);
      if (result.ok && result.kind === "sipcts") result = StatementParsers.trimSipCtsToHistory(result, await historyStartDate());
      renderResult(body, result, rows, file);
      addSeeStatementButton(body, file, result);
      if (result.kind && result.ok) {
        // A statement that came from Gmail and was read: its sender is a bank this app now knows (the 15-minute check finds its next ones).
        if (file.inboxId) callApi("rememberStatementSender", { id: file.inboxId }).catch(() => {});
        // A re-read of the same card replaces its earlier reading.
        // The same statement picked twice (same account, dates and number of lines) also counts once, whatever the files are called.
        const slot = body.dataset.slot;
        usable = usable.filter((u) => slotOf(u) !== slot && !sameStatement(u.result, result));
        usable.push({ file: file.name, slot, result, inboxId: file.inboxId || "" });
        // The plan's statement/line numbers refer to THIS list — any change makes an open plan stale.
        historyPlan = null;
        $("statement-history").innerHTML = "";
        updateReviewButton();
      }
    } catch (err) {
      if (pw.cancelled) body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("stmt.skippedNoPw"))}</p>`;
      else body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    }
  }


  // ---- "See the statement": the bank's own PDF pages on a screen of their own (owner, 2026-11-20) ----
  // Its job is to tell WHICH document a PDF is: the top names the account, the period and what the app already has for that account;
  // the pages below are the bank's own. Nothing is read into the steps and nothing is saved. Opened from an Inbox row ("See it", the PDF
  // comes from Gmail) or from a reading card in step 2 (the same file, its password already known). Memory only, like the reading.

  const VIEW_MAX_PAGES = 30;
  let viewerSeq = 0;
  let viewerUrls = [];   // the pages' pictures, released when the screen closes

  function addSeeStatementButton(body, file, result) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-inline stmt-see-btn";
    btn.textContent = tr("stmt.view.see");
    btn.addEventListener("click", () => viewStatementPdf(file, result));
    body.appendChild(btn);
  }

  function closeStatementViewer() {
    viewerSeq++;   // a page still being drawn stops
    $("stmt-viewer-backdrop").hidden = true;
    $("stmt-viewer-pages").innerHTML = "";
    viewerUrls.forEach((u) => URL.revokeObjectURL(u));
    viewerUrls = [];
  }

  // What the top of the screen says: the account (the app's name for it when tracked, else the statement's own), the bank, the period,
  // the closing balances, and how it stands against what the app already has (same notes as the reading card).
  function viewerHeadHtml(file, result) {
    const r = result || {};
    const key = r.kind ? accountKeyOf(r) : "";
    const acct = coverage && key ? coverage.accounts.find((a) => a.key === key) : null;
    const own = r.account && r.account.label ? r.account.label + (r.account.last4 ? ` …${r.account.last4}` : "") : "";
    const name = (acct && acct.label) || own;
    const bank = r.kind ? StatementParsers.STATEMENT_BANK_BY_KIND[r.kind] || "" : "";
    const kv = (label, value) => `<div class="stmt-kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
    let html = `<div class="stmt-acct">${escapeHtml(name || tr("stmt.view.unknownAcct"))}</div>`;
    if (bank && !(name || "").toLowerCase().includes(bank.toLowerCase())) html += kv(tr("stmt.view.bank"), bank);
    if (r.period && r.period.end) html += kv(tr("stmt.period"), `${fmtDate(r.period.start, true)} – ${fmtDate(r.period.end, true)}`);
    Object.entries(r.balances || {}).forEach(([cur, b]) => {
      if (b && b.closing !== null && b.closing !== undefined) html += kv(tr("stmt.closing", { cur }), fmtMoney(cur, b.closing));
    });
    if (r.kind) html += coverageNotes(r).map(([cls, msg]) => `<p class="stmt-note ${cls}">${msg}</p>`).join("");
    else html += `<p class="stmt-note info">${escapeHtml(tr("stmt.view.notRecognised"))}</p>`;
    html += `<p class="hint stmt-viewer-file">${escapeHtml(file.name)}</p>`;
    return html;
  }

  // Draws one page as a picture (a canvas per page would use too much of a phone's memory): wide enough to stay sharp when zoomed in.
  async function pageToUrl(doc, n, cssWidth) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1600, Math.round(cssWidth * 4)) / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    canvas.width = 0; canvas.height = 0;
    page.cleanup();
    const url = URL.createObjectURL(blob);
    viewerUrls.push(url);
    return url;
  }

  // `known`: the reading already made of this file (step 2); without it the PDF is read here, only to name it.
  async function viewStatementPdf(file, known) {
    const seq = ++viewerSeq;
    const backdrop = $("stmt-viewer-backdrop"), head = $("stmt-viewer-head"), pages = $("stmt-viewer-pages"), loading = $("stmt-viewer-loading");
    // Opens at once with "Loading…"; shows the account and the pages only when everything is ready (loading standard).
    head.hidden = true; pages.hidden = true; pages.innerHTML = ""; pages.style.width = ""; pages.dataset.zoom = "1";
    loading.hidden = false; loading.innerHTML = loadingHtml(tr("common.loading"));
    bringModalToFront_(backdrop);
    backdrop.hidden = false;
    $("stmt-viewer-scroll").scrollTop = 0;
    let doc = null;
    const pw = pdfPasswordTries(file.name);
    try {
      const data = file.pdfBytes ? file.pdfBytes : new Uint8Array(await file.arrayBuffer());
      const pdfjs = await loadPdfjs();
      const rows = await StatementParsers.readPdfRows(pdfjs, data.slice(), { onPassword: pw.onPassword, onDoc: (d) => { doc = d; } });
      pw.remember();
      if (seq !== viewerSeq) return;
      let result = known;
      if (!result) { try { result = StatementParsers.parseStatement(rows); } catch (e) { result = null; } }
      if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* the notes just won't show */ } }
      const cssWidth = Math.max(300, $("stmt-viewer-scroll").clientWidth - 8);
      const count = Math.min(doc.numPages, VIEW_MAX_PAGES);
      const urls = [];
      for (let n = 1; n <= count; n++) {
        if (seq !== viewerSeq) return;
        urls.push(await pageToUrl(doc, n, cssWidth));
      }
      if (seq !== viewerSeq) return;
      head.innerHTML = viewerHeadHtml(file, result);
      pages.innerHTML = `<p class="hint">${escapeHtml(tr("stmt.view.pages", { n: doc.numPages }))} · ${escapeHtml(tr("stmt.view.zoomHint"))}</p>`
        + urls.map((u, i) => `<img class="stmt-viewer-page" src="${u}" alt="${escapeHtml(tr("stmt.view.pageAlt", { i: i + 1, n: doc.numPages }))}">`).join("")
        + (doc.numPages > count ? `<p class="hint">${escapeHtml(tr("stmt.view.morePages", { n: doc.numPages - count }))}</p>` : "");
      loading.hidden = true; head.hidden = false; pages.hidden = false;
    } catch (err) {
      if (seq !== viewerSeq) return;
      if (pw.cancelled) { closeStatementViewer(); return; }   // "Skip this file" on the password: nothing to show
      loading.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.view.failed"))}</p><p class="hint">${escapeHtml(err && err.message ? err.message : String(err))}</p>`;
    } finally {
      if (doc) doc.destroy();
    }
  }

  // An Inbox statement: fetched from Gmail only to look at it (the steps are not touched; Open still reads it).
  async function seeInboxItem(id, btn) {
    const item = inbox.find((i) => i.id === id);
    if (!item) return;
    btn.disabled = true; setBusy(btn, tr("stmt.fetching"));
    try {
      const att = await callApi("getStatementAttachment", { id });
      const bin = atob(att.base64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      viewStatementPdf({ name: att.name, pdfBytes: bytes });
    } catch (err) {
      showAppMessage_(tr("stmt.fetchFailed", { error: err && err.message ? err.message : err }));
    }
    btn.disabled = false; btn.textContent = tr("stmt.view.seeShort");
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
  // Words that may follow a person's first name in a line's description without being a surname (Import's loans by person).
  const NAME_FOLLOW_WORDS_ = ["del", "por", "para", "pago", "pagos", "prestamo", "prestamos", "transf", "transferencia", "yape", "plin", "cuota",
    "cuotas", "devolucion", "devuelve", "devolvio", "abono", "deposito", "the", "for", "loan", "paid", "repaid", "from", "back", "and", "via", "con", "les"];

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

  // Accounts a file's lines can go to. Import data also offers Cash (another app's "Cash" wallet, 2026-11-04); a bank statement never.
  function tableAccounts() {
    const cashOk = screenMode === "import";
    return ((typeof meta !== "undefined" && meta && meta.paymentMethods) || []).filter((pm) => (pm.type === "debit" || pm.type === "credit" || pm.type === "wallet" || (cashOk && pm.type === "cash")) && !pmHidden_(pm));
  }

  function columnLetter(i) { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; }

  async function readTableFile(file) {
    const body = resultCardShell(file.name);
    try {
      const rows = await StatementTable.readTable(new Uint8Array(await file.arrayBuffer()), file.name);
      if (rows.length < 2) throw new Error("table-empty");
      await renderTableMapping(body, rows, file);
      updateStepUi();   // the counter now knows this file waits for "Use these lines"
    } catch (err) {
      body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(tableErrorText(err))}</p>`;
    }
  }

  async function renderTableMapping(body, rows, file) {
    const accounts = tableAccounts();
    // Import data never needs an account (a person may be trying the app before setting any up): its entries are saved with none.
    // Statements still do — a bank's statement is about one account (balances, gaps, coverage).
    const noneOk = screenMode === "import";
    if (!accounts.length && !noneOk && !(((typeof meta !== "undefined" && meta && meta.capabilities) || {}).importNewAccounts)) { body.innerHTML = `<p class="stmt-verdict bad">${escapeHtml(tr("stmt.readFailed"))}</p><p class="hint">${escapeHtml(tr("table.noAccounts"))}</p>`; return; }
    // Import reads another app's export or a person's own sheet: a few extra guesses (account column by more names, a comments column,
    // a currency per line). A remembered or known layout keeps its own columns (below).
    const guess = StatementTable.guessMapping(rows, { importMode: screenMode === "import" });
    const sig = StatementTable.signature(guess, rows);
    const width = guess.headers.length;
    const state = { balStart: "", balEnd: "", balOpen: false, m: { ...guess }, accountId: "", map: {}, source: "new", label: "", uses: 0, catChoice: {}, catNames: {}, catCustom: {}, catInfo: [], catItems: [], catSaved: {}, catKey: "", catDest: {}, newAcct: {} };

    // Where do the columns come from: this layout saved on the server, a layout the app knows by name, or the guess.
    let saved = null;
    try { saved = await callApi("getStatementFormat", { signature: sig }); } catch (e) { /* offline or an older backend: just the guess */ }
    const known = StatementTable.recognize(guess.headers);
    const fromSource = saved && saved.found ? saved.mapping : (known ? known.mapping : null);
    if (fromSource) {
      ["date", "description", "amount", "out", "in", "currency", "account", "category", "type", "note"].forEach((f) => {
        if (typeof fromSource[f] === "number") state.m[f] = fromSource[f] >= 0 && fromSource[f] < width ? fromSource[f] : -1;
      });
      if (typeof fromSource.note !== "number") state.m.note = -1;   // a layout remembered before the comments column existed keeps its descriptions
      ["dateOrder", "decimal", "sign", "currencyFixed", "source", "dollarCurrency"].forEach((f) => { if (fromSource[f]) state.m[f] = fromSource[f]; });
      // A date in THIS file that proves the order (31/10) beats a remembered answer (Mark, re-check 2026-11-18: the remembered
      // month / day dropped that line without a word). Said in the preview.
      if (guess.dateProved && guess.dateOrder && state.m.dateOrder !== guess.dateOrder) { state.m.dateOrder = guess.dateOrder; state.dateFromFile = true; }
    }
    if (saved && saved.found) {
      state.source = "saved"; state.label = saved.label || ""; state.uses = saved.uses || 0;
      state.map = { ...(saved.accounts || {}) };
      state.catSaved = { ...(saved.categories || {}) };
      if (state.map["*"] && accounts.some((a) => a.id === state.map["*"])) state.accountId = state.map["*"];
    } else if (known) {
      state.source = "known"; state.label = known.name;
    }
    // A new layout whose amounts carry a dollar sign starts on dollars: "US$" is USD; a bare "$" is the main currency when that is a
    // dollar-sign currency (pesos…), else USD. Said in the preview, and the currency box can still be changed.
    const DOLLAR_SIGN_CURS = ["USD", "MXN", "CLP", "ARS", "COP", "UYU", "CAD", "AUD", "NZD", "SGD", "HKD", "DOP"];
    // A file that mixes currency marks: each line takes its own (StatementTable.applyMapping). A bare "$" is asked once, starting on dollars
    // (or the main currency when that is written with a "$").
    if (state.m.lineCurrency && state.m.bareDollar && !state.m.dollarCurrency) state.m.dollarCurrency = DOLLAR_SIGN_CURS.includes(homeCur()) ? homeCur() : "USD";
    if (state.source === "new" && guess.currencySign && !state.m.currencyFixed) {
      state.m.currencyFixed = guess.currencySign === "$" && DOLLAR_SIGN_CURS.includes(homeCur()) ? homeCur() : "USD";
      state.signCurrency = state.m.currencyFixed;
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
      const banks = accounts.filter((a) => a.type !== "cash");   // Cash is offered, never picked by itself (a file without accounts stays with none)
      const hit = banks.find((a) => fileDigits.includes(String(a.last_4 || "").padStart(4, "0"))) || (banks.length === 1 ? banks[0] : null);
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
    const accountOptions = (selectedId, extra, after, list) => `<option value="">${escapeHtml(tr(noneOk ? "imp.noAccountOption" : "table.pickAccount"))}</option>` + (extra || "") +
      (list || accounts).map((a) => `<option value="${escapeHtml(a.id)}"${a.id === selectedId ? " selected" : ""}>${escapeHtml(a.nickname + (a.last_4 ? ` (${a.last_4})` : ""))}</option>`).join("") + (after || "");
    // A file's account can be one the save creates (backend capability importNewAccounts; see "accounts the file names" below).
    const newOk = !!(((typeof meta !== "undefined" && meta && meta.capabilities) || {}).importNewAccounts);
    const singleNewOption = newOk ? `<option value="new:*">${escapeHtml(tr("imp.newAcctSingle"))}</option>` : "";

    const banner = state.source === "known" ? tr("table.layoutKnown", { name: state.label })
      : state.source === "saved" ? (state.label ? tr("table.layoutSaved", { name: state.label }) : tr("table.layoutSavedUnnamed"))
      : tr("table.layoutNew");
    body.innerHTML = `<div class="tm-root">
      <p class="stmt-note ${remembered ? "ok" : "info"}">${escapeHtml(banner)}${state.source === "saved" ? ` <button type="button" class="add-inline tm-forget">${escapeHtml(tr("table.forget"))}</button>` : ""}</p>
      <p class="hint">${escapeHtml(tr(screenMode === "import" ? "imp.tableHint" : "table.hint"))}</p>
      <div class="tm-sec tm-sec-cols"><h4 class="accounts-group-title">${escapeHtml(tr("table.secColumns"))}</h4>
      ${sel("date", tr("table.colDate"), colOptions(state.m.date, false))}
      ${sel("desc", tr("table.colDesc"), colOptions(state.m.description, true))}
      ${sel("mode", tr("table.amounts"), `<option value="one">${escapeHtml(tr("table.amountOne"))}</option><option value="two">${escapeHtml(tr("table.amountTwo"))}</option>`)}
      <div class="tm-one">${sel("amount", tr("table.colAmount"), colOptions(state.m.amount, true))}
        ${sel("sign", tr("table.sign"), `<option value="negative">${escapeHtml(tr("table.signNeg"))}</option><option value="positive">${escapeHtml(tr("table.signPos"))}</option>`)}</div>
      <div class="tm-two" hidden>${sel("out", tr("table.colOut"), colOptions(state.m.out, true))}${sel("in", tr("table.colIn"), colOptions(state.m.in, true))}</div>
      <div class="tm-dollar-box" hidden>${sel("dollar", tr("table.dollarMeans"), currencyOptions(state.m.dollarCurrency || "USD"))}</div>
      ${sel("acol", tr("table.colAccount"), colOptions(state.m.account, true))}
      <details class="stmt-lines"><summary>${escapeHtml(tr("table.more"))}</summary>
        <label>${escapeHtml(tr("table.layoutName"))}</label><input type="text" class="tm-name" maxlength="60" placeholder="${escapeHtml(tr("table.layoutNameHint"))}" value="${escapeHtml(state.label)}">
        <div${screenMode === "import" ? "" : " hidden"}>${sel("cat", tr("table.colCategory"), colOptions(state.m.category, true))}</div>
        ${sel("type", tr("table.colType"), colOptions(state.m.type, true))}
        <div${screenMode === "import" ? "" : " hidden"}>${sel("note", tr("table.colNote"), colOptions(state.m.note, true))}</div>
        ${sel("currency", tr("table.colCurrency"), colOptions(state.m.currency, true))}
        ${sel("fixed", tr("table.currencyFixed"), currencyOptions(state.m.currencyFixed || homeCur()))}
        <div class="hint tm-fmt-read" hidden></div>
        <div class="tm-fmt-order">${sel("order", tr("table.dateOrder"), `<option value="dmy">${escapeHtml(tr("table.dmy"))}</option><option value="mdy">${escapeHtml(tr("table.mdy"))}</option>`)}</div>
        <div class="tm-fmt-decimal">${sel("decimal", tr("table.decimal"), `<option value=".">1,234.56</option><option value=",">1.234,56</option>`)}</div>
      </details>
      <div class="tm-preview"></div></div>
      <div class="tm-sec tm-sec-accts"><h4 class="accounts-group-title">${escapeHtml(tr("table.secAccounts"))}</h4>
      <div class="tm-single">${sel("account", tr(noneOk ? "imp.account" : "table.account"), accountOptions(state.accountId, "", singleNewOption))}<div class="tm-single-new"></div></div>
      <div class="tm-multi" hidden><p class="hint">${escapeHtml(tr("table.accountsHint"))}</p><div class="tm-newcard"></div><div class="tm-values"></div></div></div>
      <div class="tm-cats"></div>
      <div class="tm-use-why"></div>
      <p class="hint" style="margin:8px 0 0">${escapeHtml(tr("table.useHint"))}</p>
      <div class="stmt-choices" style="padding-left:0"><button type="button" class="primary tm-use">${escapeHtml(tr("table.use"))}</button></div></div>`;

    const root = body.querySelector(".tm-root");
    const $q = (cls) => root.querySelector(".tm-" + cls);
    const setVal = (cls, v) => { $q(cls).value = String(v); };
    const multi = () => state.m.account >= 0;
    const pm = () => accounts.find((a) => a.id === state.accountId) || null;
    const pmById = (id) => accounts.find((a) => a.id === id) || null;
    // ---- accounts the file names that the app does not have (owner, 2026-11-21; backend/StatementAccounts.gs) ----
    // A name of the file's account column that is none of the person's accounts starts on "New account: <name>"; the whole file can pick
    // "New account…" too. Choice "new:<name>" ("new:*" = the whole file); its name and type live in state.newAcct[<name>]. Nothing is
    // created until "Add to my history"; Undo removes it again. A hidden account of that name is shown again instead of a second one.
    const isNew = (c) => typeof c === "string" && c.indexOf("new:") === 0;
    const NEW_TYPES = ["debit", "credit", "wallet"];
    // ---- Yape and Plin are not accounts: they ride on a bank account (backend/Accounts.gs; owner, 2026-11-21) ----
    // A file's "Yape" is offered the person's BCP bank accounts, or a NEW one at BCP named "Yape" (renamable), whose last 4 digits are
    // asked for so bank e-mails and statements recognise it; Plin the same with a Scotiabank / BBVA / Interbank account. The save links
    // Yape / Plin to the account picked (Undo puts the old link back).
    const PLIN_BANKS = ["scotiabank", "bbva", "interbank"];
    const railOf = (value) => { const v = normName(value); return /^yape\b/.test(v) ? "yape" : /^plin\b/.test(v) ? "plin" : ""; };
    const bankNameOfPm = (a) => (((meta && meta.banks) || []).find((b) => String(b.id) === String(a.bank_id)) || {}).name || "";
    const railAllows = (rail, a) => {
      const bank = normName(bankNameOfPm(a));
      if (rail === "yape") return bank === "bcp" && a.type !== "credit";
      return a.type === "credit" ? bank === "interbank" : PLIN_BANKS.includes(bank);
    };
    const railAccounts = (rail) => accounts.filter((a) => railAllows(rail, a));
    // Banks a new account can name: the app's catalogue (main, then others) and any bank the person already has.
    function bankChoices(rail) {
      const cat = (meta && meta.bankCatalog) || { main: [], other: [] };
      const names = [...(cat.main || []), ...(cat.other || [])].map((b) => b.name);
      ((meta && meta.banks) || []).forEach((b) => { if (!names.some((n) => normName(n) === normName(b.name))) names.push(b.name); });
      return rail === "plin" ? names.filter((n) => PLIN_BANKS.includes(normName(n))) : names;
    }
    const hiddenMatch = (value) => value === "*" || railOf(value) ? null : ((meta && meta.paymentMethods) || []).find((a) => pmHidden_(a) && normName(a.nickname) === normName(value)) || null;
    function guessNewType(value) {
      const v = normName(value);
      if (/(card|tarjeta|visa|master|amex|american express|diners|credit|credito|cmr)/.test(v)) return "credit";
      if (/(paypal|wallet|billetera|monedero|mercado ?pago|tunki|lukita)/.test(v)) return "wallet";
      return "debit";
    }
    // The bank a name shows ("Latam BCP" → BCP; a catalogue bank's short name counts too), when exactly one does.
    function guessBankName(value) {
      const v = " " + normName(value) + " ";
      const cat = (meta && meta.bankCatalog) || { main: [], other: [] };
      const hits = [...(cat.main || []), ...(cat.other || [])].filter((b) => [b.name, b.short].some((n) => n && normName(n).length >= 3 && v.includes(" " + normName(n) + " ")));
      return hits.length === 1 ? hits[0].name : "";
    }
    function newSpec(value) {
      if (!state.newAcct[value]) {
        const name = value === "*" ? "" : String(value).replace(/\s+/g, " ").trim().slice(0, 60);
        const rail = value === "*" ? "" : railOf(value);
        const digits = name.match(/\d{4}/g) || [];
        state.newAcct[value] = { name, rail, type: rail ? "debit" : guessNewType(name), bankName: rail === "yape" ? "BCP" : rail ? "" : guessBankName(name), last4: digits.length === 1 ? digits[0] : "" };
      }
      return state.newAcct[value];
    }
    // What is wrong with the new accounts, if anything: "" | "empty" | "last4" | "plinBank" | the taken name.
    function newNameProblem() {
      const inFile = multi() ? new Set(StatementTable.distinctValues(rows, state.m, state.m.account).map((x) => x.value)) : null;
      const values = multi() ? Object.keys(state.map).filter((v) => inFile.has(v) && isNew(state.map[v]) && !hiddenMatch(v)) : (isNew(state.accountId) ? ["*"] : []);
      for (const v of values) {
        const sp = newSpec(v), n = String(sp.name || "").trim();
        if (!n) return "empty";
        const other = accounts.find((a) => normName(a.nickname) === normName(n));
        if (other) return other.nickname;
        if (sp.last4 && !/^\d{4}$/.test(String(sp.last4).trim())) return "last4";
        if (sp.rail === "plin" && !sp.bankName) return "plinBank";
      }
      return "";
    }
    const problemText = (p) => p === "empty" ? tr("imp.newAcctNeedName") : p === "last4" ? tr("imp.newAcctLast4Bad") : p === "plinBank" ? tr("imp.newAcctPlinBank") : tr("imp.newAcctTaken", { name: p });
    // What the save sends for a new account: the typed name, type, bank and last 4 digits, the file's currencies, and Yape / Plin.
    function newAccountPayload(value, accLines) {
      const hid = hiddenMatch(value);
      if (hid) return { name: hid.nickname, type: hid.type, unhideId: hid.id };
      const sp = newSpec(value), name = String(sp.name || "").trim().slice(0, 60);
      return { name, type: sp.rail ? "debit" : sp.type, last4: String(sp.last4 || "").trim(), bankName: sp.bankName || "", rail: sp.rail || "",
        currencies: [...new Set(accLines.map((l) => l.currency))].sort() };
    }
    const newTypeOptions = (sel) => NEW_TYPES.map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${escapeHtml(tr("accounts.type." + t))}</option>`).join("");
    const bankOptions = (rail, sel) => `<option value="">${escapeHtml(tr(rail === "plin" ? "imp.newAcctPickBank" : "imp.newAcctNoBank"))}</option>` +
      bankChoices(rail).map((n) => `<option value="${escapeHtml(n)}"${normName(n) === normName(sel) ? " selected" : ""}>${escapeHtml(n)}</option>`).join("");
    const last4Input = (sp) => `<label>${escapeHtml(tr("accounts.last4"))}</label><input type="text" class="tm-nlast4" inputmode="numeric" maxlength="4" placeholder="1234" value="${escapeHtml(sp.last4 || "")}">`;
    function newBoxHtml(value) {
      const sp = newSpec(value);
      const nameBox = `<label>${escapeHtml(tr("imp.newAcctName"))}</label><input type="text" class="tm-nname" maxlength="60" placeholder="${escapeHtml(tr("imp.newAcctNameHint"))}" value="${escapeHtml(sp.name)}">`;
      if (sp.rail) {
        return `<div class="tm-newacct" data-value="${escapeHtml(value)}"><p class="hint" style="margin:0 0 4px">${escapeHtml(tr(sp.rail === "yape" ? "imp.railYape" : "imp.railPlin"))}</p>${nameBox}
          ${sp.rail === "plin" ? `<label>${escapeHtml(tr("imp.newAcctBank"))}</label><select class="tm-nbank">${bankOptions("plin", sp.bankName)}</select>` : ""}
          ${last4Input(sp)}<p class="hint" style="margin:2px 0 0">${escapeHtml(tr(sp.rail === "yape" ? "imp.railLast4Yape" : "imp.railLast4Plin"))}</p></div>`;
      }
      return `<div class="tm-newacct" data-value="${escapeHtml(value)}">${nameBox}
        <label>${escapeHtml(tr("imp.newAcctTypeLabel"))}</label><select class="tm-ntype">${newTypeOptions(sp.type)}</select>
        <details class="tm-newmore"${sp.bankName || sp.last4 ? " open" : ""}><summary>${escapeHtml(tr("imp.newAcctMore"))}</summary>
          <label>${escapeHtml(tr("imp.newAcctBank"))}</label><select class="tm-nbank">${bankOptions("", sp.bankName)}</select>
          ${last4Input(sp)}<p class="hint" style="margin:2px 0 0">${escapeHtml(tr("imp.newAcctLast4Hint"))}</p></details></div>`;
    }
    // A "move" whose new account is no longer new is asked again; the lists show the new accounts' names as typed.
    function refreshNewMoves() {
      const ok = new Set(newMoveTargets().map((t) => t.id));
      Object.values(state.catDest).forEach((d) => { if (d && isNew(d.pmId) && !ok.has(d.pmId)) d.pmId = ""; if (d && isNew(d.herePmId) && !ok.has(d.herePmId)) d.herePmId = ""; });
      if (state.catItems.some((it) => state.catChoice[it.key] === "@move")) renderCategories();
    }
    function renderSingleNew() {
      const box = root.querySelector(".tm-single-new");
      box.innerHTML = isNew(state.accountId) ? newBoxHtml("*") : "";
    }
    currencyPickOn_($q("fixed"));
    currencyPickOn_($q("dollar"));
    const currentMapping = () => ({ ...state.m, currencyFixed: $q("fixed").value });

    // A guessed account for a name in the file: the app account whose nickname equals it or contains it (or the other way round).
    function guessAccountFor(value) {
      const v = normName(value);
      if (!v) return "";
      const rail = railOf(value);
      if (rail) {
        const st = (meta && meta.settings) || {};
        const linked = railAccounts(rail).find((a) => [st[rail + "_pen"], st[rail + "_usd"]].includes(a.id));
        if (linked) return linked.id;
        const named = railAccounts(rail).find((a) => normName(a.nickname) === v);
        return named ? named.id : "";
      }
      const hit = accounts.find((a) => normName(a.nickname) === v) || accounts.find((a) => normName(a.nickname).includes(v) || v.includes(normName(a.nickname)));
      if (hit) return hit.id;
      // "Cash" / "Efectivo" in another app's export is the app's own Cash, whatever its name in this language (never a second cash account).
      if (/^(cash|efectivo|dinero en efectivo|cash wallet)$/.test(v)) { const cash = accounts.find((a) => a.type === "cash"); if (cash) return cash.id; }
      // "Interbank 1408" in another app's export: the account whose last 4 digits are in the name, when only one has them (journeys run,
      // 2026-11-17: all 712 lines of a Money Manager file were saved with no account).
      const digits = String(value).match(/\d{4}/g) || [];
      const byDigits = accounts.filter((a) => a.last_4 && digits.includes(String(a.last_4).padStart(4, "0")));
      return byDigits.length === 1 ? byDigits[0].id : "";
    }
    function renderValues() {
      const box = root.querySelector(".tm-values");
      if (!multi()) { box.innerHTML = ""; return; }
      const values = StatementTable.distinctValues(rows, state.m, state.m.account);
      values.forEach((v) => {
        const c = state.map[v.value];
        if (c === "skip" || c === "none" || pmById(c)) return;   // (a remembered "new" is looked up again: the account may exist by now)
        const g = guessAccountFor(v.value);
        if (g) state.map[v.value] = g;
        else if (newOk) state.map[v.value] = "new:" + v.value;   // a name the app does not know starts on "New account" (owner, 2026-11-21)
        else delete state.map[v.value];
      });
      box.innerHTML = values.map((v) => {
        const c = state.map[v.value], hid = hiddenMatch(v.value);
        const rl = railOf(v.value);
        const newOpt = newOk ? `<option value="new:${escapeHtml(v.value)}"${isNew(c) ? " selected" : ""}>${escapeHtml(tr(hid ? "imp.showAgainOption" : rl ? (rl === "yape" ? "imp.newBcpOption" : "imp.newPlinOption") : "imp.newAcctOption", { name: hid ? hid.nickname : v.value }))}</option>` : "";
        return `<div class="tm-value" data-value="${escapeHtml(v.value)}"><label>${escapeHtml(tr("table.valueLines", { value: v.value, n: v.count }))}</label>
        <select class="tm-vacct">${accountOptions(c === "none" ? "" : c, newOpt + `<option value="skip"${c === "skip" ? " selected" : ""}>${escapeHtml(tr("table.skipValue"))}</option>`, "", railOf(v.value) ? railAccounts(railOf(v.value)) : null)}</select>${isNew(c) && !hid ? newBoxHtml(v.value) : ""}</div>`;
      }).join("");
      renderNewCard();
    }
    // "2 accounts in this file aren't in your app yet": said once, above the names, while any name is on "New account".
    function renderNewCard() {
      const card = root.querySelector(".tm-newcard");
      const n = multi() ? Object.keys(state.map).filter((v) => isNew(state.map[v]) && StatementTable.distinctValues(rows, state.m, state.m.account).some((x) => x.value === v)).length : 0;
      card.innerHTML = n ? `<p class="stmt-note info">${escapeHtml(tr("imp.newAcctsCard", { n }))}</p>` : "";
    }
    function syncControlsFromState() {
      const two = state.m.out >= 0 && state.m.in >= 0;
      setVal("mode", two ? "two" : "one");
      root.querySelector(".tm-one").hidden = two;
      root.querySelector(".tm-two").hidden = !two;
      setVal("sign", state.m.sign || "negative");
      setVal("order", state.m.dateOrder || "dmy");
      setVal("decimal", state.m.decimal || ".");
      // Dates and numbers the file itself settles: one line "From the file: …  Change" instead of the two lists (owner, 2026-11-21).
      const dateSet = !state.fmtOpen && !!guess.dateClear && state.m.dateOrder === guess.dateOrder;
      const decSet = !state.fmtOpen && !!guess.decimalClear && (state.m.decimal || ".") === (guess.decimal || ".");
      root.querySelector(".tm-fmt-order").hidden = dateSet;
      root.querySelector(".tm-fmt-decimal").hidden = decSet;
      const read = root.querySelector(".tm-fmt-read");
      read.hidden = !dateSet && !decSet;
      read.innerHTML = read.hidden ? "" : [dateSet ? tr("table.fmtDates", { order: tr(state.m.dateOrder === "mdy" ? "table.mdy" : "table.dmy") }) : "", decSet ? tr("table.fmtNumbers", { sample: state.m.decimal === "," ? "1.234,56" : "1,234.56" }) : ""]
        .filter(Boolean).map((t) => `<span style="display:block">${escapeHtml(t)}</span>`).join("") + `<button type="button" class="add-inline tm-fmt-change" style="margin-top:4px">${escapeHtml(tr("table.fmtChange"))}</button>`;
      setVal("fixed", state.m.currencyFixed || homeCur());
      root.querySelector(".tm-single").hidden = multi();
      renderSingleNew();
      root.querySelector(".tm-multi").hidden = !multi();
      root.querySelector(".tm-dollar-box").hidden = !(state.m.lineCurrency && state.m.bareDollar && state.m.currency < 0);
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
    // ---- where a file's category goes when it is not spending or income (owner, 2026-11-20) ----
    // A choice that starts with "@" is a place in the app instead of a category: "@loan" (Loans, with a person), "@move" (money moving to
    // or from another of the person's accounts), "@invest" (Investments), "@review" (Needs review, sorted one by one). Its details live in
    // state.catDest[key]; they are remembered with the layout under "~dest:<key>". Loans and moves need a backend that saves them.
    const destCaps = () => !!(((typeof meta !== "undefined" && meta && meta.capabilities) || {}).importDest);
    const isDest = (c) => typeof c === "string" && c.charAt(0) === "@";
    const destFriends = () => ((meta && meta.friends) || []).filter((f) => !(typeof isGroupFriend_ === "function" && isGroupFriend_(f)))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const destPlatforms = () => (((typeof meta !== "undefined" && meta && meta.paymentMethods) || []).filter((pm) => pm.type === "investment" && !pmHidden_(pm)));
    function destValid(d) {
      if (!d || !d.kind) return false;
      if (d.kind === "loan") return destCaps() && (!d.friendId || destFriends().some((f) => f.id === d.friendId));
      if (d.kind === "move") return destCaps() && (!d.pmId || accounts.some((a) => a.id === d.pmId) || newMoveTargets().some((t) => t.id === d.pmId));
      return d.kind === "invest" || d.kind === "review";
    }
    // The accounts this import will create, as places a "move" can go: [{ id: "new:<name>", name }] (owner's test, 2026-11-21: a file's
    // "Ahorro" lines had nowhere to go on a copy whose savings account was itself one of the file's new names).
    function newMoveTargets() {
      if (!(((typeof meta !== "undefined" && meta && meta.capabilities) || {}).importNewAccounts)) return [];
      if (state.m.account < 0) return state.accountId === "new:*" && state.newAcct["*"] ? [{ id: "new:*", name: String(state.newAcct["*"].name || "").trim() || "…" }] : [];
      return StatementTable.distinctValues(rows, state.m, state.m.account).filter((v) => String(state.map[v.value] || "").indexOf("new:") === 0)
        .map((v) => ({ id: "new:" + v.value, name: String((state.newAcct[v.value] || {}).name || v.value).trim() || v.value }));
    }
    function parseDest(text) { try { const d = JSON.parse(String(text || "")); return d && typeof d === "object" ? d : null; } catch (e) { return null; } }
    // ---- the lines of one category of the file (owner, 2026-11-21: "see the lines of each group") ----
    function itemLines(it) {
      return StatementTable.applyMapping(rows, currentMapping()).lines.filter((l) => l.category && (l.amount > 0 ? "income" : "expense") + ":" + StatementTable.catNorm(l.category) === it.key);
    }
    const lineHtml = (l) => `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`;
    const ITEM_LINES_MAX = 200;
    function itemLinesFold(it) {
      const lines = itemLines(it);
      if (!lines.length) return "";
      return `<details class="tm-cat-lines"><summary>${escapeHtml(tr("table.catSeeLines", { n: lines.length }))}</summary>${lines.slice(0, ITEM_LINES_MAX).map(lineHtml).join("")}${lines.length > ITEM_LINES_MAX ? `<p class="hint">${escapeHtml(tr("table.catLinesMore", { n: lines.length - ITEM_LINES_MAX }))}</p>` : ""}</details>`;
    }
    // The account a line of the file will be saved on, as it reads ("Yape", "IO (new account)"), or "" for none.
    function lineAccountLabel(l) {
      const c = multi() ? state.map[l.account] : state.accountId;
      if (isNew(c)) { const v = c.slice(4); const hid = hiddenMatch(v); return hid ? hid.nickname : tr("imp.newAcctHeader", { name: String(newSpec(v).name || v).trim() || v }); }
      const a = pmById(c);
      return a ? a.nickname : "";
    }
    // ---- a loan line's person: the one the person picked for it, else the friend its description names (one only) ----
    const loanLineKey = (l) => [l.date, Number(l.amount).toFixed(2), l.currency, String(l.description || "").trim()].join("|");
    const friendName = (id) => ((destFriends().find((f) => f.id === id) || {}).name || "");
    // Whether a description names this friend: "full" (the whole saved name), "first" (the first name alone, with no OTHER surname
    // after it: "Prestamo a Carlos Ruiz" is not the friend "Carlos Vega"; Mark, testers 2026-11-21), or "" (not named). A following
    // number, connector or bank word ("Carlos transf", "Carlos 15/11") still counts; a friend saved with only a first name keeps
    // the plain first-name match. text = normName(description).
    function friendNamedIn(f, text) {
      const full = normName(f.name), first = full.split(" ")[0];
      if (!first || first.length < 2) return "";
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(^|[^a-z0-9])" + esc(full) + "([^a-z0-9]|$)").test(text)) return "full";
      const reFirst = new RegExp("(^|[^a-z0-9])" + esc(first) + "(?![a-z0-9])(?:[^a-z0-9]+([a-z]+)(?![a-z]))?", "g");
      const rest = full.split(" ").slice(1);
      let m;
      while ((m = reFirst.exec(text))) {
        const next = m[2] || "";
        if (!next || !rest.length || rest.indexOf(next) >= 0 || NAME_FOLLOW_WORDS_.indexOf(next) >= 0 || next.length < 3) return "first";
      }
      return "";
    }
    function friendForLine(l) {
      const text = normName(l.description);
      const full = destFriends().filter((f) => friendNamedIn(f, text) === "full");
      if (full.length === 1) return full[0].id;
      if (full.length > 1) return "";
      const first = destFriends().filter((f) => friendNamedIn(f, text) === "first");
      return first.length === 1 ? first[0].id : "";
    }
    function loanLineFriend(d, l) {
      const k = loanLineKey(l), pick = d && d.lineFriends;
      if (pick && Object.prototype.hasOwnProperty.call(pick, k)) return destFriends().some((f) => f.id === pick[k]) ? pick[k] : "";
      return friendForLine(l);
    }
    // The person the lines of this category name most ("prestamo ana" → Ana), when one stands out.
    function guessFriendFor(it) {
      const lines = StatementTable.applyMapping(rows, currentMapping()).lines.filter((l) => l.category && (l.amount > 0 ? "income" : "expense") + ":" + StatementTable.catNorm(l.category) === it.key);
      let best = "", bestN = 0, tie = false;
      destFriends().forEach((f) => {
        const n = lines.filter((l) => friendNamedIn(f, normName(l.description))).length;
        if (n > bestN) { best = f.id; bestN = n; tie = false; } else if (n && n === bestN) tie = true;
      });
      return bestN && !tie ? best : "";
    }
    // Money RECEIVED in a loans category ("Préstamos") starts on "They repaid me" when everyone its lines name owes the person
    // something in that currency — before the file (Loans' balances) or through this file's own money lent to them; otherwise on
    // "They lent me money" (owner's choice, 2026-11-21, after Elena's test: her friends' repayments started as loans). Money sent
    // keeps "I lent money". The balances are asked once, in the background; the choice follows them until the person picks one.
    let loanBalAsked = false;
    function defaultLoanKind(it) {
      if (it.type === "expense") return "loan";
      if (typeof loansLastBalances_ === "undefined") return "loan";
      if (!loansLastBalances_ && !loanBalAsked && destCaps()) {
        loanBalAsked = true;
        callApi("listLoanBalances", {}).then((b) => {
          if (!loansLastBalances_) loansLastBalances_ = (b && b.balances) || b;
          let changed = false;
          state.catItems.forEach((x) => {
            const d = state.catDest[x.key];
            if (d && d.kind === "loan" && d.kindAuto && x.type !== "expense") { const k = defaultLoanKind(x); if (k !== d.loanKind) { d.loanKind = k; changed = true; } }
          });
          if (changed) { renderCategories(); renderPreview(); }
        }).catch(() => {});
      }
      const owed = new Map();   // friend id|currency -> what they owe the person
      (loansLastBalances_ || []).forEach((b) => (b.balances || []).forEach((l) => owed.set(b.friend_id + "|" + String(l.currency).toUpperCase(), Number(l.net) || 0)));
      state.catItems.filter((x) => x.type === "expense" && (x.family === "loan" || x.family === "repay")).forEach((x) => itemLines(x).forEach((l) => {
        const who = friendForLine(l);
        if (who && x.family === "loan") { const k = who + "|" + String(l.currency).toUpperCase(); owed.set(k, (owed.get(k) || 0) + Math.abs(Number(l.amount) || 0)); }
      }));
      const named = itemLines(it).map((l) => ({ who: friendForLine(l), cur: String(l.currency).toUpperCase() })).filter((x) => x.who);
      return named.length && named.every((x) => (owed.get(x.who + "|" + x.cur) || 0) > 0.004) ? "repayment" : "loan";
    }
    function familyDest(it) {
      const fam = it.family;
      if (fam === "invest") return { kind: "invest", platformId: "" };
      if (!destCaps()) return fam === "loan" || fam === "repay" || fam === "saving" || fam === "cash" ? { kind: "review" } : null;
      if (fam === "loan" || fam === "repay") return { kind: "loan", friendId: guessFriendFor(it), loanKind: fam === "repay" ? "repayment" : defaultLoanKind(it), kindAuto: fam !== "repay" };
      const others = accounts.filter((a) => a.id !== state.accountId);
      if (fam === "saving") { const a = others.find((x) => /ahorro|saving/.test(normName(x.nickname))); return { kind: "move", pmId: a ? a.id : "" }; }
      if (fam === "cash") { const a = others.find((x) => x.type === "cash"); return { kind: "move", pmId: a ? a.id : "" }; }
      return null;
    }
    const destMissing = () => state.catItems.some((it) => {
      const c = state.catChoice[it.key], d = state.catDest[it.key] || {};
      return c === "@move" && !d.pmId;   // a loan line with no person waits in Needs review (owner, 2026-11-21)
    });
    function destHtml(it) {
      const c = state.catChoice[it.key], d = state.catDest[it.key] || {};
      if (c === "@loan") {
        // No single "Who with?" (owner, 2026-11-21: a file's loans are usually with several people). Each line goes to the friend whose
        // name its description shows; every line is listed under its person with its own choice, so a wrong guess is corrected there.
        // A line with no person waits in Needs review, where the person is picked one by one.
        const out = it.type === "expense";
        const lines = itemLines(it), fr = destFriends();
        const groups = new Map();
        lines.forEach((l) => { const f = loanLineFriend(d, l); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(l); });
        const order = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : friendName(a).localeCompare(friendName(b))));
        const lineRow = (l) => `<div class="tm-loan-line">${lineHtml(l)}${fr.length ? `<select class="tm-lfriend" data-line="${escapeHtml(loanLineKey(l))}" aria-label="${escapeHtml(tr("table.destWho"))}"><option value="">${escapeHtml(tr("table.loanNoPerson"))}</option>${fr.map((f) => `<option value="${escapeHtml(f.id)}"${f.id === loanLineFriend(d, l) ? " selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}</select>` : ""}</div>`;
        const groupsHtml = order.map((f) => `<div class="tm-loan-group"><div class="tm-loan-who"><strong>${escapeHtml(f ? friendName(f) : tr("table.loanNobody"))}</strong> <span class="hint">· ${escapeHtml(tr("table.catLines", { n: groups.get(f).length }))}</span></div>
          ${f ? "" : `<p class="hint" style="margin:2px 0 4px">${escapeHtml(tr(fr.length ? "table.loanNobodyHint" : "table.loanNoFriendsHint"))}</p>`}${groups.get(f).map(lineRow).join("")}</div>`).join("");
        return `<label>${escapeHtml(tr("table.destKind"))}</label><select class="tm-dkind"><option value="loan"${d.loanKind !== "repayment" ? " selected" : ""}>${escapeHtml(tr(out ? "table.destOutLoan" : "table.destInLoan"))}</option><option value="repayment"${d.loanKind === "repayment" ? " selected" : ""}>${escapeHtml(tr(out ? "table.destOutRepay" : "table.destInRepay"))}</option></select>
          <p class="hint" style="margin:8px 0 4px">${escapeHtml(tr("table.loanByPerson"))}</p>${groupsHtml}`;
      }
      if (c === "@move") {
        // The lines' own side (owner, 2026-11-21): the account each line is in, shown; asked (optional) only for lines with no account.
        const out = it.type === "expense", origins = new Map();
        itemLines(it).forEach((l) => { const k = lineAccountLabel(l); origins.set(k, (origins.get(k) || 0) + 1); });
        const known = [...origins.entries()].filter(([k]) => k), unknown = origins.get("") || 0;
        const hereOpts = `<option value="">${escapeHtml(tr("table.destHereNone"))}</option>` + accounts.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === d.herePmId ? " selected" : ""}>${escapeHtml(a.nickname)}</option>`).join("")
          + newMoveTargets().map((t) => `<option value="${escapeHtml(t.id)}"${t.id === d.herePmId ? " selected" : ""}>${escapeHtml(tr("imp.newAcctHeader", { name: t.name }))}</option>`).join("");
        const hereHtml = (known.length ? `<p class="tm-move-here"><span class="hint">${escapeHtml(tr(out ? "table.destFromLabel" : "table.destIntoLabel"))}</span> ${escapeHtml(known.map(([k, n]) => tr("table.destHereItem", { name: k, n })).join(", "))}</p>` : "")
          + (unknown ? `<label>${escapeHtml(tr(out ? "table.destFromAsk" : "table.destIntoAsk", { n: unknown }))}</label><select class="tm-dhere">${hereOpts}</select>` : "");
        // The account the lines are already on is never offered as the other side (Mark, testers 2026-11-21: it was refused only
        // after the final confirm).
        const ownIds = new Set(itemLines(it).map((l) => (multi() ? state.map[l.account] : state.accountId)).filter(Boolean));
        ownIds.add(state.accountId);
        if (d.pmId && ownIds.has(d.pmId)) d.pmId = "";
        const news = newMoveTargets().filter((t) => !ownIds.has(t.id)).map((t) => `<option value="${escapeHtml(t.id)}"${t.id === d.pmId ? " selected" : ""}>${escapeHtml(tr("imp.newAcctHeader", { name: t.name }))}</option>`).join("");
        return `${hereHtml}<label>${escapeHtml(tr(it.type === "expense" ? "table.destMoveTo" : "table.destMoveFrom"))}</label><select class="tm-dpm"><option value="">${escapeHtml(tr("table.destPickAccount"))}</option>${accounts.filter((a) => !ownIds.has(a.id)).map((a) => `<option value="${escapeHtml(a.id)}"${a.id === d.pmId ? " selected" : ""}>${escapeHtml(a.nickname)}</option>`).join("")}${news}</select>`;
      }
      if (c === "@invest") {
        const plats = destPlatforms();
        return plats.length ? `<label>${escapeHtml(tr("table.destPlatform"))}</label><select class="tm-dplat"><option value="">${escapeHtml(tr("table.destNoPlatform"))}</option>${plats.map((pl) => `<option value="${escapeHtml(pl.id)}"${pl.id === d.platformId ? " selected" : ""}>${escapeHtml(pl.nickname)}</option>`).join("")}</select>` : "";
      }
      return "";
    }
    // What the save sends (result.catDest) and what the layout remembers ("~dest:<key>", "" = none any more).
    function destsToSend() {
      const out = {};
      state.catItems.forEach((it) => {
        const c = state.catChoice[it.key];
        if (!isDest(c)) return;
        const d = { ...(state.catDest[it.key] || {}), kind: c.slice(1) };
        if (d.kind === "loan") { const lf = {}; itemLines(it).forEach((l) => { lf[loanLineKey(l)] = loanLineFriend(state.catDest[it.key], l); }); d.lineFriends = lf; delete d.friendId; }
        out[it.key] = d;
      });
      return out;
    }
    function destFlags() {
      const out = {};
      state.catItems.forEach((it) => { const c = state.catChoice[it.key]; out["~dest:" + it.key] = isDest(c) ? JSON.stringify({ ...(state.catDest[it.key] || {}), lineFriends: undefined, kind: c.slice(1) }) : ""; });
      return out;
    }
    const plainChoices = (choices) => Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== "skip" && !isDest(v)));
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
      // An existing category keeps its own name by default; taking the file's name is the person's choice ("Rename to …"). (Owner,
      // 2026-11-17, journeys run: on a new copy every starter category is still empty, so the old rule — an empty category takes the
      // file's name — renamed Transport to "Taxi", Restaurants to "Food" and Home to "Household" without anyone asking for it.)
      return info.name;
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
        const savedDest = parseDest(state.catSaved["~dest:" + it.key]);
        if (state.catChoice[it.key] === undefined && savedDest && destValid(savedDest)) {   // remembered with the layout: the same place again
          state.catChoice[it.key] = "@" + savedDest.kind; state.catDest[it.key] = savedDest; state.catNames[it.key] = "";
          return;
        }
        if (state.catChoice[it.key] === undefined) {
          state.catChoice[it.key] = remembered !== undefined && valid(remembered) ? remembered : (it.action === "match" ? it.categoryId : it.action === "create" ? "create" : "");
          const info = catInfo(state.catChoice[it.key]);
          // A rename the person chose for this layout last time is offered again; otherwise the category keeps its own name.
          const renamedBefore = state.catSaved["~rename:" + it.key] === true && state.catSaved["~name:" + it.key];
          const mine = String(renamedBefore || "");
          const alreadyMine = !!(info && mine && info.names.indexOf(StatementTable.catNorm(mine)) !== -1);
          state.catNames[it.key] = info && mine && !alreadyMine && !info.protected ? mine : defaultNameFor(it, state.catChoice[it.key]);
          const custom = state.catSaved["~custom:" + it.key];                // a new category the person named themselves last time
          if (state.catChoice[it.key] === "create" && custom) { state.catCustom[it.key] = true; state.catNames[it.key] = custom; }
          // Not spending or income (a loan, savings, cash, an investment): the matching place in the app is suggested, shown open.
          const fd = remembered === undefined && it.action !== "match" && screenMode === "import" ? familyDest(it) : null;
          if (fd) { state.catChoice[it.key] = "@" + fd.kind; state.catDest[it.key] = fd; state.catNames[it.key] = ""; }
        }
      });
      renderCategories();
      renderPreview();   // a place that still needs a person or an account holds the button
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
      let used = 0, created = 0, left = 0, renamed = 0, skipped = 0, dest = 0;
      state.catItems.forEach((it) => {
        const c = state.catChoice[it.key];
        if (c === "create") created++; else if (c === "") left++; else if (c === "skip") skipped++; else if (isDest(c)) dest++; else { used++; if (renameOf(it)) renamed++; }
      });
      return tr(renamed ? "table.catSummaryRenamed" : "table.catSummary", { used, renamed, created, left }) + (dest ? " · " + tr("table.catSummaryDest", { n: dest }) : "") + (skipped ? " · " + tr("table.catSummarySkipped", { n: skipped }) : "");
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
      if (isDest(c)) return tr("table.destHint." + c.slice(1));
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
    // Names that differ (owner, 2026-11-04): a file category that lands in one of the person's categories which already holds entries
    // under another name ("Food & Drink" → your "Restaurants", 12 entries). Said plainly above the list, so it is never missed.
    function nameConflicts() {
      return state.catItems.map((it) => {
        const info = catInfo(state.catChoice[it.key]);
        if (!info || !info.entries || info.names.indexOf(StatementTable.catNorm(it.name)) !== -1) return null;
        return { it, info, renamed: !!renameOf(it) };
      }).filter(Boolean);
    }
    function conflictHtml() {
      const list = nameConflicts();
      if (!list.length) return "";
      const lines = list.map((c) => `<li>${escapeHtml(tr(c.renamed ? "table.conflictRenamed" : "table.conflictKept", { file: shownName(c.it.name, c.it.type), mine: shownName(c.info.name, c.it.type), to: String(state.catNames[c.it.key] || "").trim(), n: c.info.entries }))}</li>`).join("");
      return `<div class="stmt-note warn tm-cat-conflicts"><p style="margin:0 0 4px"><strong>${escapeHtml(tr("table.conflictTitle", { n: list.length }))}</strong></p><ul style="margin:0 0 4px;padding-left:18px">${lines}</ul>${list.some((c) => !c.renamed) ? `<p style="margin:0">${escapeHtml(tr("table.conflictHow"))}</p>` : ""}</div>`;
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
          return (renamable ? `<option value="ren:${escapeHtml(c.id)}"${selVal === "ren:" + c.id ? " selected" : ""}>${escapeHtml(tr("table.catOptRename", { from: catOptionText_(c), to: shownName(it.name, it.type) }) + n)}</option>` : "") +
            `<option value="${escapeHtml(c.id)}"${selVal === c.id ? " selected" : ""}>${escapeHtml(catOptionText_(c) + n)}</option>`;
        }).join("");
        const nameInput = selVal === "custom" ? `<label>${escapeHtml(tr("table.catCustomLabel"))}</label><input type="text" class="tm-cname" maxlength="40" aria-label="${escapeHtml(tr("table.catName"))}" value="${escapeHtml(state.catNames[it.key] || "")}">` : "";
        const note = isDest(cur) && it.family ? `<p class="stmt-note info" style="margin:6px 0">${escapeHtml(tr("table.destNote"))}</p>`
          : it.why === "retired" && !isDest(cur) ? `<p class="stmt-note warn" style="margin:6px 0">${escapeHtml(tr("table.catLoanNote"))}</p>` : "";
        const destOpts = screenMode === "import" ? `<optgroup label="${escapeHtml(tr("table.destGroup"))}">
            ${destCaps() ? `<option value="@loan"${cur === "@loan" ? " selected" : ""}>${escapeHtml(tr("table.destLoan"))}</option><option value="@move"${cur === "@move" ? " selected" : ""}>${escapeHtml(tr("table.destMove"))}</option>` : ""}
            <option value="@invest"${cur === "@invest" ? " selected" : ""}>${escapeHtml(tr("table.destInvest"))}</option>
            <option value="@review"${cur === "@review" ? " selected" : ""}>${escapeHtml(tr("table.destReview"))}</option></optgroup>` : "";
        return `<div class="tm-cat-row" data-key="${escapeHtml(it.key)}">
          <div><span class="hint" style="margin-right:6px">${escapeHtml(tr("table.catFromFile"))}</span><strong>${escapeHtml(shownName(it.name, it.type))}</strong> <span class="hint">· ${escapeHtml(tr("table.catLines", { n: it.count }))}</span></div>
          ${note}
          <label>${escapeHtml(tr("table.catGoesIntoLabel"))}</label>
          <select class="tm-cchoice"><optgroup label="${escapeHtml(tr("table.catYours"))}">${opts}</optgroup>
            <option value="create"${selVal === "create" ? " selected" : ""}>${escapeHtml(tr("table.catCreate", { name: it.name }))}</option>
            <option value="custom"${selVal === "custom" ? " selected" : ""}>${escapeHtml(tr("table.catCustom"))}</option>
            <option value=""${selVal === "" ? " selected" : ""}>${escapeHtml(tr("table.catLeave"))}</option>
            <option value="skip"${selVal === "skip" ? " selected" : ""}>${escapeHtml(tr("table.catSkip"))}</option>${destOpts}</select>
          ${nameInput}${destHtml(it)}
          <p class="hint tm-cat-hint" style="margin:2px 0 0">${escapeHtml(rowHint(it))}</p>${cur === "@loan" ? "" : itemLinesFold(it)}</div>`;
      };
      const groupHtml = (type) => {
        const items = state.catItems.filter((it) => it.type === type);
        return items.length ? `<h4 class="accounts-group-title">${escapeHtml(tr(type === "income" ? "table.catGroupIncome" : "table.catGroupExpense"))}</h4>${items.map(rowHtml).join("")}` : "";
      };
      const open = nameConflicts().length > 0 || destMissing() || (!Object.keys(state.catSaved).length && state.catItems.some((it) => state.catChoice[it.key] === "create" || renameOf(it) || it.why === "retired" || isDest(state.catChoice[it.key])));
      setTimeout(() => {   // the five people used most recently, then More… (one friends screen); accounts the same way
        box.querySelectorAll(".tm-dfriend, .tm-lfriend").forEach((sel) => { if (typeof personShortList_ === "function") personShortList_(sel); });
        box.querySelectorAll(".tm-dpm").forEach((sel) => { if (typeof accountShortList_ === "function") accountShortList_(sel); });
      });
      box.innerHTML = `<h4 class="accounts-group-title">${escapeHtml(tr("table.secCategories"))}</h4><p class="stmt-note info tm-cat-summary">${escapeHtml(categorySummary())}</p>
        <div class="tm-cat-conflict-box">${conflictHtml()}</div>
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
      const cb = root.querySelector(".tm-cat-conflict-box");
      if (cb) cb.innerHTML = conflictHtml();
    }
    function renderPreview() {
      const m = currentMapping();
      const r = StatementTable.applyMapping(rows, m);
      const { lines, undecided } = usableLines(r.lines);
      const box = root.querySelector(".tm-preview");
      const use = root.querySelector(".tm-use");
      const why = root.querySelector(".tm-use-why");
      const setWhy = (keys) => { why.innerHTML = keys.map((t) => `<p class="stmt-note warn">${escapeHtml(t)}</p>`).join(""); };
      if (!r.lines.length) {
        box.innerHTML = `<p class="stmt-note warn">${escapeHtml(tr("table.noLines"))}</p>`;
        use.disabled = true;
        setWhy([tr("table.whyNoLines")]);
        return;
      }
      // Every date reads two ways and none proves the order (10/04/2026): the person says how the file writes them before anything is
      // shown (owner, 2026-11-18). A file that proves it (31/01/2026) is never asked. The answer is remembered with the layout.
      if (!state.m.dateOrder) {
        const sample = state.m.dateSample || "";
        const asIs = (order) => { const iso = StatementTable.toIsoDate(sample, order); return iso ? fmtDate(iso, true) : ""; };
        box.innerHTML = `<p class="stmt-note warn">${escapeHtml(tr("table.dateAsk", { date: sample }))}</p>
          <div class="stmt-choices" style="padding-left:0">
            <button type="button" class="stmt-choice tm-dord" data-order="dmy">${escapeHtml(tr("table.dateAskDmy", { date: asIs("dmy") }))}</button>
            <button type="button" class="stmt-choice tm-dord" data-order="mdy">${escapeHtml(tr("table.dateAskMdy", { date: asIs("mdy") }))}</button>
          </div>`;
        box.querySelectorAll(".tm-dord").forEach((b) => b.addEventListener("click", () => {
          state.m.dateOrder = b.dataset.order;
          state.dateAnswered = true;
          setVal("order", b.dataset.order);
          renderPreview();
        }));
        use.disabled = true;
        setWhy([tr("table.whyDate")]);
        return;
      }
      const needCategory = screenMode === "import" && state.m.category < 0;   // another app's export names a category for every line
      const nameProblem = newNameProblem();
      use.disabled = needCategory || destMissing() || !!nameProblem || (multi() ? (undecided > 0 || !lines.length) : (!noneOk && !pm() && !isNew(state.accountId)));
      // Every reason the button is off, said right above it (owner, 2026-11-21: a tap on a button that looked like the others did nothing).
      setWhy(use.disabled ? [needCategory ? tr("imp.needCategory") : "", destMissing() ? tr("table.destMissing") : "",
        nameProblem ? problemText(nameProblem) : "",
        multi() && undecided ? tr("table.pickEach") : "", !multi() && !noneOk && !pm() && !isNew(state.accountId) ? tr("table.whyAccount") : "",
        multi() && !undecided && !lines.length ? tr("table.whyNoLines") : ""].filter(Boolean) : []);
      // Not blocking, only a heads-up: with accounts set up, a person usually wants the entries on one of them.
      // An import may leave a name of the file's account column with no account: say how many lines that is, before saving.
      const noAcctLines = multi() && noneOk ? lines.filter((l) => !state.map[l.account] || state.map[l.account] === "none").length : 0;
      const noAccountNote = noneOk && !needCategory && !multi() && !pm() && !isNew(state.accountId) ? `<p class="stmt-note info">${escapeHtml(tr(accounts.some((a) => a.type !== "cash") ? "imp.noAccountWarn" : "imp.noAccountsInfo"))}</p>` : "";
      const totals = {};
      lines.forEach((l) => { const t = totals[l.currency] || (totals[l.currency] = { out: 0, in: 0 }); if (l.amount < 0) t.out += -l.amount; else t.in += l.amount; });
      const sum = (key) => Object.keys(totals).sort().filter((c) => totals[c][key] > 0).map((c) => fmtMoney(c, totals[c][key])).join(" + ") || "—";
      const dates = lines.map((l) => l.date).sort();
      box.innerHTML = `<div class="stmt-kv"><span>${escapeHtml(lines.length ? tr("table.previewLines", { n: lines.length, from: fmtDate(dates[0], true), to: fmtDate(dates[dates.length - 1], true) }) : "—")}</span><span></span></div>
        <div class="stmt-kv"><span>${escapeHtml(tr("table.out"))}</span><span>${escapeHtml(sum("out"))}</span></div>
        <div class="stmt-kv"><span>${escapeHtml(tr("table.in"))}</span><span>${escapeHtml(sum("in"))}</span></div>
        ${skippedFold(r.skipped.filter((x) => x.reason !== "transfer"))}
        ${r.skipped.some((x) => x.reason === "amountUnclear") ? `<p class="stmt-note warn">${escapeHtml(tr("table.warnUnclear", { n: r.skipped.filter((x) => x.reason === "amountUnclear").length }))}</p>` : ""}
        ${fileWarnings(lines)}
        ${r.skipped.some((x) => x.reason === "transfer") ? `<p class="stmt-note warn">${escapeHtml(tr("table.transferNoDirection", { n: r.skipped.filter((x) => x.reason === "transfer").length }))}</p>` : ""}
        ${lines.some((l) => l.transfer) ? `<p class="stmt-note info">${escapeHtml(tr("table.transfersMarked", { n: lines.filter((l) => l.transfer).length }))}</p>` : ""}
        ${(state.source === "new" || state.dateFromFile) && guess.dateProved && !state.dateAnswered && state.m.dateOrder === guess.dateOrder ? `<p class="stmt-note info">${escapeHtml(tr(state.m.dateOrder === "mdy" ? "table.datesReadMdy" : "table.datesReadDmy"))}</p>` : ""}
        ${state.m.lineCurrency && state.m.currency < 0 ? `<p class="stmt-note info">${escapeHtml(lineCurrencyText(lines, m))}</p>` : ""}
        ${guess.currencyMixed && state.m.currency < 0 && !state.m.lineCurrency ? `<p class="stmt-note warn">${escapeHtml(tr("table.mixedCur", { signs: guess.currencyMixed, cur: m.currencyFixed || homeCur() }))}</p>` : ""}
        ${state.signCurrency && m.currencyFixed === state.signCurrency && state.m.currency < 0 ? `<p class="stmt-note info">${escapeHtml(tr("table.readAsSign", { cur: state.signCurrency, sign: guess.currencySign }))}</p>` : ""}
        ${noAccountNote}
        ${multi() && noneOk && noAcctLines ? `<p class="stmt-note warn">${escapeHtml(tr("imp.noAccountLines", { n: noAcctLines }))}</p>` : ""}
        ${r.lines.length > TABLE_BIG_FILE ? `<p class="stmt-note warn">${escapeHtml(tr("table.bigFile", { n: r.lines.length }))}</p>` : ""}
        <p class="hint">${escapeHtml(tr("table.checkSigns"))}</p>
        ${lines.slice(0, 5).map((l) => `<div class="stmt-line"><span class="stmt-line-date">${escapeHtml(fmtDate(l.date, true))}</span><span class="stmt-line-desc">${escapeHtml(l.description)}</span><span class="stmt-line-amt ${l.amount >= 0 ? "in" : "out"}">${escapeHtml(fmtMoney(l.currency, l.amount))}</span></div>`).join("")}
        ${balanceCheckHtml(lines)}`;
      lastPreviewLines = lines;
    }
    // "Each line keeps the currency written on its amount: 312 in PEN · 4 in USD. Lines with no mark: PEN."
    function lineCurrencyText(lines, m) {
      const n = {};
      lines.forEach((l) => { n[l.currency] = (n[l.currency] || 0) + 1; });
      const list = Object.keys(n).sort((a, b) => n[b] - n[a]).map((c) => tr("table.lineCurrencyCount", { n: n[c], cur: c })).join(" · ");
      return tr("table.lineCurrency", { list, cur: m.currencyFixed || homeCur() });
    }
    // ---- quick troubleshooting of a spreadsheet (owner, 2026-11-17, after the journeys run): a spreadsheet has no totals the app can
    // check, so the preview names every line it left out and why, warns about what usually means a wrong reading, and can check the
    // lines against the balances the person knows. Nothing here changes what is saved.
    let lastPreviewLines = [];
    function rowText(row) {
      const cell = (c) => (c && typeof c === "object" && c.date ? String(c.date) : String(c === undefined || c === null ? "" : c)).replace(/\s+/g, " ").trim();
      return (rows[row - 1] || []).map(cell).filter(Boolean).join(" · ").slice(0, 80);
    }
    root.addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("tm-balcheck")) state.balOpen = e.target.open; }, true);
    function skippedFold(sk) {
      if (!sk.length) return "";
      const items = sk.slice(0, 20).map((x) => `<li>${escapeHtml(tr("table.skipRow", { row: x.row, why: tr("table.skipWhy." + x.reason), text: rowText(x.row) || "—" }))}</li>`).join("");
      const more = sk.length > 20 ? `<p class="hint">${escapeHtml(tr("table.skipMore", { n: sk.length - 20 }))}</p>` : "";
      return `<details class="tm-skipped"><summary class="hint">${escapeHtml(tr("table.skipped", { n: sk.length }))}</summary><ul class="hint">${items}</ul>${more}</details>`;
    }
    function fileWarnings(lines) {
      if (!lines.length) return "";
      const warn = [];
      if (lines.length >= 5 && lines.every((l) => l.amount > 0)) warn.push(tr("table.warnAllIn"));
      if (lines.length >= 5 && lines.every((l) => l.amount < 0) && screenMode === "import") warn.push(tr("table.warnAllOut"));
      const seen = {}; let twice = 0;
      lines.forEach((l) => { const k = l.date + "|" + l.description + "|" + l.amount + "|" + l.currency; if (seen[k]) twice++; seen[k] = true; });
      if (twice) warn.push(tr("table.warnTwice", { n: twice }));
      // (spending only: one big salary among small purchases is normal)
      const spent = lines.filter((l) => l.amount < 0), abs = spent.map((l) => -l.amount).sort((a, b) => a - b), median = abs[Math.floor(abs.length / 2)];
      const big = spent.length >= 10 ? spent.filter((l) => -l.amount > median * 20 && -l.amount >= 1000).sort((a, b) => a.amount - b.amount) : [];
      if (big.length) warn.push(tr("table.warnBig", { n: big.length, amount: fmtMoney(big[0].currency, Math.abs(big[0].amount)), date: fmtDate(big[0].date, true), name: big[0].description }));
      const today = todayLocalISO(), later = lines.filter((l) => l.date > today).length;
      if (later) warn.push(tr("table.warnFuture", { n: later }));
      return warn.map((w) => `<p class="stmt-note warn">${escapeHtml(w)}</p>`).join("");
    }
    // The person's own balances at the start and the end: start + money in − money out should give the end. One currency, one account.
    function balanceCheckHtml(lines) {
      const curs = [...new Set(lines.map((l) => l.currency))];
      if (!lines.length || curs.length !== 1 || multi()) return "";
      return `<details class="tm-balcheck"${state.balOpen ? " open" : ""}><summary class="hint">${escapeHtml(tr("table.balCheck"))}</summary>
        <p class="hint">${escapeHtml(tr("table.balCheckHint"))}</p>
        <label class="hint">${escapeHtml(tr("table.balStart"))} <input type="text" inputmode="decimal" class="tm-bal" data-bal="start" value="${escapeHtml(state.balStart || "")}"></label>
        <label class="hint">${escapeHtml(tr("table.balEnd"))} <input type="text" inputmode="decimal" class="tm-bal" data-bal="end" value="${escapeHtml(state.balEnd || "")}"></label>
        <p class="tm-bal-result">${balanceResultHtml(lines)}</p></details>`;
    }
    function balanceResultHtml(lines) {
      const a = parseFloat(String(state.balStart || "").replace(/,/g, "")), b = parseFloat(String(state.balEnd || "").replace(/,/g, ""));
      if (isNaN(a) || isNaN(b) || !lines.length) return "";
      const cur = lines[0].currency, net = lines.reduce((t, l) => t + l.amount, 0), off = Math.round((a + net - b) * 100) / 100;
      if (Math.abs(off) < 0.005) return `<span class="stmt-note good">${escapeHtml(tr("table.balOk"))}</span>`;
      return `<span class="stmt-note warn">${escapeHtml(tr(off > 0 ? "table.balOffMore" : "table.balOffLess", { amount: fmtMoney(cur, Math.abs(off)) }))}</span>`;
    }
    function applyAccountGuess() {
      // A card's purchases are usually positive: re-guess the sign for the chosen account, but only for a layout nobody has confirmed.
      const a = pm();
      if (a && !remembered) state.m.sign = StatementTable.guessMapping(rows, { isCard: a.type === "credit" }).sign;
    }
    root.addEventListener("change", (e) => {
      const cls = (e.target.className.match(/tm-(\w+)/) || [])[1];
      if (!cls || cls === "bal") return;   // the balance boxes only update their own result line (the "input" handler below)
      const v = e.target.value;
      if (cls === "account") { state.accountId = v; applyAccountGuess(); syncControlsFromState(); refreshNewMoves(); if (isNew(v)) { const box = root.querySelector(".tm-single-new .tm-nname"); if (box && !box.value) box.focus(); } }
      else if (cls === "vacct") {
        const row = e.target.closest(".tm-value"), val = row.dataset.value;
        if (v) state.map[val] = v; else if (noneOk) state.map[val] = "none"; else delete state.map[val];   // "none": the person's own "No account", kept on a redraw
        const old = row.querySelector(".tm-newacct");
        if (old) old.remove();
        if (isNew(v) && !hiddenMatch(val)) row.insertAdjacentHTML("beforeend", newBoxHtml(val));
        renderNewCard();
        refreshNewMoves();
      }
      else if (cls === "ntype") { newSpec(e.target.closest(".tm-newacct").dataset.value).type = v; return; }
      else if (cls === "nbank") { newSpec(e.target.closest(".tm-newacct").dataset.value).bankName = v; renderPreview(); return; }
      else if (cls === "nlast4") { newSpec(e.target.closest(".tm-newacct").dataset.value).last4 = v.trim(); renderPreview(); return; }
      else if (cls === "nname") { newSpec(e.target.closest(".tm-newacct").dataset.value).name = v; refreshNewMoves(); renderPreview(); return; }
      else if (cls === "date") state.m.date = Number(v);
      else if (cls === "desc") state.m.description = Number(v);
      else if (cls === "amount") state.m.amount = Number(v);
      else if (cls === "sign") state.m.sign = v;
      else if (cls === "out") state.m.out = Number(v);
      else if (cls === "in") state.m.in = Number(v);
      else if (cls === "currency") state.m.currency = Number(v);
      else if (cls === "acol") { state.m.account = Number(v); renderValues(); syncControlsFromState(); }
      else if (cls === "type") state.m.type = Number(v);
      else if (cls === "note") state.m.note = Number(v);
      else if (cls === "dollar") state.m.dollarCurrency = v;
      else if (cls === "lfriend") {
        const row = e.target.closest(".tm-cat-row"), d = state.catDest[row.dataset.key] || (state.catDest[row.dataset.key] = {});
        d.lineFriends = { ...(d.lineFriends || {}), [e.target.dataset.line]: v };
        const y = window.scrollY;
        renderCategories();
        window.scrollTo(0, y);
        renderPreview();
        return;
      }
      else if (cls === "dfriend" || cls === "dkind" || cls === "dpm" || cls === "dplat" || cls === "dhere") {
        const row = e.target.closest(".tm-cat-row"), key = row.dataset.key;
        const d = state.catDest[key] || (state.catDest[key] = {});
        if (cls === "dfriend") d.friendId = v; else if (cls === "dkind") { d.loanKind = v; d.kindAuto = false; } else if (cls === "dpm") d.pmId = v; else if (cls === "dhere") d.herePmId = v; else d.platformId = v;
        refreshCategoryRow(row);
        renderPreview();
        return;
      }
      else if (cls === "cchoice") {
        const row = e.target.closest(".tm-cat-row"), it = state.catItems.find((x) => x.key === row.dataset.key);
        state.catCustom[it.key] = false;
        if (isDest(v)) {
          const kind = v.slice(1), was = state.catDest[it.key];
          state.catChoice[it.key] = v; state.catNames[it.key] = "";
          if (!was || was.kind !== kind) {
            const fd = familyDest(it);
            state.catDest[it.key] = fd && fd.kind === kind ? fd : { kind, loanKind: "loan" };
          }
          renderCategories();
          renderPreview();
          return;
        }
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
      if (e.target.classList.contains("tm-bal")) {
        state[e.target.dataset.bal === "start" ? "balStart" : "balEnd"] = e.target.value;
        const res = root.querySelector(".tm-bal-result");
        if (res) res.innerHTML = balanceResultHtml(lastPreviewLines);
        return;
      }
      if (e.target.classList.contains("tm-nname")) { newSpec(e.target.closest(".tm-newacct").dataset.value).name = e.target.value; renderPreview(); return; }
      if (e.target.classList.contains("tm-nlast4")) { newSpec(e.target.closest(".tm-newacct").dataset.value).last4 = e.target.value.trim(); renderPreview(); return; }
      if (!e.target.classList.contains("tm-cname")) return;
      const row = e.target.closest(".tm-cat-row");
      state.catNames[row.dataset.key] = e.target.value;
      refreshCategoryRow(row);
    });
    root.addEventListener("click", (e) => { if (e.target.closest(".tm-fmt-change")) { state.fmtOpen = true; syncControlsFromState(); } });
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
      // A chosen rename changes the name of entries already recorded: said once more, in a pop-up, before going on (owner, 2026-11-04).
      const renames = nameConflicts().filter((c) => c.renamed);
      if (renames.length && !practiceNoConfirm_(true) && !await askConfirmApp_(tr("table.conflictConfirm", { list: renames.map((c) => tr("table.conflictLine", { mine: c.info.name, to: String(state.catNames[c.it.key] || "").trim(), n: c.info.entries })).join("\n") }), tr("confirmBtn.renameThem"), { plain: true })) return;
      // Lines go to their account: the one picked, or — for a file with an account column — the account each name was matched to.
      const byAccount = new Map();
      lines.forEach((l) => {
        let id = multi() ? state.map[l.account] : state.accountId;
        if (id === "skip") return;
        if (isNew(id) && newOk) { /* an account the save will create */ }
        else if (!id || !pmById(id)) { if (!noneOk) return; id = ""; }   // an import keeps the lines with no account
        if (!byAccount.has(id)) byAccount.set(id, []);
        byAccount.get(id).push(l);
      });
      if (!byAccount.size) { if (!multi() && !noneOk) root.querySelector(".tm-account").focus(); return; }
      const results = [];
      let newIdx = 0;
      // A file's Yape / Plin lines saved on one of the person's accounts: the save links Yape / Plin to it (backend: stmtLinkRail_).
      const railOfAccountLines = (accLines) => (multi() ? railOf(accLines[0] && accLines[0].account) : "") || undefined;
      byAccount.forEach((accLines, id) => {
        const a = pmById(id);   // null: the lines have no account, or go to a new one
        const dates = accLines.map((l) => l.date).sort();
        const newAccount = isNew(id) ? newAccountPayload(id.slice(4), accLines) : null;
        const accountKey = a ? tableAccountKey(a) : newAccount ? `NEW-${body.dataset.slot || "x"}-${newIdx++}` : NO_ACCOUNT_KEY;
        results.push({ name: byAccount.size > 1 ? `${file.name} · ${a ? a.nickname : newAccount ? newAccount.name : tr("imp.noAccountOption")}` : file.name,
          result: { kind: "csv", ok: true, verified: false, accountKey, newAccount: newAccount || undefined, rail: !newAccount && a ? railOfAccountLines(accLines) : undefined, account: { last4: /^\d{4}$/.test(accountKey) ? accountKey : "" }, holder: "",
            period: { start: dates[0], end: dates[dates.length - 1] }, balances: {}, lines: accLines, warnings: [], source: state.m.source === "app" ? "app" : "", categoryMap: plainChoices(state.catChoice), categoryNames: namesToSend(), catDest: destsToSend() } });
      });
      // A "move" to an account this import creates goes to that statement's stand-in (backend: new:<key>, swapped for the real one on save).
      const keyOfNew = {};
      byAccount.forEach((accLines, id) => { if (isNew(id)) { const r = results.find((x) => x.result.newAccount && x.result.lines === accLines); if (r) keyOfNew[id] = "new:" + r.result.accountKey; } });
      results.forEach((r) => Object.values(r.result.catDest || {}).forEach((d) => { if (d && d.kind === "move") { if (keyOfNew[d.pmId]) d.pmId = keyOfNew[d.pmId]; if (keyOfNew[d.herePmId]) d.herePmId = keyOfNew[d.herePmId]; } }));
      // Remember the layout in the Sheet, under the name the person gave it (else the known name, else the account's name).
      const typed = $q("name").value.trim();
      const oneId = byAccount.size === 1 ? [...byAccount.keys()][0] : "";
      const label = typed || state.label || (pmById(oneId) ? pmById(oneId).nickname : isNew(oneId) && results[0].result.newAccount ? results[0].result.newAccount.name : "") || "";
      const accountsToSave = multi() ? { ...state.map } : { "*": state.accountId };
      callApi("saveStatementFormat", { signature: sig, label, accounts: accountsToSave, categories: { ...state.catSaved, ...plainChoices(state.catChoice), ...renameFlags(), ...destFlags() },
        mapping: { date: m.date, description: m.description, amount: m.amount, out: m.out, in: m.in, currency: m.currency, account: m.account, category: m.category, type: m.type,
          note: m.note, dateOrder: m.dateOrder, decimal: m.decimal, sign: m.sign, currencyFixed: m.currencyFixed, dollarCurrency: m.dollarCurrency || "", source: m.source || "" } }).catch(() => {});
      if (StatementTable.PRACTICE_FILE_NAMES.includes(file.name)) practiceINote_("used");   // the practice file's layout was just remembered: its cleanup forgets it
      // A re-read of the same card replaces its earlier reading.
      const slot = body.dataset.slot;
      usable = usable.filter((u) => slotOf(u) !== slot);
      // Lines that will come in with no category (the file names none, or the person left its category without one): the next screen only
      // says "added without a category" when there are some (Mark, re-check 2026-11-18).
      const catLeftOf = (r) => r.result.lines.filter((l) => !l.category || state.catChoice[(l.amount > 0 ? "income" : "expense") + ":" + StatementTable.catNorm(l.category)] === "").length;
      results.forEach((r) => usable.push({ file: r.name, group: file.name, slot, result: r.result, inboxId: "", catLeft: catLeftOf(r) }));
      historyPlan = null;
      $("statement-history").innerHTML = "";
      updateReviewButton();
      if (results.length === 1) renderResult(body, results[0].result, null, file, "");
      else renderTableResults(body, results.map((r) => r.result));
    });
    renderValues();
    loadCategories();
    syncControlsFromState();
    setVal("out", state.m.out); setVal("in", state.m.in); setVal("amount", state.m.amount); setVal("desc", state.m.description); setVal("date", state.m.date); setVal("currency", state.m.currency);
    setVal("acol", state.m.account); setVal("cat", state.m.category); setVal("type", state.m.type); setVal("note", state.m.note);
    if (state.accountId && !remembered) applyAccountGuess();
    syncControlsFromState();
    renderPreview();
  }

  async function handleStatementFiles(files) {
    // Copied BEFORE any wait: the file box is emptied right after the pick (so the same file can be picked again), and a list read after
    // a wait was empty, so a file picked while the screen still said "Loading…" was silently dropped (Andrés, 2026-11-09).
    const picked = Array.from(files);
    filesQueued += picked.length;
    updateStepUi();
    await screenLoaded;   // ...and it is read once the screen has loaded
    if (!coverage) { try { coverage = await callApi("listStatementCoverage", {}); } catch (e) { /* notes just won't show */ } }
    for (const f of picked) {   // one at a time: easy on a phone's memory
      filesQueued--; filesReading++;
      try {
        if (screenMode === "import" && !isTableFile(f)) {
          const body = resultCardShell(f.name);
          body.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(tr("imp.blockedPdf"))}</p>
            <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice imp-go">${escapeHtml(tr("imp.openStatements"))}</button></div>`;
          body.querySelector(".imp-go").addEventListener("click", () => { showStatementsScreen("bank"); window.scrollTo(0, 0); });
          continue;
        }
        await (isTableFile(f) ? readTableFile(f) : readStatementFile(f));
      } finally { filesReading--; updateStepUi(); }
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
      newAccount: result.newAccount || undefined,   // an account the save will create (backend/StatementAccounts.gs)
      rail: result.rail || undefined,
      kind: result.kind,
      source: result.source || "",   // "app" = an app's export: no bank-wording rules on the server
      bank: result.bank || "", accountLast4: (result.account && result.account.last4) || "",   // an account the app does not have yet is proposed from these (never a full number)
      holder: result.holder || "",   // the name printed on the statement: how the app learns the person's own name (backend/OwnerNames.gs)
      period: result.period,
      balances: result.balances,
      due: result.due || "",   // a card's pay-by date read from the file: when missing, the preview asks for it (due_asks)
      verified: !!(result.ok && result.verified !== false),
      lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section, category: l.category, transfer: l.transfer }))
    }));
  }

  // A card's pay-by date the file did not show (owner's plan, 2026-11-18): one optional box per card statement, filled with the card's
  // usual gap after closing when an earlier statement had a date. What the person types is kept across redraws (`dueTyped`).
  function dueAskHtml_() {
    const asks = (historyPlan && historyPlan.due_asks) || [];
    if (!asks.length) return "";
    return asks.map((a) => {
      const u = usable[a.stmt];
      if (!u || !u.result.period || !u.result.period.end) return "";
      const val = dueTyped[a.stmt] !== undefined ? dueTyped[a.stmt] : a.guess || "";
      const min = (() => { const d = new Date(u.result.period.end + "T12:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
      return `<div class="stmt-due-ask"><label for="stmt-due-${a.stmt}">${escapeHtml(tr("stmt.dueAsk", { account: a.account }))}</label>
        <input type="date" id="stmt-due-${a.stmt}" data-due-stmt="${a.stmt}" min="${min}" value="${escapeHtml(val)}">
        <p class="hint">${escapeHtml(tr(a.guess && dueTyped[a.stmt] === undefined ? "stmt.dueGuessed" : "stmt.dueNotFound"))}</p></div>`;
    }).join("");
  }
  // The typed pay-by dates go onto their statements just before saving; one on or before the close is refused here, in the open screen.
  function applyDueTyped_() {
    document.querySelectorAll("[data-due-stmt]").forEach((inp) => { dueTyped[inp.dataset.dueStmt] = inp.value; });
    for (const a of (historyPlan && historyPlan.due_asks) || []) {
      const u = usable[a.stmt], v = dueTyped[a.stmt] !== undefined ? dueTyped[a.stmt] : a.guess || "";
      if (!u) continue;
      if (!v) { delete u.result.due; continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v <= String(u.result.period.end)) return tr("stmt.dueTooEarly", { account: a.account });
      u.result.due = v;
    }
    return "";
  }

  // ---- "Fill my history": one approval for everything, no per-line choices (backend/StatementHistory.gs) ----

  let historyPlan = null;   // { actions, summary } from planStatementHistory, for the statements read right now
  let dueTyped = {};        // pay-by dates typed in the preview, by statement number; emptied with each new plan

  async function runHistoryPlan() {
    const btn = $("statement-history-btn");
    const out = $("statement-history");
    btn.disabled = true;
    $("statement-review-status").innerHTML = "";   // an old "Saved" / "Undone" message is not about this run
    $("statement-plan-status").innerHTML = "";
    const forPlan = statementsForAnalysis();
    // A big file says how many lines it is working out, so a long wait reads as work (Andrés, testers 2026-11-21: 1,000 lines).
    const nLines = forPlan.reduce((n, st) => n + ((st && st.lines) || []).length, 0);
    out.innerHTML = loadingHtml(nLines >= 200 ? tr("hist.planningN", { n: nLines }) : tr("hist.planning")) + `<p class="hint">${escapeHtml(tr("hist.keepOpen"))}</p>`;
    try {
      historyPlan = await callApi("planStatementHistory", { statements: forPlan, startBank: true });
      // Lines whose file category the person already sent to a place in the app (Loans, another account…) are not offered again as income.
      // Another app's export: every line already went through its category ("Goes into"), so these two lists would ask it again (owner, 2026-11-21).
      const fromApp = (x) => !!(usable[x.stmt] && usable[x.stmt].result && usable[x.stmt].result.source === "app");
      ["incomeLines", "peopleOut"].forEach((k) => { if (historyPlan.summary[k]) historyPlan.summary[k] = historyPlan.summary[k].filter((x) => !lineDest(x.stmt, x.line) && !fromApp(x)); });
      dueTyped = {};
      historyPlan.platform = new Map();    // index into summary.aside -> investment platform the person picked (else the guess is used)
      historyPlan.incMode = new Map();     // index into summary.incomeLines -> "transfer" | "investment" | "review" | "leave" (absent = income, the default)
      historyPlan.outMode = new Map();     // index into summary.peopleOut -> "review" or "leave" (absent = spending, the default)
      historyPlan.openPeople = new Set();  // people whose lines are showing
      historyPlan.openSec = new Set();        // groups the person opened (order B: all start collapsed)
      historyPlan.noAcctOff = new Set();      // lineKey of a no-account pair the person said is a different entry (added as new instead)
      historyPlan.rechargeChoice = new Map(); // index into summary.recharges -> the entry id that takes the card's charge, or "add"; absent = the plan's own
      historyPlan.discountChoice = new Map(); // index into summary.discounts -> the entry id that takes the bank's amount, or "add"; absent = the plan's own
      historyPlan.chargeChoice = new Map(); // index into summary.charges -> the entry id it fills, or "add" (a new purchase); absent = the plan's own
      historyPlan.chosen = new Map();      // index into summary.aside -> "cash" (spending/income) or "transfer", what the person counted after all
      historyPlan.exchanges = [];          // lines linked as a currency exchange: { out: {stmt, line}, in: {stmt, line} }
      historyPlan.openGroups = new Set();  // groups of similar lines whose individual lines are showing
      historyPlan.asideOpen = false;
      // A line that looks like an entry already in the app goes to Needs review by default (the person decides there whether it is
      // a duplicate); tapping the button again leaves it out instead.
      (historyPlan.summary.aside || []).forEach((a, i) => { if (a.reason === "possible" && a.optInReview) historyPlan.chosen.set(i, "review"); });
      historyPlan.bal = new Set();         // balance checks (index into historyPlan.checks) the person wants set from the statement
      historyPlan.startFix = new Set();    // balance checks whose starting-balance correction the person accepted (owner's plan, step 3)
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

  // A balance check recounted with the person's choices (owner, 2026-11-11): the server counts every statement line not in the app as
  // explained ("from N lines not in the app"), on the idea that it gets added. A line the person leaves out (or that only waits) is not
  // added, so its amount moves to "unexplained" — on screen at once, and in the difference note a set balance saves.
  function liveCheck(c0, covered, noFix) {
    const c = noFix ? livePicks_(c0) : liveStartFix_(livePicks_(c0), c0);
    const items = (c.direction === "forward" && c.notInApp && c.notInApp.items) || [];
    const out = items.filter((it) => !covered[lineKey({ stmt: c.stmt, line: it.line })]);
    if (!out.length) return c;
    const sum = out.reduce((t, it) => t + it.amount, 0);
    return { ...c, notInApp: { ...c.notInApp, net: Math.round((c.notInApp.net - sum) * 100) / 100, lines: c.notInApp.lines - out.length },
      leftOut: { net: Math.round(sum * 100) / 100, lines: out.length }, unexplained: Math.round((c.unexplained + sum) * 100) / 100 };
  }
  // The starting-balance correction the person accepted (owner, 2026-11-11): its entries count after the balance, so the app moves by
  // their effect and that much is no longer unexplained.
  function startFixSum_(c) { return r2_((c.startFix ? c.startFix.items : []).reduce((t, it) => t + (it.weight !== undefined ? it.weight : it.amount), 0)); }
  // The note's wording by direction: all "taken as inside", all "counted after", or both.
  function startFixKind_(c) {
    const sides = new Set(c.startFix.items.map((it) => it.side || "in"));
    return sides.size > 1 ? "Mixed" : sides.has("out") ? "Out" : sides.has("bank") ? "Bank" : "";
  }
  // An item's name: a purchase "already charged" shows both amounts (what the app has → what the bank charged).
  function startFixName_(c, it) {
    const name = it.description || tr("type." + it.type);
    return it.side === "bank" ? `${name} ${fmtMoney(c.currency, it.recorded)} → ${fmtMoney(c.currency, it.charged)}` : `${name} ${signed(c.currency, it.amount)}`;
  }
  // The correction, searched again on the phone with the person's picks (owner, 2026-11-11): the server sends the candidates
  // (`startCands`: entries near the starting balance, and purchases inside it that the card charged differently, as "already charged");
  // a suggestion the person picks on a purchase inside the balance adds its own. The same rule as the server's stmtStartFix_: the fewest
  // candidates that add up, to the cent, to what is left unexplained, offered only when exactly one such set exists. A correction already
  // accepted that changes with the picks is no longer accepted (the person sees the new one before it applies).
  function refreshStartFixes_() {
    if (!historyPlan || !historyPlan.checks) return;
    const covered = coveredLines(historyActions(false)), s = historyPlan.summary || {};
    historyPlan.checks.forEach((c0, i) => {
      if (!Array.isArray(c0.startCands) || c0.direction !== "forward" || !c0.anchor) return;
      const cands = c0.startCands.slice();
      (s.discounts || []).forEach((d, k) => {
        if (d.clear || d.stmt !== c0.stmt || d.currency !== c0.currency) return;
        const pick = discountOf(k);
        const o = pick && pick !== "add" ? (d.options || []).find((x) => x.id === pick) : null;
        if (!o || !o.insideStart || cands.some((x) => x.id === o.id)) return;
        const shift = r2_(d.amount + Number(o.amount));
        if (!shift) return;
        cands.push({ id: o.id, date: String(o.date || d.date).slice(0, 10), description: o.description || "", type: "expense", side: "bank",
          recorded: Number(o.amount), charged: r2_(-d.amount), amount: d.amount, weight: -shift, cents: Math.round(-shift * 100) });
      });
      cands.sort((a, b) => (a.date < b.date ? 1 : -1));
      const list = cands.slice(0, 14), n = list.length;   // 14: STMT_START_FIX_MAX_ in StatementBalance.gs
      const target = Math.round(liveCheck(c0, covered, true).unexplained * 100);
      let fix = null;
      if (target) {
        for (let size = 1; size <= n && !fix; size++) {
          const found = [];
          const walk = (start, picked, sum) => {
            if (found.length > 1) return;
            if (picked.length === size) { if (sum === target) found.push(picked.slice()); return; }
            for (let j = start; j < n; j++) { picked.push(j); walk(j + 1, picked, sum + list[j].cents); picked.pop(); }
          };
          walk(0, [], 0);
          if (found.length > 1) break;
          if (found.length === 1) {
            fix = { date: c0.anchor.date, amount: c0.anchor.amount, items: found[0].map((j) => {
              const x = list[j], it = { id: x.id, date: x.date, description: x.description, type: x.type, side: x.side, amount: x.amount, weight: x.weight };
              if (x.side === "bank") { it.recorded = x.recorded; it.charged = x.charged; }
              return it;
            }) };
          }
        }
      }
      const sig = (f) => (f ? f.items.map((it) => it.side + ":" + it.id).sort().join(",") : "");
      if (sig(fix) !== sig(c0.startFix)) historyPlan.startFix.delete(i);
      if (fix) c0.startFix = fix; else delete c0.startFix;
    });
  }
  // The starting number after this save: the correction's entries, plus any "charged differently" difference on purchases inside it that the
  // same save takes (both move the number; c is a live check).
  // (an accepted "already charged" item was taken out of c.startShift by liveStartFix_: _bankSum puts it back so it is not counted twice)
  function startFixCorrected_(c) { return r2_(c.startFix.amount + startFixSum_(c) + ((c.startShift && c.startShift.net) || 0) - (c._bankSum || 0)); }
  function startFixOn_(c) { return !!(c.startFix && historyPlan && historyPlan.startFix && historyPlan.startFix.has(historyPlan.checks.indexOf(c))); }
  function liveStartFix_(c, c0) {   // c0: the check as the server sent it (the one in historyPlan.checks)
    if (!startFixOn_(c0)) return c;
    // "Already charged" purchases no longer move the starting balance: they leave the "inside your starting balance" difference instead
    // of showing as a correction of their own (owner, 2026-11-11).
    const items = c0.startFix.items, bank = items.filter((it) => it.side === "bank"), rest = items.filter((it) => it.side !== "bank");
    const sumOf = (l) => r2_(l.reduce((t, it) => t + (it.weight !== undefined ? it.weight : it.amount), 0));
    const bankSum = sumOf(bank), restSum = sumOf(rest);
    const out = { ...c, unexplained: r2_(c.unexplained - bankSum - restSum), _src: c0, _bankSum: bankSum };
    if (rest.length) out.startFixed = { net: restSum, lines: rest.length };
    if (bank.length && c.startShift) {
      const lines = c.startShift.lines - bank.length;
      out.startShift = lines > 0 ? { net: r2_(c.startShift.net + bankSum), lines } : undefined;
    }
    return out;
  }
  // Pairs the person PICKED on screen (a suggestion, or a pair that was not ticked by itself), owner 2026-11-11: the server counted their
  // line as "not in the app" (it could not know the choice). On a pick it is recounted as what it really is — the purchase is already in
  // the app, so the line is "charged less / more than recorded" (only the difference counts) or "charged in another currency".
  const r2_ = (n) => Math.round(n * 100) / 100;
  function livePicks_(c) {
    if (c.direction !== "forward" || !historyPlan || !historyPlan.summary) return c;
    const s = historyPlan.summary, round = r2_;
    let notIn = c.notInApp ? { ...c.notInApp, items: (c.notInApp.items || []).slice() } : null;
    let disc = { ...(c.discounted || { net: 0, lines: 0 }) }, other = { ...(c.otherCurrency || { net: 0, lines: 0 }) }, unexplained = c.unexplained, changed = false;
    let shift = { ...(c.startShift || { net: 0, lines: 0 }) };
    const takeLine = (d) => {   // this check's "not in the app" line for d, removed from that count; null when it is not there
      if (!notIn || d.stmt !== c.stmt || d.currency !== c.currency) return null;
      const at = notIn.items.findIndex((it) => it.line === d.line);
      if (at < 0) return null;
      const it = notIn.items.splice(at, 1)[0];
      notIn = { ...notIn, net: round(notIn.net - it.amount), lines: notIn.lines - 1 };
      return it;
    };
    (s.discounts || []).forEach((d, k) => {
      const pick = d.clear ? "" : discountOf(k);
      if (!pick || pick === "add") return;
      const o = (d.options || []).find((x) => x.id === pick);
      if (!o) return;
      if (!takeLine(d)) {
        // A purchase inside the starting balance (owner, 2026-11-11): its line was never counted, and taking the bank's amount also moves
        // that balance by the difference (StatementApply.gs), so only the difference is explained.
        if (o.insideStart && d.stmt === c.stmt && d.currency === c.currency) {
          const diff = round(d.amount + Number(o.amount));
          shift = { net: round(shift.net + diff), lines: shift.lines + 1 };
          unexplained = round(unexplained - diff);
          changed = true;
        }
        return;
      }
      // the line minus the purchase already counted: only the discount (or the tip) is new
      disc = { net: round(disc.net + d.amount + Number(o.amount)), lines: disc.lines + 1 };
      unexplained = round(unexplained - Number(o.amount));
      changed = true;
    });
    (s.recharges || []).forEach((d, k) => {
      const pick = d.clear ? "" : rechargeOf(k);
      if (!pick || pick === "add") return;
      const o = (d.options || []).find((x) => x.id === pick);
      if (!o) return;
      if (takeLine(d)) { other = { net: round(other.net + d.amount), lines: other.lines + 1 }; changed = true; }   // the charge, in the line's currency
      else if (o.currency === c.currency && usable[c.stmt] && usable[d.stmt] && c.stmt === d.stmt) {
        // the purchase's own currency on the same card: it leaves this currency once it takes the charge
        other = { net: round(other.net + Number(o.amount)), lines: other.lines + 1 };
        unexplained = round(unexplained - Number(o.amount));
        changed = true;
      }
    });
    // A purchase the person paired with a line is no longer "in the app but not on this statement" (nor "probably on the next
    // statement"): the server could only leave out the pairs it ticked itself (owner, 2026-11-14: Amazon, fixed to USD, stayed listed and
    // "Still unexplained after it" took it off a second time).
    const paired = new Set();
    const pick_ = (list, of) => (list || []).forEach((d, k) => { const id = d.clear ? "" : of(k); if (id && id !== "add") paired.add(String(id)); });
    pick_(s.discounts, discountOf); pick_(s.recharges, rechargeOf); pick_(s.charges, chargeOf);
    let appOnly = c.appOnly, late = c.late;
    if (paired.size && appOnly && appOnly.items && appOnly.items.some((it) => paired.has(String(it.id)))) {
      const gone = appOnly.items.filter((it) => paired.has(String(it.id)));
      appOnly = { ...appOnly, items: appOnly.items.filter((it) => !paired.has(String(it.id))), n: appOnly.n - gone.length,
        net: round(appOnly.net - gone.reduce((t, it) => t + it.amount, 0)) };
      changed = true;
    }
    if (paired.size && late && late.items && late.items.some((it) => paired.has(String(it.id)))) {
      // the server had taken these off "unexplained" as next-statement purchases; the pick above explains them instead
      const gone = late.items.filter((it) => paired.has(String(it.id))), back = round(-gone.reduce((t, it) => t + it.amount, 0));
      late = { ...late, items: late.items.filter((it) => !paired.has(String(it.id))), lines: late.lines - gone.length, net: round(late.net - back) };
      unexplained = round(unexplained + back);
      changed = true;
    }
    return changed ? { ...c, notInApp: notIn, discounted: disc, otherCurrency: other, startShift: shift, unexplained, appOnly, late } : c;
  }
  // Lines an action adds to the app (an entry, a transfer, an exchange, a Needs review item); "ignore" and "wait" add nothing.
  function coveredLines(actions) {
    const covered = {};
    actions.forEach((a) => {
      if (a.type === "ignore" || a.type === "wait" || a.type === "set_balance") return;
      [a, a.out, a.in].forEach((ref) => { if (ref && ref.stmt !== undefined && ref.line !== undefined) covered[lineKey(ref)] = true; });
    });
    return covered;
  }

  function balanceAction(c) {
    if (!(c.direction === "forward" && typeof c.unexplained === "number")) return { type: "set_balance", stmt: c.stmt, currency: c.currency };
    const a = { type: "set_balance", stmt: c.stmt, currency: c.currency, gap: c.unexplained, app_balance: c.appAtEnd };
    // A correction was offered and not taken (Andrés, 2026-11-11): the note names those entries instead of "money the app doesn't know about".
    if (c.startFix && !c.startFixed && Math.abs(c.unexplained - startFixSum_(c)) < 0.005) {
      a.likely = c.startFix.items.map((it) => `${fmtDate(it.date, true)} · ${startFixName_(c, it)}`).join("; ");
    }
    return a;
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

  // Where an imported line goes when the person sent its file category to a place in the app (renderTableMapping's "@" choices):
  // { kind: "loan" | "move" | "invest" | "review", … } or null.
  function lineDest(stmt, line) {
    const u = usable[stmt], d = u && u.result && u.result.catDest;
    if (!d) return null;
    const l = u.result.lines[line];
    if (!l || !l.category) return null;
    return d[(l.amount > 0 ? "income" : "expense") + ":" + StatementTable.catNorm(l.category)] || null;
  }
  // The action that replaces a line's default expense / income for that place.
  function destAction(a) {
    if (a.stmt === undefined || (a.type !== "add_history_expense" && a.type !== "add_history_income")) return a;
    const d = lineDest(a.stmt, a.line);
    if (!d) return a;
    const at = { stmt: a.stmt, line: a.line };
    if (d.kind === "review") return { type: "add_history_pending", ...at };
    if (d.kind === "invest") return { type: "add_history_investment", ...at, platformId: d.platformId || "" };
    if (d.kind === "move" && d.pmId) return { type: "record_move", ...at, otherPmId: d.pmId, herePmId: d.herePmId || undefined };
    if (d.kind === "loan") {
      const l = usable[a.stmt].result.lines[a.line];
      const who = d.lineFriends ? d.lineFriends[[l.date, Number(l.amount).toFixed(2), l.currency, String(l.description || "").trim()].join("|")] : d.friendId;
      return who ? { type: "record_loan_line", ...at, friendId: who, kind: d.loanKind === "repayment" ? "repayment" : "loan" } : { type: "add_history_pending", ...at };
    }
    return a;
  }
  function historyActions(withBalances = true) {
    const p = historyPlan, aside = p.summary.aside || [];
    const linked = linkedKeys();
    const taken = {}, takenOut = {}, takenInc = {};
    p.chosen.forEach((mode, i) => { taken[lineKey(aside[i])] = true; });
    const outs = p.summary.peopleOut || [], incs = p.summary.incomeLines || [];
    p.outMode.forEach((mode, j) => { takenOut[lineKey(outs[j])] = true; });
    p.incMode.forEach((mode, k) => { takenInc[lineKey(incs[k])] = true; });
    // A charge left pending (Charges.gs): what each line does is worked out here from the person's choice (or the plan's, for a clear pair).
    const charges = p.summary.charges || [];
    const chargeKeys = {}, chargeActions = [];
    charges.forEach((c, k) => {
      chargeKeys[lineKey(c)] = true;
      const pick = chargeOf(k);
      if (pick === "add") chargeActions.push({ type: "add_history_expense", stmt: c.stmt, line: c.line });
      else if (pick) chargeActions.push({ type: "fill_charge", stmt: c.stmt, line: c.line, entryId: pick });
    });
    // Lines that are an entry saved with no account: it gets this account (the plan's assign_account), or the line is a new entry.
    (p.summary.noAccount || []).forEach((d) => {
      if (p.noAcctOff && p.noAcctOff.has(lineKey(d))) {
        chargeKeys[lineKey(d)] = true;
        chargeActions.push({ type: d.amount < 0 ? "add_history_expense" : "add_history_income", stmt: d.stmt, line: d.line });
      }
    });
    // A card line in another currency than a purchase in the app: the purchase takes the charge (what was paid is kept), or it is a new purchase.
    (p.summary.recharges || []).forEach((d, k) => {
      chargeKeys[lineKey(d)] = true;
      const pick = rechargeOf(k);
      if (pick === "add") chargeActions.push({ type: "add_history_expense", stmt: d.stmt, line: d.line });
      else if (pick) {
        const o = (d.options || []).find((x) => x.id === pick);
        chargeActions.push({ type: "use_bank_charge", stmt: d.stmt, line: d.line, entryId: pick, ...(o && o.wrong ? { wrong: true } : {}) });
      }
    });
    // A card charge lower than a purchase in the app (a discount): the purchase takes the bank's amount, or the line is a new purchase.
    (p.summary.discounts || []).forEach((d, k) => {
      chargeKeys[lineKey(d)] = true;
      const pick = discountOf(k);
      if (pick === "add") chargeActions.push({ type: "add_history_expense", stmt: d.stmt, line: d.line });
      else if (pick) chargeActions.push({ type: "use_bank_amount", stmt: d.stmt, line: d.line, entryId: pick });
    });
    const kept = p.actions.filter((a) => {
      if (a.stmt === undefined) return true;
      if (chargeKeys[lineKey(a)]) return false;                 // a transfer pair carries out/in instead of stmt/line
      const k = lineKey(a);
      return !linked[k] && !(a.type === "wait" && taken[k]) && !(a.type === "add_history_expense" && takenOut[k]) && !(a.type === "add_history_income" && takenInc[k]);
    }).map(destAction);
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
    const entries = kept.concat(chargeActions, optIns, exchanges);
    if (!withBalances) return entries;
    const covered = coveredLines(entries);
    const balances = settableChecks().filter(({ i }) => p.bal.has(i)).map(({ c }) => balanceAction(liveCheck(c, covered)));   // after the entries, as the apply expects
    const fixes = (p.checks || []).filter((c, i) => c.startFix && p.startFix.has(i))
      .map((c) => ({ type: "start_not_yet", stmt: c.stmt, currency: c.currency, ids: c.startFix.items.filter((it) => it.side !== "bank").map((it) => it.id),
        bank_ids: c.startFix.items.filter((it) => it.side === "bank").map((it) => it.id) }));
    return entries.concat(balances, fixes);
  }
  function chargeOf(k) {
    const c = historyPlan.summary.charges[k];
    return historyPlan.chargeChoice.has(k) ? historyPlan.chargeChoice.get(k) : (c.clear ? c.entryId : "");
  }

  // ---- Order B (owner, 2026-11-11): "Ready, nothing to do" first, then "Needs your choice", then balances. Every group starts
  // collapsed and remembers being opened (historyPlan.openSec); a group of choices shows how many are still to decide.
  const isReady_ = (d) => !!d.clear && !d.suggested;
  // Inside every group, oldest first, like the bank's own statement (owner, 2026-11-11).
  const byDate_ = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.stmt - b.stmt) || (a.line - b.line));
  function secOpen_(id) { return historyPlan.openSec && historyPlan.openSec.has(id) ? "open" : ""; }
  function toDecideBadge_(n) { return n ? ` <span class="stmt-count stmt-todo">${escapeHtml(tr("hist.toDecide", { n }))}</span>` : ""; }

  // ---- "In the app with no account": a bank line that is an entry saved with no account; it gets this statement's account ----
  function noAccountHtml() {
    const p = historyPlan, list = (p.summary.noAccount || []).slice().sort(byDate_);
    if (!list.length) return "";
    const rows = list.map((d) => {
      const k = lineKey(d), off = p.noAcctOff.has(k), o = d.entry;
      const body = `<div>${escapeHtml(tr("hist.noacct.recorded", { entry: `${fmtDate(o.date, true)} · ${o.description || ""} · ${fmtMoney(o.currency, o.amount)}`, account: d.account }))}</div>
        <div class="stmt-choices" style="padding-left:0">${modeButton(`data-noacct="${escapeHtml(k)}" data-pick="use"`, !off, tr("hist.noacct.use", { account: d.account }))}${modeButton(`data-noacct="${escapeHtml(k)}" data-pick="add"`, off, tr("hist.disc.not"))}</div>`;
      return lineRow({ date: d.date, description: d.description, amount: d.amount, currency: d.currency }, `${escapeHtml(d.account)}${body}`);
    }).join("");
    return `<details class="stmt-group" id="statement-history-noaccount" data-sec="statement-history-noaccount" ${secOpen_("statement-history-noaccount")}><summary>${escapeHtml(tr("hist.noacct.title"))} <span class="stmt-count">${list.length}</span></summary>
      <p class="hint">${escapeHtml(tr("hist.noacct.hint"))}</p>${rows}</details>`;
  }

  function rechargeOf(k) {
    const d = historyPlan.summary.recharges[k];
    return historyPlan.rechargeChoice.has(k) ? historyPlan.rechargeChoice.get(k) : (d.clear ? d.entryId : "");
  }

  // ---- "Charged in another currency": a card line in USD for a purchase recorded in PEN (or the other way), 3 days apart at most ----
  function rechargesHtml(part) {
    const p = historyPlan, all = p.summary.recharges || [];
    const items = all.map((d, k) => ({ d, k })).filter(({ d }) => (part === "ready") === isReady_(d)).sort((x, y) => byDate_(x.d, y.d));
    if (!items.length) return "";
    const id = "statement-history-recharges-" + part;
    const todo = items.filter(({ k }) => !rechargeOf(k)).length;
    const rows = items.map(({ d, k }) => {
      const pick = rechargeOf(k);
      const option = (o) => `${fmtDate(o.date, true)} · ${o.description || ""} · ${fmtMoney(o.currency, o.amount)}`;
      const change = (o) => `<div class="hint">${escapeHtml(tr(o.wrong ? "hist.rech.wrong" : "hist.rech.change", { from: fmtMoney(o.currency, o.amount), to: fmtMoney(d.currency, Math.abs(d.amount)), cur: d.currency }))}</div>`;
      let body;
      if (d.options.length === 1) {
        const o = d.options[0];
        body = `<div>${escapeHtml(tr("hist.charge.recorded", { entry: option(o) }))}</div>${change(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-rech="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr(o.wrong ? "hist.rech.fix" : "hist.rech.use"))}${modeButton(`data-rech="${k}" data-pick="add"`, pick === "add", tr("hist.disc.not"))}</div>`;
      } else {
        body = `<div>${escapeHtml(tr("hist.charge.pick"))}</div>` + d.options.map((o) => `<div class="stmt-charge-option"><div>${escapeHtml(option(o))}</div>${change(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-rech="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr("hist.charge.this"))}</div></div>`).join("")
          + `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-rech="${k}" data-pick="add"`, pick === "add", tr("hist.charge.add"))}</div>`;
      }
      const unpicked = !pick ? `<p class="stmt-note info" style="margin:6px 0 0">${escapeHtml(tr("hist.charge.unpicked"))}</p>` : "";
      return lineRow({ date: d.date, description: d.description, amount: d.amount, currency: d.currency }, `${escapeHtml(d.account)}${body}${unpicked}`);
    }).join("");
    return `<details class="stmt-group" id="${id}" data-sec="${id}" ${secOpen_(id)}><summary>${escapeHtml(tr("hist.rech.title"))} <span class="stmt-count">${items.length}</span>${toDecideBadge_(todo)}</summary>
      <p class="hint">${escapeHtml(tr("hist.rech.hint"))}${items.some(({ d }) => (d.options || []).some((o) => o.wrong)) ? " " + escapeHtml(tr("hist.rech.wrongHint")) : ""}</p>${rows}</details>`;
  }

  function discountOf(k) {
    const d = historyPlan.summary.discounts[k];
    return historyPlan.discountChoice.has(k) ? historyPlan.discountChoice.get(k) : (d.clear ? d.entryId : "");
  }

  // ---- "Charged less than recorded": a card line lower than a purchase in the app (a discount), 3 days apart at most ----
  function discountsHtml(part) {
    const p = historyPlan, all = p.summary.discounts || [];
    const items = all.map((d, k) => ({ d, k })).filter(({ d }) => (part === "ready") === isReady_(d)).sort((x, y) => byDate_(x.d, y.d));
    if (!items.length) return "";
    const list = items.map(({ d }) => d);
    const id = "statement-history-discounts-" + part;
    const todo = items.filter(({ k }) => !discountOf(k)).length;
    const rows = items.map(({ d, k }) => {
      const pick = discountOf(k);
      const option = (o) => `${fmtDate(o.date, true)} · ${o.description || ""} · ${fmtMoney(o.currency, o.amount)}`;
      const change = (o) => `<div class="hint">${escapeHtml(tr("hist.disc.change", { from: fmtMoney(o.currency, o.amount), to: fmtMoney(d.currency, Math.abs(d.amount)) }))}</div>`;
      let body;
      if (d.options.length === 1) {
        const o = d.options[0];
        body = `<div>${escapeHtml(tr("hist.charge.recorded", { entry: option(o) }))}</div>${change(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-disc="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr("hist.disc.use"))}${modeButton(`data-disc="${k}" data-pick="add"`, pick === "add", tr("hist.disc.not"))}</div>`;
      } else {
        body = `<div>${escapeHtml(tr("hist.charge.pick"))}</div>` + d.options.map((o) => `<div class="stmt-charge-option"><div>${escapeHtml(option(o))}</div>${change(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-disc="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr("hist.charge.this"))}</div></div>`).join("")
          + `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-disc="${k}" data-pick="add"`, pick === "add", tr("hist.charge.add"))}</div>`;
      }
      const unpicked = !pick ? `<p class="stmt-note info" style="margin:6px 0 0">${escapeHtml(tr("hist.charge.unpicked"))}</p>` : "";
      // Over 15% less (up to 30%), or up to 10% more: only a suggestion, never ticked (owner, 2026-11-11).
      const pct = d.options.length ? Math.round(Math.abs(1 - Math.abs(d.amount) / d.options[0].amount) * 100) : 0;
      const suggested = d.suggested ? `<p class="stmt-note warn" style="margin:6px 0 0">${escapeHtml(tr(d.higher ? "hist.disc.suggestedMore" : "hist.disc.suggested", { pct }))}</p>` : "";
      return lineRow({ date: d.date, description: d.description, amount: d.amount, currency: d.currency }, `${escapeHtml(d.account)}${suggested}${body}${unpicked}`);
    }).join("");
    const anyHigher = list.some((d) => d.higher);
    return `<details class="stmt-group" id="${id}" data-sec="${id}" ${secOpen_(id)}><summary>${escapeHtml(tr(anyHigher ? "hist.disc.titleDiffers" : "hist.disc.title"))} <span class="stmt-count">${list.length}</span>${toDecideBadge_(todo)}</summary>
      <p class="hint">${escapeHtml(tr(anyHigher ? "hist.disc.hintDiffers" : "hist.disc.hint"))}</p>${rows}</details>`;
  }

  // ---- "Completes a charge you left pending": a USD line on the card and a purchase recorded in ARS on it, 5 days apart at most ----
  function chargesHtml(part) {
    const p = historyPlan, all = p.summary.charges || [];
    const items = all.map((c, k) => ({ c, k })).filter(({ c }) => (part === "ready") === isReady_(c)).sort((x, y) => byDate_(x.c, y.c));
    if (!items.length) return "";
    const charges = items.map(({ c }) => c);
    const id = "statement-history-charges-" + part;
    const todo = items.filter(({ k }) => !chargeOf(k)).length;
    const rows = items.map(({ c, k }) => {
      const pick = chargeOf(k);
      const option = (o) => `${fmtDate(o.date, true)} · ${o.description || ""} · ${fmtMoney(o.currency, o.amount)}`;
      const rate = (o) => { const t = chargeRateText_(o.amount, o.currency, Math.abs(c.amount), c.currency); return t ? `<div class="hint stmt-charge-rate">${escapeHtml(t)}</div>` : ""; };
      let body;
      if (c.options.length === 1) {
        const o = c.options[0];
        body = `<div>${escapeHtml(tr("hist.charge.recorded", { entry: option(o) }))}</div>${rate(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-chg="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr("hist.charge.same"))}${modeButton(`data-chg="${k}" data-pick="add"`, pick === "add", tr("hist.charge.not"))}</div>`;
      } else {
        body = `<div>${escapeHtml(tr("hist.charge.pick"))}</div>` + c.options.map((o) => `<div class="stmt-charge-option"><div>${escapeHtml(option(o))}</div>${rate(o)}
          <div class="stmt-choices" style="padding-left:0">${modeButton(`data-chg="${k}" data-pick="${escapeHtml(o.id)}"`, pick === o.id, tr("hist.charge.this"))}</div></div>`).join("")
          + `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-chg="${k}" data-pick="add"`, pick === "add", tr("hist.charge.add"))}</div>`;
      }
      const unpicked = !pick ? `<p class="stmt-note info" style="margin:6px 0 0">${escapeHtml(tr("hist.charge.unpicked"))}</p>` : "";
      return lineRow({ date: c.date, description: c.description, amount: c.amount, currency: c.currency }, `${escapeHtml(c.account)}${body}${unpicked}`);
    }).join("");
    return `<details class="stmt-group" id="${id}" data-sec="${id}" ${secOpen_(id)}><summary>${escapeHtml(tr("hist.charge.title"))} <span class="stmt-count">${charges.length}</span>${toDecideBadge_(todo)}</summary>
      <p class="hint">${escapeHtml(tr("hist.charge.hint"))}</p>${rows}</details>`;
  }

  // What the summary shows, worked out from the final list of actions so it always matches what will be saved.
  function historyCounts() {
    const c = { loans: 0, charges: 0, discounts: 0, recharges: 0, currencyFixed: 0, accountsFilled: 0, expenses: 0, income: 0, refunds: 0, refundIncome: 0, transfers: 0, legs: 0, investments: 0, pendingInvestments: 0, pending: 0, left: 0, exchanges: 0, fees: 0, linked: 0, balances: 0, spent: {} };
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
      else if (a.type === "record_move") c.transfers++;
      else if (a.type === "record_loan_line") c.loans++;
      else if (a.type === "ignore") c.left++;
      else if (a.type === "record_exchange") c.exchanges++;
      else if (a.type === "record_fee") c.fees++;
      else if (a.type === "set_balance") c.balances++;
      else if (a.type === "fill_charge") c.charges++;
      else if (a.type === "use_bank_amount") c.discounts++;
      else if (a.type === "use_bank_charge") { c.recharges++; if (a.wrong) c.currencyFixed++; }
      else if (a.type === "assign_account") c.accountsFilled++;
      else if (["link", "complete_transfer"].includes(a.type)) c.linked++;
    });
    c.entries = c.expenses + c.income + c.refunds + c.refundIncome + c.transfers + c.legs + c.investments + c.pending + 2 * c.exchanges + c.fees + c.loans;
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

  // Card purchases from the last days before the closing: the bank posts them on the next statement.
  function lateHtml(c) {
    const rows = c.late.items.map((it) => `<div class="stmt-kv"><span>${escapeHtml(fmtDate(it.date, true))} · ${escapeHtml(it.description || tr("type." + it.type))}</span><span>${escapeHtml(signed(c.currency, it.amount))}</span></div>`).join("");
    return `<p class="hint"><b>${escapeHtml(tr("stmt.balLateTitle", { n: c.late.lines }))}</b></p>${rows}`;
  }

  // "In the app but not on this statement": each entry with its effect on the account, then what is still left unexplained.
  function appOnlyHtml(c) {
    const a = c.appOnly;
    const rows = a.items.map((it) => `<div class="stmt-kv"><span>${escapeHtml(fmtDate(it.date, true))} · ${escapeHtml(it.description || tr("type." + it.type))}</span><span>${escapeHtml(signed(c.currency, it.amount))}</span></div>`).join("");
    const more = a.n > a.items.length ? `<p class="hint">${escapeHtml(tr("stmt.balAppOnlyMore", { n: a.n - a.items.length }))}</p>` : "";
    const left = Math.round((c.unexplained + a.net) * 100) / 100;
    const end = Math.abs(left) < 0.005 ? tr("stmt.balAppOnlyAll", { n: a.n }) : tr("stmt.balAppOnlyLeft", { n: a.n, amount: signed(c.currency, left) });
    return `<p class="hint"><b>${escapeHtml(tr("stmt.balAppOnlyTitle", { n: a.n }))}</b></p>${rows}${more}<p class="hint">${escapeHtml(end)} ${escapeHtml(tr("stmt.balAppOnlyHint"))}</p>`;
  }

  // The first statement after a starting balance checks it (owner's plan, 2026-11-11, step 3, option 4b): when what is left unexplained
  // equals recent entries the balance took as already in the bank, the row says so and "Review the correction" shows it before anything
  // changes. Accepted, it is saved with the rest (Undo of the upload undoes it too).
  function startFixHtml_(c, i) {
    if (c.direction !== "forward" || !c.startFix) return "";
    const names = c.startFix.items.map((it) => startFixName_(c, it)).join(tr("common.and"));
    if (startFixOn_(c._src || c)) {
      const corrected = startFixCorrected_(c), keeps = Math.abs(corrected - c.startFix.amount) < 0.005;   // only "already charged": the number stays
      return `<p class="stmt-note ok">${escapeHtml(tr(keeps ? "stmt.startFix.doneKeep" : "stmt.startFix.done", { date: fmtDate(c.startFix.date, true), corrected: fmtMoney(c.currency, corrected), n: c.startFix.items.length }))}</p>
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="add-inline" data-startfixoff="${i}">${escapeHtml(tr("stmt.startFix.undo"))}</button></div>`;
    }
    if (Math.abs(c.unexplained - startFixSum_(c)) > 0.004) return "";   // the person's other choices changed what is left: it no longer fits
    return `<p class="stmt-note info">💡 ${escapeHtml(tr("stmt.startFix.seems" + startFixKind_(c), { date: fmtDate(c.startFix.date, true), items: names, n: c.startFix.items.length, amount: signed(c.currency, startFixSum_(c)) }))}</p>
      <div class="stmt-choices" style="padding-left:0"><button type="button" class="add-inline" data-startfix="${i}">${escapeHtml(tr("stmt.startFix.review"))}</button></div>`;
  }

  // A server reason carries ISO dates ("2026-11-11"); the screen shows them the way every other date is shown (Mark, 2026-11-11).
  function isoDatesReadable_(text) { return String(text || "").replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => fmtDate(d, true)); }

  // One row per statement and currency: the closing balance, what the app showed that day, the difference and what it is made of.
  function balanceRowHtml(c0, i, covered) {
    const c = liveCheck(c0, covered);
    const lines = [`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balClosing", { date: fmtDate(c.end, true) }))}</span><span>${escapeHtml(fmtMoney(c.currency, c.closing))}</span></div>`];
    let verdict = "";
    if (c.direction === "untracked") {
      verdict = `<p class="stmt-note info">${escapeHtml(isoDatesReadable_(c.reason))}</p>`;
    } else {
      lines.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balInApp"))}</span><span>${escapeHtml(fmtMoney(c.currency, c.appAtEnd))}</span></div>`);
      lines.push(`<div class="stmt-kv"><span>${escapeHtml(tr("stmt.balDiff"))}</span><span>${escapeHtml(signed(c.currency, c.diff))}</span></div>`);
      // (a difference of 0 that the person's picks would open, e.g. a purchase inside the starting balance taking the bank's amount, is
      // explained below like any other: "Matches to the cent" would be wrong next to it)
      if (c.diff === 0 && !c.unexplained && !(c.startShift && c.startShift.lines) && !c.startFixed) {
        verdict = `<p class="stmt-note ok">${escapeHtml(tr("stmt.balMatches"))}</p>`;
      } else if (c.direction === "forward") {
        const parts = [];
        if (c.notInApp.lines) parts.push(tr("stmt.balNotInApp", { amount: signed(c.currency, c.notInApp.net), n: c.notInApp.lines }));
        if (c.pending.lines) parts.push(tr("stmt.balPending", { amount: signed(c.currency, c.pending.net), n: c.pending.lines }));
        if (c.discounted && c.discounted.lines) parts.push(tr("stmt.balDiscounted", { amount: signed(c.currency, c.discounted.net), n: c.discounted.lines }));
        if (c.noAccount && c.noAccount.lines) parts.push(tr("stmt.balNoAccount", { amount: signed(c.currency, c.noAccount.net), n: c.noAccount.lines }));
        if (c.otherCurrency && c.otherCurrency.lines) parts.push(tr("stmt.balOtherCurrency", { amount: signed(c.currency, c.otherCurrency.net), n: c.otherCurrency.lines }));
        if (c.late && c.late.lines) parts.push(tr("stmt.balLate", { amount: signed(c.currency, c.late.net), n: c.late.lines }));
        if (c.startShift && c.startShift.lines) parts.push(tr("stmt.balStartShift", { amount: signed(c.currency, c.startShift.net), n: c.startShift.lines }));
        if (c.startFixed) parts.push(tr("stmt.balStartFixed", { amount: signed(c.currency, c.startFixed.net), n: c.startFixed.lines }));
        const leftOut = c.leftOut ? ` ${tr("stmt.balLeftOut", { amount: signed(c.currency, c.leftOut.net), n: c.leftOut.lines })}` : "";
        verdict = c.unexplained === 0
          ? `<p class="stmt-note ok">${escapeHtml(tr("stmt.balExplained", { parts: parts.join(tr("common.and")) }))}</p>`
          : `<p class="stmt-note warn">${parts.length ? escapeHtml(parts.join(tr("common.and"))) + ". " : ""}<b>${escapeHtml(tr("stmt.balUnexplainedBold", { amount: signed(c.currency, c.unexplained) }))}</b>${escapeHtml(tr("stmt.balUnexplainedRest") + leftOut)}</p>`;
      } else if (c.direction === "backward") {
        verdict = `<p class="stmt-note info">${escapeHtml(tr("stmt.balBackward", { reason: isoDatesReadable_(c.reason), date: fmtDate(c.end) }))}</p>`;
      } else {
        verdict = `<p class="stmt-note info">${escapeHtml(isoDatesReadable_(c.reason))}</p>`;
      }
      // Same day as the starting balance: said, since setting the balance here replaces the number the person typed.
      if (c.sameDay) verdict = `<p class="hint">${escapeHtml(tr("stmt.balSameDay", { date: fmtDate(c.end, true) }))}</p>` + verdict;
      // The other half of an unexplained difference: what the app counts here that no statement line explains.
      if (c.direction === "forward" && c.late && c.late.lines) verdict += lateHtml(c);
      if (c.direction === "forward" && c.unexplained && c.appOnly && c.appOnly.n) verdict += appOnlyHtml(c);
      // No starting balance in this currency: the app counted it from 0, which is the likeliest cause of what is left unexplained.
      if (c.direction === "forward" && c.unexplained && c.noAnchor) verdict += `<p class="stmt-note warn">${escapeHtml(c.noAnchor.date
        ? tr("stmt.balNoAnchor", { cur: c.currency, date: fmtDate(c.noAnchor.date, true), account: acctOfCheck(c) })
        : tr("stmt.balNoAnchorNoDate", { cur: c.currency, account: acctOfCheck(c) }))}</p>`;
      verdict += startFixHtml_(c, i);
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
    const covered = coveredLines(historyActions(false));
    const all = can.length > 1 ? `<div class="stmt-choices" style="padding-left:0">${modeButton(`data-balall="1"`, allOn, tr("bal.setAll", { n: can.length }))}</div>` : "";
    return `<details class="stmt-group" id="statement-history-balances" ${p.balOpen ? "open" : ""}><summary>${escapeHtml(tr("bal.title", { n: checks.length }))}${typeof infoBtnHtml_ === "function" ? infoBtnHtml_("stmtCheck") : ""}</summary>
      <p class="hint">${escapeHtml(tr("bal.hint"))}</p>${all}${checks.map((c, i) => balanceRowHtml(c, i, covered)).join("")}</details>`;
  }

  // ---- accounts the statements name that the app does not have yet (backend/StatementAccounts.gs) ----
  // The plan proposes them with defaults; one tap adds them and reads the statements again. They can be changed afterwards in
  // More → Accounts, cards & platforms, which is where the "added" note points.
  let addedAccounts = [];   // accounts added from the statements on this screen: [{ id, nickname }]
  let linkedAccounts = [];  // the person's own accounts that got a statement's digits here: [{ id, nickname, last_4 }]
  // "Is this your …?" (owner, 2026-11-23): a statement for unknown digits whose bank has an account of the same type with NO digits asks
  // first (backend matches). Answer per statement key: an account id, or "new". Nothing is saved until the button below.
  const acctAnswer = {};

  function newAccountsHtml(proposals) {
    if (!proposals.length) return "";
    const asks = proposals.filter((a) => (a.matches || []).length), plain = proposals.filter((a) => !(a.matches || []).length);
    let html = "";
    if (asks.length) {
      html += `<p class="stmt-verdict warn" style="margin-top:0">${escapeHtml(tr("acct.ask.title", { n: asks.length }))}</p>
        <p class="hint" style="margin:0 0 6px">${escapeHtml(tr("acct.ask.why", { n: asks.length }))}</p>`;
      html += asks.map((a) => {
        const ans = acctAnswer[a.key];
        // An account already chosen for another statement is not offered again.
        const usedElsewhere = new Set(Object.keys(acctAnswer).filter((k) => k !== a.key && acctAnswer[k] !== "new").map((k) => acctAnswer[k]));
        const matches = a.matches.filter((m) => !usedElsewhere.has(m.id));
        const one = matches.length === 1;
        const q = tr(a.type === "credit" ? "acct.ask.card" : "acct.ask.account", { bank: a.bank, last4: a.last4 }) + " "
          + (one ? tr("acct.ask.one", { name: matches[0].nickname }) : matches.length ? tr("acct.ask.many") : "");
        const btns = matches.map((m) => modeButton(`data-acctask="${escapeHtml(a.key)}" data-acctid="${escapeHtml(m.id)}"`, ans === m.id, one ? tr("acct.ask.yes") : m.nickname)).join("")
          + modeButton(`data-acctask="${escapeHtml(a.key)}" data-acctid="new"`, ans === "new" || !matches.length, tr("acct.ask.no"));
        const chosen = matches.find((m) => m.id === ans);
        const after = chosen ? tr("acct.ask.yesNote", { last4: a.last4, name: chosen.nickname })
          : ans === "new" || !matches.length ? tr("acct.ask.newName", { name: a.nickname }) : "";
        return `<div class="stmt-line2"><p style="margin:6px 0">${escapeHtml(q)}</p><div class="stmt-choices" style="padding-left:0">${btns}</div>${after ? `<p class="hint" style="margin:4px 0 0">${escapeHtml(after)}</p>` : ""}</div>`;
      }).join("");
    }
    if (plain.length) {
      const items = plain.map((a) => `<li><strong>${escapeHtml(a.nickname)}</strong> · ${escapeHtml(tr(a.type === "credit" ? "acct.typeCredit" : "acct.typeDebit"))} · ${escapeHtml(a.bank)} · …${escapeHtml(a.last4)}</li>`).join("");
      html += `<p class="stmt-verdict warn" style="margin-top:${asks.length ? "12px" : "0"}">${escapeHtml(tr("acct.newTitle", { n: plain.length }))}</p>
      <ul style="list-style:disc;margin:6px 0;padding-left:20px">${items}</ul>
      <p class="hint">${escapeHtml(tr("acct.newHint", { n: plain.length }))}</p>`;
    }
    const open = asks.filter((a) => acctAnswer[a.key] === undefined && a.matches.some((m) => !Object.keys(acctAnswer).some((k) => k !== a.key && acctAnswer[k] === m.id)));
    const nNew = plain.length + asks.filter((a) => !open.includes(a) && !a.matches.some((m) => m.id === acctAnswer[a.key])).length;
    const label = open.length ? tr("acct.ask.answerFirst", { n: open.length }) : nNew ? tr("acct.addBtn", { n: nNew }) : tr("acct.ask.saveBtn");
    return `<div class="stmt-new-accounts" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px">${html}
      <button type="button" class="primary" id="statement-add-accounts"${open.length ? " disabled" : ""}>${escapeHtml(label)}</button></div>`;
  }

  function addedAccountsHtml() {
    const linkedNote = linkedAccounts.length ? `<p class="stmt-note ok" style="margin:0 0 12px">${escapeHtml(tr("acct.ask.linked", { n: linkedAccounts.length, names: linkedAccounts.map((a) => a.nickname).join(", ") }))}</p>` : "";
    if (!addedAccounts.length) return linkedNote;
    return linkedNote + addedAccountsInner();
  }
  function addedAccountsInner() {
    return `<div class="stmt-note ok" style="margin-bottom:12px"><p style="margin:0 0 6px">${escapeHtml(tr("acct.added", { n: addedAccounts.length, names: addedAccounts.map((a) => a.nickname).join(", ") }))}</p>
      <p class="hint" style="margin:0 0 6px">${escapeHtml(tr("acct.addedHint", { n: addedAccounts.length }))}</p>
      <button type="button" class="add-inline" id="statement-open-accounts">${escapeHtml(tr("acct.review", { n: addedAccounts.length }))}</button>${incompleteHtml()}</div>`;
  }
  // New accounts with no bank or last 4 digits yet (an import's): named, each with "Complete" opening its own window (owner, 2026-11-21),
  // since bank e-mails and statements recognise an account by its bank and digits.
  function incompleteHtml() {
    const list = addedAccounts.filter((a) => a.incomplete);
    if (!list.length) return startBalHtml();
    return `<p class="stmt-note warn" style="margin:10px 0 4px">${escapeHtml(tr(list.some((a) => a.noBank != null) ? "acct.incompleteEach" : "acct.incomplete", { n: list.length }))}</p>
      ${list.map((a) => `<div class="stmt-kv"><span>${escapeHtml(a.nickname)}${a.noBank != null ? `<br><span class="hint">${escapeHtml(tr(a.noBank && a.noDigits ? "acct.missBoth" : a.noBank ? "acct.missBank" : "acct.missDigits"))}</span>` : ""}</span><button type="button" class="add-inline stmt-complete-acct" data-id="${escapeHtml(a.id)}">${escapeHtml(tr("acct.complete"))}</button></div>`).join("")}${startBalHtml()}`;
  }
  // A starting balance for each account the import made (Elena, testers 2026-11-21: Balances stayed "No balances yet" and nothing
  // said why). Optional; the button opens the account's own balance window (app.js openBalanceModal).
  function startBalHtml() {
    const list = addedAccounts.filter((a) => a.id);
    if (!list.length || typeof openStartBalanceFor_ !== "function") return "";
    return `<p class="hint" style="margin:10px 0 4px">${escapeHtml(tr("acct.startBalHint", { n: list.length }))}</p>
      ${list.map((a) => `<div class="stmt-kv"><span>${escapeHtml(a.nickname)}</span><button type="button" class="add-inline stmt-start-bal" data-id="${escapeHtml(a.id)}">${escapeHtml(tr("acct.startBal"))}</button></div>`).join("")}`;
  }
  async function completeAccount(id) {
    let pm = ((meta && meta.paymentMethods) || []).find((p) => p.id === id);
    if (!pm && typeof loadMeta === "function") { await loadMeta(); pm = ((meta && meta.paymentMethods) || []).find((p) => p.id === id); }
    if (pm && typeof openPmModal_ === "function") openPmModal_(pm);
  }

  async function addProposedAccounts() {
    const btn = $("statement-add-accounts");
    if (!btn || !historyPlan) return;
    const proposals = (historyPlan.summary && historyPlan.summary.newAccounts) || [];
    const before = btn.textContent;
    btn.disabled = true;
    btn.textContent = tr("acct.adding");
    try {
      const res = await callApi("createStatementAccounts", { accounts: proposals.map((a) => {
        const id = acctAnswer[a.key];
        return { last4: a.last4, bank: a.bank, kind: a.kind, ...(id && id !== "new" && (a.matches || []).some((m) => m.id === id) ? { id } : {}) };
      }) });
      Object.keys(acctAnswer).forEach((k) => delete acctAnswer[k]);
      addedAccounts = addedAccounts.concat(res.created || []);
      linkedAccounts = linkedAccounts.concat(res.linked || []);
      if (typeof loadMeta === "function") await loadMeta();   // the new accounts are known to the rest of the app from now on
      await runHistoryPlan();                                   // the statements are read again, now with their account
    } catch (err) {
      btn.disabled = false;
      btn.textContent = before;
      showAppMessage_(err.message || String(err));
    }
  }

  // "These lines look like planned items" (owner's plan, 2026-11-17): each with its tick, all ticked; Save links the ticked ones to that
  // Programmed item's month, so Projections counts each once. Only where the server sends them (an older backend: nothing shown).
  function planMatchesHtml_() {
    const pm = (historyPlan && historyPlan.plan_matches) || [];
    if (!pm.length) return "";
    const row = (m, i) => `<label class="review-plan-match"><input type="checkbox" class="stmt-plan-check" data-i="${i}" checked> ${escapeHtml(tr("hist.planLine", { line: m.description, amount: fmtMoney(m.currency, m.amount), name: m.name || tr("plan.thePlanned"), month: paceMonthName_(m.month, true) }))}</label>`;
    return `<div class="stmt-plan-matches"><p class="hint">${escapeHtml(tr("hist.planHead", { n: pm.length }))}</p>${pm.map(row).join("")}</div>`;
  }
  function planLinksChosen_() {
    const pm = (historyPlan && historyPlan.plan_matches) || [];
    return Array.from(document.querySelectorAll("#statement-history .stmt-plan-check")).filter((c) => c.checked).map((c) => pm[Number(c.dataset.i)]).filter(Boolean)
      .map((m) => ({ stmt: m.stmt, line: m.line, recurring_id: m.recurring_id, month: m.month }));
  }
  // One summary bullet; a {text, sub} item puts its sub-lines under it (the per-currency totals of the expenses).
  function sumLi_(t) {
    if (typeof t === "string") return `<li>${escapeHtml(t)}</li>`;
    return `<li>${escapeHtml(t.text)}<ul class="stmt-sum-sub">${t.sub.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></li>`;
  }

  // Every line that becomes a NEW entry, so the person can see them before saving (owner, 2026-11-14): folded, oldest first, each
  // with its account. Worked out from the same final actions as the counters, so the list and "N new" always agree.
  const NEW_LINE_ACTIONS_ = ["add_history_expense", "add_history_income", "add_history_reversal", "add_history_refund", "record_transfer",
    "record_transfer_leg", "add_history_investment", "add_history_pending", "record_exchange", "record_fee"];
  // The account a statement belongs to, as the plan names it (any of its lines the plan lists carries it).
  function stmtAccountName_(stmt) {
    const sm = historyPlan.summary;
    const hit = [sm.candidates, sm.recharges, sm.discounts, sm.charges, sm.aside, sm.noAccount].flat().find((x) => x && x.stmt === stmt && x.account);
    return hit ? hit.account : "";
  }
  function newLinesHtml_() {
    const seen = {}, items = [];
    historyActions().filter((a) => NEW_LINE_ACTIONS_.includes(a.type)).forEach((a) => {
      [a, a.out, a.in].forEach((ref) => {
        if (!ref || ref.stmt === undefined || ref.line === undefined || !usable[ref.stmt]) return;
        const key = lineKey(ref);
        const l = usable[ref.stmt].result.lines[ref.line];
        if (seen[key] || !l) return;
        seen[key] = true;
        items.push({ stmt: ref.stmt, line: ref.line, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: stmtAccountName_(ref.stmt) });
      });
    });
    if (!items.length) return "";
    const id = "statement-history-newlines";
    const rows = items.sort(byDate_).map((x) => lineRow(x, x.account ? escapeHtml(x.account) : "")).join("");
    return `<details class="stmt-group" id="${id}" data-sec="${id}" ${secOpen_(id)}><summary>${escapeHtml(tr("hist.newLines", { n: items.length }))}</summary>${rows}</details>`;
  }

  function renderHistoryPlan() {
    refreshStartFixes_();
    const out = $("statement-history");
    const { actions, summary } = historyPlan;
    const left = summary.leftOut, c = historyCounts();
    const lines = [];
    // Same order as the groups below: new entries, then what changes in entries you have, then what is only remembered.
    if (c.expenses) {
      const totals = moneyTotals(c.spent).split(" + ");
      if (totals.length > 1) lines.push({ text: tr("hist.sum.expensesMany", { n: c.expenses }), sub: totals });   // one line per currency, under it: never added together
      else lines.push(tr("hist.sum.expenses", { n: c.expenses, total: totals[0] }));
    }
    if (c.income) lines.push(tr("hist.sum.income", { n: c.income }));
    if (c.refunds) lines.push(tr("hist.sum.refunds", { n: c.refunds }));
    if (c.refundIncome) lines.push(tr("hist.sum.refundIncome", { n: c.refundIncome }));
    if (c.transfers) lines.push(tr("hist.sum.transfers", { n: c.transfers }));
    if (c.legs) lines.push(tr("hist.sum.legs", { n: c.legs }));
    if (c.investments) lines.push(tr("hist.sum.investments", { n: c.investments }));
    if (c.loans) lines.push(tr("hist.sum.loans", { n: c.loans }));
    if (c.exchanges) lines.push(tr("hist.sum.exchanges", { n: c.exchanges }));
    if (c.fees) lines.push(tr("hist.sum.fees", { n: c.fees }));
    if (c.pending) lines.push(tr("hist.sum.pending", { n: c.pending }));
    if (c.accountsFilled) lines.push(tr("hist.sum.accountsFilled", { n: c.accountsFilled }));
    if (c.charges) lines.push(tr("hist.sum.charges", { n: c.charges }));
    if (c.recharges - c.currencyFixed) lines.push(tr("hist.sum.recharges", { n: c.recharges - c.currencyFixed }));
    if (c.currencyFixed) lines.push(tr("hist.sum.currencyFixed", { n: c.currencyFixed }));
    if (c.discounts) lines.push(tr("hist.sum.discounts", { n: c.discounts }));
    if (c.linked) lines.push(tr("hist.sum.linked", { n: c.linked }));
    if (c.left) lines.push(tr("hist.sum.left", { n: c.left }));
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
    const readyHtml = noAccountHtml() + chargesHtml("ready") + rechargesHtml("ready") + discountsHtml("ready");
    const decideHtml = discountsHtml("decide") + chargesHtml("decide") + rechargesHtml("decide") + peopleHtml() + incomeHtml()
      + (StatementTable.canLinkExchange(summary.candidates) && (screenMode !== "import" || (summary.exchangeSuggestions || []).length || historyPlan.exchanges.length) ? exchangeHtml() : "") + asideHtml();
    // (another app's file: the exchange fold only when the app found a pair; a closed fold with nothing in it read as an empty
    // heading, Elena 2026-11-21. A bank statement keeps it for linking two lines by hand.)
    const noteHtml = notes.map((t) => `<p class="stmt-note info">${escapeHtml(t)}</p>`).join("")
      + (readyHtml ? `<h3 class="stmt-section-title">${escapeHtml(tr("hist.sec.ready"))}</h3>${readyHtml}` : "")
      + (decideHtml ? `<h3 class="stmt-section-title">${escapeHtml(tr("hist.sec.decide"))}</h3>${decideHtml}` : "")
      + (() => { const b = balancesHtml(); return b && (readyHtml || decideHtml) ? `<h3 class="stmt-section-title">${escapeHtml(tr("hist.sec.balances"))}</h3>${b}` : b; })();
    if (!actions.length && !(summary.aside || []).length && !(summary.peopleOut || []).length && !(summary.charges || []).length && !(summary.discounts || []).length && !(summary.recharges || []).length && !(historyPlan.checks || []).length) {
      out.innerHTML = pre + (proposals.length ? "" : `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>`) + noteHtml;
      return;
    }
    if (!c.entries && !c.charges && !c.discounts && !c.recharges) {
      // Nothing to add. Lines waiting for their other statement can still be remembered so they pair up later, and balances set.
      out.innerHTML = pre + `<p class="stmt-verdict warn">${escapeHtml(tr("hist.nothing"))}</p>${lines.length ? `<ul style="list-style:disc;margin:6px 0;padding-left:20px">${lines.map(sumLi_).join("")}</ul>` : ""}${noteHtml}
        ${historyActions().length ? `${dueAskHtml_()}<button type="button" class="${c.balances ? "primary" : "stmt-choice"}" id="statement-history-save">${escapeHtml(tr(c.balances ? "hist.saveBalances" : "hist.remember"))}</button>` : ""}`;
      return;
    }
    const range = summary.from && summary.to ? `<p class="hint">${escapeHtml(summary.from === summary.to ? tr("hist.rangeOne", { date: fmtDate(summary.from, true) })
      : tr("hist.range", { from: fmtDate(summary.from, true), to: fmtDate(summary.to, true) }))}</p>` : "";
    // Three counters first (owner, 2026-11-11): new entries · entries you have that change · choices still open.
    const nUpdated = c.accountsFilled + c.charges + c.recharges + c.discounts;
    const nDecide = (summary.charges || []).filter((x, k) => !chargeOf(k)).length + (summary.recharges || []).filter((x, k) => !rechargeOf(k)).length
      + (summary.discounts || []).filter((x, k) => !discountOf(k)).length;
    const counters = `<p class="stmt-counters">${[
      `<span>➕ ${escapeHtml(tr("hist.cnt.new", { n: c.entries }))}</span>`,
      `<span>✏️ ${escapeHtml(tr("hist.cnt.updated", { n: nUpdated }))}</span>`,
      `<span>❓ ${escapeHtml(tr("hist.cnt.decide", { n: nDecide }))}</span>`].join(" · ")}</p>`;
    out.innerHTML = pre + `<p class="stmt-verdict good">${escapeHtml(tr("hist.ready"))}</p>${counters}
      <ul style="list-style:disc;margin:6px 0;padding-left:20px">${lines.map(sumLi_).join("")}</ul>
      ${newLinesHtml_()}${range}<p class="hint">${escapeHtml(tr(!usable.some((u) => u.result.lines.some((l) => l.category)) ? "hist.noCategory" : usable.every((u) => u.catLeft === 0) ? "hist.categoryAsNamed" : "hist.noCategoryUnlessNamed"))}</p>${noteHtml}
      ${planMatchesHtml_()}${dueAskHtml_()}
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
    const hc = historyCounts(), adding = hc.entries, updating = hc.charges + hc.discounts + hc.recharges + hc.accountsFilled;
    // Purchases already in the app that take the card's figure are a change too: never say "nothing is added" about them alone.
    // Both when a statement adds AND corrects purchases already in the app (Carlos, 2026-11-10: only the added ones were named).
    // Another app's export brings its categories, and after saving the app names any left without one (hist.savedCategoriesMissed),
    // so its question does not promise a Tidy step that may not exist (Mark, 2026-11-18).
    // Lines that go to Needs review are not "confirmed": they are counted apart (Mark, testers 2026-11-21: "129 entries… confirmed"
    // when 13 of them waited in Needs review).
    const waiting = (hc.pending || 0) + (hc.pendingInvestments || 0), confirming = adding - waiting;
    const addText = (confirming > 0 ? tr(screenMode === "import" ? "hist.confirmImport" : "hist.confirm", { n: confirming }) : "")
      + (waiting > 0 ? (confirming > 0 ? " " : "") + tr("hist.confirmWaiting", { n: waiting }) : "");
    const askText = adding ? addText + (updating ? " " + tr("hist.confirmAlsoUpdate", { n: updating }) : "")
      : updating ? tr("hist.confirmUpdate", { n: updating }) : tr("hist.confirmKeep");
    // A starting balance this save corrects (owner's plan, step 3): said too, since it moves every balance after it.
    const coveredNow = coveredLines(historyActions(false));
    // (an accepted correction made only of "already charged" purchases leaves the number as typed: not counted as a correction)
    const fixes = (historyPlan.checks || []).filter((c, i) => (c.startFix && historyPlan.startFix.has(i) && c.startFix.items.some((it) => it.side !== "bank")) ||
      ((liveCheck(c, coveredNow).startShift || {}).lines > 0)).length;
    const askFull = askText + (fixes ? " " + tr("hist.confirmStartFix", { n: fixes }) : "");
    const dueProblem = applyDueTyped_();   // a pay-by date typed on or before the close: said here, nothing saved
    if (dueProblem) { status.innerHTML = `<p class="stmt-verdict warn">${escapeHtml(dueProblem)}</p>`; return; }
    if (!practiceNoConfirm_(practiceIOwns_(usable.map((u) => u.group || u.file))) && !await askConfirmApp_(askFull + "\n\n" + tr("stmt.confirmUndoable"), tr("confirmBtn.addToHistory"), { plain: true })) return;   // (the practice's own file asks nothing while the walkthrough runs)
    btn.insertAdjacentHTML("afterend", loadingHtml(tr("hist.saving")));   // right where the person tapped, not in a box further down
    btn.hidden = true;
    status.innerHTML = "";
    const payload = (dryRun) => ({
      dryRun,
      filename: `History ${usable.map((u) => u.file).join(", ")}`.slice(0, 200),
      statements: usable.map(({ file, result }) => ({
        key: accountKeyOf(result), newAccount: result.newAccount || undefined, rail: result.rail || undefined, kind: result.kind, source: result.source || "", period: result.period, file_name: file,
        verified: !!(result.ok && result.verified !== false), balances: result.balances, due: result.due || "",
        lines: result.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, currency: l.currency, section: l.section, category: l.category, transfer: l.transfer }))
      })),
      inboxIds: usable.map((u) => u.inboxId).filter(Boolean),
      inboxKeys: Object.fromEntries(usable.filter((u) => u.inboxId).map((u) => [u.inboxId, accountKeyOf(u.result)])),   // "Already read": one per account
      categoryMap: Object.assign({}, ...usable.map((u) => u.result.categoryMap || {})),
      categoryNames: Object.assign({}, ...usable.map((u) => u.result.categoryNames || {})),   // the name each of those categories should carry   // the person's choice for each category name of a spreadsheet
      actions: historyActions(),
      planLinks: planLinks
    });
    const planLinks = planLinksChosen_();   // read before the preview is cleared
    try {
      await callApi("applyStatementDecisions", payload(true));   // validates first, writes nothing
      const res = await callApi("applyStatementDecisions", payload(false));
      lastBatchId = res.batchId;
      practiceINote_("saved", res.batchId);
      const made = res.created.transfers + res.created.fees + res.created.purchases + (res.created.income || 0) + (res.created.reversals || 0) + (res.created.investments || 0) + (res.created.pending || 0) + (res.created.loans || 0) + (res.created.repayments || 0);
      // Say what did NOT happen too: entries waiting for the person in Needs review, and lines that were not added.
      const used = new Set(historyActions().filter((a) => a.type !== "wait" && a.stmt !== undefined).map(lineKey));
      const notAdded = (historyPlan.summary.aside || []).filter((a) => !used.has(lineKey(a))).length + historyCounts().left;
      const waiting = res.pendingCount || 0;
      // A loan or repayment the Loans code refused (a friend deleted meanwhile…): named, the rest is saved and Undo still removes it all.
      const loanFails = (res.loanFailures || []).map((f) => tr("hist.loanFailedLine", { date: fmtDate(f.date, true), name: f.description, amount: fmtMoney(f.currency, Math.abs(f.amount)), friend: f.friend, error: f.error }));
      const outcome = (loanFails.length ? `<p class="stmt-note warn">${escapeHtml(tr("hist.loanFailed", { n: loanFails.length }))}<br>${loanFails.map(escapeHtml).join("<br>")}</p>` : "") + (waiting ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedPending", { n: waiting }))}</p><div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-goreview-btn">${escapeHtml(tr("added.goReview"))}</button></div>` : "")
        + (res.chargesFilled ? `<p class="stmt-note info">${escapeHtml(tr("hist.sum.charges", { n: res.chargesFilled }))}</p>` : "")
        + (res.discounts ? `<p class="stmt-note info">${escapeHtml(tr("hist.sum.discounts", { n: res.discounts }))}</p>` : "")
        + (res.recharges ? `<p class="stmt-note info">${escapeHtml(tr("hist.sum.recharges", { n: res.recharges }))}</p>` : "")
        + (notAdded ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedNotAdded", { n: notAdded }))}</p>` : "")
        + (res.categoriesGuessed ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedGuessed", { n: res.categoriesGuessed }))}</p>` : "")
        + (res.categoriesFiled ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategories", { n: res.categoriesFiled }))}</p>` : "")
        + ((res.categoriesRenamed || []).length ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesRenamed", { n: res.categoriesRenamed.length, names: res.categoriesRenamed.map((r) => `${r.from} → ${r.to}`).join(", ") }))}</p>` : "")
        + ((res.categoriesCreatedNames || []).length ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesCreated", { n: res.categoriesCreatedNames.length, names: res.categoriesCreatedNames.join(", ") }))}</p>` : "")
        + (res.categoriesMissed ? `<p class="stmt-note info">${escapeHtml(tr("hist.savedCategoriesMissed", { n: res.categoriesMissed, names: (res.categoryMissedNames || []).join(", ") }))}</p>` : "");
      // Only lines that really came in without a category lead to Tidy my history (an older backend does not count them: any purchase, as before).
      const uncategorized = res.uncategorized != null ? Number(res.uncategorized) || 0 : (res.created.purchases || 0);
      if ((res.accountsCreated || []).length) {   // accounts a spreadsheet named, made with this save: said like the statements' new accounts
        addedAccounts = addedAccounts.concat(res.accountsCreated);
        if (typeof loadMeta === "function") loadMeta().catch(() => {});
      }
      status.innerHTML = `<div class="stmt-result"><p class="stmt-verdict good">${escapeHtml(made ? (made - (res.created.pending || 0) > 0 ? tr("hist.saved", { n: made - (res.created.pending || 0) }) + (res.created.pending ? " " + tr("hist.savedWaiting", { n: res.created.pending }) : "") : tr("hist.savedAllWaiting", { n: made })) : tr("stmt.saved"))}</p>
        ${addedAccountsHtml()}${outcome}${rateNeedsHtml(res.rateNeeds)}
        <div class="stmt-choices" style="padding-left:0"><button type="button" class="stmt-choice stmt-added-btn" data-batch="${escapeHtml(res.batchId)}">${escapeHtml(tr("added.button"))}</button>${uncategorized > 0 ? `<button type="button" class="stmt-choice stmt-tidy-btn" data-n="${res.uncategorized != null ? uncategorized : ""}">${escapeHtml(tr("tidy.fromStatements"))}</button>` : ""}</div>
        <button type="button" class="cancel-edit-btn" id="stmt-undo-btn">${escapeHtml(tr("stmt.undoUpload"))}</button></div>`;
      historyPlan = null;
      addedAccounts = [];
      linkedAccounts = [];
      $("statement-history").innerHTML = "";
      // The files just saved leave the Upload step: a next upload counts only its own files (journeys run, 2026-11-17: Lucía read
      // "2 of 2 ready" with one file left, Julia "4 of 4" with an already-added file still listed).
      $("statement-results").innerHTML = "";
      usable = [];
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
    if (!practiceNoConfirm_(practiceIOwnsBatch_(batchId)) && !await askConfirmApp_(tr("stmt.confirmUndo"), tr("confirmBtn.yes"), { plain: true })) return;
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
      practiceINote_("undone", batchId);
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
      batchesHeld[screenMode] = batches.length;
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
      try { await callApi("setBatchOrigin", { batchId: mv.dataset.batch, origin: screenMode === "import" ? "statement" : "import" }); } catch (err) { showAppMessage_(err.message || String(err)); }
      refreshStatementBatches();
      refreshStatementCoverage();
      return;
    }
    if (!e.target.closest("#statement-batches-more")) return;
    batchesShown += BATCHES_STEP;
    refreshStatementBatches();
  });
  $("data-statements-btn").addEventListener("click", () => showStatementsScreen("bank"));
  $("data-import-btn").addEventListener("click", () => showStatementsScreen("import"));
  $("stmt-mode-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".be-tab");
    if (tab && tab.dataset.mode !== screenMode) { showStatementsScreen(tab.dataset.mode); window.scrollTo(0, 0); }
  });
  $("statements-back-btn").addEventListener("click", () => { sessionPasswords = []; showMyDataScreen(); });
  $("statement-file-input").addEventListener("click", () => setPickerWaiting(true));
  $("statement-file-input").addEventListener("cancel", () => setPickerWaiting(false));
  $("statement-file-input").addEventListener("change", (e) => {
    setPickerWaiting(false);
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
  $("stmt-status-toggle").addEventListener("click", () => setStatusOpen($("statement-coverage-list").hidden));
  $("stmt-step1-continue").addEventListener("click", () => showStep(2));
  $("stmt-digits-card").addEventListener("click", (e) => { const b = e.target.closest(".stmt-digits-add"); if (b) completeAccount(b.dataset.id); });
  $("stmt-next-2").addEventListener("click", () => { if (!readingBusy()) showStep(3); });
  $("stmt-add-more").addEventListener("click", () => showStep(1));
  $("stmt-back-3").addEventListener("click", () => showStep(2));
  $("stmt-another").addEventListener("click", () => { clearRun(); showStep(1); });
  $("statement-past-btn").addEventListener("click", () => { pastOpen = true; renderSteps(); window.scrollTo(0, 0); });
  $("statement-past-back").addEventListener("click", () => { pastOpen = false; renderSteps(); window.scrollTo(0, 0); });
  $("statement-history").addEventListener("input", (e) => {   // a typed pay-by date survives the preview redrawing (a tick elsewhere)
    if (e.target.dataset && e.target.dataset.dueStmt !== undefined) dueTyped[e.target.dataset.dueStmt] = e.target.value;
  });
  $("statement-history").addEventListener("click", (e) => {
    if (e.target.closest("#statement-history-save")) { saveHistory(); return; }
    if (e.target.closest("#statement-add-accounts")) { addProposedAccounts(); return; }
    const ask = e.target.closest("[data-acctask]");
    if (ask) { acctAnswer[ask.dataset.acctask] = ask.dataset.acctid; renderHistoryPlan(); return; }
    if (e.target.closest("#statement-open-accounts")) { $("more-accounts-btn").click(); return; }
    if (!historyPlan) return;
    const one = e.target.closest("[data-aside]"), grp = e.target.closest("[data-agroup]");
    const pout = e.target.closest("[data-pout]"), pbulk = e.target.closest("[data-pbulk]"), pinc = e.target.closest("[data-pinc]");
    const bal = e.target.closest("[data-bal]"), balAll = e.target.closest("[data-balall]");
    const sfix = e.target.closest("[data-startfix]"), sfixOff = e.target.closest("[data-startfixoff]");
    if (sfixOff) { historyPlan.startFix.delete(Number(sfixOff.dataset.startfixoff)); historyPlan.balOpen = true; renderHistoryPlan(); return; }
    if (sfix) {
      const i = Number(sfix.dataset.startfix), c = historyPlan.checks[i];
      if (!c || !c.startFix) return;
      const line = (it) => `${fmtDate(it.date, true)} · ${startFixName_(c, it)}`;
      const ins = c.startFix.items.filter((it) => (it.side || "in") === "in"), outs = c.startFix.items.filter((it) => it.side === "out");
      const banks = c.startFix.items.filter((it) => it.side === "bank");
      const names = [ins.length ? tr("stmt.startFix.whyIn", { n: ins.length }) + "\n" + ins.map(line).join("\n") : "",
        outs.length ? tr("stmt.startFix.whyOut", { n: outs.length }) + "\n" + outs.map(line).join("\n") : "",
        banks.length ? tr("stmt.startFix.whyBank", { n: banks.length }) + "\n" + banks.map(line).join("\n") : ""].filter(Boolean).join("\n\n");
      const lc = liveCheck(c, coveredLines(historyActions(false))), corrected = startFixCorrected_(lc);
      const keeps = Math.abs(corrected - c.startFix.amount) < 0.005;   // only "already charged": the number stays as typed
      const text = tr(keeps ? "stmt.startFix.windowKeep" : "stmt.startFix.window", { account: acctOfCheck(c), date: fmtDate(c.startFix.date, true), amount: fmtMoney(c.currency, c.startFix.amount),
        corrected: fmtMoney(c.currency, corrected), moved: fmtMoney(c.currency, r2_(c.startFix.amount + ((lc.startShift && lc.startShift.net) || 0))),
        // after everything this upload adds or corrects, plus this correction: the statement minus what would still be unexplained
        items: names, after: fmtMoney(c.currency, r2_(c.closing - (liveCheck(c, coveredLines(historyActions(false))).unexplained - startFixSum_(c)))), closing: fmtMoney(c.currency, c.closing) });
      (async () => {   // the window waits for the answer; this click handler does not
        if (!await askConfirmApp_(text, tr("stmt.startFix.ok"), { plain: true })) return;
        if (!historyPlan || historyPlan.checks[i] !== c) return;
        historyPlan.startFix.add(i);
        historyPlan.balOpen = true;
        renderHistoryPlan();
      })();
      return;
    }
    const link = e.target.closest("[data-xlink]"), unlink = e.target.closest("[data-xunlink]"), manual = e.target.closest("[data-xmanual]");
    const aside = historyPlan.summary.aside || [];
    const na = e.target.closest("[data-noacct]");
    if (na) {
      if (na.dataset.pick === "add") historyPlan.noAcctOff.add(na.dataset.noacct); else historyPlan.noAcctOff.delete(na.dataset.noacct);
      renderHistoryPlan();
      return;
    }
    const rech = e.target.closest("[data-rech]");
    if (rech) {
      historyPlan.rechargeChoice.set(Number(rech.dataset.rech), rechargeOf(Number(rech.dataset.rech)) === rech.dataset.pick ? "" : rech.dataset.pick);
      renderHistoryPlan();
      return;
    }
    const disc = e.target.closest("[data-disc]");
    if (disc) {
      historyPlan.discountChoice.set(Number(disc.dataset.disc), discountOf(Number(disc.dataset.disc)) === disc.dataset.pick ? "" : disc.dataset.pick);
      renderHistoryPlan();
      return;
    }
    const chg = e.target.closest("[data-chg]");
    if (chg) {
      historyPlan.chargeChoice.set(Number(chg.dataset.chg), chargeOf(Number(chg.dataset.chg)) === chg.dataset.pick ? "" : chg.dataset.pick);
      renderHistoryPlan();
      return;
    }
    if (bal) {
      const i = Number(bal.dataset.bal), c = historyPlan.checks[i];
      if (!historyPlan.bal.has(i) && c && c.sameDay) {
        (async () => {   // replacing the number the person typed for that same day: asked first
          if (!await askConfirmApp_(tr("stmt.balSameDayAsk", { date: fmtDate(c.end, true), amount: fmtMoney(c.currency, c.closing) }), tr("stmt.balSameDayOk"), { plain: true })) return;
          if (!historyPlan || historyPlan.checks[i] !== c) return;
          historyPlan.bal.add(i);
          historyPlan.balOpen = true;
          renderHistoryPlan();
        })();
        return;
      }
      if (historyPlan.bal.has(i)) historyPlan.bal.delete(i); else historyPlan.bal.add(i);
      historyPlan.balOpen = true;
    } else if (balAll) {
      const can = settableChecks(), allOn = can.every(({ i }) => historyPlan.bal.has(i));
      can.forEach(({ i, c }) => { if (allOn) historyPlan.bal.delete(i); else if (!c.sameDay) historyPlan.bal.add(i); });   // a same-day one asks on its own button
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
    if (e.target.dataset && e.target.dataset.sec && historyPlan.openSec) {
      if (e.target.open) historyPlan.openSec.add(e.target.dataset.sec); else historyPlan.openSec.delete(e.target.dataset.sec);
    }
    if (e.target.dataset && e.target.dataset.gopen) {
      const g = Number(e.target.dataset.gopen);
      if (e.target.open) historyPlan.openGroups.add(g); else historyPlan.openGroups.delete(g);
    }
  }, true);
  $("stmt-viewer-back").addEventListener("click", closeStatementViewer);
  // Two fingers zoom the pages in and out (owner, 2026-11-20; it was a tap), from the screen's width up to 4 times it. The pages are
  // made wider (not magnified as a picture), so the screen scrolls both ways; the point between the fingers stays under them.
  // The browser's own pinch is turned off here (touch-action in style.css), else it would zoom the whole app.
  (() => {
    const scroll = $("stmt-viewer-scroll"), pages = $("stmt-viewer-pages");
    let pinch = null;
    const gap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => { const r = scroll.getBoundingClientRect(); return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top }; };
    scroll.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2 || pages.hidden) return;
      pinch = { gap: gap(e.touches), zoom: Number(pages.dataset.zoom || 1) };
    }, { passive: true });
    scroll.addEventListener("touchmove", (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const was = Number(pages.dataset.zoom || 1);
      const zoom = Math.min(4, Math.max(1, pinch.zoom * gap(e.touches) / pinch.gap));
      if (Math.abs(zoom - was) < 0.01) return;
      const m = mid(e.touches), k = zoom / was;
      const cx = scroll.scrollLeft + m.x - pages.offsetLeft, cy = scroll.scrollTop + m.y - pages.offsetTop;
      pages.dataset.zoom = String(zoom);
      pages.style.width = `${zoom * 100}%`;
      scroll.scrollLeft = cx * k + pages.offsetLeft - m.x;
      scroll.scrollTop = cy * k + pages.offsetTop - m.y;
    }, { passive: false });
    scroll.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });
    scroll.addEventListener("gesturestart", (e) => e.preventDefault());   // older iPhones: no page-wide zoom either
  })();
  $("stmt-inbox-toggle").addEventListener("click", () => { inboxOpen = $("stmt-inbox-body").hidden; setInboxOpen(inboxOpen); });
  $("statement-inbox-list").addEventListener("click", async (e) => {
    const open = e.target.closest(".stmt-inbox-open"), dis = e.target.closest(".stmt-inbox-dismiss"), all = e.target.closest(".stmt-inbox-open-all");
    if (e.target.closest(".stmt-inbox-earlier-toggle")) { inboxEarlierOpen = !inboxEarlierOpen; renderInbox(); return; }
    const see = e.target.closest(".stmt-inbox-see");
    if (all) openAllInboxItems(all);
    else if (see) seeInboxItem(see.dataset.id, see);
    else if (open) openInboxItem(open.dataset.id, open);
    else if (dis && await askConfirmApp_(tr("stmt.confirmDismiss"), tr("confirmBtn.yes"), { plain: true })) {
      // Right after OK: the row's buttons give way to a "Removing…" line (the server call takes a moment; a second tap must not be possible).
      const buttons = dis.closest(".stmt-choices");
      if (buttons) buttons.innerHTML = loadingHtml(tr("stmt.removing"));
      try { await callApi("dismissStatement", { id: dis.dataset.id }); } catch (err) { showAppMessage_(tr("stmt.dismissFailed", { error: err.message })); }
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
    const done = e.target.closest(".stmt-complete-acct");
    if (done) completeAccount(done.dataset.id);
    const bal = e.target.closest(".stmt-start-bal");
    if (bal) (async () => {
      const id = bal.dataset.id;
      if (!((meta && meta.paymentMethods) || []).some((p) => p.id === id) && typeof loadMeta === "function") await loadMeta().catch(() => {});
      openStartBalanceFor_(id);
    })();
  });
  $("statement-added-close").addEventListener("click", closeAdded);
  // "Go to Needs review": the card at the top of the Entries tab, where pending entries are finished.
  document.addEventListener("click", (e) => {
    if (!(e.target.closest && e.target.closest(".stmt-goreview-btn"))) return;
    closeAdded();
    const tab = document.querySelector('.nav-btn[data-screen="entries"]');
    if (tab) tab.click();
    setTimeout(showReviewQueue_, 400);
  });
  // "Tidy my history" in the saved message opens the same screen as More → Tidy my history.
  // (it used to press "more-tidy-btn", which no longer exists since Tidy moved into My data: the button did nothing)
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".stmt-tidy-btn")) { markTidyFromUpload_(); showTidyScreen(); } });
  // The same button sits in Recent uploads and in the "saved" message after a save.
  document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest(".stmt-added-btn"); if (b) openAdded(b.dataset.batch); });
  $("statement-batches").addEventListener("click", (e) => { const b = e.target.closest(".stmt-undo-row"); if (b) undoBatch(b.dataset.batch, b); });
  $("statement-password-ok").addEventListener("click", () => closeStatementPassword($("statement-password-input").value));
  $("statement-password-cancel").addEventListener("click", () => closeStatementPassword(null));
  $("statement-password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeStatementPassword($("statement-password-input").value);
  });
  // ---- First-use practice: Import from another app (owner's design, 2026-11-03) ----
  // Offered on More → My data → Import from another app. The app builds a small made-up CSV in code (StatementTable.practiceFile: three purchases
  // with a category) and hands it to the REAL file handler, so the person walks the real screens: the file is read, the columns and categories
  // are checked, the preview, "Add to my history", and the real Undo. The entries are saved with no account (Import never needs one), so there is
  // no account to make or delete. Only the steps' own buttons are tappable ("Use these lines", Next, Add to my history, Undo), so the person
  // cannot change the account or the categories and touch anything real. Nothing is created by a special call: the import itself saves, the
  // real Undo removes it (entries and the category it created), and one cleanup call (removePracticeImport) forgets the made-up file's
  // remembered layout and finishes an import left half-way (Exit, or the app closed): in the background, also on Exit and — asked first — the
  // next time the app opens. See backend/PracticeImport.gs.
  // The BANK STATEMENTS practice (2026-11-04) runs on the same machinery with kind "bank": a bank statement is about one account, so it first adds an
  // empty "Practice account" (createPracticeBankAccount; the real matchers skip it, isPracticeAccount_), picks it for the file by itself, and its
  // cleanup (removePracticeBank) also deletes that account if the practice made it. See backend/PracticeBank.gs.
  const PRACTICE_I_KEY_ = "tipPracticeImport";
  let practiceI_ = null;          // { kind: "import" | "bank", touched, saved, undone, batchId, signature, accountId, accountMade, startedOn }
  let practiceIRemoving_ = false;
  let practiceILeftoverAsked_ = false;

  function practiceILoad_() { try { return JSON.parse(localStorage.getItem(PRACTICE_I_KEY_) || "null"); } catch (e) { return null; } }
  function practiceISave_() {
    try { if (practiceI_) localStorage.setItem(PRACTICE_I_KEY_, JSON.stringify(practiceI_)); else localStorage.removeItem(PRACTICE_I_KEY_); } catch (e) { /* ignore */ }
  }
  // Is every file of this run the practice's own? Only while a practice runs (a real import is always asked about).
  function practiceIOwns_(names) {
    return !!practiceI_ && Spotlight.isRunning() && names.length > 0 && names.every((n) => StatementTable.PRACTICE_FILE_NAMES.includes(String(n || "")));
  }
  function practiceIOwnsBatch_(batchId) { return !!practiceI_ && Spotlight.isRunning() && !!batchId && practiceI_.batchId === batchId; }
  // What the real screens report back to the practice.
  function practiceINote_(what, batchId) {
    if (!practiceI_) return;
    if (what === "used") practiceI_.touched = true;
    else if (what === "saved") { practiceI_.touched = true; practiceI_.saved = true; practiceI_.batchId = batchId || ""; }
    else if (what === "undone" && practiceI_.batchId === batchId) practiceI_.undone = true;
    else return;
    practiceISave_();
  }

  function offerImportTip_() {
    const caps = (typeof meta !== "undefined" && meta && meta.capabilities) || {};
    if (!caps.practiceImport || screenMode !== "import") return;   // an older backend could not clean the practice up
    offerTip_("import", "import-tip-invite", tr("spot.f.invite"), startImportPractice_);
  }

  // What both kinds of practice use to find the real parts of the screens and to wait for the server.
  function practiceTools_() {
    const root = () => document.querySelector("#statement-results .tm-root");
    const part = (sel) => () => { const r = root(); return r ? r.querySelector(sel) : null; };
    const top = () => { const r = root(); return r && r.querySelector(".tm-preview") ? [r.querySelector(".stmt-note"), r.querySelector(".tm-single")].filter(Boolean) : null; };   // (the layout note and the account list; the lines below are the next step)
    const waitFor = async (cond, ms) => { for (let i = 0; i < ms / 400 && !cond(); i++) await sleep(400); return cond(); };
    const failed = (key) => { showAppMessage_(tr(key)); Spotlight.stop("skipped"); return false; };
    const preview = () => ($("statement-history-save") ? Array.from($("statement-history").children).filter((c) => c.id !== "statement-history-save") : null);   // (not its button: the next step taps that)
    return { root, part, top, waitFor, failed, preview };
  }

  function practiceISteps_() {
    const { part, top, waitFor, failed, preview } = practiceTools_();
    // The file's "Practice rides" matches none of the person's categories: its row is opened and the person sends it into one (owner, 2026-11-05).
    const rideRow = () => {
      const box = part(".tm-cats")();
      const row = box && Array.from(box.querySelectorAll(".tm-cat-row")).find((r) => /^(Practice rides|Paseos de práctica)/i.test((r.querySelector("strong") || {}).textContent || ""));
      if (!row) return null;
      const details = row.closest("details");
      if (details && !details.open) details.open = true;
      row.querySelectorAll('option[value^="ren:"]').forEach((o) => o.remove());   // (renaming a real category is never part of the practice)
      return row;
    };
    const rideSelect = () => { const r = rideRow(); return r ? r.querySelector(".tm-cchoice") : null; };
    // Which category the text names. First that works: Transport, a transport-like category, Other, the first one. Only categories the list
    // offers (visible ones): a hidden or deleted Transport is never brought back. named: the text can say "pick X" rather than "for example X".
    const rideInto = () => {
      const sel = rideSelect();
      if (!sel) return null;
      const ids = Array.from(sel.querySelectorAll("optgroup option")).map((o) => o.value);
      const mine = ((typeof meta !== "undefined" && meta && meta.categories) || []).filter((c) => ids.includes(String(c.id)));
      const first = (re) => mine.find((c) => re.test(String(c.name || "").trim()));
      const named = first(/^(transport|transporte)$/i) || first(/\b(taxis?|uber|cabify|movilidad|bus|buses|cars?|autos?|carros?|coches?|gasolina|combustible|fuel|moto|motos|motorbike)\b/i);
      if (named) return { name: named.name, named: true };
      const other = first(/^(other|others|otro|otros)$/i) || mine.find((c) => ids[0] === String(c.id));
      return other ? { name: other.name, named: false } : null;
    };
    return [
      { key: "intro", text: () => tr("spot.f.intro"), button: () => tr("spot.f.start") },
      { look: true, target: ".stmt-upload-btn", text: () => tr("spot.f.s1"), button: () => tr("spot.f.useFile"),
        after: () => { practiceIFeed_(); } },
      { look: true, target: top, text: () => tr("spot.f.s2"), button: () => tr("spot.f.gotIt"), wait: 20000 },
      { look: true, target: part(".tm-preview"), text: () => tr("spot.f.s3"), button: () => tr("spot.f.gotIt") },
      { target: rideRow, text: () => { const t = rideInto(); return tr(t && t.named ? "spot.f.s4" : "spot.f.s4other", { category: t ? t.name : "" }); },
        until: () => { const sel = rideSelect(); return !!sel && !!sel.value && !["create", "custom", "skip"].includes(sel.value); }, wait: 20000,
        before: async () => {
          if (!(await waitFor(() => !!rideRow(), 20000))) return true;   // (the step's own wait then says "One moment…" and stops the practice if it never comes)
          const sel = rideSelect();
          if (sel.value !== "create") { sel.value = "create"; sel.dispatchEvent(new Event("change", { bubbles: true })); }   // it always starts on "create" (owner)
          return !!rideInto();   // no category of the person's own to send it into: it stays "create", no step
        } },
      { target: part(".tm-use"), text: () => tr("spot.f.s5"), tap: "#statement-results .tm-use" },
      { target: "#stmt-next-2", text: () => tr("spot.f.s6"), tap: "#stmt-next-2", wait: 20000 },
      { look: true, target: preview, text: () => tr("spot.f.s7"), button: () => tr("spot.f.gotIt"), wait: 45000 },
      { target: "#statement-history-save", text: () => tr("spot.f.s8"), tap: "#statement-history-save" },
      { look: true, target: "#statement-review-status", text: () => tr("spot.f.s9"), button: () => tr("spot.f.gotIt"), wait: 20000,
        before: async () => (await waitFor(() => !!(practiceI_ && practiceI_.saved), 90000)) ? true : failed("spot.f.saveFailed") },
      { target: "#stmt-undo-btn", text: () => tr("spot.f.s10"), tap: "#stmt-undo-btn", wait: 15000 },
      { look: true, target: "#statement-review-status", text: () => tr("spot.f.s11"), button: () => tr("spot.f.finish"), wait: 20000,
        before: async () => (await waitFor(() => !!(practiceI_ && practiceI_.undone), 90000)) ? true : failed("spot.f.undoFailed") }
    ];
  }


  // The Bank statements practice: the same real screens, on a made-up bank statement of ONE account (the empty Practice account, picked for the file by
  // the practice itself so the person can never pick a real account here). No categories: a bank's purchases come in without one (Tidy my history).
  function practiceBSteps_() {
    const { part, top, waitFor, failed, preview } = practiceTools_();
    return [
      { key: "intro", text: () => tr("spot.s.intro"), button: () => tr("spot.s.start") },
      { look: true, target: "#stmt-upload-card", text: () => tr("spot.s.s1"), button: () => tr("spot.s.useFile"),
        before: async () => {
          // A long Inbox opens by itself and pushed the card's heading off the screen (owner's walk, 2026-11-05): closed for the practice, so the three ways fit.
          inboxOpen = false; setInboxOpen(false);
          window.scrollTo(0, 0);
          return (await practiceBMake_()) ? true : false;
        },
        after: () => { practiceIFeed_(); } },
      { look: true, target: top, text: () => tr("spot.s.s3"), button: () => tr("spot.s.gotIt"), wait: 20000,
        before: async () => {   // the account list: the practice picks its own account, like the person would
          if (!(await waitFor(() => !!part(".tm-account")(), 20000))) return failed("spot.s.fileFailed2");
          const sel = part(".tm-account")();
          sel.value = practiceI_.accountId;
          if (sel.value !== practiceI_.accountId) return failed("spot.s.accountFailed");
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        } },
      { look: true, target: part(".tm-preview"), text: () => tr("spot.s.s4"), button: () => tr("spot.s.gotIt") },
      { target: part(".tm-use"), text: () => tr("spot.s.s5"), tap: "#statement-results .tm-use" },
      { target: "#stmt-next-2", text: () => tr("spot.s.s6"), tap: "#stmt-next-2", wait: 20000 },
      { look: true, target: preview, text: () => tr("spot.s.s7"), button: () => tr("spot.s.gotIt"), wait: 45000 },
      { target: "#statement-history-save", text: () => tr("spot.s.s8"), tap: "#statement-history-save" },
      { look: true, target: "#statement-review-status", text: () => tr("spot.s.s9"), button: () => tr("spot.s.gotIt"), wait: 20000,
        before: async () => (await waitFor(() => !!(practiceI_ && practiceI_.saved), 90000)) ? true : failed("spot.s.saveFailed") },
      { target: "#stmt-undo-btn", text: () => tr("spot.s.s10"), tap: "#stmt-undo-btn", wait: 15000 },
      { look: true, target: "#statement-review-status", text: () => tr("spot.s.s11"), button: () => tr("spot.s.finish"), wait: 20000,
        before: async () => (await waitFor(() => !!(practiceI_ && practiceI_.undone), 90000)) ? true : failed("spot.s.undoFailed") }
    ];
  }

  // Adds the empty Practice account (refuses to touch one that already exists) and refreshes the phone's lists so the file can be read for it.
  async function practiceBMake_() {
    practiceI_.accountMade = true;   // (marked BEFORE the call: if the app is closed in the middle, the cleanup removes the account)
    practiceISave_();
    try {
      const res = await callApi("createPracticeBankAccount", { lang: I18n.getLang() });
      if (res.existed) { practiceI_.accountMade = false; practiceISave_(); showAppMessage_(tr("spot.s.accountExists")); Spotlight.stop("skipped"); return false; }
      practiceI_.accountId = String(res.id);
      practiceISave_();
      if (typeof loadMeta === "function") await loadMeta();
      return true;
    } catch (err) {
      // The answer never came back: the account may or may not exist. It is marked as ours only if one is really there now (a same-named one
      // was ruled out before the start), so the cleanup never goes looking for an account that was not made.
      try { if (typeof loadMeta === "function") await loadMeta(); } catch (e) { /* keep what we know */ }
      const there = ((typeof meta !== "undefined" && meta && meta.paymentMethods) || []).some((pm) => /^(Practice account|Cuenta de práctica)$/i.test(String(pm.nickname || "").trim()));
      if (!there) { practiceI_.accountMade = false; practiceISave_(); }
      showAppMessage_(tr("spot.s.createFailed", { error: err.message || String(err) }));
      Spotlight.stop("skipped");
      return false;
    }
  }

  let batchesHeld = {};   // how many past uploads each side of the screen has (from its list): someone who already uses it gets no tutorial

  function offerBankTip_() {
    const caps = (typeof meta !== "undefined" && meta && meta.capabilities) || {};
    if (!caps.practiceBank || screenMode !== "bank") return;   // an older backend could not make or clean up the practice account
    offerTip_("bank", "bank-tip-invite", tr("spot.s.invite"), startBankPractice_);
  }

  // ---- Real tutorials on the person's own file (owner's plan, step 5) ----
  // Only one of these and the practice is ever done with a person. It starts when a file is chosen (Start / Exit, up to 3 chances, one a day), or from the
  // bubble after 20 idle seconds on the first step. Nothing is saved until the person taps Add, and what they add stays. Every reading is judged by what really happened:
  // a table asks about its columns, a PDF shows its verdict, a file that cannot be used says so and ends.
  const realStmtFeature_ = (mode) => (mode === "import" ? "import" : "bank");
  function realStmtWanted_(mode) {
    const f = realStmtFeature_(mode);
    if (typeof meta === "undefined" || !meta || perfIsOwnerCopy_() || Spotlight.isRunning() || isTaught_(f)) return false;
    if (!realAgain_() && batchesHeld[mode] > 0) { markTaught_(f, "used"); return false; }
    return true;
  }
  function realStmtFileChosen_() {
    const mode = screenMode;
    if (!realStmtWanted_(mode) || !realChanceLeft_(realStmtFeature_(mode), true)) return;
    setTimeout(() => { if (!Spotlight.isRunning() && stmtCards().length) startStmtReal_(mode, false); }, 0);
  }
  function watchStmtIdle_() {
    const mode = screenMode;
    if (!realStmtWanted_(mode)) return;
    idleOffer_({
      key: realStmtFeature_(mode),
      wanted: () => screenMode === mode && !$("screen-statements").hidden && stepNow === 1 && !pastOpen && !stmtCards().length && !isTaught_(realStmtFeature_(mode)),
      target: () => [document.querySelector(".stmt-upload-btn"), $("stmt-stepper")].find((e) => popInView_(e)) || null,
      start: () => startStmtReal_(mode, true)
    });
  }
  function realStmtSteps_(mode, fromStart) {
    const imp = mode === "import";
    const { root, part, waitFor } = practiceTools_();
    const realNext = () => tr("spot.g.next"), done = () => tr("spot.g.done");
    const reading = () => stmtCards().some((c) => { const b = c.querySelector(".stmt-result-body"); return !!b && !!b.firstElementChild && b.firstElementChild.classList.contains("stmt-loading"); });
    const readDone = () => stmtCards().length > 0 && !reading();
    const mapper = () => !!part(".tm-use")();
    const useOff = () => { const b = part(".tm-use")(); return !!b && b.disabled; };
    const whyText = () => { const n = part(".tm-use-why .stmt-note")(); return n ? n.textContent : ""; };
    // The first thing to fix, opened and shown: the date question, a new account's box, a group's missing account, a name to match…
    let fixKind = "";
    const FIX_TEXT = { date: "rt.stmt.fixDate", name: "rt.stmt.fixName", last4: "imp.newAcctLast4Bad", bank: "imp.newAcctPlinBank", account: "rt.stmt.fixAccount", move: "rt.stmt.fixMove", cat: "rt.stmt.fixCat" };
    const fixTarget = () => {
      const r = root();
      fixKind = "";
      if (!r) return null;
      const open = (el) => { const d = el && el.closest("details"); if (d && !d.open) d.open = true; return el; };
      const dates = Array.from(r.querySelectorAll(".tm-dord"));
      if (dates.length) { fixKind = "date"; return dates; }
      const taken = new Set(((meta && meta.paymentMethods) || []).map((a) => String(a.nickname || "").trim().toLowerCase()));
      for (const box of r.querySelectorAll(".tm-newacct")) {
        const name = box.querySelector(".tm-nname"), l4 = box.querySelector(".tm-nlast4"), bank = box.querySelector(":scope > .tm-nbank");
        if (name && (!name.value.trim() || taken.has(name.value.trim().toLowerCase()))) { fixKind = "name"; return name; }
        if (l4 && l4.value.trim() && !/^\d{4}$/.test(l4.value.trim())) { fixKind = "last4"; return open(l4); }
        if (bank && !bank.value) { fixKind = "bank"; return bank; }
      }
      const vacct = Array.from(r.querySelectorAll(".tm-multi:not([hidden]) .tm-vacct")).find((x) => !x.value);
      if (vacct && !imp) { fixKind = "account"; return vacct; }
      const acct = r.querySelector(".tm-single:not([hidden]) .tm-account");
      if (acct && !acct.value && !imp) { fixKind = "account"; return acct; }
      const move = Array.from(r.querySelectorAll(".tm-dpm")).find((x) => !x.value);
      if (move) { fixKind = "move"; return open(move.closest(".tm-cat-row")); }
      const cat = r.querySelector(".tm-cat");
      if (imp && cat && cat.value === "-1") { fixKind = "cat"; return open(cat); }
      return [part(".tm-use-why")(), part(".tm-use")()].filter(Boolean);
    };
    // A file not used yet: light up WHY (owner, 2026-11-21: "the reason is here" lit the whole card and the reason was not in it).
    const resultTarget = () => {
      if (usable.length) return $("statement-results");
      if (useOff()) return [part(".tm-use-why")(), part(".tm-use")()].filter(Boolean);
      const notes = Array.from($("statement-results").querySelectorAll(".stmt-verdict.bad, .stmt-verdict.warn, .stmt-note.warn")).slice(0, 3);
      return notes.length ? notes : $("statement-results");
    };
    const columns = () => part(".tm-sec-cols")();   // the whole "Which column is which" section, from its title (owner, 2026-11-21)
    const planSettled = () => !!historyPlan || !$("statement-history").querySelector(".stmt-loading");
    const previewParts = () => { const k = Array.from($("statement-history").children).filter((c) => c.id !== "statement-history-save"); return k.length ? k : $("statement-review-card"); };
    const canSave = () => !!$("statement-history-save");
    const planError = () => !!$("statement-plan-status").querySelector(".stmt-verdict.bad");
    const pre = imp ? "rt.imp." : "rt.stmt.";
    const tidyBtn = () => $("statement-review-status").querySelector(".stmt-tidy-btn");
    const pendingBtn = () => $("statement-review-status").querySelector(".stmt-goreview-btn");
    const steps = [];
    // Accounts the file names that the app does not have (2026-11-21): said on the account step, in one more sentence.
    const newAcctTip = () => {
      const r = root();
      if (!r || !(((typeof meta !== "undefined" && meta && meta.capabilities) || {}).importNewAccounts)) return "";
      if (r.querySelector(".tm-multi:not([hidden]) .tm-newcard .stmt-note")) return " " + tr("rt.imp.newAccts");
      return r.querySelector(".tm-single:not([hidden])") ? " " + tr("rt.imp.newAcctPick") : "";
    };
    const findShown = () => !$("statement-find-card").hidden;
    if (fromStart) steps.push({ key: "choose", target: imp ? ".stmt-upload-btn" : "#stmt-upload-card", text: () => tr(!imp && findShown() ? "rt.stmt.choose3" : pre + "choose"), until: () => stmtCards().length > 0,
      before: async () => { window.scrollTo(0, 0); return true; } });
    steps.push(
      { key: "reading", target: "#statement-results", text: () => tr("rt.stmt.reading"), until: readDone, wait: 8000, before: async () => !readDone() },
      { key: "columns", target: columns, text: () => tr("rt.stmt.columns"), button: realNext, before: async () => mapper() },
      { key: "account", target: part(".tm-sec-accts"), text: () => tr(pre === "rt.imp." ? "rt.imp.account" : "rt.stmt.account") + newAcctTip(), button: realNext, before: async () => mapper() },
      { key: "cats", target: part(".tm-cats"), text: () => tr("rt.imp.cats"), button: realNext,
        before: async () => { if (!mapper()) return false; await waitFor(() => { const b = part(".tm-cats")(); return !!b && !b.querySelector(".stmt-loading"); }, 15000); return !!part(".tm-cat-row")(); } },
      // Something missing: say so, then "Take me there" lights up each thing to fix in turn, and the walkthrough goes on once the button
      // can be tapped (owner, 2026-11-21: lighting only the message left the person stuck).
      { key: "why", target: () => [part(".tm-use-why")(), part(".tm-use")()].filter(Boolean), text: () => tr("rt.stmt.useWhy"), button: () => tr("rt.stmt.takeMe"), before: async () => mapper() && useOff() },
      { key: "fix", target: fixTarget, text: () => (FIX_TEXT[fixKind] ? tr(FIX_TEXT[fixKind]) : tr("rt.stmt.fixHere", { why: whyText() })), until: () => !mapper() || !useOff(), before: async () => mapper() && useOff() },
      { key: "use", target: () => (useOff() ? [part(".tm-use-why")(), part(".tm-use")()].filter(Boolean) : part(".tm-use")()), text: () => tr(useOff() ? "rt.stmt.useWhy" : "rt.stmt.use"), until: () => !mapper() && readDone(), before: async () => mapper() },
      { key: "result", target: resultTarget, button: realNext,
        text: () => (usable.length ? tr(readyCount() < stmtCards().length ? "rt.stmt.resultMixed" : "rt.stmt.result") + ($("statement-results").querySelector(".stmt-note.warn") ? " " + tr("rt.stmt.notes") : "") : tr(mapper() ? "rt.stmt.useWhy" : "rt.stmt.bad")), before: async () => { await waitFor(readDone, 3000); return true; } },
      { key: "next", target: "#stmt-next-2", text: () => tr("rt.stmt.next"), tap: "#stmt-next-2", before: async () => usable.length > 0 },
      { key: "planning", target: "#statement-review-card", text: () => tr("rt.stmt.planning"), until: planSettled, before: async () => usable.length > 0 && !planSettled() },
      // Tapping the box's own "Add the account and continue" re-reads the statements and the box goes away: that ends this step too
      // (journeys run, 2026-11-17: Lucía's tutorial waited on "One moment…" for a box that would never come back; only Exit freed it).
      { target: () => $("statement-history").querySelector(".stmt-new-accounts"), text: () => tr("rt.stmt.newAccounts"), button: realNext,
        until: () => addedAccounts.length > 0 && !$("statement-history").querySelector(".stmt-new-accounts"),
        before: async () => usable.length > 0 && !!$("statement-history").querySelector(".stmt-new-accounts") },
      { key: "preview", target: previewParts, button: realNext, before: async () => usable.length > 0,
        text: () => tr(canSave() ? "rt.stmt.preview" : "rt.stmt.previewNone") + (canSave() && $("statement-history").querySelector("details.stmt-group, .stmt-choices button:not(#statement-history-save)") ? " " + tr("rt.stmt.questions") : "") },
      { key: "save", target: () => [$("statement-history-save"), planError() ? $("statement-plan-status") : null].filter(Boolean), text: () => tr(planError() ? "rt.stmt.saveErr" : "rt.stmt.save"), until: () => savedThisRun, before: async () => usable.length > 0 && canSave() },
      // The end, in ONE step (two raced each other, owner 2026-11-21): what was saved, and — purchases with no category — the way into Tidy
      // my history, on these very purchases (owner, 2026-11-09). Its buttons can be tapped; any other one ends the walkthrough
      // (startStmtReal_), so it never waits for a screen the person left.
      { keep: true, target: () => [$("statement-review-status"), tidyBtn()].filter(Boolean), wait: 30000, waitText: () => tr("rt.saving"),
        text: () => (tidyBtn() ? tidyDoneText_(imp, tidyBtn()) : tr(imp ? "rt.imp.done" : "rt.stmt.done")) + (pendingBtn() ? " " + tr("rt.stmt.pending") : ""), button: done,
        until: () => !$("screen-tidy").hidden, before: async () => savedThisRun },
      { keep: true, text: () => tr(usable.length ? "rt.stmt.endNone" : "rt.stmt.endBad"), button: done, before: async () => !savedThisRun }
    );
    return steps;
  }
  function startStmtReal_(mode, fromStart) {
    if (Spotlight.isRunning()) return;
    const f = realStmtFeature_(mode);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    let started = false;
    guided_ = { savedId: "", split: null };
    const intro = { key: "intro", text: () => tr(mode === "import" ? "rt.imp.intro" : "rt.stmt.intro"), button: () => tr("spot.g.start"), after: () => { started = true; markTaught_(f, "real"); } };
    // Never left waiting (owner, 2026-11-21: "Review them in Accounts" led away and the next step said "One moment…" for good):
    // leaving the screen at any step ends the walkthrough (Tidy my history, its own last step, excepted); on the last card, every
    // button that leads elsewhere ends it too; Undo ends it without counting it as taught, so it is offered again.
    const batchNow = () => (typeof lastBatchId === "undefined" ? null : lastBatchId);   // (set by the save; never declared before it)
    const batchAtStart = batchNow();
    const watch = setInterval(() => {
      if (!Spotlight.isRunning()) return;
      if ($("screen-statements").hidden && $("screen-tidy").hidden) Spotlight.stop(batchNow() !== batchAtStart ? "done" : "skipped");
    }, 400);
    const onStatusTap = (e) => {
      if (!Spotlight.isRunning() || e.target.closest(".stmt-tidy-btn")) return;
      if (e.target.closest("#stmt-undo-btn")) { delete taughtPending_[f]; setTimeout(() => Spotlight.stop("skipped"), 0); return; }
      if (e.target.closest("button")) setTimeout(() => Spotlight.stop("done"), 0);
    };
    $("statement-review-status").addEventListener("click", onStatusTap, true);
    Spotlight.run(realSteps_([intro].concat(realStmtSteps_(mode, fromStart))), {
      labels: realLabels_(), busy: () => perfInflight_ > 0,
      onFinish: async (how) => {
        clearInterval(watch);
        $("statement-review-status").removeEventListener("click", onStatusTap, true);
        guided_ = null; if (!started) spendRealChance_(f); if (how === "lost") setTimeout(() => showAppMessage_(tr("spot.g.lost")), 0);
      }
    });
  }
  // The practice brought from the two-week nudge on Home.
  window.statementsNudgePractice_ = function (kind) {
    const caps = (typeof meta !== "undefined" && meta && meta.capabilities) || {};
    if (!caps[kind === "bank" ? "practiceBank" : "practiceImport"]) return false;
    showStatementsScreen(kind);
    return startStatementsPractice_(kind);
  };

  // Builds the made-up file and hands it to the real file handler. The file's layout key is stored FIRST, so a closed app can still forget it.
  async function practiceIFeed_() {
    try {
      const f = StatementTable.practiceFile(I18n.getLang(), todayLocalISO(), practiceI_.kind === "bank" ? "bank" : "import");
      try {
        const rows = await StatementTable.readTable(new TextEncoder().encode(f.text), f.name);
        practiceI_.signature = StatementTable.signature(StatementTable.guessMapping(rows, {}), rows);
        practiceISave_();
      } catch (e) { /* no key: the cleanup just has no layout to forget */ }
      await handleStatementFiles([new File([f.text], f.name, { type: "text/csv" })]);
    } catch (err) {
      showAppMessage_(tr(practiceI_ && practiceI_.kind === "bank" ? "spot.s.fileFailed" : "spot.f.fileFailed", { error: err.message || String(err) }));
      Spotlight.stop("skipped");
    }
  }

  function startImportPractice_() { return startStatementsPractice_("import"); }
  function startBankPractice_() { return startStatementsPractice_("bank"); }

  function startStatementsPractice_(kind) {
    const k = kind === "bank" ? "s" : "f";   // (the text prefix of each: spot.f.* Import, spot.s.* Bank statements)
    if (practiceIRemoving_) { showToast_(tr(`spot.${k}.stillRemoving`)); return false; }
    const open = ["exchange-modal-backdrop", "edit-entry-modal-backdrop", "drilldown-modal-backdrop", "currency-modal-backdrop", "statement-added-backdrop"].some((id) => { const e = document.getElementById(id); return e && !e.hidden; });
    if (open || newEntrySheetOpen_) { showToast_(tr("spot.x.busy")); return false; }
    if (usable.length || stmtCards().length || historyPlan || savedThisRun) { showToast_(tr(`spot.${k}.busyRun`)); return false; }   // the person's own import is in progress
    if (kind === "bank" && ((meta && meta.paymentMethods) || []).some((pm) => isPracticeAccountName_(pm.nickname))) { showToast_(tr("spot.s.accountExists")); return false; }   // an account with that name is already there: never touch it
    practiceI_ = { kind: kind === "bank" ? "bank" : "import", touched: false, saved: false, undone: false, batchId: "", signature: "", accountId: "", accountMade: false, startedOn: todayLocalISO() };
    practiceISave_();
    stepNow = 1; renderSteps();
    window.scrollTo(0, 0);
    runTip_(kind === "bank" ? practiceBSteps_() : practiceISteps_(), async () => {
      clearRun();   // the practice file leaves the screen
      stepNow = 1; renderSteps();
      if (kind === "bank") { inboxOpen = null; renderInbox(); }   // the Inbox decides again from what is in it
      showToast_(tr(`spot.${k}.removing`));
      practiceIRemove_().then((ok) => { if (ok) showToast_(tr(`spot.${k}.removed`)); });
    }, tr(`spot.${k}.note`));
    return true;
  }

  async function practiceIRemove_() {
    if (practiceIRemoving_) return false;
    const p = practiceI_ || practiceILoad_();
    if (!p) return true;
    practiceIRemoving_ = true;
    try {
      let ok = true;
      const bank = p.kind === "bank";
      if (p.touched || (bank && p.accountMade)) {   // (nothing was remembered, saved or made before "Use these lines" / the account: nothing to remove)
        for (let i = 0; i < 40 && perfInflight_ > 0; i++) await sleep(400);   // a save / undo still on its way lands first
        try {
          if (bank) await callApi("removePracticeBank", { signature: p.signature || "", account: !!p.accountMade });
          else await callApi("removePracticeImport", { signature: p.signature || "" });
          if (bank && p.accountMade && typeof loadMeta === "function") await loadMeta();   // the Practice account leaves every list
        } catch (err) { ok = false; practiceCleanupFailed_(bank ? "s" : "f", err); }
      }
      if (ok) { practiceI_ = null; practiceISave_(); }
      coverage = null;
      refreshStatementBatches();
      refreshOtherScreens();
      return ok;
    } finally { practiceIRemoving_ = false; }
  }

  // A cleanup that lost the connection, retried by itself (practiceRetryDue_ in app.js).
  window.statementsPracticeRetry_ = function () {
    const k = (practiceILoad_() || {}).kind === "bank" ? "s" : "f";
    return practiceIRemove_().then((ok) => { if (ok) showToast_(tr(`spot.${k}.removed`)); return ok; });
  };

  // A practice left behind (the app was closed midway): offered once when the app opens.
  window.statementsPracticeLeftover_ = async function () {
    if (practiceDue_("s") || practiceDue_("f")) return;
    const left = practiceILoad_() || {};
    if (practiceILeftoverAsked_ || practiceIRemoving_ || Spotlight.isRunning() || !(left.touched || (left.kind === "bank" && left.accountMade))) return;
    practiceILeftoverAsked_ = true;
    const k = left.kind === "bank" ? "s" : "f";
    if (await askConfirmApp_(tr(`spot.${k}.leftover`), tr("confirmBtn.yes"), { plain: true })) practiceIRemove_().then((ok) => { if (ok) showToast_(tr(`spot.${k}.removed`)); });
  };
})();
