// Turns the TEXT read from a restaurant / convenience-store receipt into the
// pieces the bill splitter needs: items, discount lines, a service charge and
// the printed total. Pure functions, no screen or OCR code — tested directly in
// tests/backend/receipt-parse.test.js. Deliberately rule-based (no AI), and
// deliberately cautious: whatever it cannot place is left out and the person
// fixes the list by hand in the sheet, which also reconciles it against the
// total, so a misread line can never slip through silently.
(function (root) {
  "use strict";

  // Lines that carry an amount but are not dishes.
  const SKIP = /\b(SUB\s*-?\s*TOTAL|I\.?G\.?V\.?|OP\.?\s*(GRAVADA|EXONERADA|INAFECTA)|GRAVADA|EXONERAD[OA]|INAFECT[OA]|ICBPER|RUC|TELF?|TEL[EÉ]FONO|FECHA|HORA|MESA|MOZO|CAJERO|BOLETA|FACTURA|TICKET|TARJETA|VISA|MASTER\s*CARD|MASTERCARD|EFECTIVO|VUELTO|CAMBIO|REDONDEO|DNI|CLIENTE|PAGO|PAGADO|RECIBIDO|COMENSALES|PERSONAS|CANT\b|DESCRIPCI[OÓ]N|P\.?\s*UNIT|IMPORTE\s*$|SALDO)\b/i;
  const TOTAL = /\b(IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+VENTA|TOTAL\s+GENERAL|TOTAL)\b/i;
  const DISCOUNT = /\b(DSCTO|DCTO|DESCUENTO|DESC\.?|PROMO(CI[OÓ]N)?|OFERTA|CUP[OÓ]N|2\s*X\s*1|REBAJA|BONIF(ICACI[OÓ]N)?)\b/i;
  const CHARGE = /\b(SERVICIO|SERVICE|PROPINA|TIP|CARGO\s+POR\s+SERVICIO|CONSUMO\s+M[IÍ]NIMO)\b/i;

  // OCR often reads 0 as O and 1 as l/I inside a price; repair only tokens that
  // are otherwise numeric.
  function fixDigits(tok) {
    return /^[\dOolI]*[.,][\dOolI]{2}$/.test(tok) && /\d/.test(tok)
      ? tok.replace(/[Oo]/g, "0").replace(/[lI]/g, "1")
      : tok;
  }

  // "1,234.50" / "1.234,50" / "38,00" / "38.00" -> number (or null).
  function parseAmount(raw) {
    let t = String(raw).replace(/\s+/g, "");
    const m = /^(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{2})$/.exec(t);
    if (!m) return null;
    return Number(m[1].replace(/[.,]/g, "") + "." + m[2]);
  }

  // Amount tokens at the END of a line, e.g. "38.00", "S/ 38.00", "10.00-",
  // "-10.00". Returns {amounts: [{value, negative}], rest}.
  function splitTrailingAmounts(line) {
    let rest = line.replace(/S\s*\/\s*\.?/gi, " ").trimEnd();
    const amounts = [];
    for (;;) {
      const m = /(?:^|\s)(-?\s?[\dOolI.,]*[.,][\dOolI]{2})(\s?-)?\s*$/.exec(rest);
      if (!m) break;
      const tok = fixDigits(m[1].replace(/\s+/g, "").replace(/^-/, ""));
      const value = parseAmount(tok);
      if (value === null) break;
      amounts.unshift({ value, negative: /^-/.test(m[1].replace(/\s+/g, "")) || !!m[2] });
      rest = rest.slice(0, m.index).trimEnd();
      if (amounts.length >= 2) break;
    }
    return { amounts, rest };
  }

  function tidyName(s) {
    const t = s.replace(/[|_*~=]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s.:;,-]+|[\s.:;,-]+$/g, "");
    if (t === t.toUpperCase()) return t.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñü])/g, (_, a, b) => a + b.toUpperCase());
    return t;
  }

  const cents = (n) => Math.round(n * 100);
  const money = (c) => (c / 100).toFixed(2);

  function parseReceipt(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items = [];          // {name, cents, discount, index}
    const charges = [];        // {name, cents, index}
    const totals = [];         // {cents, index}
    const warnings = [];
    const unreadCharges = [];
    let sawSubtotal = false;

    lines.forEach((line, index) => {
      if (/SUB\s*-?\s*TOTAL/i.test(line)) { sawSubtotal = true; return; }
      const { amounts, rest } = splitTrailingAmounts(line);
      if (!amounts.length) {
        // A service / tip line whose amount the reader garbled ("SERVICIO 10%  Les 10"):
        // remembered, and filled in from the total below if that fits.
        if (CHARGE.test(line) && !TOTAL.test(line) && !SKIP.test(line)) unreadCharges.push({ name: tidyName(line.replace(/\d+\s*%/g, "").replace(CHARGE, (m) => m).split(/\s{2,}/)[0]) || "Service", index });
        return;
      }
      const last = amounts[amounts.length - 1];

      if (TOTAL.test(line) && !SKIP.test(line.replace(TOTAL, ""))) {
        totals.push({ cents: cents(last.value), index });
        return;
      }
      if (DISCOUNT.test(rest) || last.negative) {
        // "DSCTO PROMO LOMO" -> "Promo Lomo"; a bare "DESCUENTO 10%" keeps its word.
        const stripped = rest.replace(DISCOUNT, "");
        const label = /[A-Za-zÁÉÍÓÚÑáéíóúñü]{2}/.test(stripped) ? stripped : rest;
        items.push({ name: tidyName(label) || "Discount", cents: cents(last.value), discount: true, afterSubtotal: sawSubtotal, index });
        return;
      }
      if (CHARGE.test(rest)) {
        charges.push({ name: tidyName(rest.replace(/\d+\s*%/g, "")) || "Service", cents: cents(last.value), index });
        return;
      }
      if (SKIP.test(rest)) return;

      // A dish: needs real words.
      let name = rest;
      const letters = (name.match(/[A-Za-zÁÉÍÓÚÑáéíóúñü]/g) || []).length;
      if (letters < 2) return;
      let qty = 1;
      const q = /^(\d{1,2})\s*[xX]?\s+(?=\D)/.exec(name);
      if (q) { qty = Number(q[1]); name = name.slice(q[0].length); }
      // "unit price  line total": take the line total.
      let amount = last.value;
      if (amounts.length === 2) {
        const [unit, tot] = amounts;
        amount = Math.abs(unit.value * qty - tot.value) < 0.015 || tot.value >= unit.value ? tot.value : unit.value;
      }
      name = tidyName(name);
      items.push({ name: qty > 1 ? `${name} x${qty}` : name, cents: cents(amount), discount: false, afterSubtotal: sawSubtotal, index });
    });

    // Bill-wide discounts: printed after the SUBTOTAL line, not under a dish.
    const dishes = items.filter((i) => !i.discount);
    const lineDiscounts = items.filter((i) => i.discount && !i.afterSubtotal);
    const wide = items.filter((i) => i.discount && i.afterSubtotal);
    const kept = items.filter((i) => !(i.discount && i.afterSubtotal));
    const itemsNet = dishes.reduce((s, i) => s + i.cents, 0) - lineDiscounts.reduce((s, i) => s + i.cents, 0);
    const wideSum = wide.reduce((s, i) => s + i.cents, 0);

    // Charges only count when printed above the final total (a "suggested
    // tip" printed below it is not part of the bill).
    const lastTotal = totals.length ? totals[totals.length - 1].index : Infinity;
    const usedCharges = charges.filter((c) => c.index < lastTotal);
    let chargeSum = usedCharges.reduce((s, c) => s + c.cents, 0);

    // One service line with an unreadable amount: it is whatever the total
    // needs on top of the items (accepted only if small enough to be a service
    // charge, and always flagged so the person can check it).
    if (unreadCharges.length === 1 && unreadCharges[0].index < lastTotal && totals.length) {
      const gap = totals[totals.length - 1].cents + wideSum - itemsNet - chargeSum;
      if (gap > 0 && gap <= Math.max(1, Math.round(itemsNet * 0.3))) {
        usedCharges.push({ name: unreadCharges[0].name, cents: gap, index: unreadCharges[0].index });
        chargeSum += gap;
        warnings.push(`The amount of "${unreadCharges[0].name}" couldn't be read; ${money(gap)} was worked out from the total — check it.`);
      }
    }

    // The printed total the sheet wants is BEFORE bill-wide discounts: pick the
    // TOTAL line that fits what was read, else the last one.
    let totalCents = null;
    if (totals.length) {
      const fits = totals.find((t) => t.cents === itemsNet + chargeSum) ||
        totals.find((t) => t.cents + wideSum === itemsNet + chargeSum);
      const chosen = fits || totals[totals.length - 1];
      totalCents = chosen.cents;
      if (wideSum && chosen.cents + wideSum === itemsNet + chargeSum) totalCents = chosen.cents + wideSum;
    }
    if (totalCents === null) warnings.push("No total found — type the total printed on the bill.");
    else if (totalCents !== itemsNet + chargeSum) {
      warnings.push(`The lines read add up to ${money(itemsNet + chargeSum)} but the bill says ${money(totalCents)} — check the list below.`);
    }
    if (!dishes.length) warnings.push("No items could be read — add them by hand.");

    return {
      items: kept.map((i) => ({ name: i.name, price: money(i.cents), discount: i.discount })),
      charges: usedCharges.map((c) => ({ name: c.name, amount: money(c.cents) })),
      discounts: wide.map((d) => ({ name: d.name, amount: money(d.cents) })),
      total: totalCents === null ? "" : money(totalCents),
      warnings
    };
  }

  const api = { parseReceipt, parseAmount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptParse = api;
})(typeof window !== "undefined" ? window : this);
