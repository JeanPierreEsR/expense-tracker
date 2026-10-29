// A date must come back exactly as written, however the Sheet's time zone relates to the script's (America/Lima), and
// saving again what the app SHOWS (which is what every edit does) must never move it. Reported 2026-10-28 by a friend
// whose Sheet is not in the script's zone: expenses a day early, a loan going from Oct 28 to Oct 24 after several saves.
// Each save sent back the date it had been shown, so a wrong read moved the stored date one more day every time.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setSheetTimeZone } = require("../harness/fake-google");
const { freshApp } = require("./helpers");

const ZONES = ["America/Lima", "UTC", "Europe/Madrid", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland", "America/Los_Angeles", "America/Sao_Paulo", "Pacific/Kiritimati"];

function setup(zone) {
  setSheetTimeZone(zone);
  const { rt } = freshApp({ entries: 20 });
  // Sheets turns written date strings into real dates (see DATE_FIELD_FORMATS), so the text-format shortcut is switched off.
  for (const n of ["Entries", "Loans", "Settlements"]) rt.svc.ss.getSheetByName(n).textCols.clear();
  return rt;
}

for (const zone of ZONES) {
  test(`an expense keeps its date through several saves of what the app shows (Sheet in ${zone})`, () => {
    try {
      const rt = setup(zone);
      const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
      const e = rt.api("createEntry", { type: "expense", date: "2026-10-26", amount: 10, currency: "PEN", category_id: cat, description: "x" });
      const shown = () => rt.api("listEntries", { limit: 1000 }).find((x) => x.id === e.id).date;
      assert.equal(shown(), "2026-10-26");
      for (let i = 0; i < 4; i++) {
        rt.api("updateEntry", { id: e.id, fields: { date: shown(), amount: 11 + i } });
        assert.equal(shown(), "2026-10-26", `after save ${i + 1}`);
      }
    } finally { setSheetTimeZone(null); }
  });

  test(`a loan keeps its date, and its money entry the same one, through several saves (Sheet in ${zone})`, () => {
    try {
      const rt = setup(zone);
      const acct = rt.rows("Payment Methods")[0].id;
      const f = rt.api("addFriend", { name: "Ana Lo" });
      const l = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-21", payment_method_id: acct, description: "L" });
      const homeDate = () => rt.api("listEntries", { limit: 1000 }).find((x) => x.id === l.transfer_entry_id).date;
      const loansDate = () => rt.api("getFriendLoanDetail", { friendId: f.id }).find((x) => x.id === l.id).date;
      assert.equal(homeDate(), "2026-10-21");
      rt.api("updateEntry", { id: l.transfer_entry_id, fields: { date: "2026-10-28" } });
      for (let i = 0; i < 4; i++) {
        assert.equal(homeDate(), "2026-10-28", `Home after ${i} re-saves`);
        assert.equal(loansDate(), "2026-10-28", `Loans tab after ${i} re-saves`);
        rt.api("updateEntry", { id: l.transfer_entry_id, fields: { date: homeDate(), description: "edit " + i } });
      }
      assert.equal(homeDate(), "2026-10-28");
    } finally { setSheetTimeZone(null); }
  });
}
