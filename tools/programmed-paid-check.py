#!/usr/bin/env python3
"""
Which transactions the Programmed items screen counts as each item's payment, on the owner's REAL entries (read-only).

Usage:   tools/programmed-paid-check.py [DAYS]        default 365 (1-1095)
  Asks the backend action `programmedPaidCheck` with the Mac helper's key (~/expense-tracker-ocr/config.json, as
  rule-twin-check.py). Only the OWNER's copy answers. Per payment: linked by hand, payee alike the item (its name or its usual
  payee), no payee on record, or suspect (a payee that fits neither). Prints totals, per item, then every suspect.
"""
import json, os, subprocess, sys


def call(cfg, days):
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "programmedPaidCheck", "payload": {"days": days}})
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


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 365
    cfg_path = os.environ.get("RULE_TWIN_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    r = call(cfg, days)
    print("Last %d days: %d items, %d payments counted: linked %d, payee alike %d, no payee %d, SUSPECT %d" % (
        r["days"], r["items"], r["payments"], r["linked"], r["alike"], r["noPayee"], r["suspect"]))
    print("Per item:")
    for i in sorted(r["perItem"], key=lambda x: -x["suspect"]):
        print("  %-26s %-14s payments %3d  linked %2d  alike %3d  no payee %3d  suspect %3d" % (
            i["item"][:26], i["category"][:14], i["payments"], i["linked"], i["alike"], i["noPayee"], i["suspect"]))
    print("Suspects:")
    for s in r["suspects"]:
        print("  %s  for %s  %-24s payee %-28s (%s)" % (s["date"], s["month"], s["item"][:24], s["payee"][:28], s["description"][:30]))


if __name__ == "__main__":
    main()
