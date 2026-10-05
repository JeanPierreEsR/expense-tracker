const { createRuntime } = require("../harness/gas-runtime");
const { seedData } = require("../harness/seed");

// A fresh, fully seeded fake backend (~7,000 entries etc.) per call.
// `small` keeps individual scenario tests quick while still having real structure.
function freshApp(opts) {
  const rt = createRuntime();
  const data = seedData(rt, opts);
  return { rt, data };
}

const today = () => new Date().toISOString().slice(0, 10);

// Telegram: link a chat so the backend treats taps from it as the owner's.
function linkTelegram(rt, chatId = 555) {
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-bot-token");
  rt.svc.props.set("TELEGRAM_CHAT_ID", String(chatId));
  return chatId;
}

// A BCP debit-card purchase email in the shape the real parsing rule reads.
const BCP_SENDER = "notificaciones@notificacionesbcp.com.pe";
function bcpEmail(rt, { amount = "25.50", merchant = "Corner Cafe", op = "000111", daysAgo = 0, subject, threadWith } = {}) {
  const body = [
    "Total del consumo: S/ " + amount,
    "Empresa: " + merchant,
    "Número de Tarjeta de Débito: ****1234",
    op ? "Número de operación: " + op : ""
  ].join("\n");
  return rt.svc.gmail.addEmail({
    from: BCP_SENDER, subject: subject || "Realizaste un consumo con tu tarjeta de débito BCP", body, daysAgo, threadWith
  });
}

module.exports = { freshApp, today, linkTelegram, bcpEmail, BCP_SENDER };
