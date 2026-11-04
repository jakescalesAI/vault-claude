// Runs in a real browser: the plugin as a phone would load it, with a fake socket and a fake vault.
(async () => {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : String(detail === undefined ? "" : detail).slice(0, 300) });
  const P = Node.prototype, H = HTMLElement.prototype;
  const make = (tag, o, parent) => {
    const el = document.createElement(tag);
    if (typeof o === "string") o = { cls: o };
    o = o || {};
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
    if (o.text !== undefined) el.textContent = o.text;
    for (const [k, v] of Object.entries(o.attr || {})) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };
  window.createEl = (tag, o) => make(tag, o);
  window.createDiv = (o) => make("div", o);
  window.createSpan = (o) => make("span", o);
  Object.assign(H, {
    createEl(tag, o) { return make(tag, o, this); },
    createDiv(o) { return make("div", o, this); },
    createSpan(o) { return make("span", o, this); },
    empty() { this.textContent = ""; },
    addClass(...c) { this.classList.add(...c.flatMap((x) => x.split(" "))); },
    removeClass(...c) { this.classList.remove(...c.flatMap((x) => x.split(" "))); },
    hasClass(c) { return this.classList.contains(c); },
    toggleClass(c, on) { this.classList.toggle(c, on); },
    setText(t) { this.textContent = t; },
    getText() { return this.textContent; },
    setAttr(k, v) { this.setAttribute(k, v); },
    getAttr(k) { return this.getAttribute(k); },
    hide() { this.style.display = "none"; },
    show() { this.style.display = ""; },
  });

  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.last = this; setTimeout(() => { if (FakeSocket.refuse) { this.readyState = 3; this.onclose && this.onclose({}); return; } this.readyState = 1; this.onopen && this.onopen({}); }, 0); }
    send(t) { this.sent.push(JSON.parse(t)); }
    close() { this.readyState = 3; this.onclose && this.onclose({}); }
    say(o) { this.onmessage({ data: JSON.stringify(o) }); }
  }
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;

  class Component { register() {} registerEvent() {} registerDomEvent(el, t, f) { el.addEventListener(t, f); } registerInterval() {} addChild() {} load() {} unload() {} }
  class ItemView extends Component { constructor(leaf) { super(); this.leaf = leaf; this.app = app; this.containerEl = make("div"); make("div", null, this.containerEl); make("div", null, this.containerEl); } }
  class Setting {
    constructor(el) { this.row = make("div", "setting-item", el); }
    setName(t) { make("div", { cls: "setting-item-name", text: t }, this.row); return this; }
    setDesc(t) { make("div", { cls: "setting-item-description", text: t }, this.row); return this; }
    setHeading() { return this; }
    addText(f) { const i = make("input", { attr: { type: "text" } }, this.row); const c = { inputEl: i, setPlaceholder() { return c; }, setValue(v) { i.value = v; return c; }, onChange() { return c; } }; f(c); return this; }
    addButton(f) { const c = { setButtonText() { return c; }, onClick() { return c; }, setCta() { return c; }, setWarning() { return c; }, setDisabled() { return c; } }; f(c); return this; }
    addDropdown(f) { const c = { addOption() { return c; }, addOptions() { return c; }, setValue() { return c; }, onChange() { return c; } }; f(c); return this; }
    addToggle(f) { const c = { setValue() { return c; }, onChange() { return c; } }; f(c); return this; }
    addTextArea(f) { return this.addText(f); }
  }
  class PluginSettingTab { constructor(a, p) { this.app = a; this.plugin = p; this.containerEl = make("div"); } }
  class TFile {}
  const notes = new Map();
  const workspace = { on: () => ({}), active: null, open: [], getActiveFile() { return this.active; }, iterateAllLeaves(fn) { this.open.forEach((file) => fn({ view: { file } })); }, getActiveViewOfType() { return this.active ? { editor: { getSelection: () => "BANKTEXT" } } : null; }, onLayoutReady: (f) => f(), getLeavesOfType: () => [], revealLeaf() {}, rootSplit: {}, openLinkText() {} };
  const app = {
    workspace, loadLocalStorage: () => null, saveLocalStorage() {},
    vault: { getName: () => "test", getAbstractFileByPath: (p) => notes.get(p) || null, createFolder: async (p) => { notes.set(p, {}); }, create: async (p, t) => { const f = new TFile(); f.text = t; notes.set(p, f); return f; }, process: async (f, fn) => { f.text = fn(f.text); }, adapter: {} },
  };
  let statusReply = async () => { throw new Error("Could not connect to the server."); };
  const obsidian = {
    addIcon() {}, normalizePath: (p) => p, ItemView, PluginSettingTab, Setting, TFile, MarkdownView: class {},
    Plugin: class extends Component { constructor() { super(); this.app = app; this.manifest = { version: "0.9.0" }; } async loadData() { return { serverUrl: "ws://100.90.1.2:8787", pairingCode: "c" }; } async saveData() {} registerView(t, f) { this.makeView = f; } addRibbonIcon() {} addCommand() {} addSettingTab(t) { this.tab = t; } },
    MarkdownRenderer: { render: async (a, t, el) => { el.textContent = t; } },
    Platform: { isDesktopApp: false, isMobile: true, isPhone: true, isTablet: false, isIosApp: true },
    Notice: class { constructor(t) { window.lastNotice = t; } }, requestUrl: (o) => statusReply(o),
  };
  const asked = [];
  const module = { exports: {} };
  const require = (n) => { asked.push(n); if (n !== "obsidian") throw new Error("Node module on mobile: " + n); return obsidian; };
  try {
    new Function("require", "module", "exports", window.PLUGIN_SOURCE)(require, module, module.exports);
    check("the plugin loads with only obsidian required", asked.join() === "obsidian", asked);
    check("no Node globals in this page", typeof process === "undefined" && typeof Buffer === "undefined");
    const plugin = new module.exports();
    await plugin.onload();
    check("onload finishes with no host", plugin.host === null && !plugin.hostEnabled());

    const mount = document.getElementById("mount");
    const view = plugin.makeView({ getRoot: () => ({}) });
    mount.appendChild(view.containerEl);
    await view.onOpen();
    plugin.views = () => [view];
    await new Promise((r) => setTimeout(r, 30));
    const ws = FakeSocket.last;
    check("the phone opens the socket to the saved address", ws && ws.url === "ws://100.90.1.2:8787", ws && ws.url);
    check("it says its version when it signs in", ws.sent[0] && ws.sent[0].type === "auth" && ws.sent[0].version === "0.9.0", JSON.stringify(ws.sent[0]));

    const providers = [
      { id: "anthropic", name: "Anthropic API", kind: "anthropic", set: true, models: ["claude-a"], noTools: [] },
      { id: "openai", name: "OpenAI", set: true, models: ["good", "plain"], noTools: ["plain"] },
      { id: "custom-a", name: "My server", set: true, models: [], hand: true, noTools: [] },
      { id: "deepseek", name: "DeepSeek", set: false, models: [], noTools: [] },
    ];
    ws.say({ type: "hello", version: "0.8.9", vaultRoot: "/v", warnings: [], providers });
    ws.say({ type: "models", providers });
    await new Promise((r) => setTimeout(r, 20));
    check("a version gap shows in the status line", /host 0\.8\.9, this device 0\.9\.0/.test(view.statusText.textContent), view.statusText.textContent);

    const brain = () => document.querySelector(".vc-menu-settings");
    const open = () => { view.closeMenu(); view.openSettingsMenu(); return brain(); };
    let menu = open();
    let names = [...menu.querySelectorAll("select option")].map((o) => o.textContent);
    check("the brain menu lists providers that are set", names.includes("OpenAI") && names.includes("My server") && names.includes("Anthropic API"), names);
    check("it leaves out ones that aren't", !names.includes("DeepSeek"), names);
    const choose = (id) => { const s = brain().querySelector("select"); s.value = id; s.onchange(); };
    choose("openai");
    menu = brain();
    names = [...menu.querySelectorAll("select option")].map((o) => o.textContent);
    check("a model that can't use tools is labelled", names.includes("plain · text only"), names);
    check("you can switch to typing a model", names.includes("Type a model…"), names);
    check("effort is left off for translated providers", ![...menu.querySelectorAll(".vc-menu-section")].some((e) => e.textContent === "Effort"));
    choose("custom-a");
    const typed = brain().querySelector(".vc-model-input");
    check("a provider with no list gets a typing box", !!typed);
    typed.value = " my/typed-model ";
    typed.onchange();
    check("the typed model is saved", plugin.settings.providerModel === "my/typed-model", plugin.settings.providerModel);
    choose("anthropic");
    check("Anthropic keeps Effort", [...brain().querySelectorAll(".vc-menu-section")].some((e) => e.textContent === "Effort"));
    const fits = (el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; };
    check("the brain menu fits the phone", fits(brain()), JSON.stringify(brain().getBoundingClientRect()));
    view.closeMenu();
    check("the page doesn't scroll sideways", document.documentElement.scrollWidth <= window.innerWidth, document.documentElement.scrollWidth);

    ws.say({ type: "notice", message: "Started a new conversation. The earlier messages in this chat weren't sent to OpenAI." });
    check("a new conversation says why in the chat", /weren't sent to OpenAI/.test(view.messagesEl.textContent) && view.session.id === null, view.messagesEl.textContent);
    ws.say({ type: "warning", message: "x is running text only." });
    await new Promise((r) => setTimeout(r, 20));
    check("a warning shows in the chat", /text only/.test(view.messagesEl.textContent) && !!document.querySelector(".vc-note"), view.messagesEl.textContent);

    view.inputEl.value = "/log shipped it";
    await view.send();
    await new Promise((r) => setTimeout(r, 20));
    const log = notes.get(plugin.settings.logPath);
    check("/log writes the note on the phone", log && /shipped it · Copilot 0\.9\.0/.test(log.text), log && log.text);
    check("/log never goes to the host", !ws.sent.some((m) => m.type === "send"), JSON.stringify(ws.sent.map((m) => m.type)));

    plugin.tab.display();
    const text = plugin.tab.containerEl.textContent;
    check("phone settings show set and not set", /DeepSeek/.test(text) && /Not set/.test(text), text.slice(0, 200));
    check("phone settings have no key box", !plugin.tab.containerEl.querySelector("input[type=password]"));

    const money = { path: "10 Money/Bank/a.md", basename: "a" }, other = { path: "ok.md", basename: "ok" };
    workspace.active = money;
    workspace.open = [money, other];
    const ctx = view.currentContext();
    check("an active 10 Money note stays out of the context", !JSON.stringify(ctx).includes("10 Money") && !ctx.activeFile, JSON.stringify(ctx));
    check("its selected text stays out too", !JSON.stringify(ctx).includes("BANKTEXT"), JSON.stringify(ctx));
    check("other open notes still go", (ctx.openFiles || []).includes("ok.md"), JSON.stringify(ctx));
    check("the note picker doesn't offer it", !view.openNotes().some((f) => f.path === money.path));
    workspace.active = other;
    workspace.open = [other, money];
    check("an open 10 Money tab stays out", !JSON.stringify(view.currentContext()).includes("10 Money"), JSON.stringify(view.currentContext()));
    workspace.active = null;
    workspace.open = [];

    const shown = () => { const a = document.querySelector(".vc-alert"); return a ? a.textContent : ""; };
    const dismiss = () => { document.querySelectorAll(".vc-alert, .vc-alert-scrim").forEach((e) => e.remove()); };
    FakeSocket.refuse = true;
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    const cases = [
      ["refused", async () => { throw new Error("Could not connect to the server."); }, /Obsidian is closed/],
      ["timed out", async () => { throw new Error("The request timed out."); }, /asleep/],
      ["no network", async () => { throw new Error("The Internet connection appears to be offline."); }, /Tailscale/],
      ["host up, socket blocked", async () => ({ text: JSON.stringify({ version: "0.9.0" }) }), /This device: 0\.9\.0\. Your computer: 0\.9\.0/],
    ];
    for (const [name, reply, want] of cases) {
      statusReply = reply;
      dismiss();
      await view.connectionAlert();
      await new Promise((r) => setTimeout(r, 10));
      check(`alert names the cause: ${name}`, want.test(shown()), shown());
      check(`alert shows both versions: ${name}`, /This device: 0\.9\.0/.test(shown()) && /Your computer:/.test(shown()), shown());
    }
    const a = document.querySelector(".vc-alert");
    check("the alert fits the phone", a && fits(a), a && JSON.stringify(a.getBoundingClientRect()));
  } catch (e) {
    check("the page ran to the end", false, e && (e.stack || e.message));
  }
  const body = JSON.stringify({ ua: navigator.userAgent, width: window.innerWidth, results });
  document.title = "done";
  try { await fetch("/report", { method: "POST", body }); } catch (e) { /* the dump-dom run reads the title */ }
})();
