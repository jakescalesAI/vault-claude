// Checks "Ask Quartzi" (build 11-12 c) outside Obsidian. Run: node ask.test.js [path to main.js]
const Module = require("module");
const path = require("path");
const crypto = require("crypto");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

const events = {};
const commands = [];
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return {}; }
  async saveData() {}
  registerView() {} addRibbonIcon() {} addSettingTab() {}
  addCommand(c) { commands.push(c); }
  registerEvent() {}
}
const obsidian = {
  addIcon() {}, normalizePath: (p) => p, Plugin, ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
  MarkdownRenderer: {}, MarkdownView: class {}, Platform: { isDesktopApp: false, isTablet: false }, Notice: class {}, requestUrl: async () => ({}), TFile: class {},
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "obsidian" ? obsidian : origLoad.call(this, req, ...rest); };
global.window = { crypto: crypto.webcrypto, localStorage: { getItem: () => null, setItem() {} } };

const PluginClass = require(path.resolve(process.argv[2] || path.join(__dirname, "..", "main.js")));
const { VaultClaudeView } = PluginClass.securityCore;

(async () => {
  // A stand-in chat view built from the real class's methods.
  const view = Object.create(VaultClaudeView.prototype);
  let focused = 0, toasts = [];
  Object.assign(view, {
    contextEl: null, inputEl: { focus: () => focused++, value: "" }, updateSendButton() {}, toast: (t) => toasts.push(t),
    updateContext() {}, excluded: new Set(),
  });
  let revealed = 0;
  const leaf = { view, loadIfDeferred: async () => {}, getRoot: () => null };
  const app = {
    vault: { getName: () => "V", adapter: {}, configDir: ".obsidian" },
    workspace: {
      on: (name, fn) => { events[name] = fn; return {}; }, onLayoutReady() {},
      getLeavesOfType: () => [leaf], revealLeaf: async () => { revealed++; }, rootSplit: {},
    },
    loadLocalStorage: () => null, saveLocalStorage() {},
  };
  const p = new PluginClass(app, { version: "0.9.0" });
  await p.onload();
  view.plugin = p;
  view.app = app;

  const items = [];
  const menu = { addItem: (fn) => { const it = { setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; }, onClick(f) { this.click = f; return this; } }; fn(it); items.push(it); } };
  const note = { path: "School/Classes.md", basename: "Classes" };
  check("the right-click handler is registered", typeof events["editor-menu"] === "function");
  events["editor-menu"](menu, { getSelection: () => "Waitlist CSCI 455" }, { file: note });
  check("selected text gets an Ask Quartzi item", items.length === 1 && items[0].title === "Ask Quartzi" && items[0].icon === "quartzi");
  const before = items.length;
  events["editor-menu"](menu, { getSelection: () => "   " }, { file: note });
  check("no item when nothing is selected", items.length === before);

  await items[0].click();
  await new Promise((r) => setTimeout(r, 10));
  check("clicking it opens the chat", revealed === 1);
  check("the chat holds the selected text and its note", view.asked && view.asked.text === "Waitlist CSCI 455" && view.asked.path === "School/Classes.md");
  check("the message box gets focus", focused === 1);
  const ctx = view.askedContext();
  check("the next message carries the text as the selection", ctx.selection === "Waitlist CSCI 455" && ctx.activeFile === "School/Classes.md");

  // Sending: the text goes even with open notes left out, then it is cleared.
  p.settings.sendContext = false;
  const sent = [];
  Object.assign(view, {
    inputEl: { value: "What is this?", focus() {} }, pending: [], running: false, isReady: () => true, setReply() {}, autosize() {},
    renderTray() {}, replyTo: null, enqueue() {}, startTurn: (...a) => sent.push(a),
  });
  const realSend = VaultClaudeView.prototype.send;
  // Capture the context the real send builds, without running a whole turn.
  const keys = Object.getOwnPropertyNames(VaultClaudeView.prototype);
  const next = keys.find((k) => /^(sendTurn|beginTurn|startTurn|dispatch)$/.test(k));
  let captured = null;
  if (next) view[next] = (...a) => { captured = a; };
  try { realSend.call(view); } catch (e) { /* the rest of a turn needs a live chat */ }
  const src = realSend.toString();
  check("send merges the asked text into the context", /Object\.assign\(this\.plugin\.settings\.sendContext \? this\.currentContext\(\) : \{\}, this\.askedContext\(\)\)/.test(src));
  check("the text is attached once, then cleared", view.asked === null);

  // Privacy: on another provider a private note's text is never attached.
  p.settings.provider = "openai";
  view.askAbout({ path: "6 Money/Accounts.md", basename: "Accounts" }, "balance 123");
  check("money text is not attached on other providers", !view.asked && toasts.length === 1, toasts.join(" "));
  p.settings.provider = "claude";
  view.askAbout({ path: "6 Money/Accounts.md", basename: "Accounts" }, "balance 123");
  check("on Claude it is attached, as the money rule allows", view.asked && view.asked.path === "6 Money/Accounts.md");
  p.settings.provider = "openai";
  check("switching to another provider after asking drops it", JSON.stringify(view.askedContext()) === "{}");

  const cmd = commands.find((c) => c.id === "ask-about-selection");
  check("the command needs selected text", cmd && cmd.editorCheckCallback(true, { getSelection: () => "" }, { file: note }) === false && cmd.editorCheckCallback(true, { getSelection: () => "x" }, { file: note }) === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
