#!/usr/bin/env node
// Stands in for Claude Code in tests: no login, no account, no network beyond what the test starts.
// Each message posts one request to ANTHROPIC_BASE_URL, as Claude Code would, and prints the reply.
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "auth") {
  const state = process.env.FAKE_LOGIN || "yes";
  if (state === "old") { console.error("unknown command"); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: state === "yes" }));
  process.exit(state === "yes" ? 0 : 1);
}
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const record = (o) => { if (process.env.FAKE_OUT) fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify(o) + "\n"); };
const model = args[args.indexOf("--model") + 1];
const session = "s-" + process.pid;
const tools = [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const env = {};
    for (const k of Object.keys(process.env)) if (/KEY|TOKEN|ANTHROPIC|^CLAUDE/.test(k)) env[k] = process.env[k];
    record({ args, env });
    say({ type: "system", subtype: "init", session_id: session });
    if (process.env.FAKE_LOGIN === "no") { say({ type: "result", is_error: true, result: "Not logged in · Please run /login", num_turns: 1, session_id: session }); continue; }
    let text = "fake reply", isError = false;
    if (process.env.ANTHROPIC_BASE_URL) {
      const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (process.env.ANTHROPIC_AUTH_TOKEN || ""), "x-api-key": process.env.ANTHROPIC_API_KEY || "" },
        body: JSON.stringify({ model, max_tokens: 100, stream: false, system: "sys", tools, messages: [{ role: "user", content: "hi" }] }),
      });
      const j = await res.json();
      if (res.status !== 200) { isError = true; text = j.error.message; }
      else text = j.content.filter((b) => b.type === "text").map((b) => b.text).join("") || "(no text)";
    }
    if (!isError) say({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }] }, session_id: session });
    say({ type: "result", is_error: isError, result: text, num_turns: 1, session_id: session });
  }
});
