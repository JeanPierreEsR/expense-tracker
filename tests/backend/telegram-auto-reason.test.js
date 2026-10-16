// Telegram spells out why a category was guessed ("N of M past entries") only for
// the first 3 times a merchant is guessed; after that the card says just "🤖 auto".
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const cat = data.cats.find((c) => c.type === "expense");
  rt.run("ensureEntriesMerchantColumn_()");
  const pastEntries = (n) => {
    for (let i = 0; i < n; i++) {
      rt.run(`appendRowObject('Entries', { id: Utilities.getUuid(), type: 'expense', date: '2026-01-0${(i % 9) + 1}', amount: 10, currency: 'PEN', category_id: ${JSON.stringify(cat.id)},
        description: 'Zeta Kiosk', payment_method_id: '', paid_by: 'me', status: 'confirmed', source: 'email', external_id: 'past-${i}-' + Math.random(), import_batch_id: '', created_at: 'x', merchant: 'zeta kiosk' });`);
    }
  };
  // The card Telegram would send for a NEW pending email entry from that merchant.
  const card = () => rt.run(`(function () {
    var guess = guessCategoryForEmail_({ type: 'expense', amount: 12, currency: 'PEN', merchant: 'Zeta Kiosk' }, '${today()}', buildGuessContext_());
    var entry = { id: 'x', type: 'expense', status: 'pending', date: '${today()}', amount: 12, currency: 'PEN', category_id: guess.categoryId, description: 'Zeta Kiosk', paid_by: 'me', payment_method_id: '' };
    return formatEntryForTelegram_(entry, null, telegramAutoReason_(guess));
  })()`);
  return { rt, pastEntries, card, cat };
}

test("the first three guesses for a merchant show the evidence", () => {
  const { pastEntries, card } = setup();
  pastEntries(2);
  assert.match(card(), /🤖 auto \(2 of 2 past "zeta kiosk" entries\)/);
  pastEntries(1);
  assert.match(card(), /🤖 auto \(3 of 3 past/);
  pastEntries(1);
  assert.match(card(), /🤖 auto \(4 of 4 past/);
});

test("from the fourth guess on, the card says just '🤖 auto'", () => {
  const { pastEntries, card } = setup();
  pastEntries(5);
  const text = card();
  assert.match(text, /— .+ 🤖 auto\n/);
  assert.doesNotMatch(text, /past/);
  pastEntries(10);
  assert.doesNotMatch(card(), /past/);
});

test("the app's own suggestion text is unchanged (the reason is still produced in full)", () => {
  const { rt, pastEntries } = setup();
  pastEntries(8);
  const guess = JSON.parse(rt.run(`JSON.stringify(guessCategoryForEmail_({ type: 'expense', amount: 12, currency: 'PEN', merchant: 'Zeta Kiosk' }, '${today()}', buildGuessContext_()))`));
  assert.match(guess.reason, /8 of 8 past/);
  assert.equal(guess.quiet, true);
});
