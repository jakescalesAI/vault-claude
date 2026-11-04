// Everything in 0.9.0 that doesn't need a real account: fake keys, stub providers, fake Claude Code.
// usage: node test/copilot.test.cjs        (exit code 1 if anything fails)
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "main.js"), "utf8");
const FAKE_KEY = "sk-fake-test-key-0123456789";
let passed = 0, failed = 0;
const check = (name, ok, detail) => { ok ? passed++ : failed++; console.log(`${ok ? "ok" : "NOT OK"} - ${name}${!ok && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : ""}`); };

class Stub {}
class TFile {}
const platform = { isDesktopApp: true };
const obsidian = { Plugin: class { constructor() { this.app = {}; } }, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownRenderer: Stub, MarkdownView: Stub, Notice: Stub, Platform: platform, TFile, normalizePath: (p) => p, requestUrl: async () => ({ text: "" }) };
const exportsList = "Host, PROVIDERS, isPrivate, PRIVATE_DENY, diagnose, probeFailure, versionsText, logProblem, logLine, endpointProblem, TOOLS_REFUSED, hideKey, toOpenAI, DEFAULT_SETTINGS";
const mod = { exports: {} };
let electron = null;
new Function("require", "module", `${src}\n;module.exports.__t = { ${exportsList} };`)((n) => (n === "obsidian" ? obsidian : n === "electron" ? electron || (() => { throw new Error("no electron"); })() : require(n)), mod);
const T = mod.exports.__t;
const PluginClass = mod.exports;

// ---------- a stub OpenAI-compatible provider ----------
function stubProvider() {
  const s = { calls: [], auth: [] };
  s.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      s.auth.push(req.headers.authorization || req.headers["x-api-key"] || "");
      const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/v1/models" || req.url.startsWith("/v1/models?")) {
        if (s.noList) return json(404, { error: { message: "no list" } });
        return json(200, { data: [{ id: "good-model", supported_parameters: ["tools"] }, { id: "plain-model", supported_parameters: ["temperature"] }, { id: "no-tools" }, { id: "bad-key" }, { id: "text-embedding-3" }] });
      }
      const body = JSON.parse(raw);
      s.calls.push(body);
      if (body.model === "bad-key") return json(401, { error: { message: `Incorrect API key provided: ${FAKE_KEY}` } });
      if (body.model === "rejects") return json(400, { error: { message: "context too long" } });
      if (body.model === "no-tools" && body.tools) return json(400, { error: { message: "registry.ollama.ai/library/no-tools does not support tools" } });
      json(200, { choices: [{ finish_reason: "stop", message: { content: `hello from ${body.model}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
  });
  return new Promise((r) => s.server.listen(0, "127.0.0.1", () => { s.base = `http://127.0.0.1:${s.server.address().port}/v1`; r(s); }));
}

function client(port, token = "T") {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token, version: "0.9.0" }));
      resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)), until: async (pred, ms = 8000) => { const end = Date.now() + ms; for (;;) { const hit = msgs.find(pred); if (hit) return hit; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 15)); } } });
    };
  });
}

async function turn(c, msg) {
  c.msgs.length = 0;
  c.send(Object.assign({ type: "send", text: "hi", permissionMode: "acceptEdits" }, msg));
  await c.until((m) => m.type === "done");
  return c.msgs;
}
const resultOf = (msgs) => { const r = msgs.find((m) => m.type === "event" && m.event.type === "result"); return r ? r.event : {}; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
  os.homedir = () => tmp;  // Copilot's own folder for outside chats lands here
  const fake = path.join(tmp, "claude");
  fs.copyFileSync(path.join(__dirname, "fake-claude.cjs"), fake);
  fs.chmodSync(fake, 0o755);
  const out = path.join(tmp, "out.jsonl");
  process.env.FAKE_OUT = out;
  const seen = () => fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

  const stub = await stubProvider();
  for (const k of Object.values(T.PROVIDERS)) { if (k.env) delete process.env[k.env]; if (k.local) k.base = "http://127.0.0.1:9/v1"; }
  T.PROVIDERS.openai.base = stub.base;
  T.PROVIDERS.mistral.base = stub.base;
  T.PROVIDERS.xai.base = stub.base;
  T.PROVIDERS.anthropic.base = stub.base.replace(/\/v1$/, "");
  process.env.OPENAI_API_KEY = FAKE_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  process.env.MISTRAL_API_KEY = FAKE_KEY;

  // ---------- the table ----------
  for (const id of ["anthropic", "openai", "gemini", "deepseek", "mistral", "xai", "openrouter", "groq", "ollama", "lmstudio"]) check(`provider table has ${id}`, !!T.PROVIDERS[id]);

  const customs = [
    { id: "custom-a", name: "My server", base: stub.base, keyEnv: "MY_SERVER_KEY", models: ["typed-model"] },
    { id: "custom-b", name: "Open server", base: stub.base, keyEnv: "", models: [] },
    { id: "custom-bad", name: "Leaky", base: "https://user:pw@host/v1", keyEnv: "", models: [] },
    { id: "custom-env", name: "Reads PATH", base: stub.base, keyEnv: "PATH", models: [] },
  ];
  process.env.MY_SERVER_KEY = FAKE_KEY;
  const PORT = 18790;
  const logs = [];
  const host = new T.Host({ vaultPath: tmp, port: PORT, bind: "local", token: "T", claudePath: fake, transcribeCommand: "x", getCustom: () => customs, version: "0.9.0", logPath: "Build log.md" }, (m) => logs.push(m));
  await host.start();

  // ---------- providers and keys ----------
  const c = await client(PORT);
  const hello = await c.until((m) => m.type === "hello");
  check("hello carries the host version", hello && hello.version === "0.9.0", hello);
  c.send({ type: "models" });
  const models = await c.until((m) => m.type === "models");
  const row = (id) => models.providers.find((p) => p.id === id) || {};
  check("a keyed provider is set, from the environment", row("openai").set === true && row("openai").source === "environment", row("openai"));
  check("a provider with no key shows as not set", row("deepseek").set === false && row("deepseek").models.length === 0, row("deepseek"));
  check("Anthropic models are listed live with its key header", row("anthropic").models.includes("good-model") && stub.auth.includes(FAKE_KEY), row("anthropic"));
  check("models are listed live", row("openai").models.includes("good-model"), row("openai"));
  check("embedding models stay out of the picker", !row("openai").models.includes("text-embedding-3"));
  check("the list's own no-tools flag comes through", row("openai").noTools.includes("plain-model") && !row("openai").noTools.includes("good-model"), row("openai").noTools);
  check("a custom endpoint merges its model list with the live one", row("custom-a").set && row("custom-a").models.includes("typed-model") && row("custom-a").models.includes("good-model"), row("custom-a"));
  check("a custom endpoint with no key variable needs no key", row("custom-b").set === true);
  check("a base URL holding credentials is refused", !row("custom-bad").id);
  check("a key variable that isn't a key is refused", !row("custom-env").id);
  check("a stopped local provider isn't offered", row("ollama").set === false, row("ollama"));
  check("no key in the models message", !JSON.stringify(models).includes(FAKE_KEY));

  stub.noList = true;
  c.msgs.length = 0;
  c.send({ type: "models" });
  const noList = await c.until((m) => m.type === "models");
  const handRow = noList.providers.find((p) => p.id === "openai");
  check("no model list means typed by hand, still offered", handRow.set && handRow.hand && handRow.models.length === 0, handRow);
  stub.noList = false;

  // ---------- a chat through the translator ----------
  let msgs = await turn(c, { provider: "openai", providerModel: "good-model" });
  check("a chat reaches the provider and back", resultOf(msgs).result === "hello from good-model", msgs);
  check("the key goes to the provider as a bearer token", stub.auth.includes("Bearer " + FAKE_KEY));
  let run = seen().at(-1);
  check("the provider key isn't in Claude Code's environment", !JSON.stringify(run.env).includes(FAKE_KEY), run.env);
  check("translated chats leave MCP servers off", run.args.includes("--strict-mcp-config"));
  check("the system prompt names the build log", run.args.some((a) => a.includes("Build log.md")));
  check("no key in anything sent to the device", !JSON.stringify(msgs).includes(FAKE_KEY));

  msgs = await turn(c, { provider: "openai", providerModel: "hand/typed:model@v1~x" });
  check("a hand-typed model name is used as typed", resultOf(msgs).result === "hello from hand/typed:model@v1~x", msgs);

  msgs = await turn(c, { provider: "custom-a", providerModel: "typed-model" });
  check("a custom endpoint runs a chat", resultOf(msgs).result === "hello from typed-model", msgs);

  msgs = await turn(c, { provider: "mistral", providerModel: "good-model" });
  check("Mistral runs through the same path", resultOf(msgs).result === "hello from good-model", msgs);
  check("Mistral gets no stream_options", !stub.calls.at(-1).stream_options);

  // ---------- models with no tools ----------
  stub.calls.length = 0;
  msgs = await turn(c, { provider: "openai", providerModel: "no-tools" });
  check("a model that refuses tools still answers", resultOf(msgs).result === "hello from no-tools", msgs);
  check("it was asked with tools, then again without", stub.calls.length === 2 && !!stub.calls[0].tools && !stub.calls[1].tools, stub.calls.map((x) => !!x.tools));
  const warn = msgs.filter((m) => m.type === "warning" && /text only/.test(m.message));
  check("the chat is told it's text only, once", warn.length === 1, warn);
  check("the model is told not to write tool calls", /No tools are available/.test(stub.calls[1].messages[0].content));
  stub.calls.length = 0;
  msgs = await turn(c, { provider: "openai", providerModel: "no-tools" });
  check("the next turn skips the failed try", stub.calls.length === 1 && !stub.calls[0].tools, stub.calls.length);
  stub.calls.length = 0;
  msgs = await turn(c, { provider: "openai", providerModel: "plain-model" });
  check("a model the list marks goes without tools from the start", stub.calls.length === 1 && !stub.calls[0].tools && msgs.some((m) => m.type === "warning" && /text only/.test(m.message)), stub.calls.length);
  stub.calls.length = 0;
  msgs = await turn(c, { provider: "openai", providerModel: "rejects" });
  check("another 400 isn't retried and shows the provider's words", stub.calls.length === 1 && resultOf(msgs).is_error && /OpenAI: context too long/.test(resultOf(msgs).result), resultOf(msgs));

  const bareCall = T.toOpenAI({ model: "m", tools: [{ name: "Read", input_schema: {} }], messages: [
    { role: "user", content: "read it" },
    { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "and now" }] },
  ] }, {}, new Map(), true);
  check("a text-only request carries no tool steps", !bareCall.tools && !bareCall.messages.some((m) => m.role === "tool" || m.tool_calls) && bareCall.messages.length === 4, bareCall.messages);

  for (const said of [
    "registry.ollama.ai/library/gemma:2b does not support tools",
    "No endpoints found that support tool use.",
    "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set",
    "deepseek-reasoner does not support Function Calling",
    "Function calling is not enabled for models/gemma-3-27b-it",
    "tools is not supported with this model",
    "This model doesn't support tool calling",
  ]) check(`reads as no tools: ${said.slice(0, 44)}`, T.TOOLS_REFUSED.test(said));
  for (const said of ["context too long", "Invalid value for tool_choice parameter", "tools[0].function.name must match the pattern", "model not found"]) check(`not read as no tools: ${said.slice(0, 44)}`, !T.TOOLS_REFUSED.test(said));

  // ---------- errors a person can act on ----------
  msgs = await turn(c, { provider: "openai", providerModel: "bad-key" });
  check("a refused key says so and names the provider", /OpenAI refused the key/.test(resultOf(msgs).result), resultOf(msgs));
  check("a key quoted in a provider error is hidden", !JSON.stringify(msgs).includes(FAKE_KEY) && /\[key hidden\]/.test(resultOf(msgs).result), resultOf(msgs));

  msgs = await turn(c, { provider: "deepseek", providerModel: "x" });
  check("a provider with no key says so", msgs.some((m) => m.type === "error" && /DeepSeek isn't set up/.test(m.message)), msgs);
  msgs = await turn(c, { provider: "openai", providerModel: "" });
  check("no model chosen says so instead of running on Claude", msgs.some((m) => m.type === "error" && /Choose a model for OpenAI/.test(m.message)), msgs);
  msgs = await turn(c, { provider: "openai", providerModel: "bad name; rm -rf" });
  check("a model name that isn't one is refused", msgs.some((m) => m.type === "error" && /Choose a model/.test(m.message)), msgs);

  T.PROVIDERS.xai.base = "http://127.0.0.1:9/v1";
  process.env.XAI_API_KEY = FAKE_KEY;
  msgs = await turn(c, { provider: "xai", providerModel: "good-model" });
  check("a provider that can't be reached says so", /Couldn't reach xAI Grok/.test(resultOf(msgs).result), resultOf(msgs));
  delete process.env.XAI_API_KEY;

  // ---------- Anthropic API, Claude login ----------
  await turn(c, { provider: "anthropic", providerModel: "claude-test", effort: "high" });
  run = seen().at(-1);
  check("Anthropic runs Claude Code directly with the key", run.env.ANTHROPIC_API_KEY === FAKE_KEY && !run.env.ANTHROPIC_AUTH_TOKEN, Object.keys(run.env));
  check("it keeps effort and MCP servers", run.args.includes("--effort") && run.args[run.args.indexOf("--effort") + 1] === "high" && !run.args.includes("--strict-mcp-config"), run.args);
  check("it uses the chosen model", run.args[run.args.indexOf("--model") + 1] === "claude-test");

  await turn(c, { provider: "claude", model: "sonnet", effort: "low" });
  run = seen().at(-1);
  check("Claude login chats get no provider key", !run.env.OPENAI_API_KEY && !run.env.MISTRAL_API_KEY && !run.env.MY_SERVER_KEY, Object.keys(run.env));

  // ---------- 10 Money ----------
  const denied = (a) => { const i = a.indexOf("--settings"); return i >= 0 ? JSON.parse(a[i + 1]).permissions.deny : []; };
  const covers = (a) => ["Read(./10 Money/**)", "Edit(./10 Money/**)", "Bash(*10 Money*)"].every((rule) => denied(a).includes(rule));
  check("a Claude login chat starts with the deny rules", covers(run.args), run.args);
  await turn(c, { provider: "anthropic", providerModel: "claude-test", effort: "high" });
  check("an Anthropic API chat starts with them", covers(seen().at(-1).args));
  await turn(c, { provider: "openai", providerModel: "good-model" });
  check("a translated chat starts with them", covers(seen().at(-1).args));
  await turn(c, { provider: "openai", providerModel: "good-model", permissionMode: "auto" });
  check("so does every mode", covers(seen().at(-1).args));
  check("every chat is told to stay out", seen().every((r) => r.args.some((a) => a.includes("Never read, search, list or edit the 10 Money folder"))));
  for (const p of ["10 Money/a.md", "10 Money/Bank/a.md", "10 money/a.md", "x/10 MONEY/a.md", "10 Money\\Bank\\a.md"]) check(`private: ${p}`, T.isPrivate(p));
  for (const p of ["", "note.md", "10 Moneyball/a.md", "Money/a.md", "110 Money/a.md", "10 Money.md"]) check(`not private: ${p || "(empty)"}`, !T.isPrivate(p));
  const told = host.buildPrompt({ text: "hi", context: { activeFile: "10 Money/Bank/a.md", openFiles: ["10 Money/b.md", "ok.md"], selection: "BANKTEXT" } }, []);
  check("the host drops 10 Money from the context", !/10 Money|BANKTEXT/.test(told) && /ok\.md/.test(told), told);
  const plain = host.buildPrompt({ text: "hi", context: { activeFile: "ok.md", selection: "words" } }, []);
  check("other notes keep their context", /ok\.md/.test(plain) && /words/.test(plain), plain);

  // ---------- shell on outside providers ----------
  T.PROVIDERS.lmstudio.base = stub.base;
  const shellOff = (a) => ["Bash", "PowerShell", "Read(./.trash/**)", "Edit(./.trash/**)", "Read(./.git/**)", "Read(./.obsidian/**)", "Edit(./.obsidian/**)"].every((rule) => denied(a).includes(rule));
  const shellFor = async (msg) => { const m = await turn(c, msg); const a = seen().at(-1).args; return { off: shellOff(a), told: m.some((x) => x.type === "warning" && /Shell commands are off/.test(x.message)), asked: a.some((x) => x.includes("Shell commands are off in this chat")), msgs: m }; };
  for (const [name, msg] of [["OpenAI", { provider: "openai", providerModel: "good-model" }], ["Mistral", { provider: "mistral", providerModel: "good-model" }], ["a custom endpoint at localhost", { provider: "custom-a", providerModel: "typed-model" }]]) {
    const r = await shellFor(msg);
    check(`${name}: no shell, and the chat and the model are told`, r.off && r.told && r.asked, [r.off, r.told, r.asked]);
  }
  for (const [name, msg] of [["LM Studio", { provider: "lmstudio", providerModel: "good-model" }], ["Anthropic API", { provider: "anthropic", providerModel: "claude-test", effort: "high" }], ["Claude login", { provider: "claude", model: "sonnet", effort: "low" }]]) {
    const r = await shellFor(msg);
    check(`${name}: shell stays, nothing said`, !r.off && !r.told && !r.asked, [r.off, r.told, r.asked]);
  }
  // ---------- outside chats carry none of the user's setup ----------
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/fake-socket";
  process.env.CLAUDE_CODE_GIT_BASH_PATH = "C:\\Git\\bin\\bash.exe";
  process.env.CLAUDE_CONFIG_DIR = "/tmp/users-own-config";
  const flagged = (a, name) => a.includes(name) ? a[a.indexOf(name) + 1] : null;
  await turn(c, { provider: "openai", providerModel: "other-model" });
  run = seen().at(-1);
  const ownConfig = path.join(tmp, ".quartzi-copilot", "outside-claude");
  check("an outside chat gets Copilot's own config", run.env.CLAUDE_CONFIG_DIR === ownConfig && fs.statSync(ownConfig).isDirectory(), run.env.CLAUDE_CONFIG_DIR);
  check("and none of the user's CLAUDE_CODE_ variables", !run.env.CLAUDE_CODE_MESSAGING_SOCKET && Object.keys(run.env).filter((k) => k.startsWith("CLAUDE_CODE_")).sort().join() === "CLAUDE_CODE_DISABLE_AUTO_MEMORY,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,CLAUDE_CODE_GIT_BASH_PATH", Object.keys(run.env).filter((k) => k.startsWith("CLAUDE_CODE_")));
  check("and no project or local settings, or hooks", flagged(run.args, "--setting-sources") === "user" && JSON.parse(flagged(run.args, "--settings")).disableAllHooks === true, run.args);
  for (const [name, msg] of [["LM Studio", { provider: "lmstudio", providerModel: "other-model" }], ["Anthropic API", { provider: "anthropic", providerModel: "other-model", effort: "high" }], ["Claude login", { provider: "claude", model: "opus", effort: "low" }]]) {
    await turn(c, msg);
    run = seen().at(-1);
    check(`${name} keeps the user's setup`, run.env.CLAUDE_CONFIG_DIR === "/tmp/users-own-config" && run.env.CLAUDE_CODE_MESSAGING_SOCKET === "/tmp/fake-socket" && !run.args.includes("--setting-sources") && !JSON.parse(flagged(run.args, "--settings")).disableAllHooks, run.env.CLAUDE_CONFIG_DIR);
  }
  for (const k of ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR"]) delete process.env[k];

  // ---------- selection ----------
  const promptOf = (ctx) => host.buildPrompt({ text: "hi", context: ctx }, []);
  check("a selection with no note is dropped", !promptOf({ selection: "STRAY" }).includes("STRAY"));
  check("a selection in a normal note stays", promptOf({ activeFile: "a.md", selection: "PLAIN" }).includes("PLAIN"));
  check("a selection in a note that doesn't exist yet stays", promptOf({ activeFile: "not-synced.md", selection: "PLAIN" }).includes("PLAIN"));
  const vault = tmp;
  fs.mkdirSync(path.join(vault, "10 Money"), { recursive: true });
  fs.writeFileSync(path.join(vault, "10 Money", "real.md"), "x");
  fs.symlinkSync(path.join(vault, "10 Money", "real.md"), path.join(vault, "link.md"));
  fs.symlinkSync(path.join(vault, "10 Money"), path.join(vault, "folder-link"));
  let linked = promptOf({ activeFile: "link.md", selection: "LINKED", openFiles: ["folder-link/real.md", "a.md"] });
  check("a selection in a link into 10 Money is dropped", !linked.includes("LINKED") && !linked.includes("link.md"), linked);
  check("an open note behind a linked folder is left out", !linked.includes("folder-link") && linked.includes("a.md"), linked);
  linked = promptOf({ activeFile: "folder-link/real.md", selection: "LINKED" });
  check("a selection behind a linked folder is dropped", !linked.includes("LINKED"), linked);
  fs.rmSync(path.join(vault, "link.md"));
  fs.rmSync(path.join(vault, "folder-link"));

  const first = await shellFor({ provider: "openai", providerModel: "good-model" });
  const sessionId = first.msgs.find((m) => m.type === "event" && m.event.session_id).event.session_id;
  const again = await shellFor({ provider: "openai", providerModel: "good-model", sessionId });
  check("the chat is told once, not every turn", first.told && !again.told, [first.told, again.told]);

  // Every spare timer has fired by now, including the one for the xAI key removed above.
  await new Promise((r) => setTimeout(r, 4500));
  const raw = await new Promise((r) => http.get(`http://127.0.0.1:${PORT}/status`, (res) => { let t = ""; res.on("data", (d) => { t += d; }); res.on("end", () => r(t)); }));
  const st = JSON.parse(raw);
  check("/status gives the version and nothing else", st.app === "quartzi-copilot" && st.version === "0.9.0" && Object.keys(st).length === 2, st);

  check("a wrong pairing code gets nothing", await (async () => { const b = await client(PORT, "WRONG"); const e = await b.until((m) => m.type === "error"); return e && e.code === "auth" && !b.msgs.some((m) => m.type === "hello"); })());
  check("no key in the host log", !logs.join("\n").includes(FAKE_KEY), logs);

  // Not logged in, as a chat sees it and as the host reports it.
  process.env.FAKE_LOGIN = "no";
  host.checkLogin();
  const status = await c.until((m) => m.type === "status");
  check("host reports Claude Code not logged in", status && status.loggedIn === false && status.warnings.some((w) => /isn't logged in/.test(w)), status);
  host.kill(host.spare);
  msgs = await turn(c, { provider: "claude", model: "haiku", effort: "low" });
  check("a chat says how to log in, in plain words", /isn't logged in on .*run claude, then \/login/.test(resultOf(msgs).result), resultOf(msgs));
  delete process.env.FAKE_LOGIN;

  check("This computer only is called out", host.warnings().some((w) => /This computer only/.test(w)));
  const offTailnet = Object.create(host);
  offTailnet.config = Object.assign({}, host.config, { bind: "tailscale" });
  offTailnet.addresses = ["127.0.0.1"];
  check("a host off Tailscale is called out", offTailnet.warnings().some((w) => /isn't on Tailscale/.test(w)));

  c.ws.close();
  host.stop();
  stub.server.close();

  // ---------- naming the cause ----------
  const d = (o) => T.diagnose(Object.assign({ url: "ws://100.90.1.2:8787", mobile: true, version: "0.9.0", last: null }, o));
  check("no address: set up", d({ url: "" }).cause === "setup");
  check("loopback on a phone", d({ url: "ws://127.0.0.1:8787" }).cause === "loopback");
  check("pairing wrong", d({ unpaired: true }).cause === "pairing");
  check("nothing listening: Obsidian closed", d({ probe: { refused: true } }).cause === "closed" && /Obsidian is closed/.test(d({ probe: { refused: true } }).message));
  check("no answer: asleep", d({ probe: { timeout: true } }).cause === "asleep" && /asleep/.test(d({ probe: { timeout: true } }).message));
  check("no route: Tailscale off here", d({ probe: { offline: true } }).cause === "offline" && /Tailscale/.test(d({ probe: { offline: true } }).message));
  check("no answer after the host said it left Tailscale", d({ probe: { timeout: true }, last: { version: "0.9.0", at: Date.now(), notOnTailscale: true } }).cause === "no-tailscale");
  check("host up but socket failed", d({ probe: { ok: true, version: "0.9.0" } }).cause === "socket");
  check("versions on both ends, same", /This device: 0\.9\.0\. Your computer: 0\.9\.0\./.test(d({ probe: { ok: true, version: "0.9.0" } }).message) && !/differ/.test(d({ probe: { ok: true, version: "0.9.0" } }).message));
  check("a mismatch is plain", /differ/.test(d({ probe: { ok: true, version: "0.8.5" } }).message));
  check("a host older than /status", /older than 0\.9\.0/.test(d({ probe: { ok: true, version: "" } }).message) && /differ/.test(d({ probe: { ok: true, version: "" } }).message));
  check("unreachable host shows the last version seen", /Your computer: 0\.8\.5 \(last seen/.test(d({ probe: { timeout: true }, last: { version: "0.8.5", at: Date.now() } }).message));
  check("never reached", /not reached yet/.test(d({ probe: { timeout: true } }).message));
  check("probe: refused", T.probeFailure("net::ERR_CONNECTION_REFUSED", 4000).refused === true);
  check("probe: iOS could not connect", T.probeFailure("Could not connect to the server.", 300).refused === true);
  check("probe: offline wins over speed", T.probeFailure("The Internet connection appears to be offline.", 10).offline === true);
  check("probe: timed out", T.probeFailure("The request timed out.", 60000).timeout === true);
  check("probe: unknown and fast", T.probeFailure("boom", 200).refused === true);
  check("probe: unknown and slow", T.probeFailure("boom", 4000).timeout === true);

  // ---------- build log ----------
  check("the default log path is allowed", T.logProblem(T.DEFAULT_SETTINGS.logPath) === "");
  for (const bad of ["10 Money/log.md", "10 money/a/log.md", "x/10 MONEY/log.md", "../log.md", "log.txt", "", "a//b.md"]) check(`log path refused: ${bad || "(empty)"}`, T.logProblem(bad) !== "");
  const when = new Date(2026, 10, 4, 9, 5);
  check("a log line is a plain dated bullet", T.logLine("shipped 0.9.0", when, "0.9.0", "iPad") === "- 2026-11-04 09:05 · shipped 0.9.0 · Copilot 0.9.0, iPad", T.logLine("shipped 0.9.0", when, "0.9.0", "iPad"));
  check("a checkbox can't get in", !/\[ ?\]/.test(T.logLine("- [ ] do\nthing", when, "0.9.0", "iPad")), T.logLine("- [ ] do\nthing", when, "0.9.0", "iPad"));

  const fakePlugin = () => {
    const store = {}, disk = [];
    const p = new PluginClass();
    p.manifest = { version: "0.9.0" };
    p.settings = Object.assign({}, T.DEFAULT_SETTINGS);
    p.app = { loadLocalStorage: (k) => store[k] ?? null, saveLocalStorage: (k, v) => { store[k] = v; } };
    p.saveData = async (d) => { disk.push(JSON.stringify(d)); };
    return { p, store, disk };
  };

  const notes = new Map();
  const { p: logger } = fakePlugin();
  const made = [];
  logger.app.vault = {
    getAbstractFileByPath: (x) => notes.get(x) || null,
    createFolder: async (x) => { made.push(x); notes.set(x, {}); },
    create: async (x, text) => { const f = new TFile(); f.text = text; notes.set(x, f); return f; },
    process: async (f, fn) => { f.text = fn(f.text); },
  };
  await logger.appendLog("first");
  await logger.appendLog("second");
  const logFile = notes.get(T.DEFAULT_SETTINGS.logPath);
  check("the log note is created, then added to", logFile && logFile.text.split("\n").filter((l) => l.startsWith("- ")).length === 2 && /^# Build log\n\n- /.test(logFile.text), logFile && logFile.text);
  check("its folder is made when missing", made[0] === "0 Home/0 Quartzi Copilot");
  logger.settings.logPath = "10 Money/log.md";
  check("a log in 10 Money is refused at write time", await logger.appendLog("x").then(() => false, (e) => /10 Money/.test(e.message)));

  // ---------- keys at rest ----------
  electron = { safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("sealed:" + Buffer.from(t).toString("hex")), decryptString: (b) => Buffer.from(b.toString().replace("sealed:", ""), "hex").toString() } };
  const k = fakePlugin();
  k.p.setKey("openai", FAKE_KEY);
  await k.p.saveSettings();
  check("a saved key reads back", k.p.getKey("openai") === FAKE_KEY);
  check("it's sealed in local storage", !JSON.stringify(k.store).includes(FAKE_KEY) && k.p.keySource("openai") === "keychain", k.store);
  check("data.json never holds it", !k.disk.join("").includes(FAKE_KEY) && !JSON.stringify(k.p.settings).includes(FAKE_KEY));
  k.p.setKey("openai", "");
  check("Clear removes it", k.p.getKey("openai") === "" && k.p.keySource("openai") === "");

  const m8 = fakePlugin();
  m8.store["vault-claude-provider-deepseek"] = FAKE_KEY;
  m8.store["vault-claude-provider-custom-url"] = "https://old.example/v1";
  m8.store["vault-claude-provider-custom"] = FAKE_KEY;
  m8.p.migrateKeys();
  check("0.8.0 keys move into the keychain", m8.p.getKey("deepseek") === FAKE_KEY && !JSON.stringify(m8.store).includes(FAKE_KEY), m8.store);
  check("the 0.8.0 custom address becomes an endpoint with its key", m8.p.customs()[0].base === "https://old.example/v1" && m8.p.getKey("custom") === FAKE_KEY, m8.p.customs());
  m8.p.migrateKeys();
  check("migrating twice changes nothing", m8.p.customs().length === 1);

  electron = null;
  const nk = fakePlugin();
  check("no keychain: nothing to save into", nk.p.keychain() === null);
  nk.p.setKey("openai", FAKE_KEY);
  check("no keychain: a key isn't stored in the clear", !JSON.stringify(nk.store).includes(FAKE_KEY) && nk.p.getKey("openai") === "", nk.store);
  const legacy = fakePlugin();
  legacy.store["vault-claude-provider-groq"] = FAKE_KEY;
  check("no keychain: an old plain key still works and is flagged", legacy.p.getKey("groq") === FAKE_KEY && legacy.p.keySource("groq") === "plain");

  // ---------- phone load: no Node at all ----------
  platform.isDesktopApp = false;
  const phone = fakePlugin();
  check("a phone has no keychain and no key access", phone.p.keychain() === null && phone.p.hostEnabled() === false);
  platform.isDesktopApp = true;
  const box = { window: {}, console };
  const sandbox = vm.createContext(box);
  let asked = [];
  box.require = (n) => { asked.push(n); if (n !== "obsidian") throw new Error("Node module on mobile: " + n); return Object.assign({}, obsidian, { Platform: { isDesktopApp: false, isMobile: true, isTablet: false }, addIcon: () => {}, Plugin: class { constructor() { this.app = { workspace: { onLayoutReady() {} }, loadLocalStorage() { return null; } }; } async loadData() { return {}; } registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} } }); };
  box.module = { exports: {} };
  vm.runInContext(src, sandbox);
  const mobile = new box.module.exports();
  await mobile.onload();
  check("loads with no Node: only obsidian was required", asked.length === 1 && asked[0] === "obsidian", asked);
  check("no host on mobile", mobile.host === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
