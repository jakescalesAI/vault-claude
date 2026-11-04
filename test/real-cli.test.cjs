// The real Claude Code binary through the real translator, against a stub provider. Nothing here
// reaches an account: its config folder is empty and every request goes to the stub.
// usage: node test/real-cli.test.cjs        (exit code 1 if anything fails)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start } = require("./stub-provider.cjs");

const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const FAKE_KEY = "sk-fake-test-key-0123456789";
let passed = 0, failed = 0;
const check = (name, ok, detail) => { ok ? passed++ : failed++; console.log(`${ok ? "ok" : "NOT OK"} - ${name}${!ok && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : ""}`); };

class Stub {}
const obsidian = { Plugin: Stub, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownRenderer: Stub, MarkdownView: Stub, Notice: Stub, TFile: Stub, Platform: { isDesktopApp: true }, normalizePath: (p) => p, requestUrl: async () => ({}) };
const mod = { exports: {} };
new Function("require", "module", `${src}\n;module.exports.__t = { Host, PROVIDERS };`)((n) => (n === "obsidian" ? obsidian : require(n)), mod);
const { Host, PROVIDERS } = mod.exports.__t;

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-real-"));
  const vault = path.join(tmp, "vault"), config = path.join(tmp, "config");
  fs.mkdirSync(vault);
  fs.mkdirSync(config);
  // Someone who has allowed a shell command in their settings still can't aim it at 10 Money.
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(python3 *)"] } }));
  const note = path.join(vault, "note.md");
  fs.writeFileSync(note, "the secret word is marigold\n");
  const money = path.join(vault, "10 Money", "Bank", "statement.md");
  fs.mkdirSync(path.dirname(money), { recursive: true });
  fs.writeFileSync(money, "BANKSECRET balance\n");
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1" });
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[k];

  const stub = await start();
  stub.file = note;
  stub.key = FAKE_KEY;
  for (const p of Object.values(PROVIDERS)) { if (p.env) delete process.env[p.env]; if (p.local) p.base = "http://127.0.0.1:9/v1"; }
  PROVIDERS.openai.base = stub.base;
  PROVIDERS.lmstudio.base = stub.base;
  process.env.OPENAI_API_KEY = FAKE_KEY;

  const logs = [];
  const PORT = 18791;
  const host = new Host({ vaultPath: vault, port: PORT, bind: "local", token: "T", claudePath: "/usr/local/bin/claude", transcribeCommand: "x", version: "0.9.0", logPath: "Build log.md" }, (m) => logs.push(m));
  await host.start();
  const c = await client(PORT);
  const status = await c.until((m) => m.type === "status" && m.loggedIn === false, 20000);
  check("real auth status reads as not logged in", !!status && status.warnings.some((w) => /isn't logged in/.test(w)), c.msgs);

  const turn = async (msg) => {
    c.msgs.length = 0;
    c.send(Object.assign({ type: "send", permissionMode: "acceptEdits" }, msg));
    await c.until((m) => m.type === "done");
    return c.msgs.slice();
  };
  const result = (msgs) => { const r = msgs.find((m) => m.type === "event" && m.event.type === "result"); return r ? r.event : {}; };
  const toolSteps = (msgs) => msgs.filter((m) => m.type === "event" && m.event.type === "assistant").flatMap((m) => m.event.message.content).filter((b) => b.type === "tool_use");
  const nothingLeaks = (msgs) => !JSON.stringify(msgs).includes(FAKE_KEY);

  let msgs = await turn({ provider: "openai", providerModel: "good-model", text: "What is the secret word in note.md?" });
  check("real Claude Code finishes a chat through the translator", /marigold/.test(result(msgs).result || ""), result(msgs));
  check("the tool step ran for real", toolSteps(msgs).some((b) => b.name === "Read"), msgs.map((m) => m.type));

  // 10 Money: real tool calls from the model, refused by the deny rules in every mode.
  const refusedBy = (msgs) => /denied/i.test(result(msgs).result || "") && !/BANKSECRET/.test(JSON.stringify(msgs));
  for (const permissionMode of ["acceptEdits", "default", "plan", "auto"]) {
    stub.plan = ["Read", { file_path: money }];
    msgs = await turn({ provider: "openai", providerModel: "good-model", permissionMode, text: "read it" });
    check(`Read of a 10 Money note is refused in ${permissionMode}`, refusedBy(msgs), result(msgs).result);
  }
  const moneyTools = [
    ["a relative Read", "Read", { file_path: "10 Money/Bank/statement.md" }],
    ["a path through ..", "Read", { file_path: path.join(vault, "x", "..", "10 Money", "Bank", "statement.md") }],
    ["Edit", "Edit", { file_path: money, old_string: "balance", new_string: "changed" }],
    ["Write", "Write", { file_path: path.join(vault, "10 Money", "new.md"), content: "x" }],
  ];
  for (const [name, tool, input] of moneyTools) {
    stub.plan = [tool, input];
    msgs = await turn({ provider: "openai", providerModel: "good-model", text: "go" });
    check(`${name} into 10 Money is refused`, refusedBy(msgs), result(msgs).result);
  }
  // A local model keeps its shell, so the rule naming the folder has to hold there.
  const local = { provider: "lmstudio", providerModel: "good-model", text: "go" };
  for (const [name, command] of [["Bash cat", "cat '10 Money/Bank/statement.md'"], ["an allowed shell command", "python3 -c \"print(open('10 Money/Bank/statement.md').read())\""]]) {
    stub.plan = ["Bash", { command }];
    msgs = await turn(local);
    check(`${name} into 10 Money is refused on a local model`, refusedBy(msgs), result(msgs).result);
  }

  // Outside providers have no shell at all. The search tools take over, and those honour the rules.
  const outside = { provider: "openai", providerModel: "good-model", text: "go" };
  const outsideFrom = stub.calls.length;
  stub.plan = ["Bash", { command: "grep -r SECRET ." }];
  msgs = await turn(outside);
  check("grep -r from the vault root is refused on an outside provider", !/BANKSECRET/.test(JSON.stringify(msgs)) && /no such tool|denied/i.test(result(msgs).result || ""), result(msgs).result);
  check("the chat says shell commands are off", msgs.filter((m) => m.type === "warning" && /Shell commands are off for OpenAI/.test(m.message)).length === 1, msgs.map((m) => m.type));
  for (const [name, tool, input, answer] of [
    ["Grep from the vault root", "Grep", { pattern: "SECRET", path: ".", output_mode: "content" }, /No matches/],
    ["Grep naming the folder", "Grep", { pattern: "SECRET", path: "10 Money", output_mode: "content" }, /denied/],
    ["Glob from the vault root", "Glob", { pattern: "**/*.md" }, /note\.md/],
    ["Glob naming the folder", "Glob", { pattern: "**/*", path: "10 Money" }, /denied/],
  ]) {
    stub.plan = [tool, input];
    msgs = await turn(outside);
    check(`${name} finds nothing in 10 Money`, answer.test(result(msgs).result || "") && !/BANKSECRET|statement/.test(JSON.stringify(msgs)), result(msgs).result);
  }
  stub.plan = ["Agent", { description: "search", prompt: "search the vault", subagent_type: "general-purpose" }];
  stub.next = ["Bash", { command: "grep -r SECRET ." }];
  msgs = await turn(outside);
  // The subagent runs in the background and its report comes back as one more call.
  for (let seen = -1; seen !== stub.calls.length;) { seen = stub.calls.length; await new Promise((r) => setTimeout(r, 2500)); }
  const outsideCalls = stub.calls.slice(outsideFrom);
  check("the subagent ran", new Set(outsideCalls.map((x) => x.tools.length)).size > 1, outsideCalls.length);
  check("no outside call, subagent included, is offered a shell", outsideCalls.every((x) => !x.tools.some((t) => /^(Bash|PowerShell|Monitor)$/.test(t.function.name))), outsideCalls.length);

  stub.plan = ["Bash", { command: "cat note.md" }];
  msgs = await turn(local);
  check("a local model still runs shell commands", /marigold/.test(result(msgs).result || ""), result(msgs).result);
  check("and isn't told they're off", !msgs.some((m) => m.type === "warning"), msgs.filter((m) => m.type === "warning"));

  check("nothing in 10 Money changed", fs.readFileSync(money, "utf8") === "BANKSECRET balance\n" && !fs.existsSync(path.join(vault, "10 Money", "new.md")));
  check("no 10 Money text reached the provider", !JSON.stringify(stub.calls).includes("BANKSECRET"));
  stub.plan = ["Read", { file_path: note }];
  msgs = await turn({ provider: "openai", providerModel: "good-model", text: "read it" });
  check("other notes still read after that", /marigold/.test(result(msgs).result || ""), result(msgs).result);

  msgs = await turn({ provider: "openai", providerModel: "no-tools", text: "hello" });
  check("a model with no tools still answers through the real CLI", result(msgs).result === "hello from no-tools", result(msgs));
  check("the chat is told it's text only", msgs.some((m) => m.type === "warning" && /text only/.test(m.message)), msgs.map((m) => m.type));

  msgs = await turn({ provider: "openai", providerModel: "bad-key", text: "hello" });
  const refused = result(msgs).result || (msgs.find((m) => m.type === "error") || {}).message || "";
  check("a refused key reaches the chat with the provider's name", /OpenAI refused the key/.test(refused), msgs.slice(-4));
  check("a key quoted in the error stays hidden", nothingLeaks(msgs), refused);

  msgs = await turn({ provider: "openai", providerModel: "broken", text: "hello" });
  const broke = result(msgs).result || (msgs.find((m) => m.type === "error") || {}).message || "";
  check("a provider failure names the provider", /OpenAI/.test(broke), msgs.slice(-4));

  check("no key in the host log", !logs.join("\n").includes(FAKE_KEY));

  // The same empty config has no login, which is what a logged-out computer looks like.
  msgs = await turn({ model: "haiku", effort: "low", text: "hello" });
  const noLogin = result(msgs).result || (msgs.find((m) => m.type === "error") || {}).message || "";
  check("a logged-out chat says how to fix it", /isn't logged in on/.test(noLogin), msgs.slice(-3));

  c.ws.close();
  host.stop();
  stub.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
