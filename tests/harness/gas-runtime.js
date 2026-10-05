// Loads the REAL backend (../../backend/*.gs) into one shared script context,
// the way Apps Script does (all files share one global scope), on top of the
// fake Google services. No backend logic is reimplemented here.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildServices, stats, resetStats } = require("./fake-google");

// BACKEND_DIR lets a test run be pointed at an older copy of the backend (to prove a test fails on old code).
const BACKEND = process.env.BACKEND_DIR || path.join(__dirname, "..", "..", "backend");
const ACCESS_CODE = "test-access-code"; // a made-up value, only ever used against the fake

function createRuntime(opts = {}) {
  const state = { fetchHandler: null, verbose: !!opts.verbose };
  const svc = buildServices(state);
  const sandbox = {
    console, Date, JSON, Math, Number, String, Object, Array, Error, RegExp, parseInt, parseFloat, isNaN,
    ...svc
  };
  const ctx = vm.createContext(sandbox);
  fs.readdirSync(BACKEND).filter((f) => f.endsWith(".gs")).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(BACKEND, f), "utf8"), ctx, { filename: f });
  });

  svc.props.set("ACCESS_CODE", ACCESS_CODE);
  vm.runInContext("setupSpreadsheet(); seedStarterData();", ctx);

  const rt = {
    ctx, svc, state, ACCESS_CODE, stats, resetStats,
    sheet: (name) => svc.ss.getSheetByName(name),
    // Call the real doPost exactly as the web app would, return the decoded reply.
    api(action, payload = {}) {
      ctx.__body = JSON.stringify({ accessCode: ACCESS_CODE, action, payload });
      const out = vm.runInContext("doPost({ postData: { contents: __body } }).getContent()", ctx);
      const res = JSON.parse(out);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    rawPost(bodyText) {
      ctx.__body = bodyText;
      return JSON.parse(vm.runInContext("doPost({ postData: { contents: __body } }).getContent()", ctx));
    },
    // Rows of a sheet as plain objects (by header), straight from the fake sheet.
    rows(name) { return vm.runInContext(`getAllRows(${JSON.stringify(name)})`, ctx); },
    run(code) { return vm.runInContext(code, ctx); }
  };
  return rt;
}

module.exports = { createRuntime, ACCESS_CODE };
