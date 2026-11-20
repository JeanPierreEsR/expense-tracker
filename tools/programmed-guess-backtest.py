#!/usr/bin/env python3
"""
Backtest of the Programmed-item category guess on the owner's REAL entries (read-only; changes nothing).

Usage:   tools/programmed-guess-backtest.py [DAYS]        default 365 (1-1095)
  Asks the backend action `programmedGuessBacktest` with the Mac helper's key from ~/expense-tracker-ocr/config.json (api_url +
  helper_key; override with env RULE_TWIN_CONFIG). Only the OWNER's copy answers.
  'old' = the live rule (amount + date), 'new' = only a payee the item was paid to before, or one sharing a word with its name.
  'reached' = expenses the merchant history did not already answer. Prints the totals, then every expense whose guess changed.
"""
import json, os, subprocess, sys


def call(cfg, days):
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "programmedGuessBacktest", "payload": {"days": days}})
    last = "no response"
    for _ in range(3):
        out = subprocess.run(["curl", "-sL", "--max-time", "300", "-H", "Content-Type: text/plain", "--data-binary", "@-", cfg["api_url"]],
                             input=body.encode("utf-8"), capture_output=True)
        try:
            res = json.loads(out.stdout.decode("utf-8", "replace"))
        except ValueError:
            last = "bad reply (curl %s)" % out.returncode
            continue
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "API error")
        return res["data"]
    raise RuntimeError(last)


def line(name, b):
    total = b["right"] + b["wrong"] + b["none"]
    return "  %-9s right %4d   wrong %4d   no guess %4d   (of %d)" % (name, b["right"], b["wrong"], b["none"], total)


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 365
    cfg_path = os.environ.get("RULE_TWIN_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    r = call(cfg, days)
    print("Confirmed expenses with a payee, last %d days: %d" % (r["days"], r["expenses"]))
    for key, title in (("reached", "Programmed step where it decides"), ("all", "Programmed step on every expense"), ("pipeline", "Whole guess (history, then Programmed)")):
        print(title + ":")
        print(line("old", r[key]["old"]))
        print(line("new", r[key]["new"]))
    print("Changed (%d shown):" % len(r["changed"]))
    for c in r["changed"]:
        print("  %s  %-28s item %-22s kept %-16s old %-5s (%s) -> new %-5s (%s)" % (
            c["date"], c["payee"][:28], c["item"][:22], c["kept"][:16], c["old"], c["oldCategory"], c["new"], c["newCategory"]))


if __name__ == "__main__":
    main()
