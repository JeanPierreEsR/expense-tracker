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
// BEGIN GENERATED (scratch tooling; edit entries by hand from now on if the tool is gone)
var BACKEND_STRINGS_ = {
  // ---- err ----
  // ---- optional abilities (Features.gs) ----
  "feature.gmailOff": { en: "Reading your bank e-mails is not turned on for this app yet.", es: "La lectura de tus correos del banco aún no está activada en esta app." },
  "webAppUrl.missing": { en: "This app's web address is not saved yet. Open the app once on your phone, then try again.", es: "Aún no se guardó la dirección web de esta app. Abre la app una vez en tu teléfono y vuelve a intentarlo." },
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
  "err.projectionMethod": { en: "That projection method isn't available.", es: "Ese método de proyección no está disponible." },
  "err.categoryNotFound": { en: "Category not found", es: "No se encontró la categoría" },
  "err.recurringNotFound": { en: "Recurring item not found", es: "No se encontró el movimiento programado" },
  "err.recurringItemNotFound": { en: "Recurring item not found", es: "No se encontró el movimiento programado" },
  "err.currencyCode": { en: "Currency must be a 3-letter code.", es: "La moneda debe ser un código de 3 letras." },
  "err.monthFormat": { en: "Month must look like 2026-09.", es: "El mes debe verse así: 2026-09." },
  "err.rateGreater": { en: "The exchange rate must be a number greater than 0.", es: "El tipo de cambio debe ser un número mayor que 0." },
  "err.enterName": { en: "Enter a name.", es: "Ingresa un nombre." },
  "err.pmType": { en: "Pick a valid type.", es: "Elige un tipo válido." },
  "err.pmLast4": { en: "Last 4 digits must be exactly 4 numbers (or leave it blank).", es: "Los últimos 4 dígitos deben ser exactamente 4 números (o déjalo en blanco)." },
  "err.pmBank": { en: "That bank doesn't exist.", es: "Ese banco no existe." },
  "err.pmNameTaken": { en: "Another account already has that name.", es: "Ya hay otra cuenta con ese nombre." },
  "err.gapNotFound": { en: "Gap note not found.", es: "No se encontró la nota de diferencia." },
  "err.pmNotFound": { en: "Account not found.", es: "No se encontró la cuenta." },
  "err.pmInUse": { en: { one: "This account can't be deleted: {n} record uses it. Hide it instead — it disappears from the pickers but past records keep its name.", other: "This account can't be deleted: {n} records use it. Hide it instead — it disappears from the pickers but past records keep its name." }, es: { one: "No se puede eliminar esta cuenta: {n} registro la usa. Mejor ocúltala: desaparece de las listas pero los registros anteriores conservan su nombre.", other: "No se puede eliminar esta cuenta: {n} registros la usan. Mejor ocúltala: desaparece de las listas pero los registros anteriores conservan su nombre." } },
  "err.pmRailLinked": { en: "This account is linked to Yape or Plin. Change that link first (below), then delete it.", es: "Esta cuenta está vinculada a Yape o Plin. Cambia ese vínculo primero (abajo) y luego elimínala." },
  "err.pickCategoryFirst": { en: "Pick a category first.", es: "Primero elige una categoría." },
  "err.pickPlatformFirst": { en: "Pick the platform first.", es: "Primero elige la plataforma." },

  // ---- trips & events (Trips.gs) ----
  "trip.notFound": { en: "Trip or event not found", es: "No se encontró el viaje o evento" },
  "trip.errDates": { en: "Enter a start date and an end date (the end date can be the same day).", es: "Ingresa una fecha de inicio y una de fin (la de fin puede ser el mismo día)." },
  "trip.errEndBeforeStart": { en: "The end date can't be before the start date.", es: "La fecha de fin no puede ser anterior a la de inicio." },
  "trip.errBudget": { en: "The budget must be a number greater than 0 (or leave it blank).", es: "El presupuesto debe ser un número mayor que 0 (o déjalo en blanco)." },

  // ---- loan ----
  "loan.missingFriend": { en: "Missing friend.", es: "Falta el amigo." },
  "loan.fromSharedEdit": { en: "This loan came from a shared expense — edit that entry instead.", es: "Este préstamo viene de un gasto compartido: edita ese movimiento." },
  "loan.repaymentLocked": { en: "This loan already has a repayment recorded — you can't change its friend, direction or currency.", es: "Este préstamo ya tiene un repago registrado: no puedes cambiar su amigo, dirección ni moneda." },
  "loan.fromSharedDelete": { en: "This loan came from a shared expense — delete that entry instead.", es: "Este préstamo viene de un gasto compartido: elimina ese movimiento." },
  "loan.noDeleteWithRepayment": { en: "This loan has a repayment recorded against it and can't be deleted.", es: "Este préstamo tiene un repago registrado y no se puede eliminar." },
  "loan.entryIsMovement": { en: "This entry is the money movement of a loan — delete or edit that loan from the Loans tab instead.", es: "Este movimiento es el traspaso de dinero de un préstamo: elimina o edita ese préstamo desde la pestaña Préstamos." },
  "loan.splitTooLarge": { en: "The split ({split}) is larger than the expense ({amount}).", es: "La repartición ({split}) es mayor que el gasto ({amount})." },
  "loan.amountBelowSettled": { en: "This loan already has {settled} in repayments — the amount can't be lower than that.", es: "Este préstamo ya tiene {settled} en repagos: el monto no puede ser menor." },

  // ---- convert ----
  "convert.gone": { en: "That entry no longer exists — it may already have been converted.", es: "Ese movimiento ya no existe: puede que ya se haya convertido." },
  "convert.pickExtraCategory": { en: "Pick a category for any extra amount.", es: "Elige una categoría para cualquier excedente." },
  "convert.alreadyMovement": { en: "This transfer is already the money movement of a loan or repayment — change it from the Loans tab instead.", es: "Esta transferencia ya es el traspaso de dinero de un préstamo o repago: cámbiala desde la pestaña Préstamos." },
  "convert.debtHasRepayments": { en: "The debt this expense created already has repayments recorded against it — sort those out from the Loans tab first.", es: "La deuda que creó este gasto ya tiene repagos registrados: resuélvelos primero desde la pestaña Préstamos." },
  "convert.onlyLoan": { en: "Only an expense, an income or a transfer can be turned into a loan.", es: "Solo un gasto, un ingreso o una transferencia se puede convertir en un préstamo." },
  "convert.onlyRepayment": { en: "Only an expense, an income or a transfer can be turned into a repayment.", es: "Solo un gasto, un ingreso o una transferencia se puede convertir en un repago." },
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
  "budget.thresholds": { en: "Alert thresholds must be positive numbers separated by commas, like 75,100 — \"{value}\" is not valid.", es: "Los porcentajes de aviso deben ser números positivos separados por comas, como 75,100: \"{value}\" no es válido." },
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
  "rec.variableMonthlyOnly": { en: "Only a monthly item, or one with its own repeat interval (Other), can have a variable amount.", es: "Solo un movimiento mensual, o uno con su propio intervalo (Otra), puede tener monto variable." },
  "rec.customInterval": { en: "\"Repeats every\" must be a whole number from 1 to 999.", es: "\"Repite cada\" debe ser un número entero de 1 a 999." },
  "rec.customUnit": { en: "Pick days, weeks, months or years.", es: "Elige días, semanas, meses o años." },
  "rec.customNeedsStart": { en: "An item with its own repeat interval needs a start date: every following date is counted from it.", es: "Un movimiento con su propio intervalo necesita una fecha de inicio: desde ella se cuentan las siguientes." },
  "rec.variableNeedsWords": { en: "A variable-amount item needs at least one keyword (3+ letters) to recognise its payments, e.g. \"luz\".", es: "Un movimiento de monto variable necesita al menos una palabra clave (3 letras o más) para reconocer sus pagos, e.g. \"luz\"." },
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

  "export.subject": { en: "Expense Tracker export — {date}", es: "Exportación de Expense Tracker — {date}" },
  "export.body": { en: "Your export is attached.\n\n{files}", es: "Tu exportación va adjunta.\n\n{files}" },
  "export.line.entries": { en: { one: "{name} ({n} entry)", other: "{name} ({n} entries)" }, es: { one: "{name} ({n} movimiento)", other: "{name} ({n} movimientos)" } },
  "export.line.backup": { en: { one: "{name} ({n} row across all tabs)", other: "{name} ({n} rows across all tabs)" }, es: { one: "{name} ({n} fila en todas las hojas)", other: "{name} ({n} filas en todas las hojas)" } },
  "export.file.entries": { en: "entries_{label}.csv", es: "movimientos_{label}.csv" },
  "export.file.backup": { en: "backup_{date}.json", es: "respaldo_{date}.json" },
  "export.label.range": { en: "{start}_to_{end}", es: "{start}_a_{end}" },
  "export.label.start": { en: "start", es: "inicio" },
  "export.label.today": { en: "today", es: "hoy" },
  "export.label.all": { en: "all-time", es: "todo" },
  "export.backupNote": { en: "Raw rows of each data tab, exactly as stored (amounts stay in their original currency).", es: "Filas originales de cada hoja de datos, tal como están guardadas (los montos siguen en su moneda original)." },
  "export.h.id": { en: "ID", es: "ID" },
  "export.h.date": { en: "Date", es: "Fecha" },
  "export.h.type": { en: "Type", es: "Tipo" },
  "export.h.description": { en: "Description", es: "Descripción" },
  "export.h.merchant": { en: "Merchant", es: "Comercio" },
  "err.railYape": { en: "Yape only works with BCP accounts.", es: "Yape solo funciona con cuentas BCP." },
  "err.railPlin": { en: "Plin doesn't work with BCP accounts. Pick an account at another bank.", es: "Plin no funciona con cuentas BCP. Elige una cuenta de otro banco." },
  "err.tooManyAccounts": { en: "Too many accounts at once.", es: "Demasiadas cuentas a la vez." },
  "err.rateMain": { en: "The main currency has no rate of its own.", es: "La moneda principal no tiene un tipo de cambio propio." },
  "err.rateMainFirst": { en: "Set the main currency's exchange rate first (More → Exchange rates).", es: "Primero fija el tipo de cambio de la moneda principal (Más → Tipos de cambio)." },
  "err.rateNeeded": { en: "To switch the main currency to {next}, enter how many {next} one {old} is worth today.", es: "Para cambiar la moneda principal a {next}, indica cuántos {next} vale hoy un {old}." },
  "export.h.category": { en: "Category", es: "Categoría" },
  "export.h.amount": { en: "Amount", es: "Monto" },
  "export.h.currency": { en: "Currency", es: "Moneda" },
  "export.h.amountPen": { en: "Amount ({home})", es: "Monto ({home})" },
  "export.h.share": { en: "Your share", es: "Tu parte" },
  "export.h.sharePen": { en: "Your share ({home})", es: "Tu parte ({home})" },
  "export.h.splitWith": { en: "Shared with", es: "Compartido con" },
  "export.h.method": { en: "Payment method", es: "Medio de pago" },
  "export.h.toAccount": { en: "To account", es: "Hacia la cuenta" },
  "export.h.paidBy": { en: "Paid by", es: "Pagado por" },
  "export.h.friend": { en: "Linked friend", es: "Amigo vinculado" },
  "export.h.linkedAs": { en: "Linked as", es: "Vinculado como" },
  "export.h.tags": { en: "Tags", es: "Etiquetas" },
  "export.h.trip": { en: "Trip / event", es: "Viaje / evento" },
  "export.h.status": { en: "Status", es: "Estado" },
  "export.h.source": { en: "Source", es: "Origen" },
  "export.h.created": { en: "Created at", es: "Creado el" },
  "export.me": { en: "Me", es: "Yo" },
  "export.linked.repayment": { en: "Repayment", es: "Repago" },
  "export.linked.loan": { en: "Loan", es: "Préstamo" },
  "export.linked.theyOwe": { en: " (they owe me)", es: " (me debe)" },
  "export.linked.iOwe": { en: " (I owe them)", es: " (le debo)" },

  // ---- auth ----
  "perf.tabNearlyFull": { en: "📊 The \"Perf Reports\" tab in your Sheet holds {n} of at most {max} rows. Ask Claude to archive it before it fills up — once it is full, new app-speed reports are refused (phones keep them for a while).", es: "📊 La pestaña \"Perf Reports\" de tu hoja tiene {n} de un máximo de {max} filas. Pídele a Claude que la archive antes de que se llene: cuando se llena, los nuevos reportes de velocidad se rechazan (los teléfonos los guardan un tiempo)." },
  "auth.failedAttempts": { en: { one: "⚠️ {n} wrong access-code attempt in the last hour ({source}). If that was not you, someone may be guessing your code — check its strength with the sheet menu (item 22) and replace it if it is not long and random (item 23).", other: "⚠️ {n} wrong access-code attempts in the last hour ({source}). If that was not you, someone may be guessing your code — check its strength with the sheet menu (item 22) and replace it if it is not long and random (item 23)." }, es: { one: "⚠️ {n} intento con un código de acceso incorrecto en la última hora ({source}). Si no fuiste tú, alguien podría estar adivinando tu código: revisa su fortaleza con el menú de la hoja (opción 22) y cámbialo si no es largo y aleatorio (opción 23).", other: "⚠️ {n} intentos con un código de acceso incorrecto en la última hora ({source}). Si no fuiste tú, alguien podría estar adivinando tu código: revisa su fortaleza con el menú de la hoja (opción 22) y cámbialo si no es largo y aleatorio (opción 23)." } },

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
  "auth.locked": { en: { one: "Too many wrong codes. Try again in {n} minute.", other: "Too many wrong codes. Try again in {n} minutes." }, es: { one: "Demasiados códigos incorrectos. Inténtalo de nuevo en {n} minuto.", other: "Demasiados códigos incorrectos. Inténtalo de nuevo en {n} minutos." } },

  // ---- bot ----
  "bot.type.expense": { en: "expense", es: "gasto" },
  "bot.type.income": { en: "income", es: "ingreso" },
  "bot.type.investment": { en: "investment", es: "inversión" },
  "bot.type.transfer": { en: "transfer", es: "transferencia" },
  "bot.field.category": { en: "category", es: "categoría" },
  "bot.field.amount": { en: "amount", es: "monto" },
  "bot.field.description": { en: "description", es: "descripción" },
  "bot.field.paid_by": { en: "paid by", es: "pagado por" },
  "bot.field.currency": { en: "currency", es: "moneda" },
  "bot.field.date": { en: "date", es: "fecha" },
  "bot.field.split": { en: "split", es: "repartición" },
  "bot.field.payment_method": { en: "payment method", es: "medio de pago" },
  "bot.field.from": { en: "from", es: "desde" },
  "bot.field.to": { en: "to", es: "hacia" },
  "bot.field.received_at": { en: "received at", es: "recibido en" },
  "bot.field.label": { en: "tag", es: "etiqueta" },
  "bot.field.platform": { en: "platform", es: "plataforma" },
  "bot.field.direction": { en: "direction", es: "dirección" },
  "bot.field.type": { en: "type", es: "tipo" },
  "bot.status.pending": { en: "pending", es: "pendiente" },
  "bot.status.confirmed": { en: "confirmed", es: "confirmado" },
  "bot.me": { en: "Me", es: "Yo" },
  "bot.noDescription": { en: "(no description)", es: "(sin descripción)" },
  "bot.confirmedTag": { en: " ✅ Confirmed", es: " ✅ Confirmado" },
  "bot.needsCategory": { en: "needs category", es: "falta categoría" },
  "bot.autoTag": { en: " 🤖 auto ({reason})", es: " 🤖 auto ({reason})" },
  "bot.autoTagShort": { en: " 🤖 auto", es: " 🤖 auto" },
  "bot.fromLabel": { en: "⬆️ From: ", es: "⬆️ Desde: " },
  "bot.toLabel": { en: "⬇️ To: ", es: "⬇️ Hacia: " },
  "bot.notSetFrom": { en: "not set — reply \"from Plin\"", es: "sin definir: responde \"desde Plin\"" },
  "bot.notSetTo": { en: "not set — reply \"to Diners\"", es: "sin definir: responde \"hacia Diners\"" },
  "bot.notSetPlatform": { en: "not set — reply \"platform Hapi\"", es: "sin definir: responde \"plataforma Hapi\"" },
  "bot.notSetReceivedAt": { en: "not set — reply \"received at Interbank\"", es: "sin definir: responde \"recibido en Interbank\"" },
  "bot.notSetPaymentMethod": { en: "not set — reply \"payment method Interbank\"", es: "sin definir: responde \"medio de pago Interbank\"" },
  "bot.withdrawalLine": { en: "↩️ Withdrawal — money coming back from the platform", es: "↩️ Retiro: dinero que vuelve de la plataforma" },
  "bot.fromPlatform": { en: "📈 From platform: ", es: "📈 Desde la plataforma: " },
  "bot.receivedAt": { en: "⬇️ Received at: ", es: "⬇️ Recibido en: " },
  "bot.platformLabel": { en: "📈 Platform: ", es: "📈 Plataforma: " },
  "bot.receivedFrom": { en: "📥 Received from: ", es: "📥 Recibido de: " },
  "bot.notSetPayor": { en: "❓ not set — reply \"paid by Acme\"", es: "❓ sin definir: responde \"pagado por Acme\"" },
  "bot.paidBy": { en: "Paid by: ", es: "Pagado por: " },
  "bot.splitLabel": { en: "🔀 Split: ", es: "🔀 Repartición: " },
  "bot.you": { en: "you", es: "tú" },
  "bot.labelsLabel": { en: "🏷️ Tags: ", es: "🏷️ Etiquetas: " },
  "bot.duplicate": { en: "⚠️ Possible duplicate — same day, amount and merchant as {list}. Discard if it is a copy; confirm if it is a real repeat.", es: "⚠️ Posible duplicado: mismo día, monto y comercio que {list}. Descarta si es una copia; confirma si es una repetición real." },
  "bot.duplicateItem": { en: "\"{name}\" ({status})", es: "\"{name}\" ({status})" },
  "bot.anEntry": { en: "an entry", es: "un movimiento" },
  "bot.hintTransfer": { en: "Reply to edit — from, to, amount, description, currency, date, category, tag, or type. Reply \"help\" for examples.", es: "Responde para editar: desde, hacia, monto, descripción, moneda, fecha, categoría, etiqueta o tipo. Responde \"ayuda\" para ver ejemplos." },
  "bot.hintInvestment": { en: "Reply to edit — platform, withdrawal/deposit, payment method (received at, for a withdrawal), amount, description, currency, date, tag, or type. Reply \"help\" for examples.", es: "Responde para editar: plataforma, retiro/depósito, medio de pago (recibido en, si es un retiro), monto, descripción, moneda, fecha, etiqueta o tipo. Responde \"ayuda\" para ver ejemplos." },
  "bot.hintOther": { en: "Reply to edit — category, amount, description, paid by, payment method, currency, date, tag, split, or type. Reply \"help\" for examples.", es: "Responde para editar: categoría, monto, descripción, pagado por, medio de pago, moneda, fecha, etiqueta, repartir o tipo. Responde \"ayuda\" para ver ejemplos." },
  "bot.confirmButton": { en: "✅ Confirm", es: "✅ Confirmar" },
  "bot.discardButton": { en: "❌ Discard", es: "❌ Descartar" },
  "bot.alreadyConfirmed": { en: "ℹ️ Already confirmed.", es: "ℹ️ Ya estaba confirmado." },
  "bot.entryGone": { en: "ℹ️ This entry no longer exists.", es: "ℹ️ Este movimiento ya no existe." },
  "bot.needCategoryFirst": { en: "⚠️ Not confirmed — it needs a category first. Reply to the card with \"category groceries\" (or another category), then tap Confirm.", es: "⚠️ No se confirmó: primero necesita una categoría. Responde a la tarjeta con \"categoría supermercado\" (u otra categoría) y luego toca Confirmar." },
  "bot.needPlatformFirst": { en: "⚠️ Not confirmed — an investment needs its platform first. Reply to the card with \"platform Hapi\" (or another platform), then tap Confirm.", es: "⚠️ No se confirmó: una inversión necesita primero su plataforma. Responde a la tarjeta con \"plataforma Hapi\" (u otra plataforma) y luego toca Confirmar." },
  "bot.confirmed": { en: "✅ Confirmed.", es: "✅ Confirmado." },
  "bot.alreadyConfirmedDelete": { en: "ℹ️ Already confirmed — delete it from the app if you really want it gone.", es: "ℹ️ Ya estaba confirmado: elimínalo desde la app si de verdad quieres borrarlo." },
  "bot.discarded": { en: "🗑️ Discarded.", es: "🗑️ Descartado." },
  "bot.notDiscarded": { en: "⚠️ Not discarded — {error}", es: "⚠️ No se descartó: {error}" },
  "bot.alreadyLinked": { en: "This bot is already linked to another chat. To move it, re-run 'Set Telegram bot token' from the spreadsheet menu first.", es: "Este bot ya está vinculado a otro chat. Para moverlo, vuelve a ejecutar 'Set Telegram bot token' desde el menú de la hoja." },
  "bot.codeNotRecognized": { en: "That code wasn't recognized.", es: "No se reconoció ese código." },
  "bot.linked": { en: "✅ Linked! I'll send you entries to review here.", es: "✅ ¡Vinculado! Aquí te enviaré los movimientos por revisar." },
  "bot.replyToACard": { en: "Reply directly to an entry message to edit it.", es: "Responde directamente al mensaje de un movimiento para editarlo." },
  "bot.tooOld": { en: "Couldn't find that entry — it may be too old.", es: "No se encontró ese movimiento: puede que sea muy antiguo." },
  "bot.entryNotFound": { en: "Entry not found — it may have already been confirmed or discarded.", es: "No se encontró el movimiento: puede que ya se haya confirmado o descartado." },
  "bot.internalTransfer": { en: "This transfer has one of your own accounts on both ends, so repayment/loan doesn't apply. If it was really with a friend, first clear one end (\"from none\" or \"to none\").", es: "Esta transferencia tiene una cuenta tuya en ambos extremos, así que no aplica repago/préstamo. Si en realidad fue con un amigo, primero quita un extremo (\"desde ninguna\" o \"hacia ninguna\")." },
  "bot.transferNoEnds": { en: "This transfer has no account on either end, so I can't tell which way the money went. Set one first (\"from Plin\" or \"to BCP\").", es: "Esta transferencia no tiene cuenta en ningún extremo, así que no sé hacia dónde fue el dinero. Primero define una (\"desde Plin\" o \"hacia BCP\")." },
  "bot.onlyExpenseIncome": { en: "Repayment/loan only works on an expense, an income or a transfer — this one is an {type}.", es: "Repago/préstamo solo funciona con un gasto, un ingreso o una transferencia; este movimiento es de tipo {type}." },
  "bot.unknownFriend": { en: "Didn't recognize the friend \"{name}\".", es: "No reconocí al amigo \"{name}\"." },
  "bot.markedRepaymentFrom": { en: "✅ Marked as a repayment from {friend}.", es: "✅ Marcado como repago de {friend}." },
  "bot.markedRepaymentTo": { en: "✅ Marked as a repayment to {friend}.", es: "✅ Marcado como repago a {friend}." },
  "bot.overpaidIn": { en: " {cur} {amount} was more than they owed you — the extra is in your review queue in the app, waiting for a category.", es: " {cur} {amount} era más de lo que te debían: el excedente está en tu lista por revisar en la app, esperando una categoría." },
  "bot.overpaidOut": { en: " {cur} {amount} was more than they were owed — the extra is in your review queue in the app, waiting for a category.", es: " {cur} {amount} era más de lo que se le debía: el excedente está en tu lista por revisar en la app, esperando una categoría." },
  "bot.loanIOwe": { en: "✅ Converted to a loan — you now owe {friend} {cur} {amount}.", es: "✅ Convertido en préstamo: ahora le debes {cur} {amount} a {friend}." },
  "bot.loanTheyOwe": { en: "✅ Converted to a loan — {friend} now owes you {cur} {amount}.", es: "✅ Convertido en préstamo: {friend} ahora te debe {cur} {amount}." },
  "bot.notRecognized": { en: "Didn't recognize that.", es: "No entendí eso." },
  "bot.updated": { en: "Updated {fields}.", es: "Actualizado: {fields}." },
  "bot.couldntApply": { en: "Couldn't apply: {list}.", es: "No pude aplicar: {list}." },
  "bot.notConfirmedPartial": { en: "Not confirmed yet, since part of that reply didn't apply — fix it, or tap Confirm.", es: "Aún no se confirmó porque una parte de esa respuesta no se aplicó: corrígela, o toca Confirmar." },
  "bot.notConfirmedBlocker": { en: "Not confirmed yet — {blocker}.", es: "Aún no se confirmó: {blocker}." },
  "bot.backToPending": { en: "⚠️ Back to pending — {blocker}.", es: "⚠️ Vuelve a pendiente: {blocker}." },
  "bot.blockerPlatform": { en: "an investment needs its platform first — reply \"platform Hapi\"", es: "una inversión necesita primero su plataforma; responde \"plataforma Hapi\"" },
  "bot.blockerCategory": { en: "it needs a category first — reply \"category groceries\"", es: "primero necesita una categoría; responde \"categoría supermercado\"" },
  "bot.thisYear": { en: "this year", es: "este año" },
  "bot.thisMonth": { en: "this month", es: "este mes" },
  "bot.budgetAlert": { en: "{emoji} {category}: {percent}% of your {cur} {amount} budget ({cur} {spent} spent {period}).", es: "{emoji} {category}: {percent}% de tu presupuesto de {cur} {amount} ({cur} {spent} gastados {period})." },
  "bot.overdueTheyOwe": { en: "⏰ Overdue: {friend} owes you {cur} {amount} (due {date}).{description}", es: "⏰ Vencido: {friend} te debe {cur} {amount} (vencía el {date}).{description}" },
  "bot.overdueIOwe": { en: "⏰ Overdue: You owe {friend} {cur} {amount} (due {date}).{description}", es: "⏰ Vencido: le debes {cur} {amount} a {friend} (vencía el {date}).{description}" },

  // ---- help ----
  "help.intro": { en: "Reply to edit:", es: "Responde para editar:" },
  "help.t.from": { en: "from — \"from Plin\"", es: "desde — \"desde Plin\"" },
  "help.t.to": { en: "to — \"to Diners\" (or both: \"from Plin, to Diners\"). Use \"from none\" / \"to none\" when that end isn't one of your own accounts.", es: "hacia — \"hacia Diners\" (o los dos: \"desde Plin, hacia Diners\"). Usa \"desde ninguna\" / \"hacia ninguna\" cuando ese extremo no sea una de tus cuentas." },
  "help.t.amount": { en: "amount — \"amount 90\"", es: "monto — \"monto 90\"" },
  "help.descTaxi": { en: "description — \"description Taxi\"", es: "descripción — \"descripción Taxi\"" },
  "help.currency": { en: "currency — \"currency USD\"", es: "moneda — \"moneda USD\"" },
  "help.date": { en: "date — \"date 2026-09-12\"", es: "fecha — \"fecha 2026-09-12\"" },
  "help.t.category": { en: "category — \"category Transport\"", es: "categoría — \"categoría Transporte\"" },
  "help.label": { en: "tag — \"tag Trip, Work\" (or \"tag none\")", es: "etiqueta — \"etiqueta Viaje, Trabajo\" (o \"etiqueta ninguna\")" },
  "help.t.type": { en: "type — \"type expense\", \"type income\" or \"type investment\" (this wasn't actually a transfer)", es: "tipo — \"tipo gasto\", \"tipo ingreso\" o \"tipo inversión\" (esto en realidad no era una transferencia)" },
  "help.t.combine": { en: "Combine several with commas: \"from Plin, to Diners, amount 90\".", es: "Combina varios con comas: \"desde Plin, hacia Diners, monto 90\"." },
  "help.i.platform": { en: "platform — \"platform Hapi\"", es: "plataforma — \"plataforma Hapi\"" },
  "help.i.direction": { en: "direction — \"withdrawal\" (money coming back from the platform) or \"deposit\" (the default)", es: "dirección — \"retiro\" (dinero que vuelve de la plataforma) o \"depósito\" (el valor por defecto)" },
  "help.i.paymentMethod": { en: "payment method — \"payment method Interbank\" (deposit: the account the money left)", es: "medio de pago — \"medio de pago Interbank\" (depósito: la cuenta de la que salió el dinero)" },
  "help.i.receivedAt": { en: "received at — \"received at Interbank\" or \"to Interbank\" (withdrawal only: the account the money lands in — a withdrawal has no payment method)", es: "recibido en — \"recibido en Interbank\" o \"hacia Interbank\" (solo retiro: la cuenta donde cae el dinero; un retiro no tiene medio de pago)" },
  "help.i.amount": { en: "amount — \"amount 500\"", es: "monto — \"monto 500\"" },
  "help.descDeposit": { en: "description — \"description Monthly deposit\"", es: "descripción — \"descripción Depósito mensual\"" },
  "help.i.type": { en: "type — \"type expense\", \"type income\" or \"type transfer\" (this wasn't actually an investment)", es: "tipo — \"tipo gasto\", \"tipo ingreso\" o \"tipo transferencia\" (esto en realidad no era una inversión)" },
  "help.i.combine": { en: "Combine several with commas: \"platform Hapi, amount 500\" or \"withdrawal, platform Hapi, received at Interbank\".", es: "Combina varios con comas: \"plataforma Hapi, monto 500\" o \"retiro, plataforma Hapi, recibido en Interbank\"." },
  "help.o.category": { en: "category — \"category groceries\"", es: "categoría — \"categoría supermercado\"" },
  "help.o.amount": { en: "amount — \"amount 45.50\"", es: "monto — \"monto 45.50\"" },
  "help.descUber": { en: "description — \"description Uber\"", es: "descripción — \"descripción Uber\"" },
  "help.o.paidBy": { en: "paid by — \"paid by Ana\"", es: "pagado por — \"pagado por Ana\"" },
  "help.o.paymentMethod": { en: "payment method — \"payment method Interbank\"", es: "medio de pago — \"medio de pago Interbank\"" },
  "help.o.split": { en: "split — \"split equal Ana\", \"split Ana 20, Carlos 15\", \"split Ana, me 30\" (your share; Ana owes the rest), or \"split none\"", es: "repartir — \"repartir igual Ana\", \"repartir Ana 20, Carlos 15\", \"repartir Ana, yo 30\" (tu parte; Ana debe el resto) o \"repartir ninguno\"" },
  "help.o.type": { en: "type — \"type transfer\" (this was actually a move between your own accounts — follow with \"from Plin, to Diners\" in the same reply or a later one), or \"type investment\" (money you put into a platform — follow with \"platform Hapi\")", es: "tipo — \"tipo transferencia\" (en realidad fue un traspaso entre tus cuentas: sigue con \"desde Plin, hacia Diners\" en la misma respuesta o en otra) o \"tipo inversión\" (dinero que pones en una plataforma: sigue con \"plataforma Hapi\")" },
  "help.o.combine": { en: "Combine several with commas: \"category groceries, amount 48, description Uber\".", es: "Combina varios con comas: \"categoría supermercado, monto 48, descripción Uber\"." },
  "help.o.names": { en: "Names must match a whole word or the start of one — if a name fits more than one (e.g. two people named Ray), type more of it.", es: "Los nombres deben coincidir con una palabra completa o con el inicio de una; si un nombre encaja con más de uno (e.g. dos personas llamadas Ray), escribe más de él." },
  "help.transfer.intro": { en: "Or if this was really money with a friend, not between your accounts:", es: "O si en realidad fue dinero con un amigo, no entre tus cuentas:" },
  "help.transfer.repayment": { en: "repayment — \"repayment Ana\" (only a \"to\" account: Ana paying you back; only a \"from\" account: you paying Ana)", es: "repago — \"repago Ana\" (solo cuenta \"hacia\": Ana te paga lo que debía; solo cuenta \"desde\": tú le pagas a Ana)" },
  "help.transfer.loan": { en: "loan — \"loan Ana\" (only a \"to\" account: Ana lent you this; only a \"from\" account: you lent it to her)", es: "préstamo — \"préstamo Ana\" (solo cuenta \"hacia\": Ana te prestó esto; solo cuenta \"desde\": tú se lo prestaste)" },
  "help.expense.intro": { en: "Or instead of confirming as an expense:", es: "O en vez de confirmarlo como gasto:" },
  "help.expense.repayment": { en: "repayment — \"repayment Ana\" (you paying down what you owed them)", es: "repago — \"repago Ana\" (tú pagando lo que le debías)" },
  "help.expense.loan": { en: "loan — \"loan Ana\" (you lending them this)", es: "préstamo — \"préstamo Ana\" (tú prestándole esto)" },
  "help.income.intro": { en: "Or instead of confirming as income:", es: "O en vez de confirmarlo como ingreso:" },
  "help.income.repayment": { en: "repayment — \"repayment Ana\" (this is a friend paying you back what they owed)", es: "repago — \"repago Ana\" (un amigo te paga lo que te debía)" },
  "help.income.loan": { en: "loan — \"loan Ana\" (a friend lent you this — you now owe them)", es: "préstamo — \"préstamo Ana\" (un amigo te prestó esto: ahora le debes)" },
  "help.bothLanguages": { en: "Commands also work in Spanish (\"categoría\", \"monto\"…).", es: "Los comandos en inglés también funcionan (\"category\", \"amount\"…)." },

  // ---- photo ----
  "photo.noImage": { en: "Couldn't find an image in that message.", es: "No encontré una imagen en ese mensaje." },
  "photo.queued": { en: "Got it — queued for your Mac Mini. It should show up within a minute or so.", es: "Listo: quedó en cola para tu Mac Mini. Debería aparecer en un minuto, más o menos." },
  "photo.notAReceipt": { en: "That doesn't look like a Plin or Yape receipt, so I saved nothing.", es: "Eso no parece un comprobante de Plin o Yape, así que no guardé nada." },
  "photo.kind.plin_sent": { en: "Plin payment", es: "pago por Plin" },
  "photo.kind.yape_received": { en: "received Yape payment", es: "pago recibido por Yape" },
  "photo.kind.yape_sent": { en: "Yape payment", es: "pago por Yape" },
  "photo.noAmount": { en: "It looks like a {kind} receipt but I couldn't read the amount, so I saved nothing. Try a sharper screenshot.", es: "Parece un comprobante de {kind}, pero no pude leer el monto, así que no guardé nada. Prueba con una captura más nítida." },
  "photo.duplicate": { en: "Already recorded — skipped this duplicate.", es: "Ya estaba registrado: omití este duplicado." },
  "photo.ownerName": { en: "The name on this image matches yours, so I counted it as money you received (income). If that's wrong, discard it and tell me.", es: "El nombre de esta imagen coincide con el tuyo, así que lo conté como dinero que recibiste (ingreso). Si está mal, descártalo y avísame." },
  "photo.downloadFailed": { en: "Couldn't download that image from Telegram (it may be too old) — please send it again.", es: "No pude descargar esa imagen de Telegram (puede que sea muy antigua): envíala de nuevo." },
  "photo.macFailed": { en: "The Mac Mini couldn't read that image ({error}). Try a sharper screenshot.", es: "Tu Mac Mini no pudo leer esa imagen ({error}). Prueba con una captura más nítida." },
  "photo.unknownError": { en: "unknown error", es: "error desconocido" },

  // ---- tag ----
  "tag.annual": { en: "Annual", es: "Anual" },

  // ---- notice ----
  "notice.statement": { en: "📄 New {bank} statement (received {date}). It waits in More → Statements → Inbox until you open it.", es: "📄 Nuevo estado de cuenta de {bank} (recibido el {date}). Espera en Más → Estados de cuenta → Bandeja de entrada hasta que lo abras." },
  "notice.autoProblem": { en: "⚠️ Automatic scan problem:\n• {list}\nLast fully clean run: {last}", es: "⚠️ Problema en el escaneo automático:\n• {list}\nÚltima ejecución sin problemas: {last}" },
  "notice.unknown": { en: "unknown", es: "desconocida" }
};
// END GENERATED

// Built-in categories: key -> { en: stored name, es: shown name }. Names that
// are the same in both languages (acronyms, proper names) need no entry.
var CATEGORY_TRANSLATIONS_ = {
  annual_budget: { en: 'Annual budget', es: 'Presupuesto anual' },
  car: { en: 'Car', es: 'Auto' },
  travel: { en: 'Travel', es: 'Viajes' },
  restaurants: { en: 'Restaurants', es: 'Restaurantes' },
  // Legacy: the old name of 'restaurants' (renamed 2026-10-14). A sheet that has
  // not run adminMigrateCategories yet still holds it; this keeps it translated.
  food_drink: { en: 'Food & Drink', es: 'Restaurantes' },
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
// 'Family & Personal' -> 'family_personal'.
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
  if (key === 'default_currency') HOME_CURRENCY_MEMO_ = null;   // the main currency (HomeCurrency.gs)
  if (key === 'rate_base') RATE_BASE_MEMO_ = null;
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
  // Account names that were all made automatically follow the language (Accounts.gs).
  relocalizeAutoAliases_(lang);
  return { language: lang };
}
