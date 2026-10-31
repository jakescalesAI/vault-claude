// Loads the real plugin main.js with a stubbed "obsidian" module, starts its Host on a test
// port, and drives it like the sidebar does: auth, chat turns, resume, attachment, dictation.
// usage: node test/host-test.cjs main.js <path to a vault>   (needs Claude Code installed and logged in)
const fs = require("fs");
const [, , mainPath, vaultPath] = process.argv;
const src = fs.readFileSync(mainPath, "utf8");
class Stub {}
const obsidian = { Plugin: Stub, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownRenderer: Stub, MarkdownView: Stub, Notice: Stub, Platform: { isDesktopApp: true } };
const mod = { exports: {} };
new Function("require", "module", src + "\n;module.exports.__Host = Host;")((n) => (n === "obsidian" ? obsidian : require(n)), mod);
const Host = mod.exports.__Host;

const PORT = 8799;
const TOKEN = "TEST-CODE-1234-5678";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

function client(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const msgs = [];
    const waiters = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); msgs.push(m); waiters.forEach((w) => w()); };
    ws.onclose = () => { ws.closedFlag = true; waiters.forEach((w) => w()); };
    ws.onopen = () => {
      if (token !== undefined) ws.send(JSON.stringify({ type: "auth", token }));
      resolve({
        ws, msgs,
        until(pred, ms = 180000) {
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("timeout")), ms);
            const test = () => { const hit = msgs.find(pred); if (hit || ws.closedFlag) { clearTimeout(t); res(hit); } };
            waiters.push(test);
            test();
          });
        },
        send(o) { ws.send(JSON.stringify(o)); },
      });
    };
  });
}

function replyText(msgs) {
  return msgs.filter((m) => m.type === "event" && m.event.type === "assistant")
    .flatMap((m) => m.event.message.content.filter((c) => c.type === "text").map((c) => c.text)).join("");
}

(async () => {
  const host = new Host({ vaultPath, port: PORT, bind: "local", token: TOKEN, claudePath: "", transcribeCommand: "" }, (m) => console.log("  host:", m));
  await host.start();
  check("host started", host.servers.length === 1, host.claude);

  const anon = await client(undefined);
  await new Promise((r) => setTimeout(r, 5600));
  check("unauthenticated socket dropped after 5s", anon.ws.closedFlag === true);

  const bad = await client("WRONG");
  const badMsg = await bad.until((m) => m.type === "error");
  check("wrong code rejected", badMsg && badMsg.code === "auth");

  const c = await client(TOKEN);
  const hello = await c.until((m) => m.type === "hello", 5000);
  check("paired hello", !!hello && hello.vaultRoot === vaultPath, hello && `host=${hello.host}`);

  c.send({ type: "send", text: "Reply with exactly the word: pong", model: "haiku", effort: "low", permissionMode: "default",
    context: { activeFile: "Home.md", openFiles: ["Jakethinks video structure.md"] } });
  const done1 = await c.until((m) => m.type === "done");
  const streamed = c.msgs.some((m) => m.type === "event" && m.event.type === "stream_event");
  check("turn 1 done code 0", done1 && done1.code === 0, `session=${done1 && done1.sessionId}`);
  check("streamed partial events", streamed);
  check("reply says pong", /pong/i.test(replyText(c.msgs)), JSON.stringify(replyText(c.msgs).slice(0, 80)));

  c.msgs.length = 0;
  c.send({ type: "send", text: "What word did I just ask you to reply with? One word.", sessionId: done1.sessionId, model: "haiku", effort: "low", permissionMode: "default" });
  const done2 = await c.until((m) => m.type === "done");
  check("resume keeps the conversation", done2.code === 0 && /pong/i.test(replyText(c.msgs)), JSON.stringify(replyText(c.msgs).slice(0, 80)));

  c.msgs.length = 0;
  c.send({ type: "send", text: "What color is the attached image? Answer in one word.", model: "haiku", effort: "low", permissionMode: "default",
    attachments: [{ name: "swatch.png", mime: "image/png", data: png }] });
  const done3 = await c.until((m) => m.type === "done");
  check("attachment read", done3.code === 0 && /red/i.test(replyText(c.msgs)), JSON.stringify(replyText(c.msgs).slice(0, 80)));

  c.msgs.length = 0;
  c.send({ type: "transcribe", mime: "audio/webm", data: Buffer.from("not audio").toString("base64") });
  const tr = await c.until((m) => m.type === "transcript", 120000);
  check("dictation answers (text or a clear error)", !!tr && (typeof tr.text === "string" || /faster-whisper|transcribe|Python/i.test(tr.error || "")), JSON.stringify(tr && (tr.error || tr.text)).slice(0, 160));

  c.ws.close();
  host.stop();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
