// First-use tips: the "spotlight" practice walkthrough (owner's design, 2026-10-30; spec in CLAUDE.md § First-use tips).
//
// A tip is a list of steps. Each step dims the screen, leaves a bright cut-out around the REAL button or field to use next and
// puts a short bubble beside it. There is no Next or Back: the cut-out lets taps through, everything else is blocked, and the
// walkthrough moves on by itself when the person does what the step asks (taps the button, fills the field, leaves it).
// The only controls in the bubble are a small "Exit" (and, on a last step, one button).
//
//   seen(storage, key) / markSeen(storage, key) / resetSeen(storage)     which tips this phone has already shown (localStorage "tipsSeen")
//   placeBubble(rect, view, bubble)  -> { side, top, left, arrowLeft }    where the bubble goes around the cut-out
//   run(steps, ctx) -> Promise<"done" | "skipped">                         the walkthrough itself (needs a browser)
//
// A step: {
//   target:  "#css" | () => Element | Element[] | null   what to light up (several elements = one box round all of them)
//   text:    () => string                                  re-read at every check, so it can change while the step waits
//   before:  async () => (false to leave this step out)    runs first, e.g. to go to the right screen
//   tap:     "#css" | () => Element                        done when that element (or anything inside it) is tapped
//   until:   () => boolean | Promise<boolean>              done when true (checked after every tap / input / change, and every 300 ms)
//   visit:   "#css"                                        done when the person has been in that field and left it again
//   blurTap: true                                          a typing step: while the person is typing in the box the dim and the cut-out go away (a phone's
//                                                          keyboard moves the page in ways a web page cannot measure) and only a small tip stays at the top;
//                                                          a tap anywhere closes the keyboard, which is how the step ends
//   after:   () => void                                    runs when the step is done
//   wait:    ms                                            how long to wait for the target to appear (default 5000; then the step is left out)
//   poke:    () => void                                    called every 2 s while waiting for the target (e.g. refresh a list)
//   available: () => boolean                               cheap, no side effects: lets "3 of 12" count only steps that will show
//   button:  () => string                                  shows one button with this label; pressing it ends the step (an info step)
//   look:    true                                          view-only: taps inside the cut-out are blocked too (an overview of a whole screen)
//   key:     "name"                                        a name other steps can refer to
//   ok:      () => boolean                                 "what this step collected still holds" (e.g. the amount is valid)
//   holdsUntil: "key"                                      ok() is watched until that later step is reached; if it fails, the walkthrough
//                                                          goes BACK to this step (text(true) is asked, so it can say what to fix)
// }
// A step needs at least one of tap / until / visit / button. A `visit` step also needs ok() (when given) to be true.
//
// ctx: { labels: { exit, waiting, cleaning, stuck, note, step(n, total) }, onFinish(how) }  (onFinish may be async: the bubble says
// "cleaning" and the screen stays blocked until it is done).
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
  var STUCK_MS = 25000;   // after this long on one step a small "skip this step" appears (a way out, never the normal way on)

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
  function isTyping(step, doc) {
    var el = doc.activeElement;
    return !!(step && step.blurTap && el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|number|search|tel|email|url|password|)$/i.test(el.type || ""))));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function frames(n) {
    return new Promise(function (r) { (function tick(k) { if (k <= 0) r(); else requestAnimationFrame(function () { tick(k - 1); }); })(n); });
  }

  var active = null;   // only one walkthrough at a time

  function run(steps, ctx) {
    if (active) return Promise.resolve("skipped");
    var doc = document;
    var L = ctx.labels;
    var root = doc.createElement("div");
    root.className = "spot-root";
    root.style.zIndex = String(Z);
    // Four blockers round the cut-out (so taps INSIDE it reach the real button) and a visual ring; with no target one blocker
    // covers the whole screen.
    root.innerHTML =
      '<div class="spot-blk"></div><div class="spot-blk"></div><div class="spot-blk"></div><div class="spot-blk"></div>' +
      '<div class="spot-hole"></div><div class="spot-blk spot-lookcover" hidden></div>' +
      '<div class="spot-bubble" role="dialog" aria-live="polite">' +
        '<div class="spot-arrow"></div>' +
        '<p class="spot-text"></p>' +
        '<p class="spot-note" hidden></p>' +
        '<div class="spot-foot">' +
          '<span class="spot-count"></span>' +
          '<span class="spot-buttons">' +
            '<button type="button" class="spot-stuck" hidden></button>' +
            '<button type="button" class="spot-exit"></button>' +
            '<button type="button" class="spot-go" hidden></button>' +
          '</span>' +
        '</div>' +
      '</div>';
    var $ = function (sel) { return root.querySelector(sel); };
    var blockers = Array.prototype.slice.call(root.querySelectorAll(".spot-blk")).slice(0, 4);
    var hole = $(".spot-hole"), bubble = $(".spot-bubble"), arrow = $(".spot-arrow");
    $(".spot-exit").textContent = L.exit;
    if (L.note) { $(".spot-note").textContent = L.note; $(".spot-note").hidden = false; }
    var lookcover = $(".spot-lookcover");
    $(".spot-stuck").textContent = L.stuck;

    var closed = false, resolve, stepToken = 0, cur = null;
    var done = new Promise(function (r) { resolve = r; });

    function targetsOf(step) {
      var t = typeof step.target === "function" ? step.target() : step.target ? doc.querySelector(step.target) : null;
      var list = !t ? [] : (Array.isArray(t) ? t : [t]);
      return list.filter(onScreen);
    }
    function unionRect(els) {
      var r = null;
      els.forEach(function (e) {
        var b = e.getBoundingClientRect();
        r = r ? { top: Math.min(r.top, b.top), bottom: Math.max(r.bottom, b.bottom), left: Math.min(r.left, b.left), right: Math.max(r.right, b.right) }
              : { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      });
      return r;
    }
    function setBox(el, l, t, w, h) {
      el.style.left = l + "px"; el.style.top = t + "px"; el.style.width = Math.max(0, w) + "px"; el.style.height = Math.max(0, h) + "px";
    }

    function layout() {
      if (closed || !cur) return;
      var vv = window.visualViewport;
      var vw = window.innerWidth, vh = window.innerHeight;
      // Typing with the keyboard open: no dim, no cut-out; one transparent blocker (a tap on it closes the keyboard) and a small tip at the top.
      var typing = isTyping(cur.step, doc);
      root.classList.toggle("spot-typing", typing);
      if (typing) {
        hole.hidden = true;
        lookcover.hidden = true;
        root.classList.remove("spot-plain");
        setBox(blockers[0], 0, 0, vw, vh);
        [1, 2, 3].forEach(function (i) { setBox(blockers[i], 0, 0, 0, 0); });
        var oy0 = vv ? vv.offsetTop : 0, ox0 = vv ? vv.offsetLeft : 0;
        var view0 = { w: vv ? vv.width : vw, h: vv ? vv.height : vh };
        var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
        // Top of the visible part of the screen; at the bottom of it (just above the keyboard) when the box being typed in is up there.
        var atTop = true;
        try { var fr = doc.activeElement.getBoundingClientRect(); if (fr.top - oy0 < bh + 24) atTop = false; } catch (e) { /* keep the top */ }
        bubble.style.top = (atTop ? oy0 + EDGE : oy0 + view0.h - bh - EDGE) + "px";
        bubble.style.left = (ox0 + Math.max(EDGE, Math.round((view0.w - bw) / 2))) + "px";
        bubble.dataset.side = "typing";
        arrow.hidden = true;
        return;
      }
      var rect = cur.targets.length ? unionRect(cur.targets.filter(onScreen)) : null;
      if (rect) {
        var hl = rect.left - PAD, ht = rect.top - PAD, hw = rect.right - rect.left + 2 * PAD, hh = rect.bottom - rect.top + 2 * PAD;
        hole.hidden = false;
        setBox(hole, hl, ht, hw, hh);
        lookcover.hidden = !(cur.step && cur.step.look);
        if (!lookcover.hidden) setBox(lookcover, hl, ht, hw, hh);
        // top / bottom / left / right strips round the hole cover the rest of the screen.
        setBox(blockers[0], 0, 0, vw, ht);
        setBox(blockers[1], 0, ht + hh, vw, vh - (ht + hh));
        setBox(blockers[2], 0, Math.max(0, ht), hl, hh);
        setBox(blockers[3], hl + hw, Math.max(0, ht), vw - (hl + hw), hh);
        root.classList.remove("spot-plain");
      } else {
        hole.hidden = true;
        lookcover.hidden = true;
        setBox(blockers[0], 0, 0, vw, vh);
        [1, 2, 3].forEach(function (i) { setBox(blockers[i], 0, 0, 0, 0); });
        root.classList.add("spot-plain");   // no cut-out: the blocker itself dims the whole screen
      }
      // The visible part of the screen (the keyboard takes the lower part on a phone).
      var oy = vv ? vv.offsetTop : 0, ox = vv ? vv.offsetLeft : 0;
      var view = { w: vv ? vv.width : vw, h: vv ? vv.height : vh };
      var shifted = rect ? { top: rect.top - oy, bottom: rect.bottom - oy, left: rect.left - ox, right: rect.right - ox } : null;
      var p = placeBubble(shifted, view, { w: bubble.offsetWidth, h: bubble.offsetHeight });
      bubble.style.top = (p.top + oy) + "px";
      bubble.style.left = (p.left + ox) + "px";
      bubble.dataset.side = p.side;
      arrow.hidden = p.arrowLeft == null;
      if (p.arrowLeft != null) arrow.style.left = p.arrowLeft + "px";
    }
    var layoutQueued = false;
    function layoutSoon() {
      if (layoutQueued || closed) return;
      layoutQueued = true;
      requestAnimationFrame(function () {
        layoutQueued = false;
        if (cur && cur.step) cur.targets = targetsOf(cur.step);
        layout();
      });
    }

    function finish(how) {
      if (closed) return Promise.resolve();
      closed = true;
      stepToken++;
      if (cur && cur.stop) cur.stop();
      active = null;
      window.removeEventListener("resize", layoutSoon);
      window.removeEventListener("orientationchange", layoutSoon);
      doc.removeEventListener("scroll", layoutSoon, true);
      doc.removeEventListener("keydown", onKey, true);
      if (window.visualViewport) { window.visualViewport.removeEventListener("resize", layoutSoon); window.visualViewport.removeEventListener("scroll", layoutSoon); }
      // Cleanup (removing the practice data) can take a moment: the bubble says so and the screen stays blocked meanwhile.
      cur = null;
      hole.hidden = true;
      lookcover.hidden = true;
      setBox(blockers[0], 0, 0, window.innerWidth, window.innerHeight);
      [1, 2, 3].forEach(function (i) { setBox(blockers[i], 0, 0, 0, 0); });
      root.classList.add("spot-plain");
      $(".spot-text").textContent = L.cleaning;
      $(".spot-note").hidden = true;
      $(".spot-foot").hidden = true;
      arrow.hidden = true;
      bubble.dataset.side = "center";
      bubble.style.top = Math.max(EDGE, Math.round((window.innerHeight - bubble.offsetHeight) / 2)) + "px";
      bubble.style.left = Math.max(EDGE, Math.round((window.innerWidth - bubble.offsetWidth) / 2)) + "px";
      var work = Promise.resolve(ctx.onFinish ? ctx.onFinish(how) : null).catch(function () { /* cleanup must never block the close */ });
      return work.then(function () { root.remove(); resolve(how); });
    }

    // The screen while something the person cannot see is still happening (a save on its way to the server): dimmed, one line, no highlight.
    function showWaiting() {
      cur = { step: null, targets: [] };
      $(".spot-text").textContent = L.waiting;
      $(".spot-count").textContent = "";
      $(".spot-go").hidden = true;
      $(".spot-stuck").hidden = true;
      layout();
    }

    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); finish("skipped"); } }

    function shown(s) { return !s.available || s.available(); }
    function stepsShownCount() { return steps.filter(shown).length; }
    function stepNumber(i) { return Math.max(1, steps.slice(0, i + 1).filter(shown).length); }

    // Shows step i and settles when the person has completed it: "done", "skip" (left out or skipped) or "stale" (closed).
    async function showStep(i, fixing) {
      var step = steps[i], token = ++stepToken, ok = true;
      root.dataset.step = String(i) + (step.key ? ":" + step.key : "");   // which step is on (shown in tests and bug reports)
      // A step that has to prepare something slowly (waiting for a save) must not leave the PREVIOUS step's highlight on screen meanwhile.
      var waitTimer = step.before ? setTimeout(function () { if (!closed && token === stepToken) showWaiting(); }, 250) : null;
      try { if (step.before) ok = (await step.before()) !== false; } catch (e) { ok = false; }
      if (waitTimer) clearTimeout(waitTimer);
      if (closed || token !== stepToken) return "stale";
      if (!ok) return "skip";
      // (a typing step keeps the box the app has just focused, so the keyboard does not close and open again)
      if (doc.activeElement && doc.activeElement.blur && !step.keepFocus && !step.blurTap) doc.activeElement.blur();

      // Wait for the thing to light up to exist (a sheet that is still opening, a list that is still loading).
      var waited = 0, limit = step.wait || 5000, lastPoke = -2000, targets = [];
      while (step.target) {
        targets = targetsOf(step);
        if (targets.length) break;
        if (closed || token !== stepToken) return "stale";
        if (waited >= limit) return "skip";
        if (step.poke && waited - lastPoke >= 2000) { lastPoke = waited; try { step.poke(); } catch (e) { /* ignore */ } }
        if (waited >= 600) showWaiting();   // a long wait (a save still reaching the server): say so, centred
        await sleep(100); waited += 100;
      }
      if (closed || token !== stepToken) return "stale";
      if (targets.length && targets[0].scrollIntoView && !isTyping(step, doc)) targets[0].scrollIntoView({ block: "center", inline: "nearest" });
      await frames(2);
      if (closed || token !== stepToken) return "stale";
      targets = step.target ? targetsOf(step) : [];

      cur = { step: step, targets: targets, stop: null };
      $(".spot-text").textContent = step.text(!!fixing);
      $(".spot-count").textContent = L.step(stepNumber(i), stepsShownCount());
      $(".spot-stuck").hidden = true;
      var go = $(".spot-go");
      go.hidden = !step.button;
      if (step.button) go.textContent = step.button();
      layout();

      // Keeps the cut-out on the field while the page moves under it (a phone's keyboard opening scrolls the form).
      var lastBox = "";
      return new Promise(function (finishStep) {
        var finished = false, checking = false, visited = false, timers = [], listeners = [];
        function on(target, type, fn, capture) { target.addEventListener(type, fn, capture); listeners.push([target, type, fn, capture]); }
        function end(result) {
          if (finished) return;
          finished = true;
          timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
          listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
          if (cur) cur.stop = null;
          if (result === "done" && step.after) { try { step.after(); } catch (e) { /* ignore */ } }
          finishStep(result);
        }
        cur.stop = function () { end("stale"); };

        // Re-reads the text (it can depend on the state of the form) and checks whether the step is done.
        async function check() {
          if (finished || checking || closed || token !== stepToken) return;
          checking = true;
          try {
            var t = step.text(!!fixing);
            if ($(".spot-text").textContent !== t) { $(".spot-text").textContent = t; layoutSoon(); }
            // Done first: a step whose own condition is met is finished even if the form it came from has just been cleared (Save does that).
            if (step.until && (await step.until())) { end("done"); return; }
            if (step.visit) {
              var el = doc.querySelector(step.visit);
              if (el && visited && doc.activeElement !== el && (!step.ok || step.ok())) { end("done"); return; }
            }
            // Not done: something an earlier step collected no longer holds (an error on Save): go back to that step.
            for (var k = 0; k < i; k++) {
              var prev = steps[k];
              if (prev.ok && prev.holdsUntil && keyIndex(prev.holdsUntil) >= i && !prev.ok()) { end("rewind:" + k); return; }
            }
          } catch (e) { /* a check that throws just is not done yet */ }
          finally { checking = false; }
        }
        var soon = function () { setTimeout(check, 0); setTimeout(check, 250); };
        ["input", "change", "focusout", "pointerup"].forEach(function (t) { on(doc, t, soon, true); });
        if (step.visit) {
          // In a field and out again; a drop-down that was changed counts too (a phone's picker does not always report leaving it).
          on(doc, "focusin", function (e) { var el = doc.querySelector(step.visit); if (el && (e.target === el || el.contains(e.target))) visited = true; }, true);
          on(doc, "change", function (e) { var el = doc.querySelector(step.visit); if (el && (e.target === el || el.contains(e.target))) { visited = true; setTimeout(function () { if (!finished) end("done"); }, 150); } }, true);
        }
        if (step.tap) {
          on(doc, "click", function (e) {
            var el = typeof step.tap === "function" ? step.tap() : doc.querySelector(step.tap);
            if (el && el.contains(e.target)) setTimeout(function () { end("done"); }, 0);   // after the app's own handler has run
          }, true);
        }
        if (step.button) on(go, "click", function () { end("done"); }, false);
        // A tap on the dimmed area does nothing, except on a typing step, where it closes the keyboard (that is how the person says "done").
        on(root, "pointerdown", function (e) {
          if (e.target.closest && e.target.closest(".spot-bubble")) return;
          if (step.blurTap && doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
          e.preventDefault();
        }, true);
        timers.push(setInterval(check, 300));
        timers.push(setInterval(function () {
          if (finished || closed || !cur || !cur.step) return;
          var t = targetsOf(cur.step), r = t.length ? unionRect(t) : null;
          var key = (isTyping(cur.step, doc) ? "T" : "") + (r ? [r.top, r.left, r.bottom, r.right].map(Math.round).join(",") + "|" + bubble.offsetHeight : "none|" + bubble.offsetHeight) + "|" + (window.visualViewport ? Math.round(window.visualViewport.offsetTop + window.visualViewport.height) : "");
          if (key !== lastBox) { lastBox = key; cur.targets = t; layout(); }
        }, 100));
        // The keyboard takes a moment to slide in or out; look again as it settles.
        on(doc, "focusin", function () { setTimeout(layoutSoon, 150); setTimeout(layoutSoon, 450); setTimeout(layoutSoon, 900); }, true);
        on(doc, "focusout", function () { setTimeout(layoutSoon, 150); setTimeout(layoutSoon, 450); setTimeout(layoutSoon, 900); }, true);
        timers.push(setTimeout(function () {
          if (finished || closed) return;
          var b = $(".spot-stuck");
          b.hidden = false;
          b.onclick = function () { end("skip"); };
          layoutSoon();
        }, STUCK_MS));
        setTimeout(check, 0);
      });
    }

    function keyIndex(key) {
      for (var n = 0; n < steps.length; n++) if (steps[n].key === key) return n;
      return -1;
    }
    async function go() {
      var fixing = false, resumeAt = -1, completed = [];
      for (var i = 0; i < steps.length && !closed; ) {
        // After going back to fix something, the steps in between that were already done (and still hold) are not asked again.
        if (resumeAt >= 0 && i < resumeAt && !fixing && completed[i] && (!steps[i].ok || steps[i].ok())) { i++; continue; }
        if (i >= resumeAt) resumeAt = -1;
        var r = await showStep(i, fixing);
        if (closed || r === "stale") return;
        if (typeof r === "string" && r.indexOf("rewind:") === 0) { resumeAt = i; i = Number(r.slice(7)); fixing = true; continue; }
        if (r === "done") completed[i] = true;
        fixing = false;
        i++;
      }
      if (!closed) finish("done");   // the steps ran out (the last one had a button, or was left out)
    }

    $(".spot-exit").addEventListener("click", function () { finish("skipped"); });
    // Nothing behind the dim can be scrolled; inside the cut-out the person can scroll as usual.
    root.addEventListener("touchmove", function (e) { if (e.target.classList && e.target.classList.contains("spot-blk")) e.preventDefault(); }, { passive: false });

    active = { finish: finish };
    doc.body.appendChild(root);
    window.addEventListener("resize", layoutSoon);
    window.addEventListener("orientationchange", layoutSoon);
    doc.addEventListener("scroll", layoutSoon, true);
    if (window.visualViewport) { window.visualViewport.addEventListener("resize", layoutSoon); window.visualViewport.addEventListener("scroll", layoutSoon); }
    doc.addEventListener("keydown", onKey, true);
    go();
    return done;
  }

  function isRunning() { return !!active; }
  // Ends the walkthrough from outside (e.g. the practice's own save failed); the usual cleanup still runs.
  function stop(how) { return active ? active.finish(how || "skipped") : Promise.resolve(); }

  return { seen: seen, markSeen: markSeen, resetSeen: resetSeen, placeBubble: placeBubble, run: run, isRunning: isRunning, stop: stop, SEEN_KEY: SEEN_KEY };
});
