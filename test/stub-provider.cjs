// A local OpenAI-style provider for tests, streaming like the real ones. No account, no network.
// good-model reads a file with a tool, then answers. no-tools refuses tools. bad-key is a 401.
// Set s.plan = [tool, input] and the next reply calls that tool, then repeats what it got back.
// usage: require it, or: node test/stub-provider.cjs [port]
const http = require("http");

function chunk(res, o) { res.write(`data: ${JSON.stringify(o)}\n\n`); }

function start(port = 0) {
  const s = { calls: [], key: "" };
  s.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/v1/models")) return json(200, { data: ["good-model", "no-tools", "bad-key", "broken"].map((id) => ({ id })) });
      if (req.method !== "POST") return json(404, { error: { message: "not here" } });
      const body = JSON.parse(raw);
      s.calls.push(body);
      if (body.model === "bad-key") return json(401, { error: { message: `Incorrect API key provided: ${s.key}` } });
      if (body.model === "broken") return json(500, { error: { message: "upstream exploded" } });
      if (body.model === "no-tools" && body.tools) return json(400, { error: { message: "registry.ollama.ai/library/no-tools does not support tools" } });
      const toolResult = body.messages.filter((m) => m.role === "tool").pop();
      const wantsTool = body.model === "good-model" && body.tools && body.tools.some((t) => t.function.name === "Read") && !toolResult && /secret word/i.test(JSON.stringify(body.messages));
      const count = body.tools && !toolResult && /Use the Glob tool/.test(JSON.stringify(body.messages));
      if (!body.stream) return json(200, { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const plan = s.plan;
      s.plan = null;
      if (plan || wantsTool || count) {
        const [name, input] = plan || (count ? ["Glob", { pattern: "**/*.md" }] : ["Read", { file_path: s.file }]);
        chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${s.calls.length}`, type: "function", function: { name, arguments: "" } }] } }] });
        chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] } }] });
        chunk(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const said = toolResult ? `FILES=1. The file says: ${String(toolResult.content).replace(/\s+/g, " ").slice(0, 200)}` : `hello from ${body.model}`;
        chunk(res, { choices: [{ delta: { content: said } }] });
        chunk(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      chunk(res, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r, x) => {
    s.server.once("error", x);
    s.server.listen(port, "127.0.0.1", () => { s.port = s.server.address().port; s.base = `http://127.0.0.1:${s.port}/v1`; r(s); });
  });
}

module.exports = { start };
if (require.main === module) start(+(process.argv[2] || 0)).then((s) => { s.file = process.argv[3] || ""; console.log(s.base); });
