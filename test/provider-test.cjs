// Drives the real Host through another provider: lists models, then a chat that must use a tool.
// usage: node test/provider-test.cjs main.js <vault> provider model [mode]   (needs that provider's key in the environment)
// With no real key: node test/stub-provider.cjs 1234, then run this with provider lmstudio, model good-model.
const fs = require("fs");
const [, , mainPath, vaultPath, provider, providerModel, mode] = process.argv;
const PORT = +(process.env.P || 8798);
class Stub {}
const obsidian = { Plugin: Stub, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownRenderer: Stub, MarkdownView: Stub, Notice: Stub, Platform: { isDesktopApp: true } };
const mod = { exports: {} };
new Function("require", "module", fs.readFileSync(mainPath, "utf8") + "\n;module.exports.__Host = Host;")((n) => (n === "obsidian" ? obsidian : require(n)), mod);
(async () => {
  const host = new mod.exports.__Host({ vaultPath, port: PORT, bind: "local", token: "T", claudePath: "", transcribeCommand: "x" }, () => {});
  await host.start();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let text = "", tools = 0;
  const done = setTimeout(() => { console.log("TIMEOUT", text); process.exit(1); }, 170000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "T" }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "hello") ws.send(JSON.stringify({ type: "models" }));
    if (m.type === "models") {
      console.log("providers:", m.providers.map((p) => `${p.id}(${p.models.length})`).join(" "));
      const msg = provider === "claude" ? { model: providerModel } : { provider, providerModel };
      ws.send(JSON.stringify({ type: "send", ...msg, permissionMode: mode || "acceptEdits", text: "Use the Glob tool to count markdown files directly in the vault root (pattern *.md), then reply with just: FILES=<count>" }));
    }
    if (m.type === "error") console.log("ERROR", m.message);
    if (m.type === "event") {
      const ev = m.event;
      if (ev.type === "assistant") for (const b of ev.message.content || []) { if (b.type === "tool_use") tools++; if (b.type === "text") text += b.text; }
      if (ev.type === "result") {
        const ok = !ev.is_error && tools && /FILES=/.test(text);
        console.log(ok ? "PASS" : "FAIL", `tools=${tools}`, JSON.stringify(text.slice(-200)), ev.is_error ? String(ev.result).slice(0, 300) : "");
        clearTimeout(done); host.stop(); process.exit(ok ? 0 : 1);
      }
    }
  };
})();
