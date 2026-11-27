// The company test copy's engine (owner, 2026-11-27; plan "Empresa de prueba en el teléfono"): the REAL backend (backend/*.gs) running on
// the phone, on the same fake Google layer the test server uses (tests/harness/fake-google.js), so the owner can try a company copy
// without a test server, an IP address or a promote. Nothing here talks to Google: every "Google" call stays in memory.
// No backend logic is reimplemented: this file only supplies what fake-google.js needs from Node (Buffer, crypto, process) and loads
// the .gs files into one shared scope, the way Apps Script does. Works in a Web Worker (self.DemoEngineCore) and in Node (the tests).
// Made-up data only.
(function (root) {
  "use strict";

  // ---- What fake-google.js needs from Node ----------------------------------------------------------------------------------

  const b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToB64_(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += b64chars[(n >> 18) & 63] + b64chars[(n >> 12) & 63] + (i + 1 < bytes.length ? b64chars[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? b64chars[n & 63] : "=");
    }
    return out;
  }
  function b64ToBytes_(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? b64chars.indexOf(s[i + k]) : -1));
      const n = (c[0] << 18) | (c[1] << 12) | ((c[2] < 0 ? 0 : c[2]) << 6) | (c[3] < 0 ? 0 : c[3]);
      out.push((n >> 16) & 255);
      if (c[2] >= 0) out.push((n >> 8) & 255);
      if (c[3] >= 0) out.push(n & 255);
    }
    return out;
  }
  const utf8Encode_ = (s) => Array.from(new TextEncoder().encode(String(s)));
  const utf8Decode_ = (b) => new TextDecoder().decode(new Uint8Array(b));

  class DemoBuffer extends Uint8Array {
    static from(x, enc) {
      if (typeof x === "string") {
        if (enc === "base64" || enc === "base64url") return DemoBuffer.of_(b64ToBytes_(x));
        if (enc === "latin1" || enc === "binary") return DemoBuffer.of_(Array.from(x, (ch) => ch.charCodeAt(0) & 255));
        return DemoBuffer.of_(utf8Encode_(x));
      }
      return DemoBuffer.of_(Array.from(x || [], (b) => b & 255));
    }
    static of_(arr) { const b = new DemoBuffer(arr.length); b.set(arr); return b; }
    static alloc(n) { return new DemoBuffer(n); }
    toString(enc) {
      if (enc === "base64") return bytesToB64_(this);
      if (enc === "base64url") return bytesToB64_(this).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (enc === "latin1" || enc === "binary") return Array.from(this, (b) => String.fromCharCode(b)).join("");
      return utf8Decode_(this);
    }
  }

  // SHA-256 and MD5 (the two digests the backend asks for), synchronous like Utilities.computeDigest.
  function sha256_(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const msg = bytes.slice();
    const bitLen = bytes.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (let i = 7; i >= 0; i--) msg.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Array(64);
    for (let o = 0; o < msg.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (msg[o + 4 * i] << 24) | (msg[o + 4 * i + 1] << 16) | (msg[o + 4 * i + 2] << 8) | msg[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
    }
    const out = [];
    H.forEach((v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
    return out;
  }
  function md5_(bytes) {
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const msg = bytes.slice();
    const bitLen = bytes.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (let i = 0; i < 8; i++) msg.push(i < 4 ? (bitLen >>> (i * 8)) & 255 : 0);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let o = 0; o < msg.length; o += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) M[i] = msg[o + 4 * i] | (msg[o + 4 * i + 1] << 8) | (msg[o + 4 * i + 2] << 16) | (msg[o + 4 * i + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = [];
    [a0, b0, c0, d0].forEach((v) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
    return out;
  }
  function randomUuid_() {
    const c = root.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  const cryptoShim = {
    randomUUID: randomUuid_,
    createHash(alg) {
      const fn = alg === "sha256" ? sha256_ : alg === "md5" ? md5_ : null;
      if (!fn) throw new Error("company test copy: digest " + alg + " is not available");
      let data = [];
      const h = { update(x) { data = data.concat(typeof x === "string" ? utf8Encode_(x) : Array.from(x)); return h; }, digest() { return DemoBuffer.of_(fn(data)); } };
      return h;
    }
  };

  // Runs fake-google.js's source as a CommonJS module with the shims above.
  function loadFakeGoogle_(src) {
    const module = { exports: {} };
    const req = (name) => { if (name === "crypto") return cryptoShim; throw new Error("company test copy: no module " + name); };
    new Function("require", "module", "exports", "Buffer", "process", src)(req, module, module.exports, DemoBuffer, { env: {} });
    return module.exports;
  }

  // ---- The engine --------------------------------------------------------------------------------------------------------------

  const ACCESS_CODE = "company-test-copy";   // a made-up value, only ever used inside this in-memory copy
  // Every Google service the .gs files see, by the name they use.
  const SERVICE_NAMES = ["SpreadsheetApp", "Utilities", "PropertiesService", "CacheService", "LockService", "Session", "ContentService",
    "UrlFetchApp", "ScriptApp", "MailApp", "GmailApp", "Gmail", "DriveApp", "Logger"];

  // sources = { fakeGoogle: <fake-google.js text>, files: [{ name, source }] } (the .gs files, any order); snapshot = what snapshot() gave.
  function create(sources, snapshot) {
    const fake = loadFakeGoogle_(sources.fakeGoogle);
    const svc = fake.buildServices({ verbose: false });
    const gs = sources.files.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => f.source + "\n;\n").join("");
    // One function scope holds every .gs file (as Apps Script's one global scope does); the returned eval reaches into it.
    const enter = new Function(...SERVICE_NAMES, gs + "\nreturn function (__code) { return eval(__code); };")(...SERVICE_NAMES.map((n) => svc[n]));

    if (snapshot) restore_(svc, fake, snapshot);
    else {
      // A brand-new COMPANY copy, built the way the installer builds one (FEATURES set while seeding: the short starter lists), with the
      // company mark (CompanyCopy.gs) — the same as the test server's COMPANY_COPY=1.
      svc.props.set("FEATURES", "gmail,keepawake");
      svc.props.set("COMPANY_COPY", "yes");
      enter("setupSpreadsheet(); seedStarterData();");
      enter("setSetting_('company_copy', 'yes')");
    }
    svc.props.set("ACCESS_CODE", ACCESS_CODE);

    // The web app's doPost, exactly as Google would call it: the request text in, the reply text out.
    const doPost_ = enter("(function (body) { return doPost({ postData: { contents: body } }).getContent(); })");
    const engine = {
      ACCESS_CODE,
      post: (bodyText) => doPost_(String(bodyText)),
      api(action, payload) {
        const res = JSON.parse(doPost_(JSON.stringify({ accessCode: ACCESS_CODE, action, payload: payload || {} })));
        if (!res.ok) throw new Error(res.error);
        return res.data;
      },
      run: (code) => enter(code),
      snapshot: () => snapshot_(svc),
      rows: (name) => enter("getAllRows(" + JSON.stringify(name) + ")")
    };
    return engine;
  }

  // What is kept between two openings: every tab (rows, text columns, header), the script's properties and the Sheet's time zone.
  // Rows keep their Date objects (IndexedDB stores them as they are; JSON is not used).
  function snapshot_(svc) {
    const ss = svc.SpreadsheetApp.getActiveSpreadsheet();
    return {
      v: 1,
      tz: ss.getSpreadsheetTimeZone(),
      sheets: ss.getSheets().map((s) => ({ name: s.name, rows: s.rows.map((r) => r.slice()), textCols: [...s.textCols], lastCol: s.lastCol, frozen: s.frozen })),
      props: [...svc.props.entries()]
    };
  }
  function restore_(svc, fake, snap) {
    const ss = svc.ss;
    snap.sheets.forEach((s) => {
      const sh = ss.insertSheet(s.name);
      sh.rows = s.rows.map((r) => r.slice());
      sh.textCols = new Set(s.textCols);
      sh.lastCol = s.lastCol;
      sh.frozen = s.frozen;
    });
    snap.props.forEach(([k, v]) => svc.props.set(k, v));
    if (snap.tz && fake.setSheetTimeZone) fake.setSheetTimeZone(snap.tz);
  }

  const api = { create, ACCESS_CODE, DemoBuffer, sha256_, md5_ };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DemoEngineCore = api;
})(typeof self !== "undefined" ? self : globalThis);
