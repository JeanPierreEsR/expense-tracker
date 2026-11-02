// First-use practices (the hands-on tutorials, CLAUDE.md § First-use tips): what every practice shares on the server.
//
// A practice creates REAL entries with an unmistakable name and deletes them minutes later. While they exist they must
// not set off anything real: a practice expense must never push a budget over an alert threshold (the alert would reach
// Home and Telegram for something that is about to vanish). The alert check builds its spending without them.
// Each practice's own cleanup lives with its feature (removePracticeData, removePracticeBudgets, removePracticeProgrammed, …).

// Entry descriptions the practices give the entries they create, in both languages. Add a practice's markers here.
var PRACTICE_ENTRY_NAMES_ = [
  'Practice expense', 'Gasto de práctica',            // Loans: the shared expense
  'Practice item', 'Elemento de práctica'             // Programmed items: the recorded payment
];

function isPracticeEntry_(e) {
  return PRACTICE_ENTRY_NAMES_.indexOf(String((e && e.description) || '').trim()) !== -1;
}
