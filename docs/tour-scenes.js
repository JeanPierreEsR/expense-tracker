// Small animated scenes for the welcome tour (and More → How to use the app).
//
// One tiny engine plays any number of scenes. A scene is just data:
//   build(stage, ctx)    -> draws the screen and returns handles to its parts
//   timeline(parts, ctx) -> [[milliseconds, fn(instant)], …]; fn does one thing (move the finger, type, fill a bar…)
//   hold                 -> pause before the scene loops
// Every screen is drawn with the APP'S OWN PIECES (owner, 2026-11-13): its own classes at its real size (a 390 px wide phone screen),
// then shrunk to fit the card, so a picture follows any change to the app's look by itself. The pieces that never depend on the
// scene (the tab bar, the More tab, the My data hub, the "+" form's currencies) are copied from the live app itself. The words are
// the app's own (tr). Nothing inside a picture can be tapped: a tap on the picture replays it (or plays its next step).
// With "reduce motion" on, only the final picture is shown.
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

  // The finger: glides to the middle of any element and "taps" with a ring.
  function makeFinger(stage) {
    const f = h("div", "ts-finger", null, stage);
    h("div", "ts-finger-dot", null, f);
    return {
      el: f,
      to(target, instant) {
        if (!target) return;
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
    if (scene.initial) scene.initial(parts, ctx);   // its starting picture at once, as the swipe preview shows it (no blank second)
    const total = scene.steps.length;
    const bar = h("div", "ts-stepper", null, stage);
    const btn = h("button", "ts-step-btn", null, bar);
    btn.type = "button";
    let i = 0;
    const refresh = () => { btn.textContent = ctx.tr(i < total ? "tour.nextStep" : "tour.replay"); };
    // Scroll so the top of the animation is on screen, but only when it is not already fully visible (no jump when it is).
    const showTop = () => {
      if (!stage.scrollIntoView) return;
      let box = stage.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      const view = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const top = stage.getBoundingClientRect().top;
      if (top < view.top - 0.5 || top >= view.bottom) stage.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    const go = (instant) => {
      if (i >= total) { showTop(); play(key, stage, ctx); return; }
      const later = (fn, ms) => { if (instant) fn(); else timers.push(setTimeout(fn, ms)); };
      const ms = scene.steps[i](parts, ctx, instant, later) || 0;
      i++;
      if (instant) { refresh(); return; }
      btn.disabled = true;
      // each step starts with the top of the animation on screen, so as much of it as possible shows
      showTop();
      timers.push(setTimeout(() => { btn.disabled = false; refresh(); if (i >= total && ctx.onEnd) ctx.onEnd(); }, ms));
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
  function copyOf(sel) { const real = document.querySelector(sel); return real ? strip(real.cloneNode(true)) : null; }

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
    return { stage, frame, app, main, scroll, nav, fab, k, ctx, finger: makeFinger(stage) };
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

  // A pop-up sheet: the app's own sheet (header with ✕, body), sliding up over the screen. o = { tall, foot } — foot: a button pinned at the bottom.
  function sheetOpen(p, title, o) {
    o = o || {};
    if (p.sh) p.sh.back.remove();
    const back = h("div", "ts-sheet", null, p.app);
    const m = h("div", "currency-modal" + (o.tall ? " ts-tall" : ""), null, back);
    const hd = h("div", "currency-modal-header", null, m);
    h("span", null, title, hd); h("span", "currency-modal-close", "✕", hd);
    const clip = h("div", "ts-sheet-clip", null, m);
    const body = h("div", "budget-modal-body ts-sheet-body", null, clip);
    const foot = o.foot ? h("div", "ts-sheet-foot", null, m) : null;
    p.sh = { back, modal: m, head: hd, clip, body, foot };
    void back.offsetWidth;
    back.classList.add("show");
    return body;
  }
  function sheetClose(p) {
    if (!p.sh) return;
    const el = p.sh.back; p.sh = null;
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }

  // A field as the app draws it: its label and its box (an input, or a select where the app has a list). value.textContent reads and
  // writes what the box shows; box.classList "focus" draws the app's focused look.
  function box(parent, label, value, o) {
    o = o || {};
    const w = h("div", "ts-field", null, parent);
    if (label) h("label", null, label, w);
    let set, get;
    if (o.select) {
      const s = h("select", null, null, w); s.tabIndex = -1;
      const opt = h("option", null, value || "", s);
      set = (v) => { opt.textContent = v; }; get = () => opt.textContent;
    } else {
      const i = h("input", null, null, w); i.type = "text"; i.readOnly = true; i.tabIndex = -1;
      if (o.ph) i.placeholder = o.ph;
      i.value = value || "";
      set = (v) => { i.value = v; }; get = () => i.value;
    }
    return { box: w, value: { get textContent() { return get(); }, set textContent(v) { set(v); } } };
  }
  // The app's tab rows: the four entry types, or two to four plain choices (Deposit / Withdrawal, I paid them / They paid me…).
  function typeTabs(parent, ctx, on) {
    const row = h("div", "type-tabs", null, parent), tabs = {};
    ["expense", "income", "investment", "transfer"].forEach((t) => { const b = h("div", "type-tab" + (t === on ? " active" : ""), ctx.tr("type." + t), row); b.dataset.type = t; tabs[t] = b; });
    return { row, tabs };
  }
  const typeOn = (tabs, t) => Object.keys(tabs).forEach((k) => tabs[k].classList.toggle("active", k === t));
  function seg(parent, labels, on) {
    const row = h("div", "type-tabs budget-period-tabs", null, parent);
    row.style.gridTemplateColumns = "repeat(" + labels.length + ", 1fr)";
    return labels.map((l, i) => h("div", "type-tab" + (i === on ? " active" : ""), l, row));
  }
  const segOn = (items, el) => items.forEach((x) => x.classList.toggle("active", x === el));
  function chips(parent, labels, on) { const row = h("div", "currency-chips", null, parent); return labels.map((l, i) => h("div", "currency-chip" + (i === on ? " active" : ""), l, row)); }
  function tags(parent, labels) { const row = h("div", "tags-list", null, parent); return labels.map((l) => h("div", "tag-chip", l, row)); }
  // The "+" form's currencies: the live row copied (flags, More… and all), the main currency picked.
  function currencyRow(parent, ctx) {
    const real = copyOf("#currency-chips");
    if (real && real.children.length) {
      Array.from(real.children).forEach((c, i) => c.classList.toggle("active", i === 0));
      parent.appendChild(real);
      return real;
    }
    return chips(parent, [ctx.home, "USD", "EUR"], 0)[0].parentNode;
  }
  function primary(parent, text) { const b = h("button", "primary", text, parent); b.type = "button"; b.tabIndex = -1; return b; }
  function link(parent, ctx, iconName, text) { const a = h("div", "add-inline", text, parent); ico(ctx, iconName, a); return a; }
  function check(parent, label) {
    const row = h("label", "checkbox-row", null, parent);
    const c = h("input", null, null, row); c.type = "checkbox"; c.tabIndex = -1;
    h("span", null, label, row);
    return { row, set: (on) => { c.checked = on; } };
  }
  const press = (el) => { el.classList.add("ts-pressed"); };
  const unpress = (el) => { el.classList.remove("ts-pressed"); };
  const typing = (field, parts) => parts.map((txt) => () => { field.value.textContent = txt; });

  // A card with the app's card header: a title, and the round buttons on the right.
  function cardHead(parent, title, buttons) {
    const card = h("div", "card", null, parent);
    const hd = h("div", "budgets-header", null, card);
    const t = h("h2", null, title, hd);
    const acts = h("span", "friends-header-actions", null, hd);
    const btn = {};
    (buttons || []).forEach((b) => { btn[b] = iconBtn(acts, b); });
    return { card, title: t, btn };
  }
  // A More sub-screen's card: the round Back on the left, its buttons on the right, then the screen's title.
  function subHead(parent, title, buttons) {
    const card = h("div", "card", null, parent);
    const hd = h("div", "budgets-header", null, card);
    iconBtn(hd, "back", "back-btn");
    const acts = h("span", "friends-header-actions", null, hd);
    const btn = {};
    (buttons || []).forEach((b) => { btn[b] = iconBtn(acts, b); });
    h("h2", "screen-title", title, card);
    return { card, btn };
  }

  // Dates as the app writes them.
  const fmtMd = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return root.I18n ? root.I18n.fmtMonthDay(d) : d.toDateString(); };
  const fmtDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return root.I18n ? root.I18n.fmtDateMedium(d) : d.toDateString(); };
  const out = (ctx, n) => "−" + ctx.home + " " + ctx.money(n);
  const inc = (ctx, n) => "+" + ctx.home + " " + ctx.money(n);

  // Categories as the app draws them: a round coloured icon and the name.
  const CATS = {
    groceries: ["🛒", "scene.cat.groceries", "#C9E4F7"], transport: ["🚌", "scene.cat.transport", "#FFE0B2"], restaurants: ["🍽️", "scene.cat.restaurants", "#E0D9F7"],
    home: ["🏠", "scene.cat.home", "#F7D9C4"], shopping: ["🛍️", "scene.cat.shopping", "#F7C6D9"], healthcare: ["🏥", "scene.cat.healthcare", "#E0D9F7"],
    gifts: ["🎁", "scene.cat.gifts", "#F7D9C4"], education: ["🎓", "scene.cat.education", "#D9F2D9"], salary: ["💰", "scene.cat.salary", "#D9F2D9"],
    business: ["👔", "scene.cat.business", "#C9E4F7"], extraIncome: ["💵", "scene.cat.extraIncome", "#D9F7F0"], sales: ["🏷️", "scene.cat.sales", "#FFF3B0"],
    savingsReturn: ["🪙", "scene.cat.savingsReturn", "#FFE0B2"], insurance: ["🛡️", "scene.cat.insurance", "#E0D9F7"], other: ["📦", "scene.cat.other", "#E5E5EA"]
  };
  const TILES = {
    expense: ["groceries", "transport", "restaurants", "home", "shopping", "healthcare", "gifts", "education"],
    income: ["salary", "gifts", "business", "extraIncome", "sales", "savingsReturn", "insurance", "other"]
    // Investments (and transfers) have NO category in the app: the Investment tab opens the form directly.
  };
  function tileGrid(parent, ctx, type) {
    const g = h("div", "category-grid", null, parent);
    return TILES[type].map((key) => {
      const [icon, name, bg] = CATS[key];
      const t = h("div", "category-tile", null, g);
      const i = h("span", "category-tile-icon", icon, t); i.style.background = bg;
      h("span", "category-tile-name", ctx.tr(name), t);
      return t;
    });
  }
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

  // ---- add an expense or income: the + → type tab → category → the form's fields → More details → Save entry ----
  // The new-entry sheet: its type tabs and category grid; tapping a category turns it into the form (as the app does).
  function newEntrySheet(p, ctx, type) {
    const tr = ctx.tr;
    const s = sheetOpen(p, tr("entry.newTitle"), { tall: true, foot: true });
    const tt = typeTabs(s, ctx, type);
    p.tabs = tt.tabs;
    p.grid = h("div", null, null, s);
    p.tiles = tileGrid(p.grid, ctx, type);
    p.form = h("div", null, null, s); p.form.hidden = true;
    p.save = primary(p.sh.foot, tr("entry.save")); p.save.hidden = true;
    return s;
  }
  const showForm = (p) => { p.grid.hidden = true; p.form.hidden = false; p.save.hidden = false; };
  // Home before the + is tapped: the Recent entries card with two entries.
  function homeScreen(stage, ctx) {
    const p = device(stage, ctx, { nav: "entries", fab: true });
    p.list = entriesCard(p.scroll, ctx);
    p.list.add({ cat: "transport", amt: out(ctx, 6.5), net: -6.5 });
    p.list.add({ cat: "restaurants", amt: out(ctx, 48), net: -48 });
    return p;
  }

  SCENES.add = {
    hold: 1800,
    build(stage, ctx) { return homeScreen(stage, ctx); },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      const half = ctx.money(12.75);
      let amount, desc, account, more, splitChk, splitDetail, friend, summary, tag, banner;
      const fillForm = () => {
        const f = p.form;
        banner = h("div", "category-banner", null, f);
        catIcon(banner, "groceries", "category-banner-icon"); h("span", null, tr("scene.cat.groceries"), banner);
        link(banner, ctx, "pencil", tr("common.change"));
        amount = box(f, tr("field.amount"), "", { ph: "0.00" });
        box(f, tr("field.date"), fmtDay(0));
        h("label", null, tr("field.currency"), f); currencyRow(f, ctx);
        desc = box(f, tr("field.description"), "", { ph: tr("common.optional") });
        account = box(f, tr("field.paymentMethod"), tr("scene.debit"), { select: true });
        // the optional fields are folded behind "More details" on a new entry (design review 2026-11-12)
        more = h("div", "more-details-toggle", null, f);
        h("span", "more-details-title", tr("entry.moreDetails"), more); h("span", "more-details-sum", tr("scene.me") + " ›", more);
        p.details = h("div", null, null, f); p.details.hidden = true;
        box(p.details, tr("field.paidBy"), tr("scene.me"), { select: true });
        splitChk = check(p.details, tr("split.toggle"));
        splitDetail = h("div", null, null, p.details); splitDetail.hidden = true;
        seg(splitDetail, [tr("split.equal"), tr("split.percent"), tr("split.custom"), tr("split.byItems")], 0);
        h("label", null, tr("split.sharedWith"), splitDetail);
        [friend] = tags(splitDetail, ["Ana", "Luis"]);
        summary = h("p", "hint", null, splitDetail); summary.hidden = true;
        h("label", null, tr("field.tags"), p.details);
        tag = tags(p.details, [tr("scene.tagAnnual"), tr("scene.tagFamily")])[1];
      };
      const amt = () => typing(amount, ["2", "25", "25.", "25.5", "25.50"]);
      let a, d;
      return [
        [300, (i) => fg.to(p.fab, i)],
        [1200, (i) => { fg.tap(i); newEntrySheet(p, ctx, "expense"); fillForm(); a = amt(); d = typing(desc, ["Comp", tr("scene.descShop").slice(0, 8), tr("scene.descShop")]); }],
        [2200, (i) => fg.to(p.tabs.income, i)],
        [2800, (i) => { fg.tap(i); typeOn(p.tabs, "income"); p.grid.innerHTML = ""; p.tiles = tileGrid(p.grid, ctx, "income"); }],
        [3600, (i) => fg.to(p.tabs.expense, i)],
        [4100, (i) => { fg.tap(i); typeOn(p.tabs, "expense"); p.grid.innerHTML = ""; p.tiles = tileGrid(p.grid, ctx, "expense"); }],
        [4800, (i) => fg.to(p.tiles[0], i)],
        [5400, (i) => { fg.tap(i); press(p.tiles[0]); }],
        [5700, () => { unpress(p.tiles[0]); showForm(p); }],
        [6000, (i) => fg.to(amount.box, i)],
        [6500, (i) => { fg.tap(i); amount.box.classList.add("focus"); }],
        [6600, () => a[0]()], [6800, () => a[1]()], [7000, () => a[2]()], [7200, () => a[3]()], [7400, () => a[4]()],
        [7900, (i) => { amount.box.classList.remove("focus"); sheetScrollTo(p, desc.box, 60); }],
        [8500, (i) => fg.to(desc.box, i)],
        [9000, (i) => { fg.tap(i); desc.box.classList.add("focus"); }],
        [9100, () => d[0]()], [9300, () => d[1]()], [9500, () => d[2]()],
        [10000, (i) => { desc.box.classList.remove("focus"); fg.to(account.box, i); }],
        [10500, (i) => { fg.tap(i); account.box.classList.add("focus"); }],
        [11100, (i) => { account.box.classList.remove("focus"); fg.to(more, i); }],
        [11600, (i) => { fg.tap(i); p.details.hidden = false; more.setAttribute("aria-expanded", "true"); }],
        [11800, () => sheetScrollTo(p, more)],
        [12600, (i) => fg.to(splitChk.row, i)],
        [13100, (i) => { fg.tap(i); splitChk.set(true); splitDetail.hidden = false; }],
        [13300, () => sheetScrollTo(p, splitChk.row)],
        [14100, (i) => fg.to(friend, i)],
        [14600, (i) => { fg.tap(i); friend.classList.add("selected"); summary.textContent = tr("split.summaryEqual", { cur: ctx.home, each: half, own: half }); summary.hidden = false; }],
        [15400, () => sheetScrollTo(p, tag)],
        [16000, (i) => fg.to(tag, i)],
        [16500, (i) => { fg.tap(i); tag.classList.add("selected"); }],
        [17100, (i) => fg.to(p.save, i)],
        [17600, (i) => { fg.tap(i); press(p.save); }],
        [17900, () => { unpress(p.save); sheetClose(p); p.list.add({ cat: "groceries", amt: "−" + ctx.home + " " + half, sub: tr("common.total") + " " + ctx.home + " " + ctx.money(25.5), net: -12.75 }, true); }],
        [18500, () => fg.hide()]
      ];
    }
  };

  // ---- an investment: the Investment tab opens the form directly (no category). Deposit/Withdrawal come first ----
  SCENES.invest = {
    hold: 1800,
    build(stage, ctx) { return homeScreen(stage, ctx); },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let deposit, withdrawal, dirs, hint, amount, from, plat, a;
      const fillForm = () => {
        const f = p.form;
        dirs = seg(f, [tr("investment.deposit"), tr("investment.withdrawal")], 0);
        [deposit, withdrawal] = dirs;
        hint = h("p", "hint", tr("investment.depositHint"), f);
        amount = box(f, tr("field.amount"), "", { ph: "0.00" });
        box(f, tr("field.date"), fmtDay(0));
        h("label", null, tr("field.currency"), f); currencyRow(f, ctx);
        from = box(f, tr("field.from"), tr("scene.savings"), { select: true });
        plat = box(f, tr("field.platform"), tr("scene.platform"), { select: true });
        a = typing(amount, ["5", "50", "500"]);
      };
      const dir = (w) => { segOn(dirs, w ? withdrawal : deposit); hint.textContent = tr(w ? "investment.withdrawalHint" : "investment.depositHint"); };
      return [
        [300, (i) => fg.to(p.fab, i)],
        [1200, (i) => { fg.tap(i); newEntrySheet(p, ctx, "expense"); fillForm(); }],
        [2200, (i) => fg.to(p.tabs.investment, i)],
        [2800, (i) => { fg.tap(i); typeOn(p.tabs, "investment"); showForm(p); }],
        [3500, (i) => fg.to(withdrawal, i)],
        [4000, (i) => { fg.tap(i); dir(true); }],
        [4700, (i) => fg.to(deposit, i)],
        [5200, (i) => { fg.tap(i); dir(false); }],
        [5800, (i) => fg.to(amount.box, i)],
        [6300, (i) => { fg.tap(i); amount.box.classList.add("focus"); }],
        [6400, () => a[0]()], [6600, () => a[1]()], [6800, () => a[2]()],
        [7300, () => { amount.box.classList.remove("focus"); sheetScrollTo(p, from.box, 80); }],
        [7900, (i) => fg.to(from.box, i)],
        [8400, (i) => { fg.tap(i); from.box.classList.add("focus"); }],
        [8900, (i) => { from.box.classList.remove("focus"); fg.to(plat.box, i); }],
        [9400, (i) => { fg.tap(i); plat.box.classList.add("focus"); }],
        [9900, (i) => { plat.box.classList.remove("focus"); fg.to(p.save, i); }],
        [10400, (i) => { fg.tap(i); press(p.save); }],
        [10700, () => { unpress(p.save); sheetClose(p); p.list.add({ dot: "investment", name: tr("entry.investmentIn", { platform: tr("scene.platform") }), amt: out(ctx, 500) }, true); }],
        [11300, () => fg.hide()]
      ];
    }
  };

  // ---- a transfer: the Transfer tab opens the form directly (no category). "Type of transfer" has its kinds ----
  //      Between my accounts (From / To), Repayment (I paid them / They paid me + friend), New loan (same + due date).
  SCENES.transfer = {
    hold: 1800,
    build(stage, ctx) { return homeScreen(stage, ctx); },
    timeline(p, ctx) {
      const fg = p.finger, tr = ctx.tr;
      let kindBox, dyn, theyPaid;
      const renderKind = (kind, they) => {
        dyn.innerHTML = "";
        kindBox.value.textContent = tr("transfer.kind." + kind);
        if (kind !== "between") {
          const tabs = seg(dyn, [tr("transfer.iPaid"), tr("transfer.theyPaid")], they ? 1 : 0);
          theyPaid = tabs[1];
          box(dyn, tr("common.friend"), "Ana", { select: true });
          const hintKey = kind === "loan" ? (they ? "transfer.hintLoanTheyPaid" : "transfer.hintLoanIPaid") : (they ? "transfer.hintRepayTheyPaid" : "transfer.hintRepayIPaid");
          h("p", "hint", tr(hintKey), dyn);
        }
        box(dyn, tr("field.amount"), kind === "between" ? "200.00" : "40.00");
        box(dyn, tr("field.date"), fmtDay(0));
        if (kind === "between") {
          box(dyn, tr("field.from"), tr("scene.debit"), { select: true });
          box(dyn, tr("field.toAccount"), tr("scene.savings"), { select: true });
        }
        if (kind === "loan") box(dyn, tr("loan.dueDateOptional"), "");
      };
      return [
        [300, (i) => fg.to(p.fab, i)],
        [1200, (i) => {
          fg.tap(i); newEntrySheet(p, ctx, "expense");
          kindBox = box(p.form, tr("transfer.kind"), "", { select: true });
          dyn = h("div", null, null, p.form);
          renderKind("between");
        }],
        [2200, (i) => fg.to(p.tabs.transfer, i)],
        [2800, (i) => { fg.tap(i); typeOn(p.tabs, "transfer"); showForm(p); }],
        [4900, (i) => fg.to(kindBox.box, i)],
        [5400, (i) => { fg.tap(i); kindBox.box.classList.add("focus"); }],
        [5600, () => renderKind("repayment", false)],
        [6900, (i) => { kindBox.box.classList.remove("focus"); fg.to(theyPaid, i); }],
        [7400, (i) => { fg.tap(i); renderKind("repayment", true); }],
        [8700, (i) => fg.to(kindBox.box, i)],
        [9200, (i) => { fg.tap(i); kindBox.box.classList.add("focus"); }],
        [9400, () => renderKind("loan", false)],
        [11300, () => { kindBox.box.classList.remove("focus"); fg.hide(); }]
      ];
    }
  };

  // ---- More → Programmed income/expenses: + → description, category, amount, frequency, start → Save → it is listed ----
  // A More sub-screen at its top: the card with Back, the + and the title (the tab bar shows More).
  function subScreen(stage, ctx, title, buttons) {
    const p = device(stage, ctx, { nav: "more" });
    const s = subHead(p.scroll, title, buttons || ["plus"]);
    p.card = s.card; p.addBtn = s.btn.plus;
    return p;
  }
  function listRow(parent, ctx, name, sub, amount, amountSub, enter) {
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
    hold: 1800,
    build(stage, ctx) {
      const p = subScreen(stage, ctx, ctx.tr("recurring.title"));
      h("p", "hint", ctx.tr("recurring.intro"), p.card);
      h("h3", "accounts-group-title", ctx.tr("recurring.recurring"), p.card);
      p.empty = h("p", "hint", ctx.tr("recurring.empty"), p.card);
      p.rows = h("div", null, null, p.card);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let desc, cats, amount, freq, save, d, a;
      return [
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, tr("recModal.add"), { tall: true, foot: true });
          desc = box(s, tr("field.description"), "");
          h("label", null, tr("field.category"), s);
          cats = chips(s, [CATS.home[0] + " " + tr("scene.cat.home"), CATS.groceries[0] + " " + tr("scene.cat.groceries"), CATS.salary[0] + " " + tr("scene.cat.salary")], -1);
          amount = box(s, tr("field.amount"), "", { ph: "0.00" });
          freq = seg(s, [tr("period.monthly"), tr("period.yearly"), tr("recModal.once"), tr("recModal.other")], 0);
          box(s, tr("recModal.dates"), tr("range.fromOpen", { start: fmtDay(0) }));   // the one date field: start, no end
          save = primary(p.sh.foot, tr("common.save"));
          d = typing(desc, ["Re", tr("scene.rent").slice(0, 3), tr("scene.rent")]); a = typing(amount, ["1", "1,2", "1,200"]);
        }],
        [1900, (i) => fg.to(desc.box, i)],
        [2400, (i) => { fg.tap(i); desc.box.classList.add("focus"); }],
        [2500, () => d[0]()], [2700, () => d[1]()], [2900, () => d[2]()],
        [3400, (i) => { desc.box.classList.remove("focus"); fg.to(cats[0], i); }],
        [3900, (i) => { fg.tap(i); cats[0].classList.add("active"); }],
        [4400, (i) => fg.to(amount.box, i)],
        [4900, (i) => { fg.tap(i); amount.box.classList.add("focus"); }],
        [5000, () => a[0]()], [5200, () => a[1]()], [5400, () => a[2]()],
        [5900, (i) => { amount.box.classList.remove("focus"); fg.to(freq[0], i); }],
        [6400, (i) => fg.tap(i)],
        [6900, (i) => fg.to(save, i)],
        [7400, (i) => { fg.tap(i); press(save); }],
        [7700, () => {
          sheetClose(p); p.empty.hidden = true;
          listRow(p.rows, ctx, tr("scene.rent"), tr("recurring.freqMonthly", { day: new Date().getDate() }), out(ctx, 1200), null, true);
        }],
        [8400, () => fg.hide()]
      ];
    }
  };

  // ---- More → Trips & events: + → kind, name, dates, currency, budget → Save → listed; open it → your share, budget bar, Before/During/After ----
  SCENES.trips = {
    hold: 1800,
    build(stage, ctx) {
      const tr = ctx.tr;
      const p = subScreen(stage, ctx, tr("trips.title"), ["pencil", "plus"]);
      h("p", "hint", tr("trips.hint"), p.card);
      p.empty = h("p", "hint", tr("trips.empty"), p.card);
      p.listBox = h("div", null, null, p.card);
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger, cur = ctx.home;
      const name = tr("scene.tripName");
      const start = fmtDay(14), end = fmtDay(19);
      let nameBox, datesBox, budgetBox, save, row, n, b;
      return [
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, tr("trips.addTitle"), { tall: true, foot: true });
          seg(s, [tr("trips.kind.trip"), tr("trips.kind.event")], 0);
          nameBox = box(s, tr("trips.name"), "");
          datesBox = box(s, tr("trips.dates"), tr("range.span", { start, end }));   // one field, one calendar
          box(s, tr("trips.currency"), cur, { select: true });
          budgetBox = box(s, tr("trips.budget"), "", { ph: "0.00" });
          save = primary(p.sh.foot, tr("trips.save"));
          n = typing(nameBox, [name.slice(0, 4), name.slice(0, 8), name]); b = typing(budgetBox, ["2", "2,0", "2,000"]);
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
        [7200, (i) => { fg.tap(i); press(save); }],
        [7500, () => {
          sheetClose(p); p.empty.hidden = true;
          h("h3", "accounts-group-title", tr("trips.group.upcoming"), p.listBox);
          row = listRow(p.listBox, ctx, "✈️ " + name, [tr("trips.kind.trip"), tr("trips.dateRange", { start, end }), tr("trips.entryCount", { n: 0 })].join(" · "),
            cur + " " + ctx.money(0), tr("trips.ofBudget", { cur, amount: ctx.money(2000) }), true);
          scrollTo(p, row, 120);
        }],
        [8300, (i) => fg.to(row, i)],
        [8800, (i) => fg.tap(i)],
        [9000, () => {
          // the trip's own screen: its total (your share), the budget bar, and Before / During / After
          const s = sheetOpen(p, "✈️ " + name, { tall: true });
          h("p", "hint", tr("trips.kind.trip") + " · " + tr("trips.dateRange", { start, end }), s);
          h("div", "trip-total ts-big", cur + " " + ctx.money(1250), s);
          h("p", "hint", tr("trips.total") + " · " + tr("trips.entryCount", { n: 6 }), s);
          const track = h("div", "budget-progress-track", null, s); h("div", "budget-progress-fill", null, track).style.width = "62.5%";
          const sub = h("div", "budget-row-sub", null, s); h("span", null, tr("trips.budgetLeft", { cur, amount: ctx.money(750) }), sub); h("span", null, tr("trips.ofBudget", { cur, amount: ctx.money(2000) }), sub);
          const ph = h("div", "ts-phases", null, s);
          [["trips.before", 400], ["trips.during", 850], ["trips.after", 0]].forEach(([k, v]) => { const c = h("div", "ts-phase", null, ph); h("span", "summary-label", tr(k), c); h("b", null, cur + " " + ctx.money(v), c); });
          h("p", "hint", tr("trips.phaseHint"), s);
        }],
        [9600, () => fg.hide()]
      ];
    }
  };

  // ---- the Loans tab: the "Owes you" card (its + adds a loan), and sheets that slide up (add loan / the person / repayment) ----
  function loansScreen(stage, ctx, owed) {
    const tr = ctx.tr;
    const p = device(stage, ctx, { nav: "loans" });
    const c = cardHead(p.scroll, tr("loans.owesYou"), ["plus"]);
    p.addBtn = c.btn.plus;
    const totalRow = h("div", "budgets-summary-row", null, c.card);
    h("span", "budgets-summary-label", tr("loans.totalOwed"), totalRow);
    const total = h("span", "loan-total-values income", "", totalRow);
    const list = h("div", null, null, c.card);
    const empty = h("p", "hint", tr("loans.noneOwed"), c.card);
    p.setOwed = (x, enter) => {
      list.innerHTML = "";
      empty.hidden = x > 0; totalRow.hidden = !(x > 0);
      if (!(x > 0)) return null;
      const r = h("div", "loan-row" + (enter ? " ts-enter" : ""), null, list);
      h("span", "loan-row-name", "Ana", r);
      h("span", "loan-row-amount owed-to-me", inc(ctx, x), r);
      total.textContent = inc(ctx, x);
      return r;
    };
    p.friendRow = p.setOwed(owed);
    return p;
  }

  // ---- Loans tab: + → Friend, who owes whom, Amount → Save loan → the friend appears under "Owes you" ----
  SCENES.loan = {
    hold: 1800,
    build(stage, ctx) { return loansScreen(stage, ctx, 0); },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let amountBox, saveBtn, dirOn, a;
      return [
        [500, (i) => fg.to(p.addBtn, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, tr("loanModal.add"), { foot: true });
          box(s, tr("common.friend"), "Ana", { select: true });
          h("label", null, tr("loanModal.direction"), s);
          [dirOn] = seg(s, [tr("loanModal.theyOweMe"), tr("loanModal.iOweThem")], 0);
          amountBox = box(s, tr("field.amount"), "", { ph: "0.00" });
          saveBtn = primary(p.sh.foot, tr("loanModal.save"));
          a = typing(amountBox, ["1", "10", "100"]);
        }],
        [1900, (i) => fg.to(dirOn, i)],
        [2400, (i) => fg.tap(i)],
        [2800, (i) => fg.to(amountBox.box, i)],
        [3300, (i) => { fg.tap(i); amountBox.box.classList.add("focus"); }],
        [3400, () => a[0]()], [3600, () => a[1]()], [3800, () => a[2]()],
        [4300, (i) => { amountBox.box.classList.remove("focus"); fg.to(saveBtn, i); }],
        [4800, (i) => { fg.tap(i); press(saveBtn); }],
        [5100, () => { sheetClose(p); p.setOwed(100, true); }],
        [5800, () => fg.hide()]
      ];
    }
  };

  // ---- Loans tab: tap the friend → their screen (headline, Record repayment) → Amount → Record PEN x → the balance goes down ----
  SCENES.repay = {
    hold: 1800,
    build(stage, ctx) { return loansScreen(stage, ctx, 100); },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      let rec, amountBox, saveBtn;
      return [
        [500, (i) => fg.to(p.friendRow, i)],
        [1100, (i) => fg.tap(i)],
        [1300, () => {
          const s = sheetOpen(p, "Ana");
          const head = h("p", "hint ld-headline", null, s);
          const side = h("span", "ld-head-side", null, head);
          h("span", "ld-head-label", tr("loanDetail.owesYouLabel"), side); side.appendChild(document.createTextNode(" "));
          h("span", "ld-head-amt pos", inc(ctx, 100), side);
          const acts = h("div", "loan-detail-actions", null, s);
          rec = link(acts, ctx, "coin", tr("loan.recordRepayment").replace(/^\S+\s+/, ""));
          link(acts, ctx, "calendar", tr("history.button").replace(/^\S+\s+/, ""));
        }],
        [1900, (i) => fg.to(rec, i)],
        [2400, (i) => fg.tap(i)],
        [2700, () => {
          const s = sheetOpen(p, tr("transfer.kind.repayment"), { foot: true });
          h("p", "hint", tr("settle.contextTheyOwe", { name: "Ana", cur: ctx.home, amount: ctx.money(100) }), s);
          amountBox = box(s, tr("field.amount"), "", { ph: "0.00" });
          box(s, tr("field.date"), fmtDay(0));
          box(s, tr("field.paymentMethod"), tr("scene.savings"), { select: true });
          saveBtn = primary(p.sh.foot, tr("settle.save"));
        }],
        [3300, (i) => fg.to(amountBox.box, i)],
        [3800, (i) => { fg.tap(i); amountBox.box.classList.add("focus"); }],
        [3900, () => { amountBox.value.textContent = "4"; saveBtn.textContent = tr("settle.recordAmount", { amount: ctx.home + " " + ctx.money(4) }); }],
        [4100, () => { amountBox.value.textContent = "40"; saveBtn.textContent = tr("settle.recordAmount", { amount: ctx.home + " " + ctx.money(40) }); }],
        [4600, (i) => { amountBox.box.classList.remove("focus"); fg.to(saveBtn, i); }],
        [5100, (i) => { fg.tap(i); press(saveBtn); }],
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

  // ---- Projections tab, told in 6 numbered steps the person advances with "Next step" (the real screens and words; numbers made up):
  //      1 the projected totals   2 a category's three lines (Confirmed / Programmed / Expected)   3 tap it: chart + the sums
  //      4 tap Expected: how it was worked out   5 set the remaining by hand ("Manually set")   6 how to get the most out of it
  SCENES.projections = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr;
      const money = (n) => ctx.home + " " + ctx.money(n);
      const now = new Date(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const left = Math.min(dim - 4, Math.max(4, dim - now.getDate())), frac = left / dim;   // the days still to come this month
      const cats = [
        { key: "groceries", rate: 600, actual: Math.round(600 * (1 - frac) * 1.1), prog: 0, exp: Math.round(600 * frac) },
        { key: "home", rate: 0, actual: 0, prog: 1500, exp: 0 },
        { key: "restaurants", rate: 300, actual: Math.round(300 * (1 - frac) * 0.9), prog: 0, exp: Math.round(300 * frac) }
      ];
      cats.forEach((c) => { c.icon = CATS[c.key][0]; c.name = tr(CATS[c.key][1]); c.total = c.actual + c.prog + c.exp; });
      const add = (k) => cats.reduce((s, c) => s + c[k], 0);
      const income = 3500, invest = 500, expenses = add("total");
      const p = device(stage, ctx, { nav: "projections", h: 600 });
      Object.assign(p, { money, now, dim, left, frac, cats });
      // the top card: the projected totals and the confirmed + programmed + expected lines
      p.top = h("div", "card", null, p.scroll);
      h("h2", null, tr("nav.projections"), p.top);
      h("p", "hint", tr("projections.projectedFor", { period: ctx.period || "" }), p.top);
      p.sum = h("div", "summary-grid", null, p.top);
      [["summary.income", "+" + money(income), "income"], ["summary.expenses", "−" + money(expenses), "expense"], ["summary.investments", "−" + money(invest), "investment"],
        ["projections.netMonthEnd", "+" + money(income - expenses - invest), ""]].forEach(([k, v, cls]) => {
        const c = h("div", "summary-item", null, p.sum);
        h("span", "summary-label", tr(k), c);
        h("span", "summary-value" + (cls ? " " + cls : ""), v, c);
      });
      h("p", "projections-breakdown", tr("projections.lineIncome", { actual: money(income), programmed: money(0) }), p.top);
      h("p", "projections-breakdown", tr("projections.lineExpenses", { actual: money(add("actual")), programmed: money(add("prog")), expected: money(add("exp")) }), p.top);
      // By category: one row each, three lines under the name
      p.list = h("div", "card", null, p.scroll);
      h("h2", null, tr("overview.byCategory"), p.list);
      p.drawRow = (c) => {
        c.amount.textContent = "−" + money(c.total);
        c.lines.innerHTML = "";
        const line = (icon, amount, label) => { const l = h("div", null, null, c.lines); h("span", "projection-line-icon", icon, l); h("span", "projection-line-amount", money(amount), l); h("span", "projection-line-label", label, l); };
        line("✅", c.actual, tr("projections.actual"));
        if (c.manual) line("✏️", c.remaining, tr("projections.remainingManual"));
        else { line("🔁", c.prog, tr("projections.programmed")); line("📈", c.exp, tr("projections.expected")); }
      };
      cats.forEach((c) => {
        c.row = h("div", "recurring-row projection-row-expanded", null, p.list);
        const top = h("div", "projection-row-top", null, c.row);
        h("div", "recurring-row-name", c.icon + " " + c.name, top); c.amount = h("div", "recurring-row-amount", "", top);
        c.lines = h("div", "projection-row-breakdown", null, c.row);
        p.drawRow(c);
      });
      p.list2 = h("ol", "ts-captions", null, stage);
      p.caps = ["scene.proj.s1", "scene.proj.s2", "scene.proj.s3", "scene.proj.s4", "scene.proj.s5", "scene.proj.s6"].map((key, k) => { const li = h("li", null, null, p.list2); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(key), li); return li; });
      return p;
    },
    initial(p, ctx) { /* the starting picture is the Projections screen itself */ },
    steps: [
      // 1 — the projected totals
      (p, ctx, instant, later) => {
        capStep(p, 1);
        later(() => p.finger.to(p.sum, instant), 400);
        later(() => { p.finger.tap(instant); p.top.classList.add("ts-now"); }, 900);
        later(() => { p.top.classList.remove("ts-now"); p.finger.hide(); }, 2400);
        return 2500;
      },
      // 2 — the three lines of one category
      (p, ctx, instant, later) => {
        capStep(p, 2);
        later(() => scrollTo(p, p.list), 100);
        later(() => { p.cats[0].row.classList.add("ts-now"); p.finger.to(p.cats[0].lines, instant); }, 1200);
        return 2600;
      },
      // 3 — tap the category: its chart and the sums
      (p, ctx, instant, later) => {
        const tr = ctx.tr, c = p.cats[0];
        capStep(p, 3);
        later(() => p.finger.tap(instant), 300);
        later(() => {
          p.finger.hide();
          const s = sheetOpen(p, c.icon + " " + c.name, { tall: true });
          h("p", "hint", (ctx.period || "") + " · " + tr("drill.projectedLegend"), s);
          // the chart: the solid line is the spend so far, the dashed one where it is heading
          const NS = "http://www.w3.org/2000/svg", W = 330, H = 90, x = Math.round(W * (1 - p.frac));
          const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("class", "ts-pchart"); s.appendChild(svg);
          const line = (pts, cls) => { const l = document.createElementNS(NS, "polyline"); l.setAttribute("points", pts); l.setAttribute("class", cls); svg.appendChild(l); };
          line("0," + (H - 4) + " " + Math.round(x * 0.3) + "," + (H - 22) + " " + Math.round(x * 0.6) + "," + (H - 36) + " " + x + "," + (H - 50), "ts-pl-actual");
          line(x + "," + (H - 50) + " " + W + "," + 10, "ts-pl-proj");
          const lg = h("div", "chart-legend", null, s);
          const a = h("span", null, null, lg); h("span", "chart-legend-swatch legend-actual", null, a); a.appendChild(document.createTextNode(tr("drill.actualSpend")));
          const b = h("span", null, null, lg); h("span", "chart-legend-swatch legend-pace", null, b); b.appendChild(document.createTextNode(tr("drill.projectedLegend")));
          const drow = (label, value) => { const r = h("div", "ts-drow", null, s); h("span", null, label, r); h("b", null, value, r); return r; };
          p.dActual = drow(tr("drill.actual"), p.money(c.actual));
          p.dProg = drow(tr("drill.programmed") + " " + tr("drill.tapToTrace"), p.money(c.prog));
          p.dExp = drow(tr("drill.expected") + " " + tr("drill.tapToTrace"), p.money(c.exp));
          p.trace = h("div", "ts-trace", null, s); p.trace.hidden = true;
          p.dTot = drow(tr("drill.periodTotal") + " " + tr("drill.periodTotalHint"), p.money(c.total));   // Confirmed + Programmed + Expected; tap it to set a figure by hand
          p.dTot.classList.add("edit");
        }, 700);
        return 2100;
      },
      // 4 — tap Expected: how it was worked out
      (p, ctx, instant, later) => {
        const tr = ctx.tr, c = p.cats[0];
        capStep(p, 4);
        later(() => p.finger.to(p.dExp, instant), 300);
        later(() => {
          p.finger.tap(instant); p.dExp.classList.add("ts-now");
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
        capStep(p, 5);
        later(() => { p.dExp.classList.remove("ts-now"); p.finger.to(p.dTot, instant); }, 300);
        later(() => {
          p.finger.tap(instant);
          const s = sheetOpen(p, tr("projOverride.title"), { foot: true });
          h("p", "hint", tr("projOverride.subtitleCalculated", { category: c.name, amount: p.money(c.total) }), s);
          const tabs = seg(s, [tr("projOverride.total"), tr("projOverride.remaining")], 0);
          p.remTabs = tabs; p.remTab = tabs[1];
          p.ovBox = box(s, ctx.home, "", { ph: "0.00" });
          h("p", "hint", tr("projOverride.hintRemaining", { actual: p.money(c.actual) }), s);
          link(s, ctx, "toggle", tr("projOverride.reset"));
          p.ovSave = primary(p.sh.foot, tr("common.save"));
        }, 800);
        later(() => p.finger.to(p.remTab, instant), 1500);
        later(() => { p.finger.tap(instant); segOn(p.remTabs, p.remTab); }, 2000);
        later(() => p.finger.to(p.ovBox.box, instant), 2500);
        later(() => { p.finger.tap(instant); p.ovBox.box.classList.add("focus"); p.ovBox.value.textContent = "450"; }, 3000);
        later(() => p.finger.to(p.ovSave, instant), 3700);
        later(() => { p.finger.tap(instant); press(p.ovSave); }, 4200);
        later(() => {
          p.finger.hide(); sheetClose(p);
          c.manual = true; c.remaining = 450; c.total = c.actual + 450;
          p.drawRow(c); c.row.classList.add("ts-now");
          scrollTo(p, p.list);
        }, 4600);
        return 5400;
      },
      // 6 — how to get the most out of it (the whole list again)
      (p, ctx, instant, later) => {
        capStep(p, 6);
        later(() => { p.cats[0].row.classList.remove("ts-now"); p.list.classList.add("ts-now"); }, 200);
        later(() => p.list.classList.remove("ts-now"), 1800);
        return 1900;
      }
    ]
  };

  // ---- Pro: split a restaurant bill. The expense form → Split with friends → By items → who is splitting → the photo reads the dishes →
  //      a misread price is fixed → who shared each dish → the tip → the total check → "Use this split" fills the form. Every number comes
  //      from the app's own BillSplit maths and every line of text from its own strings. ----
  const BILL_NAMES = { ana: "Ana", luis: "Luis" };
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
    p.check.className = "hint";
    if (res.printedCents > 0) {
      if (res.diffCents === 0) { p.check.classList.add("ts-ok"); p.check.textContent = tr("bill.checkOk", { counted, printed: fmt(res.printedCents) }); }
      else {
        p.check.classList.add("ts-bad");
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
        h("div", "hint", bits.join(" · "), left);
        h("b", null, fmt(pp.total), row);
      });
      if (res.tipCents) h("div", "hint", tr("bill.tipTotal", { tip: fmt(res.tipCents), total: fmt(res.grandCents) }), p.results);
    }
    p.apply.classList.toggle("ts-off", !res.ok);
    return res;
  }
  SCENES.bill = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home;
      const p = device(stage, ctx, { nav: "entries", h: 600 });
      Object.assign(p, { tipPct: "", total: "", sel: {}, shown: false });
      p.fmt = (cents) => cur + " " + ctx.money(cents / 100);
      // the expense form, open with its details unfolded (the starting picture)
      const f = sheetOpen(p, tr("entry.newTitle"), { tall: true, foot: true });
      p.formSheet = p.sh;
      typeTabs(f, ctx, "expense");
      const banner = h("div", "category-banner", null, f);
      catIcon(banner, "restaurants", "category-banner-icon"); h("span", null, tr("scene.cat.restaurants"), banner);
      link(banner, ctx, "pencil", tr("common.change"));
      p.amountBox = box(f, tr("field.amount"), "", { ph: "0.00" });
      p.splitChk = check(f, tr("split.toggle"));
      p.splitDetail = h("div", null, null, f); p.splitDetail.hidden = true;
      p.modes = seg(p.splitDetail, [tr("split.equal"), tr("split.percent"), tr("split.custom"), tr("split.byItems")], 0);
      p.splitSummary = h("p", "hint", null, p.splitDetail);
      p.save = primary(p.sh.foot, tr("entry.save"));
      // the bill sheet (opens from "By items")
      p.sh = null;
      const S = sheetOpen(p, tr("bill.title"), { tall: true, foot: true });
      p.billSheet = p.sh; p.billSheet.back.classList.remove("show");
      p.photoBtn = link(S, ctx, "camera", tr("bill.photo"));
      p.status = h("p", "hint", null, S); p.status.hidden = true;
      p.totalBox = box(S, tr("bill.totalBefore") + " (" + cur + ")", "", { ph: "0.00" });
      h("label", null, tr("bill.who"), S);
      const who = h("div", "tags-list", null, S);
      p.friends = {}; Object.keys(BILL_NAMES).forEach((k) => { p.friends[k] = h("div", "tag-chip", BILL_NAMES[k], who); });
      p.itemsLabel = h("label", null, tr("bill.items"), S);
      // what the photo reads (one price is misread, the way a thermal printout sometimes is) and the right price
      p.items = [["Ceviche", "40.00", "40.00"], ["Lomo saltado", "82.00", "32.00"], ["Pasta", "28.00", "28.00"], ["Pizza", "20.00", "20.00"]].map(([name, read, right]) => {
        const it = { name, price: read, right, people: new Set(), chips: {} };
        it.row = h("div", "ts-bill-item", null, S); it.row.hidden = true;
        const ln = h("div", "ts-bill-line", null, it.row); h("b", null, name, ln); it.priceEl = h("span", "ts-bill-price", read, ln);
        const cs = h("div", "tags-list", null, it.row);
        [["me", tr("common.me")], ["ana", "Ana"], ["luis", "Luis"]].forEach(([key, label]) => { it.chips[key] = h("div", "tag-chip", label, cs); });
        return it;
      });
      p.check = h("p", "hint", null, S);
      p.adjLabel = h("label", null, tr("bill.adjs"), S);
      const adj = h("div", "ts-bill-adj", null, S);
      p.addDiscount = link(adj, ctx, "plus", tr("bill.addDiscount").replace(/^\+\s*/, "")); link(adj, ctx, "plus", tr("bill.addCharge").replace(/^\+\s*/, ""));
      p.tipLabel = h("label", null, tr("bill.tip"), S);
      seg(S, [tr("bill.tipPercentTab"), tr("bill.tipAmountTab")], 0);
      p.tipBox = box(S, tr("bill.tipPercentLabel"), "");
      p.tipPreview = h("p", "hint", null, S);
      seg(S, [tr("bill.byOrdered"), tr("split.equal")], 0);
      p.results = h("div", "ts-bill-res", null, S);
      p.apply = primary(p.sh.foot, tr("bill.apply"));
      p.sh = p.formSheet;
      // the explanations, one more appearing at each step
      p.list2 = h("ol", "ts-captions", null, stage);
      p.caps = [["tour.bill.l1", "tour.bill.t1"], ["tour.bill.l2", "tour.bill.t2"], ["tour.bill.l3", "tour.bill.t3"], ["tour.bill.l4", "tour.bill.t4"],
        ["tour.bill.l5", "tour.bill.t5"], ["tour.bill.l6", "tour.bill.t6"], ["tour.bill.l7", "tour.bill.t7"], ["tour.bill.l8", "tour.bill.t8"]].map(([head, text], k) => {
        const li = h("li", null, null, p.list2); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(head) + ": " + tr(text), li); return li;
      });
      billRecompute(p);
      return p;
    },
    initial(p, ctx) { /* the starting picture is the empty expense form */ },
    steps: [
      // 1 — Split with friends, then By items: the bill sheet opens
      (p, ctx, instant, later) => {
        capStep(p, 1);
        later(() => p.finger.to(p.splitChk.row, instant), 400);
        later(() => { p.finger.tap(instant); p.splitChk.set(true); p.splitDetail.hidden = false; }, 900);
        later(() => p.finger.to(p.modes[3], instant), 1500);
        later(() => { p.finger.tap(instant); segOn(p.modes, p.modes[3]); }, 2000);
        later(() => { p.sh = p.billSheet; p.billSheet.back.classList.add("show"); p.finger.hide(); }, 2250);
        return 2800;
      },
      // 2 — tap the friends who are splitting
      (p, ctx, instant, later) => {
        capStep(p, 2);
        ["ana", "luis"].forEach((k, n) => {
          later(() => p.finger.to(p.friends[k], instant), 300 + n * 900);
          later(() => { p.finger.tap(instant); p.friends[k].classList.add("selected"); p.sel[k] = true; billRecompute(p); }, 750 + n * 900);
        });
        later(() => p.finger.hide(), 2300);
        return 2400;
      },
      // 3 — the photo reads the dishes (and the total printed on the bill)
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        capStep(p, 3);
        later(() => p.finger.to(p.photoBtn, instant), 300);
        later(() => { p.finger.tap(instant); press(p.photoBtn); p.status.textContent = tr("photo.reading"); p.status.hidden = false; }, 800);
        later(() => {
          unpress(p.photoBtn); p.finger.hide();
          p.status.textContent = tr("photo.readN", { n: 4, notes: "" });
          p.shown = true; p.total = "120.00"; p.totalBox.value.textContent = p.total;
          p.items.forEach((it) => { it.row.hidden = false; });
          billRecompute(p);
        }, 2000);
        later(() => sheetScrollTo(p, p.itemsLabel), 2600);
        return 3700;
      },
      // 4 — the check line says "too much": one price was misread; fix it
      (p, ctx, instant, later) => {
        const it = p.items[1];
        capStep(p, 4);
        later(() => { sheetScrollTo(p, it.row); p.check.classList.add("ts-now"); }, 100);
        later(() => p.finger.to(it.priceEl, instant), 1300);
        later(() => { p.finger.tap(instant); it.priceEl.classList.add("focus"); }, 1800);
        ["3", "32", "32.0", "32.00"].forEach((v, n) => later(() => { it.price = v; it.priceEl.textContent = v; billRecompute(p); p.check.classList.add("ts-now"); }, 1950 + n * 200));
        later(() => { it.priceEl.classList.remove("focus"); p.finger.hide(); }, 3000);
        later(() => p.check.classList.remove("ts-now"), 3400);
        return 3500;
      },
      // 5 — tap who shared each dish
      (p, ctx, instant, later) => {
        capStep(p, 5);
        let t = 100;
        later(() => sheetScrollTo(p, p.items[0].row), t);
        t = 1200;
        [[0, "me"], [0, "ana"], [1, "me"], [2, "ana"], [3, "luis"]].forEach(([k, who]) => {
          if (k === 2) { const at = t; later(() => sheetScrollTo(p, p.items[2].row), at); t += 1100; }
          const at = t;
          later(() => p.finger.to(p.items[k].chips[who], instant), at);
          later(() => { p.finger.tap(instant); p.items[k].people.add(who); p.items[k].chips[who].classList.add("selected"); billRecompute(p); }, at + 450);
          t += 900;
        });
        later(() => p.finger.hide(), t);
        return t + 200;
      },
      // 6 — discounts and extra charges exist; the tip is typed as a percentage
      (p, ctx, instant, later) => {
        capStep(p, 6);
        later(() => sheetScrollTo(p, p.adjLabel), 100);
        later(() => p.finger.to(p.addDiscount, instant), 1200);
        later(() => sheetScrollTo(p, p.tipLabel), 2300);
        later(() => p.finger.to(p.tipBox.box, instant), 3400);
        later(() => { p.finger.tap(instant); p.tipBox.box.classList.add("focus"); }, 3900);
        ["1", "10"].forEach((v, n) => later(() => { p.tipPct = v; p.tipBox.value.textContent = v; billRecompute(p); }, 4000 + n * 250));
        later(() => { p.tipBox.box.classList.remove("focus"); p.finger.hide(); }, 4800);
        return 5000;
      },
      // 7 — the total printed on the bill against the dishes: a green ✓
      (p, ctx, instant, later) => {
        capStep(p, 7);
        later(() => sheetScrollTo(p, p.totalBox.box), 100);
        later(() => p.finger.to(p.totalBox.box, instant), 1200);
        later(() => { p.finger.tap(instant); p.totalBox.box.classList.add("focus"); }, 1700);
        later(() => { p.totalBox.box.classList.remove("focus"); p.finger.hide(); sheetScrollTo(p, p.itemsLabel); }, 2500);
        later(() => p.check.classList.add("ts-now"), 3500);
        later(() => p.check.classList.remove("ts-now"), 5000);
        return 5100;
      },
      // 8 — Use this split: the form is filled in; Save entry
      (p, ctx, instant, later) => {
        capStep(p, 8);
        later(() => sheetScrollTo(p, p.results), 100);
        later(() => p.finger.to(p.apply, instant), 1700);
        later(() => { p.finger.tap(instant); press(p.apply); }, 2200);
        later(() => {
          unpress(p.apply); p.billSheet.back.classList.remove("show"); p.sh = p.formSheet;
          const res = billRecompute(p), money = (c) => ctx.money(c / 100);
          p.amountBox.value.textContent = money(res.grandCents);
          p.splitSummary.textContent = ctx.tr("split.summaryCustom", { cur: ctx.home, friends: money(res.grandCents - res.perPerson.me.total), total: money(res.grandCents), own: money(res.perPerson.me.total) });
        }, 2500);
        later(() => p.finger.to(p.save, instant), 3300);
        later(() => { p.finger.tap(instant); press(p.save); }, 3800);
        later(() => { unpress(p.save); p.finger.hide(); }, 4200);
        return 4300;
      }
    ]
  };

  // ---- The More tab: a copy of the person's own More tab (its rows, groups, icons and words, the language picker at the bottom); the
  //      finger drags the list down to the language picker and back up (it does not open any section). ----
  SCENES.more = {
    hold: 2200,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "more" });
      p.rows = {};
      const real = document.getElementById("screen-more");
      if (real) Array.from(real.children).forEach((c) => { if (!c.hidden && c.classList.contains("card")) p.scroll.appendChild(strip(c.cloneNode(true))); });
      // the row the finger rests on: Currencies (the first visible row of the second group if that row is missing)
      const groups = p.scroll.querySelectorAll(".more-group");
      p.anchor = (groups[1] && groups[1].querySelector(".more-list-item:not([hidden])")) || p.scroll.querySelector(".more-list-item");
      p.lang = p.scroll.querySelector("select") || p.scroll.lastElementChild;
      return p;
    },
    timeline(p, ctx) {
      const fg = p.finger;
      return [
        [500, (i) => fg.to(p.anchor, i)],
        [1000, () => scrollTo(p, p.lang, 300)],   // the finger drags the list up: the rest of More, down to the language
        [1100, (i) => fg.to(p.lang, i)],
        [3600, () => scrollTo(p, null)],          // and back to the top
        [3700, (i) => fg.to(p.anchor, i)],
        [5200, () => fg.hide()]
      ];
    }
  };

  // ---- More → My data → Bank statements, told in 6 numbered steps the person advances with "Next step" (the real screens and words;
  //      numbers and merchants made up):
  //      1 read two statements at once, then "Read my statements"   2 the summary: what is added, what is already in the app
  //      3 payments with people (a Yape): spending by default, or Needs review   4 a transfer between your accounts is found on both statements and recorded once
  //      5 balances: Set balance to statement   6 Add to my history (one step, undoable)
  SCENES.statements = {
    manual: true,
    build(stage, ctx) {
      const tr = ctx.tr, cur = ctx.home;
      const money = (n) => (n < 0 ? "−" : "") + cur + " " + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const p = device(stage, ctx, { nav: "more", h: 600 });
      Object.assign(p, { money, sel: {} });
      const head = subHead(p.scroll, tr("stmt.title"), []);
      // view A: Read a statement
      p.a = h("div", null, null, head.card);
      h("h3", null, tr("stmt.read"), p.a);
      p.choose = primary(p.a, tr("stmt.choose"));
      p.results = h("div", "ts-stmt-result", null, p.a);
      // view B: the summary the app shows after reading (real order: summary, people, balances; the steps scroll to the one being explained)
      p.b = h("div", null, null, head.card); p.b.hidden = true;
      p.groups = {};
      const group = (key, title, hint) => {
        const g = h("div", "ts-sg", null, p.b);
        h("h3", null, title, g);
        if (hint) h("p", "hint", hint, g);
        p.groups[key] = g; return g;
      };
      const line = (g, date, desc, amt, sub) => {
        const it = h("div", "ts-sl", null, g);
        const l = h("div", "ts-sline", null, it);
        h("span", "hint", fmtMd(date), l); h("span", null, desc, l); h("b", null, money(amt), l);
        if (sub) h("p", "hint", sub, it);
        return it;
      };
      const choices = (it, labels) => tags(it, labels);
      const gSum = group("sum", tr("hist.ready"));
      p.sums = h("div", null, null, gSum);
      p.sumLine = (text) => h("p", "hint", "• " + text, p.sums);
      p.sumLine(tr("hist.sum.expenses", { n: 3, total: money(93.5).replace("−", "") }));
      p.sumLine(tr("hist.sum.transfers", { n: 1 }));
      p.sumLine(tr("hist.sum.linked", { n: 2 }));
      const gPeople = group("people", tr("hist.people.title", { n: 1 }));
      p.peopleItem = line(gPeople, -5, "YAPE-ANA", -20, tr("scene.savings"));
      [p.peopleSpend, p.peopleReview] = choices(p.peopleItem, [tr("hist.people.spending"), tr("hist.people.review"), tr("hist.people.leave")]);
      stmtPick(p, p.peopleSpend, "spending");
      const gBal = group("balance", tr("bal.title", { n: 1 }), tr("bal.hint"));
      const bal = h("div", "ts-sl", null, gBal);
      h("b", null, tr("scene.savings") + " · " + cur, bal);
      const kv = (a, b) => { const r = h("div", "ts-kv", null, bal); h("span", null, a, r); h("span", null, b, r); };
      kv(tr("stmt.balClosing", { date: fmtDay(-1) }), money(2512));
      kv(tr("stmt.balInApp"), money(2880));
      kv(tr("stmt.balDiff"), cur + " −368.00");
      h("p", "hint ts-ok", tr("stmt.balExplained", { parts: tr("stmt.balNotInApp", { amount: cur + " −368.00", n: 3 }) }), bal);
      p.balChip = choices(bal, [tr("stmt.choice.setBalance")])[0];
      // the save bar (pinned at the bottom of the screen once there is a summary)
      p.bar = h("div", "ts-stmt-bar", null, p.app); p.bar.hidden = true;
      p.summary = h("p", "hint", tr("hist.noCategory"), p.bar);
      p.save = primary(p.bar, tr("hist.add"));
      p.list2 = h("ol", "ts-captions", null, stage);
      p.caps = ["scene.stmt.s1", "scene.stmt.s2", "scene.stmt.s3", "scene.stmt.s4", "scene.stmt.s5", "scene.stmt.s6"].map((key, k) => { const li = h("li", null, null, p.list2); h("span", "ts-stepnum", String(k + 1), li); h("span", null, tr(key), li); return li; });
      return p;
    },
    initial(p, ctx) { /* the starting picture is just the empty "Read a statement" screen */ },
    steps: [
      // 1 — read two statements at once; each one is checked; then Read my statements
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        capStep(p, 1);
        later(() => p.finger.to(p.choose, instant), 400);
        later(() => { p.finger.tap(instant); press(p.choose); }, 900);
        later(() => { unpress(p.choose); p.results.innerHTML = ""; h("p", "hint", tr("stmt.reading"), p.results); }, 1200);
        later(() => {
          p.results.innerHTML = "";
          [tr("scene.savings"), tr("accounts.type.credit")].forEach((name) => {
            const c = h("div", "ts-stmt-card", null, p.results);
            h("p", "hint ts-ok", tr("stmt.verdictGood"), c);
            h("p", "hint", tr("stmt.noteAccount", { label: name }), c);
          });
          p.reviewBtn = primary(p.results, tr("hist.button"));
        }, 2200);
        later(() => p.finger.to(p.reviewBtn, instant), 3000);
        later(() => { p.finger.tap(instant); press(p.reviewBtn); }, 3500);
        later(() => { p.a.hidden = true; p.b.hidden = false; p.bar.hidden = false; p.finger.hide(); stmtFocus(p, null); }, 3800);
        return 4400;
      },
      // 2 — the summary: what will be added, what is already in the app (nothing is saved yet)
      (p, ctx, instant, later) => {
        capStep(p, 2); stmtFocus(p, "sum"); scrollTo(p, p.groups.sum);
        later(() => p.finger.hide(), 200);
        return 3200;
      },
      // 3 — payments with people: what you paid is spending by default; one can go to Needs review instead
      (p, ctx, instant, later) => {
        capStep(p, 3); stmtFocus(p, "people"); scrollTo(p, p.groups.people);
        later(() => p.finger.to(p.peopleReview, instant), 1000);
        later(() => { p.finger.tap(instant); stmtPick(p, p.peopleReview, "review"); }, 1600);
        later(() => p.finger.hide(), 2400);
        return 2800;
      },
      // 4 — a transfer between your accounts: its two sides (one on each statement) are recorded once
      (p, ctx, instant, later) => {
        capStep(p, 4); stmtFocus(p, "sum"); scrollTo(p, p.groups.sum);
        later(() => p.sums.children[1].classList.add("ts-ok"), 600);
        return 3200;
      },
      // 5 — balances: the statement's closing balance against the app's; Set balance to statement
      (p, ctx, instant, later) => {
        capStep(p, 5); stmtFocus(p, "balance"); scrollTo(p, p.groups.balance);
        later(() => p.finger.to(p.balChip, instant), 1000);
        later(() => { p.finger.tap(instant); stmtPick(p, p.balChip, "set"); p.sumLine(ctx.tr("hist.sum.balances", { n: 1 })); }, 1500);
        later(() => p.finger.hide(), 2200);
        return 2600;
      },
      // 6 — Add to my history: everything is applied at once, and can be undone at once
      (p, ctx, instant, later) => {
        const tr = ctx.tr;
        capStep(p, 6); stmtFocus(p, null);
        later(() => p.finger.to(p.save, instant), 700);
        later(() => { p.finger.tap(instant); press(p.save); }, 1300);
        later(() => {
          unpress(p.save); p.finger.hide();
          p.summary.textContent = tr("stmt.saved") + " · " + tr("stmt.recentHint");
          p.summary.classList.add("ts-ok");
          p.save.hidden = true;
        }, 1700);
        return 2400;
      }
    ]
  };
  // helpers of the step-by-step scenes
  function capStep(p, n) { p.caps.forEach((li, k) => { if (k < n) li.classList.add("show"); li.classList.toggle("now", k === n - 1); }); }
  function stmtFocus(p, key) { Object.keys(p.groups).forEach((k) => p.groups[k].classList.toggle("ts-dim", !!key && k !== key)); }
  function stmtPick(p, chip, key) {
    Array.from(chip.parentNode.children).forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    p.sel[key] = true;
  }

  // ---- More → My data: a copy of the person's own hub (its headings, rows, icons and words; Recently deleted only where the app shows it).
  //      The finger visits every row.
  SCENES.mydata = {
    hold: 2200,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "more" });
      const real = document.querySelector("#screen-my-data .card");
      if (real) p.scroll.appendChild(strip(real.cloneNode(true)));
      p.rows = Array.from(p.scroll.querySelectorAll(".md-row:not([hidden])"));
      return p;
    },
    timeline(p, ctx) {
      const steps = [];
      p.rows.forEach((r, k) => {
        steps.push([500 + k * 1000, (i) => { p.rows.forEach((m) => m.classList.toggle("ts-lit", m === r)); p.finger.to(r, i); p.finger.tap(i); }]);
      });
      steps.push([500 + p.rows.length * 1000, () => { p.rows.forEach((m) => m.classList.remove("ts-lit")); p.finger.hide(); }]);
      return steps;
    }
  };

  // ---- The big picture, as a flow chart told in 4 numbered steps the person advances with "Next step" ----
  //      1 Income lands in a savings account (it was at zero) → the Result appears.   2 A credit card pays an expense → the card goes negative, the Result down.
  //      3 Savings pays the card (a transfer) → only moves money between accounts, the Result does not change.   4 Savings puts money into a platform
  //      (an investment) → the Result down. Result = income − expenses − investments (Overview's own formula). Platforms are never in Balances.
  //      (A diagram, not a screen: it is drawn as a chart, in the app's colours.)
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
      const frame = h("div", "ts-chartframe", null, stage);
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
      // the Result
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
      // 1 — Income: the box appears, then the savings account (at zero), the money flows in, the Result appears
      (p, ctx, instant, later) => {
        step(p, 1, [p.income]);
        later(() => { lit(p.savings); lit(p.incomeArrow); run(p.incomeLine, true); }, 900);
        later(() => { setAmt(p.savingsAmt, p.fmt(3500)); lit(p.net); setAmt(p.netVal, p.fmt(3500)); }, 1900);
        later(() => run(p.incomeLine, false), 2600);
        return 3000;
      },
      // 2 — Expense: income and savings slide left, the credit card appears, pays an expense and goes negative; the Result goes down
      (p, ctx, instant, later) => {
        step(p, 2, []);
        p.colA.classList.add("left");
        later(() => lit(p.card), 900);
        later(() => { lit(p.expense); lit(p.expenseArrow); run(p.expenseLine, true); }, 1800);
        later(() => { setAmt(p.cardAmt, "−" + p.fmt(120)); p.cardAmt.classList.add("neg"); lit(p.net); setAmt(p.netVal, p.fmt(3380)); }, 2700);
        later(() => run(p.expenseLine, false), 3400);
        return 3800;
      },
      // 3 — Transfer: savings pays the card; only the two accounts change, the Result stays where it was (it stays dimmed)
      (p, ctx, instant, later) => {
        step(p, 3, [p.savings, p.card]);
        later(() => { lit(p.transfer); lit(p.transferArrow); run(p.transferLine, true); }, 600);
        later(() => { setAmt(p.savingsAmt, p.fmt(3380)); setAmt(p.cardAmt, p.fmt(0)); p.cardAmt.classList.remove("neg"); }, 1700);
        later(() => run(p.transferLine, false), 2400);
        return 2800;
      },
      // 4 — Investment: savings puts money into a platform; the Result goes down. At the end everything is lit up.
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

  // ---- Overview tab: this month's totals and the Result, then the Breakdown "By category" (pie + list); tap a category → its entries ----
  //      The made-up month: Income 3,500 − Expenses 1,920 − Investments 500 = Result 1,080 (the app's own formula).
  const PIE = {
    expense: [["home", 700, "#F7D9C4"], ["groceries", 480, "#C9E4F7"], ["restaurants", 320, "#E0D9F7"], ["transport", 260, "#FFE0B2"], ["shopping", 160, "#F7C6D9"]],
    income: [["salary", 3200, "#D9F2D9"], ["extraIncome", 300, "#D9F7F0"]]
  };
  SCENES.overview = {
    hold: 1800,
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
      p.tabExpense = h("div", "type-tab active", tr("type.expense"), tabs); p.tabExpense.dataset.type = "expense";
      p.tabIncome = h("div", "type-tab", tr("type.income"), tabs); p.tabIncome.dataset.type = "income";
      const sec = h("div", "breakdown-section", null, p.card);
      h("h3", null, tr("overview.byCategory"), sec);
      p.wrap = h("div", "pie-chart-wrap", null, sec);
      p.pie = h("div", "pie-chart", null, p.wrap);
      p.legend = h("div", "chart-legend", null, sec);
      p.draw = (type) => {
        const items = PIE[type], total = items.reduce((s, it) => s + it[1], 0);
        p.wrap.querySelectorAll(".pie-outside-label").forEach((e) => e.remove());
        p.legend.innerHTML = "";
        let cum = 0; const stops = []; p.rows = [];
        const half = 110;   // the pie's frame is 220 px square in the app
        items.forEach(([key, amt, color]) => {
          const pct = amt / total * 100;
          stops.push(color + " " + cum + "% " + (cum + pct) + "%");
          if (pct >= 4) {   // the app labels slices of 4% and more outside the pie
            const a = (cum + pct / 2) / 100 * 2 * Math.PI, r = half * 0.82;
            const lab = h("div", "pie-outside-label", null, p.wrap);
            lab.style.left = (half + r * Math.sin(a)) + "px"; lab.style.top = (half - r * Math.cos(a)) + "px";
            const ic = h("span", "pie-outside-icon", CATS[key][0], lab); ic.style.background = color;
            h("span", "pie-outside-pct", Math.round(pct) + "%", lab);
          }
          cum += pct;
          const row = h("div", "legend-row", null, p.legend);
          const sw = h("span", "legend-swatch", null, row); sw.style.background = color;
          const text = h("div", "legend-text", null, row);
          h("div", "legend-name", CATS[key][0] + " " + tr(CATS[key][1]), text);
          const sub = h("div", "legend-sub", null, text);
          h("span", "legend-amount", money(amt), sub); h("span", "legend-percent", pct.toFixed(1) + "%", sub);
          p.rows.push(row);
        });
        p.pie.style.background = "conic-gradient(" + stops.join(", ") + ")";
      };
      p.draw("expense");
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger;
      const tab = (type) => { p.tabExpense.classList.toggle("active", type === "expense"); p.tabIncome.classList.toggle("active", type === "income"); p.draw(type); };
      const today = new Date().getDate();
      const rows = [[0, "scene.descShop", 210], [-Math.floor(today / 2), null, 150], [1 - today, null, 120]];
      return [
        [1200, () => scrollTo(p, p.card)],
        [2600, (i) => fg.to(p.tabIncome, i)],
        [3100, (i) => { fg.tap(i); tab("income"); }],
        [4300, (i) => fg.to(p.tabExpense, i)],
        [4800, (i) => { fg.tap(i); tab("expense"); }],
        [5300, () => scrollTo(p, p.legend)],
        [5900, (i) => fg.to(p.rows[1], i)],
        [6400, (i) => { fg.tap(i); p.rows[1].classList.add("ts-lit"); }],
        [6700, () => {
          const s = sheetOpen(p, CATS.groceries[0] + " " + tr("scene.cat.groceries"), { tall: true });
          h("p", "hint", (ctx.period || "") + " · " + tr("type.expense"), s);
          rows.forEach(([off, desc, amt]) => {
            const r = h("div", "entry", null, s);
            const left = h("div", "entry-left", null, r);
            const t = h("div", "entry-category", null, left);
            catIcon(t, "groceries", "entry-cat-icon"); t.appendChild(document.createTextNode(tr("scene.cat.groceries")));
            if (desc) h("div", "entry-desc", tr(desc), left);
            h("div", "entry-meta", fmtDay(off) + " · " + tr("common.me"), left);
            const a = h("div", "entry-amount", null, r); h("span", "primary-amt", "−" + ctx.home + " " + ctx.money(amt), a);
          });
        }],
        [7600, () => fg.hide()],
        [10000, () => {}]
      ];
    }
  };

  // The Needs review card of Home, as the app draws it: a closed row "Needs review (1) ›" that opens on a tap, holding short rows with
  // a quick category pick and a one-tap Confirm.
  function reviewCard(parent, ctx, open) {
    const tr = ctx.tr;
    const card = h("div", "card review-queue" + (open ? "" : " review-closed"), null, parent);
    const bh = h("div", "budgets-header", null, card);
    const h2 = h("h2", null, null, bh);
    const toggle = h("div", "review-toggle", null, h2);
    h("span", null, tr("review.title") + " (1)", toggle); h("span", "review-toggle-chev", "›", toggle);
    const body = h("div", null, null, card); body.hidden = !open;
    h("p", "hint", tr("review.intro"), body);
    const item = h("div", "review-item review-collapsed review-more-closed", null, body);
    const top = h("div", "review-item-top", null, item);
    const left = h("div", null, null, top);
    h("div", "review-item-desc", "Cafe Luna", left);
    h("div", "review-item-meta", fmtDay(0) + " · " + tr("type.expense").toLowerCase(), left);
    h("div", "review-item-amount", out(ctx, 48), top);
    const quick = h("div", "review-quick", null, item);
    const cat = h("span", "review-quick-cat", tr("review.pickCategory"), quick);
    const confirm = h("button", "review-quick-confirm", tr("review.confirm"), quick); confirm.type = "button"; confirm.tabIndex = -1;
    return { card, toggle, body, item, cat, confirm, open: () => { body.hidden = false; card.classList.remove("review-closed"); } };
  }

  // ---- Home: a bank e-mail was read → "Needs review (1)" → open it → pick the category → Confirm → it joins Recent entries ----
  SCENES.bank = {
    hold: 1800,
    build(stage, ctx) {
      const p = device(stage, ctx, { nav: "entries", fab: true });
      p.review = reviewCard(p.scroll, ctx, false); p.review.card.hidden = true;
      p.list = entriesCard(p.scroll, ctx);
      p.list.add({ cat: "transport", amt: out(ctx, 6.5), net: -6.5 });
      p.list.add({ cat: "groceries", amt: out(ctx, 25.5), net: -25.5 });
      return p;
    },
    timeline(p, ctx) {
      const tr = ctx.tr, fg = p.finger, r = p.review;
      return [
        [800, () => { r.card.hidden = false; r.card.classList.add("ts-pop"); }],
        [1700, (i) => fg.to(r.toggle, i)],
        [2200, (i) => { fg.tap(i); r.open(); }],
        [3400, (i) => fg.to(r.cat, i)],
        [3900, (i) => { fg.tap(i); r.cat.classList.add("ts-lit"); }],
        [4500, () => { r.cat.textContent = CATS.restaurants[0] + " " + tr("scene.cat.restaurants"); r.cat.classList.remove("ts-lit"); }],
        [5200, (i) => fg.to(r.confirm, i)],
        [5700, (i) => { fg.tap(i); press(r.confirm); }],
        [6000, () => { r.card.hidden = true; p.list.add({ cat: "restaurants", desc: "Cafe Luna", amt: out(ctx, 48), net: -48 }, true); }],
        [6800, () => fg.hide()]
      ];
    }
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
      p.review = reviewCard(p.scroll, ctx, true); p.review.card.hidden = true;
      return p;
    },
    timeline(p) {
      return [
        [500, () => { p.mail.hidden = false; p.mail.classList.add("ts-pop"); }],
        [1600, () => { p.arrow.hidden = false; }],
        [2000, () => { p.review.card.hidden = false; p.review.card.classList.add("ts-pop"); }],
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
