#!/usr/bin/env python3
"""
Which kept copy of the app (docs/stable-<pin>/) is a friend's phone still using?

Friends' phones that agreed to share app speed ("Help me improve the app") send the release of the screens they run
(`app_version`) with every report. FRIENDS_VERSIONS.md (private folder, written by promote.sh) says which backend pin each
promoted release belonged to. Joining the two tells which pin each phone is on, and so which kept copies are still in use.

Usage:   tools/friends-copies.py PERF_REPORTS.csv [FRIENDS_VERSIONS.md] [OUT.json]
         tools/friends-copies.py --from-backend [FRIENDS_VERSIONS.md] [OUT.json]    (automatic: asks the backend itself — promote.sh does this)
  --from-backend     calls the read-only action `listPerfAppVersions` with the Mac helper's key from ~/expense-tracker-ocr/config.json
                     (api_url + helper_key; override the file with env FRIENDS_COPIES_CONFIG). Exits 2 when it cannot get an answer.
  PERF_REPORTS.csv   the "Perf Reports" tab of the owner's Sheet, downloaded as CSV (File > Download > CSV)
  FRIENDS_VERSIONS.md  default ../FRIENDS_VERSIONS.md        OUT.json  default ../FRIENDS_COPIES.json
Writes { "updated": "YYYY-MM-DD", "pins": { "<7 letters>": { "lastSeen": "YYYY-MM-DD", "installs": n } } } and prints, for the
owner only, who is on what. The JSON holds no names. promote.sh reads it and never removes a copy a friend used in the last 30 days.
The owner's own phones (label "Owner") are left out: they run the live screens, not a kept copy.
"""
import csv, datetime, json, os, re, sys


def release_to_pin(md_path):
    pins = {}
    for line in open(md_path, encoding="utf-8"):
        m = re.match(r"\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*(\d+\.\d+\.\d+)\s*\|\s*([0-9a-f]{7})\s*\|", line)
        if m:
            pins[m.group(1)] = m.group(2)
    return pins


def newest_per_install(csv_path):
    """install_id -> (received_at, label, app_version) of its newest report."""
    latest = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            install = (row.get("install_id") or "").strip()
            at = (row.get("received_at") or "").strip()
            if not install or not at:
                continue
            if install not in latest or at > latest[install][0]:
                latest[install] = (at, (row.get("label") or "").strip(), (row.get("app_version") or "").strip())
    return latest


def build(csv_path, md_path):
    to_pin = release_to_pin(md_path)
    pins, unknown = {}, []
    for install, (at, label, release) in newest_per_install(csv_path).items():
        if label.lower() == "owner":
            continue
        pin = to_pin.get(release)
        day = at[:10]
        if not pin:
            unknown.append((label, release, day))
            continue
        p = pins.setdefault(pin, {"lastSeen": day, "installs": 0, "who": []})
        p["installs"] += 1
        p["lastSeen"] = max(p["lastSeen"], day)
        p["who"].append(label)
    return pins, unknown


def from_releases(releases, md_path):
    """Backend answer { "<release>": { installs, lastSeen } } -> same shape as build()."""
    to_pin = release_to_pin(md_path)
    pins, unknown = {}, []
    for release, v in releases.items():
        pin = to_pin.get(release)
        if not pin:
            unknown.append(("", release, v.get("lastSeen", "")))
            continue
        p = pins.setdefault(pin, {"lastSeen": v["lastSeen"], "installs": 0, "who": []})
        p["installs"] += v["installs"]
        p["lastSeen"] = max(p["lastSeen"], v["lastSeen"])
    return pins, unknown


def fetch_releases():
    import subprocess
    cfg_path = os.environ.get("FRIENDS_COPIES_CONFIG") or os.path.expanduser("~/expense-tracker-ocr/config.json")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("helper_key") or not cfg.get("api_url"):
        raise RuntimeError("config.json has no helper_key / api_url")
    body = json.dumps({"helperKey": cfg["helper_key"], "action": "listPerfAppVersions", "payload": {}})
    last = "no response"
    for attempt in range(3):
        out = subprocess.run(["curl", "-sL", "--max-time", "90", "-H", "Content-Type: text/plain", "--data-binary", "@-", cfg["api_url"]],
                             input=body.encode("utf-8"), capture_output=True)
        try:
            res = json.loads(out.stdout.decode("utf-8", "replace"))
        except ValueError:
            last = "bad reply (curl %s)" % out.returncode
            continue
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "API error")
        return res["data"]["releases"]
    raise RuntimeError(last)


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    if argv[1] == "--from-backend":
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.normpath(os.path.join(here, "..", ".."))
        md = argv[2] if len(argv) > 2 else os.path.join(root, "FRIENDS_VERSIONS.md")
        out = argv[3] if len(argv) > 3 else os.path.join(root, "FRIENDS_COPIES.json")
        try:
            pins, unknown = from_releases(fetch_releases(), md)
        except Exception as err:
            print("Could not ask the backend for the copies in use: %s" % err, file=sys.stderr)
            sys.exit(2)
        write_out(pins, unknown, out)
        return
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, "..", ".."))
    md = argv[2] if len(argv) > 2 else os.path.join(root, "FRIENDS_VERSIONS.md")
    out = argv[3] if len(argv) > 3 else os.path.join(root, "FRIENDS_COPIES.json")
    pins, unknown = build(argv[1], md)
    write_out(pins, unknown, out)


def write_out(pins, unknown, out):
    data = {"updated": datetime.date.today().isoformat(),
            "pins": {pin: {"lastSeen": v["lastSeen"], "installs": v["installs"]} for pin, v in sorted(pins.items())}}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    for pin, v in sorted(pins.items()):
        print(f"{pin}: {v['installs']} phone(s), last seen {v['lastSeen']}" + (f" ({', '.join(sorted(v['who']))})" if v["who"] else ""))
    for label, release, day in unknown:
        print(f"? {label or '(no name)'} runs release {release or '(none)'} (seen {day}), which is not in FRIENDS_VERSIONS.md: not counted")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main(sys.argv)
