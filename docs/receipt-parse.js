// Turns the TEXT read from a restaurant / convenience-store receipt into the
// pieces the bill splitter needs: items, discount lines, a service charge and
// the printed total. Pure functions, no screen or OCR code — tested directly in
// tests/backend/receipt-parse.test.js. Deliberately rule-based (no AI), and
// deliberately cautious: whatever it cannot place is left out and the person
// fixes the list by hand in the sheet, which also reconciles it against the
// total, so a misread line can never slip through silently.
//
// What it understands (all seen on real receipts):
//   "2 PISCO SOUR   18.00  36.00"      quantity first, unit price, line total
//   "Pisco Sour     2  18.00  36.00"   quantity AFTER the name (Cant / P.U / Importe columns)
//   names wrapped onto the next line   ("SIN GAS") — appended to the item above
//   a discount under a dish            negative amount, trailing minus, DSCTO/PROMO/2x1
//   a bill-wide discount               printed AFTER a SUBTOTAL / TOTAL line ("Dcto (Otros)")
//   a service / tip line               only if printed above the final total
//   readers that turn 0 into 8 or 9    repaired by cross-checks (quantity × unit = line,
//                                      lines add up to the total), never by guessing blindly
(function (root) {
  "use strict";

  // Lines that carry an amount but are not dishes.
  const SKIP = /\b(SUB\s*-?\s*TOTAL|I\.?G\.?V\.?|OP\.?\s*[A-Z]{3,}\w*|OP\.|GRAVADA|EXONERAD[OA]|INAFECT[OA]|ICBPER|RUC|R\.U\.C\.?|TELF?|TEL[EÉ]FONO|FAX|FECHA|HORA|MESA|MOZO|MESERO|CAJERO|CAJA|PEDIDO|BOLETA|FACTURA|TICKET|TARJETA|VISA|MASTER\s*CARD|MASTERCARD|EFECTIVO|VUELTO|CAMBIO|REDONDEO|DNI|CLIENTE|PAGO|PAGADO|RECIBIDO|COMENSALES|PERSONAS|CANT\b|DESCRIPCI[OÓ]N|ART[IÍ]CULO|P\.?\s*UNIT|P\.?\s*U\b|IMPORTE\s*$|SALDO|TOTAL\s+NETO|REC(ARGO)?\.?\s+(AL\s+)?CONSUMO|R\.?\s*CONS|CONSUMO|SON|AV|AVDA|CAL|JR|URB|NRO|INT|PSJE|CALLE|AVENIDA|LOTE|PISO|MZ|OBSERVACI[OÓ]N|MONEDA|LOCAL|TIPO|EMPRESA|DIREC\w*|AUTORIZACI[OÓ]N|REPRESENTACI[OÓ]N|CONSULTE|REF)\b/i;
  const TOTAL = /\b(IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+VENTA|TOTAL\s+GENERAL|TOTAL)\b/i;
  const DISCOUNT = /\b(DSCTO|DCTO|DESCUENTO|DESC\.?|PROMO(CI[OÓ]N)?|OFERTA|CUP[OÓ]N|2\s*X\s*1|REBAJA|BONIF(ICACI[OÓ]N)?)\b/i;
  const CHARGE = /\b(SERVICIO|SERVICE|PROPINA|TIP|CARGO\s+POR\s+SERVICIO|CONSUMO\s+M[IÍ]NIMO)\b/i;
  const LETTER = /[A-Za-zÁÉÍÓÚÑáéíóúñü]/;

  // OCR often reads 0 as O and 1 as l/I inside a price; repair only tokens that
  // are otherwise numeric.
  function fixDigits(tok) {
    return /^[\dOolI]*[.,][\dOolI]{2,3}$/.test(tok) && /\d/.test(tok)
      ? tok.replace(/[Oo]/g, "0").replace(/[lI]/g, "1")
      : tok;
  }

  // "1,234.50" / "1.234,50" / "38,00" / "38.00" -> number (or null). A stray
  // third decimal ("56.080", the reader doubling a 0) is dropped.
  function parseAmount(raw) {
    const t = String(raw).replace(/\s+/g, "").replace(/^(\d{1,4}):(\d{2})$/, "$1.$2");
    const m = /^(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{2})\d?$/.exec(t);
    if (!m) return null;
    return Number(m[1].replace(/[.,]/g, "") + "." + m[2]);
  }

  // Amount tokens at the END of a line, e.g. "38.00", "S/ 38.00", "10.00-",
  // "-10.00". Returns {amounts: [{value, negative}], rest}.
  function splitTrailingAmounts(line) {
    let rest = line.replace(/S\s*\/\s*\.?/gi, " ").trimEnd();
    // a LAST token with a single decimal ("16.0") lost a digit: read it as x.d0
    rest = rest.replace(/(^|\s)(\d{1,6}[.,]\d)\s*$/, "$1$20");
    const amounts = [];
    for (;;) {
      const m = /(?:^|\s)(-?\s?[\dOolI.,:]*[.,:][\dOolI]{2,3})(\s?-)?\s*$/.exec(rest);
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
    const t = s.replace(/[|_*~=]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s.:;,\-—–]+|[\s.:;,\-—–]+$/g, "");
    if (t === t.toUpperCase()) return t.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñü])/g, (_, a, b) => a + b.toUpperCase());
    return t;
  }

  const cents = (n) => Math.round(n * 100);
  const money = (c) => (c / 100).toFixed(2);

  // Readers confuse a 0 with an 8 or a 9 (dotted thermal fonts). The other
  // readings of an amount that only change an 8/9 in its decimals back to a 0.
  function zeroVariants(c) {
    const digits = String(Math.max(0, c)).padStart(3, "0").split("");
    const spots = digits.map((d, i) => (d === "8" || d === "9" ? i : -1)).filter((i) => i >= 0).slice(-4);
    const out = [c];
    // every way of turning up to TWO of those 8s/9s back into 0s
    for (let a = 0; a < spots.length; a++) {
      const one = digits.slice(); one[spots[a]] = "0";
      out.push(Number(one.join("")));
      for (let b = a + 1; b < spots.length; b++) {
        const two = one.slice(); two[spots[b]] = "0";
        out.push(Number(two.join("")));
      }
    }
    return Array.from(new Set(out));
  }

  // Unit words that do not make a name ("KG X", "30UN").
  const UNIT_WORDS = /\b(KG|X|UN|UND|UNID|UNIDAD|UNIDADES|GR|LT|L)\b/gi;
  const lettersOf = (s) => (s.match(/[A-Za-zÁÉÍÓÚÑáéíóúñü]/g) || []).length;
  // A price line with no name of its own ("2 .435 KG X 12.90 5.61", "3 X 4.60 13.80"):
  // supermarkets print the name on the line ABOVE.
  const namelessRest = (rest) => lettersOf(rest.replace(UNIT_WORDS, "")) < 3;
  const stripCode = (s) => s.replace(/^\s*[\d\-]{6,}\s*/, "").replace(/^\s*\d{1,2}\s+(?=\D)/, "");

  // The line that opens the item table ("Producto  Cant.  P.Unit  Total").
  const HEADER = /\b(CANT\w*|CNT)\b.*\b(DESCRIP\w*|PRODUCTO|ART\w*|DETALLE)\b|\b(DESCRIP\w*|PRODUCTO|ART[IÍ]CULO|DETALLE)\b.*\b(CANT\w*|P\.?\s?U\w*|PRECIO|IMPORTE|TOTAL|VALOR)\b/i;

  // OCR slips in the words that matter.
  const fixKeywords = (l) => l
    .replace(/\bTota[\]|1Il!]/gi, "Total").replace(/\bT0TAL\b/gi, "TOTAL")
    .replace(/\b[T1lI][GC6]V\b/g, "IGV").replace(/\bIC[BR]PER\b/gi, "ICBPER");

  function parseReceipt(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => fixKeywords(l.trim())).filter(Boolean);
    const headerAt = lines.findIndex((l) => HEADER.test(l));     // -1 when there is none
    let pending = null;        // a name printed on the line above its price line
    const unpriced = [];       // lines that look like a dish but whose price the reader missed
    const taxLines = [];       // IGV / consumption surcharge printed between SUBTOTAL and TOTAL
    const items = [];          // {name, cands:[cents], pick, discount, afterSubtotal, index}
    const charges = [];        // {name, cents, index}
    const totals = [];         // {cents, index}
    const warnings = [];
    const unreadCharges = [];
    let sawSubtotal = false;
    let sawTotal = false;
    let lastItemIndex = -2;    // for names wrapped onto the next line
    let wraps = 0;

    lines.forEach((line, index) => {
      if (index <= headerAt) return;                           // address, RUC, date … above the table
      if (/SUB\s*-?\s*TOTAL/i.test(line)) { sawSubtotal = true; return; }
      // junk the reader left after the last price ("12,00   1", "43.00   li")
      line = line.replace(/(\d[.,:]\d{2})((?:\s+[^\s]{1,3})+)\s*$/, (m, amt, tail) =>
        tail.trim().split(/\s+/).some((t) => /[.,:]\d{2}$/.test(t)) ? m : amt);
      let { amounts, rest } = splitTrailingAmounts(line);
      if (!amounts.length && TOTAL.test(line) && !/SUB\s*-?\s*TOTAL|DESC/i.test(line)) {
        // a total read as "S/ 11700" (point lost) or "152/73" (slash for the point)
        const m = /(?:^|\s)(\d{1,4})\s?[\/ ]\s?(\d{2})\s*$/.exec(line) || /(?:^|\s)(\d{1,4})(00)\s*$/.exec(line.replace(/S\s*\/\s*/gi, " "));
        if (m && Number(m[1]) > 0) {
          amounts = [{ value: Number(m[1] + "." + m[2]), negative: false }];
          rest = line.slice(0, m.index);
        }
      }
      if (!amounts.length) {
        // A service / tip line whose amount the reader garbled ("SERVICIO 10%  Les 10"):
        // remembered, and filled in from the total below if that fits.
        if (CHARGE.test(line) && !TOTAL.test(line) && !SKIP.test(line)) {
          unreadCharges.push({ name: tidyName(line.replace(/\d+\s*%/g, "").split(/\s{2,}/)[0]) || "Service", index });
          return;
        }
        const bare = stripCode(line);                   // without a leading barcode / quantity
        const wordy = lettersOf(bare) >= 3 && /[A-Za-zÁÉÍÓÚÑáéíóúñü]{3,}/.test(bare) &&
          lettersOf(bare) / bare.replace(/\s/g, "").length >= 0.7 &&
          !SKIP.test(line) && !TOTAL.test(line) && !DISCOUNT.test(line) && !CHARGE.test(line);
        if (!wordy || sawSubtotal || sawTotal) return;
        // Name ABOVE a nameless price line (supermarket style) …
        const nxt = lines[index + 1] ? splitTrailingAmounts(lines[index + 1]) : null;
        if (nxt && nxt.amounts.length && namelessRest(nxt.rest)) { pending = { name: tidyName(stripCode(line)), index }; return; }
        // … a dish with its quantity but no price the reader could see ("1 SPRITE"): kept,
        // with an empty price, so the person can see it is missing …
        if ((/^\d{1,2}\s+[A-Za-zÁÉÍÓÚÑ]{3,}/.test(line) || /^\+\s*[A-Za-zÁÉÍÓÚÑ]{3,}/.test(line)) && lettersOf(line) >= (items.length || unpriced.length ? 4 : 5)) {
          unpriced.push({ name: tidyName(line.replace(/^\d{1,2}\s+/, "").replace(/\s+\d{1,2}$/, "")), index });
          lastItemIndex = index;
          return;
        }
        // … or a dish name that wrapped onto this line ("SIN GAS"): words only.
        const prev = items[items.length - 1];
        if (prev && !prev.discount && index === lastItemIndex + 1 && wraps < 2) {
          prev.name = `${prev.name} ${tidyName(line)}`;
          wraps++;
          lastItemIndex = index;   // a second wrapped line stays attached to the same dish
        }
        return;
      }
      wraps = 0;
      const last = amounts[amounts.length - 1];
      const stopDishes = sawSubtotal || sawTotal;

      if (/TOTAL\s+(DESC|DSCTO|DCTO)/i.test(line)) {          // "Total Descuento S/ 150.00"
        if (last.value > 0) items.push({ name: "Discount", cands: [cents(last.value)], pick: 0, discount: true, afterSubtotal: true, index });
        return;
      }
      if (TOTAL.test(line) && !SKIP.test(line.replace(TOTAL, ""))) {
        if (last.value > 0) totals.push({ cents: cents(last.value), index });
        sawTotal = true;
        return;
      }
      if (DISCOUNT.test(rest) || last.negative) {
        // "DSCTO PROMO LOMO" -> "Promo Lomo"; a bare "DESCUENTO 10%" keeps its word.
        const stripped = rest.replace(DISCOUNT, "");
        const label = !stopDishes && /[A-Za-zÁÉÍÓÚÑáéíóúñü]{2}/.test(stripped) ? stripped : rest;
        items.push({ name: tidyName(stripCode(label)) || "Discount", cands: [cents(last.value)], pick: 0, discount: true, afterSubtotal: stopDishes, index });
        return;
      }
      if (CHARGE.test(rest)) {
        charges.push({ name: tidyName(rest.replace(/\d+\s*%/g, "")) || "Service", cents: cents(last.value), index });
        return;
      }
      if (SKIP.test(rest) || /\d\s*%/.test(rest) || stopDishes) {
        // Taxes / surcharges between SUBTOTAL and TOTAL: some bills price items WITHOUT
        // them, so they may be part of the total — decided below, only if they make it add up.
        if (sawSubtotal && !sawTotal && last.value > 0 && /\b(IGV|RECARGO|REC\.?\s*(AL\s*)?CONSUMO|R\.?\s*CONS|ICBPER|IMPUESTO|SERVICIO)\b/i.test(rest)) {
          taxLines.push({ name: tidyName(rest.replace(/\d+([.,]\d+)?\s*%/g, "").replace(/\b(S\/?|SOLES)\b/gi, "")) || "Tax", cents: cents(last.value), index });
        }
        return;                                                  // taxes, summaries, nothing after the total
      }

      // A dish.
      let name = rest;
      let qty = 1;
      let qtyKnown = false;
      const weighed = /\bKG\b/i.test(name);
      if (namelessRest(name) && pending && pending.index === index - 1) {
        // "3 X 4.60 13.80" under "7750… NAME": the name came from the line above
        const q = /(\d{1,3})\s*[xX]\b/.exec(name);
        if (q && !weighed) { qty = Number(q[1]); qtyKnown = amounts.length === 2; }
        name = pending.name;
      } else if (lettersOf(name) < 2) {
        return;                                                  // no words: not a dish
      } else {
        // "name  qty  unit  total" (quantity column AFTER the name, as 3 or 3.00) …
        const trailing = amounts.length === 2 ? /\s(\d{1,3})(?:[.,:]\d{1,2})?$/.exec(name) : null;
        if (trailing && !weighed) { qty = Number(trailing[1]); qtyKnown = true; name = name.slice(0, trailing.index); }
        else if (!weighed) {
          // … or "2 name  unit  total" (quantity first).
          const q = /^(\d{1,2})\s*[xX]?\s+(?=\D)/.exec(name);
          if (q) { qty = Number(q[1]); qtyKnown = true; name = name.slice(q[0].length); }
        }
        name = stripCode(name);
      }
      pending = null;
      // Possible amounts for this line, best first: the printed line total, then
      // quantity × unit price. When they disagree by a stray 8/9 for a 0 the
      // zero reading wins; otherwise the printed total stays first and the
      // other is kept for the cross-check against the bill total below.
      let cands = [cents(last.value)];
      if (amounts.length === 2 && qtyKnown) {
        const read = cents(amounts[1].value);
        const expected = Math.round(cents(amounts[0].value) * qty);
        if (expected !== read) {
          // Which values could BOTH columns be saying? (the total with its 8/9s
          // turned back into 0s, and the unit price with its own, times the quantity)
          const fromTotal = zeroVariants(read);
          const fromUnit = zeroVariants(cents(amounts[0].value)).map((u) => u * qty);
          const both = fromTotal.filter((v) => fromUnit.includes(v));
          if (both.length) cands = [both.sort((x, y) => Math.abs(x - read) - Math.abs(y - read))[0], read, expected];
          else cands = [read, expected];
        }
      } else if (amounts.length === 1 || !qtyKnown) {
        zeroVariants(cands[0]).forEach((v) => { if (!cands.includes(v)) cands.push(v); });
      }
      cands = cands.slice(0, 8);
      name = tidyName(name);
      if (lettersOf(name) < 2) return;
      items.push({ name: qty > 1 ? `${name} x${qty}` : name, cands, pick: 0, discount: false, afterSubtotal: false, index });
      lastItemIndex = index;
    });

    // Which dish does a discount belong to? One whose name it mentions ("DSCTO PROMO
    // LOMO" -> Lomo Saltado, moved to sit right under it so it merges into it); with
    // no such word, the dish above — unless the discount is BIGGER than that dish,
    // then it is the whole bill's.
    const GENERIC = /^(promo|promocion|promoción|descuento|dscto|dcto|oferta|cupon|cupón|rebaja|bonif\w*|total|club|desc)$/i;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (!it.discount || it.afterSubtotal) continue;
      const words = it.name.toLowerCase().split(/[^a-záéíóúñü]+/).filter((w) => w.length >= 4 && !GENERIC.test(w));
      let target = -1;
      for (let j = k - 1, seen = 0; j >= 0 && seen < 8; j--) {
        if (items[j].discount) continue;
        seen++;
        if (words.some((w) => items[j].name.toLowerCase().includes(w))) { target = j; break; }
      }
      if (target >= 0) {
        if (target !== k - 1 && !items.slice(target + 1, k).every((x) => x.discount)) {
          items.splice(k, 1);
          items.splice(target + 1, 0, it);                    // right under the dish it names
        }
        continue;
      }
      let above = null;
      for (let j = k - 1; j >= 0; j--) if (!items[j].discount) { above = items[j]; break; }
      if (!above || it.cands[it.pick] > above.cands[above.pick]) it.afterSubtotal = true;
    }

    // Bill-wide discounts: printed after the SUBTOTAL / TOTAL line, not under a dish.
    const wide = items.filter((i) => i.discount && i.afterSubtotal);
    const kept = items.filter((i) => !(i.discount && i.afterSubtotal));
    const wideSum = wide.reduce((s, i) => s + i.cands[i.pick], 0);

    // Charges only count when printed above the final total (a "suggested
    // tip" printed below it is not part of the bill).
    const lastTotal = totals.length ? totals[totals.length - 1].index : Infinity;
    const usedCharges = charges.filter((c) => c.index < lastTotal);
    const chargeSum = usedCharges.reduce((s, c) => s + c.cents, 0);

    const netOf = (picks) => kept.reduce((s, it, k) => s + (it.discount ? -1 : 1) * it.cands[picks[k]], 0);
    let picks = kept.map((it) => it.pick);

    // The totals the bill could be printing BEFORE bill-wide discounts: each TOTAL
    // line as read (and with 8/9 turned back into 0), and the same plus the
    // discounts when it is the "total to pay" line.
    const preCandidates = [];
    totals.forEach((t) => zeroVariants(t.cents).forEach((v) => {
      preCandidates.push({ pre: v, read: t.cents });
      if (wideSum) preCandidates.push({ pre: v + wideSum, read: t.cents });
    }));
    const matches = (net) => preCandidates.find((c) => c.pre === net + chargeSum);

    // If the lines don't add up, look for the FEW lines whose other reading
    // (or zero-variant) makes them add up exactly — only when that is unambiguous.
    let fixedNote = "";
    if (totals.length && !unpriced.length && !matches(netOf(picks))) {
      const open = [];
      kept.forEach((it, k) => { if (it.cands.length > 1) open.push(k); });
      const limit = Math.min(open.length, 14);
      const solutions = [];
      const search = (at, changed, cur) => {
        if (solutions.length > 3) return;
        if (matches(netOf(cur)) && changed.length) { solutions.push({ cur: cur.slice(), changed: changed.slice() }); return; }
        if (changed.length >= 3 || at >= limit) return;
        for (let j = at; j < limit; j++) {
          const k = open[j];
          for (let alt = 1; alt < kept[k].cands.length; alt++) {
            const nxt = cur.slice();
            nxt[k] = alt;
            changed.push(k);
            search(j + 1, changed, nxt);
            changed.pop();
          }
        }
      };
      search(0, [], picks);
      if (solutions.length) {
        const fewest = Math.min(...solutions.map((s) => s.changed.length));
        const best = solutions.filter((s) => s.changed.length === fewest);
        if (best.length === 1) {
          picks = best[0].cur;
          fixedNote = `Fixed ${best[0].changed.length === 1 ? "a number" : best[0].changed.length + " numbers"} that didn't add up (${best[0].changed.map((k) => `"${kept[k].name}"`).join(", ")}) — check ${best[0].changed.length === 1 ? "it" : "them"}.`;
        }
      }
    }
    const itemsNet = netOf(picks);

    // Tax / surcharge lines that, added to the items, make the bill add up to its total.
    const addedTaxes = [];
    if (totals.length && taxLines.length && !unpriced.length && !matches(itemsNet)) {
      const t = taxLines.slice(0, 6);
      let found = null;
      for (let size = 1; size <= t.length && !found; size++) {
        const hits = [];
        const pick = (at, chosen, sum) => {
          if (chosen.length === size) { if (matches(itemsNet + sum)) hits.push(chosen.slice()); return; }
          for (let j = at; j < t.length; j++) { chosen.push(t[j]); pick(j + 1, chosen, sum + t[j].cents); chosen.pop(); }
        };
        pick(0, [], 0);
        if (hits.length === 1) found = hits[0];
        else if (hits.length > 1) break;                       // ambiguous: don't guess
      }
      if (found) found.forEach((x) => addedTaxes.push(x));
    }

    // One service line with an unreadable amount: it is whatever the total
    // needs on top of the items (accepted only if small enough to be a service
    // charge, and always flagged so the person can check it).
    addedTaxes.forEach((x) => usedCharges.push({ name: x.name, cents: x.cents, index: x.index }));
    if (addedTaxes.length) warnings.push(`This bill adds ${addedTaxes.map((x) => x.name).join(" and ")} on top of the item prices — included as ${addedTaxes.length === 1 ? "a charge" : "charges"}.`);
    let chargeTotal = chargeSum + addedTaxes.reduce((s, x) => s + x.cents, 0);
    if (unreadCharges.length === 1 && unreadCharges[0].index < lastTotal && totals.length) {
      const gap = totals[totals.length - 1].cents + wideSum - itemsNet - chargeTotal;
      if (gap > 0 && gap <= Math.max(1, Math.round(itemsNet * 0.3))) {
        usedCharges.push({ name: unreadCharges[0].name, cents: gap, index: unreadCharges[0].index });
        chargeTotal += gap;
        warnings.push(`The amount of "${unreadCharges[0].name}" couldn't be read; ${money(gap)} was worked out from the total — check it.`);
      }
    }
    if (fixedNote) warnings.push(fixedNote);

    // The printed total the sheet wants is BEFORE bill-wide discounts.
    let totalCents = null;
    if (totals.length) {
      const hit = preCandidates.find((c) => c.pre === itemsNet + chargeTotal);
      totalCents = hit ? hit.pre : (() => {
        const t = totals[totals.length - 1].cents;
        return t;
      })();
    }
    // Dishes whose price was not read: one of them takes whatever the total
    // still needs (flagged); with several, the person is told which are empty.
    let unpricedOut = unpriced.map((u) => ({ name: u.name, cents: null, index: u.index }));
    // The total already adds up without them: they are free (modifiers like "+Leche"), not missing.
    if (unpricedOut.length && totalCents !== null && totalCents === itemsNet + chargeTotal) unpricedOut = [];
    if (unpricedOut.length && totalCents !== null) {
      const gap = totalCents - (itemsNet + chargeTotal);
      if (unpricedOut.length === 1 && gap > 0 && gap <= Math.round(totalCents * 0.6)) {
        unpricedOut[0].cents = gap;
        warnings.push(`The price of "${unpricedOut[0].name}" wasn't read; ${money(gap)} was worked out from the total — check it.`);
      } else {
        warnings.push(`${unpricedOut.length === 1 ? "1 line has" : unpricedOut.length + " lines have"} no price read (${unpricedOut.map((u) => `"${u.name}"`).slice(0, 4).join(", ")}) — fill ${unpricedOut.length === 1 ? "it" : "them"} in.`);
      }
    } else if (unpricedOut.length) {
      warnings.push(`${unpricedOut.length} line${unpricedOut.length === 1 ? "" : "s"} with no price read — fill in the price${unpricedOut.length === 1 ? "" : "s"}.`);
    }
    if (totalCents === null) warnings.push("No total found — type the total printed on the bill.");
    else if (totalCents !== itemsNet + chargeTotal && !unpricedOut.length) {
      warnings.push(`The lines read add up to ${money(itemsNet + chargeTotal)} but the bill says ${money(totalCents)} — check the list below.`);
    }
    if (!kept.some((i) => !i.discount) && !unpriced.length) warnings.push("No items could be read — add them by hand.");

    // Receipt order (a discount moved under its dish stays there); a line with no
    // price goes before the first priced line that came after it on the paper.
    const outItems = kept.map((i, k) => ({ name: i.name, price: money(i.cands[picks[k]]), discount: i.discount, index: i.index }));
    unpricedOut.forEach((u) => {
      const at = outItems.findIndex((o) => o.index > u.index);
      const row = { name: u.name, price: u.cents === null ? "" : money(u.cents), discount: false, index: u.index };
      if (at < 0) outItems.push(row); else outItems.splice(at, 0, row);
    });
    return {
      items: outItems.map((i) => ({ name: i.name, price: i.price, discount: i.discount })),
      charges: usedCharges.map((c) => ({ name: c.name, amount: money(c.cents) })),
      discounts: wide.map((d) => ({ name: d.name, amount: money(d.cands[d.pick]) })),
      total: totalCents === null ? "" : money(totalCents),
      warnings
    };
  }

  // How well a parse fits its own printed total: reconciled when the items plus
  // charges add up to it (and there are at least two items); gap = how far off.
  function fit(parsed) {
    const net = Math.round(parsed.items.reduce((s, i) => s + (i.discount ? -1 : 1) * (i.price === "" ? 0 : Number(i.price)) * 100, 0));
    const ch = Math.round(parsed.charges.reduce((s, c) => s + Number(c.amount) * 100, 0));
    if (parsed.total === "") return { reconciled: false, known: false, gap: Infinity };
    const gap = Math.abs(Math.round(Number(parsed.total) * 100) - (net + ch));
    const priced = parsed.items.filter((i) => i.price !== "").length;
    return { reconciled: gap === 0 && priced >= 2 && !parsed.items.some((i) => i.price === ""), known: true, gap };
  }

  const api = { parseReceipt, parseAmount, zeroVariants, fit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptParse = api;
})(typeof window !== "undefined" ? window : this);
