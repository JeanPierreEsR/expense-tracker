// A Sheet whose own time zone differs from the script's (America/Lima) must not shift dates a day early.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setSheetTimeZone } = require("../harness/fake-google");
const { freshApp, bcpEmail } = require("./helpers");

for (const zone of ["America/Lima", "UTC"]) {
  test(`an email entry keeps the email's Lima date when the Sheet is set to ${zone}`, () => {
    setSheetTimeZone(zone);
    try {
      const { rt } = freshApp({ entries: 50 });
      // Sheets turns date strings into real Dates even in text-formatted columns (see DATE_FIELD_FORMATS), so mimic that.
      rt.svc.ss.getSheetByName("Entries").textCols.clear();
      bcpEmail(rt, { amount: "12.00", merchant: "Corner Cafe", op: "TZ-1" });
      rt.run("processEmails()");
      const e = rt.rows("Entries").find((r) => r.external_id === "TZ-1");
      assert.ok(e, "entry created");
      const expected = String(e.created_at).slice(0, 10);   // taken from the same e-mail timestamp, in Lima
      assert.equal(e.date, expected);
    } finally {
      setSheetTimeZone(null);
    }
  });
}
