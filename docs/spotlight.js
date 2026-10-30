// First-use tips: the "spotlight" walkthrough (owner's design, 2026-10-30; spec in CLAUDE.md § First-use tips).
//
// A tip is a short list of steps. Each step dims the screen, leaves a bright cut-out around ONE real button or field and
// puts a one-sentence bubble next to it, with Back / Next / Skip. The dimmed area swallows taps, so a walkthrough can never
// save or change anything by accident; the person moves on with Next only.
//
//   seen(storage, key) / markSeen(storage, key) / resetSeen(storage)     which tips this phone has already shown (localStorage "tipsSeen")
//   placeBubble(rect, view, bubble)  -> { side, top, left, arrowLeft }    where the bubble goes around the cut-out
//   run(steps, ctx) -> Promise<"done" | "skipped">                         the walkthrough itself (needs a browser)
//
// A step: { target: "#css-selector" | () => Element, text: () => string, before: async () => (false to skip this step),
//            available: () => boolean (optional, no side effects: lets "2 of 4" count only the steps that will really show) }.
// A step whose target is missing or not on screen is skipped (a feature that is switched off, a list that is empty).
//
// Used by docs/app.js; also loaded by Node for tests/backend/spotlight.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Spotlight = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var SEEN_KEY = "tipsSeen";
  var Z = 100000;   // above every sheet (their layers count up from 250 one by one) and the welcome screens (300)
  var PAD = 6;      // breathing room between the target and the edge of the cut-out
  var GAP = 12;     // between the cut-out and the bubble
  var EDGE = 12;    // never closer than this to the screen's edge

  function readSeen(storage) {
    try {
      var list = JSON.parse(storage.getItem(SEEN_KEY) || "[]");
      return Array.isArray(list) ? list.filter(function (k) { return typeof k === "string"; }) : [];
    } catch (e) { return []; }
  }
  function seen(storage, key) { return readSeen(storage).indexOf(key) !== -1; }
  function markSeen(storage, key) {
    var list = readSeen(storage);
    if (list.indexOf(key) === -1) list.push(key);
    try { storage.setItem(SEEN_KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable: the tip may show again, nothing worse */ }
  }
  function resetSeen(storage) { try { storage.removeItem(SEEN_KEY); } catch (e) { /* ignore */ } }

  // rect = the target's box in screen coordinates; view = { w, h }; bubble = { w, h } (measured after its text is in).
  // Below the target when it fits, else above, else (a target as tall as the screen) over its lower part. No target: centred.
  function placeBubble(rect, view, bubble) {
    var left = Math.round((view.w - bubble.w) / 2);
    if (!rect) return { side: "center", top: Math.round((view.h - bubble.h) / 2), left: left, arrowLeft: null };
    var hole = { top: rect.top - PAD, bottom: rect.bottom + PAD, left: rect.left - PAD, right: rect.right + PAD };
    var cx = (hole.left + hole.right) / 2;
    left = Math.round(Math.min(Math.max(cx - bubble.w / 2, EDGE), Math.max(EDGE, view.w - bubble.w - EDGE)));
    var arrowLeft = Math.round(Math.min(Math.max(cx - left, 18), bubble.w - 18));
    if (hole.bottom + GAP + bubble.h <= view.h - EDGE) return { side: "below", top: Math.round(hole.bottom + GAP), left: left, arrowLeft: arrowLeft };
    if (hole.top - GAP - bubble.h >= EDGE) return { side: "above", top: Math.round(hole.top - GAP - bubble.h), left: left, arrowLeft: arrowLeft };
    return { side: "inside", top: Math.round(Math.max(EDGE, view.h - bubble.h - EDGE)), left: left, arrowLeft: null };
  }

  function onScreen(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  var active = null;   // only one walkthrough at a time

  // ctx: { tr(key), onFinish(how) }; labels come from ctx.labels = { next, back, skip, done, step(n, total) }.
  function run(steps, ctx) {
    if (active) return Promise.resolve("skipped");
    var doc = document;
    var root = doc.createElement("div");
    root.className = "spot-root";
    root.style.zIndex = String(Z);
    root.innerHTML =
      '<div class="spot-block"></div>' +
      '<div class="spot-hole"></div>' +
      '<div class="spot-bubble" role="dialog" aria-live="polite">' +
        '<div class="spot-arrow"></div>' +
        '<p class="spot-text"></p>' +
        '<div class="spot-foot">' +
          '<span class="spot-count"></span>' +
          '<span class="spot-buttons">' +
            '<button type="button" class="spot-skip"></button>' +
            '<button type="button" class="spot-back"></button>' +
            '<button type="button" class="spot-next"></button>' +
          '</span>' +
        '</div>' +
      '</div>';
    var $ = function (sel) { return root.querySelector(sel); };
    var hole = $(".spot-hole"), bubble = $(".spot-bubble"), arrow = $(".spot-arrow");
    var L = ctx.labels;
    $(".spot-skip").textContent = L.skip;
    $(".spot-back").textContent = L.back;

    var index = -1, el = null, closed = false, busy = false, resolve;
    var done = new Promise(function (r) { resolve = r; });

    function targetOf(step) {
      var t = typeof step.target === "function" ? step.target() : step.target ? doc.querySelector(step.target) : null;
      return t;
    }
    // Brings the step's target to the middle of the screen and waits for the page to settle before measuring.
    function settle(target) {
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "nearest" });
      return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    }
    function layout() {
      if (closed || index < 0) return;
      var rect = null;
      if (el && onScreen(el)) {
        var b = el.getBoundingClientRect();
        rect = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      }
      var vv = window.visualViewport;
      var view = { w: vv ? vv.width : window.innerWidth, h: vv ? vv.height : window.innerHeight };
      if (rect) {
        hole.hidden = false;
        hole.style.top = (rect.top - PAD) + "px";
        hole.style.left = (rect.left - PAD) + "px";
        hole.style.width = (rect.right - rect.left + 2 * PAD) + "px";
        hole.style.height = (rect.bottom - rect.top + 2 * PAD) + "px";
        root.classList.remove("spot-plain");
      } else {
        hole.hidden = true;
        root.classList.add("spot-plain");   // no cut-out: the block itself dims the whole screen
      }
      var p = placeBubble(rect, view, { w: bubble.offsetWidth, h: bubble.offsetHeight });
      bubble.style.top = p.top + "px";
      bubble.style.left = p.left + "px";
      bubble.dataset.side = p.side;
      arrow.hidden = p.arrowLeft == null;
      if (p.arrowLeft != null) arrow.style.left = p.arrowLeft + "px";
    }
    function finish(how) {
      if (closed) return;
      closed = true;
      active = null;
      window.removeEventListener("resize", layout);
      window.removeEventListener("orientationchange", layout);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", layout);
      doc.removeEventListener("keydown", onKey, true);
      root.remove();
      Promise.resolve(ctx.onFinish ? ctx.onFinish(how) : null).catch(function () { /* cleanup must never block the close */ }).then(function () { resolve(how); });
    }
    // Finds the next step that can be shown, walking in `dir` (+1 / -1) from `from`. A step that cannot be shown is passed over.
    async function show(from, dir) {
      if (busy) return;
      busy = true;
      try { await showStep(from, dir); } finally { busy = false; }
    }
    async function showStep(from, dir) {
      var i = from;
      while (i >= 0 && i < steps.length) {
        var step = steps[i], ok = true;
        try { if (step.before) ok = (await step.before()) !== false; } catch (e) { ok = false; }
        if (closed) return;
        var target = ok ? targetOf(step) : null;
        if (ok && !step.centered) {
          if (!onScreen(target)) { await settle(null); target = targetOf(step); }   // the screen may still be drawing itself
          ok = onScreen(target);
        }
        if (ok) {
          if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();   // no keyboard popping up behind the tip
          await settle(target);
          if (closed) return;
          index = i; el = target;
          $(".spot-text").textContent = step.text();
          var pos = shownPosition(i);
          $(".spot-count").textContent = L.step(pos.n, pos.total);
          var last = !hasLater(i);
          $(".spot-back").hidden = !hasEarlier(i);
          $(".spot-skip").hidden = last;
          $(".spot-next").textContent = last ? L.done : L.next;
          layout();
          $(".spot-next").focus({ preventScroll: true });
          return;
        }
        i += dir;
      }
      finish("done");
    }
    // "Step 2 of 5" counts the steps the person can actually see; the ones skipped for lack of a target are not counted
    // as far as that can be known in advance (a step with no `before` and a present target).
    function visible(i) { var s = steps[i]; if (s.available) return !!s.available(); if (s.before || s.centered) return true; return onScreen(targetOf(s)); }
    function shownPosition(i) {
      var n = 0, total = 0;
      for (var k = 0; k < steps.length; k++) { if (visible(k) || k === i) { total++; if (k <= i) n++; } }
      return { n: n, total: total };
    }
    function hasLater(i) { for (var k = i + 1; k < steps.length; k++) if (visible(k)) return true; return false; }
    function hasEarlier(i) { for (var k = i - 1; k >= 0; k--) if (visible(k)) return true; return false; }

    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); finish("skipped"); }
    }
    $(".spot-next").addEventListener("click", function () {
      if (!hasLater(index)) finish("done"); else show(index + 1, 1);
    });
    $(".spot-back").addEventListener("click", function () { show(index - 1, -1); });
    $(".spot-skip").addEventListener("click", function () { finish("skipped"); });
    // Nothing behind the dim can be tapped or scrolled.
    ["click", "touchstart", "pointerdown", "mousedown"].forEach(function (t) {
      $(".spot-block").addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    });
    $(".spot-block").addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });

    active = { finish: finish };
    doc.body.appendChild(root);
    window.addEventListener("resize", layout);
    window.addEventListener("orientationchange", layout);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", layout);
    doc.addEventListener("keydown", onKey, true);
    show(0, 1);
    return done;
  }

  function isRunning() { return !!active; }

  return { seen: seen, markSeen: markSeen, resetSeen: resetSeen, placeBubble: placeBubble, run: run, isRunning: isRunning, SEEN_KEY: SEEN_KEY };
});
