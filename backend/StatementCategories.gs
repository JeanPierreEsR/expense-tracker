/**
 * Merging the categories of an imported file with the person's own (spreadsheet statements — docs/statement-table.js).
 *
 * An app's export (Spendee…) names a category on every line. The people who bring such a file are used to THEIR categories, so
 * the file's names win: each distinct name (per type: expense / income) is matched to a category the app already has, or becomes a
 * new category with the file's own name; only the app's categories that have no relation to anything in the file (Bank fees…)
 * stay as they are. The person sees the mapping before anything is saved and can change any row; it is remembered with the
 * layout (backend/StatementFormats.gs) so the next export from the same app asks only about names it has not seen.
 *
 * Matching is deterministic and explainable (no AI):
 *   1. the same name — ignoring case, accents and "&" / "and" — as an existing category, in EITHER language (a built-in is
 *      "Transport" and "Transporte" at once);
 *   2. a well-known equivalent of a built-in category (CATEGORY_ALIASES_: "Food & Drink" is Restaurants, "Supermarket" is
 *      Groceries…), found through the built-in's `key`, so it works whatever the person has renamed it to;
 *   3. otherwise: create a category with the file's name.
 * Two names are never merged because they merely look alike. "Savings" and "Loan" are left uncategorized by default: the app
 * retired them on purpose (money put aside is a transfer or an investment, a loan is a loan — principle 2), so they wait in
 * Tidy my history for the person to decide.
 */

// Words that mean one of the app's built-in categories. Key = the built-in's `key`; values are normalized (see catNameNorm_).
// Only equivalents that are safe to assume belong here: a wrong merge hides a person's own distinction.
var CATEGORY_ALIASES_ = {
  expense: {
    restaurants: ['food and drink', 'food and drinks', 'food', 'dining', 'dining out', 'eating out', 'comida', 'comidas', 'comida y bebida', 'comida y bebidas', 'bares y restaurantes', 'restaurantes y bares'],
    groceries: ['supermarket', 'supermarkets', 'supermercado', 'supermercados', 'grocery', 'mercado', 'abarrotes', 'despensa'],
    transport: ['transportation', 'transporte', 'public transport', 'public transportation', 'transporte publico', 'taxi', 'taxis'],
    car: ['auto', 'vehicle', 'vehicles', 'vehiculo', 'vehiculos', 'carro', 'coche', 'automovil'],
    mobile_phone: ['phone', 'cell phone', 'celular', 'telefono', 'telefono movil', 'movil', 'mobile'],
    shopping: ['compras', 'clothes', 'clothing', 'ropa'],
    entertainment: ['leisure', 'ocio', 'entretenimiento', 'fun', 'diversion', 'recreation', 'recreacion'],
    party: ['parties', 'fiestas', 'fiesta', 'nightlife', 'vida nocturna'],
    gifts: ['gift', 'regalos', 'regalo', 'presents'],
    home: ['house', 'housing', 'hogar', 'casa', 'vivienda', 'household'],
    travel: ['trip', 'trips', 'viajes', 'viaje', 'vacation', 'vacations', 'vacaciones', 'holiday', 'holidays'],
    work: ['job', 'trabajo', 'office', 'oficina'],
    education: ['school', 'educacion', 'estudios', 'universidad'],
    gym: ['fitness', 'gimnasio'],
    sports: ['sport', 'deporte', 'deportes'],
    donations: ['donation', 'charity', 'donaciones', 'caridad', 'donativos'],
    family_personal: ['family', 'familia', 'personal', 'personal care', 'cuidado personal', 'familia y personal', 'family and personal'],
    credit_card: ['credit card', 'credit cards', 'tarjeta de credito', 'tarjetas de credito'],
    psychologist: ['therapy', 'therapist', 'psicologo', 'psicologa', 'terapia', 'psychology', 'psicologia'],
    healthcare: ['health', 'health care', 'salud', 'medical', 'medico', 'medicina', 'doctor', 'pharmacy', 'farmacia'],
    other: ['others', 'otros', 'otro', 'misc', 'miscellaneous', 'varios', 'general'],
    bank_fees: ['bank fee', 'bank charges', 'fees', 'comisiones', 'comision', 'bank commissions'],
    annual_budget: ['annual', 'presupuesto anual', 'anual']
  },
  income: {
    salary: ['salaries', 'sueldo', 'salario', 'wages', 'paycheck', 'nomina', 'payroll'],
    business: ['negocio', 'business income', 'freelance'],
    extra_income: ['extra', 'ingreso extra', 'ingresos extra', 'side income', 'other income', 'bonus', 'bono'],
    savings_return: ['interest', 'interest income', 'intereses', 'interes', 'retorno de ahorros'],
    sales: ['sale', 'ventas', 'venta'],
    refunds: ['refund', 'reembolso', 'reembolsos', 'devoluciones', 'devolucion'],
    insurance_payout: ['insurance', 'seguro', 'pago de seguro']
  }
};

// Categories the app retired on purpose: a file's category of this name is NOT recreated; its lines wait in Tidy my history.
var CATEGORY_RETIRED_NAMES_ = ['savings', 'ahorros', 'loan', 'loans', 'prestamo', 'prestamos'];

// Lowercase, no accents, "&" = "and", only letters and digits, single spaces: "Food & Drink" and "food and drink" are one name.
function catNameNorm_(text) {
  return String(text === undefined || text === null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * { 'expense:food and drink': id, … } for the categories of the two managed types. A category answers to its stored name and to its
 * name in both languages. `withHidden` also takes the ones the person hid (used only to avoid creating a clash).
 */
function categoryNameIndex_(cats, withHidden) {
  var index = {};
  cats.forEach(function (c) {
    if (c.type !== 'expense' && c.type !== 'income') return;
    if (!withHidden && String(c.hidden || '') === 'yes') return;
    [c.name, categoryLabel_(c, 'en'), categoryLabel_(c, 'es')].forEach(function (n) {
      var k = c.type + ':' + catNameNorm_(n);
      if (catNameNormKeyOk_(k) && index[k] === undefined) index[k] = c.id;
    });
  });
  return index;
}
function catNameNormKeyOk_(k) { return k.split(':')[1] !== ''; }

// The built-in category of this type whose `key` is one of the alias keys that list this name, or ''.
function categoryIdByAlias_(cats, type, normName) {
  var table = CATEGORY_ALIASES_[type] || {};
  var keys = Object.keys(table).filter(function (key) { return table[key].indexOf(normName) !== -1; });
  // The old name of Restaurants ("Food & Drink") is still a key some sheets hold.
  if (type === 'expense' && (normName === 'food and drink' || normName === 'food and drinks')) keys.push('food_drink');
  for (var i = 0; i < keys.length; i++) {
    var hit = cats.filter(function (c) { return c.type === type && c.key === keys[i] && String(c.hidden || '') !== 'yes'; })[0];
    if (hit) return hit.id;
  }
  return '';
}

/**
 * payload: { names: [{ type: 'expense'|'income', name, count }] }. For each, what the merge would do by default:
 *   { key, type, name, count, action: 'match' | 'create' | 'left', categoryId, categoryName, why: 'name' | 'equivalent' | 'new' | 'retired' }
 * `key` is what the phone sends back (categoryMap) to choose differently. Writes nothing.
 */
function suggestCategoryMap(payload) {
  var cats = getAllRows('Categories');
  var byId = rowsById_(cats);
  var index = categoryNameIndex_(cats, false);
  var items = [];
  var seen = {};
  ((payload && payload.names) || []).forEach(function (n) {
    var type = n.type === 'income' ? 'income' : 'expense';
    var name = String(n.name || '').replace(/\s+/g, ' ').trim();
    var norm = catNameNorm_(name);
    if (!norm) return;
    var key = type + ':' + norm;
    if (seen[key]) return;
    seen[key] = true;
    var item = { key: key, type: type, name: name, count: Number(n.count) || 0, action: 'create', categoryId: '', categoryName: '', why: 'new' };
    var id = index[key];
    if (id) { item.action = 'match'; item.why = 'name'; }
    else if (CATEGORY_RETIRED_NAMES_.indexOf(norm) !== -1) { item.action = 'left'; item.why = 'retired'; }
    else {
      id = categoryIdByAlias_(cats, type, norm);
      if (id) { item.action = 'match'; item.why = 'equivalent'; }
    }
    if (id) { item.categoryId = id; item.categoryName = categoryLabel_(byId[id]); }
    items.push(item);
  });
  return { items: items };
}
