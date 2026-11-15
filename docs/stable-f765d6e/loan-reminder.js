// "Remind on WhatsApp" message (pure functions, no screen code) — used by the person's loan screen in app.js and tested
// directly in tests/backend/loan-reminder.test.js. specs/loans.md § Reminders.
//
// Only what the friend owes the owner is mentioned, per currency, never converted (CLAUDE.md principle 5). A currency where
// the owner owes MORE than the friend does is left out entirely; where the owner owes a part, the total is the net and the
// message says it already takes that off. The newest debts are listed first, at most MAX_ITEMS of them.
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const i18n = () => (node ? require("./i18n.js") : root.I18n);
  const tr = (key, params) => i18n().tr(key, params);

  const MAX_ITEMS = 5;
  // How the money reads to a friend in Peru ("S/ 85.00"), whatever the app's language.
  const SYMBOLS = { PEN: "S/", USD: "US$", EUR: "€" };

  function money(amount, currency) {
    const n = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${SYMBOLS[currency] || currency} ${n}`;
  }

  const isOpen = (l) => l.status !== "forgiven" && Number(l.remaining) > 0.004;

  // Per currency: { owed: what they owe me, mine: what I owe them, net }. Only currencies with a positive net are kept.
  function owedByCurrency(loans) {
    const by = {};
    loans.filter(isOpen).forEach((l) => {
      const c = by[l.currency] || (by[l.currency] = { owed: 0, mine: 0 });
      if (l.direction === "they_owe_me") c.owed += Number(l.remaining);
      else c.mine += Number(l.remaining);
    });
    const out = {};
    Object.keys(by).forEach((cur) => {
      const net = Math.round((by[cur].owed - by[cur].mine) * 100) / 100;
      if (net > 0.004) out[cur] = { owed: by[cur].owed, mine: by[cur].mine, net };
    });
    return out;
  }

  // Whether the reminder makes sense at all: the friend owes something in at least one currency.
  function canRemind(loans) {
    return Object.keys(owedByCurrency(loans)).length > 0;
  }

  function firstName(name) {
    return String(name || "").trim().split(/\s+/)[0] || "";
  }

  function itemDate(iso, today) {
    const d = new Date(String(iso) + "T00:00:00");
    if (isNaN(d)) return "";
    return i18n().fmtMonthDay(d, String(iso).slice(0, 4) !== String(today).slice(0, 4));
  }

  // { name, loans (getFriendLoanDetail rows), today: "yyyy-MM-dd" } → the message text, in the app's current language.
  function build({ name, loans, today }) {
    const owed = owedByCurrency(loans);
    const currencies = Object.keys(owed).sort();
    if (!currencies.length) return "";
    const items = loans
      .filter((l) => isOpen(l) && l.direction === "they_owe_me" && owed[l.currency])
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const lines = [tr("remind.msg.hello", { name: firstName(name) }), ""];
    items.slice(0, MAX_ITEMS).forEach((l) => {
      const desc = String(l.description || "").trim() || tr(l.origin === "entry" ? "remind.msg.sharedExpense" : "remind.msg.loan");
      const date = itemDate(l.date, today);
      lines.push(tr("remind.msg.item", { desc: date ? `${desc} (${date})` : desc, amount: money(l.remaining, l.currency) }));
    });
    if (items.length > MAX_ITEMS) lines.push(tr("remind.msg.more", { n: items.length - MAX_ITEMS }));
    const amounts = currencies.map((cur) => money(owed[cur].net, cur));
    const joined = amounts.length > 1 ? amounts.slice(0, -1).join(", ") + tr("remind.msg.and") + amounts[amounts.length - 1] : amounts[0];
    lines.push("");
    lines.push(tr("remind.msg.total", { amounts: joined }));
    if (currencies.some((cur) => owed[cur].mine > 0.004)) lines.push(tr("remind.msg.afterMine"));
    lines.push("");
    lines.push(tr("remind.msg.thanks"));
    return lines.join("\n");
  }

  // The number as WhatsApp wants it in a link: digits only, country code first. "" when there is none.
  function phoneDigits(phone) {
    return String(phone || "").replace(/\D/g, "");
  }
  function phoneOk(phone) {
    const d = phoneDigits(phone);
    return d.length >= 7 && d.length <= 15;
  }

  // From the Home Screen app, whatsapp:// opens WhatsApp itself; in a browser tab, wa.me does (and works on a computer too).
  function whatsappUrl(phone, text, homeScreenApp) {
    const d = phoneDigits(phone);
    const t = encodeURIComponent(text);
    if (homeScreenApp) return `whatsapp://send?${d ? "phone=" + d + "&" : ""}text=${t}`;
    return `https://wa.me/${d}?text=${t}`;
  }

  const api = { build, canRemind, owedByCurrency, phoneDigits, phoneOk, whatsappUrl, money, MAX_ITEMS };
  if (node) module.exports = api;
  else root.LoanReminder = api;
})(typeof window !== "undefined" ? window : this);
