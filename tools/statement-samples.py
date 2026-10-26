#!/usr/bin/env python3
"""
Fetch the statement samples friends' phones sent ("Send this statement"), without exporting the Sheet by hand.

Usage:   tools/statement-samples.py [OUT_FOLDER]      default OUT_FOLDER = ../Statements  (the PRIVATE folder, next to expense-tracker/)
  Asks the read-only backend action `listStatementSamples` with the Mac helper's key from ~/expense-tracker-ocr/config.json
  (api_url + helper_key; override the file with env STATEMENT_SAMPLES_CONFIG). Exits 2 when it cannot get an answer.
  Writes in OUT_FOLDER:
    Statement Samples - latest.csv   every sample received so far, same columns as the Sheet tab (+ the sheet row)
    .statement-samples-state.json    how many sheet rows were already seen, so the next run lists only the new ones
  Prints one line per NEW statement (parts joined): when, who, bank, kind, size. The text is already redacted by the phone
  (digits are 9); it is still private data: never copy it into the public repo.
"""
import csv, json, os, subprocess, sys

COLUMNS = ["row", "received_at", "install_id", "label", "bank", "kind", "language", "app_version", "part", "parts", "chars", "text"]


def call(cfg, after_row):
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "listStatementSamples", "payload": {"afterRow": after_row}})
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
        return res["data"]
    raise RuntimeError(last)


def fetch_all():
    cfg_path = os.environ.get("STATEMENT_SAMPLES_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("helper_key") or not cfg.get("api_url"):
        raise RuntimeError("config.json has no helper_key / api_url")
    rows, after = [], 1
    while True:
        data = call(cfg, after)
        rows += data["rows"]
        if data["done"]:
            return rows
        after = data["next"]


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = argv[1] if len(argv) > 1 else os.path.normpath(os.path.join(here, "..", "..", "Statements"))
    state_path = os.path.join(out_dir, ".statement-samples-state.json")
    seen = 1
    if os.path.exists(state_path):
        seen = json.load(open(state_path)).get("seenRows", 1)
    try:
        rows = fetch_all()
    except Exception as e:
        print("Could not read the statement samples: %s" % e, file=sys.stderr)
        return 2
    with open(os.path.join(out_dir, "Statement Samples - latest.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    new = [r for r in rows if r["row"] > seen]
    groups = {}
    for r in new:
        g = groups.setdefault((r["received_at"], r["install_id"], r["bank"]), [])
        g.append(r)
    if not groups:
        print("No new statement samples (%d rows in total)." % len(rows))
    for (at, _install, bank), parts in groups.items():
        kind = parts[0]["kind"]
        print("NEW  %s  %s  bank=%s  kind=%s  %d part(s), %d characters%s" % (
            at, parts[0]["label"], bank, kind, len(parts), sum(int(p["chars"] or 0) for p in parts),
            "   ** FULL VERSION: real numbers and names, private **" if kind.startswith("full-") else ""))
    with open(state_path, "w") as f:
        json.dump({"seenRows": max([r["row"] for r in rows] + [1])}, f)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
