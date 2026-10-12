// Every piece of user-visible text in the app lives here, ONE ENTRY PER TEXT
// with both languages side by side. To add or change text: edit the entry
// (or add a new one) with BOTH `en` and `es` — tests/backend/i18n.test.js
// fails the deploy if one language is missing, if the {placeholders} differ
// between the two, or if the code asks for a key that doesn't exist.
//
//   "area.name": { en: "Save", es: "Guardar" }
//   "area.count": { en: { one: "{n} entry", other: "{n} entries" },
//                   es: { one: "{n} movimiento", other: "{n} movimientos" } }
//
// Used from code as tr("area.name") / tr("area.count", { n: 3 }), and from
// index.html as data-i18n="area.name" (also data-i18n-placeholder,
// data-i18n-title, data-i18n-aria-label). Texts are plain text, NOT HTML:
// wrap them in escapeHtml() when they go into an innerHTML template.
//
// Vocabulary and style rules: specs/language.md (approved glossary).
(function (root) {
  const STRINGS = {
    // ---- app ----
    "app.title": { en: "Expense Tracker", es: "Expense Tracker" },

    // ---- search ----
    "search.placeholder": { en: "🔍 Search entries…", es: "🔍 Buscar movimientos…" },
    "search.clear": { en: "Clear search", es: "Borrar búsqueda" },
    "search.reloadAll": { en: "↻ Reload all entries", es: "↻ Recargar todos los movimientos" },
    "search.updating": { en: "Updating…", es: "Actualizando…" },
    "search.minChars": { en: "Type at least {n} letters…", es: "Escribe al menos {n} letras…" },
    "search.loadFailed": { en: "Couldn't load your entries for search ({error}). Keep typing to retry.", es: "No se pudieron cargar tus movimientos para buscar ({error}). Sigue escribiendo para reintentar." },
    "search.loadingAll": { en: "Loading all your entries for instant search… (first time only)", es: "Cargando todos tus movimientos para la búsqueda instantánea… (solo la primera vez)" },
    "search.matches": { en: { one: "{n} matching entry — tap one to edit.", other: "{n} matching entries — tap one to edit." }, es: { one: "{n} movimiento coincide: tócalo para editarlo.", other: "{n} movimientos coinciden: toca uno para editarlo." } },
    "search.noMatch": { en: "No entries match “{term}”.", es: "Ningún movimiento coincide con “{term}”." },
    "search.showMore": { en: "Show more ({n} left)", es: "Mostrar más (quedan {n})" },
    "search.reloading": { en: "Reloading everything…", es: "Recargando todo…" },

    // ---- type ----
    "type.expense": { en: "Expense", es: "Gasto" },
    "type.income": { en: "Income", es: "Ingreso" },
    "type.investment": { en: "Investment", es: "Inversión" },
    "type.transfer": { en: "Transfer", es: "Transferencia" },

    // ---- entry ----
    "entry.editing": { en: "✏️ Editing entry", es: "✏️ Editando movimiento" },
    "entry.save": { en: "Save entry", es: "Guardar movimiento" },
    "entry.cancelNew": { en: "Cancel entry", es: "Cancelar movimiento" },
    "entry.cancelEdit": { en: "Cancel edit", es: "Cancelar edición" },
    "entry.delete": { en: "Delete this entry", es: "Eliminar este movimiento" },
    "entry.editTitle": { en: "Edit transaction", es: "Editar movimiento" },
    "entry.programmedNotice": { en: "Programmed for {date} — see More → Programmed income/expenses. It'll turn into a real entry once it actually happens.", es: "Programado para el {date}: míralo en Más → Ingresos y gastos programados. Se convertirá en un movimiento real cuando ocurra." },
    "entry.splitSaveFailed": { en: "Your entry was saved, but the split with your friend(s) was NOT. Open it in Recent entries and save the split again. Don't add the entry a second time.", es: "Tu movimiento se guardó, pero la división con tus amigos NO. Ábrelo en Movimientos recientes y guarda la división de nuevo. No vuelvas a agregar el movimiento." },
    "entry.billSaveFailed": { en: "Your entry and its split were saved, but the bill's item list could not be kept, so you won't be able to edit its items later. Don't add the entry a second time.", es: "Tu movimiento y su división se guardaron, pero no se pudo conservar la lista de ítems de la cuenta, así que no podrás editar sus ítems después. No vuelvas a agregar el movimiento." },
    "entry.savedNotRefreshed": { en: "Saved — but the screen couldn't refresh ({error}). Pull down or reopen the app to see it. Don't add it again.", es: "Se guardó, pero la pantalla no pudo actualizarse ({error}). Desliza hacia abajo o vuelve a abrir la app para verlo. No lo agregues otra vez." },
    "entry.repaymentTo": { en: "Repayment to {friend}", es: "Repago a {friend}" },
    "entry.repaymentFrom": { en: "Repayment from {friend}", es: "Repago de {friend}" },
    "entry.loanFrom": { en: "Loan from {friend}", es: "Préstamo de {friend}" },
    "entry.loanTo": { en: "Loan to {friend}", es: "Préstamo a {friend}" },
    "entry.withdrawalFrom": { en: "Withdrawal from {platform}", es: "Retiro de {platform}" },
    "entry.investmentIn": { en: "Investment in {platform}", es: "Inversión en {platform}" },
    "entry.withdrawalCategory": { en: "Withdrawal — {category}", es: "Retiro — {category}" },
    "entry.investmentCategory": { en: "Investment — {category}", es: "Inversión — {category}" },
    "entry.receivedAt": { en: "received at {account}", es: "recibido en {account}" },
    "entry.fromAccount": { en: "from {account}", es: "desde {account}" },
    "entry.noAccount": { en: "no account set", es: "sin cuenta asignada" },
    "entry.unknownCategory": { en: "(unknown category)", es: "(categoría desconocida)" },
    "entry.saving": { en: "💾 Saving…", es: "💾 Guardando…" },
    "entry.saveFailedRetry": { en: "⚠️ Couldn't save — tap to retry", es: "⚠️ No se pudo guardar: toca para reintentar" },
    "entry.draftRestored": { en: "↩️ Restored the entry you were typing — it wasn't saved yet. Clear the amount and description to drop it.", es: "↩️ Se restauró el movimiento que estabas escribiendo: aún no se guardó. Borra el monto y la descripción para descartarlo." },
    "entry.confirmCancelNew": { en: "Cancel this entry? What you've typed will be discarded.", es: "¿Cancelar este movimiento? Lo que escribiste se descartará." },
    "entry.update": { en: "Update entry", es: "Actualizar movimiento" },
    "entry.confirmButton": { en: "Confirm entry", es: "Confirmar movimiento" },
    "entry.confirmTitle": { en: "Confirm transaction", es: "Confirmar movimiento" },
    "entry.confirmingBanner": { en: "✏️ Confirming entry", es: "✏️ Confirmando movimiento" },
    "entry.stillSaving": { en: "Still saving your last change to this entry — try again in a moment.", es: "Todavía se está guardando tu último cambio en este movimiento: inténtalo de nuevo en un momento." },
    "entry.notInList": { en: "That entry isn't in the currently loaded list — scroll Recent entries to find it, or pull down to refresh.", es: "Ese movimiento no está en la lista cargada: desplázate por Movimientos recientes para encontrarlo, o desliza hacia abajo para actualizar." },

    // ---- common ----
    "common.change": { en: "Change", es: "Cambiar" },
    "common.friend": { en: "Friend", es: "Amigo" },
    "common.optional": { en: "Optional", es: "Opcional" },
    "common.addFriend": { en: "+ Add friend…", es: "+ Agregar amigo…" },
    "common.addTag": { en: "+ Add tag…", es: "+ Agregar etiqueta…" },
    "common.save": { en: "Save", es: "Guardar" },
    "common.more": { en: "More…", es: "Más…" },
    "common.less": { en: "Less", es: "Menos" },
    "common.me": { en: "Me", es: "Yo" },
    "common.addPayor": { en: "+ Add payor…", es: "+ Agregar pagador…" },
    "common.noPaymentMethods": { en: "No payment methods yet", es: "Aún no hay medios de pago" },
    "common.addPaymentMethod": { en: "+ Add payment method…", es: "+ Agregar medio de pago…" },
    "common.total": { en: "Total", es: "Total" },
    "common.loadMore": { en: "Load more", es: "Cargar más" },
    "common.loading": { en: "Loading…", es: "Cargando…" },

    // ---- field ----
    "field.category": { en: "Category", es: "Categoría" },
    "field.amount": { en: "Amount", es: "Monto" },
    "field.date": { en: "Date", es: "Fecha" },
    "field.currency": { en: "Currency", es: "Moneda" },
    "field.description": { en: "Description", es: "Descripción" },
    "field.paidBy": { en: "Paid by", es: "Pagado por" },
    "field.paymentMethod": { en: "Payment method", es: "Medio de pago" },
    "field.toAccount": { en: "To (account it goes into)", es: "Hacia (cuenta donde entra)" },
    "field.tags": { en: "Tags", es: "Etiquetas" },
    "field.receivedFrom": { en: "Received from", es: "Recibido de" },
    "field.from": { en: "From", es: "Desde" },
    "field.receivedAt": { en: "Received at", es: "Recibido en" },
    "field.platform": { en: "Platform", es: "Plataforma" },
    "field.paidFromAccount": { en: "Paid from (account)", es: "Pagado desde (cuenta)" },
    "field.receivedIntoAccount": { en: "Received into (account)", es: "Recibido en (cuenta)" },

    // ---- transfer ----
    "transfer.kind": { en: "Type of transfer", es: "Tipo de transferencia" },
    "transfer.kind.between": { en: "Between Accounts", es: "Entre cuentas" },
    "transfer.kind.repayment": { en: "Repayments", es: "Repagos" },
    "transfer.kind.loan": { en: "New loan", es: "Nuevo préstamo" },
    "transfer.iPaid": { en: "I paid them", es: "Le pagué" },
    "transfer.theyPaid": { en: "They paid me", es: "Me pagó" },
    "transfer.overpayCategory": { en: "Category if you paid extra", es: "Categoría si pagaste de más" },
    "transfer.overpayHint": { en: "Only used if the amount is more than what was owed — the extra becomes a real entry in this category.", es: "Solo se usa si el monto es mayor a lo que se debía: el excedente se registra como un movimiento real en esta categoría." },
    "transfer.toHint": { en: "Optional — e.g. topping up a Starbucks or Yape balance from a card. Lets that account's balance count it. Money arriving from outside (e.g. the USD side of a currency exchange)? Set From to \"None\" and enter the amount in its own currency; record the PEN leaving as a separate transfer with To left empty.", es: "Opcional: por ejemplo, recargar el saldo de Starbucks o de Yape desde una tarjeta. Así el saldo de esa cuenta lo toma en cuenta. ¿Dinero que llega de afuera (por ejemplo, la parte en dólares de un cambio de moneda)? Pon \"Ninguna\" en Desde e ingresa el monto en su propia moneda; registra los soles que salen como otra transferencia con Hacia vacío." },
    "transfer.autoFromTo": { en: "from {from} to {to}", es: "de {from} a {to}" },
    "transfer.autoFrom": { en: "from {from}", es: "de {from}" },
    "transfer.autoInto": { en: "into {to}", es: "hacia {to}" },
    "transfer.overpayCategoryIPaid": { en: "Category if you paid extra (expense)", es: "Categoría si pagaste de más (gasto)" },
    "transfer.overpayCategoryTheyPaid": { en: "Category if they paid extra (income)", es: "Categoría si te pagaron de más (ingreso)" },
    "transfer.hintLoanIPaid": { en: "You lent them this money, so they now owe you it back. It is not an expense.", es: "Le prestaste este dinero, así que ahora te lo debe. No es un gasto." },
    "transfer.hintLoanTheyPaid": { en: "They lent you this money, so you now owe them it back. It is not income.", es: "Te prestaron este dinero, así que ahora se lo debes. No es un ingreso." },
    "transfer.hintRepayIPaid": { en: "Pays down what you owe them. It is not an expense — only your debt balance changes.", es: "Reduce lo que le debes. No es un gasto: solo cambia el saldo de tu deuda." },
    "transfer.hintRepayTheyPaid": { en: "Pays down what they owe you. It is not income — only their debt balance changes.", es: "Reduce lo que te debe. No es un ingreso: solo cambia el saldo de su deuda." },

    // ---- loan ----
    "loan.dueDateOptional": { en: "Due date (optional)", es: "Fecha de vencimiento (opcional)" },
    "loan.dueDateHint": { en: "Left blank, it's set to a week after the date.", es: "Si la dejas en blanco, se pone una semana después de la fecha." },

    // ---- investment ----
    "investment.deposit": { en: "Deposit", es: "Depósito" },
    "investment.withdrawal": { en: "Withdrawal", es: "Retiro" },
    "investment.depositHint": { en: "Money you put into the platform.", es: "Dinero que pones en la plataforma." },
    "investment.withdrawalHint": { en: "Money coming back from the platform to your account.", es: "Dinero que vuelve de la plataforma a tu cuenta." },

    // ---- split ----
    "split.openBill": { en: "🧾 Split a bill by items…", es: "🧾 Dividir una cuenta por ítems…" },
    "split.toggle": { en: "Split this expense", es: "Dividir este gasto" },
    "split.equal": { en: "Equal", es: "Igual" },
    "split.custom": { en: "Custom", es: "Personalizado" },
    "split.sharedWith": { en: "Shared with", es: "Compartido con" },
    "split.pickWho": { en: "Pick who else this is shared with.", es: "Elige con quién más se comparte." },
    "split.summaryEqual": { en: "{cur} {each} each · {cur} {own} to you", es: "{cur} {each} cada uno · {cur} {own} para ti" },
    "split.errorOver": { en: "That's more than the total amount.", es: "Eso es más que el monto total." },
    "split.errorEveryoneFilled": { en: "Everyone's filled in, but it adds up to {cur} {sum}, not {cur} {total}. Clear one box to let it take the rest.", es: "Todos tienen monto, pero suman {cur} {sum}, no {cur} {total}. Vacía una casilla para que se quede con el resto." },
    "split.summaryCustom": { en: "{cur} {friends} of {cur} {total} to friends · {cur} {own} to you", es: "{cur} {friends} de {cur} {total} para los amigos · {cur} {own} para ti" },
    "split.errNoFriend": { en: "Pick at least one friend to split with, or turn the split toggle off.", es: "Elige al menos un amigo para dividir, o desactiva la división." },
    "split.errOverTotal": { en: "The split adds up to more than the total amount.", es: "La división suma más que el monto total." },
    "split.errNotTotal": { en: "The amounts don't add up to the total — clear one box to let it take the rest.", es: "Los montos no suman el total: vacía una casilla para que se quede con el resto." },
    "split.errNoAmount": { en: "Enter at least one friend's amount.", es: "Ingresa el monto de al menos un amigo." },

    // ---- review ----
    "review.title": { en: "Needs review", es: "Por revisar" },
    "review.intro": { en: "Caught automatically from your email — check the details and confirm, or discard if it's not a real transaction.", es: "Detectados automáticamente en tu correo: revisa los detalles y confirma, o descarta si no es un movimiento real." },
    "review.pickPlatform": { en: "Pick the platform…", es: "Elige la plataforma…" },
    "review.noDescription": { en: "(no description)", es: "(sin descripción)" },
    "review.dupWarning": { en: "⚠️ Possible duplicate — same day, amount and merchant as {list}. Discard if it's a copy; confirm if it's a real repeat.", es: "⚠️ Posible duplicado: mismo día, monto y comercio que {list}. Descarta si es una copia; confirma si es una repetición real." },
    "review.dupItem": { en: "\"{name}\" ({status})", es: "\"{name}\" ({status})" },
    "review.dupAnEntry": { en: "an entry", es: "un movimiento" },
    "review.pickCategory": { en: "Pick a category…", es: "Elige una categoría…" },
    "review.pickAccountLeft": { en: "Pick the account it left…", es: "Elige la cuenta de la que salió…" },
    "review.pickAccountEntered": { en: "Pick the account it went into…", es: "Elige la cuenta a la que entró…" },
    "review.fromLabel": { en: "⬆️ From", es: "⬆️ Desde" },
    "review.toLabel": { en: "⬇️ To", es: "⬇️ Hacia" },
    "review.platformLabel": { en: "📈 Platform", es: "📈 Plataforma" },
    "review.platformWithdrawal": { en: " (withdrawal — money coming back)", es: " (retiro: dinero que vuelve)" },
    "review.receivedAtLabel": { en: "⬇️ Received at", es: "⬇️ Recibido en" },
    "review.pickAccount": { en: "Pick the account…", es: "Elige la cuenta…" },
    "review.confirm": { en: "✅ Confirm", es: "✅ Confirmar" },
    "review.discard": { en: "❌ Discard", es: "❌ Descartar" },
    "review.split": { en: "🔀 Split", es: "🔀 Dividir" },
    "review.markRepayment": { en: "💰 Mark as repayment", es: "💰 Marcar como repago" },
    "review.convertLoan": { en: "🤝 Convert to loan", es: "🤝 Convertir en préstamo" },
    "review.pickCategoryFirst": { en: "Pick a category first.", es: "Primero elige una categoría." },
    "review.pickPlatformFirst": { en: "Pick the platform first — an investment only counts once it has one.", es: "Primero elige la plataforma: una inversión solo cuenta cuando tiene una." },
    "review.confirmDiscard": { en: "Discard {what}? This can't be undone.", es: "¿Descartar {what}? No se puede deshacer." },
    "review.alreadyHandled": { en: "This entry was already confirmed, changed or removed elsewhere — refreshing the list.", es: "Este movimiento ya se confirmó, cambió o eliminó en otro lugar: se está actualizando la lista." },
    "review.repayTitle": { en: "Mark as repayment", es: "Marcar como repago" },
    "review.loanTitle": { en: "Convert to loan", es: "Convertir en préstamo" },
    "review.transactionFallback": { en: "Transaction", es: "Movimiento" },
    "review.contextRepay": { en: " — a friend paying you back what they owed", es: " — un amigo te devuelve lo que te debía" },
    "review.contextLoan": { en: " — a friend lending you this", es: " — un amigo te presta esto" },
    "review.overpaidIncoming": { en: "Marked as a repayment from {name} — {cur} {amount} was more than they owed you. The extra is in your review queue, waiting for a category.", es: "Se marcó como repago de {name}: {cur} {amount} era más de lo que te debía. El excedente está en tu lista por revisar, esperando una categoría." },
    "review.overpaidOutgoing": { en: "Marked as a repayment to {name} — {cur} {amount} was more than they were owed. The extra is in your review queue, waiting for a category.", es: "Se marcó como repago a {name}: {cur} {amount} era más de lo que se le debía. El excedente está en tu lista por revisar, esperando una categoría." },

    // ---- entries ----
    "entries.recent": { en: "Recent entries", es: "Movimientos recientes" },
    "entries.empty": { en: "No entries yet — add your first one above.", es: "Aún no hay movimientos: agrega el primero arriba." },

    // ---- period ----
    "period.prev": { en: "Previous period", es: "Periodo anterior" },
    "period.next": { en: "Next period", es: "Periodo siguiente" },
    "period.month": { en: "Month", es: "Mes" },
    "period.year": { en: "Year", es: "Año" },
    "period.alltime": { en: "All-time", es: "Todo" },
    "period.custom": { en: "Custom", es: "Personalizado" },
    "period.from": { en: "From", es: "Desde" },
    "period.to": { en: "To", es: "Hasta" },
    "period.customRange": { en: "Custom range", es: "Rango personalizado" },

    // ---- nav ----
    "nav.entries": { en: "Entries", es: "Movimientos" },
    "nav.overview": { en: "Overview", es: "Resumen" },
    "nav.budgets": { en: "Budgets", es: "Presupuestos" },
    "nav.projections": { en: "Projections", es: "Proyecciones" },
    "nav.loans": { en: "Loans", es: "Préstamos" },
    "nav.more": { en: "More", es: "Más" },

    // ---- currency ----
    "currency.choose": { en: "Choose a currency", es: "Elige una moneda" },
    "currency.search": { en: "Search code or name…", es: "Buscar código o nombre…" },
    "currency.PEN": { en: "Peruvian Sol", es: "Sol peruano" },
    "currency.USD": { en: "US Dollar", es: "Dólar estadounidense" },
    "currency.EUR": { en: "Euro", es: "Euro" },
    "currency.ARS": { en: "Argentine Peso", es: "Peso argentino" },
    "currency.MXN": { en: "Mexican Peso", es: "Peso mexicano" },
    "currency.BRL": { en: "Brazilian Real", es: "Real brasileño" },
    "currency.CLP": { en: "Chilean Peso", es: "Peso chileno" },
    "currency.COP": { en: "Colombian Peso", es: "Peso colombiano" },
    "currency.BOB": { en: "Bolivian Boliviano", es: "Boliviano" },
    "currency.UYU": { en: "Uruguayan Peso", es: "Peso uruguayo" },
    "currency.PYG": { en: "Paraguayan Guaraní", es: "Guaraní paraguayo" },
    "currency.VES": { en: "Venezuelan Bolívar", es: "Bolívar venezolano" },
    "currency.GTQ": { en: "Guatemalan Quetzal", es: "Quetzal guatemalteco" },
    "currency.CRC": { en: "Costa Rican Colón", es: "Colón costarricense" },
    "currency.PAB": { en: "Panamanian Balboa", es: "Balboa panameño" },
    "currency.DOP": { en: "Dominican Peso", es: "Peso dominicano" },
    "currency.HNL": { en: "Honduran Lempira", es: "Lempira hondureño" },
    "currency.NIO": { en: "Nicaraguan Córdoba", es: "Córdoba nicaragüense" },
    "currency.CUP": { en: "Cuban Peso", es: "Peso cubano" },
    "currency.GBP": { en: "British Pound", es: "Libra esterlina" },
    "currency.CAD": { en: "Canadian Dollar", es: "Dólar canadiense" },
    "currency.CHF": { en: "Swiss Franc", es: "Franco suizo" },
    "currency.JPY": { en: "Japanese Yen", es: "Yen japonés" },
    "currency.CNY": { en: "Chinese Yuan", es: "Yuan chino" },
    "currency.KRW": { en: "South Korean Won", es: "Won surcoreano" },
    "currency.INR": { en: "Indian Rupee", es: "Rupia india" },
    "currency.AUD": { en: "Australian Dollar", es: "Dólar australiano" },
    "currency.NZD": { en: "New Zealand Dollar", es: "Dólar neozelandés" },
    "currency.SGD": { en: "Singapore Dollar", es: "Dólar singapurense" },
    "currency.HKD": { en: "Hong Kong Dollar", es: "Dólar de Hong Kong" },
    "currency.SEK": { en: "Swedish Krona", es: "Corona sueca" },
    "currency.NOK": { en: "Norwegian Krone", es: "Corona noruega" },
    "currency.DKK": { en: "Danish Krone", es: "Corona danesa" },
    "currency.PLN": { en: "Polish Złoty", es: "Esloti polaco" },
    "currency.TRY": { en: "Turkish Lira", es: "Lira turca" },
    "currency.ZAR": { en: "South African Rand", es: "Rand sudafricano" },
    "currency.AED": { en: "UAE Dirham", es: "Dírham de los Emiratos" },
    "currency.THB": { en: "Thai Baht", es: "Baht tailandés" },
    "currency.RUB": { en: "Russian Ruble", es: "Rublo ruso" },
    "currency.ILS": { en: "Israeli Shekel", es: "Nuevo shéquel israelí" },

    // ---- error ----
    "error.unreachable": { en: "Couldn't reach the server. Check your connection and try again.", es: "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo." },
    "error.unknown": { en: "Unknown error", es: "Error desconocido" },
    "error.rateRequired": { en: "An exchange rate is required to save this entry.", es: "Se necesita un tipo de cambio para guardar este movimiento." },
    "error.sameAccount": { en: "From and To can't be the same account.", es: "Desde y Hacia no pueden ser la misma cuenta." },
    "error.pickPlatform": { en: "Pick the platform.", es: "Elige la plataforma." },
    "error.dateRequired": { en: "Date is required.", es: "La fecha es obligatoria." },
    "error.validAmount": { en: "Enter a valid amount.", es: "Ingresa un monto válido." },
    "error.pickCategory": { en: "Pick a category.", es: "Elige una categoría." },
    "error.pickAccount": { en: "Pick the account the money leaves (From) or the one it goes into (To).", es: "Elige la cuenta de la que sale el dinero (Desde) o a la que entra (Hacia)." },
    "error.pickPaymentMethod": { en: "Pick a payment method.", es: "Elige un medio de pago." },
    "error.pickFriend": { en: "Pick a friend.", es: "Elige un amigo." },
    "error.loadData": { en: "Couldn't load data: {error}", es: "No se pudieron cargar los datos: {error}" },

    // ---- form ----
    "form.pickPlatform": { en: "Pick a platform…", es: "Elige una plataforma…" },
    "form.noneAccount": { en: "None", es: "Ninguna" },
    "form.noneFromOutside": { en: "None (money comes from outside)", es: "Ninguna (el dinero viene de afuera)" },

    // ---- prompt ----
    "prompt.friendName": { en: "Friend's name:", es: "Nombre del amigo:" },
    "prompt.payorName": { en: "Payor's name (e.g. a client or employer):", es: "Nombre del pagador (por ejemplo, un cliente o empleador):" },
    "prompt.paymentMethodName": { en: "Payment method name (e.g. \"BCP Visa\"):", es: "Nombre del medio de pago (por ejemplo, \"BCP Visa\"):" },
    "prompt.paymentMethodType": { en: "Type: credit, debit, cash, transfer, or wallet?", es: "Tipo: crédito, débito, efectivo, transferencia o billetera?" },
    "prompt.last4": { en: "Last 4 digits (leave blank if none):", es: "Últimos 4 dígitos (déjalo en blanco si no tiene):" },
    "prompt.tagName": { en: "New tag name:", es: "Nombre de la nueva etiqueta:" },

    // ---- repay ----
    "repay.overpaidRecordedIncome": { en: " {cur} {amount} was more than the debt, so it was also recorded as income.", es: " {cur} {amount} era más que la deuda, así que también se registró como ingreso." },
    "repay.overpaidRecordedExpense": { en: " {cur} {amount} was more than the debt, so it was also recorded as an expense.", es: " {cur} {amount} era más que la deuda, así que también se registró como gasto." },
    "repay.overpaidPendingIncome": { en: " {cur} {amount} was more than the debt — it's in your review queue as income, waiting for a category.", es: " {cur} {amount} era más que la deuda: está en tu lista por revisar como ingreso, esperando una categoría." },
    "repay.overpaidPendingExpense": { en: " {cur} {amount} was more than the debt — it's in your review queue as an expense, waiting for a category.", es: " {cur} {amount} era más que la deuda: está en tu lista por revisar como gasto, esperando una categoría." },
    "repay.loanTo": { en: "Loan to {name} recorded.", es: "Préstamo a {name} registrado." },
    "repay.loanFrom": { en: "Loan from {name} recorded.", es: "Préstamo de {name} registrado." },
    "repay.repaymentFrom": { en: "Repayment from {name} recorded.", es: "Repago de {name} registrado." },
    "repay.repaymentTo": { en: "Repayment to {name} recorded.", es: "Repago a {name} registrado." },

    // ---- confirm ----
    "confirm.thisEntry": { en: "this entry", es: "este movimiento" },
    "confirm.thisItem": { en: "this item", es: "este elemento" },
    "confirm.label": { en: "\"{label}\"", es: "\"{label}\"" },
    "confirm.deleteEntry": { en: "Delete {what}? This can't be undone.", es: "¿Eliminar {what}? No se puede deshacer." },

    // ---- delete ----
    "delete.forgivenessTheyOweMe": { en: "This entry records you forgiving {friend}'s debt. Deleting it also undoes the forgiveness, so they owe you that amount again. Continue?", es: "Este movimiento registra que perdonaste la deuda de {friend}. Si lo eliminas, también se deshace el perdón y te volverá a deber ese monto. ¿Continuar?" },
    "delete.forgivenessIOweThem": { en: "This entry records you forgiving {friend}'s debt. Deleting it also undoes the forgiveness, so you owe them that amount again. Continue?", es: "Este movimiento registra que perdonaste la deuda de {friend}. Si lo eliminas, también se deshace el perdón y volverás a deberle ese monto. ¿Continuar?" },
    "delete.isLoan": { en: "This entry is the money movement of a loan — delete or edit that loan from the Loans tab instead.", es: "Este movimiento es el traspaso de dinero de un préstamo: elimina o edita ese préstamo desde la pestaña Préstamos." },
    "delete.repaymentFrom": { en: "This is a repayment from {friend} ({cur} {total}). Deleting it also cancels the repayment, so they owe you that amount again. Continue?", es: "Este es un repago de {friend} ({cur} {total}). Si lo eliminas, también se cancela el repago y te volverá a deber ese monto. ¿Continuar?" },
    "delete.repaymentTo": { en: "This is a repayment to {friend} ({cur} {total}). Deleting it also cancels the repayment, so you owe them that amount again. Continue?", es: "Este es un repago a {friend} ({cur} {total}). Si lo eliminas, también se cancela el repago y volverás a deberle ese monto. ¿Continuar?" },

    // ---- banner ----
    "banner.saveFailed": { en: { one: "⚠️ {n} entry couldn't save — tap to review", other: "⚠️ {n} entries couldn't save — tap to review" }, es: { one: "⚠️ {n} movimiento no se pudo guardar: toca para revisar", other: "⚠️ {n} movimientos no se pudieron guardar: toca para revisar" } },
    "banner.update": { en: "🔄 New version available — tap to reload", es: "🔄 Nueva versión disponible: toca para recargar" },

    // ---- check ----
    "check.checking.review": { en: "🔄 Checking for new review items…", es: "🔄 Buscando nuevos movimientos por revisar…" },
    "check.failed.review": { en: "⚠️ Couldn't confirm — showing the last known review items. Pull down to retry.", es: "⚠️ No se pudo confirmar: se muestran los últimos movimientos por revisar conocidos. Desliza hacia abajo para reintentar." },
    "check.checking.entries": { en: "🔄 Checking for new entries…", es: "🔄 Buscando nuevos movimientos…" },
    "check.failed.entries": { en: "⚠️ Couldn't confirm — showing the last known entries. Pull down to retry.", es: "⚠️ No se pudo confirmar: se muestran los últimos movimientos conocidos. Desliza hacia abajo para reintentar." },
    "check.checking.meta": { en: "🔄 Checking for new categories & accounts…", es: "🔄 Buscando nuevas categorías y cuentas…" },
    "check.failed.meta": { en: "⚠️ Couldn't confirm — showing the last known categories & accounts. Pull down to retry.", es: "⚠️ No se pudo confirmar: se muestran las últimas categorías y cuentas conocidas. Desliza hacia abajo para reintentar." },
    "check.checking.recurring": { en: "🔄 Checking for new programmed items…", es: "🔄 Buscando nuevos movimientos programados…" },
    "check.failed.recurring": { en: "⚠️ Couldn't confirm — showing the last known programmed items. Pull down to retry.", es: "⚠️ No se pudo confirmar: se muestran los últimos movimientos programados conocidos. Desliza hacia abajo para reintentar." },

    // ---- status ----
    "status.pending": { en: "pending", es: "pendiente" },
    "status.confirmed": { en: "confirmed", es: "confirmado" },
    "status.discarded": { en: "discarded", es: "descartado" }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = STRINGS;
  else root.STRINGS = STRINGS;
})(typeof window !== "undefined" ? window : this);
