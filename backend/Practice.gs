// First-use practices (the hands-on tutorials, CLAUDE.md § First-use tips): what every practice shares on the server.
//
// A practice creates REAL entries with an unmistakable name and deletes them minutes later. While they exist they must
// not set off anything real: a practice expense must never push a budget over an alert threshold (the alert would reach
// Home and Telegram for something that is about to vanish). The alert check builds its spending without them.
// Each practice's own cleanup lives with its feature (removePracticeData, removePracticeBudgets, removePracticeProgrammed, …).

// Entry descriptions the practices give the entries they create, in both languages. Add a practice's markers here.
var PRACTICE_ENTRY_NAMES_ = [
  'Practice expense', 'Gasto de práctica',            // Loans: the shared expense
  'Practice item', 'Elemento de práctica',            // Programmed items: the recorded payment
  'Practice purchase', 'Compra de práctica',          // Needs review: the capture the person confirms
  'Practice charge', 'Cargo de práctica',             // Needs review: the capture the person discards
  'Practice trip expense', 'Gasto de viaje de práctica',  // Trips & events: the expense linked to the practice trip
  'Practice coffee shop', 'Cafetería de práctica',    // Tidy my history: the three uncategorised expenses (also marked by external_id 'practice-tidy-')
  'Interest and fees, installment 1/3: Practice bank loan',          // Bank loan practice: the installment's interest + fees
  'Intereses y comisiones, cuota 1/3: Préstamo bancario de práctica'
];

// Also any entry a practice created on the server itself (source 'practice', e.g. the Needs review practice's captures).
function isPracticeEntry_(e) {
  if (!e) return false;
  return String(e.source || '') === 'practice' || PRACTICE_ENTRY_NAMES_.indexOf(String(e.description || '').trim()) !== -1;
}
