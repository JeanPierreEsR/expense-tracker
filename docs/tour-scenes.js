// Small animated "mini app" scenes for the welcome tour (and More → How to use the app).
//
// One tiny engine plays any number of scenes. A scene is just data:
//   build(stage, ctx)    -> draws the mini screen and returns handles to its parts
//   timeline(parts, ctx) -> [[milliseconds, fn(instant)], …]; fn does one thing (move the finger, type, fill a bar…)
//   hold                 -> pause before the scene loops
// The mini screens reuse the app's own colours (CSS variables) and its words (tr), so they follow dark mode and the
// language by themselves. Tap a scene to replay it. With "reduce motion" on, only the final picture is shown.
// ctx = { tr, home, money }  (the tour passes the app's own helpers; nothing here reads app state).
(function (root) {
  "use strict";

  const SCENES = {};
  let timers = [];

  function stop() { timers.forEach(clearTimeout); timers = []; }

  function h(tag, cls, text, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  // The finger: glides to the middle of any element and "taps" with a ring.
  function makeFinger(stage) {
    const f = h("div", "ts-finger", null, stage);
    h("div", "ts-finger-dot", null, f);
    return {
      el: f,
      to(target, instant) {
        const s = stage.getBoundingClientRect(), t = target.getBoundingClientRect();
        f.style.transition = instant ? "none" : "";
        f.style.transform = `translate(${Math.round(t.left - s.left + t.width / 2 - 12)}px, ${Math.round(t.top - s.top + t.height / 2 - 12)}px)`;
        f.style.opacity = "1";
      },
      tap(instant) {
        if (instant) return;
        f.classList.remove("ts-tap");
        void f.offsetWidth;
        f.classList.add("ts-tap");
      },
      hide() { f.style.opacity = "0"; }
    };
  }

  // A step-by-step scene (scene.manual): step 1 plays by itself, then the person taps "Next step" at their own pace.
  // scene.steps[i](parts, ctx, instant, later) runs one step and returns how long it animates (the button waits for it).
  function playManual(scene, key, stage, ctx, reduce) {
    stage.hidden = false; stage.innerHTML = ""; stage.onclick = null;
    const parts = scene.build(stage, ctx);
    const total = scene.steps.length;
    const bar = h("div", "ts-stepper", null, stage);
    const btn = h("button", "ts-step-btn", null, bar);
    btn.type = "button";
    let i = 0;
    const refresh = () => { btn.textContent = ctx.tr(i < total ? "tour.nextStep" : "tour.replay"); };
    const go = (instant) => {
      if (i >= total) { play(key, stage, ctx); return; }
      const later = (fn, ms) => { if (instant) fn(); else timers.push(setTimeout(fn, ms)); };
      const ms = scene.steps[i](parts, ctx, instant, later) || 0;
      i++;
      if (instant) { refresh(); return; }
      btn.disabled = true;
      // keep the new explanation and the button in view (the page grows as explanations are added)
      timers.push(setTimeout(() => { btn.disabled = false; refresh(); if (bar.scrollIntoView) bar.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, ms));
    };
    btn.onclick = () => go(false);
    // Tapping the animation itself also goes to the next step (not while a step is still playing, and not to replay at the end).
    stage.onclick = () => { if (!btn.disabled && i < total) go(false); };
    refresh();
    if (reduce) { for (let k = 0; k < total; k++) go(true); }
    else { btn.disabled = true; timers.push(setTimeout(() => go(false), 400)); }
  }

  function play(key, stage, ctx) {
    stop();
    const scene = SCENES[key];
    if (!scene) { stage.hidden = true; stage.innerHTML = ""; return false; }
    stage.hidden = false;
    const reduce = !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (scene.manual) { playManual(scene, key, stage, ctx, reduce); return true; }
    const run = () => {
      stage.innerHTML = "";
      const parts = scene.build(stage, ctx);
      const steps = scene.timeline(parts, ctx);
      if (reduce) { steps.forEach((s) => s[1](true)); return; }
      let end = 0;
      steps.forEach((s) => { end = Math.max(end, s[0]); timers.push(setTimeout(() => s[1](false), s[0])); });
      timers.push(setTimeout(run, end + (scene.hold || 1500)));
    };
    run();
    stage.onclick = () => play(key, stage, ctx);   // tap to replay
    return true;
  }

  // ------------------------------------------------------------------
  // RULE: a scene may only show things the app really does and says (its own screens, labels and numbers). No invented
  // banners, badges or messages. When a screen changes in the app, check its scene.
  // ------------------------------------------------------------------
  const TILES = {
    expense: [["🛒", "scene.cat.groceries"], ["🚌", "scene.cat.transport"], ["🍽️", "scene.cat.restaurants"], ["🏠", "scene.cat.home"], ["🛍️", "scene.cat.shopping"], ["🏥", "scene.cat.healthcare"], ["🎁", "scene.cat.gifts"], ["🎓", "scene.cat.education"]],
    income: [["💰", "scene.cat.salary"], ["🎁", "scene.cat.gifts"], ["👔", "scene.cat.business"], ["💵", "scene.cat.extraIncome"], ["🏷️", "scene.cat.sales"], ["🪙", "scene.cat.savingsReturn"], ["🛡️", "scene.cat.insurance"], ["📦", "scene.cat.other"]]
    // Investments (and transfers) have NO category in the app: the Investment tab opens the form directly.
  };

  // A labelled box: small label above its value. Returns the value element.
  function box(parent, label, value, cls) {
    const b = h("div", "ts-box" + (cls ? " " + cls : ""), null, parent);
    h("span", "ts-box-label", label, b);
    const v = h("span", "ts-box-value", value, b);
    return { box: b, value: v };
  }

  // The new-entry sheet (opened by the green +): type tabs, a category grid, and (after a category is tapped) the
  // entry form. Saving closes the sheet, so showForm(p, false) leaves Home with the new entry on top of the list.
  function entriesPhone(stage, ctx, type, form) {
    const tr = ctx.tr;
    const phone = h("div", "ts-phone", null, stage);
    const bar = h("div", "ts-bar", tr("entry.newTitle"), phone);
    const tabs = {};
    const tabRow = h("div", "ts-types", null, phone);
    ["expense", "income", "investment", "transfer"].forEach((t) => { tabs[t] = h("span", "ts-pill" + (t === type ? " on " + t : ""), tr("type." + t), tabRow); });
    const gridView = h("div", "ts-view", null, phone);
    const grid = h("div", "ts-grid", null, gridView);
    const fillGrid = (t) => {
      grid.innerHTML = "";
      const tiles = [];
      TILES[t].forEach(([icon, key]) => { const tile = h("div", "ts-tile", null, grid); h("span", "ts-tile-icon", icon, tile); h("span", "ts-tile-name", tr(key), tile); tiles.push(tile); });
      return tiles;
    };
    let tiles = fillGrid(type);
    const recent = h("div", "ts-list", null, phone);   // Home's list: shown once the sheet has closed
    recent.hidden = true;
    h("div", "ts-list-title", tr("entries.recent"), recent);
    const rows = h("div", "ts-rows", null, recent);
    const addRow = (name, amt, enter, dot) => {
      const r = h("div", "ts-row" + (enter ? " enter" : ""), null, null);
      const nm = h("span", "ts-row-name", null, r);
      if (dot) { const d = h("span", "ts-dot", null, nm); d.style.background = dot; }
      nm.appendChild(document.createTextNode(name));
      const a = h("span", "ts-row-amt", Array.isArray(amt) ? amt[0] : amt, r);
      if (Array.isArray(amt)) h("small", "ts-row-sub", amt[1], a);   // a shared entry: your part big, the full total small underneath
      rows.insertBefore(r, rows.firstChild);
      while (rows.children.length > 3) rows.removeChild(rows.lastChild);
    };
    addRow("🚌 " + tr("scene.cat.transport"), ctx.home + " " + ctx.money(6.5));
    addRow("🍽️ " + tr("scene.cat.restaurants"), ctx.home + " " + ctx.money(48));
    const formView = h("div", "ts-view ts-form", null, phone);
    formView.hidden = true;
    return { phone, bar, tabRow, recent, tabs, gridView, formView, fillGrid, get tiles() { return tiles; }, set tiles(v) { tiles = v; }, addRow, finger: makeFinger(stage), ctx };
  }
  const typeOn = (p, t) => Object.keys(p.tabs).forEach((k) => { p.tabs[k].className = "ts-pill" + (k === t ? " on " + t : ""); });
  const showForm = (p, on) => {
    p.gridView.hidden = on;
    p.formView.hidden = !on;
    if (on) return;
    // Saved: the sheet closes and Home is what is left, the new entry at the top of its list.
    p.gridView.hidden = true;
    p.formView.hidden = true;
    p.tabRow.hidden = true;
    p.recent.hidden = false;
    p.bar.textContent = p.ctx.tr("nav.home");
  };
  const typing = (el, parts) => parts.map((txt, i) => (inst) => { el.textContent = txt; });

  // ---- add an expense or income: type tab -> category -> the form's fields -> Save entry ----
  SCENES.add = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = entriesPhone(stage, ctx, "expense");
      // the form is taller than the little screen once Split and Tags are in: its inner box slides up like the page does in the app
      p.formView.classList.add("ts-form-clip");
      const f = h("div", "ts-form-inner", null, p.formView);
      p.formInner = f;
      const banner = h("div", "ts-banner", null, f);
      p.bannerIcon = h("span", null, "🛒", banner); p.bannerName = h("b", null, tr("scene.cat.groceries"), banner); h("span", "ts-change", tr("common.change"), banner);
      const r1 = h("div", "ts-two", null, f);
      p.amountBox = box(r1, tr("field.amount"), "", "grow");
      p.dateBox = box(r1, tr("field.date"), tr("scene.today"));
      const cur = h("div", "ts-chips", null, f);
      [ctx.home, "USD", "EUR"].forEach((c, i) => h("span", "ts-chip small" + (i === 0 ? " on" : ""), c, cur));
      p.descBox = box(f, tr("field.description"), "");
      const r2 = h("div", "ts-two", null, f);
      p.paidBox = box(r2, tr("field.paidBy"), tr("scene.me"));
      p.methodBox = box(r2, tr("field.paymentMethod"), tr("scene.debit"), "grow");
      // Split this expense (checkbox -> Equal/Custom, Shared with, summary) and Tags: the form's own fields, after the payment method
      p.splitRow = h("div", "ts-check", null, f);
      p.splitBox = h("span", "ts-checkbox", null, p.splitRow); h("span", null, tr("split.toggle"), p.splitRow);
      p.splitDetail = h("div", "ts-split", null, f); p.splitDetail.hidden = true;
      const mode = h("div", "ts-seg", null, p.splitDetail); h("span", "on", tr("split.equal"), mode); h("span", null, tr("split.custom"), mode);
      h("div", "ts-box-label", tr("split.sharedWith"), p.splitDetail);
      const fr = h("div", "ts-tags", null, p.splitDetail);
      p.friendChip = h("span", "ts-tag", "Ana", fr); h("span", "ts-tag", "Luis", fr);
      p.splitSummary = h("div", "ts-hint", null, p.splitDetail); p.splitSummary.hidden = true;
      h("div", "ts-box-label", tr("field.tags"), f);
      const tg = h("div", "ts-tags", null, f);
      h("span", "ts-tag", tr("scene.tagAnnual"), tg); p.tagChip = h("span", "ts-tag", tr("scene.tagFamily"), tg);
      p.save = h("div", "ts-btn", tr("entry.save"), f);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      const half = ctx.money(12.75);
      // slide the form up just far enough to bring the bottom of an element into view
      const slide = (el) => { const clipH = p.formView.clientHeight; p.formInner.style.transform = "translateY(" + (-Math.max(0, el.offsetTop + el.offsetHeight - clipH + 6)) + "px)"; };
      const amt = typing(p.amountBox.value, ["2", "25", "25.", "25.5", "25.50"]);
      const dsc = typing(p.descBox.value, ["Comp", tr("scene.descShop").slice(0, 8), tr("scene.descShop")]);
      return [
        [0, () => fg.to(p.tabs.income, true)],
        [500, (i) => fg.to(p.tabs.income, i)],
        [1100, (i) => { fg.tap(i); typeOn(p, "income"); p.tiles = p.fillGrid("income"); }],
        [1900, (i) => fg.to(p.tabs.expense, i)],
        [2400, (i) => { fg.tap(i); typeOn(p, "expense"); p.tiles = p.fillGrid("expense"); }],
        [3100, (i) => fg.to(p.tiles[0], i)],
        [3700, (i) => { fg.tap(i); p.tiles[0].classList.add("on"); }],
        [4000, () => showForm(p, true)],
        [4300, (i) => fg.to(p.amountBox.box, i)],
        [4800, (i) => { fg.tap(i); p.amountBox.box.classList.add("focus"); }],
        [4900, amt[0]], [5100, amt[1]], [5300, amt[2]], [5500, amt[3]], [5700, amt[4]],
        [6200, (i) => { p.amountBox.box.classList.remove("focus"); fg.to(p.descBox.box, i); }],
        [6700, (i) => { fg.tap(i); p.descBox.box.classList.add("focus"); }],
        [6800, (i) => { dsc[0](i); }], [7000, (i) => { dsc[1](i); }], [7200, (i) => { dsc[2](i); }],
        [7700, (i) => { p.descBox.box.classList.remove("focus"); fg.to(p.methodBox.box, i); }],
        [8200, (i) => { fg.tap(i); p.methodBox.box.classList.add("focus"); }],
        [8800, (i) => { p.methodBox.box.classList.remove("focus"); fg.to(p.splitRow, i); }],
        [9300, (i) => { fg.tap(i); p.splitBox.classList.add("on"); p.splitDetail.hidden = false; }],
        [9450, () => slide(p.splitDetail)],
        [10200, (i) => fg.to(p.friendChip, i)],
        [10700, (i) => { fg.tap(i); p.friendChip.classList.add("on"); p.splitSummary.textContent = tr("split.summaryEqual", { cur: ctx.home, each: half, own: half }); p.splitSummary.hidden = false; slide(p.splitDetail); }],
        [11500, () => slide(p.save)],
        [12300, (i) => fg.to(p.tagChip, i)],
        [12800, (i) => { fg.tap(i); p.tagChip.classList.add("on"); }],
        [13400, (i) => fg.to(p.save, i)],
        [13900, (i) => { fg.tap(i); p.save.classList.add("pressed"); }],
        [14200, (i) => { p.save.classList.remove("pressed"); showForm(p, false); p.formInner.style.transform = ""; p.tiles[0].classList.remove("on"); p.addRow("🛒 " + tr("scene.cat.groceries"), [ctx.home + " " + half, tr("common.total") + " " + ctx.home + " " + ctx.money(25.5)], true); }],
        [14800, () => fg.hide()]
      ];
    }
  };

  // ---- an investment: the Investment tab opens the form directly (no category). Deposit/Withdrawal buttons come first ----
  SCENES.invest = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = entriesPhone(stage, ctx, "expense");
      const f = p.formView;
      const seg = h("div", "ts-seg", null, f);
      p.deposit = h("span", "on", tr("investment.deposit"), seg);
      p.withdrawal = h("span", null, tr("investment.withdrawal"), seg);
      p.hint = h("div", "ts-hint", tr("investment.depositHint"), f);
      const r1 = h("div", "ts-two", null, f);
      p.amountBox = box(r1, tr("field.amount"), "", "grow");
      p.dateBox = box(r1, tr("field.date"), tr("scene.today"));
      const cur = h("div", "ts-chips", null, f);
      [ctx.home, "USD", "EUR"].forEach((c, i) => h("span", "ts-chip small" + (i === 0 ? " on" : ""), c, cur));
      const r2 = h("div", "ts-two", null, f);
      p.paidBox = box(r2, tr("field.paidBy"), tr("scene.me"));
      p.fromBox = box(r2, tr("field.from"), tr("scene.savings"), "grow");
      p.platBox = box(f, tr("field.platform"), tr("scene.platform"));
      p.save = h("div", "ts-btn", tr("entry.save"), f);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      const amt = typing(p.amountBox.value, ["5", "50", "500"]);
      const dir = (w) => () => {
        p.deposit.className = w ? "" : "on"; p.withdrawal.className = w ? "on" : "";
        p.hint.textContent = tr(w ? "investment.withdrawalHint" : "investment.depositHint");
      };
      return [
        [0, () => fg.to(p.tabs.investment, true)],
        [500, (i) => fg.to(p.tabs.investment, i)],
        [1100, (i) => { fg.tap(i); typeOn(p, "investment"); showForm(p, true); }],
        [1800, (i) => fg.to(p.withdrawal, i)],
        [2300, (i) => { fg.tap(i); dir(true)(); }],
        [3000, (i) => fg.to(p.deposit, i)],
        [3500, (i) => { fg.tap(i); dir(false)(); }],
        [4100, (i) => fg.to(p.amountBox.box, i)],
        [4600, (i) => { fg.tap(i); p.amountBox.box.classList.add("focus"); }],
        [4700, amt[0]], [4900, amt[1]], [5100, amt[2]],
        [5600, (i) => { p.amountBox.box.classList.remove("focus"); fg.to(p.fromBox.box, i); }],
        [6100, (i) => { fg.tap(i); p.fromBox.box.classList.add("focus"); }],
        [6600, (i) => { p.fromBox.box.classList.remove("focus"); fg.to(p.platBox.box, i); }],
        [7100, (i) => { fg.tap(i); p.platBox.box.classList.add("focus"); }],
        [7600, (i) => { p.platBox.box.classList.remove("focus"); fg.to(p.save, i); }],
        [8100, (i) => { fg.tap(i); p.save.classList.add("pressed"); }],
        [8400, (i) => { p.save.classList.remove("pressed"); showForm(p, false); typeOn(p, "expense"); p.addRow(tr("entry.investmentIn", { platform: tr("scene.platform") }), ctx.home + " " + ctx.money(500), true, "var(--investment)"); }],
        [9000, () => fg.hide()]
      ];
    }
  };

  // ---- a transfer: the Transfer tab opens the form directly (no category). "Type of transfer" has three scenarios ----
  //      Between Accounts (From / To), Repayments (I paid them / They paid me + friend), New loan (same + due date).
  SCENES.transfer = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = entriesPhone(stage, ctx, "expense");
      const f = p.formView;
      p.kindBox = box(f, tr("transfer.kind"), tr("transfer.kind.between"));
      p.dyn = h("div", "ts-form", null, f);
      p.save = h("div", "ts-btn", tr("entry.save"), f);
      p.renderKind = (kind, theyPaid) => {
        p.dyn.innerHTML = "";
        p.kindBox.value.textContent = tr("transfer.kind." + kind);
        if (kind !== "between") {
          const seg = h("div", "ts-seg", null, p.dyn);
          p.iPaid = h("span", theyPaid ? "" : "on", tr("transfer.iPaid"), seg);
          p.theyPaid = h("span", theyPaid ? "on" : "", tr("transfer.theyPaid"), seg);
          p.friendBox = box(p.dyn, tr("common.friend"), "Ana");
          const hintKey = kind === "loan" ? (theyPaid ? "transfer.hintLoanTheyPaid" : "transfer.hintLoanIPaid") : (theyPaid ? "transfer.hintRepayTheyPaid" : "transfer.hintRepayIPaid");
          p.hint = h("div", "ts-hint", tr(hintKey), p.dyn);
        }
        const r1 = h("div", "ts-two", null, p.dyn);
        box(r1, tr("field.amount"), kind === "between" ? "200.00" : "40.00", "grow");
        box(r1, tr("field.date"), tr("scene.today"));
        if (kind === "between") {
          const r2 = h("div", "ts-two", null, p.dyn);
          box(r2, tr("field.from"), tr("scene.debit"), "grow");
          box(r2, tr("field.toAccount"), tr("scene.savings"), "grow");
        }
        if (kind === "loan") box(p.dyn, tr("loan.dueDateOptional"), "");
      };
      p.renderKind("between");
      return p;
    },
    timeline(p, ctx) {
      const fg = p.finger, tr = ctx.tr;
      return [
        [0, () => fg.to(p.tabs.transfer, true)],
        [500, (i) => fg.to(p.tabs.transfer, i)],
        [1100, (i) => { fg.tap(i); typeOn(p, "transfer"); showForm(p, true); }],
        [3200, (i) => fg.to(p.kindBox.box, i)],
        [3700, (i) => { fg.tap(i); p.kindBox.box.classList.add("focus"); }],
        [3900, () => p.renderKind("repayment", false)],
        [5200, (i) => { p.kindBox.box.classList.remove("focus"); fg.to(p.theyPaid, i); }],
        [5700, (i) => { fg.tap(i); p.renderKind("repayment", true); }],
        [7000, (i) => fg.to(p.kindBox.box, i)],
        [7500, (i) => { fg.tap(i); p.kindBox.box.classList.add("focus"); }],
        [7700, () => p.renderKind("loan", false)],
        [9600, (i) => { p.kindBox.box.classList.remove("focus"); fg.hide(); }]
      ];
    }
  };

  // ---- a More sub-screen: "‹ Back" and "+ Add", a title and its list; a sheet slides up for the form ----
  // The day as the app's date field shows it ("Oct 28, 2026" / "28 oct 2026"), for the one-calendar date fields.
  const fmtMd = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return root.I18n ? root.I18n.fmtMonthDay(d) : d.toDateString(); };
  const fmtDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return root.I18n ? root.I18n.fmtDateMedium(d) : d.toDateString(); };
  const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  function subPhone(stage, ctx, title) {
    const tr = ctx.tr;
    const phone = h("div", "ts-phone", null, stage);
    const head = h("div", "ts-head", null, phone);
    h("span", "ts-link", tr("common.back"), head);
    const addBtn = h("span", "ts-link", tr("common.add"), head);
    h("div", "ts-h2", title, phone);
    const list = h("div", "ts-subbody", null, phone);
    const sheet = h("div", "ts-sheet", null, phone);
    return { phone, addBtn, list, sheet, finger: makeFinger(stage), ctx };
  }
  const chipRow = (parent, labels, on) => { const row = h("div", "ts-chips", null, parent); return labels.map((l, i) => h("span", "ts-chip small" + (i === on ? " on" : ""), l, row)); };

  // ---- More → Programmed income/expenses: + Add → description, category, amount, frequency, start → Save → it is listed ----
  SCENES.programmed = {
    hold: 1800,
    build(stage, ctx) {
      const p = subPhone(stage, ctx, ctx.tr("recurring.title"));
      h("div", "ts-grouptitle", ctx.tr("recurring.recurring"), p.list);
      p.empty = h("div", "ts-hint", ctx.tr("recurring.empty"), p.list);
      p.rows = h("div", "ts-rows", null, p.list);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let desc, chips, amount, seg, save;
      const t = (el, parts) => parts.map((x) => () => { el.textContent = x; });
      let d, a;
      return [
        [0, () => fg.to(p.addBtn, true)],
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, tr("recModal.add"));
          desc = box(s, tr("field.description"), "");
          chips = chipRow(s, ["🏠 " + tr("scene.cat.home"), "🛒 " + tr("scene.cat.groceries"), "💰 " + tr("scene.cat.salary")], -1);
          amount = box(s, tr("field.amount"), "");
          seg = h("div", "ts-seg", null, s);
          [["period.monthly", true], ["period.yearly"], ["recModal.once"], ["recModal.other"]].forEach(([k, on]) => h("span", on ? "on" : "", tr(k), seg));
          box(s, tr("recModal.dates"), tr("range.fromOpen", { start: fmtDay(0) }));   // the one date field: start, no end
          save = h("div", "ts-btn", tr("common.save"), s);
          d = t(desc.value, ["Re", tr("scene.rent").slice(0, 3), tr("scene.rent")]); a = t(amount.value, ["1", "1,2", "1,200"]);
        }],
        [1900, (i) => fg.to(desc.box, i)],
        [2400, (i) => { fg.tap(i); desc.box.classList.add("focus"); }],
        [2500, () => d[0]()], [2700, () => d[1]()], [2900, () => d[2]()],
        [3400, (i) => { desc.box.classList.remove("focus"); fg.to(chips[0], i); }],
        [3900, (i) => { fg.tap(i); chips[0].classList.add("on"); }],
        [4400, (i) => fg.to(amount.box, i)],
        [4900, (i) => { fg.tap(i); amount.box.classList.add("focus"); }],
        [5000, () => a[0]()], [5200, () => a[1]()], [5400, () => a[2]()],
        [5900, (i) => { amount.box.classList.remove("focus"); fg.to(seg.firstChild, i); }],
        [6400, (i) => fg.tap(i)],
        [6900, (i) => fg.to(save, i)],
        [7400, (i) => { fg.tap(i); save.classList.add("pressed"); }],
        [7700, () => {
          sheetClose(p); p.empty.hidden = true;
          const r = h("div", "ts-loanrow enter", null, p.rows);
          const left = h("div", null, null, r); h("b", null, tr("scene.rent"), left); h("div", "ts-hint", tr("recurring.freqMonthly", { day: new Date().getDate() }), left);
          h("b", null, ctx.home + " " + ctx.money(1200), r);
        }],
        [8400, () => fg.hide()]
      ];
    }
  };

  // ---- More → Trips & events: + Add → kind, name, dates, currency, budget → Save → listed; open it → your share, budget bar, Before/During/After ----
  SCENES.trips = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = subPhone(stage, ctx, tr("trips.title"));
      p.empty = h("div", "ts-hint", tr("trips.empty"), p.list);
      p.listBox = h("div", null, null, p.list);
      p.detail = h("div", "ts-subbody", null, p.phone); p.detail.hidden = true;
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger, cur = ctx.home;
      const name = tr("scene.tripName");
      const start = isoDay(14), end = isoDay(19);   // the trip list and detail show the plain dates (trip.start_date / end_date)
      let nameBox, datesBox, budgetBox, save, row;
      const part = (el, parts) => parts.map((x) => () => { el.textContent = x; });
      let n, b;
      return [
        [0, () => fg.to(p.addBtn, true)],
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, tr("trips.addTitle"));
          const seg = h("div", "ts-seg", null, s); h("span", "on", tr("trips.kind.trip"), seg); h("span", null, tr("trips.kind.event"), seg);
          nameBox = box(s, tr("trips.name"), "");
          datesBox = box(s, tr("trips.dates"), tr("range.span", { start: fmtDay(14), end: fmtDay(19) }));   // one field, one calendar
          box(s, tr("trips.currency"), cur);
          budgetBox = box(s, tr("trips.budget"), "");
          save = h("div", "ts-btn", tr("trips.save"), s);
          n = part(nameBox.value, [name.slice(0, 4), name.slice(0, 8), name]); b = part(budgetBox.value, ["2", "2,0", "2,000"]);
        }],
        [1900, (i) => fg.to(nameBox.box, i)],
        [2400, (i) => { fg.tap(i); nameBox.box.classList.add("focus"); }],
        [2500, () => n[0]()], [2700, () => n[1]()], [2900, () => n[2]()],
        [3400, (i) => { nameBox.box.classList.remove("focus"); fg.to(datesBox.box, i); }],
        [3900, (i) => { fg.tap(i); datesBox.box.classList.add("focus"); }],
        [5200, (i) => { datesBox.box.classList.remove("focus"); fg.to(budgetBox.box, i); }],
        [5700, (i) => { fg.tap(i); budgetBox.box.classList.add("focus"); }],
        [5800, () => b[0]()], [6000, () => b[1]()], [6200, () => b[2]()],
        [6700, (i) => { budgetBox.box.classList.remove("focus"); fg.to(save, i); }],
        [7200, (i) => { fg.tap(i); save.classList.add("pressed"); }],
        [7500, () => {
          sheetClose(p); p.empty.hidden = true;
          h("div", "ts-grouptitle", tr("trips.group.upcoming"), p.listBox);
          row = h("div", "ts-loanrow enter", null, p.listBox);
          const left = h("div", null, null, row); h("b", null, "✈️ " + name, left);
          h("div", "ts-hint", [tr("trips.kind.trip"), tr("trips.dateRange", { start, end }), tr("trips.entryCount", { n: 0 })].join(" · "), left);
          const right = h("div", "ts-right", null, row); h("b", null, cur + " " + ctx.money(0), right); h("div", "ts-hint", tr("trips.ofBudget", { cur, amount: ctx.money(2000) }), right);
        }],
        [8300, (i) => fg.to(row, i)],
        [8800, (i) => fg.tap(i)],
        [9000, () => {
          p.list.hidden = true; p.detail.hidden = false;
          const d = p.detail;
          h("div", "ts-detail-title", "✈️ " + name, d);
          h("div", "ts-hint", tr("trips.kind.trip") + " · " + tr("trips.dateRange", { start, end }), d);
          h("div", "ts-total", cur + " " + ctx.money(1250), d);
          h("div", "ts-hint", tr("trips.total") + " · " + tr("trips.entryCount", { n: 6 }), d);
          const track = h("div", "ts-track", null, d); const fill = h("div", "ts-fill", null, track); fill.style.width = "62.5%";
          const sub = h("div", "ts-budget-nums", null, d); h("span", "ts-hint", tr("trips.budgetLeft", { cur, amount: ctx.money(750) }), sub); h("span", "ts-hint", tr("trips.ofBudget", { cur, amount: ctx.money(2000) }), sub);
          const ph = h("div", "ts-phases", null, d);
          [["trips.before", 400], ["trips.during", 850], ["trips.after", 0]].forEach(([k, v]) => { const c = h("div", "ts-phase", null, ph); h("span", "ts-box-label", tr(k), c); h("b", null, cur + " " + ctx.money(v), c); });
          h("div", "ts-hint", tr("trips.phaseHint"), d);
        }],
        [9600, () => fg.hide()]
      ];
    }
  };

  // ---- the Loans tab: a phone with a list, and a sheet that slides up (add loan / repayment) ----
  function loansPhone(stage, ctx, owed) {
    const tr = ctx.tr;
    const phone = h("div", "ts-phone", null, stage);
    h("div", "ts-bar", tr("nav.loans"), phone);
    const card = h("div", "ts-card", null, phone);
    const head = h("div", "ts-card-head", null, card);
    h("b", null, tr("loans.owesYou"), head);
    const addBtn = h("span", "ts-link", tr("loans.add"), head);
    const totalRow = h("div", "ts-card-total", null, card);
    h("span", "ts-muted", tr("loans.totalOwed"), totalRow);
    const total = h("b", "ts-pos", "", totalRow);
    const list = h("div", "ts-loanlist", null, card);
    const empty = h("div", "ts-hint", tr("loans.noneOwed"), card);
    const sheet = h("div", "ts-sheet", null, phone);
    const setOwed = (x, enter) => {
      list.innerHTML = "";
      empty.hidden = x > 0; totalRow.hidden = !(x > 0);
      if (x > 0) {
        const r = h("div", "ts-loanrow" + (enter ? " enter" : ""), null, list);
        h("span", null, "Ana", r); const a = h("b", "ts-pos", ctx.home + " " + ctx.money(x), r);
        total.textContent = ctx.home + " " + ctx.money(x);
        return r;
      }
      return null;
    };
    setOwed(owed);
    return { phone, addBtn, sheet, setOwed, list, finger: makeFinger(stage), ctx };
  }
  const sheetOpen = (p, title) => { p.sheet.innerHTML = ""; const hd = h("div", "ts-sheet-head", null, p.sheet); h("b", null, title, hd); h("span", null, "✕", hd); p.sheet.classList.add("show"); return p.sheet; };
  const sheetClose = (p) => p.sheet.classList.remove("show");

  // ---- Loans tab: + Add loan -> Friend, Direction, Amount -> Save loan -> the friend appears under "Owes you" ----
  SCENES.loan = {
    hold: 1800,
    build(stage, ctx) { return loansPhone(stage, ctx, 0); },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let amountBox, saveBtn, friendBox, dirOn;
      const amt = (txt) => (i) => { amountBox.value.textContent = txt; };
      return [
        [0, () => fg.to(p.addBtn, true)],
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => { fg.tap(i); }],
        [1300, () => {
          const s = sheetOpen(p, tr("loanModal.add"));
          friendBox = box(s, tr("common.friend"), "Ana");
          const seg = h("div", "ts-seg", null, s); dirOn = h("span", "on", tr("loanModal.theyOweMe"), seg); h("span", null, tr("loanModal.iOweThem"), seg);
          amountBox = box(s, tr("field.amount"), "");
          saveBtn = h("div", "ts-btn", tr("loanModal.save"), s);
        }],
        [1900, (i) => fg.to(dirOn, i)],
        [2400, (i) => { fg.tap(i); }],
        [2800, (i) => fg.to(amountBox.box, i)],
        [3300, (i) => { fg.tap(i); amountBox.box.classList.add("focus"); }],
        [3400, amt("1")], [3600, amt("10")], [3800, amt("100")],
        [4300, (i) => { amountBox.box.classList.remove("focus"); fg.to(saveBtn, i); }],
        [4800, (i) => { fg.tap(i); saveBtn.classList.add("pressed"); }],
        [5100, () => { sheetClose(p); p.setOwed(100, true); }],
        [5800, () => fg.hide()]
      ];
    }
  };

  // ---- Loans tab: tap the friend -> "Record repayment" -> Amount -> Save repayment -> the balance goes down ----
  SCENES.repay = {
    hold: 1800,
    build(stage, ctx) { const p = loansPhone(stage, ctx, 100); p.friendRow = p.list.firstChild; return p; },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let rec, amountBox, saveBtn;
      const amt = (txt) => (i) => { amountBox.value.textContent = txt; };
      return [
        [0, () => fg.to(p.friendRow, true)],
        [500, (i) => fg.to(p.friendRow, i)],
        [1100, (i) => { fg.tap(i); }],
        [1300, () => {
          const s = sheetOpen(p, "Ana");
          h("div", "ts-hint", tr("loanDetail.net", { parts: "+" + ctx.home + " " + ctx.money(100) }), s);
          rec = h("div", "ts-link big", tr("loan.recordRepayment"), s);
        }],
        [1900, (i) => fg.to(rec, i)],
        [2400, (i) => { fg.tap(i); }],
        [2700, () => {
          const s = sheetOpen(p, tr("transfer.kind.repayment"));
          h("div", "ts-hint", tr("settle.contextTheyOwe", { name: "Ana", cur: ctx.home, amount: ctx.money(100) }), s);
          amountBox = box(s, tr("field.amount"), "");
          saveBtn = h("div", "ts-btn", tr("settle.save"), s);
        }],
        [3300, (i) => fg.to(amountBox.box, i)],
        [3800, (i) => { fg.tap(i); amountBox.box.classList.add("focus"); }],
        [3900, amt("4")], [4100, amt("40")],
        [4600, (i) => { amountBox.box.classList.remove("focus"); fg.to(saveBtn, i); }],
        [5100, (i) => { fg.tap(i); saveBtn.classList.add("pressed"); }],
        [5400, () => { sheetClose(p); p.setOwed(60, true); }],
        [6100, () => fg.hide()]
      ];
    }
  };

  // ---- Budgets tab: the bar fills as you spend; orange from 75%, red at 100% (the app's own rule, no extra messages) ----
  SCENES.budgets = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const phone = h("div", "ts-phone", null, stage);
      h("div", "ts-bar", tr("nav.budgets"), phone);
      const row = (icon, name, pctInit) => {
        const card = h("div", "ts-budget", null, phone);
        const head = h("div", "ts-budget-head", null, card);
        h("span", null, icon + " " + name, head); h("span", "ts-muted", tr("budget.thisMonth"), head);
        const track = h("div", "ts-track", null, card); const fill = h("div", "ts-fill", null, track);
        const nums = h("div", "ts-budget-nums", null, card);
        const spent = h("span", null, "", nums); const pct = h("b", null, "", nums);
        if (pctInit != null) fill.style.width = pctInit + "%";
        return { card, fill, spent, pct };
      };
      const main = row("🛒", tr("scene.cat.groceries"));
      const other = row("🚌", tr("scene.cat.transport"), 32);
      other.card.classList.add("small");
      other.spent.textContent = ctx.home + " " + ctx.money(128) + " / " + ctx.home + " " + ctx.money(400); other.pct.textContent = "32%";
      return { stage, main, limit: 400, ctx };
    },
    timeline(p, ctx) {
      const set = (value) => (inst) => {
        const share = value / p.limit * 100;
        p.main.fill.style.width = Math.min(100, share) + "%";
        p.main.fill.classList.toggle("warn", share >= 75 && share < 100);   // the app's rule: orange from 75%, red from 100%
        p.main.fill.classList.toggle("over", share >= 100);
        p.main.spent.textContent = ctx.home + " " + ctx.money(value) + " / " + ctx.home + " " + ctx.money(p.limit);
        p.main.pct.textContent = Math.round(share) + "%";
      };
      return [[0, set(0)], [500, set(80)], [800, set(160)], [1900, set(240)], [2200, set(320)], [3300, set(420)], [4800, () => {}]];
    }
  };

  // ---- Projections tab, told in 6 numbered steps the person advances with "Next step" (the real screens and words; numbers made up):
  //      1 the projected totals   2 a category's three lines (✅ Actual / 🔁 Programmed / 📈 Expected)   3 tap it: chart + the sums
  //      4 tap Expected: how it was worked out   5 set the remaining by hand ("Manually set")   6 how to get the most out of it
  SCENES.projections = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr;
      const money = (n) => ctx.home + " " + ctx.money(n);
      const now = new Date(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const left = Math.min(dim - 4, Math.max(4, dim - now.getDate())), frac = left / dim;   // the days still to come this month
      const cats = [
        { icon: "🛒", name: tr("scene.cat.groceries"), rate: 600, actual: Math.round(600 * (1 - frac) * 1.1), prog: 0, exp: Math.round(600 * frac) },
        { icon: "🏠", name: tr("scene.cat.home"), rate: 0, actual: 0, prog: 1500, exp: 0 },
        { icon: "🍽️", name: tr("scene.cat.restaurants"), rate: 300, actual: Math.round(300 * (1 - frac) * 0.9), prog: 0, exp: Math.round(300 * frac) }
      ];
      cats.forEach((c) => { c.total = c.actual + c.prog + c.exp; });
      const add = (k) => cats.reduce((s, c) => s + c[k], 0);
      const income = 3500, invest = 500, expenses = add("total");
      const phone = h("div", "ts-phone ts-proj", null, stage);
      h("div", "ts-bar", tr("nav.projections"), phone);
      const clip = h("div", "ts-proj-clip", null, phone);
      const scroll = h("div", "ts-scroll", null, clip);
      const p = { ctx, money, now, dim, left, frac, cats, phone, scroll, rows: [], finger: makeFinger(stage) };
      // the top card: projected totals and the confirmed + programmed + expected lines
      p.top = h("div", "ts-card", null, scroll);
      h("div", "ts-hint", tr("projections.projectedFor", { period: ctx.period || "" }), p.top);
      p.sum = h("div", "ts-sum", null, p.top);
      [["summary.income", income, "var(--income)"], ["summary.expenses", expenses, "var(--expense)"], ["summary.investments", invest, "var(--investment)"], ["summary.net", income - expenses - invest, ""]].forEach(([k, v, color]) => {
        const c = h("div", null, null, p.sum);
        h("span", "ts-muted", tr(k), c);
        const val = h("b", "ts-sum-value", money(v), c);
        if (color) val.style.color = color;
      });
      h("div", "ts-brk", tr("projections.lineIncome", { actual: money(income), programmed: money(0) }), p.top);
      h("div", "ts-brk", tr("projections.lineExpenses", { actual: money(add("actual")), programmed: money(add("prog")), expected: money(add("exp")) }), p.top);
      // By category: one row each, three lines under the name
      p.list = h("div", "ts-card", null, scroll);
      h("div", "ts-h3", tr("overview.byCategory"), p.list);
      p.drawRow = (c) => {
        c.nameTotal.textContent = money(c.total);
        c.lines.innerHTML = "";
        const line = (icon, amount, label) => { const l = h("div", "ts-pline", null, c.lines); h("span", "ts-pline-ic", icon, l); h("span", "ts-pline-am", money(amount), l); h("span", null, label, l); };
        line("✅", c.actual, tr("projections.actual"));
        if (c.manual) line("✏️", c.remaining, tr("projections.remainingManual"));
        else { line("🔁", c.prog, tr("projections.programmed")); line("📈", c.exp, tr("projections.expected")); }
      };
      cats.forEach((c) => {
        c.row = h("div", "ts-prow", null, p.list);
        const top = h("div", "ts-prow-top", null, c.row);
        h("span", null, c.icon + " " + c.name, top); c.nameTotal = h("span", null, "", top);
        c.lines = h("div", null, null, c.row);
        p.drawRow(c);
        p.rows.push(c.row);
      });
      p.sheet = h("div", "ts-sheet", null, phone);
      p.list2 = h("ol", "ts-captions", null, stage);
      p.caps = ["scene.proj.s1", "scene.proj.s2", "scene.proj.s3", "scene.proj.s4", "scene.proj.s5", "scene.proj.s6"].map((key, k) => { const li = h("li", null, null, p.list2); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(key), li); return li; });
      return p;
    },
    initial(p, ctx) { /* the starting picture is the Projections screen itself */ },
    steps: [
      // 1 — the projected totals
      (p, ctx, instant, later) => {
        stmtStep(p, 1);
        later(() => p.finger.to(p.sum, instant), 400);
        later(() => { p.finger.tap(instant); p.top.classList.add("now"); }, 900);
        later(() => { p.top.classList.remove("now"); p.finger.hide(); }, 2400);
        return 2500;
      },
      // 2 — the three lines of one category
      (p, ctx, instant, later) => {
        stmtStep(p, 2);
        later(() => { projScroll(p, p.list); }, 100);
        later(() => { p.cats[0].row.classList.add("now"); p.finger.to(p.cats[0].lines, instant); }, 1200);
        return 2600;
      },
      // 3 — tap the category: its chart and the sums
      (p, ctx, instant, later) => {
        const tr = ctx.tr, c = p.cats[0];
        stmtStep(p, 3);
        later(() => p.finger.tap(instant), 300);
        later(() => {
          p.finger.hide();
          const s = sheetOpen(p, c.icon + " " + c.name);
          h("div", "ts-hint", (ctx.period || "") + " · " + tr("drill.projectedLegend"), s);
          // the chart: the solid line is the spend so far, the dashed one where it is heading
          const NS = "http://www.w3.org/2000/svg", W = 260, H = 64, x = Math.round(W * (1 - p.frac));
          const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("class", "ts-pchart"); s.appendChild(svg);
          const line = (pts, cls) => { const l = document.createElementNS(NS, "polyline"); l.setAttribute("points", pts); l.setAttribute("class", cls); svg.appendChild(l); };
          line("0," + (H - 4) + " " + Math.round(x * 0.3) + "," + (H - 16) + " " + Math.round(x * 0.6) + "," + (H - 26) + " " + x + "," + (H - 36), "ts-pl-actual");
          line(x + "," + (H - 36) + " " + W + "," + 8, "ts-pl-proj");
          const lg = h("div", "ts-plegend", null, s);
          const a = h("span", null, null, lg); h("span", "chart-legend-swatch legend-actual", null, a); a.appendChild(document.createTextNode(tr("drill.actualSpend")));
          const b = h("span", null, null, lg); h("span", "chart-legend-swatch legend-pace", null, b); b.appendChild(document.createTextNode(tr("drill.projectedLegend")));
          const drow = (label, value) => { const r = h("div", "ts-drow", null, s); h("span", null, label, r); h("b", null, value, r); return r; };
          p.dActual = drow(tr("drill.actual"), p.money(c.actual));
          p.dProg = drow(tr("drill.programmed") + " " + tr("drill.tapToTrace"), p.money(c.prog));
          p.dExp = drow(tr("drill.expected") + " " + tr("drill.tapToTrace"), p.money(c.exp));
          p.trace = h("div", "ts-trace", null, s); p.trace.hidden = true;
          p.dTot = drow(tr("drill.periodTotal") + " " + tr("drill.periodTotalHint"), p.money(c.total));   // Actual + Programmed + Expected; tap it to set a figure by hand
          p.dTot.classList.add("edit");
        }, 700);
        return 2100;
      },
      // 4 — tap Expected: how it was worked out
      (p, ctx, instant, later) => {
        const tr = ctx.tr, c = p.cats[0];
        stmtStep(p, 4);
        later(() => p.finger.to(p.dExp, instant), 300);
        later(() => {
          p.finger.tap(instant); p.dExp.classList.add("now");
          const mon = (d) => (root.I18n ? root.I18n.monthShort(d.getMonth(), true) : "") + " " + d.getFullYear();
          const span = mon(new Date(p.now.getFullYear(), p.now.getMonth() - 12, 1)) + "–" + mon(new Date(p.now.getFullYear(), p.now.getMonth() - 1, 1));
          p.trace.innerHTML = "";
          h("div", null, tr("projections.formulaBased", { total: p.money(c.rate * 12), n: 12, span, rate: p.money(c.rate) }), p.trace);
          h("div", null, tr("projections.formulaProrated", { rate: p.money(c.rate), months: p.frac.toFixed(2), n: p.left, amount: p.money(c.exp) }), p.trace);
          p.trace.hidden = false;
        }, 800);
        return 2400;
      },
      // 5 — set the remaining by hand
      (p, ctx, instant, later) => {
        const tr = ctx.tr, c = p.cats[0];
        stmtStep(p, 5);
        later(() => { p.dExp.classList.remove("now"); p.finger.to(p.dTot, instant); }, 300);
        later(() => {
          p.finger.tap(instant);
          const s = sheetOpen(p, tr("projOverride.title"));
          h("div", "ts-hint", tr("projOverride.subtitleCalculated", { category: c.name, amount: p.money(c.total) }), s);
          const seg = h("div", "ts-seg", null, s); h("span", null, tr("projOverride.total"), seg); p.remTab = h("span", null, tr("projOverride.remaining"), seg);
          p.ovBox = box(s, p.ctx.home, "");
          h("div", "ts-hint", tr("projOverride.hintRemaining", { actual: p.money(c.actual) }), s);
          p.ovSave = h("div", "ts-btn", tr("common.save"), s);
          h("div", "ts-link", tr("projOverride.reset"), s);
        }, 800);
        later(() => p.finger.to(p.remTab, instant), 1500);
        later(() => { p.finger.tap(instant); p.remTab.classList.add("on"); }, 2000);
        later(() => p.finger.to(p.ovBox.box, instant), 2500);
        later(() => { p.finger.tap(instant); p.ovBox.box.classList.add("focus"); p.ovBox.value.textContent = "450"; }, 3000);
        later(() => p.finger.to(p.ovSave, instant), 3700);
        later(() => {
          p.finger.tap(instant); p.ovSave.classList.add("pressed");
        }, 4200);
        later(() => {
          p.finger.hide(); sheetClose(p);
          c.manual = true; c.remaining = 450; c.total = c.actual + 450;
          p.drawRow(c); c.row.classList.add("now");
          projScroll(p, p.list);
        }, 4600);
        return 5400;
      },
      // 6 — how to get the most out of it (the whole list again)
      (p, ctx, instant, later) => {
        stmtStep(p, 6);
        later(() => { p.cats[0].row.classList.remove("now"); p.list.classList.add("now"); }, 200);
        later(() => p.list.classList.remove("now"), 1800);
        return 1900;
      }
    ]
  };
  function projScroll(p, el) { p.scroll.style.transform = "translateY(" + (-Math.max(0, el.offsetTop - 2)) + "px)"; }

  // ---- Pro: split a restaurant bill. The expense form -> "Split a bill by items…" -> who is splitting -> the photo reads the dishes -> a misread price is
  //      fixed -> who shared each dish -> the tip -> the total check -> "Use this split" fills the form. Every number comes from the app's own BillSplit maths
  //      and every line of text from its own strings. ----
  const BILL_NAMES = { ana: "Ana", luis: "Luis" };
  function billScroll(p, el) {
    const max = Math.max(0, p.scroll.offsetHeight - p.clip.clientHeight);
    p.scroll.style.transform = "translateY(" + (-Math.min(max, Math.max(0, el.offsetTop - 2))) + "px)";
  }
  // Works the bill out again from what is on screen and redraws the check line, the tip line and the per-person rows (as recomputeBill_ in app.js).
  function billRecompute(p) {
    const tr = p.ctx.tr, fmt = p.fmt;
    const people = ["me"].concat(Object.keys(BILL_NAMES).filter((k) => p.sel[k]));
    Object.keys(BILL_NAMES).forEach((k) => p.items.forEach((it) => { it.chips[k].hidden = !p.sel[k]; }));
    const res = root.BillSplit.compute({
      people,
      items: p.shown ? p.items.map((it, k) => ({ id: k, name: it.name, people: Array.from(it.people), price: it.price })) : [],
      adjustments: [],
      tip: { type: "percent", mode: "proportional", value: p.tipPct },
      printedTotal: p.total
    });
    const chargesCents = res.preDiscountCents - res.itemsCents;
    const counted = chargesCents ? tr("bill.countedCharges", { items: fmt(res.itemsCents), charges: fmt(chargesCents) }) : tr("bill.counted", { items: fmt(res.itemsCents) });
    const lead = chargesCents ? tr("bill.leadCharges", { counted, total: fmt(res.preDiscountCents) }) : tr("bill.leadPlain", { items: fmt(res.itemsCents) });
    p.check.className = "ts-hint";
    if (res.printedCents > 0) {
      if (res.diffCents === 0) { p.check.classList.add("ts-stmt-ok"); p.check.textContent = tr("bill.checkOk", { counted, printed: fmt(res.printedCents) }); }
      else {
        p.check.classList.add("ts-bill-bad");
        p.check.textContent = res.diffCents > 0 ? tr("bill.checkShort", { lead, printed: fmt(res.printedCents), diff: fmt(res.diffCents) })
          : tr("bill.checkTooMuch", { lead, printed: fmt(res.printedCents), diff: fmt(-res.diffCents) });
      }
    } else p.check.textContent = res.itemsCents ? tr("bill.itemsSoFar", { items: fmt(res.itemsCents) }) : "";
    p.tipPreview.textContent = p.tipPct && res.tipCents ? tr("bill.tipPctOf", { pct: p.tipPct, bill: fmt(res.billCents), tip: fmt(res.tipCents), odd: "" })
      : (res.billCents > 0 ? tr("bill.tipBase", { bill: fmt(res.billCents) }) : "");
    p.results.innerHTML = "";
    if (res.itemsCents) {
      people.forEach((k) => {
        const pp = res.perPerson[k], row = h("div", "ts-bill-resrow", null, p.results);
        const left = h("div", null, null, row);
        h("div", null, k === "me" ? tr("common.me") : BILL_NAMES[k], left);
        const bits = [tr("bill.subItems", { v: p.ctx.money(pp.items / 100) })];
        if (pp.tip) bits.push(tr("bill.subTip", { v: p.ctx.money(pp.tip / 100) }));
        h("div", "ts-hint", bits.join(" · "), left);
        h("b", null, fmt(pp.total), row);
      });
      if (res.tipCents) h("div", "ts-hint", tr("bill.tipTotal", { tip: fmt(res.tipCents), total: fmt(res.grandCents) }), p.results);
    }
    p.apply.classList.toggle("off", !res.ok);
    return res;
  }
  SCENES.bill = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home;
      const phone = h("div", "ts-phone ts-billp", null, stage);
      h("div", "ts-bar", tr("entry.newTitle"), phone);
      const p = { ctx, phone, finger: makeFinger(stage), tipPct: "", total: "", sel: {}, shown: false };
      p.fmt = (cents) => cur + " " + ctx.money(cents / 100);
      // the expense form, behind the sheet
      const form = h("div", "ts-billform", null, phone);
      const banner = h("div", "ts-banner", null, form);
      h("span", null, "🍽️", banner); h("b", null, tr("scene.cat.restaurants"), banner); h("span", "ts-change", tr("common.change"), banner);
      p.amountBox = box(form, tr("field.amount"), "");
      p.openBtn = h("div", "ts-billbtn", tr("split.openBill"), form);
      const chk = h("div", "ts-check", null, form);
      p.splitBox = h("span", "ts-checkbox", null, chk); h("span", null, tr("split.toggle"), chk);
      p.splitDetail = h("div", "ts-split", null, form); p.splitDetail.hidden = true;
      const mode = h("div", "ts-seg", null, p.splitDetail); h("span", null, tr("split.equal"), mode); h("span", "on", tr("split.custom"), mode);
      p.splitSummary = h("div", "ts-hint", null, p.splitDetail);
      p.save = h("div", "ts-btn", tr("entry.save"), form);
      // the bill sheet
      p.ov = h("div", "ts-billov", null, phone);
      const hd = h("div", "ts-sheet-head", null, p.ov); h("b", null, tr("bill.title"), hd); h("span", null, "✕", hd);
      p.clip = h("div", "ts-bill-clip", null, p.ov);
      p.scroll = h("div", "ts-scroll", null, p.clip);
      const S = p.scroll;
      p.photoBtn = h("div", "ts-billbtn", tr("bill.photo"), S);
      p.status = h("div", "ts-hint", null, S); p.status.hidden = true;
      p.totalBox = box(S, tr("bill.totalBefore") + " (" + cur + ")", "");
      h("div", "ts-box-label", tr("bill.who"), S);
      const who = h("div", "ts-tags", null, S);
      p.friends = {}; Object.keys(BILL_NAMES).forEach((k) => { p.friends[k] = h("span", "ts-tag", BILL_NAMES[k], who); });
      p.itemsLabel = h("div", "ts-box-label", tr("bill.items"), S);
      // what the photo reads (one price is misread, the way a thermal printout sometimes is) and the right price
      p.items = [["Ceviche", "40.00", "40.00"], ["Lomo saltado", "82.00", "32.00"], ["Pasta", "28.00", "28.00"], ["Pizza", "20.00", "20.00"]].map(([name, read, right]) => {
        const it = { name, price: read, right, people: new Set(), chips: {} };
        it.row = h("div", "ts-bill-item", null, S); it.row.hidden = true;
        const ln = h("div", "ts-bill-line", null, it.row); h("b", null, name, ln); it.priceEl = h("span", "ts-bill-price", read, ln);
        const cs = h("div", "ts-tags", null, it.row);
        [["me", tr("common.me")], ["ana", "Ana"], ["luis", "Luis"]].forEach(([key, label]) => { it.chips[key] = h("span", "ts-tag", label, cs); });
        return it;
      });
      p.check = h("div", "ts-hint", null, S);
      p.adjLabel = h("div", "ts-box-label", tr("bill.adjs"), S);
      const adj = h("div", "ts-bill-adj", null, S);
      p.addDiscount = h("span", "ts-billbtn small", tr("bill.addDiscount"), adj); h("span", "ts-billbtn small", tr("bill.addCharge"), adj);
      p.tipLabel = h("div", "ts-box-label", tr("bill.tip"), S);
      const tt = h("div", "ts-seg", null, S); h("span", "on", tr("bill.tipPercentTab"), tt); h("span", null, tr("bill.tipAmountTab"), tt);
      p.tipBox = box(S, tr("bill.tipPercentLabel"), "");
      p.tipPreview = h("div", "ts-hint", null, S);
      const tm = h("div", "ts-seg", null, S); h("span", "on", tr("bill.byOrdered"), tm); h("span", null, tr("split.equal"), tm);
      p.results = h("div", "ts-bill-res", null, S);
      p.apply = h("div", "ts-btn off", tr("bill.apply"), p.ov);
      // the explanations, one more appearing at each step
      p.list = h("ol", "ts-captions", null, stage);
      p.caps = [["tour.bill.l1", "tour.bill.t1"], ["tour.bill.l2", "tour.bill.t2"], ["tour.bill.l3", "tour.bill.t3"], ["tour.bill.l4", "tour.bill.t4"],
        ["tour.bill.l5", "tour.bill.t5"], ["tour.bill.l6", "tour.bill.t6"], ["tour.bill.l7", "tour.bill.t7"], ["tour.bill.l8", "tour.bill.t8"]].map(([head, text], k) => {
        const li = h("li", null, null, p.list); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(head) + ": " + tr(text), li); return li;
      });
      billRecompute(p);
      return p;
    },
    initial(p, ctx) { /* the starting picture is the empty expense form */ },
    steps: [
      // 1 — open the sheet from the expense form
      (p, ctx, instant, later) => {
        stmtStep(p, 1);
        later(() => p.finger.to(p.openBtn, instant), 400);
        later(() => { p.finger.tap(instant); p.openBtn.classList.add("pressed"); }, 900);
        later(() => { p.openBtn.classList.remove("pressed"); p.ov.classList.add("show"); p.finger.hide(); }, 1150);
        return 1700;
      },
      // 2 — tap the friends who are splitting
      (p, ctx, instant, later) => {
        stmtStep(p, 2);
        ["ana", "luis"].forEach((k, n) => {
          later(() => p.finger.to(p.friends[k], instant), 300 + n * 900);
          later(() => { p.finger.tap(instant); p.friends[k].classList.add("on"); p.sel[k] = true; billRecompute(p); }, 750 + n * 900);
        });
        later(() => p.finger.hide(), 2300);
        return 2400;
      },
      // 3 — the photo reads the dishes (and the total printed on the bill)
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        stmtStep(p, 3);
        later(() => p.finger.to(p.photoBtn, instant), 300);
        later(() => { p.finger.tap(instant); p.photoBtn.classList.add("pressed"); p.status.textContent = tr("photo.reading"); p.status.hidden = false; }, 800);
        later(() => {
          p.photoBtn.classList.remove("pressed"); p.finger.hide();
          p.status.textContent = tr("photo.readN", { n: 4, notes: "" });
          p.shown = true; p.total = "120.00"; p.totalBox.value.textContent = p.total;
          p.items.forEach((it) => { it.row.hidden = false; });
          billRecompute(p);
        }, 2000);
        later(() => billScroll(p, p.itemsLabel), 2600);
        return 3700;
      },
      // 4 — the check line says "too much": one price was misread; fix it
      (p, ctx, instant, later) => {
        const it = p.items[1];
        stmtStep(p, 4);
        later(() => { billScroll(p, it.row); p.check.classList.add("now"); }, 100);
        later(() => p.finger.to(it.priceEl, instant), 1300);
        later(() => { p.finger.tap(instant); it.priceEl.classList.add("focus"); }, 1800);
        ["3", "32", "32.0", "32.00"].forEach((v, n) => later(() => { it.price = v; it.priceEl.textContent = v; billRecompute(p); p.check.classList.add("now"); }, 1950 + n * 200));
        later(() => { it.priceEl.classList.remove("focus"); p.finger.hide(); }, 3000);
        later(() => p.check.classList.remove("now"), 3400);
        return 3500;
      },
      // 5 — tap who shared each dish
      (p, ctx, instant, later) => {
        stmtStep(p, 5);
        let t = 100;
        later(() => billScroll(p, p.items[0].row), t);
        t = 1200;
        [[0, "me"], [0, "ana"], [1, "me"], [2, "ana"], [3, "luis"]].forEach(([k, who]) => {
          if (k === 2) { const at = t; later(() => billScroll(p, p.items[2].row), at); t += 1100; }
          const at = t;
          later(() => p.finger.to(p.items[k].chips[who], instant), at);
          later(() => { p.finger.tap(instant); p.items[k].people.add(who); p.items[k].chips[who].classList.add("on"); billRecompute(p); }, at + 450);
          t += 900;
        });
        later(() => p.finger.hide(), t);
        return t + 200;
      },
      // 6 — discounts and extra charges exist; the tip is typed as a percentage
      (p, ctx, instant, later) => {
        stmtStep(p, 6);
        later(() => billScroll(p, p.adjLabel), 100);
        later(() => p.finger.to(p.addDiscount, instant), 1200);
        later(() => billScroll(p, p.tipLabel), 2300);
        later(() => p.finger.to(p.tipBox.box, instant), 3400);
        later(() => { p.finger.tap(instant); p.tipBox.box.classList.add("focus"); }, 3900);
        ["1", "10"].forEach((v, n) => later(() => { p.tipPct = v; p.tipBox.value.textContent = v; billRecompute(p); }, 4000 + n * 250));
        later(() => { p.tipBox.box.classList.remove("focus"); p.finger.hide(); }, 4800);
        return 5000;
      },
      // 7 — the total printed on the bill against the dishes: a green ✓
      (p, ctx, instant, later) => {
        stmtStep(p, 7);
        later(() => billScroll(p, p.totalBox.box), 100);
        later(() => p.finger.to(p.totalBox.box, instant), 1200);
        later(() => { p.finger.tap(instant); p.totalBox.box.classList.add("focus"); }, 1700);
        later(() => { p.totalBox.box.classList.remove("focus"); p.finger.hide(); billScroll(p, p.itemsLabel); }, 2500);
        later(() => p.check.classList.add("now"), 3500);
        later(() => p.check.classList.remove("now"), 5000);
        return 5100;
      },
      // 8 — Use this split: the form is filled in; Save entry
      (p, ctx, instant, later) => {
        stmtStep(p, 8);
        later(() => billScroll(p, p.results), 100);
        later(() => p.finger.to(p.apply, instant), 1700);
        later(() => { p.finger.tap(instant); p.apply.classList.add("pressed"); }, 2200);
        later(() => {
          p.apply.classList.remove("pressed"); p.ov.classList.remove("show");
          const res = billRecompute(p), money = (c) => ctx.money(c / 100);
          p.amountBox.value.textContent = money(res.grandCents);
          p.splitBox.classList.add("on"); p.splitDetail.hidden = false;
          p.splitSummary.textContent = ctx.tr("split.summaryCustom", { cur: ctx.home, friends: money(res.grandCents - res.perPerson.me.total), total: money(res.grandCents), own: money(res.perPerson.me.total) });
        }, 2500);
        later(() => p.finger.to(p.save, instant), 3300);
        later(() => { p.finger.tap(instant); p.save.classList.add("pressed"); }, 3800);
        later(() => { p.save.classList.remove("pressed"); p.finger.hide(); }, 4200);
        return 4300;
      }
    ]
  };

  // ---- The More tab: only the More screen itself — the list is dragged down to the language picker and back up (it does not open any section) ----
  //      Only the rows every copy shows are drawn (the owner-only and friend-only rows differ); real order, groups and words.
  SCENES.more = {
    hold: 2200,
    build(stage, ctx) {
      const tr = ctx.tr;
      const phone = h("div", "ts-phone", null, stage);
      const p = { ctx, phone, finger: makeFinger(stage) };
      h("div", "ts-bar", tr("nav.more"), phone);
      const clip = h("div", "ts-more-clip", null, phone);
      p.scroll = h("div", "ts-scroll", null, clip);
      p.rows = {};
      const card = (keys) => {
        const c = h("div", "ts-card ts-more-group", null, p.scroll);
        keys.forEach((k) => { const r = h("div", "ts-more-row", null, c); h("span", null, tr("more." + k), r); h("span", "ts-muted", "›", r); p.rows[k] = r; });
        return c;
      };
      card(["programmed", "trips"]);
      card(["accounts", "categories", "exchangeRates", "mainCurrency", "statements", "export"]);
      card(["tour", "devices", "signout"]);
      const lang = h("div", "ts-more-lang", null, p.scroll);
      h("div", "ts-hint", "🌐 Language / Idioma", lang);
      p.lang = h("div", "ts-box", null, lang); h("span", "ts-box-value", root.I18n && root.I18n.getLang() === "es" ? "Español" : "English", p.lang);
      return p;
    },
    timeline(p, ctx) {
      const fg = p.finger;
      const room = () => Math.max(0, p.scroll.scrollHeight - p.scroll.parentNode.clientHeight);
      return [
        [500, (i) => fg.to(p.rows.exchangeRates, i)],
        [1000, () => { p.scroll.style.transform = "translateY(" + (-room()) + "px)"; }],   // the finger drags the list up: the rest of More, down to the language
        [1100, (i) => fg.to(p.lang, i)],
        [3600, () => { p.scroll.style.transform = "translateY(0)"; }],                    // and back to the top
        [3700, (i) => fg.to(p.rows.exchangeRates, i)],
        [5200, () => fg.hide()]
      ];
    }
  };

  // ---- More → Statements, told in 6 numbered steps the person advances with "Next step" (the real screens and words; numbers and merchants made up):
  //      1 read two statements at once, then "Read my statements"   2 the summary: what is added, what is already in the app
  //      3 payments with people (a Yape): spending by default, or Needs review   4 a transfer between your accounts is found on both statements and recorded once
  //      5 balances: Set balance to statement   6 Add to my history (one step, undoable)
  SCENES.statements = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home;
      const money = (n) => (n < 0 ? "−" : "") + cur + " " + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const phone = h("div", "ts-phone ts-stmt", null, stage);
      const head = h("div", "ts-head", null, phone);
      h("span", "ts-link", tr("common.back"), head);
      h("div", "ts-h2", tr("stmt.title"), phone);
      const clip = h("div", "ts-stmt-clip", null, phone);
      const scroll = h("div", "ts-scroll", null, clip);
      const p = { ctx, money, phone, clip, scroll, sel: {}, finger: makeFinger(stage) };
      // view A: Read a statement
      p.a = h("div", null, null, scroll);
      h("b", null, tr("stmt.read"), p.a);
      p.choose = h("div", "ts-btn", tr("stmt.choose"), p.a);
      p.results = h("div", "ts-stmt-result", null, p.a);
      // view B: the summary the app shows after reading (real order: summary, people, balances; the steps scroll to the one being explained)
      p.b = h("div", null, null, scroll); p.b.hidden = true;
      p.groups = {};
      const group = (key, title, count, hint) => {
        const g = h("div", "ts-sg", null, p.b);
        const t = h("div", "ts-sg-title", title, g); if (count !== null) h("span", "ts-stmt-count", String(count), t);
        if (hint) h("div", "ts-hint", hint, g);
        p.groups[key] = g; return g;
      };
      const line = (g, date, desc, amt, sub) => {
        const it = h("div", "ts-sl", null, g);
        const l = h("div", "ts-sline", null, it);
        h("span", "ts-muted", fmtMd(date), l); h("span", null, desc, l); h("b", "out", money(amt), l);
        if (sub) h("div", "ts-hint", sub, it);
        return it;
      };
      const chips = (it, labels) => { const row = h("div", "ts-schoices", null, it); return labels.map((l) => h("span", "ts-schoice", l, row)); };
      // the summary
      const gSum = group("sum", tr("hist.ready"), null, null);
      p.sums = h("div", null, null, gSum);
      p.sumLine = (text) => h("div", "ts-hint", "• " + text, p.sums);
      p.sumLine(tr("hist.sum.expenses", { n: 3, total: money(93.5).replace("−", "") }));
      p.sumLine(tr("hist.sum.transfers", { n: 1 }));
      p.sumLine(tr("hist.sum.linked", { n: 2 }));
      // payments with people
      const gPeople = group("people", tr("hist.people.title", { n: 1 }), null, null);
      p.peopleItem = line(gPeople, -5, "YAPE-ANA", -20, tr("scene.savings"));
      [p.peopleSpend, p.peopleReview] = chips(p.peopleItem, [tr("hist.people.spending"), tr("hist.people.review"), tr("hist.people.leave")]);
      stmtPick(p, p.peopleSpend, "spending");
      // balances
      const gBal = group("balance", tr("bal.title", { n: 1 }), null, tr("bal.hint"));
      const bal = h("div", "ts-sl", null, gBal);
      h("div", "ts-spair", tr("scene.savings") + " · " + cur, bal);
      const kv = (a, b) => { const r = h("div", "ts-kv", null, bal); h("span", null, a, r); h("span", null, b, r); };
      kv(tr("stmt.balClosing", { date: fmtDay(-1) }), money(2512));
      kv(tr("stmt.balInApp"), money(2880));
      kv(tr("stmt.balDiff"), cur + " −368.00");
      h("div", "ts-stmt-ok", tr("stmt.balExplained", { parts: tr("stmt.balNotInApp", { amount: cur + " −368.00", n: 3 }) }), bal);
      p.balChip = chips(bal, [tr("stmt.choice.setBalance")])[0];
      // the save bar (sticky at the bottom of the screen once there is a summary)
      p.bar = h("div", "ts-stmt-bar", null, phone); p.bar.hidden = true;
      p.summary = h("div", "ts-hint", tr("hist.noCategory"), p.bar);
      p.save = h("div", "ts-btn", tr("hist.add"), p.bar);
      // the explanations, one more appearing at each step
      p.list = h("ol", "ts-captions", null, stage);
      p.caps = ["scene.stmt.s1", "scene.stmt.s2", "scene.stmt.s3", "scene.stmt.s4", "scene.stmt.s5", "scene.stmt.s6"].map((key, k) => { const li = h("li", null, null, p.list); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(key), li); return li; });
      return p;
    },
    initial(p, ctx) { /* the starting picture is just the empty "Read a statement" screen */ },
    steps: [
      // 1 — read two statements at once; each one is checked; then Read my statements
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        stmtStep(p, 1);
        later(() => p.finger.to(p.choose, instant), 400);
        later(() => { p.finger.tap(instant); p.choose.classList.add("pressed"); }, 900);
        later(() => {
          p.choose.classList.remove("pressed"); p.results.innerHTML = "";
          h("div", "ts-hint", tr("stmt.reading"), p.results);
        }, 1200);
        later(() => {
          p.results.innerHTML = "";
          [tr("scene.savings"), tr("accounts.type.credit")].forEach((name) => {
            const c = h("div", "ts-stmt-card", null, p.results);
            h("div", "ts-stmt-ok", tr("stmt.verdictGood"), c);
            h("div", "ts-hint", tr("stmt.noteAccount", { label: name }), c);
          });
          p.reviewBtn = h("div", "ts-btn", tr("hist.button"), p.results);
        }, 2200);
        later(() => p.finger.to(p.reviewBtn, instant), 3000);
        later(() => { p.finger.tap(instant); p.reviewBtn.classList.add("pressed"); }, 3500);
        later(() => { p.a.hidden = true; p.b.hidden = false; p.bar.hidden = false; p.finger.hide(); stmtFocus(p, null); }, 3800);
        return 4400;
      },
      // 2 — the summary: what will be added, what is already in the app (nothing is saved yet)
      (p, ctx, instant, later) => {
        stmtStep(p, 2); stmtFocus(p, "sum"); stmtScroll(p, p.groups.sum);
        later(() => p.finger.hide(), 200);
        return 3200;
      },
      // 3 — payments with people: what you paid is spending by default; one can go to Needs review instead
      (p, ctx, instant, later) => {
        stmtStep(p, 3); stmtFocus(p, "people"); stmtScroll(p, p.groups.people);
        later(() => p.finger.to(p.peopleReview, instant), 1000);
        later(() => { p.finger.tap(instant); stmtPick(p, p.peopleReview, "review"); }, 1600);
        later(() => p.finger.hide(), 2400);
        return 2800;
      },
      // 4 — a transfer between your accounts: its two sides (one on each statement) are recorded once
      (p, ctx, instant, later) => {
        stmtStep(p, 4); stmtFocus(p, "sum"); stmtScroll(p, p.groups.sum);
        later(() => p.sums.children[1].classList.add("ts-stmt-ok"), 600);
        return 3200;
      },
      // 5 — balances: the statement's closing balance against the app's; Set balance to statement
      (p, ctx, instant, later) => {
        stmtStep(p, 5); stmtFocus(p, "balance"); stmtScroll(p, p.groups.balance);
        later(() => p.finger.to(p.balChip, instant), 1000);
        later(() => { p.finger.tap(instant); stmtPick(p, p.balChip, "set"); p.sumLine(ctx.tr("hist.sum.balances", { n: 1 })); }, 1500);
        later(() => p.finger.hide(), 2200);
        return 2600;
      },
      // 6 — Add to my history: everything is applied at once, and can be undone at once
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        stmtStep(p, 6); stmtFocus(p, null);
        later(() => p.finger.to(p.save, instant), 700);
        later(() => { p.finger.tap(instant); p.save.classList.add("pressed"); }, 1300);
        later(() => {
          p.save.classList.remove("pressed"); p.finger.hide();
          p.summary.textContent = tr("stmt.saved") + " · " + tr("stmt.recentHint");
          p.summary.classList.add("ts-stmt-ok");
          p.save.hidden = true;
        }, 1700);
        return 2400;
      }
    ]
  };
  // helpers of the statements scene
  function stmtStep(p, n) { p.caps.forEach((li, k) => { if (k < n) li.classList.add("show"); li.classList.toggle("now", k === n - 1); }); }
  function stmtFocus(p, key) { Object.keys(p.groups).forEach((k) => p.groups[k].classList.toggle("dim", !!key && k !== key)); }
  function stmtScroll(p, el, inside) {
    const y = inside ? el.offsetTop + el.offsetParent.offsetTop : el.offsetTop;
    p.scroll.style.transform = "translateY(" + (-Math.max(0, y - 4)) + "px)";
  }
  function stmtPick(p, chip, key) {
    const row = chip.parentNode;
    [...row.children].forEach((c) => { c.classList.remove("on"); c.textContent = c.textContent.replace(/^✓ /, ""); });
    chip.classList.add("on"); chip.textContent = "✓ " + chip.textContent;
    p.sel[key] = true;
  }

  // ---- The big picture, as a flow chart told in 4 numbered steps the person advances with "Next step" ----
  //      1 Income lands in a savings account (it was at zero) → Net appears.   2 A credit card pays an expense → the card goes negative, Net down.
  //      3 Savings pays the card (a transfer) → only moves money between accounts, Net does not change.   4 Savings puts money into a platform
  //      (an investment) → Net down. Net = income − expenses − investments (Overview's own formula). Platforms are never in Balances.
  const SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  SCENES.flow = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr, fmt = (v) => ctx.home + " " + ctx.money(v);
      const frame = h("div", "ts-phone ts-chart", null, stage);
      const svg = sv("svg", { viewBox: "0 0 320 312", class: "ts-chart-svg" }, frame);
      const p = { ctx, fmt, svg, els: [] };
      const fillOf = (c) => "fill:" + c;
      const fl = (parent) => { const g = sv("g", { class: "ts-fl" }, parent); p.els.push(g); return g; };
      const head = (g, x, y, dx, dy, color) => sv("polygon", { points: dx ? (x + "," + y + " " + (x - dx * 8) + "," + (y - 5) + " " + (x - dx * 8) + "," + (y + 5)) : (x + "," + y + " " + (x - 5) + "," + (y - dy * 8) + " " + (x + 5) + "," + (y - dy * 8)), style: fillOf(color) }, g);
      const arrow = (g, x1, y1, x2, y2, color) => {
        const line = sv("line", { x1, y1, x2, y2, class: "ts-fl-line", style: "stroke:" + color }, g);
        head(g, x2, y2, Math.sign(x2 - x1), Math.sign(y2 - y1), color);
        return line;
      };
      const typeBox = (g, x, y, color, type, amount) => {
        sv("rect", { x, y, width: 120, height: 36, rx: 10, style: fillOf(color) }, g);
        sv("text", { x: x + 60, y: y + 14, "text-anchor": "middle", class: "ts-chart-pill" }, g, tr("type." + type));
        sv("text", { x: x + 60, y: y + 29, "text-anchor": "middle", class: "ts-chart-pill b" }, g, amount);
      };
      const dot = (g, x, y, n) => { const d = sv("g", { class: "ts-stepdot" }, g); sv("circle", { cx: x, cy: y, r: 9 }, d); sv("text", { x, y: y + 4, "text-anchor": "middle" }, d, String(n)); };
      const account = (g, x, name) => {
        sv("rect", { x, y: 98, width: 120, height: 52, rx: 8, class: "ts-chart-acct" }, g);
        sv("text", { x: x + 8, y: 117, class: "ts-chart-muted" }, g, name);
        return sv("text", { x: x + 8, y: 140, class: "ts-chart-num" }, g, fmt(0));
      };
      // column A (moves left in step 2): income, savings account, investment
      p.colA = sv("g", { class: "ts-col" }, svg);
      p.income = fl(p.colA);
      typeBox(p.income, 100, 4, "var(--income)", "income", "+" + fmt(3500));
      dot(p.income, 98, 6, 1);
      p.incomeArrow = fl(p.colA); p.incomeLine = arrow(p.incomeArrow, 160, 42, 160, 96, "var(--income)");
      p.savings = fl(p.colA); p.savingsAmt = account(p.savings, 100, tr("scene.savings"));
      p.investArrow = fl(p.colA); p.investLine = arrow(p.investArrow, 160, 152, 160, 206, "var(--investment)");
      p.invest = fl(p.colA);
      typeBox(p.invest, 100, 208, "var(--investment)", "investment", "−" + fmt(500));
      dot(p.invest, 98, 210, 4);
      sv("text", { x: 160, y: 258, "text-anchor": "middle", class: "ts-chart-muted" }, p.invest, "→ " + tr("scene.platform"));
      // column B: credit card, its expense, and the transfer that pays it
      p.card = fl(svg); p.cardAmt = account(p.card, 186, tr("accounts.type.credit"));
      p.expenseArrow = fl(svg); p.expenseLine = arrow(p.expenseArrow, 246, 152, 246, 206, "var(--expense)");
      p.expense = fl(svg);
      typeBox(p.expense, 186, 208, "var(--expense)", "expense", "−" + fmt(120));
      dot(p.expense, 184, 210, 2);
      p.transferArrow = fl(svg); p.transferLine = arrow(p.transferArrow, 138, 124, 182, 124, "var(--transfer)");
      p.transfer = fl(svg);
      sv("line", { x1: 160, y1: 128, x2: 160, y2: 164, class: "ts-chart-stem" }, p.transfer);
      sv("rect", { x: 78, y: 164, width: 164, height: 28, rx: 10, style: fillOf("var(--transfer)") }, p.transfer);
      sv("text", { x: 160, y: 182, "text-anchor": "middle", class: "ts-chart-pill" }, p.transfer, tr("type.transfer") + " · " + fmt(120));
      dot(p.transfer, 78, 166, 3);
      // Net
      p.net = fl(svg);
      sv("rect", { x: 14, y: 274, width: 292, height: 32, rx: 10, class: "ts-chart-hub" }, p.net);
      sv("text", { x: 28, y: 295, class: "ts-chart-title" }, p.net, tr("summary.net"));
      p.netVal = sv("text", { x: 292, y: 295, "text-anchor": "end", class: "ts-chart-num" }, p.net, fmt(0));
      // the explanations, one more appearing at each step
      p.list = h("ol", "ts-captions", null, frame);
      p.caps = ["scene.flow.s1", "scene.flow.s2", "scene.flow.s3", "scene.flow.s4"].map((key, k) => { const li = h("li", null, null, p.list); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(key), li); return li; });
      return p;
    },
    initial(p) { lit(p.income); },   // the starting picture: only the Income box
    steps: [
      // 1 — Income: the box appears, then the savings account (at zero), the money flows in, Net appears
      (p, ctx, instant, later) => {
        step(p, 1, [p.income]);
        later(() => { lit(p.savings); lit(p.incomeArrow); run(p.incomeLine, true); }, 900);
        later(() => { setAmt(p.savingsAmt, p.fmt(3500)); lit(p.net); setAmt(p.netVal, p.fmt(3500)); }, 1900);
        later(() => run(p.incomeLine, false), 2600);
        return 3000;
      },
      // 2 — Expense: income and savings slide left, the credit card appears, pays an expense and goes negative; Net goes down
      (p, ctx, instant, later) => {
        step(p, 2, []);
        p.colA.classList.add("left");
        later(() => lit(p.card), 900);
        later(() => { lit(p.expense); lit(p.expenseArrow); run(p.expenseLine, true); }, 1800);
        later(() => { setAmt(p.cardAmt, "−" + p.fmt(120)); p.cardAmt.classList.add("neg"); lit(p.net); setAmt(p.netVal, p.fmt(3380)); }, 2700);
        later(() => run(p.expenseLine, false), 3400);
        return 3800;
      },
      // 3 — Transfer: savings pays the card; only the two accounts change, Net stays where it was (it stays dimmed)
      (p, ctx, instant, later) => {
        step(p, 3, [p.savings, p.card]);
        later(() => { lit(p.transfer); lit(p.transferArrow); run(p.transferLine, true); }, 600);
        later(() => { setAmt(p.savingsAmt, p.fmt(3380)); setAmt(p.cardAmt, p.fmt(0)); p.cardAmt.classList.remove("neg"); }, 1700);
        later(() => run(p.transferLine, false), 2400);
        return 2800;
      },
      // 4 — Investment: savings puts money into a platform; Net goes down. At the end everything is lit up.
      (p, ctx, instant, later) => {
        step(p, 4, [p.savings]);
        later(() => { lit(p.invest); lit(p.investArrow); run(p.investLine, true); }, 600);
        later(() => { setAmt(p.savingsAmt, p.fmt(2880)); lit(p.net); setAmt(p.netVal, p.fmt(2880)); }, 1700);
        later(() => run(p.investLine, false), 2400);
        later(() => p.els.forEach(lit), 3000);
        return 3400;
      }
    ]
  };
  // Step n begins: everything lit so far dims (so the eye goes to the new thing), `focus` stays fully lit, and the n-th explanation appears.
  function step(p, n, focus) {
    p.els.forEach((e) => { if (e.classList.contains("on")) e.classList.add("past"); });
    focus.forEach(lit);
    p.caps.forEach((li, k) => { if (k < n) li.classList.add("show"); li.classList.toggle("now", k === n - 1); });
  }
  function lit(e) { e.classList.add("on"); e.classList.remove("past"); }
  function run(line, on) { line.classList.toggle("run", on); }
  function setAmt(el, text) { el.textContent = text; el.classList.remove("ts-blink"); void el.getBoundingClientRect(); el.classList.add("ts-blink"); }

  // ---- Overview tab: this month's Income / Expenses / Investments / Net, then "By category" (pie + list); tap a category → its entries ----
  //      The made-up month: Income 3,500 − Expenses 1,920 − Investments 500 = Net 1,080 (the app's own formula).
  const PIE = {
    expense: [["🏠", "scene.cat.home", 700, "#f4a58f"], ["🛒", "scene.cat.groceries", 480, "#9cc5ec"], ["🍽️", "scene.cat.restaurants", 320, "#f7cf7a"], ["🚌", "scene.cat.transport", 260, "#9fd18a"], ["🛍️", "scene.cat.shopping", 160, "#c9a8ec"]],
    income: [["💰", "scene.cat.salary", 3200, "#7fcf9f"], ["💵", "scene.cat.extraIncome", 300, "#9cc5ec"]]
  };
  const monthIso = (day) => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0"); };

  SCENES.overview = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const phone = h("div", "ts-phone", null, stage);
      h("div", "ts-bar", tr("nav.overview"), phone);
      const clip = h("div", "ts-clip", null, phone);
      const scroll = h("div", "ts-scroll", null, clip);
      // period selector: ‹ month › and Month / Year / All-time / Custom
      const per = h("div", "ts-card", null, scroll);
      const sel = h("div", "ts-period", null, per);
      h("span", "ts-link", "‹", sel); h("b", null, ctx.period || "", sel); h("span", "ts-link", "›", sel);
      chipRow(per, [tr("period.month"), tr("period.year"), tr("period.alltime"), tr("period.custom")], 0);
      // the four totals
      const sum = h("div", "ts-card ts-sum", null, scroll);
      [["summary.income", 3500, "var(--income)"], ["summary.expenses", 1920, "var(--expense)"], ["summary.investments", 500, "var(--investment)"], ["summary.net", 1080, ""]].forEach(([k, v, color]) => {
        const c = h("div", null, null, sum);
        h("span", "ts-muted", tr(k), c);
        const val = h("b", "ts-sum-value", ctx.home + " " + ctx.money(v), c);
        if (color) val.style.color = color;
      });
      // By category
      const card = h("div", "ts-card", null, scroll);
      const tabs = h("div", "ts-seg", null, card);
      const p = { phone, scroll, card, finger: makeFinger(stage), ctx, sum };
      p.tabExpense = h("span", "on expense", tr("type.expense"), tabs);
      p.tabIncome = h("span", null, tr("type.income"), tabs);
      h("div", "ts-h3", tr("overview.byCategory"), card);
      p.wrap = h("div", "ts-pie-wrap", null, card);
      p.pie = h("div", "ts-pie", null, p.wrap);
      p.legend = h("div", "ts-legend", null, card);
      p.sheet = h("div", "ts-sheet", null, phone);
      p.draw = (type) => {
        const items = PIE[type], total = items.reduce((s, it) => s + it[2], 0), half = 65;
        p.wrap.querySelectorAll(".ts-pie-label").forEach((e) => e.remove());
        p.legend.innerHTML = "";
        let cum = 0; const stops = []; p.rows = [];
        items.forEach(([icon, key, amt, color]) => {
          const pct = amt / total * 100;
          stops.push(color + " " + cum + "% " + (cum + pct) + "%");
          if (pct >= 4) {   // the app labels slices of 4% and more outside the pie
            const a = (cum + pct / 2) / 100 * 2 * Math.PI, r = half * 0.82;
            const lab = h("div", "ts-pie-label", null, p.wrap);
            lab.style.left = (half + r * Math.sin(a)) + "px"; lab.style.top = (half - r * Math.cos(a)) + "px";
            const ic = h("span", "ts-pie-icon", icon, lab); ic.style.background = color;
            h("span", "ts-pie-pct", Math.round(pct) + "%", lab);
          }
          cum += pct;
          const row = h("div", "ts-legend-row", null, p.legend);
          const sw = h("span", "ts-legend-swatch", null, row); sw.style.background = color;
          const text = h("div", "ts-legend-text", null, row);
          h("div", "ts-legend-name", icon + " " + tr(key), text);
          const sub = h("div", "ts-legend-sub", null, text);
          h("span", null, ctx.home + " " + ctx.money(amt), sub); h("b", null, pct.toFixed(1) + "%", sub);
          p.rows.push(row);
        });
        p.pie.style.background = "conic-gradient(" + stops.join(", ") + ")";
      };
      p.draw("expense");
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      const scrollTo = (el) => { p.scroll.style.transform = "translateY(" + (-(el.offsetTop - 2)) + "px)"; };
      const tab = (type) => { p.tabExpense.className = type === "expense" ? "on expense" : ""; p.tabIncome.className = type === "income" ? "on income" : ""; p.draw(type); };
      const today = new Date().getDate();
      const rows = [[today, "scene.descShop", 210], [Math.max(1, Math.floor(today / 2)), null, 150], [1, null, 120]];
      return [
        [1200, () => scrollTo(p.card)],
        [2600, (i) => fg.to(p.tabIncome, i)],
        [3100, (i) => { fg.tap(i); tab("income"); }],
        [4300, (i) => fg.to(p.tabExpense, i)],
        [4800, (i) => { fg.tap(i); tab("expense"); }],
        [5800, (i) => fg.to(p.rows[1], i)],
        [6300, (i) => { fg.tap(i); p.rows[1].classList.add("on"); }],
        [6600, () => {
          const s = sheetOpen(p, "🛒 " + tr("scene.cat.groceries"));
          h("div", "ts-hint", (ctx.period || "") + " · " + tr("type.expense"), s);
          rows.forEach(([day, desc, amt]) => {
            const r = h("div", "ts-entry", null, s);
            const left = h("div", null, null, r);
            const t = h("div", "ts-entry-cat", null, left);
            const ic = h("span", "ts-entry-icon", "🛒", t); ic.style.background = "#9cc5ec";
            t.appendChild(document.createTextNode(tr("scene.cat.groceries")));
            if (desc) h("div", "ts-hint", tr(desc), left);
            h("div", "ts-hint", monthIso(day) + " · " + tr("common.me"), left);
            h("b", null, ctx.home + " " + ctx.money(amt), r);
          });
        }],
        [7500, () => fg.hide()],
        [10000, () => {}]
      ];
    }
  };

  // ---- Entries tab: a bank e-mail was read → "Needs review (1)" → pick the category → ✅ Confirm → it joins Recent entries ----
  SCENES.bank = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const phone = h("div", "ts-phone", null, stage);
      h("div", "ts-bar", tr("nav.home"), phone);
      const p = { phone, finger: makeFinger(stage), ctx };
      p.card = h("div", "ts-card ts-review", null, phone); p.card.hidden = true;
      h("b", null, tr("review.title") + " (1)", p.card);
      h("div", "ts-hint", tr("review.intro"), p.card);
      const top = h("div", "ts-review-top", null, p.card);
      const left = h("div", null, null, top);
      h("b", null, "Cafe Luna", left);
      h("div", "ts-hint", isoDay(0) + " · " + tr("type.expense").toLowerCase(), left);
      h("b", null, ctx.home + " " + ctx.money(48), top);
      p.category = box(p.card, "", tr("review.pickCategory"));
      p.category.box.querySelector(".ts-box-label").remove();
      const two = h("div", "ts-two", null, p.card);
      box(two, "", "Cafe Luna", "grow").box.querySelector(".ts-box-label").remove();
      box(two, "", "48", "grow").box.querySelector(".ts-box-label").remove();
      const btns = h("div", "ts-two", null, p.card);
      p.confirm = h("div", "ts-btn green grow", tr("review.confirm"), btns);
      h("div", "ts-btn ghost grow", tr("review.discard"), btns);
      const more = h("div", "ts-links", null, p.card);
      ["review.split", "review.markRepayment", "review.convertLoan"].forEach((k) => h("span", "ts-link", tr(k), more));
      const recent = h("div", "ts-list", null, phone);
      h("div", "ts-list-title", tr("entries.recent"), recent);
      p.rows = h("div", "ts-rows", null, recent);
      const addRow = (name, amt, enter) => {
        const r = h("div", "ts-row" + (enter ? " enter" : ""), null, null);
        h("span", "ts-row-name", name, r); h("span", "ts-row-amt", amt, r);
        p.rows.insertBefore(r, p.rows.firstChild);
        while (p.rows.children.length > 3) p.rows.removeChild(p.rows.lastChild);
      };
      addRow("🚌 " + tr("scene.cat.transport"), ctx.home + " " + ctx.money(6.5));
      addRow("🛒 " + tr("scene.cat.groceries"), ctx.home + " " + ctx.money(25.5));
      p.addRow = addRow;
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      return [
        [800, () => { p.card.hidden = false; p.card.classList.add("pop"); }],
        [2000, (i) => fg.to(p.category.box, i)],
        [2500, (i) => { fg.tap(i); p.category.box.classList.add("focus"); }],
        [3100, () => { p.category.value.textContent = tr("scene.cat.restaurants"); p.category.box.classList.remove("focus"); }],
        [3800, (i) => fg.to(p.confirm, i)],
        [4300, (i) => { fg.tap(i); p.confirm.classList.add("pressed"); }],
        [4600, () => { p.card.hidden = true; p.addRow("🍽️ " + tr("scene.cat.restaurants"), ctx.home + " " + ctx.money(48), true); }],
        [5400, () => fg.hide()]
      ];
    }
  };

  // ---- More → Bank emails: the bank e-mails you about a payment → the app lists it under "Needs review". Only what the app really does:
  //      the e-mail is read (nothing is invented about the bank's own screens) and the entry waits for the person's Confirm. ----
  SCENES.bankalerts = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const phone = h("div", "ts-phone", null, stage);
      const p = { ctx };
      p.mail = h("div", "ts-card ts-mail", null, phone); p.mail.hidden = true;
      h("span", "ts-mail-icon", "✉️", p.mail);
      const who = h("div", "ts-mail-who", null, p.mail);
      h("b", null, ctx.bank || tr("bankMail.title"), who);
      h("div", "ts-hint", "Cafe Luna", who);
      h("b", null, ctx.home + " " + ctx.money(48), p.mail);
      p.arrow = h("div", "ts-arrow", "↓", phone); p.arrow.hidden = true;
      p.card = h("div", "ts-card ts-review", null, phone); p.card.hidden = true;
      h("b", null, tr("review.title") + " (1)", p.card);
      const top = h("div", "ts-review-top", null, p.card);
      const left = h("div", null, null, top);
      h("b", null, "Cafe Luna", left);
      h("div", "ts-hint", isoDay(0) + " · " + tr("type.expense").toLowerCase(), left);
      h("b", null, ctx.home + " " + ctx.money(48), top);
      const btns = h("div", "ts-two", null, p.card);
      h("div", "ts-btn green grow", tr("review.confirm"), btns);
      h("div", "ts-btn ghost grow", tr("review.discard"), btns);
      return p;
    },
    timeline(p) {
      return [
        [500, () => { p.mail.hidden = false; p.mail.classList.add("pop"); }],
        [1600, () => { p.arrow.hidden = false; }],
        [2000, () => { p.card.hidden = false; p.card.classList.add("pop"); }],
        [4200, () => {}]
      ];
    }
  };

  // The STARTING picture of a scene, with no timers and no motion (owner: do not spoil the ending): used to show every card of the swipeable
  // tour already filled in, so nothing looks empty while a swipe is under way. (The card that is on screen plays its scene with play().)
  function preview(key, stage, ctx) {
    const scene = SCENES[key];
    stage.onclick = null;
    if (!scene) { stage.hidden = true; stage.innerHTML = ""; return false; }
    stage.hidden = false; stage.innerHTML = "";
    const parts = scene.build(stage, ctx);
    if (scene.manual) {
      if (scene.initial) scene.initial(parts, ctx);   // e.g. the first box that appears
      const bar = h("div", "ts-stepper", null, stage);
      const btn = h("button", "ts-step-btn", ctx.tr("tour.nextStep"), bar);
      btn.type = "button"; btn.disabled = true;   // same height as the playing scene; it only becomes usable when the card is on screen
    }
    return true;
  }

  root.TourScenes = { play, preview, stop, has: (key) => !!SCENES[key] };
})(typeof window !== "undefined" ? window : this);
