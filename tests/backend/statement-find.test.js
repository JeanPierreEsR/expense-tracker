// "Find statements in Gmail" (StatementFind.gs): the on-demand search, putting ticked results in the inbox, and learning new banks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const find = (rt, months) => JSON.parse(JSON.stringify(rt.run(`findStatementEmails(${JSON.stringify({ months })})`)));
const add = (rt, items) => JSON.parse(JSON.stringify(rt.run(`addStatementsToInbox(${JSON.stringify({ items })})`)));

function mails(rt) {
  rt.svc.gmail.addEmail({ from: "BCP <notificaciones@notificacionesbcp.com.pe>", subject: "Tu estado de cuenta", body: "", daysAgo: 40, attachments: [{ name: "EECC_08.pdf" }] });
  rt.svc.gmail.addEmail({ from: "BCP <notificaciones@notificacionesbcp.com.pe>", subject: "Tu estado de cuenta", body: "", daysAgo: 300, attachments: [{ name: "EECC_11.pdf" }] });
  rt.svc.gmail.addEmail({ from: "Banco Nuevo <avisos@banconuevo.example>", subject: "Estado de cuenta de tu tarjeta", body: "", daysAgo: 60, attachments: [{ name: "ec_septiembre.pdf" }] });
  rt.svc.gmail.addEmail({ from: "Tienda <ofertas@tienda.example>", subject: "Mira nuestras ofertas", body: "", daysAgo: 10, attachments: [{ name: "catalogo.pdf" }] });
  rt.svc.gmail.addEmail({ from: "Boss <boss@work.example>", subject: "contrato", body: "", daysAgo: 20, attachments: [{ name: "contract.pdf" }] });
}

test("the search lists bank PDFs and statement-sounding PDFs from anyone, not other PDFs, newest first", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  const res = find(rt, 12);
  const names = res.items.map((i) => i.attachment_name);
  assert.deepEqual(names, ["EECC_08.pdf", "ec_septiembre.pdf", "EECC_11.pdf"]);
  assert.equal(res.items[0].known, true);
  assert.equal(res.items[0].bank, "BCP");
  assert.equal(res.items[1].known, false);
  assert.equal(res.items[1].sender, "avisos@banconuevo.example");
});

test("the period limits the search", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  assert.deepEqual(find(rt, 3).items.map((i) => i.attachment_name), ["EECC_08.pdf", "ec_septiembre.pdf"]);
});

test("adding picks puts them in the inbox once; a second add reuses the same rows", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  const items = find(rt, 12).items.map((i) => ({ message_id: i.message_id, attachment_name: i.attachment_name }));
  const first = add(rt, items);
  assert.equal(first.ids.length, 3);
  assert.equal(rt.rows("Statement Inbox").length, 3);
  const second = add(rt, items);
  assert.deepEqual(second.ids, first.ids);
  assert.equal(rt.rows("Statement Inbox").length, 3);
  const bcp = rt.rows("Statement Inbox").find((r) => r.attachment_name === "EECC_08.pdf");
  assert.equal(bcp.bank_keyword, "bcp");
  assert.equal(bcp.status, "new");
  assert.equal(first.senders[bcp.id], "notificaciones@notificacionesbcp.com.pe");
});

test("a pick that is not a statement attachment is refused, so this is not a general mail reader", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  const real = find(rt, 12).items[0];
  assert.equal(add(rt, [{ message_id: real.message_id, attachment_name: "not-in-that-mail.pdf" }]).ids.length, 0);
  assert.equal(add(rt, [{ message_id: real.message_id, attachment_name: "photo.png" }]).ids.length, 0);
  assert.equal(rt.rows("Statement Inbox").length, 0);
});

test("a statement read from an unknown bank teaches the app its sender; the scan then finds that bank's next statements", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  const pick = find(rt, 12).items.find((i) => i.sender === "avisos@banconuevo.example");
  const { ids } = add(rt, [pick]);
  assert.equal(JSON.parse(JSON.stringify(rt.run(`rememberStatementSender({ id: ${JSON.stringify(ids[0])} })`))).remembered, true);
  assert.equal(rt.rows("Statement Senders")[0].address, "avisos@banconuevo.example");
  // asking again adds nothing
  assert.equal(JSON.parse(JSON.stringify(rt.run(`rememberStatementSender({ id: ${JSON.stringify(ids[0])} })`))).remembered, false);
  assert.equal(rt.rows("Statement Senders").length, 1);
  // the next one is found by the 15-minute scan (an old row exists so it is not the silent first scan)
  rt.svc.gmail.addEmail({ from: "Banco Nuevo <avisos@banconuevo.example>", subject: "hola", body: "", daysAgo: 1, attachments: [{ name: "ec_octubre.pdf" }] });
  const res = JSON.parse(JSON.stringify(rt.run("scanStatementInbox_()")));
  assert.equal(res.found, 1);
  assert.equal(rt.rows("Statement Inbox").find((r) => r.attachment_name === "ec_octubre.pdf").sender_key, "avisos@banconuevo.example");
});

test("a bank that is already built in, a self-sent mail and a free-mail address are never learned", () => {
  const { rt } = freshApp({ entries: 20 });
  mails(rt);
  rt.svc.gmail.addEmail({ from: "Ana <ana@gmail.com>", subject: "estado de cuenta", body: "", daysAgo: 5, attachments: [{ name: "estado.pdf" }] });
  const items = find(rt, 12).items.map((i) => ({ message_id: i.message_id, attachment_name: i.attachment_name }));
  const { ids } = add(rt, items);
  ids.forEach((id) => rt.run(`rememberStatementSender({ id: ${JSON.stringify(id)} })`));
  assert.deepEqual(rt.rows("Statement Senders").map((r) => r.address), ["avisos@banconuevo.example"]);
});

test("statement senders count for the 'your bank is ready' check", () => {
  const { rt } = freshApp({ entries: 20 });
  const list = JSON.parse(JSON.stringify(rt.run("listSupportedSenders()")));
  assert.ok(list.some((s) => s.sender === "notificaciones@notificacionesbcp.com.pe"));
});

test("without the Gmail extra the search is refused", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run("PropertiesService.getScriptProperties().setProperty('FEATURES', 'base')");
  assert.throws(() => rt.run("findStatementEmails({ months: 12 })"), /not turned on/i);
});

test("the recent-uploads list shows 5 by default and more when the screen asks", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`ensureStatementUploadsSheet_(); appendRowsBulk_('Statement Uploads', ${JSON.stringify(
    Array.from({ length: 23 }, (_, i) => ({ id: "u" + i, source: "upload", batch_id: "b" + i, processed_at: "2026-01-" + String(i + 1).padStart(2, "0") + "T10:00:00", account_label: "Acct " + i, account_key: "k" + i }))
  )})`);
  const list = (payload) => JSON.parse(JSON.stringify(rt.run(`listStatementBatches(${JSON.stringify(payload)})`)));
  assert.equal(list(undefined).length, 5);
  assert.equal(list({ limit: 15 }).length, 15);
  assert.equal(list({ limit: 25 }).length, 23);
  assert.equal(list({ limit: 15 })[0].batchId, "b22");   // newest first
});
