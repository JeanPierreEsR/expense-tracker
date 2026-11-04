// Practice safety rules (owner asked for these after the persona review, 2026-11-04): a practice never deletes something the person made
// himself, never silently throws away an unfinished draft, and its cleanup waits for the practice's own saves that are still travelling.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "../../docs");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const stm = fs.readFileSync(path.join(DOCS, "statements.js"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));

function fn(src, name) {   // the source of one top-level function
  const start = src.search(new RegExp("(async )?function " + name + "\\("));
  assert.ok(start >= 0, name + " exists");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}

test("Accounts and Investments practices only remove a same-named leftover THIS phone made; a real one makes them refuse to start", () => {
  for (const [starter, loader, key] of [["startAccountsPractice_", "practiceALoad_", "spot.a.exists"], ["startInvestmentsPractice_", "practiceILoad_", "spot.i.exists"]]) {
    const body = fn(app, starter);
    const guard = body.indexOf("if (!" + loader + "())");
    const removal = body.search(/practice[AI]Remove_\(true\)/);
    assert.ok(guard > 0 && guard < removal, starter + ": the note this phone kept is checked BEFORE any removal");
    assert.ok(body.includes(`alert(tr("${key}"))`), starter + ": refuses with its own message");
    assert.ok(STRINGS[key] && STRINGS[key].en && STRINGS[key].es, key + " exists in both languages");
  }
});

test("the Programmed items practice asks before it overwrites an unfinished entry draft", () => {
  const body = fn(app, "startProgrammedPractice_");
  assert.match(body, /tipPrepareForm_\(tr\("spot\.r\.name"\)\)/);
  assert.ok(body.indexOf("tipPrepareForm_") < body.indexOf("practiceR_ = {"), "asked before the practice state is created");
  const prep = fn(app, "tipPrepareForm_");
  assert.match(prep, /ownName \|\| tr\("spot\.p\.name"\)/, "the practice's own leftover draft is still cleared silently");
});

test("tipWaitIdle_ waits for saves on their way and is not cut short by an unrelated FAILED save", async () => {
  const src = fn(app, "tipWaitIdle_");
  let edits = [{ status: "failed" }], money = [{ status: "sending" }];
  const run = new Function("getQueuedEdits_", "getMoneyQueue_", src + "; return tipWaitIdle_;")(() => edits, () => money);
  setTimeout(() => { money = []; }, 450);
  const t0 = Date.now();
  assert.equal(await run(5000), true);
  assert.ok(Date.now() - t0 >= 400, "kept waiting while a save was still on its way, in spite of the failed one");
  edits = [{ status: "failed" }];
  assert.equal(await run(1000), true, "only a failed save left: nothing more to wait for");
  money = [{ status: "sending" }];
  assert.equal(await run(700), false, "a save that never lands ends the wait at the cap");
});

test("the Bank practice only keeps its 'I made the account' mark when an account is really there after a failed create", () => {
  const body = stm.slice(stm.indexOf("async function practiceBMake_"), stm.indexOf("function offerBankTip_"));
  assert.match(body, /if \(!there\) \{ practiceI_\.accountMade = false; practiceISave_\(\); \}/);
});
