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

  // Messages for the person go through the language engine (browser: window.tr; tests: Node, English).
  function msg(key, params) { return (typeof module === 'object' && module.exports ? require('./i18n.js').tr : window.tr)(key, params); }

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

  /**
   * pdfjsLib: the loaded pdf.js module; data: Uint8Array of the PDF.
   * opts.onPassword(reason) -> Promise<string|null>: called when the PDF is
   * password-protected (reason 1 = needs a password, 2 = the last one was
   * wrong); resolve null to give up. The password is only handed to pdf.js,
   * never kept here.
   */
  function readPdfRows(pdfjsLib, data, opts) {
    var task = pdfjsLib.getDocument({ data: data, useSystemFonts: true });
    if (opts && opts.onPassword) {
      task.onPassword = function (update, reason) {
        opts.onPassword(reason).then(function (pw) {
          if (pw === null || pw === undefined) task.destroy(); else update(pw);
        });
      };
    }
    return task.promise.then(function (doc) {
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

  // Any Interbank credit card (Visa, American Express, Classic, Infinite…) prints the same
  // "payment of the month" pages; the card's own name is only on the first line, so the layout is
  // recognised by its section headings, not by a card name.
  function isInterbankCard(all) {
    return /interbank/i.test(all) && /DETALLE DE PAGO DEL MES/i.test(all) &&
      /PAGOS REALIZADOS/i.test(all) && /PAGO DEL MES \(Suma de subtotales\)/i.test(all);
  }

  function titleCase(s) {
    return String(s).toLowerCase().replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  // The SIP "(C) DEUDA TOTAL" row: SALDO INICIAL, CONSUMOS E INTERESES, PAGOS Y OTROS, DEUDA TOTAL.
  function sipSummary(rows) {
    var summary = null;
    rows.forEach(function (r) {
      var a = r.cells.filter(function (c) { return isAmount(c.str); }).map(function (c) { return num(c.str); });
      if (a.length === 4 && round2(a[0] + a[1] - a[2]) === round2(a[3])) summary = a;
    });
    return summary;
  }

  function detectKind(rows) {
    var all = rows.map(function (r) { return r.text; }).join('\n');
    if (/DETALLE DE MOVIMIENTOS/.test(all) && /EMPEZASTE/i.test(all)) return 'savings';
    if (isInterbankCard(all)) return 'visa';
    if (/Estado de Cuenta Tarjeta/i.test(all) && /Ciclo de Facturaci[óo]n/i.test(all) && /MONTO TOTAL FACTURADO/i.test(all)) return 'bcpcard';
    if (/Listado de movimientos/i.test(all) && /Total Facturado Mes Anterior/i.test(all) && /\bCMR\b|Falabella/i.test(all)) return 'cmr';
    if (/PERIODO FACTURADO DEL/i.test(all)) return 'diners';
    if (/Estado de Cuenta de Ahorros/i.test(all) && /FECHA PROC/i.test(all)) return 'bcp';
    if (/Ahorros disponible/i.test(all) && /Estado de cuenta del/i.test(all)) return 'ahorramas';
    if (/TARJETA DE CR[ÉE]DITO SIP/i.test(all) && /DETALLE DE TU ESTADO DE CUENTA/i.test(all)) return 'sip';
    // Some SIP PDFs are a scan: the headings above are part of the picture and
    // only the movements carry real text.
    // Since the bank's name is not in the text, also require its closing
    // "(C)" row: four amounts where opening + purchases − payments = total debt.
    if (/SALDO MES ANTERIOR/i.test(all) && /DETALLE DE MOVIMIENTO DEL MES/i.test(all) && /TIT\/ADIC/i.test(all) && sipSummary(rows)) return 'sip';
    return null;
  }

  // ---- Interbank savings / sueldo ("Cuenta Simple/Sueldo Soles/Dólares") ----

  function parseSavings(rows) {
    var errors = [];
    // Everything after the first "SALDO CONTABLE AL" is Interbank's generic
    // "how to read your statement" page, which shows another person's sample
    // account — it must never be read.
    var end = rows.findIndex(function (r) { return /^SALDO CONTABLE AL\b/i.test(r.text); });
    if (end === -1) return fail('savings', [msg('sp.noClosing')]);
    var body = rows.slice(0, end + 1);

    var title = body.map(function (r) { return r.text; }).join('\n');
    var kindM = title.match(/CUENTA\s+(SIMPLE|SUELDO)\s+(SOLES|D[ÓO]LARES)/i) || title.match(/AHORRO\s+(SUELDO|SIMPLE)\s+(SOLES|D[ÓO]LARES)/i);
    var numM = title.match(/\b(\d{3})-(\d{7,})\b/);
    if (!kindM || !numM) return fail('savings', [msg('sp.noAccount')]);
    var currency = /SOLES/i.test(kindM[2]) ? 'PEN' : 'USD';
    var number = numM[1] + '-' + numM[2];

    var openM = title.match(/EMPEZASTE[^\n]*?CON\s+(-?[\d,]+\.\d{2})/i);
    if (!openM) return fail('savings', [msg('sp.noOpening')]);
    var opening = num(openM[1]);

    var lines = [];
    var running = opening;
    var totalIn = 0, totalOut = 0;
    body.forEach(function (r) {
      var c = r.cells;
      if (c.length < 4 || !/^\d{2}\/\d{2}\/\d{4}$/.test(c[0].str)) return;
      var bal = c[c.length - 1].str, amt = c[c.length - 2].str;
      if (!isAmount(bal) || !/^[+-]/.test(amt) || !isAmount(amt)) {
        errors.push(msg('sp.unreadableRow', { text: r.text }));
        return;
      }
      var d = c[0].str.split('/');
      var amount = num(amt), balance = num(bal);
      if (round2(running + amount) !== round2(balance)) {
        errors.push(msg('sp.runningBreaks', { text: r.text, expected: round2(running + amount).toFixed(2) }));
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
    if (!cm) return fail('savings', errors.concat([msg('sp.closingUnreadable', { text: closeRow.text })]));
    var closing = num(cm[5]);
    if (round2(running) !== round2(closing)) errors.push(msg('sp.lastRunning', { a: running.toFixed(2), b: closing.toFixed(2) }));
    if (round2(totalIn) !== round2(num(cm[3]))) errors.push(msg('sp.ingresosRead', { a: totalIn.toFixed(2), b: num(cm[3]).toFixed(2) }));
    if (round2(totalOut) !== round2(num(cm[4]))) errors.push(msg('sp.gastosRead', { a: totalOut.toFixed(2), b: num(cm[4]).toFixed(2) }));

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

  // ---- Interbank credit cards (every card name; kind stays 'visa' — the matcher keys on it) ----

  // The card line near the top, e.g. "<CARD NAME> 1234 56** **** 7890 - SOLES": the name is whatever
  // comes before the number, the last four digits end the masked number.
  function interbankCardLine(rows) {
    for (var i = 0; i < Math.min(rows.length, 12); i++) {
      var t = rows[i].text;
      if (!/[*Xx•]{2,}/.test(t)) continue;
      var m = t.match(/^(.*?)\s*\d{4,6}\s+\d{2,6}[*Xx•]+\s*[*Xx•\s]*?(\d{4})\b/) || t.match(/^(.*?)\s*[*Xx•]{2,}[*Xx•\s]*?(\d{4})\b/);
      if (m) return { name: m[1].replace(/^\s*INTERBANK\s*/i, '').replace(/[\d\s]+$/, '').trim(), last4: m[2] };
    }
    return null;
  }

  function parseVisa(rows) {
    var errors = [];
    var all = rows.map(function (r) { return r.text; }).join('\n');
    var card = interbankCardLine(rows);
    var l4 = card ? [null, card.last4] : all.match(/\*{2,}\s*(\d{4})/);
    var pm = all.match(/del\s+(\d{2})\/(\d{2})\/(\d{4})\s+al\s+cierre\s+de\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (!l4 || !pm) return fail('visa', [msg('sp.noCardPeriod')]);
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
          if (round2(read) !== round2(want)) errors.push(msg('sp.subtotal', { key: key, cur: cur, a: read.toFixed(2), b: want.toFixed(2) }));
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
      if (!amts.length) { errors.push(msg('sp.noAmount', { text: t })); return; }
      amts.forEach(function (c) {
        var cur = currencyByX(c, split);
        var printed = num(c.str);
        dedupeSum(rowsSum, cur, printed);
        if (printed === 0) return;
        // Printed amounts are debt: a purchase is positive, a payment negative.
        lines.push({ date: date, description: desc, amount: round2(-printed), currency: cur, section: section });
      });
    });

    var credit = {};        // per currency: negative sum of subtotals when the card is in credit
    if (!monthly) errors.push(msg('sp.pagoMissing'));
    else {
      ['PEN', 'USD'].forEach(function (cur) {
        var sum = round2(['payments', 'purchases', 'fees'].reduce(function (a, k) { return a + ((subtotals[k] && subtotals[k][cur]) || 0); }, 0));
        // Paid more than owed: the bank prints PAGO DEL MES as 0.00 but the subtotals add to a
        // negative (a credit balance carried to the next statement) — that is consistent, not an error.
        if (round2(monthly[cur] || 0) === 0 && sum < 0) { credit[cur] = sum; return; }
        if (round2(monthly[cur] || 0) !== sum) errors.push(msg('sp.sumSubtotals', { a: sum.toFixed(2), b: (monthly[cur] || 0).toFixed(2), cur: cur }));
      });
    }
    var balances = {};
    ['PEN', 'USD'].forEach(function (cur) {
      balances[cur] = { opening: round2(-(prev[cur] || 0)), closing: round2(credit[cur] !== undefined ? -credit[cur] : -(monthly ? (monthly[cur] || 0) : 0)) };
    });
    return {
      ok: errors.length === 0, errors: errors, kind: 'visa', bank: 'Interbank',
      account: { last4: l4[1], label: 'Interbank' + (card && card.name ? ' ' + titleCase(card.name) : ' card') },
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
    if (!l4 || !pm || !due || !total) return fail('diners', [msg('sp.noCardPeriodTotal')]);
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
          if (read !== round2(want)) errors.push(msg('sp.subTotalSection', { section: section, cur: cur, a: read.toFixed(2), b: want.toFixed(2) }));
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
      if (!amts.length) { errors.push(msg('sp.noAmount', { text: t })); return; }
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
    if (!codeM || !pm) return fail('bcp', [msg('sp.noCodePeriod')]);
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
      if (!amts.length) { errors.push(msg('sp.noAmount', { text: t })); return; }
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

    if (opening === null || closing === null) errors.push(msg('sp.openingClosingMissing'));
    if (totalCharges === null || totalCredits === null) errors.push(msg('sp.totalMovMissing'));
    if (opening !== null && closing !== null && totalCharges !== null && totalCredits !== null) {
      if (round2(opening + totalCredits - totalCharges) !== round2(closing)) errors.push(msg('sp.openingCredits', { a: round2(opening + totalCredits - totalCharges).toFixed(2), b: closing.toFixed(2) }));
      if (round2(sumCharges) !== round2(totalCharges)) errors.push(msg('sp.chargesRead', { a: sumCharges.toFixed(2), b: totalCharges.toFixed(2) }));
      if (round2(sumCredits) !== round2(totalCredits)) errors.push(msg('sp.creditsRead', { a: sumCredits.toFixed(2), b: totalCredits.toFixed(2) }));
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
    if (!pm || !cur || !acct) return fail('ahorramas', [msg('sp.noPeriodCurrencyAccount')]);
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
      warnings: [msg('sp.ahorramasNoBalance')],
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
    var l4 = all.match(/\*{4,}\s*(\d{4})/);
    var pm = all.match(/del\s+(\d{2})\/(\d{2})\/(\d{4})\s+al\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    var named = /TARJETA DE CR[ÉE]DITO SIP/i.test(all);
    if (!l4 || !pm) return fail('sip', [msg('sp.noCardCycle')]);
    // The scanned layout prints a payment as "- 318.86" (space after the minus).
    rows.forEach(function (r) {
      r.cells.forEach(function (c) { c.str = c.str.replace(/^-\s+(?=[\d,]+\.\d{2}$)/, '-'); });
    });
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
      if (!amtCell) { errors.push(msg('sp.noAmount', { text: t })); return; }
      var printed = num(amtCell.str);
      var desc = r.cells.slice(1).filter(function (c) { return c !== amtCell && !/^[TA]$/.test(c.str); })
        .map(function (c) { return c.str; }).join(' ');
      if (printed >= 0) charges = round2(charges + printed); else credits = round2(credits + printed);
      var section = /^PAGO/i.test(desc) ? 'payments' : (/^REV\./i.test(desc) ? 'reversal' : (/SEGURO|INTER[EÉ]S|COMISI/i.test(desc) ? 'fees' : 'purchases'));
      // Printed amounts are debt: a purchase is positive, a payment/reversal negative.
      lines.push({ date: iso(d[2], +d[1], +d[0]), description: desc, amount: round2(-printed), currency: 'PEN', section: section });
    });

    // The "(C) DEUDA TOTAL" line: SALDO INICIAL, + CONSUMOS E INTERESES, − PAGOS Y OTROS, = DEUDA TOTAL.
    var summary = sipSummary(rows);
    if (prev === null) errors.push(msg('sp.prevMissing'));
    if (!summary) errors.push(msg('sp.summaryMissing'));
    else {
      if (prev !== null && round2(prev) !== round2(summary[0])) errors.push(msg('sp.openingDebt', { a: prev.toFixed(2), b: summary[0].toFixed(2) }));
      if (round2(charges) !== round2(summary[1])) errors.push(msg('sp.purchasesInterest', { a: charges.toFixed(2), b: summary[1].toFixed(2) }));
      if (round2(-credits) !== round2(summary[2])) errors.push(msg('sp.paymentsReversals', { a: (-credits).toFixed(2), b: summary[2].toFixed(2) }));
    }
    return {
      ok: errors.length === 0, errors: errors, kind: 'sip', bank: 'SIP',
      warnings: named ? [] : [msg('sp.sipByLayout', { last4: l4[1] })],
      account: { last4: l4[1], label: 'SIP tarjeta de crédito' },
      period: { start: iso(pm[3], +pm[2], +pm[1]), end: iso(pm[6], +pm[5], +pm[4]) },
      balances: { PEN: { opening: prev === null ? null : round2(-prev), closing: summary ? round2(-summary[3]) : null } },
      lines: lines
    };
  }

  // ---- BCP credit cards (Visa, American Express, Mastercard… — one layout, titled "Estado de Cuenta Tarjeta <name>") ----

  // BCP prints a credit as "123.45-" (minus AFTER the number). Returns the DEBT: a charge is positive.
  function bcpAmount(str) {
    var m = String(str).match(/^([\d,]+\.\d{2})(-?)$/);
    return m ? (m[2] ? -num(m[1]) : num(m[1])) : null;
  }

  function parseBcpCard(rows) {
    var errors = [];
    var titleM = null;
    rows.some(function (r) { titleM = r.cells[0] && r.cells[0].str.match(/^Estado de Cuenta Tarjeta\s+(.+)$/i); return !!titleM; });
    var cardName = titleM ? titleM[1].trim() : '';

    // Billing cycle: the row under the "Del … Al" headings holds the two dates (dd/mm/yy).
    var cycle = null, last4 = null;
    for (var i = 0; i < rows.length && !(cycle && last4); i++) {
      var cells = rows[i].cells;
      var numHdr = cells.find(function (c) { return /^N[úu]mero de tarjeta$/i.test(c.str); });
      var delHdr = cells.find(function (c) { return c.str === 'Del'; });
      if (!numHdr && !delHdr) continue;
      var below = rows.slice(i + 1, i + 4);
      if (numHdr && !last4) {
        below.some(function (br) {
          var cc = br.cells.find(function (c) { return Math.abs(c.x0 - numHdr.x0) <= 8; });
          var m = cc && cc.str.match(/(\d{4})\D*$/);
          if (m) last4 = m[1];
          return !!m;
        });
      }
      if (delHdr && !cycle) {
        below.some(function (br) {
          var ds = br.cells.filter(function (c) { return /^\d{2}\/\d{2}\/\d{2}$/.test(c.str); });
          if (ds.length >= 2) cycle = [ds[0].str.split('/'), ds[1].str.split('/')];
          return ds.length >= 2;
        });
      }
    }
    if (!last4 || !cycle) return fail('bcpcard', [msg('sp.noCardCycle')]);
    var start = iso(2000 + +cycle[0][2], +cycle[0][1], +cycle[0][0]);
    var endY = 2000 + +cycle[1][2], endM = +cycle[1][1];
    var end = iso(endY, endM, +cycle[1][0]);

    // Amounts are right-aligned, and on some statements a wide dollar amount starts LEFT of the "Dólares" heading, so the heading's
    // own left edge is not the border. The border is the middle between the "Soles" and "Dólares" headings' left edges (checked
    // on a real statement: soles amounts start left of it, dollar amounts right of it). See CHANGELOG.md § BCP card dollars.
    var dolX = null;            // set once both headings are seen
    var lines = [], prev = {}, total = null, sums = {};
    var haveBalance = false;
    var phase = 'items';        // items -> fees (from "INTERESES") -> done (after the total)

    function curOf(cell) { return cell.x0 < dolX ? 'PEN' : 'USD'; }
    function amountsOf(r) {
      return r.cells.map(function (c) { return { c: c, v: bcpAmount(c.str) }; }).filter(function (a) { return a.v !== null; });
    }
    function add(date, desc, debt, cur, section) {
      sums[cur] = round2((sums[cur] || 0) + debt);
      if (debt !== 0) lines.push({ date: date, description: desc, amount: round2(-debt), currency: cur, section: section });
    }

    rows.forEach(function (r) {
      var t = r.text;
      var sh = r.cells.find(function (c) { return c.str === 'Soles'; });
      var dh = r.cells.find(function (c) { return /^D[óo]lares$/i.test(c.str); });
      if (sh && dh) { dolX = (sh.x0 + dh.x0) / 2; return; }
      if (phase === 'done' || dolX === null) return;

      if (/^SALDO ANTERIOR/i.test(t)) {
        amountsOf(r).forEach(function (a) { prev[curOf(a.c)] = a.v; });
        haveBalance = true;
        return;
      }
      if (/^MONTO TOTAL FACTURADO/i.test(t)) {
        total = {};
        amountsOf(r).forEach(function (a) { total[curOf(a.c)] = a.v; });
        phase = 'done';
        return;
      }
      if (/^SUB ?TOTAL\b/i.test(t)) return;
      if (/^INTERESES\b/i.test(t)) phase = 'fees';

      // Movement: "12Sep  10Sep  SHOP  CITY  PE  CONSUMO  amount"
      var d1 = r.cells[0] && r.cells[0].str.match(/^(\d{1,2})\s?([A-Za-zÁ-ú]{3})\.?$/);
      var d2 = r.cells[1] && r.cells[1].str.match(/^(\d{1,2})\s?([A-Za-zÁ-ú]{3})\.?$/);
      if (phase === 'items' && d1 && d2 && MONTHS[d2[2].toLowerCase()] && MONTHS[d1[2].toLowerCase()]) {
        var month = MONTHS[d2[2].toLowerCase()];
        var date = iso(inferYear(month, endY, endM), month, +d2[1]);
        var amts = amountsOf(r);
        var words = r.cells.slice(2).filter(function (c) { return bcpAmount(c.str) === null; });
        if (!amts.length) { errors.push(msg('sp.noAmount', { text: t })); return; }
        var type = words.length > 1 ? words[words.length - 1].str : '';
        var desc = (words.length > 1 ? words.slice(0, -1) : words).map(function (c) { return c.str; }).join(' ');
        var section = /PAGO/i.test(type) ? 'payments' : (/DEVOLUCI|REVERS|ANUL/i.test(type) ? 'refunds' : 'purchases');
        amts.forEach(function (a) { add(date, desc, a.v, curOf(a.c), section); });
        return;
      }

      // Interest, commissions, insurance: undated rows between "INTERESES" and the total.
      if (phase === 'fees') {
        var label = r.cells.filter(function (c) { return bcpAmount(c.str) === null; }).map(function (c) { return c.str; }).join(' ');
        amountsOf(r).forEach(function (a) { add(end, label, a.v, curOf(a.c), 'fees'); });
      }
    });

    if (dolX === null) return fail('bcpcard', [msg('sp.bcpNoColumns')]);
    if (!haveBalance) errors.push(msg('sp.bcpNoBalance'));
    if (!total) errors.push(msg('sp.bcpNoTotal'));
    else {
      ['PEN', 'USD'].forEach(function (cur) {
        var read = round2((prev[cur] || 0) + (sums[cur] || 0));
        var want = round2(total[cur] || 0);
        if (read !== want) errors.push(msg('sp.bcpTotal', { cur: cur, a: read.toFixed(2), b: want.toFixed(2) }));
      });
    }
    var balances = {};
    ['PEN', 'USD'].forEach(function (cur) {
      balances[cur] = { opening: round2(-(prev[cur] || 0)), closing: round2(-(total ? (total[cur] || 0) : 0)) };
    });
    return {
      ok: errors.length === 0, errors: errors, kind: 'bcpcard', bank: 'BCP',
      account: { last4: last4, label: 'BCP' + (cardName ? ' ' + titleCase(cardName) : ' card') },
      period: { start: start, end: end }, balances: balances, lines: lines
    };
  }

  // ---- CMR Falabella credit cards (Banco Falabella; soles only; "Estado de Cuenta" with a "Listado de movimientos") ----

  // CMR prints a credit as "-123.45" (minus BEFORE the number) and some header amounts as "S/ 1,234.50". Returns the DEBT or null.
  function cmrAmount(str) {
    var m = String(str).replace(/^S\/\s*/, '').match(/^(-?)([\d,]+\.\d{2})$/);
    return m ? (m[1] ? -num(m[2]) : num(m[2])) : null;
  }

  function parseCmr(rows) {
    var errors = [];
    var cardName = '', last4 = null, due = null, cyc = null, totalDue = null, prev = 0, havePrev = false;
    rows.forEach(function (r) {
      var cells = r.cells;
      var nm = !cardName && cells.map(function (c) { return c.str.match(/^CMR\s+([A-ZÁÉÍÓÚ ]+)$/); }).find(Boolean);
      if (nm) cardName = nm[1].trim();
      // "Nº de Tarjeta   1234-56**-****-7890": the value is the cell after the label
      cells.forEach(function (c, i) {
        if (!last4 && /^N[º°o]\.? de Tarjeta$/i.test(c.str) && cells[i + 1]) { var m = cells[i + 1].str.match(/(\d{4})\D*$/); if (m) last4 = m[1]; }
        if (!cyc && /^Periodo de facturaci[óo]n$/i.test(c.str) && cells[i + 1]) cyc = cells[i + 1].str.match(/(\d{2})\/(\d{2})\s+al\s+(\d{2})\/(\d{2})/);
        if (!due && /^[ÚU]ltimo d[íi]a de pago$/i.test(c.str) && cells[i + 1]) due = cells[i + 1].str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (totalDue === null && /^Pago total del mes$/i.test(c.str) && cells[i + 1]) totalDue = cmrAmount(cells[i + 1].str);
      });
    });
    if (!last4 || !cyc || !due) return fail('cmr', [msg('sp.noCardCycle')]);
    // The cycle is printed as "dd/mm al dd/mm" with no year; the payment day (full date) comes after the cycle's end.
    var endM = +cyc[4], endY = endM <= +due[2] ? +due[3] : +due[3] - 1;
    var startM = +cyc[2], startY = startM <= endM ? endY : endY - 1;
    var start = iso(startY, startM, +cyc[1]), end = iso(endY, endM, +cyc[3]);

    var dateRe = /^(\d{2})\/(\d{2})\/(\d{4})$/;
    var lines = [], sum = 0;
    rows.forEach(function (r) {
      var cells = r.cells;
      if (/Total Facturado Mes Anterior/i.test(r.text)) {
        var pa = cells.map(function (c) { return cmrAmount(c.str); }).filter(function (v) { return v !== null; });
        prev = pa.length ? pa[pa.length - 1] : 0;   // all dashes when nothing was owed
        havePrev = true;
        return;
      }
      // Movement: "dd/mm/yyyy (transaction)  dd/mm/yyyy (processed)  DESCRIPTION  Peru  …  amount"; the right-most amount is the row's TOTAL
      var d1 = cells[0] && cells[0].str.match(dateRe), d2 = cells[1] && cells[1].str.match(dateRe);
      if (!d1 || !d2) return;
      var amts = cells.slice(2).filter(function (c) { return cmrAmount(c.str) !== null; });
      if (!amts.length) { errors.push(msg('sp.noAmount', { text: r.text })); return; }
      var printed = cmrAmount(amts[amts.length - 1].str);
      var desc = cells.slice(2).filter(function (c) { return cmrAmount(c.str) === null && !/^\d+\/\d+$/.test(c.str) && !/^(Peru|Perú)$/i.test(c.str); })
        .map(function (c) { return c.str; }).join(' ');
      var section = /^Pago\b/i.test(desc) ? 'payments' : /^Devoluci/i.test(desc) ? 'refunds'
        : /^(Itf|Seg\b|Seguro|Inter[eé]s|Comisi|Cuota de membres|Membres)/i.test(desc) ? 'fees' : 'purchases';
      sum = round2(sum + printed);
      if (printed !== 0) lines.push({ date: iso(+d1[3], +d1[2], +d1[1]), description: desc, amount: round2(-printed), currency: 'PEN', section: section });
    });

    if (!havePrev) errors.push(msg('sp.cmrNoPrev'));
    if (totalDue === null) errors.push(msg('sp.cmrNoTotal'));
    else if (havePrev && round2(prev + sum) !== round2(totalDue)) errors.push(msg('sp.cmrTotal', { a: round2(prev + sum).toFixed(2), b: totalDue.toFixed(2) }));
    return {
      ok: errors.length === 0, errors: errors, kind: 'cmr', bank: 'CMR Falabella',
      account: { last4: last4, label: 'CMR' + (cardName ? ' ' + titleCase(cardName) : ' card') },
      period: { start: start, end: end },
      balances: { PEN: { opening: round2(-prev) || 0, closing: totalDue === null ? null : (round2(-totalDue) || 0) } },   // "|| 0": never -0
      lines: lines
    };
  }

  // ---- who the statement belongs to ----
  // Every layout prints its holder near the top; the app uses it to learn the person's own name (backend/OwnerNames.gs). Returns
  // the name as printed (CAPITALS, any word order) or '' — an unrecognised line is never guessed. Ahorra Más only greets by first
  // name ("¡HOLA, …!"), which is not enough, so it gives nothing.
  var NAME_WORDS = '[A-ZÁÉÍÓÚÜÑ]{2,}(?: [A-ZÁÉÍÓÚÜÑ]{2,}){1,4}';
  function holderOf(kind, rows) {
    var texts = rows.slice(0, 16).map(function (r) { return String(r.text || '').trim(); });
    function first(re) {
      for (var i = 0; i < texts.length; i++) { var m = texts[i].match(re); if (m) return m[1]; }
      return '';
    }
    var name = '';
    if (kind === 'savings') {
      var at = texts.findIndex(function (t) { return /^DNI\b/.test(t); });
      if (at > 0 && new RegExp('^' + NAME_WORDS + '$').test(texts[at - 1])) name = texts[at - 1];
    } else if (kind === 'bcp') name = first(new RegExp('^(' + NAME_WORDS + ') CODIGO DE CUENTA\\b'));
    else if (kind === 'diners') name = first(new RegExp('^(' + NAME_WORDS + ') \\d{2}/\\d{2}/\\d{4}\\b'));
    else if (kind === 'visa') name = first(new RegExp('^(' + NAME_WORDS + ')$'));
    else if (kind === 'sip') name = first(new RegExp('^(' + NAME_WORDS + ') \\(A\\)'));
    else if (kind === 'bcpcard') {
      // the holder is the first cell of the row that carries the "Número de tarjeta" heading
      var nameRe = new RegExp('^' + NAME_WORDS + '$');
      var hr = rows.slice(0, 16).find(function (r) { return r.cells.some(function (c) { return /^N[úu]mero de tarjeta$/i.test(c.str); }); });
      if (hr && hr.cells[0] && nameRe.test(hr.cells[0].str.trim())) name = hr.cells[0].str.trim();
    } else if (kind === 'cmr') {
      // the holder is the only text on a line above "Estado de Cuenta" (the first line is the file name)
      var stop = texts.findIndex(function (t) { return /^Estado de Cuenta$/i.test(t); });
      for (var i = 1; i < stop && !name; i++) if (new RegExp('^' + NAME_WORDS + '$').test(texts[i])) name = texts[i];
    }
    return name;
  }

  function parseStatement(rows) {
    var kind = detectKind(rows);
    var res;
    if (kind === 'savings') res = parseSavings(rows);
    else if (kind === 'visa') res = parseVisa(rows);
    else if (kind === 'diners') res = parseDiners(rows);
    else if (kind === 'bcp') res = parseBcp(rows);
    else if (kind === 'bcpcard') res = parseBcpCard(rows);
    else if (kind === 'cmr') res = parseCmr(rows);
    else if (kind === 'ahorramas') res = parseAhorramas(rows);
    else if (kind === 'sip') res = parseSip(rows);
    else return fail(null, [msg('sp.notRecognized')]);
    if (res && res.ok) res.holder = holderOf(kind, rows);
    return res;
  }

  return { groupRows: groupRows, readPdfRows: readPdfRows, parseStatement: parseStatement, detectKind: detectKind, holderOf: holderOf };
});
