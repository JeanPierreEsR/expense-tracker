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
  // Scene: add an expense (Entries tab): type the amount, pick a category, Save, the new entry appears.
  SCENES.add = {
    hold: 1800,
    build(stage, ctx) {
      const phone = h("div", "ts-phone", null, stage);
      h("div", "ts-bar", ctx.tr("nav.entries"), phone);
      const types = h("div", "ts-types", null, phone);
      h("span", "ts-pill on", ctx.tr("scene.expense"), types);
      h("span", "ts-pill", ctx.tr("scene.income"), types);
      h("span", "ts-pill", ctx.tr("scene.investment"), types);
      const field = h("div", "ts-field", null, phone);
      h("span", "ts-field-label", ctx.tr("scene.amount"), field);
      const amount = h("span", "ts-field-value", "", field);
      h("span", "ts-field-cur", ctx.home, field);
      const chips = h("div", "ts-chips", null, phone);
      const chip = [["🛒", "scene.groceries"], ["🚌", "scene.transport"], ["🍽️", "scene.dining"]].map(([i, k]) => h("span", "ts-chip", i + " " + ctx.tr(k), chips));
      const save = h("div", "ts-btn", ctx.tr("scene.save"), phone);
      const list = h("div", "ts-list", null, phone);
      h("div", "ts-list-title", ctx.tr("scene.recent"), list);
      const row = (name, amt, on) => { const r = h("div", "ts-row" + (on ? " enter" : ""), null, list); h("span", "ts-row-name", name, r); h("span", "ts-row-amt", amt, r); return r; };
      const rows = h("div", "ts-rows", null, list);
      const old1 = h("div", "ts-row", null, rows); h("span", "ts-row-name", "🍽️ " + ctx.tr("scene.dining"), old1); h("span", "ts-row-amt", ctx.home + " " + ctx.money(48), old1);
      const old2 = h("div", "ts-row", null, rows); h("span", "ts-row-name", "🚌 " + ctx.tr("scene.transport"), old2); h("span", "ts-row-amt", ctx.home + " " + ctx.money(6.5), old2);
      return { stage, phone, field, amount, chip, save, rows, finger: makeFinger(stage), ctx };
    },
    timeline(p, ctx) {
      const f = p.finger;
      const type = (txt) => (inst) => { p.amount.textContent = txt; };
      return [
        [0, (i) => f.to(p.stage.querySelector(".ts-bar"), true)],
        [300, (i) => f.to(p.field, i)],
        [900, (i) => { f.tap(i); p.field.classList.add("focus"); }],
        [1100, type("2")], [1300, type("25")], [1500, type("25.")], [1700, type("25.5")], [1900, type("25.50")],
        [2400, (i) => f.to(p.chip[0], i)],
        [3000, (i) => { f.tap(i); p.chip[0].classList.add("on"); }],
        [3500, (i) => f.to(p.save, i)],
        [4100, (i) => { f.tap(i); p.save.classList.add("pressed"); }],
        [4400, (i) => {
          p.save.classList.remove("pressed");
          p.field.classList.remove("focus"); p.amount.textContent = ""; p.chip[0].classList.remove("on");
          const r = h("div", "ts-row enter", null, null);
          h("span", "ts-row-name", "🛒 " + ctx.tr("scene.groceries"), r); h("span", "ts-row-amt", ctx.home + " " + ctx.money(25.5), r);
          p.rows.insertBefore(r, p.rows.firstChild);
          if (p.rows.children.length > 2) p.rows.removeChild(p.rows.lastChild);
        }],
        [5000, (i) => f.hide()]
      ];
    }
  };

  // ------------------------------------------------------------------
  // Scene: set a budget (Budgets tab): the bar fills as you spend, turns orange near the limit and red when over.
  SCENES.budgets = {
    hold: 1800,
    build(stage, ctx) {
      const phone = h("div", "ts-phone", null, stage);
      h("div", "ts-bar", ctx.tr("nav.budgets"), phone);
      const card = h("div", "ts-budget", null, phone);
      const head = h("div", "ts-budget-head", null, card);
      h("span", null, "🛒 " + ctx.tr("scene.groceries"), head);
      h("span", "ts-muted", ctx.tr("scene.thisMonth"), head);
      const track = h("div", "ts-track", null, card);
      const fill = h("div", "ts-fill", null, track);
      const nums = h("div", "ts-budget-nums", null, card);
      const spent = h("span", null, "", nums);
      const pct = h("b", null, "0%", nums);
      const badge = h("div", "ts-badge", "", card);
      const other = h("div", "ts-budget small", null, phone);
      const head2 = h("div", "ts-budget-head", null, other);
      h("span", null, "🚌 " + ctx.tr("scene.transport"), head2);
      h("span", "ts-muted", ctx.tr("scene.thisMonth"), head2);
      const track2 = h("div", "ts-track", null, other); const fill2 = h("div", "ts-fill", null, track2); fill2.style.width = "32%";
      return { stage, fill, spent, pct, badge, ctx, limit: 400 };
    },
    timeline(p, ctx) {
      const set = (value) => (inst) => {
        const share = Math.round(value / p.limit * 100);
        p.fill.style.width = Math.min(100, share) + "%";
        p.fill.classList.toggle("warn", share >= 80 && share <= 100);
        p.fill.classList.toggle("over", share > 100);
        p.spent.textContent = ctx.home + " " + ctx.money(value) + " / " + ctx.home + " " + ctx.money(p.limit);
        p.pct.textContent = share + "%";
        p.badge.className = "ts-badge" + (share > 100 ? " show over" : share >= 80 ? " show warn" : "");
        p.badge.textContent = share > 100 ? "⛔ " + ctx.tr("scene.overLimit") : share >= 80 ? "⚠️ " + ctx.tr("scene.nearLimit") : "";
      };
      return [
        [0, set(0)],
        [500, set(80)], [800, set(160)],
        [1900, set(240)], [2200, set(320)],
        [3300, set(420)],
        [4800, (i) => {}]
      ];
    }
  };

  root.TourScenes = { play, stop, has: (key) => !!SCENES[key] };
})(typeof window !== "undefined" ? window : this);
