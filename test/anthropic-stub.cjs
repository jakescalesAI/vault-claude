// An Anthropic-shaped provider for tests, so Anthropic API and login chats can run with no account.
// Set s.plan = [tool, input] and the next reply calls that tool.
const http = require("http");

function start() {
  const s = { calls: [], plan: null };
  s.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (/count_tokens/.test(req.url)) return json({ input_tokens: 1 });
      const body = raw ? JSON.parse(raw) : {};
      s.calls.push(body);
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (!body.stream) return json({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, o))}\n\n`);
      ev("message_start", { message: { id: `m${s.calls.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } });
      const plan = body.tools && body.tools.length ? s.plan : null;
      if (plan) {
        s.plan = null;
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${s.calls.length}`, name: plan[0], input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(plan[1]) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: plan ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise((r) => s.server.listen(0, "127.0.0.1", () => { s.base = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}

module.exports = { start };
