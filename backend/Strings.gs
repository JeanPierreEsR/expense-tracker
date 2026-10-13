/**
 * Spanish + English for everything the SERVER says to the person (see
 * specs/language.md). Two parts:
 *
 *  1. BACKEND_STRINGS_ — texts for errors, labels and generated descriptions,
 *     one entry per text with both languages side by side, looked up with
 *     tr_('area.name', { param: value }). tests/backend/server-language.test.js
 *     fails the deploy if a text lacks a language or its {placeholders} differ.
 *  2. CATEGORY_TRANSLATIONS_ — Spanish names for the built-in categories. A
 *     built-in category carries a hidden internal `key` (e.g. 'groceries') in
 *     the Categories sheet and keeps its ENGLISH name stored there forever; the
 *     translation is applied only when the name is shown (categoryLabel_).
 *     A category the owner created, or renamed, shows exactly as typed.
 *
 * Which language: the app sends its own on every request (REQUEST_LANG_);
 * work with no request behind it (Telegram, scheduled scans) uses the
 * `language` row of the Settings sheet; otherwise English.
 */

var SUPPORTED_LANGS_ = ['en', 'es'];
var REQUEST_LANG_ = null;   // set by doPost for the duration of one request

// Server texts — edit by hand: one entry per text, en and es side by side.
var BACKEND_STRINGS_ = {
  // ---- err ----
  "err.pickFriend": { en: "Pick a friend.", es: "Elige un amigo." },
  "err.invalidDirection": { en: "Invalid direction.", es: "Dirección no válida." },
  "err.validAmount": { en: "Enter a valid amount.", es: "Ingresa un monto válido." },
  "err.dateRequired": { en: "Date is required.", es: "La fecha es obligatoria." },
  "err.pickCategory": { en: "Pick a category.", es: "Elige una categoría." },
  "err.entryNotFound": { en: "Entry not found", es: "No se encontró el movimiento" },
  "err.loanNotFound": { en: "Loan not found", es: "No se encontró el préstamo" },
  "err.repaymentNotFound": { en: "Repayment not found", es: "No se encontró el repago" },
  "err.friendNotFound": { en: "Friend not found", es: "No se encontró al amigo" },
  "err.paymentMethodNotFound": { en: "Payment method not found", es: "No se encontró el medio de pago" },
  "err.budgetNotFound": { en: "Budget not found", es: "No se encontró el presupuesto" },
  "err.recurringNotFound": { en: "Recurring expense not found", es: "No se encontró el movimiento programado" },
  "err.recurringItemNotFound": { en: "Recurring item not found", es: "No se encontró el movimiento programado" },
  "err.currencyCode": { en: "Currency must be a 3-letter code.", es: "La moneda debe ser un código de 3 letras." },
  "err.monthFormat": { en: "Month must look like 2026-09.", es: "El mes debe verse así: 2026-09." },
  "err.rateGreater": { en: "The exchange rate must be a number greater than 0.", es: "El tipo de cambio debe ser un número mayor que 0." },
  "err.enterName": { en: "Enter a name.", es: "Ingresa un nombre." },
  "err.pickCategoryFirst": { en: "Pick a category first.", es: "Primero elige una categoría." },
  "err.pickPlatformFirst": { en: "Pick the platform first.", es: "Primero elige la plataforma." },

  // ---- loan ----
  "loan.missingFriend": { en: "Missing friend.", es: "Falta el amigo." },
  "loan.fromSharedEdit": { en: "This loan came from a shared expense — edit that entry instead.", es: "Este préstamo viene de un gasto compartido: edita ese movimiento." },
  "loan.repaymentLocked": { en: "This loan already has a repayment recorded — you can't change its friend, direction or currency.", es: "Este préstamo ya tiene un repago registrado: no puedes cambiar su amigo, dirección ni moneda." },
  "loan.fromSharedDelete": { en: "This loan came from a shared expense — delete that entry instead.", es: "Este préstamo viene de un gasto compartido: elimina ese movimiento." },
  "loan.noDeleteWithRepayment": { en: "This loan has a repayment recorded against it and can't be deleted.", es: "Este préstamo tiene un repago registrado y no se puede eliminar." },
  "loan.entryIsMovement": { en: "This entry is the money movement of a loan — delete or edit that loan from the Loans tab instead.", es: "Este movimiento es el traspaso de dinero de un préstamo: elimina o edita ese préstamo desde la pestaña Préstamos." },
  "loan.splitTooLarge": { en: "The split ({split}) is larger than the expense ({amount}).", es: "La división ({split}) es mayor que el gasto ({amount})." },
  "loan.amountBelowSettled": { en: "This loan already has {settled} in repayments — the amount can't be lower than that.", es: "Este préstamo ya tiene {settled} en repagos: el monto no puede ser menor." },

  // ---- convert ----
  "convert.gone": { en: "That entry no longer exists — it may already have been converted.", es: "Ese movimiento ya no existe: puede que ya se haya convertido." },
  "convert.pickExtraCategory": { en: "Pick a category for any extra amount.", es: "Elige una categoría para cualquier excedente." },
  "convert.alreadyMovement": { en: "This transfer is already the money movement of a loan or repayment — change it from the Loans tab instead.", es: "Esta transferencia ya es el traspaso de dinero de un préstamo o repago: cámbiala desde la pestaña Préstamos." },
  "convert.debtHasRepayments": { en: "The debt this expense created already has repayments recorded against it — sort those out from the Loans tab first.", es: "La deuda que creó este gasto ya tiene repagos registrados: resuélvelos primero desde la pestaña Préstamos." },
  "convert.onlyLoan": { en: "Only an expense or a transfer can be turned into a loan.", es: "Solo un gasto o una transferencia se puede convertir en un préstamo." },
  "convert.onlyRepayment": { en: "Only an expense or a transfer can be turned into a repayment.", es: "Solo un gasto o una transferencia se puede convertir en un repago." },
  "convert.undoFailed": { en: "Something went wrong AND putting the original back failed — entry \"{what}\" ({date}, {amount}) needs re-entering. {error}", es: "Algo salió mal Y no se pudo restaurar el original: el movimiento \"{what}\" ({date}, {amount}) hay que volver a ingresarlo. {error}" },
  "convert.nothingChanged": { en: "Nothing was changed — {error}", es: "No se cambió nada: {error}" },

  // ---- forgive ----
  "forgive.already": { en: "This loan is already forgiven.", es: "Este préstamo ya está perdonado." },

  // ---- repay ----
  "repay.autoOffsetEdit": { en: "That was an automatic offset from a repayment, not a real payment — it can't be edited directly.", es: "Eso fue una compensación automática de un repago, no un pago real: no se puede editar directamente." },
  "repay.autoOffsetDelete": { en: "That was an automatic offset from a repayment, not a real payment — it can't be deleted directly.", es: "Eso fue una compensación automática de un repago, no un pago real: no se puede eliminar directamente." },
  "repay.moreThanRemaining": { en: "That's more than the remaining balance ({cur} {amount}).", es: "Eso es más que el saldo restante ({cur} {amount})." },
  "repay.noLoanFromYou": { en: "{friend} has no {cur} loan from you on record, so there is nothing for this to repay. Add the loan first (Loans tab), or use \"Convert to loan\" if they lent you this money.", es: "{friend} no tiene un préstamo tuyo en {cur} registrado, así que no hay nada que repagar. Agrega primero el préstamo (pestaña Préstamos), o usa \"Convertir en préstamo\" si te prestaron este dinero." },
  "repay.noDebt": { en: "You have no {cur} debt to {friend} on record, so there is nothing for this to repay.", es: "No tienes una deuda en {cur} con {friend} registrada, así que no hay nada que repagar." },

  // ---- budget ----
  "budget.amountGreater": { en: "The budget amount must be a number greater than 0.", es: "El monto del presupuesto debe ser un número mayor que 0." },
  "budget.thresholds": { en: "Alert thresholds must be positive numbers separated by commas, like 75,100 — \"{value}\" is not valid.", es: "Los umbrales de aviso deben ser números positivos separados por comas, como 75,100: \"{value}\" no es válido." },
  "budget.monthly": { en: "monthly", es: "mensual" },
  "budget.yearly": { en: "yearly", es: "anual" },
  "budget.allExpenseLower": { en: "all expense categories", es: "todas las categorías de gasto" },
  "budget.thisCategory": { en: "this category", es: "esta categoría" },
  "budget.duplicate": { en: "You already have a {period} budget for exactly {what}. Edit that one instead, or pick a different timeframe or set of categories.", es: "Ya tienes un presupuesto {period} exactamente para {what}. Edita ese, o elige otro periodo u otro conjunto de categorías." },
  "budget.allExpense": { en: "All expense categories", es: "Todas las categorías de gasto" },
  "budget.overlap": { en: "\"{a}\" and \"{b}\" both include {names} — total may overstate your real ceiling.", es: "\"{a}\" y \"{b}\" incluyen {names}: el total puede sobrestimar tu tope real." },

  // ---- inbox ----
  "inbox.notThere": { en: "That statement is not in the inbox", es: "Ese estado de cuenta no está en la bandeja" },
  "inbox.attachmentGone": { en: "The attachment is no longer in that email", es: "El adjunto ya no está en ese correo" },

  // ---- rec ----
  "rec.startDate": { en: "The start date must be a real date (YYYY-MM-DD).", es: "La fecha de inicio debe ser una fecha real (AAAA-MM-DD)." },
  "rec.endDate": { en: "The end date must be a real date (YYYY-MM-DD).", es: "La fecha de fin debe ser una fecha real (AAAA-MM-DD)." },
  "rec.endBeforeStart": { en: "The end date is before the start date.", es: "La fecha de fin es anterior a la de inicio." },

  // ---- bill ----
  "bill.format": { en: "That bill is not in a format this app can store.", es: "Esa cuenta no tiene un formato que esta app pueda guardar." },
  "bill.onlyExpense": { en: "Only an expense can have a bill.", es: "Solo un gasto puede tener una cuenta." },
  "bill.tooLarge": { en: "That bill is too large to store.", es: "Esa cuenta es demasiado grande para guardarla." },

  // ---- export ----
  "export.chooseOne": { en: "Choose at least one file to send.", es: "Elige al menos un archivo para enviar." },
  "export.quota": { en: "Google's daily email limit has been reached. Try again tomorrow.", es: "Se alcanzó el límite diario de correos de Google. Inténtalo de nuevo mañana." },
  "export.noEmail": { en: "No export email address is set up yet.", es: "Aún no hay un correo configurado para las exportaciones." },
  "export.badEmail": { en: "That does not look like an email address.", es: "Eso no parece una dirección de correo." },
  "export.dateFormat": { en: "Dates must look like 2026-01-31.", es: "Las fechas deben verse así: 2026-01-31." },
  "export.dateOrder": { en: "The start date is after the end date.", es: "La fecha de inicio es posterior a la fecha de fin." },
  "export.tooLarge": { en: "The export is too large to email ({mb} MB). Try a shorter date range, or send only one file.", es: "La exportación es demasiado grande para enviarla por correo ({mb} MB). Prueba con un rango de fechas más corto o envía solo un archivo." },

  // ---- sa ----
  "sa.laterNotWaiting": { en: "That earlier statement line is no longer waiting", es: "Esa línea de un estado de cuenta anterior ya no está en espera" },
  "sa.unknownLine": { en: "Unknown statement line", es: "Línea de estado de cuenta desconocida" },
  "sa.twoActions": { en: "A statement line was given two actions", es: "A una línea del estado de cuenta se le dieron dos acciones" },
  "sa.notSameTransfer": { en: "The two lines are not the same transfer (opposite signs, same amount and currency)", es: "Las dos líneas no son la misma transferencia (signos opuestos, mismo monto y moneda)" },
  "sa.catMissingBetween": { en: "Category \"Between Accounts\" is missing", es: "Falta la categoría \"Entre cuentas\"" },
  "sa.feeOut": { en: "A fee must be money going out", es: "Una comisión debe ser dinero que sale" },
  "sa.catMissingFees": { en: "Category \"Bank fees\" is missing", es: "Falta la categoría \"Comisiones bancarias\"" },
  "sa.purchaseOut": { en: "A purchase must be money going out", es: "Una compra debe ser dinero que sale" },
  "sa.unknownExpenseCat": { en: "Unknown expense category", es: "Categoría de gasto desconocida" },
  "sa.incomeIn": { en: "Income must be money coming in", es: "Un ingreso debe ser dinero que entra" },
  "sa.unknownIncomeCat": { en: "Unknown income category", es: "Categoría de ingreso desconocida" },
  "sa.reversalIn": { en: "A reversal must be money coming back", es: "Una reversión debe ser dinero que vuelve" },
  "sa.chargeNotFound": { en: "The charge to cancel was not found", es: "No se encontró el cargo a cancelar" },
  "sa.onlyExpenseCancel": { en: "Only an expense can be cancelled by a reversal", es: "Solo un gasto se puede cancelar con una reversión" },
  "sa.reversalMismatch": { en: "The reversal and the charge are not the same amount and currency", es: "La reversión y el cargo no tienen el mismo monto y moneda" },
  "sa.notTransfer": { en: "Not a transfer", es: "No es una transferencia" },
  "sa.endFilled": { en: "That end of the transfer is already filled in", es: "Ese extremo de la transferencia ya está completo" },
  "sa.unknownBalance": { en: "Unknown statement or account for the balance", es: "Estado de cuenta o cuenta desconocidos para el saldo" },
  "sa.unverifiedBalance": { en: "A statement that could not be verified cannot set a balance", es: "Un estado de cuenta que no se pudo verificar no puede fijar un saldo" },
  "sa.noEnd": { en: "This statement has no end date", es: "Este estado de cuenta no tiene fecha de fin" },
  "sa.entryNotFound": { en: "Entry not found: {id}", es: "No se encontró el movimiento: {id}" },
  "sa.noAccount": { en: "No account is set up for statement {key}", es: "No hay una cuenta configurada para el estado de cuenta {key}" },
  "sa.noClosing": { en: "This statement has no closing balance in {cur}", es: "Este estado de cuenta no tiene saldo final en {cur}" },
  "sa.balanceNotOlder": { en: "The balance registered on {date} is not older than this statement, so it stays", es: "El saldo registrado el {date} no es más antiguo que este estado de cuenta, así que se mantiene" },
  "sa.unknownAction": { en: "Unknown action: {type}", es: "Acción desconocida: {type}" },

  // ---- bal ----
  "bal.listedOnce": { en: "Each currency can only be listed once ({cur}).", es: "Cada moneda solo puede aparecer una vez ({cur})." },
  "bal.validBalance": { en: "Enter a valid balance for {cur}.", es: "Ingresa un saldo válido para {cur}." },
  "bal.pickFromDate": { en: "Pick a from-date for {cur}.", es: "Elige la fecha desde la que cuenta {cur}." },

  // ---- label ----
  "label.unknownFriend": { en: "(unknown friend)", es: "(amigo desconocido)" },
  "label.unknownCategory": { en: "(unknown category)", es: "(categoría desconocida)" },
  "label.sharedExpense": { en: "Shared expense", es: "Gasto compartido" },
  "label.loan": { en: "Loan", es: "Préstamo" },
  "label.friendFallback": { en: "a friend", es: "un amigo" },

  // ---- desc ----
  "desc.loanTo": { en: "Loan to {name}", es: "Préstamo a {name}" },
  "desc.loanFrom": { en: "Loan from {name}", es: "Préstamo de {name}" },
  "desc.repaymentFrom": { en: "Repayment from {name}", es: "Repago de {name}" },
  "desc.repaymentTo": { en: "Repayment to {name}", es: "Repago a {name}" },
  "desc.overpaymentFrom": { en: "Overpayment from {name}'s loan repayment", es: "Pago de más de {name} en el repago de su préstamo" },
  "desc.overpaymentTo": { en: "Overpayment to {name}'s loan repayment", es: "Pago de más a {name} en el repago de su préstamo" },
  "desc.forgave": { en: "Forgave {name}'s debt", es: "Perdoné la deuda de {name}" },
  "desc.forgaveMe": { en: "{name} forgave a debt I owed them", es: "{name} me perdonó una deuda" },
  "desc.transfer": { en: "Transfer {from} → {to}", es: "Transferencia {from} → {to}" },
  "desc.reversal": { en: "Reversal: {text}", es: "Reversión: {text}" },

  // ---- report ----
  "report.uncategorized": { en: "Uncategorized", es: "Sin categoría" },
  "report.untagged": { en: "Untagged", es: "Sin etiqueta" },
  "report.otherMethod": { en: "Other", es: "Otros" },

  // ---- guess ----
  "guess.history": { en: "{n} of {total} past \"{merchant}\" entries", es: "{n} de {total} movimientos pasados de \"{merchant}\"" },
  "guess.programmed": { en: "matches programmed \"{name}\"", es: "coincide con el programado \"{name}\"" },
  "guess.interest": { en: "interest earned", es: "intereses ganados" },

  // ---- sb ----
  "sb.untracked": { en: "No balance is registered for this account yet — this statement can start it.", es: "Aún no hay un saldo registrado para esta cuenta: este estado de cuenta puede iniciarlo." },
  "sb.noCurrency": { en: "No balance is registered in {cur} for this account yet.", es: "Aún no hay un saldo registrado en {cur} para esta cuenta." },
  "sb.newer": { en: "This statement is newer than the balance registered on {date}.", es: "Este estado de cuenta es más reciente que el saldo registrado el {date}." },
  "sb.sameDay": { en: "Your balance registered on {date} is for the same day, so it stays.", es: "Tu saldo registrado el {date} es del mismo día, así que se mantiene." },
  "sb.older": { en: "Your balance registered on {date} is newer than this statement, so it stays.", es: "Tu saldo registrado el {date} es más reciente que este estado de cuenta, así que se mantiene." },

  // ---- auth ----
  "auth.invalidCode": { en: "Invalid access code", es: "Código de acceso no válido" },
  "auth.wrongCode": { en: "Wrong access code.", es: "Código de acceso incorrecto." },
  "auth.locked": { en: { one: "Too many wrong codes. Try again in {n} minute.", other: "Too many wrong codes. Try again in {n} minutes." }, es: { one: "Demasiados códigos incorrectos. Inténtalo de nuevo en {n} minuto.", other: "Demasiados códigos incorrectos. Inténtalo de nuevo en {n} minutos." } }
};

// Built-in categories: key -> { en: stored name, es: shown name }. Names that
// are the same in both languages (acronyms, proper names) need no entry.
var CATEGORY_TRANSLATIONS_ = {
  annual_budget: { en: 'Annual budget', es: 'Presupuesto anual' },
  car: { en: 'Car', es: 'Auto' },
  travel: { en: 'Travel', es: 'Viajes' },
  food_drink: { en: 'Food & Drink', es: 'Comida y bebida' },
  family_personal: { en: 'Family & Personal', es: 'Familia y personal' },
  entertainment: { en: 'Entertainment', es: 'Entretenimiento' },
  home: { en: 'Home', es: 'Hogar' },
  shopping: { en: 'Shopping', es: 'Compras' },
  healthcare: { en: 'Healthcare', es: 'Salud' },
  other: { en: 'Other', es: 'Otros' },
  transport: { en: 'Transport', es: 'Transporte' },
  groceries: { en: 'Groceries', es: 'Supermercado' },
  education: { en: 'Education', es: 'Educación' },
  gifts: { en: 'Gifts', es: 'Regalos' },
  work: { en: 'Work', es: 'Trabajo' },
  party: { en: 'Party', es: 'Fiestas' },
  mobile_phone: { en: 'Mobile Phone', es: 'Celular' },
  donations: { en: 'Donations', es: 'Donaciones' },
  credit_card: { en: 'Credit card', es: 'Tarjeta de crédito' },
  gym: { en: 'Gym', es: 'Gimnasio' },
  psychologist: { en: 'Psychologist', es: 'Psicólogo' },
  ai: { en: 'AI', es: 'IA' },
  sports: { en: 'Sports', es: 'Deporte' },
  bank_fees: { en: 'Bank fees', es: 'Comisiones bancarias' },
  business: { en: 'Business', es: 'Negocio' },
  salary: { en: 'Salary', es: 'Sueldo' },
  insurance_payout: { en: 'Insurance Payout', es: 'Pago de seguro' },
  parental_leave: { en: 'Parental Leave', es: 'Licencia parental' },
  extra_income: { en: 'Extra Income', es: 'Ingreso extra' },
  savings_return: { en: 'Savings return', es: 'Retorno de ahorros' },
  sales: { en: 'Sales', es: 'Ventas' },
  refunds: { en: 'Refunds', es: 'Reembolsos' },
  contribution: { en: 'Contribution', es: 'Aporte' },
  withdrawal: { en: 'Withdrawal', es: 'Retiro' },
  between_accounts: { en: 'Between Accounts', es: 'Entre cuentas' },
  investments: { en: 'Investments', es: 'Inversiones' },
  investment_returns: { en: 'Investment returns', es: 'Rendimiento de inversiones' },
  // Kept only so the one-off cleanup can recognise them (they are removed from
  // the starter list and retired from the owner's sheet).
  savings: { en: 'Savings', es: 'Ahorros' },
  loan: { en: 'Loan', es: 'Préstamo' }
};

function normalizeLang_(value) {
  var lang = String(value || '').toLowerCase();
  return SUPPORTED_LANGS_.indexOf(lang) >= 0 ? lang : null;
}

// The language the current work should speak.
function currentLang_() {
  if (REQUEST_LANG_) return REQUEST_LANG_;
  var saved = null;
  try { saved = normalizeLang_(getSettingsMap().language); } catch (err) { /* sheet unreadable: default */ }
  return saved || 'en';
}

// tr_('area.name', { n: 3 }) — a text with { one, other } forms picks "one"
// when params.n is exactly 1. A missing text shows its key (and is logged).
function tr_(key, params, langOverride) {
  var lang = langOverride || currentLang_();
  var entry = BACKEND_STRINGS_[key];
  var value = entry ? (entry[lang] !== undefined ? entry[lang] : entry.en) : undefined;
  if (value === undefined) {
    Logger.log('Missing server text: ' + key);
    return key;
  }
  if (value && typeof value === 'object') {
    value = params && Number(params.n) === 1 ? value.one : value.other;
  }
  if (!params) return value;
  return String(value).replace(/\{(\w+)\}/g, function (whole, name) {
    return params[name] !== undefined ? String(params[name]) : whole;
  });
}

// The internal key a built-in category gets from its English name:
// 'Food & Drink' -> 'food_drink'.
function categoryKeyFromName_(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// What to SHOW for a category row. Only a built-in (it has a key) that still
// carries its original English name is translated; anything else is shown as stored.
function categoryLabel_(cat, langOverride) {
  if (!cat) return '';
  var lang = langOverride || currentLang_();
  var t = cat.key ? CATEGORY_TRANSLATIONS_[cat.key] : null;
  if (t && lang !== 'en' && String(cat.name) === t.en && t[lang]) return t[lang];
  return cat.name;
}

// Both the stored name and its Spanish translation, so the search finds a
// category whichever language the person types (and the phone's saved search
// copy stays valid when the language is switched).
function categorySearchNames_(cat) {
  var t = cat.key ? CATEGORY_TRANSLATIONS_[cat.key] : null;
  if (t && String(cat.name) === t.en && t.es && t.es !== t.en) return cat.name + ' ' + t.es;
  return cat.name;
}

// A copy of the category rows with `name` as it should be shown. Used for what
// the app receives; the stored name never changes and logic keeps using it.
function localizeCategories_(rows, langOverride) {
  return rows.map(function (c) {
    var copy = {};
    Object.keys(c).forEach(function (k) { copy[k] = c[k]; });
    copy.name = categoryLabel_(c, langOverride);
    return copy;
  });
}

// ---- Settings (key/value rows) ----

// Sets (or adds) one Settings row. The Settings table is cached by the
// structure version, so it is bumped to make the change visible at once.
function setSetting_(key, value) {
  var sheet = getSheet('Settings');
  var headers = getHeaders(sheet);
  var keyCol = headers.indexOf('key') + 1;
  var valueCol = headers.indexOf('value') + 1;
  var lastRow = sheet.getLastRow();
  var keys = lastRow >= 2 ? sheet.getRange(2, keyCol, lastRow - 1, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) {
      sheet.getRange(i + 2, valueCol).setValue(value);
      if (ROWS_MEMO_) delete ROWS_MEMO_['Settings'];
      bumpStructureVersion_();
      return;
    }
  }
  appendRowObject('Settings', { key: key, value: value });
  bumpStructureVersion_();
}

// The app's language picker: remembered on the phone AND here, so the bot,
// alerts and e-mails (which have no phone) speak the same language.
function setLanguage(payload) {
  var lang = normalizeLang_(payload && payload.lang);
  if (!lang) throw new Error('Unsupported language');
  setSetting_('language', lang);
  return { language: lang };
}
