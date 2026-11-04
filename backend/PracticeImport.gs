/**
 * First-use practice: "Import from another app" (docs/statements.js § First-use practice: Import from another app).
 *
 * The practice builds a small made-up CSV ON THE PHONE and walks the person through the REAL import (read, check the columns and categories,
 * preview, "Add to my history") and the REAL Undo. So there is no "create" call: the import itself saves. What can be left behind:
 *  - an import that was saved but never undone (Exit after "Add to my history", or the app closed midway): its entries ("Practice lunch" …) sit in
 *    an import batch, and so may a category the import created;
 *  - the remembered layout of the made-up file (saveStatementFormat runs when the person taps "Use these lines"), which Undo does not remove.
 * removePracticeImport({ signature }) takes both away: every import batch whose entries are ALL practice entries is undone with the REAL
 * undoStatementBatch (which also removes the categories that batch created), and the layout with the practice file's signature is forgotten.
 * A real import batch is never touched: one entry that is not a practice entry keeps its whole batch.
 */

function isPracticeImportEntry_(e) {
  return !!e && PRACTICE_ENTRY_NAMES_.indexOf(String(e.description || '').trim()) !== -1;
}

/** payload: { signature }. Returns { batches, entries, layouts }. */
function removePracticeImport(payload) {
  return withScriptLockOnce_(function () {
    var out = { batches: 0, entries: 0, layouts: 0 };
    var byBatch = {};
    getAllRows('Entries').forEach(function (e) {
      var id = String(e.import_batch_id || '');
      if (!id) return;
      var b = byBatch[id] || (byBatch[id] = { all: 0, practice: 0 });
      b.all++;
      if (isPracticeImportEntry_(e)) b.practice++;
    });
    Object.keys(byBatch).forEach(function (id) {
      var b = byBatch[id];
      if (b.all === 0 || b.all !== b.practice) return;   // a real import (or a mixed one) stays whole
      try {
        var r = undoStatementBatch({ batchId: id });
        out.batches++;
        out.entries += r.deletedEntries || 0;
      } catch (err) { /* it stays in Recent imports: the person can undo it there */ }
    });
    var signature = String((payload && payload.signature) || '');
    if (signature) out.layouts = deleteStatementFormat({ signature: signature }).deleted || 0;
    return out;
  });
}
