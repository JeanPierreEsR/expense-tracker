// Speed sweep (2026-11-21): every LOOKING action (get…/list…) and the everyday saves, against the made-up (~real-size)
// data, with the number of sheet reads, cells read, and which sheet was read more than once in the same request.
// On the real Sheet each read is a trip to Google, so "reads" and repeats are what to cut. Wall ms here means little.
//   node tests/perf-sweep.js            (all)        node tests/perf-sweep.js listEntries getMeta   (only these)
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./backend/helpers");
const { rt, data } = freshApp();
const api = (a, p) => rt.api(a, p || {});
// Warm up: a brand-new copy's first request does its one-time setup (heals, Cash account, investment platforms…), ~30 extra reads
// that never come back. Measure what a person feels every day.
api("getMeta"); api("getStartupBundle");
const src = fs.readFileSync(path.join(__dirname, "../backend/Api.gs"), "utf8");
const looking = [...new Set([...src.matchAll(/case '((?:get|list)[A-Za-z]+)'/g)].map((m) => m[1]))];
const ym = new Date().toISOString().slice(0, 7);
const first = (a, p, f) => { try { const r = api(a, p); return Array.isArray(r) ? r : f(r); } catch (e) { return undefined; } };
const entries = first("listEntries", { limit: 50 }, (r) => r.entries || r) || [];
const anEntry = entries.find((e) => e.id) || {};
const loans = first("listLoanBalances", {}, (r) => r.balances || r.friends || r) || [];
const aFriend = (Array.isArray(loans) && loans[0]) || {};
const trips = first("listTrips", {}, (r) => r.trips || r) || [];
const rec = first("listRecurringExpenses", {}, (r) => r.items || r.recurring || r) || [];
const pms = first("listPaymentMethodBalances", {}, (r) => r.balances || r.accounts || r) || [];
const payloads = {
  listEntries: { limit: 20 }, getEntry: { id: anEntry.id }, getEntrySplits: { id: anEntry.id, entry_id: anEntry.id },
  getEntryBill: { id: anEntry.id, entry_id: anEntry.id }, getEntryTags: { id: anEntry.id, entry_id: anEntry.id },
  getEntryRepaymentLinks: { id: anEntry.id, entry_id: anEntry.id }, getEntriesNear: { id: anEntry.id, date: anEntry.date, amount: anEntry.amount },
  getFriendLoanDetail: { friend_id: aFriend.friend_id },
  getFriendRepaymentHistory: { friend_id: aFriend.friend_id, currency: "PEN" },
  listSettlementsForFriendCurrency: { friend_id: aFriend.friend_id, currency: "PEN" },
  getTripDetail: { id: (trips[0] || {}).id, trip_id: (trips[0] || {}).id },
  getRecurringExpenseSplits: { id: (rec[0] || {}).id }, listEntriesForRecurringMonth: { id: (rec[0] || {}).id, month: ym },
  getPaymentMethodMovements: { id: (pms[0] || {}).id, payment_method_id: (pms[0] || {}).id },
  getPeriodSummary: { period: "month", month: ym }, getExchangeRate: { currency: "USD", month: ym },
  getLatestRateOnOrBefore: { currency: "USD", date: ym + "-01" }
};
const only = process.argv.slice(2);
const list = only.length ? only : ["getStartupBundle", ...looking.filter((a) => a !== "getStartupBundle")];
console.log("action".padEnd(34), "reads".padStart(6), "cells".padStart(8), " ms", "  repeated sheets");
const rows = [];
for (const a of list) {
  rt.resetStats(); rt.stats.bySheet = {};
  const t = process.hrtime.bigint();
  let err = "";
  try { api(a, payloads[a]); } catch (e) { err = String(e.message).slice(0, 60); }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const rep = Object.entries(rt.stats.bySheet).filter(([k, n]) => n > 1 && !k.endsWith("(1 row)")).map(([k, n]) => k + "×" + n).join(", ");
  rows.push([a, rt.stats.reads, rt.stats.cellsRead, ms, rep, err]);
  delete rt.stats.bySheet;
}
rows.sort((x, y) => y[1] - x[1]);
for (const [a, r, c, ms, rep, err] of rows) console.log(a.padEnd(34), String(r).padStart(6), String(c).padStart(8), String(ms.toFixed(0)).padStart(4), " ", rep, err ? " ERR " + err : "");
