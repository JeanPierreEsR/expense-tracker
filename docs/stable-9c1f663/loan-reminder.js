// "Remind on WhatsApp" message (pure functions, no screen code) — used by the person's loan screen in app.js and tested
// directly in tests/backend/loan-reminder.test.js. specs/loans.md § Reminders.
//
// Only what the friend owes the owner is mentioned, per currency, never converted (CLAUDE.md principle 5). A currency where
// the owner owes MORE than the friend does is left out entirely; where the owner owes a part, the total is the net and the
// message says it already takes that off. The newest debts are listed first, at most MAX_ITEMS of them. The message can be
// written in either language whatever the app's own, and from the person's own template (specs/loans.md § Reminders).
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

  const LANGS = ["en", "es"];
  const TAGS = ["name", "list", "amount"];

  // Runs fn with the texts and dates of `lang` (the message may be in another language than the app), then puts the app's back.
  function inLang(lang, fn) {
    const I = i18n();
    const before = I.getLang();
    if (!lang || LANGS.indexOf(lang) === -1 || lang === before) return fn();
    I.setLang(lang);
    try { return fn(); } finally { I.setLang(before); }
  }

  // The app's own wording, with {name}, {list} and {amount} where the friend's details go.
  function defaultTemplate(lang) {
    return inLang(lang, () => tr("remind.tpl.default"));
  }

  // Stored form ({list}) ↔ what the person reads and edits ([List] / [Lista]). Either language's tag is understood when saving.
  function toEditable(template, lang) {
    return inLang(lang, () => String(template).replace(/\{(name|list|amount)\}/g, (w, k) => "[" + tr("remind.tag." + k) + "]"));
  }
  function fromEditable(text) {
    let out = String(text || "").replace(/\r\n?/g, "\n").trim();
    TAGS.forEach((k) => LANGS.forEach((l) => {
      const label = inLang(l, () => tr("remind.tag." + k));
      out = out.replace(new RegExp("\\[\\s*" + label + "\\s*\\]", "gi"), "{" + k + "}");
    }));
    return out;
  }
  function tagLabel(k, lang) { return "[" + inLang(lang, () => tr("remind.tag." + k)) + "]"; }

  // { name, loans (getFriendLoanDetail rows), today: "yyyy-MM-dd", lang?, template? } → the message text, in `lang` (the app's
  // language when not given), from the person's own template when there is one (stored form, see fromEditable).
  function build({ name, loans, today, lang, template }) {
    return inLang(lang, () => {
      const owed = owedByCurrency(loans);
      const currencies = Object.keys(owed).sort();
      if (!currencies.length) return "";
      const items = loans
        .filter((l) => isOpen(l) && l.direction === "they_owe_me" && owed[l.currency])
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const lines = [];
      items.slice(0, MAX_ITEMS).forEach((l) => {
        const desc = String(l.description || "").trim() || tr(l.origin === "entry" ? "remind.msg.sharedExpense" : "remind.msg.loan");
        const date = itemDate(l.date, today);
        lines.push(tr("remind.msg.item", { desc: date ? `${desc} (${date})` : desc, amount: money(l.remaining, l.currency) }));
      });
      if (items.length > MAX_ITEMS) lines.push(tr("remind.msg.more", { n: items.length - MAX_ITEMS }));
      const amounts = currencies.map((cur) => money(owed[cur].net, cur));
      let amount = amounts.length > 1 ? amounts.slice(0, -1).join(", ") + tr("remind.msg.and") + amounts[amounts.length - 1] : amounts[0];
      if (currencies.some((cur) => owed[cur].mine > 0.004)) amount += tr("remind.msg.afterMine");
      const values = { name: firstName(name), list: lines.join("\n"), amount };
      const tpl = String(template || "").trim() || tr("remind.tpl.default");
      return tpl.replace(/\{(name|list|amount)\}/g, (w, k) => values[k]);
    });
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

  const api = { build, defaultTemplate, toEditable, fromEditable, tagLabel, LANGS, canRemind, owedByCurrency, phoneDigits, phoneOk, whatsappUrl, money, MAX_ITEMS };
  if (node) module.exports = api;
  else root.LoanReminder = api;
})(typeof window !== "undefined" ? window : this);
