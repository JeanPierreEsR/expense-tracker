// Serves the real frontend (docs/) on http://localhost:4180 wired to the FAKE
// backend (real .gs code + made-up data held in memory). Nothing touches Google,
// Telegram or the owner's real data. In the app, use access code:  test-access-code
//   node tests/harness/server.js            (SEED_ENTRIES=7000 by default)
// POST /__reset re-creates the made-up data from scratch.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createRuntime, ACCESS_CODE } = require("./gas-runtime");
const { seedData } = require("./seed");

const PORT = Number(process.env.PORT || 4180);
const DOCS = path.join(__dirname, "..", "..", "docs");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

let rt, data;
function boot() {
  rt = createRuntime();
  data = seedData(rt, { entries: Number(process.env.SEED_ENTRIES || 7000) });
}
boot();

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "POST" && url === "/api") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = rt.rawPost(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
    return;
  }
  if (req.method === "POST" && url === "/__reset") { boot(); res.end("reset"); return; }
  if (url === "/__info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accessCode: ACCESS_CODE, friends: data.friends.map((f) => f.name) }));
    return;
  }
  let file = path.join(DOCS, url === "/" ? "index.html" : url);
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  let buf = fs.readFileSync(file);
  if (path.basename(file) === "app.js") {
    // Point the app at the fake backend instead of the real Apps Script URL.
    buf = Buffer.from(buf.toString().replace(/const API_URL = "[^"]*";/, 'const API_URL = "/api";'));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(buf);
}).listen(PORT, () => console.log(`Fake app on http://localhost:${PORT}  (access code: ${ACCESS_CODE}) — ${data.entries.length} made-up entries`));
