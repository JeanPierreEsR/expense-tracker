/**
 * Bank statement readers. Runs in the browser (the PDF is read on the
 * owner's phone/computer, never uploaded anywhere — free, no OCR service)
 * and in Node (for testing against the real PDFs).
 *
 * Pipeline: PDF -> pdf.js text items -> rows (items on one baseline, with
 * their x positions) -> one reader per statement layout -> a normalized
 * result. Every reader VERIFIES its own reading before returning: running
 * balances must add up row by row, and section subtotals / closing totals
 * must equal the sum of the rows read. A statement that doesn't check out
 * is reported with `ok: false` and the reasons, never half-trusted.
 *
 * Normalized result:
 *   { ok, errors[], kind, bank, account: { last4, label, number },
 *     period: { start, end },
 *     balances: { CUR: { opening, closing } },   // account view: a card's
 *                                                // debt is a NEGATIVE balance
 *     lines: [ { date, description, amount, currency, section, balanceAfter? } ] }
 * `amount` is always the effect on the account's balance: money in is
 * positive, money out (or a card charge) is negative.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StatementParsers = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var MONTHS = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12 };
  var MONTH_WORDS = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
    setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
  };

  function num(s) { return parseFloat(String(s).replace(/,/g, '').replace(/^\+/, '')); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function isAmount(s) { return /^[+-]?[\d,]+\.\d{2}$/.test(s); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  // ---- rows ----

  /**
   * items: [{ str, x, w, y }] for ONE page. Items whose baselines are within
   * a few points are one row (a merchant name is often printed a point or
   * two off its amount). Returns rows top to bottom, each with cells
   * sorted left to right: { y, page, cells: [{ x0, x1, str }], text }.
   */
  function groupRows(items, page) {
    var its = items.filter(function (i) { return String(i.str).trim(); })
      .sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
    var rows = [];
    its.forEach(function (i) {
      var cell = { x0: i.x, x1: i.x + i.w, str: String(i.str).trim() };
      var r = rows[rows.length - 1];
      if (r && Math.abs(r.y - i.y) <= 4.5) r.cells.push(cell);
      else rows.push({ y: i.y, page: page, cells: [cell] });
    });
    rows.forEach(function (r) {
      r.cells.sort(function (a, b) { return a.x0 - b.x0; });
      r.text = r.cells.map(function (c) { return c.str; }).join(' ');
    });
    return rows;
  }

  /** pdfjsLib: the loaded pdf.js module; data: Uint8Array of the PDF. */
  function readPdfRows(pdfjsLib, data) {
    return pdfjsLib.getDocument({ data: data, useSystemFonts: true }).promise.then(function (doc) {
      var out = [];
      var chain = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) {
        (function (pageNo) {
          chain = chain.then(function () {
            return doc.getPage(pageNo).then(function (page) {
              return page.getTextContent().then(function (tc) {
                var items = tc.items.map(function (i) {
                  return { str: i.str, x: i.transform[4], w: i.width, y: i.transform[5] };
                });
                out = out.concat(groupRows(items, pageNo));
              });
            });
          });
        })(p);
      }
      return chain.then(function () { return out; });
    });
  }

  // ---- shared helpers ----

  function fail(kind, errors) {
    return { ok: false, kind: kind, errors: errors, lines: [], balances: {}, account: {}, period: {} };
  }

  // A card statement prints dates as "25-Jul" / "11 AGO" with no year; the
  // period end tells which year (a month later than the end month belongs
  // to the year before).
  function inferYear(month, endYear, endMonth) { return month <= endMonth ? endYear : endYear - 1; }

  function dedupeSum(map, cur, v) { map[cur] = round2((map[cur] || 0) + v); }

  function detectKind(rows) {
    var all = rows.map(function (r) { return r.text; }).join('\n');
    if (/DETALLE DE MOVIMIENTOS/.test(all) && /EMPEZASTE/i.test(all)) return 'savings';
    if (/INTERBANK VISA/i.test(all) && /DETALLE DE PAGO DEL MES/i.test(all)) return 'visa';
    if (/PERIODO FACTURADO DEL/i.test(all)) return 'diners';
    if (/Estado de Cuenta de Ahorros/i.test(all) && /FECHA PROC/i.test(all)) return 'bcp';
    if (/Ahorros disponible/i.test(all) && /Estado de cuenta del/i.test(all)) return 'ahorramas';
    if (/TARJETA DE CR[ÉE]DITO SIP/i.test(all) && /DETALLE DE TU ESTADO DE CUENTA/i.test(all)) return 'sip';
    return null;
  }

  // ---- Interbank savings / sueldo ("Cuenta Simple/Sueldo Soles/Dólares") ----

  function parseSavings(rows) {
    var errors = [];
    // Everything after the first "SALDO CONTABLE AL" is Interbank's generic
    // "how to read your statement" page, which shows another person's sample
    // account — it must never be read.
    var end = rows.findIndex(function (r) { return /^SALDO CONTABLE AL\b/i.test(r.text); });
    if (end === -1) return fail('savings', ['No closing "SALDO CONTABLE AL" line found.']);
    var body = rows.slice(0, end + 1);

    var title = body.map(function (r) { return r.text; }).join('\n');
    var kindM = title.match(/CUENTA\s+(SIMPLE|SUELDO)\s+(SOLES|D[ÓO]LARES)/i) || title.match(/AHORRO\s+(SUELDO|SIMPLE)\s+(SOLES|D[ÓO]LARES)/i);
    var numM = title.match(/\b(\d{3})-(\d{7,})\b/);
    if (!kindM || !numM) return fail('savings', ['Could not identify the account (name / number).']);
    var currency = /SOLES/i.test(kindM[2]) ? 'PEN' : 'USD';
    var number = numM[1] + '-' + numM[2];

    var openM = title.match(/EMPEZASTE[^\n]*?CON\s+(-?[\d,]+\.\d{2})/i);
    if (!openM) return fail('savings', ['Opening balance ("EMPEZASTE … CON") not found.']);
    var opening = num(openM[1]);

    var lines = [];
    var running = opening;
    var totalIn = 0, totalOut = 0;
    body.forEach(function (r) {
      var c = r.cells;
      if (c.length < 4 || !/^\d{2}\/\d{2}\/\d{4}$/.test(c[0].str)) return;
      var bal = c[c.length - 1].str, amt = c[c.length - 2].str;
      if (!isAmount(bal) || !/^[+-]/.test(amt) || !isAmount(amt)) {
        errors.push('Unreadable movement row: ' + r.text);
        return;
      }
      var d = c[0].str.split('/');
      var amount = num(amt), balance = num(bal);
      if (round2(running + amount) !== round2(balance)) {
        errors.push('Running balance breaks at "' + r.text + '" (expected ' + round2(running + amount).toFixed(2) + ').');
      }
      running = balance;
      if (amount > 0) totalIn = round2(totalIn + amount); else totalOut = round2(totalOut + amount);
      lines.push({
        date: iso(d[2], +d[1], +d[0]),
        description: c.slice(1, c.length - 2).map(function (x) { return x.str; }).join(' '),
        amount: amount, currency: currency, section: 'movement', balanceAfter: balance
      });
    });

    var closeRow = body[body.length - 1];
    var cm = closeRow.text.match(/^SALDO CONTABLE AL\s+(\d{2})\/(\d{2})\s+([+-][\d,]+\.\d{2})\s+([+-][\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/i);
    if (!cm) return fail('savings', errors.concat(['Closing line unreadable: ' + closeRow.text]));
    var closing = num(cm[5]);
    if (round2(running) !== round2(closing)) errors.push('Last running balance ' + running.toFixed(2) + ' ≠ closing ' + closing.toFixed(2) + '.');
    if (round2(totalIn) !== round2(num(cm[3]))) errors.push('Ingresos read ' + totalIn.toFixed(2) + ' ≠ statement total ' + num(cm[3]).toFixed(2) + '.');
    if (round2(totalOut) !== round2(num(cm[4]))) errors.push('Gastos read ' + totalOut.toFixed(2) + ' ≠ statement total ' + num(cm[4]).toFixed(2) + '.');

    var year = lines.length ? +lines[lines.length - 1].date.substring(0, 4) : new Date().getFullYear();
    var endDate = iso(year, +cm[2], +cm[1]);
    var pm = title.match(/DEL\s+(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚ]+)\s+AL\s+(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚ]+)/i);
    var startDate = null;
    if (pm && MONTH_WORDS[pm[2].toLowerCase()]) {
      var sm = MONTH_WORDS[pm[2].toLowerCase()];
      startDate = iso(sm > +cm[2] ? year - 1 : year, sm, +pm[1]);
    }
    var label = kindM[0].replace(/\s+/g, ' ');
    var balances = {};
    balances[currency] = { opening: opening, closing: closing };
    return {
      ok: errors.length === 0, errors: errors, kind: 'savings', bank: 'Interbank',
      account: { last4: number.slice(-4), number: number, label: label },
      period: { start: startDate, end: endDate }, balances: balances, lines: lines
    };
  }

  // ---- shared by the two card layouts: two currency columns (S/ and US$) ----

  // The currency of an amount cell from where its right edge sits: left of
  // `split` is S/, right of it is US$.
  function currencyByX(cell, split) { return cell.x1 < split ? 'PEN' : 'USD'; }

  // ---- Interbank Visa Infinite ----

  function parseVisa(rows) {
    var errors = [];
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var l4 = all.match(/INTERBANK VISA[^\n]*?(\d{4})\s*-\s*SOLES/i) || all.match(/\*{2,}\s*(\d{4})/);
    var pm = all.match(/del\s+(\d{2})\/(\d{2})\/(\d{4})\s+al\s+cierre\s+de\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (!l4 || !pm) return fail('visa', ['Could not read the card number / statement period.']);
    var start = iso(pm[3], +pm[2], +pm[1]);
    var endY = +pm[6], endM = +pm[5];
    var end = iso(endY, endM, +pm[4]);

    var section = null;
    var split = 520;
    var lines = [];
    var rowsSum = {};       // per section, per currency
    var prev = {};          // previous statement's balance, per currency
    var subtotals = {};     // per section
    var monthly = null;

    function reset() { rowsSum = {}; }
    reset();

    rows.forEach(function (r) {
      var t = r.text;
      // A row with both column headers tells us where the columns sit on
      // this page.
      var sc = r.cells.find(function (c) { return c.str === 'S/'; });
      var uc = r.cells.find(function (c) { return c.str === 'US$'; });
      if (sc && uc) split = (sc.x1 + uc.x0) / 2;

      if (/^TU ESTADO DE CUENTA ANTERIOR/i.test(t)) { section = 'previous'; reset(); return; }
      if (/^PAGOS REALIZADOS/i.test(t)) { section = 'payments'; return; }
      if (/^TUS CONSUMOS/i.test(t)) { if (section !== 'purchases') { section = 'purchases'; reset(); } return; }
      if (/^OTROS COBROS/i.test(t)) { section = 'fees'; reset(); return; }
      if (/^PAGO DEL MES \(Suma de subtotales\)/i.test(t)) {
        var nums = r.cells.filter(function (c) { return isAmount(c.str); });
        monthly = {};
        nums.forEach(function (c) { monthly[currencyByX(c, split)] = num(c.str); });
        section = null;
        return;
      }
      if (/^SUBTOTAL\b/i.test(t)) {
        var sub = {};
        r.cells.filter(function (c) { return isAmount(c.str); })
          .forEach(function (c) { sub[currencyByX(c, split)] = num(c.str); });
        // Compare against the rows read in this section. The previous-balance
        // row belongs to the same subtotal as the payments that follow it.
        var key = section === 'payments' ? 'payments' : section;
        ['PEN', 'USD'].forEach(function (cur) {
          var read = round2((rowsSum[cur] || 0) + (key === 'payments' ? (prev[cur] || 0) : 0));
          var want = sub[cur] === undefined ? 0 : sub[cur];
          if (round2(read) !== round2(want)) errors.push('Subtotal (' + key + ', ' + cur + ') read ' + read.toFixed(2) + ' ≠ statement ' + want.toFixed(2) + '.');
        });
        subtotals[key] = sub;
        if (section === 'purchases') rowsSum = rowsSum; // purchases may span pages; a subtotal closes it
        reset();
        return;
      }
      if (/^Debías en el estado de cuenta anterior/i.test(t)) {
        r.cells.filter(function (c) { return isAmount(c.str); })
          .forEach(function (c) { prev[currencyByX(c, split)] = num(c.str); });
        return;
      }

      // Movement rows: "25-Jul  DESCRIPTION  amount(s)"
      var dm = r.cells[0] && r.cells[0].str.match(/^(\d{2})-([A-Za-z]{3})$/);
      if (!dm || !MONTHS[dm[2].toLowerCase()] || !section || section === 'previous') return;
      var month = MONTHS[dm[2].toLowerCase()];
      var date = iso(inferYear(month, endY, endM), month, +dm[1]);
      var amts = r.cells.filter(function (c) { return c.x0 > 300 && isAmount(c.str); });
      var desc = r.cells.slice(1).filter(function (c) { return !(c.x0 > 300 && isAmount(c.str)); })
        .map(function (c) { return c.str; }).join(' ');
      if (!amts.length) { errors.push('Movement without an amount: ' + t); return; }
      amts.forEach(function (c) {
        var cur = currencyByX(c, split);
        var printed = num(c.str);
        dedupeSum(rowsSum, cur, printed);
        if (printed === 0) return;
        // Printed amounts are debt: a purchase is positive, a payment negative.
        lines.push({ date: date, description: desc, amount: round2(-printed), currency: cur, section: section });
      });
    });

    if (!monthly) errors.push('"PAGO DEL MES" total not found.');
    else {
      ['PEN', 'USD'].forEach(function (cur) {
        var sum = round2(['payments', 'purchases', 'fees'].reduce(function (a, k) { return a + ((subtotals[k] && subtotals[k][cur]) || 0); }, 0));
        if (round2(monthly[cur] || 0) !== sum) errors.push('Sum of subtotals ' + sum.toFixed(2) + ' ≠ PAGO DEL MES ' + (monthly[cur] || 0).toFixed(2) + ' (' + cur + ').');
      });
    }
    var balances = {};
    ['PEN', 'USD'].forEach(function (cur) {
      balances[cur] = { opening: round2(-(prev[cur] || 0)), closing: round2(-(monthly ? (monthly[cur] || 0) : 0)) };
    });
    return {
      ok: errors.length === 0, errors: errors, kind: 'visa', bank: 'Interbank',
      account: { last4: l4[1], label: 'Interbank Visa Infinite' },
      period: { start: start, end: end }, balances: balances, lines: lines
    };
  }

  // ---- Diners Club ----

  function parseDiners(rows) {
    var errors = [];
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var l4 = all.match(/X{4,}(\d{4})/);
    var pm = all.match(/PERIODO FACTURADO DEL\s+(\d{1,2})\s+([A-Z]{3})\s+AL\s+(\d{1,2})\s+([A-Z]{3})/i);
    var due = all.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    var total = all.match(/S\/\s*([\d,]+\.\d{2})\s*\/\s*US\$\s*([\d,]+\.\d{2})/);
    if (!l4 || !pm || !due || !total) return fail('diners', ['Could not read card number / period / total.']);
    var endM = MONTHS[pm[4].toLowerCase()], endD = +pm[3];
    var endY = endM <= +due[2] ? +due[3] : +due[3] - 1;
    var startM = MONTHS[pm[2].toLowerCase()];
    var start = iso(startM > endM ? endY - 1 : endY, startM, +pm[1]);
    var end = iso(endY, endM, endD);

    var SPLIT = 538; // right edge of S/ amounts ≈ 510, of US$ amounts ≈ 566
    var section = null;
    var rowsSum = {};
    var subtotals = {};
    var lines = [];
    var dateRe = /^(\d{2})\s+([A-Z]{3})$/;

    rows.forEach(function (r) {
      var t = r.text;
      if (/^PAGOS\/ABONOS/i.test(t)) { section = 'payments'; rowsSum = {}; return; }
      if (/^CONSUMOS REVOLVENTES/i.test(t)) { section = 'purchases'; rowsSum = {}; return; }
      if (/^COMISIONES Y OTROS CARGOS/i.test(t)) { section = 'fees'; rowsSum = {}; return; }
      if (/^SUB TOTAL\b/i.test(t)) {
        var sub = {};
        r.cells.filter(function (c) { return isAmount(c.str); }).forEach(function (c) { sub[currencyByX(c, SPLIT)] = num(c.str); });
        ['PEN', 'USD'].forEach(function (cur) {
          var read = round2(rowsSum[cur] || 0), want = sub[cur] === undefined ? 0 : sub[cur];
          if (read !== round2(want)) errors.push('Sub total (' + section + ', ' + cur + ') read ' + read.toFixed(2) + ' ≠ statement ' + want.toFixed(2) + '.');
        });
        subtotals[section] = sub;
        section = null;
        return;
      }
      if (!section) return;
      var d1 = r.cells[0] && r.cells[0].str.match(dateRe);
      if (!d1 || !MONTHS[d1[2].toLowerCase()]) return;
      var month = MONTHS[d1[2].toLowerCase()];
      var date = iso(month <= endM ? endY : endY - 1, month, +d1[1]);
      var amts = r.cells.filter(function (c) { return c.x0 > 300 && isAmount(c.str); });
      var desc = r.cells.slice(1).filter(function (c) { return !(c.x0 > 300 && isAmount(c.str)) && !dateRe.test(c.str); })
        .map(function (c) { return c.str; }).join(' ');
      if (!amts.length) { errors.push('Movement without an amount: ' + t); return; }
      amts.forEach(function (c) {
        var cur = currencyByX(c, SPLIT);
        var printed = num(c.str);
        dedupeSum(rowsSum, cur, printed);
        if (printed === 0) return;
        // Payments reduce the debt (money in for the account view); purchases and fees increase it.
        lines.push({ date: date, description: desc, amount: round2(section === 'payments' ? printed : -printed), currency: cur, section: section });
      });
    });

    var balances = {
      PEN: { opening: null, closing: round2(-num(total[1])) },
      USD: { opening: null, closing: round2(-num(total[2])) }
    };
    return {
      ok: errors.length === 0, errors: errors, kind: 'diners', bank: 'Diners',
      account: { last4: l4[1], label: 'Diners Club' },
      period: { start: start, end: end }, balances: balances, lines: lines
    };
  }


  // ---- BCP savings (Cuenta Digital, soles / dólares) ----
  // No running balance: an opening balance ("SALDO ANTERIOR"), the rows,
  // and a totals line — so the check is opening + credits − charges = closing
  // AND the rows must sum to the printed totals.

  function parseBcp(rows) {
    var errors = [];
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var codeM = all.match(/\b(\d{3}-\d{8}-\d-\d{2})\b/);
    var pm = all.match(/DEL\s+(\d{2})\/(\d{2})\/(\d{2})\s+AL\s+(\d{2})\/(\d{2})\/(\d{2})/);
    if (!codeM || !pm) return fail('bcp', ['Could not read the account code / period.']);
    var currency = /\bSOLES\b/.test(all.split('\n').slice(0, 14).join('\n')) ? 'PEN' : 'USD';
    var digits = codeM[1].replace(/-/g, '');
    var y = 2000 + +pm[6];

    var header = rows.find(function (r) { return /CARGOS\s*\/\s*DEBE/i.test(r.text); });
    var split = 450;
    if (header) {
      var cg = header.cells.find(function (c) { return /CARGOS/i.test(c.str); });
      var ab = header.cells.find(function (c) { return /ABONOS/i.test(c.str); });
      if (cg && ab) split = (cg.x1 + ab.x0) / 2;
    }

    var opening = null, closing = null, totalCharges = null, totalCredits = null;
    var lines = [];
    var sumCharges = 0, sumCredits = 0;
    var dateRe = /^(\d{2})([A-Z]{3})$/;

    rows.forEach(function (r) {
      var t = r.text;
      if (/SALDO ANTERIOR/i.test(t)) {
        var a = r.cells.filter(function (c) { return isAmount(c.str); });
        if (a.length) opening = num(a[a.length - 1].str);
        return;
      }
      if (/TOTAL MOVIMIENTO/i.test(t)) {
        var am = r.cells.filter(function (c) { return isAmount(c.str); });
        am.forEach(function (c) { if (c.x1 < split) totalCharges = num(c.str); else totalCredits = num(c.str); });
        return;
      }
      if (/^SALDO\b/i.test(r.cells[0] && r.cells[0].str) || (r.cells[0] && /^SALDO$/i.test(r.cells[0].str))) {
        var b = r.cells.filter(function (c) { return isAmount(c.str); });
        if (b.length) closing = num(b[b.length - 1].str);
        return;
      }
      var d1 = r.cells[0] && r.cells[0].str.match(dateRe);
      if (!d1 || !MONTHS[d1[2].toLowerCase()]) return;
      var month = MONTHS[d1[2].toLowerCase()];
      var amts = r.cells.filter(function (c) { return c.x0 > 300 && isAmount(c.str); });
      var desc = r.cells.slice(2).filter(function (c) { return c.x0 < 300 && !/^[*\d]$/.test(c.str); })
        .map(function (c) { return c.str; }).join(' ');
      if (!amts.length) { errors.push('Movement without an amount: ' + t); return; }
      var c = amts[0];
      var value = num(c.str);
      var isCharge = c.x1 < split;
      if (isCharge) sumCharges = round2(sumCharges + value); else sumCredits = round2(sumCredits + value);
      if (value === 0) return; // e.g. "MANT. CUENTA … 0.00" (free maintenance)
      lines.push({
        date: iso(y, month, +d1[1]), description: desc,
        amount: round2(isCharge ? -value : value), currency: currency, section: 'movement'
      });
    });

    if (opening === null || closing === null) errors.push('Opening ("SALDO ANTERIOR") or closing ("SALDO") balance not found.');
    if (totalCharges === null || totalCredits === null) errors.push('"TOTAL MOVIMIENTO" not found.');
    if (opening !== null && closing !== null && totalCharges !== null && totalCredits !== null) {
      if (round2(opening + totalCredits - totalCharges) !== round2(closing)) errors.push('Opening + credits − charges = ' + round2(opening + totalCredits - totalCharges).toFixed(2) + ' ≠ closing ' + closing.toFixed(2) + '.');
      if (round2(sumCharges) !== round2(totalCharges)) errors.push('Charges read ' + sumCharges.toFixed(2) + ' ≠ statement ' + totalCharges.toFixed(2) + '.');
      if (round2(sumCredits) !== round2(totalCredits)) errors.push('Credits read ' + sumCredits.toFixed(2) + ' ≠ statement ' + totalCredits.toFixed(2) + '.');
    }
    var balances = {};
    balances[currency] = { opening: opening, closing: closing };
    return {
      ok: errors.length === 0, errors: errors, kind: 'bcp', bank: 'BCP',
      account: { last4: digits.slice(-4), number: codeM[1], label: 'BCP Cuenta Digital ' + (currency === 'PEN' ? 'soles' : 'dólares') },
      period: { start: iso(y, +pm[2], +pm[1]), end: iso(y, +pm[5], +pm[4]) }, balances: balances, lines: lines
    };
  }

  // ---- AhorraMás (app statement: one signed line per activity) ----
  // No opening balance and no running balance, so a reading can't be
  // checked against anything — `verified: false`. "Ahorros disponible" is
  // the balance on the day the PDF was generated, not at the period end,
  // so it is reported as `availableNow` and never used as a closing balance.

  function parseAhorramas(rows) {
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var pm = all.match(/Estado de cuenta del\s+(\d{2})\/(\d{2})\/(\d{4})\s+al\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    var cur = all.match(/Moneda\s+(Soles|D[óo]lares)/i);
    var acct = all.match(/N°\s*de tu cuenta\s+(\d+)/i);
    var avail = all.match(/Ahorros disponible:\s*(?:S\/|US\$)\s*([\d,]+\.\d{2})/i);
    if (!pm || !cur || !acct) return fail('ahorramas', ['Could not read the period / currency / account.']);
    var currency = /Soles/i.test(cur[1]) ? 'PEN' : 'USD';
    var start = iso(pm[3], +pm[2], +pm[1]), end = iso(pm[6], +pm[5], +pm[4]);
    var lines = [], skipped = 0;
    rows.forEach(function (r) {
      var m = r.text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s+([+-])\s*(?:S\/|US\$)\s*([\d,]+\.\d{2})$/);
      if (!m) return;
      var date = iso(m[3], +m[2], +m[1]);
      // The PDF lists whatever history the app keeps (months before and after
      // the period too); only the period itself belongs to this statement.
      if (date < start || date > end) { skipped++; return; }
      lines.push({
        date: date, description: m[4], amount: round2((m[5] === '-' ? -1 : 1) * num(m[6])),
        currency: currency, section: 'movement'
      });
    });
    var balances = {};
    balances[currency] = { opening: null, closing: null };
    return {
      ok: true, errors: [], verified: false,
      warnings: ['AhorraMás statements have no opening or running balance, so the reading could not be checked against totals.'],
      kind: 'ahorramas', bank: 'AhorraMás',
      account: { last4: acct[1].slice(-4), number: acct[1], label: 'AhorraMás ' + (currency === 'PEN' ? 'soles' : 'dólares') },
      period: { start: start, end: end }, balances: balances, lines: lines,
      availableNow: avail ? num(avail[1]) : null, skippedOutOfPeriod: skipped
    };
  }

  // ---- SIP credit card (PEN only) ----
  // Checks: opening debt + purchases/interest − payments/reversals = the
  // printed total debt, using the statement's own "(C) DEUDA TOTAL" line.

  function parseSip(rows) {
    var errors = [];
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var l4 = all.match(/\*{4,}(\d{4})/);
    var pm = all.match(/del\s+(\d{2})\/(\d{2})\/(\d{4})\s+al\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (!l4 || !pm) return fail('sip', ['Could not read the card number / billing cycle.']);
    var lines = [];
    var prev = null, opening = null;
    var charges = 0, credits = 0;
    var inMovements = false;
    var dateRe = /^\d{2}\/\d{2}\/\d{4}$/;
    rows.forEach(function (r) {
      var t = r.text;
      if (/SALDO MES ANTERIOR/i.test(t)) {
        var a = r.cells.filter(function (c) { return isAmount(c.str); });
        if (a.length) prev = num(a[a.length - 1].str);
        inMovements = true;
        return;
      }
      if (/^\(A\) PAGO DEL MES/i.test(t) || /DEUDA TOTAL\s+MONEDA/i.test(t)) inMovements = false;
      if (!inMovements || !r.cells[0] || !dateRe.test(r.cells[0].str)) return;
      var d = r.cells[0].str.split('/');
      var amtCell = r.cells.filter(function (c) { return isAmount(c.str); }).pop();
      if (!amtCell) { errors.push('Movement without an amount: ' + t); return; }
      var printed = num(amtCell.str);
      var desc = r.cells.slice(1).filter(function (c) { return c !== amtCell && !/^[TA]$/.test(c.str); })
        .map(function (c) { return c.str; }).join(' ');
      if (printed >= 0) charges = round2(charges + printed); else credits = round2(credits + printed);
      var section = /^PAGO/i.test(desc) ? 'payments' : (/^REV\./i.test(desc) ? 'reversal' : (/SEGURO|INTER[EÉ]S|COMISI/i.test(desc) ? 'fees' : 'purchases'));
      // Printed amounts are debt: a purchase is positive, a payment/reversal negative.
      lines.push({ date: iso(d[2], +d[1], +d[0]), description: desc, amount: round2(-printed), currency: 'PEN', section: section });
    });

    // The "(C) DEUDA TOTAL" line: SALDO INICIAL, + CONSUMOS E INTERESES, − PAGOS Y OTROS, = DEUDA TOTAL.
    var summary = null;
    rows.forEach(function (r) {
      var a = r.cells.filter(function (c) { return isAmount(c.str); }).map(function (c) { return num(c.str); });
      if (a.length === 4 && round2(a[0] + a[1] - a[2]) === round2(a[3])) summary = a;
    });
    if (prev === null) errors.push('"SALDO MES ANTERIOR" not found.');
    if (!summary) errors.push('"(C) DEUDA TOTAL" summary line not found or does not add up.');
    else {
      if (prev !== null && round2(prev) !== round2(summary[0])) errors.push('Opening debt ' + prev.toFixed(2) + ' ≠ statement ' + summary[0].toFixed(2) + '.');
      if (round2(charges) !== round2(summary[1])) errors.push('Purchases + interest read ' + charges.toFixed(2) + ' ≠ statement ' + summary[1].toFixed(2) + '.');
      if (round2(-credits) !== round2(summary[2])) errors.push('Payments + reversals read ' + (-credits).toFixed(2) + ' ≠ statement ' + summary[2].toFixed(2) + '.');
    }
    return {
      ok: errors.length === 0, errors: errors, kind: 'sip', bank: 'SIP',
      account: { last4: l4[1], label: 'SIP tarjeta de crédito' },
      period: { start: iso(pm[3], +pm[2], +pm[1]), end: iso(pm[6], +pm[5], +pm[4]) },
      balances: { PEN: { opening: prev === null ? null : round2(-prev), closing: summary ? round2(-summary[3]) : null } },
      lines: lines
    };
  }

  function parseStatement(rows) {
    var kind = detectKind(rows);
    if (kind === 'savings') return parseSavings(rows);
    if (kind === 'visa') return parseVisa(rows);
    if (kind === 'diners') return parseDiners(rows);
    if (kind === 'bcp') return parseBcp(rows);
    if (kind === 'ahorramas') return parseAhorramas(rows);
    if (kind === 'sip') return parseSip(rows);
    return fail(null, ['This statement layout is not recognized yet.']);
  }

  return { groupRows: groupRows, readPdfRows: readPdfRows, parseStatement: parseStatement, detectKind: detectKind };
});
