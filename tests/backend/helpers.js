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

module.exports = { freshApp, today, linkTelegram };
