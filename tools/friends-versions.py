#!/usr/bin/env python3
"""
Who is on which version of the app, and since when (owner's request, 2026-11-24).

Friends' phones that agreed to share app speed ("Help me improve the app") send the release of the screens they run with every
report. A friend's screens follow their backend (each pin has its own kept copy), so the release says which backend they run, and
the first day a phone reported a release is (within a day of opening the app) the day they updated.

This asks the owner's backend for each friend phone's release history (read-only action `listPerfPhones`, the Mac helper's key
from ~/expense-tracker-ocr/config.json, like friends-copies.py), keeps it in the PRIVATE folder (FRIEND_PHONES.json: the owner's
names for each phone and every release seen, so trimmed report rows do not lose the dates), and rewrites the automatic section of
"Friends and their versions.md". Nothing here goes to the public repo; phones are known by a short code (8 letters of a random id).

Usage:
  tools/friends-versions.py                       refresh from the backend, rewrite the section, print the table
  tools/friends-versions.py --name CODE NAME      say whose phone CODE is (e.g. --name 1a2b3c4d Ana), then refresh
  tools/friends-versions.py --retire CODE... [--why TEXT]   stop listing these phones (the owner's test phones, an uninstalled copy);
                                                  logged under the table; a phone that reports again after that day comes back
  tools/friends-versions.py --offline             no backend call: rebuild the section from FRIEND_PHONES.json
  tools/friends-versions.py --from-json FILE      use FILE ({"phones": [...]}, the backend's answer) instead of the backend (tests)
  --root DIR                                      the private folder (default: found by walking up to "Friends and their versions.md")
Exit 2 when the backend cannot be reached (the section is then rebuilt from what was already kept).
"""
import datetime, json, os, re, subprocess, sys

FRIENDS_MD = "Friends and their versions.md"
START, END = "<!-- friends-versions:start -->", "<!-- friends-versions:end -->"
STALE_DAYS = 30


def find_root(start):
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, FRIENDS_MD)):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def promoted(md_path):
    """[(date, release, pin)] in the order promoted, from FRIENDS_VERSIONS.md."""
    rows = []
    if not os.path.exists(md_path):
        return rows
    for line in open(md_path, encoding="utf-8"):
        m = re.match(r"\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d+\.\d+\.\d+)\s*\|\s*([0-9a-f]{7})\s*\|", line)
        if m:
            rows.append(m.groups())
    return rows


def fetch_phones():
    cfg_path = os.environ.get("FRIENDS_COPIES_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("helper_key") or not cfg.get("api_url"):
        raise RuntimeError("config.json has no helper_key / api_url")
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "listPerfPhones", "payload": {}})
    last = "no response"
    for _ in range(3):
        out = subprocess.run(["curl", "-sL", "--max-time", "90", "-H", "Content-Type: text/plain", "--data-binary", "@-", cfg["api_url"]],
                             input=body.encode("utf-8"), capture_output=True)
        try:
            res = json.loads(out.stdout.decode("utf-8", "replace"))
        except ValueError:
            last = "bad reply (curl %s)" % out.returncode
            continue
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "API error")
        return res["data"]["phones"]
    raise RuntimeError(last)


def merge(store, phones):
    """Adds the backend's answer to what was kept: earliest first day and latest last day per release."""
    kept = store.setdefault("phones", {})
    for p in phones:
        k = kept.setdefault(p["phone"], {"label": "", "device": "", "lastSeen": "", "releases": {}})
        if (p.get("lastSeen") or "") >= k["lastSeen"]:
            k["lastSeen"], k["label"], k["device"] = p.get("lastSeen") or "", p.get("label") or "", p.get("device") or ""
        for r in p.get("releases", []):
            v = k["releases"].setdefault(r["app"], {"first": r["first"], "last": r["last"]})
            v["first"], v["last"] = min(v["first"], r["first"]), max(v["last"], r["last"])
    return store


def rows(store, promo, today):
    to_pin = {rel: pin for _, rel, pin in promo}
    newest = promo[-1][1] if promo else None
    names = store.get("names", {})
    retired = store.get("retired", {})
    out = []
    for code, p in store.get("phones", {}).items():
        if code in retired and (p["lastSeen"] or "") <= retired[code]["on"]:
            continue   # retired and not heard from since
        rels = sorted(p["releases"].items(), key=lambda kv: (kv[1]["last"], kv[1]["first"]))
        if not rels:
            continue
        cur, cv = rels[-1]
        before = rels[-2][0] if len(rels) > 1 else ""
        stale = (today - datetime.date.fromisoformat(p["lastSeen"])).days > STALE_DAYS if p["lastSeen"] else True
        if cur == newest:
            status = "✅ up to date"
        elif cur in to_pin:
            status = "⬆️ behind (newest: %s)" % newest
        else:
            status = "? not a promoted release"
        out.append({
            "code": code, "who": names.get(code) or "", "label": p["label"], "device": p["device"],
            "release": cur, "pin": to_pin.get(cur, "?"), "since": cv["first"], "updated": len(rels) > 1,
            "before": before, "lastSeen": p["lastSeen"], "status": status, "stale": stale,
        })
    out.sort(key=lambda r: (r["stale"], not r["who"], r["who"].lower(), r["lastSeen"]), reverse=False)
    return out


def retired_lines(store):
    phones = store.get("phones", {})
    out = []
    for code, r in sorted(store.get("retired", {}).items(), key=lambda kv: kv[1]["on"]):
        p = phones.get(code, {})
        back = (p.get("lastSeen") or "") > r["on"]
        out.append("- `%s` (shares as \"%s\"): not tracked since %s%s%s" % (
            code, p.get("label") or "?", r["on"], " — " + r["why"] if r.get("why") else "",
            "; ⚠️ it reported again on %s, so it is listed above" % p["lastSeen"] if back else ""))
    return out


def section(table, today, store=None):
    lines = [START, "",
             "_Written by `tools/friends-versions.py` on %s from the app-speed reports. A phone that does not share app speed does not appear; "
             "an update shows the first day the phone opened the app on it. Name a phone with `--name CODE NAME`._" % today.isoformat(), "",
             "| Person | Phone | Release (backend pin) | On it since | Before that | Last seen | |",
             "|---|---|---|---|---|---|---|"]
    for r in table:
        who = r["who"] or "unnamed (shares as \"%s\", %s)" % (r["label"] or "(no name)", r["device"] or "?")
        since = r["since"] + ("" if r["updated"] else " (first seen)")
        status = "💤 not seen in %d+ days" % STALE_DAYS if r["stale"] else r["status"]
        lines.append("| %s | `%s` | %s (%s) | %s | %s | %s | %s |" % (who, r["code"], r["release"], r["pin"], since, r["before"] or "—", r["lastSeen"], status))
    if not table:
        lines.append("| (no friend phone has shared app speed yet) | | | | | | |")
    gone = retired_lines(store or {})
    if gone:
        lines += ["", "Not tracked any more (`--retire`; a new install is a new phone and shows up again):"] + gone
    lines += ["", END]
    return "\n".join(lines)


def write_section(md_path, text):
    s = open(md_path, encoding="utf-8").read()
    if START in s and END in s:
        s = s[:s.index(START)] + text + s[s.index(END) + len(END):]
    else:
        block = "## Who is on what (automatic)\n\n" + text + "\n\n"
        at = s.find("## What friends are offered")
        s = s[:at] + block + s[at:] if at >= 0 else s.rstrip("\n") + "\n\n" + block
    open(md_path, "w", encoding="utf-8").write(s)


def main(argv):
    args = argv[1:]
    opt = lambda name: args[args.index(name) + 1] if name in args else None
    root = opt("--root") or find_root(os.getcwd()) or find_root(os.path.dirname(os.path.abspath(__file__)))
    if not root:
        sys.exit("Could not find the private folder (the one holding \"%s\"): pass --root DIR" % FRIENDS_MD)
    store_path = os.path.join(root, "FRIEND_PHONES.json")
    store = json.load(open(store_path, encoding="utf-8")) if os.path.exists(store_path) else {}
    if "--name" in args:
        i = args.index("--name")
        code, rest = args[i + 1], args[i + 2:]
        name = " ".join(rest[:next((j for j, a in enumerate(rest) if a.startswith("--")), len(rest))]).strip()
        if not name:
            sys.exit("Usage: --name CODE NAME")
        known = [c for c in store.get("phones", {}) if c.startswith(code)]
        if len(known) != 1:
            sys.exit("No single phone starts with %s (known: %s)" % (code, ", ".join(sorted(store.get("phones", {}))) or "none yet"))
        store.setdefault("names", {})[known[0]] = name
        print("Phone %s is %s." % (known[0], name))
    if "--retire" in args:
        i = args.index("--retire")
        codes = []
        for a in args[i + 1:]:
            if a.startswith("--"):
                break
            codes.append(a)
        why = opt("--why") or ""
        for c in codes:
            known = [k for k in store.get("phones", {}) if k.startswith(c)]
            if len(known) != 1:
                sys.exit("No single phone starts with %s" % c)
            store.setdefault("retired", {})[known[0]] = {"on": datetime.date.today().isoformat(), "why": why}
            print("Phone %s is no longer tracked." % known[0])
    code_ = 0
    if "--offline" not in args:
        try:
            src = opt("--from-json")
            phones = json.load(open(src, encoding="utf-8"))["phones"] if src else fetch_phones()
            merge(store, phones)
        except Exception as err:
            print("Could not ask the backend for the phones' versions: %s (showing what was already kept)" % err, file=sys.stderr)
            code_ = 2
    store["updated"] = datetime.date.today().isoformat()
    with open(store_path, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    today = datetime.date.fromisoformat(os.environ.get("FRIENDS_VERSIONS_TODAY") or datetime.date.today().isoformat())
    table = rows(store, promoted(os.path.join(root, "FRIENDS_VERSIONS.md")), today)
    text = section(table, today, store)
    write_section(os.path.join(root, FRIENDS_MD), text)
    print(text.replace(START, "").replace(END, "").strip())
    sys.exit(code_)


if __name__ == "__main__":
    main(sys.argv)
