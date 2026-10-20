// Investment platforms in the welcome questions (step 3, optional): a new person's copy starts with none, the owner's copy
// keeps its four, and the step saves exactly what the person chose. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const friendCopy = () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.sheet("Payment Methods").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; RATES_MEMO_ = null; bumpStructureVersion_();");
  return rt;
};
const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const platforms = (rt) => Array.from(rt.rows("Payment Methods")).filter((p) => p.type === "investment").map((p) => p.nickname);

test("a new person's copy has no platforms, even after the app loads (and after deleting nothing)", () => {
  const rt = friendCopy();
  post(rt, "getMeta");
  post(rt, "getMeta");
  assert.deepEqual(platforms(rt), []);
  assert.ok(rt.rows("Categories").some((c) => c.key === "investment_returns"), "the Investment returns income category is still there");
});

test("the owner's copy (no FEATURES) still gets the four starter platforms when it has none", () => {
  const { rt } = freshApp({ small: true });
  rt.sheet("Payment Methods").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; RATES_MEMO_ = null; bumpStructureVersion_();");
  post(rt, "getMeta");
  assert.deepEqual(platforms(rt).sort(), ["Binance", "Hapi", "Inteligo", "Prestamype"]);
});

test("saving platforms creates exactly those, trims names, ignores blanks and reuses an existing name", () => {
  const rt = friendCopy();
  const r = post(rt, "saveOnboardingPlatforms", { batch: "b1", names: ["Hapi", "  Mi broker ", "", "hapi"] }).data;
  assert.equal(r.already, false);
  assert.deepEqual(platforms(rt).sort(), ["Hapi", "Mi broker"]);
  post(rt, "getMeta");
  assert.deepEqual(platforms(rt).sort(), ["Hapi", "Mi broker"], "loading the app adds nothing");
});

test("sending the same batch twice changes nothing", () => {
  const rt = friendCopy();
  post(rt, "saveOnboardingPlatforms", { batch: "b2", names: ["Binance"] });
  const again = post(rt, "saveOnboardingPlatforms", { batch: "b2", names: ["Binance", "Otra"] }).data;
  assert.equal(again.already, true);
  assert.deepEqual(platforms(rt), ["Binance"]);
});

test("choosing none is fine, and too many at once is refused", () => {
  const rt = friendCopy();
  assert.equal(post(rt, "saveOnboardingPlatforms", { batch: "b3", names: [] }).data.platforms.length, 0);
  const many = Array.from({ length: 21 }, (_, i) => "P" + i);
  assert.ok(post(rt, "saveOnboardingPlatforms", { batch: "b4", names: many }).error);
  assert.deepEqual(platforms(rt), []);
});
