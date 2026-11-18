// A made-up person's money life, day by day (journeys, 2026-11-17). The same persona and dates always give the same days (seeded),
// so a run can be repeated. From it come the bank e-mails they get, the statements and app exports they bring, and the entries
// the day-runner types for them. Every merchant, amount and name is invented.

// mulberry32: a small seeded random generator.
function rng(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();   // 0 = Sunday
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const cents = (x) => Math.round(x * 100) / 100;

// One persona's transactions between two days (inclusive): [{ date, time, type, amount, currency, cat, merchant, via, habit }]
// Habit fields: cat (category key), what (merchant names), amt [min, max], perWeek (average count) | monthly (day of month) |
// weekdays ([0-6]), via ("cash" | "yape" | an account id), type (default expense), cur (default PEN), round (whole soles).
function days(persona, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = rng(persona.id + d);
    persona.habits.forEach((h, hi) => {
      let n = 0;
      if (h.monthly) {
        const dim = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
        n = +d.slice(8) === Math.min(h.monthly, dim) ? 1 : 0;
      } else if (h.weekdays) n = h.weekdays.includes(dow(d)) && r() < (h.chance === undefined ? 1 : h.chance) ? 1 : 0;
      else {
        // About perWeek times a week: a daily chance, at most 3 in a day.
        const p = h.perWeek / 7;
        for (let k = 0; k < 3; k++) if (r() < (k === 0 ? Math.min(p, 0.95) : Math.max(0, p - 1) / 2)) n++;
      }
      for (let k = 0; k < n; k++) {
        let amount = h.amt[0] + r() * (h.amt[1] - h.amt[0]);
        amount = h.round ? Math.round(amount) : cents(amount);
        const hour = h.hours ? h.hours[0] + Math.floor(r() * (h.hours[1] - h.hours[0])) : 8 + Math.floor(r() * 13);
        out.push({ date: d, time: String(hour).padStart(2, "0") + ":" + String(Math.floor(r() * 60)).padStart(2, "0"),
          type: h.type || "expense", amount, currency: h.cur || "PEN", cat: h.cat, merchant: pick(r, h.what), via: h.via || "cash", mail: h.mail || null, habit: hi });
      }
    });
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// Does the person open the app that day? persona.use = { perWeek, from (journey day), gaps: [[fromDay, toDay]] }, journey day 1 = start.
function opensApp(persona, start, d) {
  const n = daysBetween(start, d) + 1, u = persona.use || { perWeek: 7 };
  if (n === 1) return true;
  if ((u.gaps || []).some(([a, b]) => n >= a && n <= b)) return false;
  if (u.after && n > u.after.day) return rng(persona.id + "use" + d)() < u.after.perWeek / 7;
  return rng(persona.id + "use" + d)() < u.perWeek / 7;
}

// The e-mails a day's purchases make: a habit's own kind (a bill paid in the bank app), the account's kind (its card), or Yape's.
const UNREAD_ = /^(bbva|scotiabank)_/;   // e-mails the app has no rule for: they arrive but make nothing
function mailKind(persona, t) {
  if (t.type !== "expense") return null;
  if (t.via === "yape") return persona.yapeMail ? "yape_out" : null;
  const a = (persona.accounts || []).find((x) => x.id === t.via);
  return (typeof t.mail === "string" && t.mail) || (a && a.mail) || null;
}
function mails(persona, items) {
  return items.map((t) => [t, mailKind(persona, t)]).filter(([, k]) => k).map(([t, kind]) => {
    const a = (persona.accounts || []).find((x) => x.id === t.via) || {};
    return { kind, amount: t.amount, currency: t.currency, merchant: kind === "yape_out" ? t.merchant.replace(/^Yape a /, "") : t.merchant.toUpperCase(), last4: a.last4 || "0000", name: persona.first, at: t.date + "T" + t.time };
  });
}

// Would the person type this one in by hand? persona.record = { cash, yape, card } chances. A purchase the app will hear about from
// a bank e-mail it can read is left to that e-mail.
function typesIt(persona, t) {
  const k = mailKind(persona, t);
  if (k && !UNREAD_.test(k)) return false;
  const kind = t.via === "cash" ? "cash" : t.via === "yape" ? "yape" : "card";
  const p = (persona.record || {})[kind];
  return rng(persona.id + "rec" + t.date + t.time + t.amount)() < (p === undefined ? 0.7 : p);
}

module.exports = { rng, addDays, daysBetween, days, opensApp, mails, typesIt };
