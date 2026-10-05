// How much sheet work each main request does against the made-up (~real-size)
// data. Wall-clock here is NOT what you'd feel on the phone (the fake is
// in-memory, real Sheets is far slower) — the read COUNTS are the useful part:
// every read call is a round trip to Google on the real sheet.
//   node tests/perf-report.js
const { freshApp } = require("./backend/helpers");
const { rt, data } = freshApp();
const ym = new Date().toISOString().slice(0, 7);
const cases = [
  ["getStartupBundle (app open)", "getStartupBundle", {}],
  ["getMeta", "getMeta", {}],
  ["listEntries (first page)", "listEntries", { limit: 20 }],
  ["getPeriodSummary (Overview)", "getPeriodSummary", {}],
  ["listPendingEntries", "listPendingEntries", {}],
  ["listLoanBalances (Loans tab)", "listLoanBalances", {}],
  ["listBudgets / progress", "listBudgets", {}]
];
console.log("action".padEnd(34), "wall ms".padStart(8), "reads".padStart(7), "cells read".padStart(12));
for (const [label, action, payload] of cases) {
  rt.resetStats();
  const t = process.hrtime.bigint();
  try { rt.api(action, payload); } catch (e) { console.log(label.padEnd(34), "ERROR", e.message); continue; }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(label.padEnd(34), ms.toFixed(0).padStart(8), String(rt.stats.reads).padStart(7), String(rt.stats.cellsRead).padStart(12));
}
