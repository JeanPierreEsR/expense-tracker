/**
 * The bot's examples use the person's OWN things (owner, 2026-11-20: "reply account Interbank" was tailored to him; specs/
 * review-telegram-email.md § Bot examples). A server text with {ex…} gets them from tr_ (Strings.gs) when its caller did not pass
 * them:
 *   exAcc            the most used account ("(account)" when there is none)
 *   exFrom / exTo    the two most used accounts; both "(account)" with fewer than two (owner's choice (a): never "from Cash, to Cash")
 *   exPlatform       the most used investment platform ("(platform)")
 *   exFriend(2)      the friends used last (made-up "Ana" / "Carlos" when there are none: they are not anyone's friends)
 *   exCat            the most used expense category ("(category)")
 *   exTag            the most used tag ("(tag)")
 *   exCur / exCur2   the main currency; another one for "currency …" (USD, or EUR when the main one is USD)
 *   exLunch, exLunchWith, exIncome, exSalary   typed-example words in the copy's language
 *   exPhoto          the receipt-photo sentence, only where photos can be read
 * Names come from the Sheet once per run (and the script cache for 10 minutes); the words around them from Strings.gs.
 */
var BOT_EXAMPLES_RUN_ = null;
var BOT_EXAMPLES_CACHE_KEY_ = 'bot-examples-v1';

function botExampleNames_() {
  if (BOT_EXAMPLES_RUN_) return BOT_EXAMPLES_RUN_;
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }
  var hit = cache ? cache.get(BOT_EXAMPLES_CACHE_KEY_) : null;
  if (hit) { try { BOT_EXAMPLES_RUN_ = JSON.parse(hit); return BOT_EXAMPLES_RUN_; } catch (err) { /* read again */ } }
  var names = { accounts: [], platform: '', friends: [], category: '', tag: '' };
  try {
    var visible = function (r) { var h = String(r.hidden || '').toLowerCase(); return h !== 'yes' && h !== 'true'; };
    var pms = getAllRows('Payment Methods').filter(visible);
    var entries = getAllRows('Entries');
    var uses = {}, cats = {};
    entries.forEach(function (e) {
      if (e.payment_method_id) uses[e.payment_method_id] = (uses[e.payment_method_id] || 0) + 1;
      if (e.to_payment_method_id) uses[e.to_payment_method_id] = (uses[e.to_payment_method_id] || 0) + 1;
      if (e.type === 'expense' && e.category_id) cats[e.category_id] = (cats[e.category_id] || 0) + 1;
    });
    var byUse = function (a, b) { return (uses[b.id] || 0) - (uses[a.id] || 0) || String(a.nickname).localeCompare(String(b.nickname)); };
    names.accounts = pms.filter(function (p) { return p.type !== 'investment' && p.nickname; }).sort(byUse).slice(0, 2).map(function (p) { return String(p.nickname); });
    var plat = pms.filter(function (p) { return p.type === 'investment' && p.nickname; }).sort(byUse)[0];
    names.platform = plat ? String(plat.nickname) : '';

    var friends = getAllRows('Friends');
    var lastUse = {};
    getAllRows('Loans').forEach(function (l) { if (String(l.date || '') > String(lastUse[l.friend_id] || '')) lastUse[l.friend_id] = String(l.date); });
    names.friends = friends.filter(function (f) { return f.name; }).sort(function (a, b) {
      return String(lastUse[b.id] || '').localeCompare(String(lastUse[a.id] || '')) || String(a.name).localeCompare(String(b.name));
    }).slice(0, 2).map(function (f) { return String(f.name); });

    var catRows = getAllRows('Categories').filter(function (c) { return visible(c) && c.type !== 'income'; });
    var topCat = catRows.sort(function (a, b) { return (cats[b.id] || 0) - (cats[a.id] || 0); })[0];
    names.category = topCat ? { name: topCat.name, key: topCat.key } : '';

    var tagUse = {};
    getAllRows('Entry Tags').forEach(function (t) { tagUse[t.tag_id] = (tagUse[t.tag_id] || 0) + 1; });
    var topTag = getAllRows('Tags').filter(function (t) { return t.name; }).sort(function (a, b) { return (tagUse[b.id] || 0) - (tagUse[a.id] || 0); })[0];
    names.tag = topTag ? String(topTag.name) : '';
  } catch (err) { /* a missing tab: the placeholders below stand in */ }
  BOT_EXAMPLES_RUN_ = names;
  if (cache) { try { cache.put(BOT_EXAMPLES_CACHE_KEY_, JSON.stringify(names), 600); } catch (err) { /* too big: never */ } }
  return names;
}

// The {ex…} values for one language.
function botExamples_(lang) {
  var n = botExampleNames_();
  var w = function (key) { return tr_(key, null, lang); };
  var acc = w('botEx.account');
  var cur = String(homeCurrency_() || 'USD');
  var two = n.accounts.length >= 2;
  return {
    exAcc: n.accounts[0] || acc,
    exFrom: two ? n.accounts[0] : acc,
    exTo: two ? n.accounts[1] : acc,
    exPlatform: n.platform || w('botEx.platform'),
    exFriend: n.friends[0] || 'Ana',
    exFriend2: n.friends[1] || (n.friends[0] === 'Carlos' ? 'Ana' : 'Carlos'),
    exCat: n.category ? categoryLabel_(n.category, lang) : w('botEx.category'),
    exTag: n.tag || w('botEx.tag'),
    exCur: cur,
    exCur2: cur === 'USD' ? 'EUR' : 'USD',
    exLunch: w('botEx.lunch'),
    exLunchWith: w('botEx.lunchWith'),
    exIncome: w('botEx.income'),
    exSalary: w('botEx.salary'),
    exPhoto: whatsappPhotoReaderReady_() ? w('botEx.photo') : ''
  };
}
