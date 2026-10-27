// Business pack, step 3B: pulls the few things an expense or an income needs out of the TEXT read from a receipt, an invoice
// or a payment screenshot (Yape / Plin / bank): the total, the date, who it is from (the business that issued it) or from whom
// (the client who paid), the IGV when it is printed, and the invoice number. Pure functions, no screen or OCR code — tested
// directly in tests/backend/receipt-fields.test.js with made-up receipts. Rule-based (no AI) and cautious: whatever it cannot
// place is left blank and the person fills it in, because the result only FILLS the entry form and is always reviewed.
(function (root) {
  "use strict";

  const MONTHS = {
    ene: 1, enero: 1, jan: 1, january: 1, feb: 2, febrero: 2, february: 2, mar: 3, marzo: 3, march: 3, abr: 4, abril: 4, apr: 4, april: 4,
    may: 5, mayo: 5, jun: 6, junio: 6, june: 6, jul: 7, julio: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8,
    set: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9, oct: 10, octubre: 10, october: 10,
    nov: 11, noviembre: 11, november: 11, dic: 12, diciembre: 12, dec: 12, december: 12
  };

  // OCR slips in the words that matter (same ones the bill reader repairs).
  const fixKeywords = (l) => l
    .replace(/\bTota[\]|1Il!]/gi, "Total").replace(/\bT0TAL\b/gi, "TOTAL")
    .replace(/\b[T1lI][GC6]V\b/g, "IGV").replace(/\bI\s?G\s?V\b/gi, "IGV");

  // "1,180.00", "1.180,00", "118,00", "118.00" -> 1180 / 118; NaN when it is not an amount with two decimals.
  function toNumber(raw) {
    const m = /^(\d[\d.,]*?)[.,](\d{2})$/.exec(String(raw).replace(/\s/g, ""));
    return m ? Number(m[1].replace(/[.,]/g, "") + "." + m[2]) : NaN;
  }

  // Amounts printed with two decimals on a line. A percentage ("18%") is never an amount, and the pieces of a date ("12.10.2026") are not either.
  const AMOUNT = /(?:^|[^\d.,])(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?!\d|[.,]\d)/g;
  function amountsOf(line) {
    const clean = line.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");
    const out = [];
    let m;
    AMOUNT.lastIndex = 0;
    while ((m = AMOUNT.exec(clean))) {
      const n = toNumber(m[1]);
      if (n > 0) out.push(n);
    }
    return out;
  }

  // ---- the total ----
  const TOTAL_STRONG = /\b(IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+VENTA|TOTAL\s+GENERAL|MONTO\s+TOTAL|TOTAL\s+PAGADO|TOTAL\s+COMPROBANTE)\b/i;
  const TOTAL_PLAIN = /\bTOTAL\b/i;
  const TOTAL_WEAK = /\b(MONTO|IMPORTE|A\s+PAGAR)\b/i;
  const NOT_THE_TOTAL = /SUB\s*-?\s*TOTAL|GRAVAD|EXONERAD|INAFECT|\bIGV\b|DESC|ICBPER|PROPINA|VUELTO|CAMBIO|REDONDEO|EFECTIVO|RECIBIDO|PAGO\s+CON|ANTICIPO|OP\.?\s*[A-Z]{3,}/i;

  function findTotal(lines) {
    let best = null;
    lines.forEach((line, i) => {
      if (NOT_THE_TOTAL.test(line)) return;
      const rank = TOTAL_STRONG.test(line) ? 3 : TOTAL_PLAIN.test(line) ? 2 : TOTAL_WEAK.test(line) ? 1 : 0;
      if (!rank) return;
      let amounts = amountsOf(line);
      if (!amounts.length && i + 1 < lines.length && /^[^A-Za-z]*$/.test(lines[i + 1])) amounts = amountsOf(lines[i + 1]);   // the number is printed on the next line
      if (!amounts.length) return;
      const amount = amounts[amounts.length - 1];
      if (!best || rank > best.rank || (rank === best.rank && amount > best.amount)) best = { rank, amount, line };
    });
    if (best) return best;
    // A payment screenshot has no "TOTAL": it shows the amount next to the currency ("S/ 50", "S/ 1,250.50", "US$ 20.00").
    const CUR = /(?:S\s*\/\s*\.?|US\s*\$|\$)\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/g;
    let fallback = null;
    lines.forEach((line) => {
      let m;
      CUR.lastIndex = 0;
      while ((m = CUR.exec(line))) {
        const raw = m[1];
        const n = /[.,]\d{1,2}$/.test(raw) ? Number(raw.replace(/[.,](?=\d{3})/g, "").replace(",", ".")) : Number(raw.replace(/[.,]/g, ""));
        if (n > 0 && (!fallback || n > fallback.amount)) fallback = { rank: 0, amount: n, line };
      }
    });
    return fallback;
  }

  // ---- the IGV ----
  function findIgv(lines, total) {
    for (let i = 0; i < lines.length; i++) {
      if (!/\bIGV\b/.test(lines[i]) || /SIN\s+IGV|NO\s+INCLUYE/i.test(lines[i])) continue;
      const amounts = amountsOf(lines[i]);
      if (!amounts.length) continue;
      const n = amounts[amounts.length - 1];
      // the IGV is a fraction of the total (18/118 = 15%): a figure as big as the total is the base or the total itself
      if (total && !(n < total && n <= total * 0.25)) continue;
      return n;
    }
    return null;
  }

  // ---- the date ----
  function isoOf(y, m, d) {
    if (y < 100) y += 2000;
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return "";
    const last = new Date(y, m, 0).getDate();
    if (d > last) return "";
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function datesOf(line) {
    const out = [];
    let m;
    const numeric = /(?<!\d)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g;     // day first (Peru); month first only when the day cannot be one
    while ((m = numeric.exec(line))) {
      let d = Number(m[1]), mo = Number(m[2]);
      if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
      const iso = isoOf(Number(m[3]), mo, d);
      if (iso) out.push(iso);
    }
    const ymd = /(?<!\d)(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\d)/g;
    while ((m = ymd.exec(line))) {
      const iso = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) out.push(iso);
    }
    const words = /(?<!\d)(\d{1,2})\s*(?:de\s+)?([A-Za-záéíóúÁÉÍÓÚ]{3,10})\.?,?\s*(?:de\s+|del\s+)?(\d{4})(?!\d)/g;
    while ((m = words.exec(line))) {
      const mo = MONTHS[m[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
      const iso = mo ? isoOf(Number(m[3]), mo, Number(m[1])) : "";
      if (iso) out.push(iso);
    }
    return out;
  }

  function findDate(lines, today) {
    const limit = today ? new Date(today + "T00:00:00").getTime() + 2 * 86400000 : Infinity;   // a date after tomorrow is a misread
    const ok = (iso) => new Date(iso + "T00:00:00").getTime() <= limit;
    let first = "";
    for (const line of lines) {
      const found = datesOf(line).filter(ok);
      if (!found.length) continue;
      if (/FECHA|EMISI[OÓ]N|F\.\s*EMIS|DATE/i.test(line)) return found[0];
      if (!first) first = found[0];
    }
    return first;
  }

  // ---- who it is from / who paid ----
  const SKIP_NAME = /\b(RUC|R\.U\.C|FACTURA|BOLETA|TICKET|ELECTR[OÓ]NIC\w*|AV|AVDA|JR|CALLE|CAL|URB|TEL|TELF|FECHA|CLIENTE|SUCURSAL|DIRECCI[OÓ]N|YAPE|PLIN|OPERACI[OÓ]N|CONSTANCIA|COMPROBANTE|N[°º]|NRO|HORA)\b|^[\d\W_]+$/i;
  const COMPANY_WORD = /\b(S\.?A\.?C\.?|S\.?A\.?|S\.?R\.?L\.?|E\.?I\.?R\.?L\.?|S\.?A\.?S\.?|CORP\w*|INVERSIONES|COMERCIAL|RESTAURANT\w*|BOTICA|FARMACIA|SUPERMERCADO\w*|BODEGA|MINIMARKET|FERRETER[IÍ]A|LIBRER[IÍ]A|IMPORTACIONES|DISTRIBUIDORA|SERVICIOS)\b/i;
  const lettersOf = (s) => (s.match(/[A-Za-zÁÉÍÓÚÑáéíóúñü]/g) || []).length;

  function titleCase(s) {
    if (s !== s.toUpperCase()) return s;                  // already mixed case: leave it
    return s.toLowerCase().replace(/(^|[\s'(-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(sac|srl|eirl|sa|sas)\b/gi, (w) => w.toUpperCase());
  }

  function tidyName(s) {
    return titleCase(s.replace(/[|_~=]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[^A-Za-zÁÉÍÓÚÑ0-9]+|[^A-Za-z0-9.ÁÉÍÓÚÑáéíóúñü)*]+$/g, "").trim()).substring(0, 60);   // a trailing * is kept: Yape masks surnames ("Ana Lo*")
  }

  function findBusinessName(lines) {
    const head = lines.slice(0, 10).filter((l) => lettersOf(l) >= 4 && !SKIP_NAME.test(l) && lettersOf(l) / l.length >= 0.55);
    const company = head.find((l) => COMPANY_WORD.test(l));
    const pick = company || head[0];
    return pick ? tidyName(pick) : "";
  }

  function findPayer(lines) {
    const label = /\b(?:SE[ÑN]OR(?:\s*\(?ES\)?)?|CLIENTE|RAZ[OÓ]N\s+SOCIAL|ADQUIRENTE|DENOMINACI[OÓ]N|NOMBRE|ENVIADO\s+POR|ORIGEN|DE)\s*[:\-]\s*(.{3,60})$/i;
    for (const line of lines) {
      const m = label.exec(line);
      if (m && lettersOf(m[1]) >= 3 && !/^\d/.test(m[1])) return tidyName(m[1].replace(/\s+(RUC|DNI)\b.*$/i, ""));
    }
    for (const line of lines) {                           // "Ana Lo* te yapeó S/ 50"
      const m = /^(.{2,40}?)\s+(?:te\s+)?(?:yape[óo]|plane[óo]|envi[óo]|transfiri[óo])(?![A-Za-z])/i.exec(line);   // no \b: "ó" is not a word character
      if (m && lettersOf(m[1]) >= 2) return tidyName(m[1]);
    }
    return "";
  }

  // ---- RUC and invoice number ----
  function findRuc(lines) {
    for (const line of lines) {
      const m = /\bR\.?\s?U\.?\s?C\.?\s*[:.#-]?\s*(\d{11})\b/i.exec(line);
      if (m) return m[1];
    }
    return "";
  }

  // "F001-00123", "E001-45", "B001-7": a letter and three characters, a dash, the number. OCR reads the series' zeros as O.
  function findInvoice(lines) {
    for (const line of lines) {
      const m = /(?<![A-Za-z0-9])([FBE])\s?([A-Z0-9]{3})\s*[-–]\s*(\d{1,8})(?!\d)/i.exec(line.replace(/\bN[°º.]\s*/gi, ""));
      if (!m) continue;
      const series = m[1].toUpperCase() + m[2].toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
      if (!/^[FBE]\d{3}$/.test(series)) continue;
      return `${series}-${m[3]}`;
    }
    return "";
  }

  function findCurrency(text) {
    if (/US\s?\$|\bUSD\b|\bD[OÓ]LARES\b/i.test(text)) return "USD";
    if (/\bS\s*\/\s*\.?|\bSOLES\b|\bPEN\b/i.test(text)) return "PEN";
    return "";
  }

  // text: what the reader printed; opts.today ("YYYY-MM-DD") rules out a date that is still to come.
  function parse(text, opts) {
    opts = opts || {};
    const lines = String(text || "").split(/\r?\n/).map((l) => fixKeywords(l.replace(/\s{2,}/g, "  ").trim())).filter(Boolean);
    const total = findTotal(lines);
    const igv = findIgv(lines, total ? total.amount : 0);
    return {
      amount: total ? total.amount.toFixed(2) : "",
      date: findDate(lines, opts.today),
      name: findBusinessName(lines),
      payer: findPayer(lines),
      igv: igv ? igv.toFixed(2) : "",
      invoice: findInvoice(lines),
      ruc: findRuc(lines),
      currency: (total && findCurrency(total.line)) || findCurrency(String(text || ""))
    };
  }

  const api = { parse, toNumber, amountsOf, datesOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptFields = api;
})(typeof window !== "undefined" ? window : this);
