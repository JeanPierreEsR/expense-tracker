// Company invitation (Business 2, piece 1; owner 2026-11-22): the owner's app makes a code from the Google account (e-mail) the
// company's person will install with, and an install link that carries it (setup/#company=<code>). The install page checks the code
// against the account that is signed in and, only when they match, builds the copy as a COMPANY COPY (Script Property COMPANY_COPY,
// read by backend/CompanyCopy.gs). Shared by the app (docs/app.js) and the install page (docs/setup/index.html), so both compute it the
// same way. Nothing is stored: the same e-mail always gives the same code. It is not a secret (the recipe is public): it only marks a
// copy for the company welcome, the way a WhatsApp invitation code only shows the bot's card.
(function (root) {
  const LETTERS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";   // no 0/O, 1/I/L: easy to read out and type
  const normEmail = (email) => String(email || "").trim().toLowerCase();
  const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(email));
  async function code(email) {
    const data = new TextEncoder().encode("expense-tracker-company-invite-v1:" + normEmail(email));
    const bytes = new Uint8Array(await root.crypto.subtle.digest("SHA-256", data));
    let out = "";
    for (let i = 0; i < 8; i++) out += LETTERS.charAt(bytes[i] % LETTERS.length);
    return "EM-" + out.slice(0, 4) + "-" + out.slice(4);
  }
  const clean = (c) => String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  async function matches(typed, email) { return looksLikeEmail(email) && clean(typed) === clean(await code(email)); }
  // The code a page address carries (#company=EM-XXXX-XXXX or ?company=…), or "".
  function fromAddress(loc) {
    const m = /[#&?]company=([A-Za-z0-9-]+)/.exec(String((loc && (loc.hash + loc.search)) || ""));
    return m ? m[1].toUpperCase() : "";
  }
  root.CompanyInvite = { code, matches, fromAddress, looksLikeEmail, normEmail };
})(typeof window !== "undefined" ? window : globalThis);
