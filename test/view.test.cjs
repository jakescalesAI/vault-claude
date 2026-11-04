// The Copilot view in a real browser at phone width, loaded with no Node, reporting back over HTTP.
// usage: node test/view.test.cjs        (exit code 1 if anything fails, or a browser never reports)
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const cache = path.join(os.homedir(), ".cache/ms-playwright");
const find = (prefix, rel) => { try { const d = fs.readdirSync(cache).filter((n) => n.startsWith(prefix)).sort().pop(); return d ? path.join(cache, d, rel) : ""; } catch (e) { return ""; } };
const chrome = find("chromium-", "chrome-linux/chrome");

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${fs.readFileSync(path.join(root, "styles.css"), "utf8")}</style>
<style>html,body{margin:0;height:100%}#mount,#mount>div,#mount>div>div:nth-child(2){height:100%}</style></head>
<body class="is-mobile is-phone"><div id="mount"></div>
<script>window.onerror = (m, f, l) => { fetch("/report", { method: "POST", body: JSON.stringify({ ua: navigator.userAgent, width: innerWidth, results: [{ name: "the page has no script errors", ok: false, detail: m + " line " + l }] }) }); };</script>
<script>window.PLUGIN_SOURCE = ${JSON.stringify(fs.readFileSync(path.join(root, "main.js"), "utf8")).replace(/<\//g, "<\\/")};</script>
<script>${fs.readFileSync(path.join(__dirname, "view-page.js"), "utf8")}</script></body></html>`;

function run(name, launch) {
  return new Promise((resolve) => {
    let proc, timer;
    const server = http.createServer((req, res) => {
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (d) => { raw += d; });
        req.on("end", () => { res.end("ok"); finish(JSON.parse(raw)); });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/app" ? page : '<!doctype html><body style="margin:0"><iframe src="/app" width="390" height="844" style="border:0"></iframe>');
    });
    const finish = (report) => { clearTimeout(timer); try { process.kill(-proc.pid); } catch (e) { /* gone */ } server.close(); resolve(report); };
    server.listen(0, "127.0.0.1", () => {
      proc = launch(`http://127.0.0.1:${server.address().port}/`);
      timer = setTimeout(() => finish(null), 60000);
    });
  });
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-view-"));
  const browsers = [
    ["Chromium", (url) => spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=390,844", url], { stdio: "ignore", detached: true })],
  ];
  let bad = 0;
  for (const [name, launch] of browsers) {
    const report = await run(name, launch);
    if (!report) { console.log(`NOT OK - ${name} never reported`); bad++; continue; }
    console.log(`# ${name} at ${report.width}px: ${report.ua}`);
    for (const r of report.results) { if (!r.ok) bad++; console.log(`${r.ok ? "ok" : "NOT OK"} - ${r.name}${r.ok ? "" : "  " + r.detail}`); }
  }
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(bad ? `\n${bad} failed` : "\nall passed");
  process.exit(bad ? 1 : 0);
})();
