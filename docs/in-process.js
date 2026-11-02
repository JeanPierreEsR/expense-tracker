// "Payments in process": reads the TEXT of a screenshot of a bank app's movements list (first layout: Interbank, where a
// card payment the bank has not posted yet is printed with "En proceso" under its amount) and returns the in-process
// payments, so the app can add them up. Pure functions, no screen or OCR code — tested in tests/backend/in-process.test.js
// with made-up lists. Rule-based and cautious: a row counts only when "En proceso" really follows its amount; anything else
// (posted rows, headings) is left out, and the person ticks/unticks the result before using it.
(function (root) {
  "use strict";

  const MONTHS = "ene|feb|mar|abr|may|jun|jul|ago|set|sep|oct|nov|dic";
  // OCR often turns "S/" into "5/" or "$/" and "US$" into "USS"/"U$S".
  const AMOUNT = /([-−–+])?\s*(S\/\.?|5\/|\$\/|US\s?[$S5]|U\$S|\$)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)/gi;
  // "En proceso" with the slips OCR makes ("Fn proceso", "En praceso", "En proceso" with a stray mark).
  const IN_PROCESS = /[eEfF][nN]\s*pr\w{2,5}s[o0]\b/i;
  const DATE = new RegExp("(\\d{1,2})\\s+(" + MONTHS + ")\\b[^|]*\\|?\\s*(\\d{1,2}:\\d{2}\\s*[ap]m)?", "i");

  function currencyOf(marker) {
    return marker && /U/i.test(marker) ? "USD" : "PEN";
  }

  // Every amount with a sign or a currency mark on the line (a bare "12.50" in a name is not a movement).
  function amountsOnLine(line) {
    const out = [];
    let m;
    AMOUNT.lastIndex = 0;
    while ((m = AMOUNT.exec(line))) {
      if (!m[1] && !m[2]) continue;
      const value = Number(m[3].replace(/,/g, ""));
      out.push({ index: m.index, end: m.index + m[0].length, sign: m[1] && m[1] !== "+" ? -1 : m[1] ? 1 : 0, value, currency: currencyOf(m[2]) });
    }
    return out;
  }

  // A row whose sign and currency mark were both lost by OCR ("Tienda Uno   12.29"): name, then an amount at the end of the line.
  // Only kept when "En proceso" follows it, so a posted row or a heading with a number never counts.
  const BARE_AMOUNT_ROW = /^(.*[A-Za-zÁÉÍÓÚáéíóúñÑ].*?)\s{2,}(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\s*$/;

  function cleanName(s) {
    return String(s || "").replace(/[>›»|]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // text -> { items: [{ name, when, amount (negative = money out), currency }], posted: number of rows that were not in process }
  function parseInProcess(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    let current = null;
    let previousText = "";
    lines.forEach((line) => {
      const amounts = amountsOnLine(line);
      const bare = !amounts.length && BARE_AMOUNT_ROW.exec(line);
      if (bare) {
        current = { name: cleanName(bare[1]), when: "", amount: -Number(bare[2].replace(/,/g, "")), currency: "PEN", inProcess: false };
        rows.push(current);
        previousText = "";
        return;
      }
      if (amounts.length) {
        const a = amounts[amounts.length - 1];
        current = { name: cleanName(line.slice(0, a.index)) || cleanName(previousText), when: "", amount: a.sign === 1 ? a.value : -a.value, currency: a.currency, inProcess: false };
        rows.push(current);
        if (IN_PROCESS.test(line.slice(a.end))) current.inProcess = true;
        previousText = "";
        return;
      }
      if (current) {
        if (IN_PROCESS.test(line)) current.inProcess = true;
        const d = DATE.exec(line);
        if (d && !current.when) current.when = d[1] + " " + d[2][0].toUpperCase() + d[2].slice(1).toLowerCase() + (d[3] ? " " + d[3].replace(/\s+/g, "").toLowerCase() : "");
      }
      if (!IN_PROCESS.test(line) && !DATE.test(line)) previousText = line;
    });
    const items = rows.filter((r) => r.inProcess).map((r) => ({ name: r.name, when: r.when, amount: r.amount, currency: r.currency }));
    return { items, posted: rows.length - items.length };
  }

  // The same payment seen in two overlapping screenshots counts once.
  // The key leaves the time out (OCR misreads it often) but keeps the day. Two identical rows inside ONE screenshot are two real
  // payments; across screenshots, a key counts as many times as its busiest screenshot shows it.
  const itemKey = (it) => [it.name.toLowerCase(), it.when.split(" ").slice(0, 2).join(" "), it.amount, it.currency].join("|");
  function mergeItems(lists) {
    const kept = {};
    const out = [];
    lists.forEach((items) => {
      const here = {};
      items.forEach((it) => {
        const key = itemKey(it);
        here[key] = (here[key] || 0) + 1;
        if (here[key] > (kept[key] || 0)) {
          kept[key] = here[key];
          out.push(it);
        }
      });
    });
    return out;
  }

  // Several readings of the SAME screenshot (different image sizes: a phone sometimes reads one size better than another):
  // a payment found by any of them counts once. The name is left out of the key here (OCR spells it differently each time);
  // two real payments with the same amount and day inside one reading still count twice.
  const readKey = (it) => [it.when.split(" ").slice(0, 2).join(" "), it.amount, it.currency].join("|");
  function mergeReads(reads) {
    const kept = {};
    const out = [];
    reads.forEach((items) => {
      const here = {};
      items.forEach((it) => {
        const key = readKey(it);
        here[key] = (here[key] || 0) + 1;
        if (here[key] > (kept[key] || 0)) {
          kept[key] = here[key];
          out.push(it);
        }
      });
    });
    return out;
  }

  // Sum per currency of the ticked items, in cents so 0.1 + 0.2 stays exact: { PEN: -67811, ... } (cents; negative = money out).
  function sumsByCurrency(items) {
    const sums = {};
    items.forEach((it) => { sums[it.currency] = (sums[it.currency] || 0) + Math.round(it.amount * 100); });
    return sums;
  }

  const api = { parseInProcess, mergeItems, mergeReads, sumsByCurrency };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InProcess = api;
})(typeof window !== "undefined" ? window : this);
