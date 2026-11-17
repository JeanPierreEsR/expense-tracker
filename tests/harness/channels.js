// The outside world of a test copy (2026-11-17, for the "journeys" runs): bank e-mails that arrive at a chosen moment, and the
// Telegram and WhatsApp bots as a chat. Everything goes through the REAL backend doors (Gmail search, doPost with a Telegram update
// or a relay-forwarded WhatsApp message); only Google's, Telegram's and Meta's own servers are imitated. Every value is made up.
const clock = require("./clock");

// ---------- Bank e-mails ----------
// One template per kind of e-mail the person's bank sends, in the shapes the real rules read (tests/rule-samples, email-parsing tests).
// The "unread" kinds are banks the app has no rule for yet (BBVA, Scotiabank): they land in "Bank emails I couldn't read".
const pad = (n, w) => String(n).padStart(w, "0");
const money = (cur, amt) => (cur === "USD" ? "US$ " : "S/ ") + Number(amt).toFixed(2);
const BANK_MAIL = {
  bcp_debit: { from: "notificaciones@notificacionesbcp.com.pe", subject: () => "Realizaste un consumo con tu Tarjeta de Débito BCP - Servicio de Notificaciones BCP",
    body: (t) => `Hola ${t.name || "Ana"},\nTotal del consumo                ${money(t.currency, t.amount)}\nEmpresa                 ${t.merchant}\nNúmero de Tarjeta de Débito          ************${t.last4}\nNúmero de operación          ${t.op}` },
  bcp_service: { from: "notificaciones@notificacionesbcp.com.pe", subject: () => "ENVIO AUTOMATICO - CONSTANCIA DE PAGO DE SERVICIO - BANCA MOVIL BCP",
    body: (t) => `Monto total     ${money(t.currency, t.amount)}\nEmpresa     ${t.merchant}\nServicio     ${t.service || "Recibo"}\nCuenta de origen     ****${t.last4}\nNúmero de operación     ${t.op}` },
  bcp_transfer: { from: "notificaciones@notificacionesbcp.com.pe", subject: () => "Constancia de transferencia a terceros",
    body: (t) => `Monto transferido    ${money(t.currency, t.amount)}\nEnviado a    ${t.merchant}\nDesde    ****${t.last4}\nNúmero de operación    ${t.op}` },
  yape_out: { from: "notificaciones@yape.pe", subject: () => "Constancia de yapeo",
    body: (t) => `Hola, acabas de yapear\nMonto de yapeo\n${money("PEN", t.amount)}\nNombre del Beneficiario\n${t.merchant}\nCódigo de operación ${t.op}` },
  interbank_purchase: { from: "servicioalcliente@netinterbank.com.pe", subject: () => "Realizaste un consumo con tu Tarjeta Interbank",
    body: (t) => `Hola ${t.name || "Ana"},\nComercio\n${t.merchant}\nMonto\n${money(t.currency, t.amount)}\nTarjeta\n**** ${t.last4}` },
  interbank_service: { from: "servicioalcliente@netinterbank.com.pe", subject: () => "Constancia de Pago",
    body: (t) => `Empresa\n${t.merchant}\nMoneda y monto\n${money(t.currency, t.amount)}\nCuenta cargo\nCuenta Simple Soles 000 000000${t.last4}\nCódigo de operación\n${t.op}` },
  interbank_recurring: { from: "servicioalcliente@netinterbank.com.pe", subject: (t) => `${t.name || "Ana"}, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa`,
    body: (t) => `${t.name || "Ana"}, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa\n\nConoce el detalle:\nTarjeta: ****${t.last4}\nComercio: ${t.merchant}\nMonto: ${money(t.currency, t.amount)}\nFecha: ${t.day || "01/01/2027"}\nHora: 09:15 AM\n\nSi no reconoces esta operación llámanos.` },
  diners_purchase: { from: "avisos@dinersenlinea.pe", subject: () => "Aviso de consumo",
    body: (t) => `Se realizó un consumo en el comercio ${t.merchant} por ${money(t.currency, t.amount)} con tu tarjeta.` },
  sip_purchase: { from: "no-reply@servicioalcliente.sip.pe", subject: () => "Realizaste un consumo con tu tarjeta SIP",
    body: (t) => `Monto ${money(t.currency, t.amount)}\nEstablecimiento ${t.merchant}\nTarjeta Titular ****${t.last4}` },
  // No rule yet: what a BBVA or Scotiabank customer gets.
  bbva_purchase: { from: "procesos@bbva.com.pe", subject: () => "Has realizado una compra con tu tarjeta BBVA",
    body: (t) => `Estimado cliente, se registró una compra por ${money(t.currency, t.amount)} en ${t.merchant} con tu tarjeta terminada en ${t.last4}.` },
  scotiabank_purchase: { from: "notificaciones@scotiabank.com.pe", subject: () => "Notificación de consumo",
    body: (t) => `Consumo realizado\nComercio: ${t.merchant}\nImporte: ${money(t.currency, t.amount)}\nTarjeta: ****${t.last4}` }
};
let opSeq = 100000;
function bankMail(t) {
  const kind = BANK_MAIL[t.kind];
  if (!kind) throw new Error("Unknown bank e-mail kind " + t.kind + " (known: " + Object.keys(BANK_MAIL).join(", ") + ")");
  const v = { currency: "PEN", last4: "1234", merchant: "TIENDA PRUEBA", op: pad(opSeq++, 6), ...t };
  return { from: kind.from, subject: kind.subject(v), body: kind.body(v) };
}

function attach(rt) {
  const chat = [];          // [{ at, bot, who: 'me'|'bot', text, buttons: [{ id, title }], id }]
  const mailQueue = [];     // e-mails waiting for their moment: [{ at, mail }]
  let tgUpdate = 1000, tgMsg = 5000, waMsg = 1;
  const TG_CHAT = "424242";

  // Outgoing calls of the real backend: Telegram's API and the WhatsApp relay's /send become lines of the chat; anything else
  // (the keep-warm ping, rate look-ups) gets a harmless answer.
  rt.state.fetchHandler = (url, options) => {
    const payload = (() => { try { return JSON.parse(options && options.payload || "{}"); } catch (e) { return {}; } })();
    if (/api\.telegram\.org\/bot[^/]+\/(\w+)/.test(url)) {
      const method = /\/(\w+)$/.exec(url)[1];
      if (method === "getUpdates") return { ok: true, result: [] };
      if (method === "sendMessage" || method === "sendPhoto") {
        const id = tgMsg++;
        const buttons = ((payload.reply_markup && payload.reply_markup.inline_keyboard) || []).flat().map((b) => ({ id: b.callback_data, title: b.text }));
        chat.push({ at: clock.now(), bot: "telegram", who: "bot", id, text: payload.text || payload.caption || "", buttons, replyTo: payload.reply_to_message_id || null });
        return { ok: true, result: { message_id: id } };
      }
      if (method === "editMessageReplyMarkup" || method === "editMessageText") {
        const line = chat.find((c) => c.bot === "telegram" && c.id === payload.message_id);
        if (line && method === "editMessageReplyMarkup") line.buttons = ((payload.reply_markup && payload.reply_markup.inline_keyboard) || []).flat().map((b) => ({ id: b.callback_data, title: b.text }));
        if (line && method === "editMessageText") line.text = payload.text;
        return { ok: true, result: true };
      }
      return { ok: true, result: true };
    }
    if (/\/send$/.test(url) && payload.message) {
      const m = payload.message, id = "wamid.fake" + waMsg++;
      let text = "", buttons = [];
      if (m.type === "text") text = m.text && m.text.body;
      else if (m.type === "interactive" && m.interactive) {
        text = (m.interactive.body && m.interactive.body.text) || "";
        if (m.interactive.action && m.interactive.action.buttons) buttons = m.interactive.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }));
        if (m.interactive.action && m.interactive.action.sections) buttons = m.interactive.action.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title + (r.description ? " · " + r.description : "") })));
      } else text = JSON.stringify(m).slice(0, 300);
      chat.push({ at: clock.now(), bot: "whatsapp", who: "bot", id, text, buttons, replyTo: m.context ? m.context.message_id : null });
      return { messages: [{ id }] };
    }
    return { ok: true, result: { message_id: 1 } };
  };

  // ---- Telegram ----
  // Makes the copy look like one whose bot was set up from the Sheet menu (a token saved); the person then links it in the chat
  // with "/start <access code>", as on a real phone.
  function telegramSetUp() { rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-token"); return { ok: true, chatId: TG_CHAT }; }
  function telegramSend({ text, tap, to }) {
    const update = { update_id: tgUpdate++ };
    if (tap) {
      const card = to ? chat.find((c) => c.bot === "telegram" && c.id === Number(to)) : [...chat].reverse().find((c) => c.bot === "telegram" && c.buttons.some((b) => b.id === tap || b.title === tap));
      if (!card) throw new Error("No Telegram message with a button " + tap);
      const b = card.buttons.find((x) => x.id === tap || x.title === tap);
      chat.push({ at: clock.now(), bot: "telegram", who: "me", text: "[tapped " + (b ? b.title : tap) + "]" });
      update.callback_query = { id: "cb" + update.update_id, data: b ? b.id : tap, message: { message_id: card.id, chat: { id: Number(TG_CHAT) }, text: card.text } };
    } else {
      const id = tgMsg++;
      chat.push({ at: clock.now(), bot: "telegram", who: "me", id, text });
      update.message = { message_id: id, date: Math.floor(clock.now() / 1000), chat: { id: Number(TG_CHAT), type: "private" }, from: { id: Number(TG_CHAT), first_name: "Test" }, text };
      if (to) update.message.reply_to_message = { message_id: Number(to), text: (chat.find((c) => c.id === Number(to)) || {}).text || "" };
    }
    return rt.rawPost(JSON.stringify(update));
  }

  // ---- WhatsApp ----
  // The person turns the bot on in the app (More → My profile → WhatsApp bot); here we only need the copy to be one the owner marked.
  function whatsappOffer() { rt.run("setSetting_('whatsapp_offered', 'yes')"); return { ok: true }; }
  function whatsappSend({ text, tap, to }) {
    const secret = rt.svc.props.get("WHATSAPP_RELAY_SECRET");
    const number = rt.svc.props.get("WA_OWNER_NUMBER") || "51900000000";
    const id = "wamid.me" + waMsg++;
    const msg = { from: number, id, timestamp: String(Math.floor(clock.now() / 1000)) };
    if (tap) {
      const card = to ? chat.find((c) => c.bot === "whatsapp" && c.id === to) : [...chat].reverse().find((c) => c.bot === "whatsapp" && c.buttons.some((b) => b.id === tap || b.title === tap));
      const b = card && card.buttons.find((x) => x.id === tap || x.title === tap);
      Object.assign(msg, { type: "interactive", reply_id: b ? b.id : tap, reply_title: b ? b.title : tap, context_id: card ? card.id : undefined });
      chat.push({ at: clock.now(), bot: "whatsapp", who: "me", id, text: "[tapped " + (b ? b.title : tap) + "]" });
    } else {
      Object.assign(msg, { type: "text", text, context_id: to || undefined });
      chat.push({ at: clock.now(), bot: "whatsapp", who: "me", id, text });
    }
    const out = rt.rawPost(JSON.stringify({ whatsapp: msg, relay_secret: secret }));
    // Like the relay (cloudflare-worker/whatsapp-relay.js): nothing more when the app answered on its own ("handled"), else the
    // short reply it wrote, else the relay's fallback sentence.
    if (!(out && out.ok && out.data && out.data.handled)) {
      const reply = (out && out.ok && out.data && out.data.reply) || (out && out.reply) || "(relay fallback: the app did not answer" + (out && out.error ? ": " + out.error : out && out.ok === false ? " — is the WhatsApp bot on in My profile?" : "") + ")";
      chat.push({ at: clock.now(), bot: "whatsapp", who: "bot", id: "wamid.reply" + waMsg++, text: reply, buttons: [] });
    }
    return out;
  }

  // ---- E-mail delivery at a moment ----
  function queueMail(items) {
    items.forEach((it) => {
      const mail = it.kind ? bankMail(it) : { from: it.from, to: it.to, subject: it.subject, body: it.body, attachments: it.attachments || [] };
      mailQueue.push({ at: it.at ? (typeof it.at === "number" ? it.at : clock.limaMs(it.at)) : clock.now(), mail });
    });
    mailQueue.sort((a, b) => a.at - b.at);
    return deliverDue();
  }
  // Puts every queued e-mail whose moment has come into the fake Gmail, dated at that moment.
  function deliverDue() {
    let n = 0;
    while (mailQueue.length && mailQueue[0].at <= clock.now()) {
      const { at, mail } = mailQueue.shift();
      rt.svc.gmail.addEmail({ ...mail, sentAt: at });
      n++;
    }
    return n;
  }

  return { chat, mailQueue, telegramSetUp, telegramSend, whatsappOffer, whatsappSend, queueMail, deliverDue, TG_CHAT };
}

module.exports = { attach, bankMail, BANK_MAIL };
