#!/usr/bin/env python3
"""
Compare each pack twin with the code rule it replaces, on the owner's REAL mailbox (the gate before a bank moves from code to the rule pack).

Usage:   tools/rule-twin-check.py [DAYS]        default 30 (1-90)
  Asks the read-only backend action `rulePackTwinCheck` with the Mac helper's key from ~/expense-tracker-ocr/config.json (api_url + helper_key;
  override the file with env RULE_TWIN_CONFIG). Only the OWNER's copy answers; it changes nothing.
  Prints one line per twin: e-mails seen, read the same, read differently (which fields), only the code rule matches, only the twin matches.
  The answer holds no amount, name or number: field names, counts, and the subject's wording with its digits hidden.
  A twin is ready to go in front of its code rule (`first`) when: same = emails, and different, only code, only twin are all 0.
"""
import json, os, subprocess, sys


def call(cfg, days):
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "rulePackTwinCheck", "payload": {"days": days}})
    last = "no response"
    for _ in range(3):
        out = subprocess.run(["curl", "-sL", "--max-time", "120", "-H", "Content-Type: text/plain", "--data-binary", "@-", cfg["api_url"]],
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
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    cfg_path = os.environ.get("RULE_TWIN_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        if not cfg.get("helper_key") or not cfg.get("api_url"):
            raise RuntimeError("config.json has no api_url / helper_key")
        data = call(cfg, days)
    except Exception as e:  # noqa: BLE001 - one plain message, exit code 2
        print("Could not get an answer: %s" % e, file=sys.stderr)
        sys.exit(2)
    print("\n".join(render(data)))


def render(data):
    lines = ["Twin check over the last %d days" % data["days"]]
    ready = 0
    for t in data["twins"]:
        if not t["codeRuleFound"]:
            lines.append("  ! %s: no code rule called \"%s\"" % (t["id"], t["replaces"]))
            continue
        same = t["emails"] > 0 and t["both"] == t["emails"] and t["different"] == 0 and not t["ruleAttributesDiffering"]
        ready += 1 if same else 0
        lines.append("  %s %-34s emails %3d | same %3d | different %2d %s | only code %2d | only twin %2d%s" % (
            "OK " if same else "...", t["id"], t["emails"], t["identical"], t["different"],
            ("(" + ",".join(sorted(t["fieldsDiffering"])) + ")") if t["fieldsDiffering"] else "", t["onlyCode"], t["onlyTwin"],
            (" | RULE ATTRIBUTES DIFFER: " + ",".join(t["ruleAttributesDiffering"])) if t["ruleAttributesDiffering"] else ""))
        for ex in t["examples"]:
            extra = (" -> would take it from: " + ex["wouldTakeFrom"]) if ex.get("wouldTakeFrom") else (" fields: " + ",".join(ex["fields"]) if ex.get("fields") else "")
            lines.append("       %s: \"%s\"%s" % (ex["kind"], ex["subject"], extra))
    lines.append("%d of %d twins read every e-mail they saw exactly like their code rule (a twin with no e-mail in the window proves nothing yet)." % (ready, len(data["twins"])))
    return lines


if __name__ == "__main__":
    main()
