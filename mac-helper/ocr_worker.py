#!/usr/bin/env python3
"""
Mac Mini OCR helper for the expense tracker's Telegram receipt photos.

The bot queues any receipt photo that Google's free OCR refuses. This script
(run every ~30 s by launchd) asks the Apps Script API for queued jobs, reads
each image with Tesseract (free, local — the image never goes to a third
party), and posts the recognised text back. The server then does the same
parsing and pending-entry creation it does for Google's text.

Needs: `brew install tesseract`, the Spanish model in ./tessdata, and a
config.json next to this file: {"api_url": "...", "helper_key": "..."} (or the older
"access_code" instead of "helper_key").
Outbound HTTPS only — nothing on the Mac is exposed to the internet.
"""
import base64, json, os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'config.json')))
TESSERACT = '/opt/homebrew/bin/tesseract'
ENV = dict(os.environ, TESSDATA_PREFIX=os.path.join(HERE, 'tessdata'))
# Different layout modes read different parts of a receipt best: 11 (sparse)
# catches the big stylised amount, 3 (auto) and 6 (block) catch the rest.
# The server's parser reads the joined text, first match wins.
PSM_MODES = ['11', '3', '6']


def call(action, payload=None, tries=4):
    """POST to the Apps Script API. Google sometimes answers with an empty or
    HTML body (cold start, rate limit, dropped connection), so retry a few
    times before giving up."""
    # The helper's own key (menu item 25 in the sheet) is good only for reading
    # receipt photos; the access code still works until sessions are required.
    auth = {'helperKey': CFG['helper_key']} if CFG.get('helper_key') else {'accessCode': CFG['access_code']}
    body = json.dumps(dict(auth, action=action, payload=payload or {}))
    last = 'no response'
    for attempt in range(tries):
        if attempt:
            time.sleep(3 * attempt)
        out = subprocess.run(
            ['curl', '-sL', '--max-time', '90', '-H', 'Content-Type: text/plain', '--data-binary', '@-', CFG['api_url']],
            input=body.encode('utf-8'), capture_output=True)
        text = out.stdout.decode('utf-8', 'replace')
        try:
            res = json.loads(text)
        except ValueError:
            last = 'bad reply (curl %s): %s' % (out.returncode, text[:60].strip() or 'empty')
            continue
        if not res.get('ok'):
            raise RuntimeError(res.get('error') or 'API error')
        return res.get('data')
    raise RuntimeError(last)


def ocr(path):
    texts = []
    for psm in PSM_MODES:
        r = subprocess.run([TESSERACT, path, '-', '-l', 'spa', '--psm', psm],
                           capture_output=True, env=ENV)
        texts.append(r.stdout.decode('utf-8', 'replace'))
    return '\n\n'.join(texts)


def main():
    for job in call('listPhotoJobs') or []:
        try:
            img = call('getPhotoJob', {'id': job['id']})
            ext = '.png' if 'png' in img['mime'] else '.jpg'
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                f.write(base64.b64decode(img['base64']))
                path = f.name
            try:
                text = ocr(path)
            finally:
                os.unlink(path)
            call('submitPhotoJobText', {'id': job['id'], 'text': text})
            print('done', job['id'])
        except Exception as e:  # report and carry on with the next job
            print('failed', job['id'], e, file=sys.stderr)
            try:
                call('failPhotoJob', {'id': job['id'], 'error': str(e)[:80]})
            except Exception:
                pass


if __name__ == '__main__':
    main()
