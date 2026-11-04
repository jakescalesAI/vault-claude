// Outside-provider chats on real Claude Code: what must never reach the provider.
// Every outside chat runs against one stub, so anything on that stub is what a third party would get.
// usage: node test/outside.test.cjs                 a planted user config, no account
//        node test/outside.test.cjs --root-config   this machine's real user config, read only
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start } = require("./stub-provider.cjs");
const anthropicStub = require("./anthropic-stub.cjs").start;

class Stub {}
const obsidian = { Plugin: Stub, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownRenderer: Stub, MarkdownView: Stub, Notice: Stub, TFile: Stub, Platform: { isDesktop: true, isMobile: false } };
const mod = { exports: {} };
new Function("require", "module", fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8") + "\n;module.exports.__t = { Host, PROVIDERS };")(
  (n) => (n === "obsidian" ? obsidian : require(n)), mod);
const { Host, PROVIDERS } = mod.exports.__t;

const rootConfig = process.argv.includes("--root-config");
const SECRET = /BANKSECRET|NESTSECRET|TRASHSECRET/;
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log("ok -", name); }
  else { failed++; console.log("NOT OK -", name, detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300)); }
}

function client(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: "T", version: "0.9.0" }));
      resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)), until: async (pred, ms = 90000) => { const end = Date.now() + ms; for (;;) { const hit = msgs.find(pred); if (hit) return hit; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 25)); } } });
    };
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-outside-"));
  const vault = path.join(tmp, "vault");
  const write = (file, text) => { const p = path.join(vault, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  write("note.md", "the secret word is marigold\n");
  write("0 Home/ok.md", "plain nested note\n");
  write("10 Money/Bank/statement.md", "BANKSECRET balance\n");
  write("0 Home/10 Money/nested.md", "NESTSECRET a\n");
  write("0 Home/10 MONEY/upper.md", "NESTSECRET b\n");
  write(".trash/old.md", "TRASHSECRET old statement\n");
  const git = (args) => cp.execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: vault }).toString().trim();
  git(["init", "-q"]); git(["add", "-A"]); git(["commit", "-qm", "x"]);
  const blob = git(["rev-parse", "HEAD:10 Money/Bank/statement.md"]);

  // The user's Claude Code setup: planted, or this machine's own.
  const real = path.join(os.homedir(), ".claude");
  const config = rootConfig ? process.env.CLAUDE_CONFIG_DIR || real : path.join(tmp, "config");
  const markers = [];
  let extraFile = null;
  if (rootConfig) {
    const firstLine = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").find((l) => l.trim().length > 12); } catch (e) { return null; } };
    const settings = JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8"));
    const extra = ((settings.permissions || {}).additionalDirectories || [])[0];
    if (extra) { const f = fs.readdirSync(extra).find((n) => n.endsWith(".md")); if (f) extraFile = path.join(extra, f); }
    markers.push(firstLine(path.join(config, "CLAUDE.md")), extraFile && firstLine(extraFile));
    const memory = path.join(config, "projects");
    for (const d of fs.readdirSync(memory)) { const m = firstLine(path.join(memory, d, "memory", "MEMORY.md")); if (m) markers.push(m); }
  } else {
    const extra = path.join(tmp, "extra");
    fs.mkdirSync(extra);
    extraFile = path.join(extra, "extra.md");
    fs.writeFileSync(extraFile, "EXTRADIRMARKER\n");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, "CLAUDE.md"), "USERMEMORYMARKER\n");
    // Logged in, as most computers are: local chats have to work anyway.
    fs.writeFileSync(path.join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-login-token", refreshToken: "fake", expiresAt: Date.now() + 864e5, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
    fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [extra] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo USERHOOKMARKER" }] }] } }));
    process.env.CLAUDE_CONFIG_DIR = config;
    markers.push("USERMEMORYMARKER", "USERHOOKMARKER", "EXTRADIRMARKER");
  }
  const marks = markers.filter(Boolean);
  // A chat on this computer keeps its hooks, so in root mode the local chats here switch them off for this vault only.
  const guard = () => { if (rootConfig) write(".claude/settings.local.json", JSON.stringify({ disableAllHooks: true })); };
  guard();
  // Copilot's own folder lands in the test's temp folder, while Claude Code still sees the real home.
  os.homedir = () => tmp;
  Object.assign(process.env, { DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[k];

  const stub = await start();
  const near = await start();
  const anth = await anthropicStub();
  for (const p of Object.values(PROVIDERS)) { if (p.env) delete process.env[p.env]; if (p.local) p.base = "http://127.0.0.1:9/v1"; }
  PROVIDERS.openai.base = stub.base;
  PROVIDERS.xai.base = stub.base;
  PROVIDERS.ollama.base = near.base;
  PROVIDERS.anthropic.base = anth.base;
  process.env.OPENAI_API_KEY = "fake-openai-key-0000000000";
  process.env.XAI_API_KEY = "fake-xai-key-0000000000";

  const PORT = rootConfig ? 18793 : 18792;
  const host = new Host({ vaultPath: vault, port: PORT, bind: "local", token: "T", claudePath: process.env.CLAUDE_PATH || "claude", transcribeCommand: "x", version: "0.9.0", logPath: "Build log.md", log() {} });
  await host.start();
  const c = await client(PORT);
  await c.until((m) => m.type === "status", 20000);

  const openai = { provider: "openai", providerModel: "good-model", text: "go" };
  const turn = async (msg) => {
    c.msgs.length = 0;
    c.send(Object.assign({ type: "send", permissionMode: "acceptEdits" }, openai, msg));
    await c.until((m) => m.type === "done");
    return c.msgs.slice();
  };
  const said = (msgs) => { const r = msgs.find((m) => m.type === "event" && m.event.type === "result"); return r ? r.event.result || "" : ""; };
  const sidOf = (msgs) => msgs.find((m) => m.type === "done").sessionId;
  const reached = (re) => re.test(JSON.stringify(stub.calls));
  const has = (s) => JSON.stringify(stub.calls).includes(JSON.stringify(s).slice(1, -1));

  // ---------- what a plain chat carries ----------
  let msgs = await turn({ text: "hello" });
  const tools = stub.calls.at(-1).tools.map((t) => t.function.name);
  check("the chat runs", /hello from good-model/.test(said(msgs)), msgs.map((m) => m.type));
  check("no MCP tools, AgentHub included", !tools.some((n) => n.startsWith("mcp__")), tools);
  check("no shell tools", !tools.some((n) => /^(Bash|PowerShell|Monitor)$/.test(n)), tools);
  check("the user's config has text to find", marks.length >= (rootConfig ? 1 : 3), marks);
  for (const m of marks) check(`user config stays out: ${m.slice(0, 40)}`, !has(m));
  if (extraFile) {
    stub.plan = ["Read", { file_path: extraFile }];
    msgs = await turn({});
    check("a folder from the user's settings is out of reach", /permission|denied/i.test(said(msgs)), said(msgs));
  }

  // ---------- switching a chat to an outside provider ----------
  const sources = [["Ollama", near, { provider: "ollama", providerModel: "good-model" }, "Bash", { command: "grep -r SECRET ." }]];
  if (!rootConfig) {
    sources.push(["the Anthropic API", anth, { provider: "anthropic", providerModel: "good-model", effort: "low" }, "Bash", { command: "grep -r SECRET ." }]);
    sources.push(["Claude login", anth, { provider: "claude", model: "haiku", effort: "low" }, "Bash", { command: "grep -r SECRET ." }]);
  }
  let lastSid = null;
  for (const [name, from, msg, tool, input] of sources) {
    const login = name === "Claude login";
    const api = name === "the Anthropic API";
    if (api) process.env.ANTHROPIC_API_KEY = "fake-anthropic-key-0000000000";
    if (login) Object.assign(process.env, { ANTHROPIC_API_KEY: "fake-anthropic-key-0000000000", ANTHROPIC_BASE_URL: anth.base });
    const before = from.calls.length;
    from.plan = [tool, input];
    msgs = await turn(Object.assign({ text: `OLDCHATMARKER ${name}` }, msg));
    const sid = sidOf(msgs);
    lastSid = sid;
    check(`control: ${name} found the secret`, !!sid && /BANKSECRET/.test(JSON.stringify(from.calls.slice(before))), said(msgs));
    if (login) { delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; }
    const calls = stub.calls.length;
    msgs = await turn({ sessionId: sid, text: "carry on" });
    const notice = msgs.find((m) => m.type === "notice");
    check(`${name} to outside: the chat says it started fresh`, !!notice && /new conversation/i.test(notice.message) && /weren't sent to OpenAI/.test(notice.message), msgs.map((m) => m.type));
    check(`${name} to outside: the turn still answers`, /hello from good-model/.test(said(msgs)), said(msgs));
    check(`${name} to outside: a new session`, sidOf(msgs) && sidOf(msgs) !== sid, sidOf(msgs));
    const sent = JSON.stringify(stub.calls.slice(calls));
    check(`${name} to outside: no old message or secret reaches the provider`, calls < stub.calls.length && !/OLDCHATMARKER/.test(sent) && !SECRET.test(sent));
  }

  // ---------- old transcripts ----------
  const findTranscript = (dir, sid) => {
    for (const d of fs.readdirSync(path.join(dir, "projects"))) { const f = path.join(dir, "projects", d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
    return null;
  };
  const transcript = findTranscript(config, lastSid);
  check("control: the old transcript is on disk", !!transcript && /OLDCHATMARKER/.test(fs.readFileSync(transcript, "utf8")));
  stub.plan = ["Read", { file_path: transcript }];
  msgs = await turn({});
  check("a new outside chat can't read the old transcript", /permission|denied/i.test(said(msgs)) && !/OLDCHATMARKER/.test(JSON.stringify(stub.calls.at(-1))), said(msgs));
  stub.plan = ["Glob", { pattern: "*.jsonl", path: path.dirname(transcript) }];
  msgs = await turn({});
  check("or list it", !said(msgs).includes(lastSid), said(msgs));
  stub.plan = ["Grep", { pattern: "CHATMARKER", path: path.dirname(transcript), output_mode: "content" }];
  msgs = await turn({});
  check("or search it", !said(msgs).includes("OLDCHATMARKER"), said(msgs));

  // ---------- outside to outside ----------
  msgs = await turn({ text: "OUTSIDEMARKER first" });
  const outsideSid = sidOf(msgs);
  msgs = await turn({ provider: "xai", sessionId: outsideSid, text: "second" });
  check("outside to outside resumes", !msgs.some((m) => m.type === "notice") && /OUTSIDEMARKER/.test(JSON.stringify(stub.calls.at(-1).messages)), msgs.map((m) => m.type));
  msgs = await turn({ provider: "ollama", sessionId: sidOf(msgs), text: "third" });
  check("outside to a local model starts fresh and says so", msgs.some((m) => m.type === "notice" && /new conversation/i.test(m.message)), msgs.map((m) => m.type));

  // ---------- settings in the vault ----------
  // A spare chat started before the file was written wouldn't prove anything.
  const fresh = () => { if (host.spare) { host.kill(host.spare); host.spare = null; } };
  const hook = (cmd) => ({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }], SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });
  const cat = "cat '10 Money/Bank/statement.md'";
  for (const file of ["settings.json", "settings.local.json"]) {
    write(`.claude/${file}`, JSON.stringify(hook(cat)));
    if (!rootConfig) {
      const before = near.calls.length;
      fresh();
      await turn({ provider: "ollama", text: "hi" });
      check(`control: a local chat runs the ${file} hook`, /BANKSECRET/.test(JSON.stringify(near.calls.slice(before))));
    }
    fresh();
    await turn({ text: "hi" });
    check(`a hook in the vault's ${file} doesn't run`, !reached(SECRET));
    fs.rmSync(path.join(vault, ".claude"), { recursive: true });
    guard();
  }
  write(".claude/settings.json", JSON.stringify({ permissions: { deny: [], additionalDirectories: [path.dirname(extraFile)] } }));
  fresh();
  stub.plan = ["Read", { file_path: extraFile }];
  msgs = await turn({});
  check("the vault's settings can't add a folder", /permission|denied/i.test(said(msgs)), said(msgs));
  fs.rmSync(path.join(vault, ".claude"), { recursive: true });
  guard();
  write("CLAUDE.md", "VAULTMDMARKER\n@10 Money/Bank/statement.md\n");
  fresh();
  await turn({ text: "hi" });
  check("the vault's CLAUDE.md isn't loaded, so its import goes nowhere", !reached(SECRET) && !reached(/VAULTMDMARKER/));
  fs.rmSync(path.join(vault, "CLAUDE.md"));

  // ---------- the trash, git history and nested folders ----------
  for (const [name, tool, input, answer] of [
    ["Read of the trash", "Read", { file_path: ".trash/old.md" }, /denied/],
    ["Grep from the root skips the trash", "Grep", { pattern: "SECRET", path: ".", output_mode: "content" }, /No matches/],
    ["Grep of the trash", "Grep", { pattern: "SECRET", path: ".trash", output_mode: "content" }, /denied/],
    ["Glob of the trash", "Glob", { pattern: "**/*", path: ".trash" }, /denied/],
    ["Edit of the trash", "Edit", { file_path: ".trash/old.md", old_string: "old", new_string: "new" }, /denied/],
    ["Read of a git object", "Read", { file_path: `.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}` }, /denied/],
    ["Read of the git index", "Read", { file_path: ".git/index" }, /denied/],
    ["Glob of git objects", "Glob", { pattern: "**/*", path: ".git/objects" }, /denied/],
    ["Read of a nested folder", "Read", { file_path: "0 Home/10 Money/nested.md" }, /denied/],
    ["Read of a nested folder in capitals", "Read", { file_path: "0 Home/10 MONEY/upper.md" }, /denied/],
    ["Grep of a nested folder", "Grep", { pattern: "SECRET", path: "0 Home/10 Money", output_mode: "content" }, /denied/],
    ["Edit of a nested folder", "Edit", { file_path: "0 Home/10 Money/nested.md", old_string: "a", new_string: "b" }, /denied/],
    ["Write into a nested folder", "Write", { file_path: "0 Home/10 Money/new.md", content: "x" }, /denied/],
    ["control: Read beside the nested folder", "Read", { file_path: "0 Home/ok.md" }, /plain nested note/],
  ]) {
    stub.plan = [tool, input];
    msgs = await turn({});
    check(name, answer.test(said(msgs)) && !SECRET.test(said(msgs)), said(msgs));
  }
  check("nothing in the nested folder changed", fs.readFileSync(path.join(vault, "0 Home/10 Money/nested.md"), "utf8") === "NESTSECRET a\n" && !fs.existsSync(path.join(vault, "0 Home/10 Money/new.md")));
  check("the trash is unchanged", fs.readFileSync(path.join(vault, ".trash/old.md"), "utf8").includes("old statement"));

  // ---------- Obsidian's own folder ----------
  write(".obsidian/plugins/vault-claude/data.json", '{"token":"FAKEPAIRING"}');
  write(".obsidian/plugins/other/main.js", "// plugin code\n");
  for (const [name, tool, input, answer] of [
    ["Read of plugin data", "Read", { file_path: ".obsidian/plugins/vault-claude/data.json" }, /denied/],
    ["Grep of plugin data", "Grep", { pattern: "PAIRING", path: ".", output_mode: "content", glob: "*.json" }, /No matches/],
    ["Edit of plugin code", "Edit", { file_path: ".obsidian/plugins/other/main.js", old_string: "plugin", new_string: "changed" }, /denied/],
  ]) {
    stub.plan = [tool, input];
    msgs = await turn({});
    check(name, answer.test(said(msgs)), said(msgs));
  }
  check("no plugin data reached the provider", !reached(/FAKEPAIRING/));
  check("plugin code is unchanged", fs.readFileSync(path.join(vault, ".obsidian/plugins/other/main.js"), "utf8") === "// plugin code\n");

  // Other chats on this computer use another config, so an outside chat can't see them.
  stub.plan = ["ListAgents", {}];
  msgs = await turn({});
  console.log("info - ListAgents:", said(msgs).replace(/\s+/g, " ").slice(0, 160));

  // ---------- everything the provider ever saw ----------
  check("no 10 Money, trash or nested text reached the outside stub", !reached(SECRET));
  check("no old transcript text reached it", !reached(/OLDCHATMARKER/));
  for (const m of marks) check(`no user config text reached it: ${m.slice(0, 40)}`, !has(m));

  c.ws.close();
  host.stop();
  for (const s of [stub, near, anth]) s.server.close();
  // The temp vault's own transcript folder is the only thing a root run leaves in the real config.
  if (rootConfig && transcript && path.basename(path.dirname(transcript)).includes(path.basename(tmp))) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
