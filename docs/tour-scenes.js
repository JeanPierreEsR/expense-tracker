// Small animated pictures for the welcome tour (and More → How to use the app), plus the Bank emails sheet's picture.
//
// A tour card only says that a feature exists (owner, 2026-11-14): its picture shows the RESULT of the feature (the new entry in the
// list, the budget bar filling, the friend's balance, the split bill…), as a short loop with no finger and no steps. How to use a
// feature is taught by the real tutorials, practices and bubbles, on the real screens.
//
// One tiny engine plays any number of scenes. A scene is just data:
//   build(stage, ctx)    -> draws the starting picture and returns handles to its parts
//   timeline(parts, ctx) -> [[milliseconds, fn(instant)], …]; fn does one thing (a row arrives, a bar fills, the page glides…)
//   hold                 -> pause before the scene loops
// Every screen is drawn with the APP'S OWN PIECES (owner, 2026-11-13): its own classes at its real size (a 390 px wide phone screen),
// then shrunk to fit the card, so a picture follows any change to the app's look by itself. The pieces that never depend on the
// scene (the tab bar, the More tab, the My data hub) are copied from the live app itself. The words are the app's own (tr). Nothing
// inside a picture can be tapped: a tap on the picture replays it. With "reduce motion" on, only the final picture is shown.
// ctx = { tr, home, money, period, restore, icon }  (the tour passes the app's own helpers; icon(name) draws one of its line icons).
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

  // The animation never makes its card shorter while it plays (owner, 2026-11-14): when a scene looped it was emptied and rebuilt,
  // the card shrank for an instant and the phone pulled the person reading below it back up to the animation. The stage keeps the
  // tallest height it has had for this scene, so nothing under it moves and the page never scrolls by itself.
  function holdHeight(stage, key) {
    if (stage.dataset.tsKey !== key) { stage.dataset.tsKey = key; stage.style.minHeight = ""; }
    if (stage._tsHold) return;
    const grow = () => { const hgt = stage.offsetHeight; if (hgt > (parseFloat(stage.style.minHeight) || 0)) stage.style.minHeight = hgt + "px"; };
    stage._tsHold = root.ResizeObserver ? new ResizeObserver(grow) : null;
    if (stage._tsHold) stage._tsHold.observe(stage);
  }

  function play(key, stage, ctx) {
    stop();
    const scene = SCENES[key];
    if (!scene) { stage.hidden = true; stage.innerHTML = ""; return false; }
    stage.hidden = false;
    holdHeight(stage, key);
    const reduce = !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const run = () => {
      stage.innerHTML = "";
      const parts = scene.build(stage, ctx);
      const steps = scene.timeline(parts, ctx);
      if (reduce) { steps.forEach((s) => s[1](true)); return; }
      let end = 0;
      // The first picture is drawn at once (design review 2026-11-12: a card opened blank for about a second while the first
      // step waited for its timer); the rest plays on its timeline.
      const first = steps.reduce((m, s) => Math.min(m, s[0]), Infinity);
      steps.forEach((s) => {
        end = Math.max(end, s[0]);
        if (s[0] === first) s[1](true);
        else timers.push(setTimeout(() => s[1](false), s[0]));
      });
      // ctx.onEnd: told once, when the first run has played to its end (the tour's first card then hints that swiping goes on)
      if (ctx.onEnd && !ended) timers.push(setTimeout(() => { if (!ended) { ended = true; ctx.onEnd(); } }, end + 400));
      timers.push(setTimeout(run, end + (scene.hold || 1500)));
    };
    let ended = false;
    run();
    stage.onclick = () => play(key, stage, ctx);   // tap to replay
    return true;
  }

  // ------------------------------------------------------------------
  // RULE: a scene may only show things the app really does and says (its own screens, labels and numbers). No invented
  // banners, badges or messages. Draw with the app's own classes (below), never with look-alikes: then a change to the app's
  // look reaches the pictures by itself. When a screen's LAYOUT changes in the app, check its scene.
  // ------------------------------------------------------------------

  // ---- The app's own pieces -------------------------------------------------------------------------------------------------------------
  const APP_W = 390;   // the app's design width; the picture is drawn at this size and shrunk to the card
  const svg_ = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  // The round header buttons' icons, as index.html draws them.
  const BTN_ICON = { plus: '<path d="M12 5v14M5 12h14"/>', back: '<path d="M15 18l-6-6 6-6"/>', pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>' };
  function iconBtn(parent, name, cls) { const b = h("span", "icon-btn" + (cls ? " " + cls : ""), null, parent); b.innerHTML = svg_(BTN_ICON[name]); return b; }
  // A line icon in front of a link or a title (the app's own set).
  function ico(ctx, name, parent) { const s = h("span", "ico link-ico", null, null); s.innerHTML = ctx.icon ? ctx.icon(name) : ""; if (parent) parent.insertBefore(s, parent.firstChild); return s; }
  // A copy of a live piece of the app is only a picture: no ids, labels' targets or translation hooks of its own.
  function strip(el) {
    [el].concat(Array.from(el.querySelectorAll("*"))).forEach((e) => {
      ["id", "for", "data-i18n", "data-i18n-aria-label", "data-i18n-placeholder", "data-screen", "tabindex", "role", "aria-controls"].forEach((a) => e.removeAttribute(a));
    });
    return el;
  }

  // A phone screen at the app's real size: the app's header, the screen's content (p.scroll, which can glide up like a page),
  // the tab bar copied from the app with the right tab lit, and the round "+" where Home has it. o = { nav, fab, h, header }.
  function device(stage, ctx, o) {
    o = o || {};
    const H = o.h || 540;
    const k = Math.min(1, (stage.clientWidth || 320) / APP_W);
    const frame = h("div", "ts-device", null, stage);
    frame.style.height = Math.round(H * k) + "px";
    const app = h("div", "ts-app", null, frame);
    app.style.height = H + "px";
    app.style.transform = "scale(" + k + ")";
    if (o.header !== false) { const hd = h("header", null, null, app); h("h1", null, ctx.tr("app.title"), hd); }
    const main = h("div", "ts-main", null, app);
    const scroll = h("div", "ts-scroll", null, main);
    let nav = null;
    if (o.nav) {
      const real = document.getElementById("bottom-nav");
      if (real) {
        nav = real.cloneNode(true);
        nav.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.screen === o.nav));
        app.appendChild(strip(nav));
      }
    }
    const fab = o.fab ? h("div", "fab", "+", app) : null;
    return { stage, frame, app, main, scroll, nav, fab, k, ctx };
  }
  // Glide the page (or a sheet's body) so `el` sits near the top, never past the end, as a finger scrolling would.
  function glide(box, inner, el, k, pad) {
    if (!el) { inner.style.transform = ""; return; }
    const y = (el.getBoundingClientRect().top - inner.getBoundingClientRect().top) / k - (pad == null ? 8 : pad);
    const max = Math.max(0, inner.scrollHeight - box.clientHeight);
    inner.style.transform = "translateY(" + (-Math.max(0, Math.min(max, y))) + "px)";
  }
  const scrollTo = (p, el, pad) => glide(p.main, p.scroll, el, p.k, pad);
  const sheetScrollTo = (p, el, pad) => { if (p.sh) glide(p.sh.clip, p.sh.body, el, p.k, pad); };

  // A pop-up sheet: the app's own sheet (header with ✕, body), already open over the screen. o = { tall, foot } — foot: a button pinned at the bottom.
  function sheetOpen(p, title, o) {
    o = o || {};
    const back = h("div", "ts-sheet show", null, p.app);
    const m = h("div", "currency-modal" + (o.tall ? " ts-tall" : ""), null, back);
    const hd = h("div", "currency-modal-header", null, m);
    h("span", null, title, hd); h("span", "currency-modal-close", "✕", hd);
    const clip = h("div", "ts-sheet-clip", null, m);
    const body = h("div", "budget-modal-body ts-sheet-body", null, clip);
    const foot = o.foot ? h("div", "ts-sheet-foot", null, m) : null;
    p.sh = { back, modal: m, head: hd, clip, body, foot };
    return body;
  }

  // A field as the app draws it: its label and its box.
  function box(parent, label, value) {
    const w = h("div", "ts-field", null, parent);
    if (label) h("label", null, label, w);
    const i = h("input", null, null, w); i.type = "text"; i.readOnly = true; i.tabIndex = -1;
    i.value = value || "";
    return w;
  }
  function seg(parent, labels, on) {
    const row = h("div", "type-tabs budget-period-tabs", null, parent);
    row.style.gridTemplateColumns = "repeat(" + labels.length + ", 1fr)";
    return labels.map((l, i) => h("div", "type-tab" + (i === on ? " active" : ""), l, row));
  }
  function tags(parent, labels) { const row = h("div", "tags-list", null, parent); return labels.map((l) => h("div", "tag-chip", l, row)); }
  function primary(parent, text) { const b = h("button", "primary", text, parent); b.type = "button"; b.tabIndex = -1; return b; }
  function link(parent, ctx, iconName, text) { const a = h("div", "add-inline", text, parent); ico(ctx, iconName, a); return a; }

  // A card with the app's card header: a title, and the round buttons on the right.
  function cardHead(parent, title, buttons) {
    const card = h("div", "card", null, parent);
    const hd = h("div", "budgets-header", null, card);
    const t = h("h2", null, title, hd);
    const acts = h("span", "friends-header-actions", null, hd);
    (buttons || []).forEach((b) => iconBtn(acts, b));
    return { card, title: t };
  }
  // A More sub-screen at its top: the card with Back, its buttons and the title (the tab bar shows More).
  function subScreen(stage, ctx, title, buttons) {
    const p = device(stage, ctx, { nav: "more" });
    const card = h("div", "card", null, p.scroll);
    const hd = h("div", "budgets-header", null, card);
    iconBtn(hd, "back", "back-btn");
    const acts = h("span", "friends-header-actions", null, hd);
    (buttons || ["plus"]).forEach((b) => iconBtn(acts, b));
    h("h2", "screen-title", title, card);
    p.card = card;
    return p;
  }

  // Dates as the app writes them.
  const fmtDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return root.I18n ? root.I18n.fmtDateMedium(d) : d.toDateString(); };
  const out = (ctx, n) => "−" + ctx.home + " " + ctx.money(n);
  const inc = (ctx, n) => "+" + ctx.home + " " + ctx.money(n);

  // Categories as the app draws them: a round coloured icon and the name.
  const CATS = {
    groceries: ["🛒", "scene.cat.groceries", "#C9E4F7"], transport: ["🚌", "scene.cat.transport", "#FFE0B2"], restaurants: ["🍽️", "scene.cat.restaurants", "#E0D9F7"],
    home: ["🏠", "scene.cat.home", "#F7D9C4"], shopping: ["🛍️", "scene.cat.shopping", "#F7C6D9"], salary: ["💰", "scene.cat.salary", "#D9F2D9"],
    extraIncome: ["💵", "scene.cat.extraIncome", "#D9F7F0"]
  };
  function catIcon(parent, key, cls) { const [icon, , bg] = CATS[key]; const i = h("span", cls, icon, parent); i.style.background = bg; return i; }

  // Home's "Recent entries" card: entries grouped by day, as the app lists them.
  function entriesCard(parent, ctx) {
    const c = cardHead(parent, ctx.tr("entries.recent"), ["pencil"]);
    c.card.classList.add("entry-list");
    const list = h("div", null, null, c.card);
    const day = h("div", "day-head", null, list);
    h("span", null, ctx.tr("scene.today"), day);
    const total = h("span", "day-total", "", day);
    let net = 0;
    const add = (o, enter) => {
      const r = h("div", "entry" + (enter ? " ts-enter" : ""), null, null);
      const l = h("div", "entry-left", null, r);
      const cat = h("div", "entry-category", null, l);
      if (o.dot) { const d = h("span", "type-dot", null, cat); d.dataset.type = o.dot; }
      else catIcon(cat, o.cat, "entry-cat-icon");
      cat.appendChild(document.createTextNode(o.name || ctx.tr(CATS[o.cat][1])));
      if (o.desc) h("div", "entry-desc", o.desc, l);
      h("div", "entry-meta", fmtDay(0) + " · " + ctx.tr("common.me"), l);
      const a = h("div", "entry-amount", null, r);
      h("span", "primary-amt" + (o.sign === "+" ? " income" : ""), o.amt, a);
      if (o.sub) h("span", "original-amt", o.sub, a);
      day.after(r);
      if (o.net) { net += o.net; total.textContent = (net < 0 ? "−" : "+") + ctx.home + " " + ctx.money(Math.abs(net)); }
      return r;
    };
    return { card: c.card, add };
  }
  // Home with two entries; `then` is the new entry that arrives in the list (the result of the + form).
  function homeArrives(then) {
    return {
      hold: 4000,   // the result stays up long enough to read before the loop starts again
      build(stage, ctx) {
        const p = device(stage, ctx, { nav: "entries", fab: true });
        p.list = entriesCard(p.scroll, ctx);
        p.list.add({ cat: "transport", amt: out(ctx, 6.5), net: -6.5 });
        p.list.add({ cat: "restaurants", amt: out(ctx, 48), net: -48 });
        return p;
      },
      timeline(p, ctx) { return [[0, () => {}], [700, () => p.list.add(then(ctx), true)]]; }
    };
  }

  // ---- Record an expense or income: the new expense arrives in Home's list ----
  SCENES.add = homeArrives((ctx) => ({ cat: "groceries", desc: ctx.tr("scene.descShop"), amt: out(ctx, 25.5), net: -25.5 }));
  // ---- An investment: it arrives in the list as money out to the platform ----
  SCENES.invest = homeArrives((ctx) => ({ dot: "investment", name: ctx.tr("entry.investmentIn", { platform: ctx.tr("scene.platform") }), amt: out(ctx, 500), net: -500 }));
  // ---- A transfer between your own accounts: no sign, and the day's total does not change ----
  SCENES.transfer = homeArrives((ctx) => ({ dot: "transfer", name: ctx.tr("scene.debit") + " → " + ctx.tr("scene.savings"), amt: ctx.home + " " + ctx.money(200) }));

  // ---- Programmed income/expenses: the known amounts are listed ----
  function listRow(parent, name, sub, amount, amountSub, enter) {
    const r = h("div", "recurring-row" + (enter ? " ts-enter" : ""), null, parent);
    const l = h("div", null, null, r);
    h("div", "recurring-row-name", name, l);
    if (sub) h("div", "recurring-row-sub", sub, l);
    const a = h("div", "recurring-row-amount", null, r);
    h("span", "primary-amt", amount, a);
    if (amountSub) h("span", "original-amt", amountSub, a);
    return r;
  }
  SCENES.programmed = {
    hold: 2200,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = subScreen(stage, ctx, tr("recurring.title"));
      h("p", "hint", tr("recurring.intro"), p.card);
      h("h3", "accounts-group-title", tr("recurring.recurring"), p.card);
      p.rows = h("div", null, null, p.card);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr;
      return [
        [0, () => {}],
        [600, () => listRow(p.rows, CATS.home[0] + " " + tr("scene.rent"), tr("recurring.freqMonthly", { day: 5 }), out(ctx, 1200), null, true)],
        [1400, () => listRow(p.rows, CATS.salary[0] + " " + tr("scene.cat.salary"), tr("recurring.freqMonthly", { day: 30 }), inc(ctx, 3500), null, true)]
      ];
    }
  };

  // ---- Trips & events: the trip's own screen — your share in total, the budget bar filling, Before / During / After ----
  SCENES.trips = {
    hold: 2400,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home, name = tr("scene.tripName");
      const start = fmtDay(-10), end = fmtDay(-5);
      const p = subScreen(stage, ctx, tr("trips.title"), ["pencil", "plus"]);
      const s = sheetOpen(p, "✈️ " + name, { tall: true });
      h("p", "hint", tr("trips.kind.trip") + " · " + tr("trips.dateRange", { start, end }), s);
      h("div", "trip-total ts-big", cur + " " + ctx.money(1250), s);
      h("p", "hint", tr("trips.total") + " · " + tr("trips.entryCount", { n: 6 }), s);
      const track = h("div", "budget-progress-track", null, s);
      p.fill = h("div", "budget-progress-fill", null, track);
      const sub = h("div", "budget-row-sub", null, s); h("span", null, tr("trips.budgetLeft", { cur, amount: ctx.money(750) }), sub); h("span", null, tr("trips.ofBudget", { cur, amount: ctx.money(2000) }), sub);
      const ph = h("div", "ts-phases", null, s);
      [["trips.before", 400], ["trips.during", 850], ["trips.after", 0]].forEach(([k, v]) => { const c = h("div", "ts-phase", null, ph); h("span", "summary-label", tr(k), c); h("b", null, cur + " " + ctx.money(v), c); });
      h("p", "hint", tr("trips.phaseHint"), s);
      return p;
    },
    timeline(p) { return [[0, () => { p.fill.style.width = "0%"; }], [500, () => { p.fill.style.width = "62.5%"; }]]; }
  };

  // ---- Money with friends: the friend's share arrives in the Loans tab's "Owes you" card ----
  SCENES.friends = {
    hold: 2200,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = device(stage, ctx, { nav: "loans" });
      const c = cardHead(p.scroll, tr("loans.owesYou"), ["plus"]);
      p.totalRow = h("div", "budgets-summary-row", null, c.card); p.totalRow.hidden = true;
      h("span", "budgets-summary-label", tr("loans.totalOwed"), p.totalRow);
      p.total = h("span", "loan-total-values income", "", p.totalRow);
      p.list = h("div", null, null, c.card);
      p.empty = h("p", "hint", tr("loans.noneOwed"), c.card);
      return p;
    },
    timeline(p, ctx) {
      return [[0, () => {}], [700, () => {
        p.empty.hidden = true; p.totalRow.hidden = false;
        const r = h("div", "loan-row ts-enter", null, p.list);
        h("span", "loan-row-name", "Ana", r);
        h("span", "loan-row-amount owed-to-me", inc(ctx, 12.75), r);
        p.total.textContent = inc(ctx, 12.75);
      }]];
    }
  };

  // ---- Budgets tab: the bar fills as you spend; orange from 75%, red at 100% (the app's own rule, no extra messages) ----
  SCENES.budgets = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = device(stage, ctx, { nav: "budgets" });
      const c = cardHead(p.scroll, tr("nav.budgets"), ["pencil", "plus"]);
      const row = (key, pctInit) => {
        const r = h("div", "budget-row", null, c.card);
        const top = h("div", "budget-row-top", null, r);
        h("div", "budget-row-name", CATS[key][0] + " " + tr(CATS[key][1]), top); h("span", "budget-row-period", tr("budget.thisMonth"), top);
        const track = h("div", "budget-progress-track", null, r); const fill = h("div", "budget-progress-fill", null, track);
        const sub = h("div", "budget-row-sub", null, r);
        const spent = h("span", null, "", sub); const pct = h("span", "budget-row-pct", "", sub);
        if (pctInit != null) fill.style.width = pctInit + "%";
        return { r, fill, spent, pct };
      };
      p.main_ = row("groceries");
      const other = row("transport", 32);
      other.spent.textContent = ctx.home + " " + ctx.money(128) + " / " + ctx.home + " " + ctx.money(400); other.pct.textContent = "32%";
      p.limit = 400;
      return p;
    },
    timeline(p, ctx) {
      const set = (value) => () => {
        const share = value / p.limit * 100, m = p.main_;
        m.fill.style.width = Math.min(100, share) + "%";
        m.fill.classList.toggle("warn", share >= 75 && share < 100);   // the app's rule: orange from 75%, red from 100%
        m.fill.classList.toggle("over", share >= 100);
        m.spent.textContent = ctx.home + " " + ctx.money(value) + " / " + ctx.home + " " + ctx.money(p.limit);
        m.pct.textContent = Math.round(share) + "%";
      };
      return [[0, set(0)], [500, set(80)], [800, set(160)], [1900, set(240)], [2200, set(320)], [3300, set(420)], [4800, () => {}]];
    }
  };

  // ---- Projections tab: the projected totals, then the page glides to the categories with their Confirmed / Programmed / Expected lines ----
  SCENES.projections = {
    hold: 1500,
    build(stage, ctx) {
      const tr = ctx.tr;
      const money = (n) => ctx.home + " " + ctx.money(n);
      const now = new Date(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const left = Math.min(dim - 4, Math.max(4, dim - now.getDate())), frac = left / dim;   // the days still to come this month
      const cats = [
        { key: "groceries", actual: Math.round(600 * (1 - frac) * 1.1), prog: 0, exp: Math.round(600 * frac) },
        { key: "home", actual: 0, prog: 1500, exp: 0 },
        { key: "restaurants", actual: Math.round(300 * (1 - frac) * 0.9), prog: 0, exp: Math.round(300 * frac) }
      ];
      cats.forEach((c) => { c.total = c.actual + c.prog + c.exp; });
      const add = (k) => cats.reduce((s, c) => s + c[k], 0);
      const income = 3500, invest = 500, expenses = add("total");
      const p = device(stage, ctx, { nav: "projections", h: 600 });
      const top = h("div", "card", null, p.scroll);
      h("h2", null, tr("nav.projections"), top);
      h("p", "hint", tr("projections.projectedFor", { period: ctx.period || "" }), top);
      const sum = h("div", "summary-grid", null, top);
      [["summary.income", "+" + money(income), "income"], ["summary.expenses", "−" + money(expenses), "expense"], ["summary.investments", "−" + money(invest), "investment"],
        ["projections.netMonthEnd", "+" + money(income - expenses - invest), ""]].forEach(([k, v, cls]) => {
        const c = h("div", "summary-item", null, sum);
        h("span", "summary-label", tr(k), c);
        h("span", "summary-value" + (cls ? " " + cls : ""), v, c);
      });
      h("p", "projections-breakdown", tr("projections.lineIncome", { actual: money(income), programmed: money(0) }), top);
      h("p", "projections-breakdown", tr("projections.lineExpenses", { actual: money(add("actual")), programmed: money(add("prog")), expected: money(add("exp")) }), top);
      p.list = h("div", "card", null, p.scroll);
      h("h2", null, tr("overview.byCategory"), p.list);
      cats.forEach((c) => {
        const row = h("div", "recurring-row projection-row-expanded", null, p.list);
        const t = h("div", "projection-row-top", null, row);
        h("div", "recurring-row-name", CATS[c.key][0] + " " + tr(CATS[c.key][1]), t); h("div", "recurring-row-amount", "−" + money(c.total), t);
        const lines = h("div", "projection-row-breakdown", null, row);
        const line = (icon, amount, label) => { const l = h("div", null, null, lines); h("span", "projection-line-icon", icon, l); h("span", "projection-line-amount", money(amount), l); h("span", "projection-line-label", label, l); };
        line("✅", c.actual, tr("projections.actual")); line("🔁", c.prog, tr("projections.programmed")); line("📈", c.exp, tr("projections.expected"));
      });
      return p;
    },
    timeline(p) { return [[0, () => scrollTo(p, null)], [2200, () => scrollTo(p, p.list)], [5200, () => {}]]; }
  };

  // ---- Split a restaurant bill: the split worked out — each dish with who shared it, the ✓ against the bill's total, what each person
  //      pays. Every number comes from the app's own BillSplit maths and every line of text from its own strings. ----
  const BILL_NAMES = { ana: "Ana", luis: "Luis" };
  function billRecompute(p) {
    const tr = p.ctx.tr, fmt = p.fmt;
    const people = ["me"].concat(Object.keys(BILL_NAMES));
    const res = root.BillSplit.compute({
      people,
      items: p.items.map((it, k) => ({ id: k, name: it.name, people: it.people, price: it.price })),
      adjustments: [],
      tip: { type: "percent", mode: "proportional", value: "10" },
      printedTotal: "120.00"
    });
    const counted = tr("bill.counted", { items: fmt(res.itemsCents) });
    if (res.diffCents === 0) { p.check.classList.add("ts-ok"); p.check.textContent = tr("bill.checkOk", { counted, printed: fmt(res.printedCents) }); }
    p.tipPreview.textContent = tr("bill.tipPctOf", { pct: "10", bill: fmt(res.billCents), tip: fmt(res.tipCents), odd: "" });
    people.forEach((k) => {
      const pp = res.perPerson[k], row = h("div", "ts-bill-resrow", null, p.results);
      const left = h("div", null, null, row);
      h("div", null, k === "me" ? tr("common.me") : BILL_NAMES[k], left);
      h("div", "hint", [tr("bill.subItems", { v: p.ctx.money(pp.items / 100) }), tr("bill.subTip", { v: p.ctx.money(pp.tip / 100) })].join(" · "), left);
      h("b", null, fmt(pp.total), row);
    });
    h("div", "hint", tr("bill.tipTotal", { tip: fmt(res.tipCents), total: fmt(res.grandCents) }), p.results);
  }
  SCENES.bill = {
    hold: 2400,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home;
      const p = device(stage, ctx, { nav: "entries", h: 600 });
      p.ctx = ctx;
      p.fmt = (cents) => cur + " " + ctx.money(cents / 100);
      const S = sheetOpen(p, tr("bill.title"), { tall: true, foot: true });
      box(S, tr("bill.totalBefore") + " (" + cur + ")", "120.00");
      h("label", null, tr("bill.who"), S);
      tags(S, Object.values(BILL_NAMES)).forEach((t) => t.classList.add("selected"));
      p.itemsLabel = h("label", null, tr("bill.items"), S);
      p.items = [["Ceviche", "40.00", ["me", "ana"]], ["Lomo saltado", "32.00", ["me"]], ["Pasta", "28.00", ["ana"]], ["Pizza", "20.00", ["luis"]]].map(([name, price, who]) => {
        const it = { name, price, people: who };
        const row = h("div", "ts-bill-item", null, S);
        const ln = h("div", "ts-bill-line", null, row); h("b", null, name, ln); h("span", "ts-bill-price", price, ln);
        const cs = h("div", "tags-list", null, row);
        [["me", tr("common.me")], ["ana", "Ana"], ["luis", "Luis"]].forEach(([key, label]) => { const c = h("div", "tag-chip", label, cs); if (who.includes(key)) c.classList.add("selected"); });
        return it;
      });
      p.check = h("p", "hint", null, S);
      h("label", null, tr("bill.tip"), S);
      p.tipPreview = h("p", "hint", null, S);
      p.results = h("div", "ts-bill-res", null, S);
      primary(p.sh.foot, tr("bill.apply"));
      billRecompute(p);
      return p;
    },
    timeline(p) {
      return [
        [0, () => { sheetScrollTo(p, p.itemsLabel); p.results.classList.remove("ts-now"); }],
        [2200, () => sheetScrollTo(p, p.check)],
        [3600, () => sheetScrollTo(p, p.results, 120)],
        [4200, () => p.results.classList.add("ts-now")],
        [6000, () => {}]
      ];
    }
  };

  // ---- The More tab: a copy of the person's own More tab (its rows, groups, icons and words, the language picker at the bottom);
  //      the page glides down to the language picker and back up. ----
  SCENES.more = {
    hold: 2000,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "more" });
      const real = document.getElementById("screen-more");
      if (real) Array.from(real.children).forEach((c) => { if (!c.hidden && c.classList.contains("card")) p.scroll.appendChild(strip(c.cloneNode(true))); });
      p.lang = p.scroll.querySelector("select") || p.scroll.lastElementChild;
      return p;
    },
    timeline(p) { return [[0, () => scrollTo(p, null)], [1200, () => scrollTo(p, p.lang, 300)], [3800, () => scrollTo(p, null)], [5200, () => {}]]; }
  };

  // ---- More → My data: a copy of the person's own hub (its headings, rows, icons and words; Recently deleted only where the app shows
  //      it). Each row lights up in turn. ----
  SCENES.mydata = {
    hold: 1500,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "more" });
      const real = document.querySelector("#screen-my-data .card");
      if (real) p.scroll.appendChild(strip(real.cloneNode(true)));
      p.rows = Array.from(p.scroll.querySelectorAll(".md-row:not([hidden])"));
      return p;
    },
    timeline(p) {
      // A row that lights up below the visible part of the screen (above the tab bar) slides into view, a third of the way down, so
      // the next rows fit too and the page moves only when needed; at the end the page goes back to the top for the next loop.
      const lit = (r) => () => {
        p.rows.forEach((m) => m.classList.toggle("ts-lit", m === r));
        if (!r) { scrollTo(p, null); return; }
        const view = p.main.getBoundingClientRect();
        if (r.getBoundingClientRect().bottom > view.bottom - 4) scrollTo(p, r, Math.round(view.height / p.k / 3));
      };
      const steps = [[0, lit(null)]];
      p.rows.forEach((r, k) => steps.push([600 + k * 1000, lit(r)]));
      steps.push([600 + p.rows.length * 1000, lit(null)]);
      return steps;
    }
  };

  // ---- The big picture, as a flow chart: income lands in savings, a card pays an expense, savings pays the card (a transfer: the Result
  //      does not change), savings puts money into a platform (an investment). Result = income − expenses − investments (Overview's own
  //      formula). Platforms are never in Balances. (A diagram, not a screen: it is drawn as a chart, in the app's colours.)
  const SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function lit(e) { e.classList.add("on"); }
  function run(line, on) { line.classList.toggle("run", on); }
  function setAmt(el, text) { el.textContent = text; el.classList.remove("ts-blink"); void el.getBoundingClientRect(); el.classList.add("ts-blink"); }
  SCENES.flow = {
    hold: 2600,
    build(stage, ctx) {
      const tr = ctx.tr, fmt = (v) => ctx.home + " " + ctx.money(v);
      const frame = h("div", "ts-chartframe", null, stage);
      const svg = sv("svg", { viewBox: "0 0 320 312", class: "ts-chart-svg" }, frame);
      const p = { ctx, fmt, svg };
      const fillOf = (c) => "fill:" + c;
      const fl = (parent) => sv("g", { class: "ts-fl" }, parent);
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
      const account = (g, x, name) => {
        sv("rect", { x, y: 98, width: 120, height: 52, rx: 8, class: "ts-chart-acct" }, g);
        sv("text", { x: x + 8, y: 117, class: "ts-chart-muted" }, g, name);
        return sv("text", { x: x + 8, y: 140, class: "ts-chart-num" }, g, fmt(0));
      };
      // column A (moves left once the card appears): income, savings account, investment
      p.colA = sv("g", { class: "ts-col" }, svg);
      p.income = fl(p.colA);
      typeBox(p.income, 100, 4, "var(--income)", "income", "+" + fmt(3500));
      p.incomeArrow = fl(p.colA); p.incomeLine = arrow(p.incomeArrow, 160, 42, 160, 96, "var(--income)");
      p.savings = fl(p.colA); p.savingsAmt = account(p.savings, 100, tr("scene.savings"));
      p.investArrow = fl(p.colA); p.investLine = arrow(p.investArrow, 160, 152, 160, 206, "var(--investment)");
      p.invest = fl(p.colA);
      typeBox(p.invest, 100, 208, "var(--investment)", "investment", "−" + fmt(500));
      sv("text", { x: 160, y: 258, "text-anchor": "middle", class: "ts-chart-muted" }, p.invest, "→ " + tr("scene.platform"));
      // column B: credit card, its expense, and the transfer that pays it
      p.card = fl(svg); p.cardAmt = account(p.card, 186, tr("accounts.type.credit"));
      p.expenseArrow = fl(svg); p.expenseLine = arrow(p.expenseArrow, 246, 152, 246, 206, "var(--expense)");
      p.expense = fl(svg);
      typeBox(p.expense, 186, 208, "var(--expense)", "expense", "−" + fmt(120));
      p.transferArrow = fl(svg); p.transferLine = arrow(p.transferArrow, 138, 124, 182, 124, "var(--transfer)");
      p.transfer = fl(svg);
      sv("line", { x1: 160, y1: 128, x2: 160, y2: 164, class: "ts-chart-stem" }, p.transfer);
      sv("rect", { x: 78, y: 164, width: 164, height: 28, rx: 10, style: fillOf("var(--transfer)") }, p.transfer);
      sv("text", { x: 160, y: 182, "text-anchor": "middle", class: "ts-chart-pill" }, p.transfer, tr("type.transfer") + " · " + fmt(120));
      // the Result
      p.net = fl(svg);
      sv("rect", { x: 14, y: 274, width: 292, height: 32, rx: 10, class: "ts-chart-hub" }, p.net);
      sv("text", { x: 28, y: 295, class: "ts-chart-title" }, p.net, tr("summary.net"));
      p.netVal = sv("text", { x: 292, y: 295, "text-anchor": "end", class: "ts-chart-num" }, p.net, fmt(0));
      lit(p.income);   // the starting picture (also what a swipe shows before the card plays)
      return p;
    },
    timeline(p) {
      const f = p.fmt;
      return [
        [0, () => lit(p.income)],
        // income → savings; the Result appears
        [600, () => { lit(p.savings); lit(p.incomeArrow); run(p.incomeLine, true); }],
        [1300, () => { setAmt(p.savingsAmt, f(3500)); lit(p.net); setAmt(p.netVal, f(3500)); }],
        [1700, () => run(p.incomeLine, false)],
        // the card pays an expense: the card goes negative, the Result down
        [2100, () => { p.colA.classList.add("left"); lit(p.card); }],
        [2800, () => { lit(p.expense); lit(p.expenseArrow); run(p.expenseLine, true); }],
        [3500, () => { setAmt(p.cardAmt, "−" + f(120)); p.cardAmt.classList.add("neg"); setAmt(p.netVal, f(3380)); }],
        [3900, () => run(p.expenseLine, false)],
        // savings pays the card: only the two accounts change, the Result stays
        [4400, () => { lit(p.transfer); lit(p.transferArrow); run(p.transferLine, true); }],
        [5200, () => { setAmt(p.savingsAmt, f(3380)); setAmt(p.cardAmt, f(0)); p.cardAmt.classList.remove("neg"); }],
        [5600, () => run(p.transferLine, false)],
        // savings puts money into a platform: the Result goes down
        [6000, () => { lit(p.invest); lit(p.investArrow); run(p.investLine, true); }],
        [6800, () => { setAmt(p.savingsAmt, f(2880)); setAmt(p.netVal, f(2880)); }],
        [7200, () => run(p.investLine, false)]
      ];
    }
  };

  // ---- Overview tab: this month's totals and the Result, then the page glides to the Breakdown "By category" (pie + list) ----
  //      The made-up month: Income 3,500 − Expenses 1,920 − Investments 500 = Result 1,080 (the app's own formula).
  const PIE = [["home", 700, "#F7D9C4"], ["groceries", 480, "#C9E4F7"], ["restaurants", 320, "#E0D9F7"], ["transport", 260, "#FFE0B2"], ["shopping", 160, "#F7C6D9"]];
  SCENES.overview = {
    hold: 1500,
    build(stage, ctx) {
      const tr = ctx.tr, money = (n) => ctx.home + " " + ctx.money(n);
      const p = device(stage, ctx, { nav: "overview" });
      // the period: ‹ month › and Week / Month / Year / All time / Custom
      const per = h("div", "card", null, p.scroll);
      const sel = h("div", "period-selector", null, per);
      h("span", "period-nav-btn", "‹", sel); h("div", "tappable", ctx.period || "", sel); h("span", "period-nav-btn", "›", sel);
      const pc = h("div", "period-type-chips", null, per);
      ["week", "month", "year", "alltime", "custom"].forEach((k) => h("span", "period-type-chip" + (k === "month" ? " active" : ""), tr("period." + k), pc));
      // the totals and the Result
      const sum = h("div", "card ov-period", null, p.scroll);
      const grid = h("div", "ov-sum-grid", null, sum);
      [["income", "+", "summary.income", "+" + money(3500)], ["expense", "−", "summary.expenses", "−" + money(1920)], ["investment", "±", "summary.investments", "−" + money(500)]].forEach(([cls, sign, k, v]) => {
        const t = h("div", "ov-sum-tile " + cls, null, grid);
        h("span", "ov-sum-sign", sign, t); h("span", "summary-label", tr(k), t); h("span", "summary-value " + cls, v, t);
      });
      h("div", "ov-sum-eq", "=", sum);
      const net = h("div", "ov-sum-net", null, sum);
      h("span", "ov-sum-net-label", tr("summary.net"), net);
      h("span", "ov-sum-net-value", "+" + money(1080), net);
      h("span", "ov-sum-net-eq", [tr("summary.income"), tr("summary.expenses"), tr("summary.investments")].join(" − "), net);
      // the Breakdown: Expense / Income, By category, the pie and its list
      p.card = h("div", "card ov-period", null, p.scroll);
      h("h2", null, tr("overview.breakdownTitle"), p.card);
      const tabs = h("div", "type-tabs overview-type-tabs", null, p.card);
      h("div", "type-tab active", tr("type.expense"), tabs).dataset.type = "expense";
      h("div", "type-tab", tr("type.income"), tabs).dataset.type = "income";
      const sec = h("div", "breakdown-section", null, p.card);
      h("h3", null, tr("overview.byCategory"), sec);
      const wrap = h("div", "pie-chart-wrap", null, sec);
      const pie = h("div", "pie-chart", null, wrap);
      const legend = h("div", "chart-legend", null, sec);
      const total = PIE.reduce((s, it) => s + it[1], 0);
      let cum = 0; const stops = [];
      const half = 110;   // the pie's frame is 220 px square in the app
      PIE.forEach(([key, amt, color]) => {
        const pct = amt / total * 100;
        stops.push(color + " " + cum + "% " + (cum + pct) + "%");
        if (pct >= 4) {   // the app labels slices of 4% and more outside the pie
          const a = (cum + pct / 2) / 100 * 2 * Math.PI, r = half * 0.82;
          const lab = h("div", "pie-outside-label", null, wrap);
          lab.style.left = (half + r * Math.sin(a)) + "px"; lab.style.top = (half - r * Math.cos(a)) + "px";
          const ic = h("span", "pie-outside-icon", CATS[key][0], lab); ic.style.background = color;
          h("span", "pie-outside-pct", Math.round(pct) + "%", lab);
        }
        cum += pct;
        const row = h("div", "legend-row", null, legend);
        const sw = h("span", "legend-swatch", null, row); sw.style.background = color;
        const text = h("div", "legend-text", null, row);
        h("div", "legend-name", CATS[key][0] + " " + tr(CATS[key][1]), text);
        const sub = h("div", "legend-sub", null, text);
        h("span", "legend-amount", money(amt), sub); h("span", "legend-percent", pct.toFixed(1) + "%", sub);
      });
      pie.style.background = "conic-gradient(" + stops.join(", ") + ")";
      return p;
    },
    timeline(p) { return [[0, () => scrollTo(p, null)], [2000, () => scrollTo(p, p.card)], [5000, () => {}]]; }
  };

  // The Needs review card of Home, as the app draws it, opened: a short row with a quick category pick and a one-tap Confirm.
  function reviewCard(parent, ctx) {
    const tr = ctx.tr;
    const card = h("div", "card review-queue", null, parent);
    const bh = h("div", "budgets-header", null, card);
    const h2 = h("h2", null, null, bh);
    const toggle = h("div", "review-toggle", null, h2);
    h("span", null, tr("review.title") + " (1)", toggle); h("span", "review-toggle-chev", "›", toggle);
    h("p", "hint", tr("review.intro"), card);
    const item = h("div", "review-item review-collapsed review-more-closed", null, card);
    const top = h("div", "review-item-top", null, item);
    const left = h("div", null, null, top);
    h("div", "review-item-desc", "Cafe Luna", left);
    h("div", "review-item-meta", fmtDay(0) + " · " + tr("type.expense").toLowerCase(), left);
    h("div", "review-item-amount", out(ctx, 48), top);
    const quick = h("div", "review-quick", null, item);
    h("span", "review-quick-cat", tr("review.pickCategory"), quick);
    const confirm = h("button", "review-quick-confirm", tr("review.confirm"), quick); confirm.type = "button"; confirm.tabIndex = -1;
    return card;
  }

  // ---- Bank transactions arrive by themselves: on Home, a payment the bank e-mailed about appears under "Needs review" ----
  SCENES.bank = {
    hold: 2400,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "entries", fab: true });
      p.review = reviewCard(p.scroll, ctx); p.review.hidden = true;
      const list = entriesCard(p.scroll, ctx);
      list.add({ cat: "transport", amt: out(ctx, 6.5), net: -6.5 });
      list.add({ cat: "groceries", amt: out(ctx, 25.5), net: -25.5 });
      return p;
    },
    timeline(p) { return [[0, () => { p.review.hidden = true; p.review.classList.remove("ts-pop"); }], [800, () => { p.review.hidden = false; p.review.classList.add("ts-pop"); }]]; }
  };

  // ---- More → Bank emails: the bank e-mails you about a payment → the app lists it under "Needs review". Only what the app really does:
  //      the e-mail is read (nothing is invented about the bank's own screens) and the entry waits for the person's Confirm. ----
  SCENES.bankalerts = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = device(stage, ctx, { header: false, h: 400 });
      p.mail = h("div", "card ts-mail", null, p.scroll); p.mail.hidden = true;
      const ic = h("span", "row-icon", null, p.mail); ic.innerHTML = ctx.icon ? ctx.icon("mail") : "";
      const who = h("div", "ts-mail-who", null, p.mail);
      h("b", null, ctx.bank || tr("bankMail.title"), who);
      h("div", "hint", "Cafe Luna", who);
      h("b", null, out(ctx, 48), p.mail);
      p.arrow = h("div", "ts-arrow", "↓", p.scroll); p.arrow.hidden = true;
      p.review = reviewCard(p.scroll, ctx); p.review.hidden = true;
      return p;
    },
    timeline(p) {
      return [
        [500, () => { p.mail.hidden = false; p.mail.classList.add("ts-pop"); }],
        [1600, () => { p.arrow.hidden = false; }],
        [2000, () => { p.review.hidden = false; p.review.classList.add("ts-pop"); }],
        [4200, () => {}]
      ];
    }
  };

  // The STARTING picture of a scene, with no timers and no motion: used to show every card of the swipeable tour already filled in, so
  // nothing looks empty while a swipe is under way. (The card that is on screen plays its scene with play().)
  function preview(key, stage, ctx) {
    const scene = SCENES[key];
    stage.onclick = null;
    if (!scene) { stage.hidden = true; stage.innerHTML = ""; return false; }
    stage.hidden = false; stage.innerHTML = "";
    scene.build(stage, ctx);
    return true;
  }

  // How long a scene takes to watch once, in ms (its timeline), measured on a copy nobody sees. The tour times its swipe nudge with it.
  function length(key, ctx) {
    const scene = SCENES[key];
    if (!scene) return 0;
    const saved = timers;
    timers = [];
    try {
      const parts = scene.build(document.createElement("div"), ctx);
      return scene.timeline(parts, ctx).reduce((m, s) => Math.max(m, s[0]), 0);
    } catch (e) {
      return 0;
    } finally {
      timers.forEach(clearTimeout);
      timers = saved;
    }
  }

  root.TourScenes = { play, preview, stop, length, has: (key) => !!SCENES[key] };
})(typeof window !== "undefined" ? window : this);
