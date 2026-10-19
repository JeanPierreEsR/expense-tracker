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

  function play(key, stage, ctx) {
    stop();
    const scene = SCENES[key];
    if (!scene) { stage.hidden = true; stage.innerHTML = ""; return false; }
    stage.hidden = false;
    const reduce = !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
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

  // The Entries tab: type tabs, a category grid, and (after a category is tapped) the entry form.
  function entriesPhone(stage, ctx, type, form) {
    const tr = ctx.tr;
    const phone = h("div", "ts-phone", null, stage);
    h("div", "ts-bar", tr("nav.entries"), phone);
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
    const recent = h("div", "ts-list", null, gridView);
    h("div", "ts-list-title", tr("entries.recent"), recent);
    const rows = h("div", "ts-rows", null, recent);
    const addRow = (name, amt, enter, dot) => {
      const r = h("div", "ts-row" + (enter ? " enter" : ""), null, null);
      const nm = h("span", "ts-row-name", null, r);
      if (dot) { const d = h("span", "ts-dot", null, nm); d.style.background = dot; }
      nm.appendChild(document.createTextNode(name));
      h("span", "ts-row-amt", amt, r);
      rows.insertBefore(r, rows.firstChild);
      while (rows.children.length > 3) rows.removeChild(rows.lastChild);
    };
    addRow("🚌 " + tr("scene.cat.transport"), ctx.home + " " + ctx.money(6.5));
    addRow("🍽️ " + tr("scene.cat.restaurants"), ctx.home + " " + ctx.money(48));
    const formView = h("div", "ts-view ts-form", null, phone);
    formView.hidden = true;
    return { phone, tabs, gridView, formView, fillGrid, get tiles() { return tiles; }, set tiles(v) { tiles = v; }, addRow, finger: makeFinger(stage), ctx };
  }
  const typeOn = (p, t) => Object.keys(p.tabs).forEach((k) => { p.tabs[k].className = "ts-pill" + (k === t ? " on " + t : ""); });
  const showForm = (p, on) => { p.gridView.hidden = on; p.formView.hidden = !on; };
  const typing = (el, parts) => parts.map((txt, i) => (inst) => { el.textContent = txt; });

  // ---- add an expense or income: type tab -> category -> the form's fields -> Save entry ----
  SCENES.add = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = entriesPhone(stage, ctx, "expense");
      const f = p.formView;
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
      p.save = h("div", "ts-btn", tr("entry.save"), f);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
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
        [8800, (i) => { p.methodBox.box.classList.remove("focus"); fg.to(p.save, i); }],
        [9300, (i) => { fg.tap(i); p.save.classList.add("pressed"); }],
        [9600, (i) => { p.save.classList.remove("pressed"); showForm(p, false); p.tiles[0].classList.remove("on"); p.addRow("🛒 " + tr("scene.cat.groceries"), ctx.home + " " + ctx.money(25.5), true); }],
        [10200, () => fg.hide()]
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

  root.TourScenes = { play, stop, has: (key) => !!SCENES[key] };
})(typeof window !== "undefined" ? window : this);
