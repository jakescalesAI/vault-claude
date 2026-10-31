/* Vault Claude: a chat sidebar for Claude Code, on your own computer and your own Claude login.
   On a desktop the plugin hosts Claude Code itself (see Host below) and other devices (iPad,
   phone) connect to it over Tailscale with a pairing code. The chat UI uses no Node APIs, so it
   runs on mobile. Styled after Apple's HIG; see styles.css. */
const { Plugin, ItemView, PluginSettingTab, Setting, MarkdownRenderer, MarkdownView, Platform, Notice } = require("obsidian");

const VIEW_TYPE = "vault-claude-view";
const DEFAULT_SETTINGS = {
  serverUrl: "", // the host other devices connect to, e.g. ws://100.x.y.z:8787
  pairingCode: "", // made by the host; synced devices pick it up from data.json
  hostPort: 8787,
  hostBind: "local", // "local" | "tailscale" | "all"
  claudePath: "",
  transcribeCommand: "",
  model: "",
  effort: "",
  permissionMode: "acceptEdits",
  sendContext: true,
  sessions: [], // [{id, title, updated, pinned?, items: [...]}] newest first
};
const MODELS = [["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const EFFORTS = [["", "Auto"], ["low", "Low"], ["medium", "Med"], ["high", "High"], ["max", "Max"]];
const MODES = [["acceptEdits", "Edit"], ["plan", "Plan"], ["default", "Read"]];
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// SF Symbols-style line icons: 24px grid, stroke 2, round caps.
const ICONS = {
  compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  brain: '<path d="M9.5 4A2.5 2.5 0 0 0 7 6.5 3 3 0 0 0 4.5 11a3 3 0 0 0 .5 5 3 3 0 0 0 4.5 3.5 2.5 2.5 0 0 0 2.5-2V6a2.5 2.5 0 0 0-2.5-2z"/><path d="M14.5 4A2.5 2.5 0 0 1 17 6.5 3 3 0 0 1 19.5 11a3 3 0 0 1-.5 5 3 3 0 0 1-4.5 3.5 2.5 2.5 0 0 1-2.5-2V6a2.5 2.5 0 0 1 2.5-2z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  xmark: '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>',
  paperclip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  pin: '<path d="M12 17v4"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  pinFill: '<path d="M12 17v4"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" fill="currentColor"/>',
};
function icon(parent, name, cls) {
  const span = parent.createSpan({ cls: "vc-ico" + (cls ? " " + cls : "") });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

class VaultClaudeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.ws = null;
    this.vaultRoot = "";
    this.running = false;
    this.session = null;
    this.live = null; // {el, target, shown, ...} assistant text block being streamed
    this.toolEls = new Map(); // tool_use_id -> {el, item}
    this.queue = []; // [{text, ctx, el}] messages typed while Claude is working
    this.typers = new Set(); // assistant text blocks still typing out
    this.rafId = null;
    this.excluded = new Set(); // open notes the user left out of the context
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Claude"; }
  getIcon() { return "sparkles"; }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("vc-root");
    this.root = root;

    const header = root.createDiv("vc-header");
    header.createDiv("vc-glass vc-glass-top");
    const titles = header.createDiv("vc-titles");
    this.titleEl = titles.createDiv({ cls: "vc-title", text: "New Chat", attr: { role: "button", "aria-label": "Rename chat" } });
    this.titleEl.onclick = () => this.renameTitle();
    const statusRow = titles.createDiv("vc-status-row");
    this.statusDot = statusRow.createSpan("vc-dot");
    this.statusText = statusRow.createSpan({ cls: "vc-caption" });
    this.iconButton(header, "clock", "Chats", () => this.openHistory());
    this.iconButton(header, "compose", "New chat", () => this.newChat());

    this.messagesEl = root.createDiv("vc-messages");
    this.stick = true;
    this.registerDomEvent(this.messagesEl, "scroll", () => {
      const m = this.messagesEl;
      this.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    });

    // The composer floats over the chat: messages scroll behind it, and a blur fades in
    // from halfway up (vc-glass), so there is no hard edge between chat and input.
    const composer = root.createDiv("vc-composer");
    composer.createDiv("vc-glass vc-glass-bottom");
    this.composerEl = composer;
    this.trayEl = composer.createDiv("vc-tray");
    const field = composer.createDiv("vc-field");
    this.inputEl = field.createEl("textarea", { cls: "vc-input", attr: { placeholder: "Message", rows: "1" } });
    this.inputEl.addEventListener("input", () => { this.autosize(); this.updateSendButton(); });
    this.inputEl.addEventListener("paste", (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length) { e.preventDefault(); this.addFiles(files); }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    this.sendBtn = field.createEl("button", { cls: "vc-send", attr: { "aria-label": "Send" } });
    // While Claude works: with text, the button queues it; with an empty box, it stops Claude.
    this.sendBtn.onclick = () => (this.sendBtn.hasClass("is-stop") ? this.interrupt() : this.send());

    // Controls under the field: + | open note | mic | brain.
    const controls = composer.createDiv("vc-controls");
    const attachBtn = this.iconButton(controls, "plus", "Add photos or files", () => this.fileInput.click());
    attachBtn.addClass("vc-attach");
    this.fileInput = controls.createEl("input", { attr: { type: "file", multiple: "" } });
    this.fileInput.hide();
    this.fileInput.onchange = async () => {
      await this.addFiles(Array.from(this.fileInput.files || []));
      this.fileInput.value = "";
    };
    this.contextEl = controls.createDiv("vc-context");
    this.micBtn = this.iconButton(controls, "mic", "Dictate", () => this.toggleRecording());
    this.micBtn.addClass("vc-mic");
    this.brainBtn = this.iconButton(controls, "brain", "Mode, model and effort", (e) => { e.stopPropagation(); this.openSettingsMenu(); });
    this.brainBtn.addClass("vc-brain");

    // Keep the last message clear of the floating composer, whatever its height.
    const fit = () => root.style.setProperty("--vc-composer-h", composer.offsetHeight + "px");
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(fit);
      ro.observe(composer);
      this.register(() => ro.disconnect());
    }
    fit();

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContext()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateContext()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateContext()));
    this.registerDomEvent(document, "click", () => this.closeMenu());
    this.updateContext();
    this.updateBrain();
    this.setRunning(false);

    const last = this.plugin.settings.sessions[0];
    if (last) this.loadSession(last); else this.newChat();
    this.connect();
  }

  async onClose() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }

  // ---------- controls ----------
  iconButton(parent, name, label, onClick) {
    const b = parent.createEl("button", { cls: "vc-icon-btn", attr: { "aria-label": label } });
    icon(b, name);
    b.onclick = onClick;
    return b;
  }

  segmented(parent, options, value, onChange) {
    const track = parent.createDiv({ cls: "vc-seg", attr: { role: "tablist" } });
    const thumb = track.createDiv("vc-seg-thumb");
    const buttons = options.map(([v, label], i) => {
      const b = track.createEl("button", { cls: "vc-seg-btn", text: label, attr: { role: "tab" } });
      b.onclick = () => { select(i); onChange(v); };
      return b;
    });
    const select = (i) => {
      buttons.forEach((b, j) => b.toggleClass("is-active", i === j));
      thumb.style.width = `calc((100% - 4px) / ${options.length})`;
      thumb.style.transform = `translateX(${i * 100}%)`;
    };
    select(Math.max(0, options.findIndex(([v]) => v === value)));
    return track;
  }

  // Brain menu: mode, model and effort as three segmented controls in one popover.
  openSettingsMenu() {
    if (this.closeMenu()) return;
    const s = this.plugin.settings;
    const menu = this.root.createDiv("vc-menu vc-menu-settings vc-material");
    menu.onclick = (e) => e.stopPropagation();
    const group = (title, options, key) => {
      menu.createDiv({ cls: "vc-menu-section", text: title });
      this.segmented(menu, options, s[key], (v) => { s[key] = v; this.plugin.saveSettings(); this.updateBrain(); });
    };
    group("Mode", MODES, "permissionMode");
    group("Model", MODELS, "model");
    group("Effort", EFFORTS, "effort");
    const r = this.brainBtn.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    menu.style.right = `${Math.max(8, box.right - r.right)}px`;
    menu.style.bottom = `${box.bottom - r.top + 4}px`;
    this.menuEl = menu;
  }

  // Tint the brain when anything differs from the defaults, so the state is visible at a glance.
  updateBrain() {
    const s = this.plugin.settings;
    this.brainBtn.toggleClass("is-custom", s.permissionMode !== "acceptEdits" || !!s.model || !!s.effort);
  }

  closeMenu() {
    if (!this.menuEl) return false;
    this.menuEl.remove();
    this.menuEl = null;
    return true;
  }

  toast(text) {
    const t = this.root.createDiv("vc-toast vc-material");
    icon(t, "check", "vc-ico-sm");
    t.createSpan({ text });
    window.setTimeout(() => t.addClass("is-out"), 1600);
    window.setTimeout(() => t.remove(), 1950);
  }

  alert(title, message, actions) {
    const scrim = this.root.createDiv("vc-scrim");
    const box = scrim.createDiv("vc-alert vc-material");
    box.createDiv({ cls: "vc-alert-title", text: title });
    if (message) box.createDiv({ cls: "vc-alert-msg", text: message });
    const row = box.createDiv("vc-alert-actions");
    for (const a of actions) {
      const b = row.createEl("button", { cls: "vc-alert-btn" + (a.primary ? " is-primary" : "") + (a.destructive ? " is-destructive" : ""), text: a.label });
      b.onclick = () => { scrim.remove(); if (a.run) a.run(); };
    }
  }

  autosize() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  // ---------- connection ----------
  // The socket opens, the plugin sends the pairing code, and the host answers "hello" once it
  // accepts it. Only then is the chat ready.
  connect() {
    if (this.closing) return;
    clearTimeout(this.retryTimer);
    const url = this.plugin.clientUrl();
    if (!url) { this.setStatus(this.plugin.hostEnabled() && !this.plugin.hostError ? "connecting" : "setup"); return this.retry(5000); }
    this.setStatus("connecting");
    this.ready = false;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.setStatus("off"); return this.retry(); }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.plugin.settings.pairingCode }));
    ws.onmessage = (e) => { try { this.onServer(JSON.parse(e.data)); } catch (err) { console.error("vault-claude", err); } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      this.setStatus(this.unpaired ? "unpaired" : "off");
      if (this.running && wasReady) this.finishTurn(null, "Connection lost. Your computer keeps working; reopen this chat from Chats to see the result.");
      this.retry(this.unpaired ? 10000 : 3000);
    };
    ws.onerror = () => {};
  }

  isReady() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.ready;
  }

  retry(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), ms || 3000);
  }

  reconnect() {
    this.unpaired = false;
    if (this.ws) { const old = this.ws; this.ws = null; old.close(); }
    this.connect();
  }

  setStatus(state) {
    this.statusDot.className = "vc-dot is-" + (state === "on" ? "on" : state === "connecting" ? "connecting" : "off");
    const local = this.plugin.hosting();
    this.statusText.setText({
      on: local ? "Running on this computer" : `Connected to ${this.hostName || "your computer"}`,
      off: "Not connected",
      connecting: "Connecting…",
      unpaired: "Not paired · add the pairing code in settings",
      setup: "Set up in Vault Claude settings",
    }[state]);
  }

  // ---------- context from Obsidian ----------
  // Every note open in a tab or window, the active one first.
  openNotes() {
    const active = this.app.workspace.getActiveFile();
    const files = active ? [active] : [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const f = leaf.view && leaf.view.file;
      if (f && f.path && !files.some((x) => x.path === f.path)) files.push(f);
    });
    return files;
  }

  includedNotes() {
    if (!this.plugin.settings.sendContext) return [];
    return this.openNotes().filter((f) => !this.excluded.has(f.path));
  }

  currentContext() {
    const notes = this.includedNotes();
    const active = this.app.workspace.getActiveFile();
    const ctx = {};
    if (active && notes.some((f) => f.path === active.path)) {
      ctx.activeFile = active.path;
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      const sel = md && md.editor ? md.editor.getSelection() : "";
      if (sel) ctx.selection = sel;
    }
    const others = notes.map((f) => f.path).filter((p) => p !== ctx.activeFile);
    if (others.length) ctx.openFiles = others;
    return ctx;
  }

  // One open note: the pill toggles it. Several: the pill opens a list to pick which ones
  // Claude sees.
  updateContext() {
    if (!this.contextEl) return;
    this.contextEl.empty();
    const notes = this.openNotes();
    const open = new Set(notes.map((f) => f.path));
    for (const p of this.excluded) if (!open.has(p)) this.excluded.delete(p);
    if (!notes.length) return;
    const included = this.includedNotes();
    const on = included.length > 0;
    const many = notes.length > 1;
    const chip = this.contextEl.createEl("button", {
      cls: "vc-chip" + (on ? "" : " is-off"),
      attr: { "aria-label": many ? "Choose which open notes Claude sees" : "Include or leave out the open note" },
    });
    icon(chip, "doc", "vc-ico-sm");
    const lead = included[0] || notes[0];
    chip.createSpan({ cls: "vc-chip-name", text: lead.basename });
    if (many && included.length > 1) chip.createSpan({ cls: "vc-chip-more vc-num", text: `+${included.length - 1}` });
    chip.createSpan({ cls: "vc-chip-note", text: on ? "Included" : "Not included" });
    if (many) icon(chip, "chevronDown", "vc-ico-sm vc-chip-chev");
    chip.onclick = (e) => {
      e.stopPropagation();
      if (many) return this.openContextMenu(chip);
      const s = this.plugin.settings;
      if (on) s.sendContext = false;
      else { s.sendContext = true; this.excluded.clear(); }
      this.plugin.saveSettings();
      this.updateContext();
    };
  }

  openContextMenu(anchor) {
    if (this.closeMenu()) return;
    const menu = this.root.createDiv("vc-menu vc-menu-notes vc-material");
    menu.onclick = (e) => e.stopPropagation();
    menu.createDiv({ cls: "vc-menu-section", text: "Open notes Claude can see" });
    const list = menu.createDiv("vc-menu-list");
    const s = this.plugin.settings;
    const draw = () => {
      list.empty();
      const active = this.app.workspace.getActiveFile();
      for (const f of this.openNotes()) {
        const checked = s.sendContext && !this.excluded.has(f.path);
        const row = list.createEl("button", { cls: "vc-menu-row" + (checked ? " is-checked" : ""), attr: { role: "menuitemcheckbox", "aria-checked": String(checked) } });
        const mark = row.createSpan("vc-menu-check");
        if (checked) icon(mark, "check", "vc-ico-sm");
        const text = row.createDiv("vc-row-stack");
        text.createDiv({ cls: "vc-row-text", text: f.basename });
        const where = f.parent && f.parent.path !== "/" ? f.parent.path : "";
        if (active && f.path === active.path) text.createDiv({ cls: "vc-caption", text: where ? `Current note · ${where}` : "Current note" });
        else if (where) text.createDiv({ cls: "vc-caption", text: where });
        row.onclick = () => {
          if (!s.sendContext) {
            // Everything was off: turn on just this one.
            s.sendContext = true;
            this.openNotes().forEach((n) => this.excluded.add(n.path));
            this.excluded.delete(f.path);
          } else if (checked) this.excluded.add(f.path);
          else this.excluded.delete(f.path);
          this.plugin.saveSettings();
          draw();
          this.updateContext();
        };
      }
    };
    draw();
    const r = anchor.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left - box.left)}px`;
    menu.style.bottom = `${box.bottom - r.top + 4}px`;
    this.menuEl = menu;
  }

  // ---------- sessions ----------
  newChat() {
    this.session = { id: null, title: "New Chat", updated: Date.now(), items: [] };
    this.renderSession();
  }

  loadSession(s) {
    this.session = s;
    this.renderSession();
  }

  renderSession() {
    this.messagesEl.empty();
    this.toolEls.clear();
    this.live = null;
    this.typers.clear();
    this.queue = [];
    this.queueEl = null;
    this.thinkingEl = null;
    if (this.running) this.setRunning(true);
    this.titleEl.setText(this.session.title);
    if (!this.session.items.length) this.renderEmpty();
    for (const item of this.session.items) this.renderItem(item);
    this.scrollDown();
  }

  renderEmpty() {
    const empty = this.messagesEl.createDiv("vc-empty");
    icon(empty, "sparkle", "vc-empty-ico");
    empty.createDiv({ cls: "vc-large-title", text: "Claude" });
    empty.createDiv({ cls: "vc-empty-sub", text: "Claude Code on your computer, working in this vault. It sees the notes you have open." });
    const card = empty.createDiv("vc-card vc-suggestions");
    for (const s of ["Plan my day", "Summarize this note", "What should I work on next?"]) {
      const row = card.createEl("button", { cls: "vc-row" });
      row.createSpan({ cls: "vc-row-text", text: s });
      icon(row, "chevronRight", "vc-ico-sm vc-row-chev");
      row.onclick = () => { this.inputEl.value = s; this.send(); };
    }
  }

  openHistory() {
    const scrim = this.root.createDiv("vc-scrim vc-scrim-sheet");
    const sheet = scrim.createDiv("vc-sheet");
    const close = () => { sheet.addClass("is-out"); scrim.addClass("is-out"); window.setTimeout(() => scrim.remove(), 300); };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };

    const bar = sheet.createDiv("vc-sheet-bar vc-material");
    bar.createEl("button", { cls: "vc-plain", text: "Cancel" }).onclick = close;
    bar.createDiv({ cls: "vc-sheet-title", text: "Chats" });
    bar.createEl("button", { cls: "vc-plain is-bold", text: "Done" }).onclick = close;

    const search = sheet.createDiv("vc-search");
    icon(search, "search", "vc-ico-sm");
    const input = search.createEl("input", { attr: { type: "search", placeholder: "Search" } });

    const list = sheet.createDiv("vc-sheet-body");
    const draw = () => {
      list.empty();
      const q = input.value.trim().toLowerCase();
      const sessions = this.plugin.settings.sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
      if (!sessions.length) {
        list.createDiv({ cls: "vc-section", text: q ? "Results" : "Recent" });
        list.createDiv({ cls: "vc-caption vc-pad", text: q ? "No matching chats." : "No chats yet." });
        return;
      }
      const section = (title, items) => {
        if (!items.length) return;
        list.createDiv({ cls: "vc-section", text: title });
        const card = list.createDiv("vc-card");
        for (const s of items) {
          const row = card.createDiv({ cls: "vc-row vc-row-2", attr: { role: "button", tabindex: "0" } });
          const text = row.createDiv("vc-row-stack");
          text.createDiv({ cls: "vc-row-text", text: s.title });
          text.createDiv({ cls: "vc-caption vc-num", text: new Date(s.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
          const pin = row.createEl("button", { cls: "vc-icon-btn vc-pin" + (s.pinned ? " is-pinned" : ""), attr: { "aria-label": s.pinned ? "Unpin" : "Pin" } });
          icon(pin, s.pinned ? "pinFill" : "pin", "vc-ico-sm");
          pin.onclick = (e) => {
            e.stopPropagation();
            s.pinned = !s.pinned;
            this.plugin.saveSettings();
            draw();
          };
          icon(row, "chevronRight", "vc-ico-sm vc-row-chev");
          row.onclick = () => { this.loadSession(s); close(); };
        }
      };
      section("Pinned", sessions.filter((s) => s.pinned));
      section(q ? "Results" : "Recent", sessions.filter((s) => !s.pinned));
      if (!q) {
        const danger = list.createDiv("vc-card vc-card-gap");
        const clear = danger.createEl("button", { cls: "vc-row vc-row-destructive", text: "Clear All Chats" });
        clear.onclick = () => this.alert("Clear all chats?", "This removes saved chats from the vault, except pinned ones. Claude Code keeps its own copies on your computer.", [
          { label: "Cancel" },
          { label: "Clear", destructive: true, run: async () => {
            this.plugin.settings.sessions = this.plugin.settings.sessions.filter((s) => s.pinned);
            await this.plugin.saveSettings();
            if (!this.session.pinned) this.newChat();
            close();
            this.toast("Cleared");
          } },
        ]);
      }
    };
    input.addEventListener("input", draw);
    draw();
  }

  saveSession() {
    const s = this.session;
    if (!s.items.length) return;
    s.updated = Date.now();
    const list = this.plugin.settings.sessions.filter((x) => x !== s && (!s.id || x.id !== s.id));
    list.unshift(s);
    // Keep every pinned chat plus the 50 most recent others.
    let recent = 0;
    this.plugin.settings.sessions = list.filter((x) => x.pinned || ++recent <= 50);
    this.plugin.saveSettings();
  }

  // ---------- sending and the queue ----------
  // Enter always works: idle, it sends now; while Claude works, it queues. Queued messages
  // go out together as the next turn when the current one finishes.
  send() {
    const text = this.inputEl.value.trim();
    const attachments = this.pending || [];
    if (!text && !attachments.length) return;
    if (!this.running && (!this.isReady())) {
      this.alert("Not Connected", "Make sure Tailscale is on and your computer is awake with Obsidian open, then try again.", [{ label: "OK", primary: true }]);
      return;
    }
    const ctx = this.plugin.settings.sendContext ? this.currentContext() : {};
    this.inputEl.value = "";
    this.autosize();
    this.pending = [];
    this.renderTray();
    if (this.running) this.enqueue(text, ctx, attachments);
    else this.dispatch([{ text, ctx, attachments }]);
    this.updateSendButton();
  }

  enqueue(text, ctx, attachments) {
    if (!this.queueEl) this.queueEl = this.messagesEl.createDiv("vc-queue");
    const wrap = this.queueEl.createDiv("vc-user-wrap is-queued");
    this.renderAttachments(wrap, attachments);
    if (text) wrap.createDiv({ cls: "vc-bubble", text });
    wrap.createDiv({ cls: "vc-caption", text: "Queued · tap to cancel" });
    const entry = { text, ctx, attachments, el: wrap };
    wrap.onclick = () => {
      this.queue = this.queue.filter((q) => q !== entry);
      wrap.remove();
    };
    this.queue.push(entry);
    this.flyIn(wrap);
    this.keepTypingLast();
    this.scrollDown(true);
  }

  flushQueue() {
    if (!this.queue.length || this.running) return;
    if (!this.isReady()) return; // sent once reconnected
    const entries = this.queue;
    this.queue = [];
    entries.forEach((q) => q.el.remove());
    this.dispatch(entries, true);
  }

  dispatch(entries, fromQueue) {
    if (!this.session.items.length) {
      this.messagesEl.empty();
      this.queueEl = null;
      if (!this.session.customTitle) this.session.title = (entries[0].text || (entries[0].attachments || []).map((a) => a.name).join(", ")).slice(0, 60);
      this.titleEl.setText(this.session.title);
    }
    for (const { text, ctx, attachments } of entries) {
      // History keeps names and small previews only; the full files go to the host once.
      const files = (attachments || []).map((a) => ({ name: a.name, mime: a.mime, thumb: a.thumb || null }));
      const item = { kind: "user", text, file: ctx.activeFile || null, files };
      this.session.items.push(item);
      const el = this.renderItem(item);
      if (!fromQueue) this.flyIn(el);
    }
    const s = this.plugin.settings;
    this.ws.send(JSON.stringify({
      type: "send",
      text: entries.map((e) => e.text).filter(Boolean).join("\n\n") || "(See the attached files.)",
      sessionId: this.session.id,
      model: s.model, effort: s.effort, permissionMode: s.permissionMode,
      context: entries[entries.length - 1].ctx,
      attachments: entries.flatMap((e) => (e.attachments || []).map((a) => ({ name: a.name, mime: a.mime, data: a.data }))),
    }));
    this.setRunning(true);
    this.saveSession();
    this.scrollDown(true);
  }

  interrupt() {
    if (this.isReady()) this.ws.send(JSON.stringify({ type: "interrupt" }));
  }

  setRunning(on) {
    this.running = on;
    this.updateSendButton();
    if (on) {
      this.thinkingEl = this.messagesEl.createDiv("vc-typing");
      for (let i = 0; i < 3; i++) this.thinkingEl.createSpan();
      this.keepTypingLast();
    } else if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  // Stop only while Claude works and the box is empty; otherwise the arrow sends or queues.
  updateSendButton() {
    const stop = this.running && !this.inputEl.value.trim() && !(this.pending && this.pending.length);
    if (this.sendBtn.hasClass("is-stop") === stop && this.sendBtn.childElementCount) return;
    this.sendBtn.empty();
    icon(this.sendBtn, stop ? "stop" : "up");
    this.sendBtn.setAttr("aria-label", stop ? "Stop" : this.running ? "Queue" : "Send");
    this.sendBtn.toggleClass("is-stop", stop);
  }

  // ---------- server events ----------
  onServer(msg) {
    if (msg.type === "hello") {
      this.vaultRoot = msg.vaultRoot || "";
      this.hostName = msg.host || "";
      this.ready = true;
      this.unpaired = false;
      this.setStatus("on");
      if (!this.running) this.flushQueue();
      return;
    }
    if (msg.type === "transcript") { this.onTranscript(msg); return; }
    if (msg.type === "error" && msg.code === "auth") { this.unpaired = true; this.setStatus("unpaired"); return; }
    if (msg.type === "error") { this.addItem({ kind: "error", text: msg.message }); return; }
    if (msg.type === "done") { this.finishTurn(msg.sessionId); return; }
    if (msg.type !== "event") return;
    const ev = msg.event;

    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) this.session.id = ev.session_id;

    if (ev.type === "stream_event") {
      const e = ev.event || {};
      if (e.type === "content_block_start" && e.content_block && e.content_block.type === "text") this.startLive();
      if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") {
        if (!this.live) this.startLive();
        this.live.target += e.delta.text;
        this.startTyping();
      }
      return;
    }

    if (ev.type === "assistant" && ev.message) {
      for (const block of ev.message.content || []) {
        if (block.type === "text" && block.text) this.commitText(block.text);
        if (block.type === "tool_use") this.addItem({ kind: "tool", id: block.id, name: block.name, input: block.input || {} });
      }
      return;
    }

    if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type !== "tool_result") continue;
        const t = this.toolEls.get(block.tool_use_id);
        if (!t) continue;
        t.item.result = resultText(block.content).slice(0, 4000);
        t.item.isError = !!block.is_error;
        this.fillTool(t.el, t.item);
      }
      return;
    }

    if (ev.type === "result") {
      if (ev.session_id) this.session.id = ev.session_id;
      if (ev.is_error && ev.result) this.addItem({ kind: "error", text: String(ev.result) });
    }
  }

  // ---------- typing out replies ----------
  // Text arrives in bursts; each block reveals it a few characters per frame, faster when it
  // falls behind, so the reply reads as a smooth stream instead of jumping in chunks.
  startLive() {
    this.flushLive();
    const el = this.messagesEl.createDiv("vc-msg vc-assistant is-new");
    this.live = { el, target: "", shown: 0, rendered: -1, lastRender: 0 };
    this.keepTypingLast();
  }

  startTyping() {
    if (this.live) this.typers.add(this.live);
    if (this.rafId) return;
    const tick = (now) => {
      for (const t of this.typers) {
        const backlog = t.target.length - t.shown;
        if (backlog > 0) t.shown += Math.max(1, Math.ceil(backlog / 14));
        // Markdown re-renders at most ~30 times a second; the final frame always renders.
        const caughtUp = t.shown >= t.target.length;
        if (t.shown !== t.rendered && (caughtUp || now - t.lastRender > 32)) {
          this.renderMarkdown(t.el, t.target.slice(0, t.shown), !caughtUp);
          t.rendered = t.shown;
          t.lastRender = now;
          this.scrollDown();
        }
        if (caughtUp && t.committed) this.typers.delete(t);
      }
      this.rafId = this.typers.size ? window.requestAnimationFrame(tick) : null;
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  // The full text block arrives after its deltas: let the typer finish with exactly that text.
  commitText(text) {
    this.session.items.push({ kind: "assistant", text });
    let t = this.live;
    if (!t) {
      t = { el: this.messagesEl.createDiv("vc-msg vc-assistant is-new"), target: "", shown: 0, rendered: -1, lastRender: 0 };
    }
    t.target = text;
    t.shown = Math.min(t.shown, text.length);
    t.committed = true;
    this.live = null;
    this.typers.add(t);
    this.startTyping();
    this.keepTypingLast();
  }

  // A block that streamed but never got its full copy (e.g. interrupted) is saved as streamed.
  flushLive() {
    const t = this.live;
    if (!t) return;
    this.live = null;
    if (!t.target) return;
    this.session.items.push({ kind: "assistant", text: t.target });
    t.committed = true;
    this.typers.add(t);
    this.startTyping();
  }

  finishTurn(sessionId, note) {
    this.flushLive();
    if (sessionId) this.session.id = sessionId;
    if (note) this.addItem({ kind: "error", text: note });
    this.setRunning(false);
    this.saveSession();
    this.flushQueue();
  }

  addItem(item) {
    this.session.items.push(item);
    this.renderItem(item);
    this.keepTypingLast();
    this.scrollDown();
  }

  // The dots and any queued messages always sit below the conversation.
  keepTypingLast() {
    if (this.thinkingEl) this.messagesEl.appendChild(this.thinkingEl);
    if (this.queueEl) this.messagesEl.appendChild(this.queueEl);
  }


  // ---------- renaming ----------
  renameTitle() {
    if (this.titleEl.hasClass("is-editing")) return;
    const input = createEl("input", { cls: "vc-title-input", attr: { type: "text", "aria-label": "Chat name" } });
    input.value = this.session.title;
    this.titleEl.addClass("is-editing");
    this.titleEl.empty();
    this.titleEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== this.session.title) {
        this.session.title = name;
        this.session.customTitle = true;
        this.saveSession();
        this.toast("Renamed");
      }
      this.titleEl.removeClass("is-editing");
      this.titleEl.setText(this.session.title);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  // ---------- dictation ----------
  // Tap to record, tap again to stop. The host computer transcribes the audio (faster-whisper) and
  // the text lands in the message box to check before sending.
  async toggleRecording() {
    if (this.recorder) { this.recorder.stop(); return; }
    if (this.transcribing) return;
    if (!this.isReady()) {
      this.alert("Not Connected", "Dictation is transcribed on your computer, so it needs a connection.", [{ label: "OK", primary: true }]);
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      this.alert("Microphone Unavailable", "This device doesn't allow recording here. Use the keyboard's dictation key instead.", [{ label: "OK", primary: true }]);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.alert("Microphone Access", "Allow microphone access for Obsidian, then try again.", [{ label: "OK", primary: true }]);
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(this.recordLimit);
      this.recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      if (blob.size < 1000) { this.setMicState("idle"); return; }
      this.setMicState("transcribing");
      const data = await readBase64(blob);
      if (!this.isReady()) {
        this.setMicState("idle");
        this.alert("Not Connected", "The recording couldn't be sent. Try again once connected.", [{ label: "OK", primary: true }]);
        return;
      }
      this.ws.send(JSON.stringify({ type: "transcribe", mime: blob.type, data }));
    };
    rec.start();
    this.recorder = rec;
    this.recordLimit = window.setTimeout(() => this.recorder && this.recorder.stop(), 5 * 60 * 1000);
    this.setMicState("recording");
  }

  setMicState(state) {
    this.transcribing = state === "transcribing";
    this.micBtn.toggleClass("is-recording", state === "recording");
    this.micBtn.toggleClass("is-busy", state === "transcribing");
    this.micBtn.setAttr("aria-label", { idle: "Dictate", recording: "Stop recording", transcribing: "Transcribing" }[state]);
    this.inputEl.setAttr("placeholder", { idle: "Message", recording: "Listening…", transcribing: "Transcribing…" }[state]);
  }

  onTranscript(msg) {
    this.setMicState("idle");
    if (msg.error) {
      this.alert("Dictation Unavailable", msg.error, [{ label: "OK", primary: true }]);
      return;
    }
    const text = (msg.text || "").trim();
    if (!text) return;
    const cur = this.inputEl.value;
    this.inputEl.value = cur && !/\s$/.test(cur) ? cur + " " + text : cur + text;
    this.autosize();
    this.updateSendButton();
    this.inputEl.focus();
  }

  // ---------- motion ----------
  flyIn(el) {
    if (!el || !el.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.scrollDown(true);
    const from = this.inputEl.getBoundingClientRect();
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.92)`, opacity: 0.4 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 350, easing: "cubic-bezier(.32,.72,0,1)" }
    );
  }

  // ---------- attachments ----------
  async addFiles(files) {
    this.pending = this.pending || [];
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT) {
        this.alert("File Too Large", `${f.name} is over ${MAX_ATTACHMENT / 1048576} MB.`, [{ label: "OK", primary: true }]);
        continue;
      }
      const data = await readBase64(f);
      const mime = f.type || "application/octet-stream";
      const name = f.name || (mime.startsWith("image/") ? "image." + (mime.split("/")[1] || "png") : "file");
      const thumb = mime.startsWith("image/") ? await thumbnail(f) : null;
      this.pending.push({ name, mime, data, thumb });
    }
    this.renderTray();
    this.updateSendButton();
  }

  renderTray() {
    this.trayEl.empty();
    for (const a of this.pending || []) {
      const chip = this.trayEl.createDiv("vc-att");
      this.attachmentFace(chip, a);
      const x = chip.createEl("button", { cls: "vc-att-remove", attr: { "aria-label": "Remove " + a.name } });
      icon(x, "xmark");
      x.onclick = () => { this.pending = this.pending.filter((p) => p !== a); this.renderTray(); this.updateSendButton(); };
    }
  }

  renderAttachments(parent, files) {
    if (!files || !files.length) return;
    const row = parent.createDiv("vc-att-row");
    for (const a of files) this.attachmentFace(row.createDiv("vc-att is-sent"), a);
  }

  attachmentFace(el, a) {
    if (a.thumb) {
      el.addClass("is-image");
      el.createEl("img", { attr: { src: a.thumb, alt: a.name } });
    } else {
      el.addClass("is-file");
      icon(el, "doc", "vc-ico-sm");
      el.createSpan({ cls: "vc-att-name", text: a.name });
    }
  }

  // ---------- rendering ----------
  renderItem(item) {
    let ret = null;
    if (item.kind === "user") {
      const wrap = this.messagesEl.createDiv("vc-user-wrap");
      ret = wrap;
      if (item.file) {
        const f = wrap.createDiv("vc-user-file vc-caption");
        icon(f, "doc", "vc-ico-xs");
        f.createSpan({ text: item.file.split("/").pop().replace(/\.md$/, "") });
      }
      this.renderAttachments(wrap, item.files);
      if (item.text) wrap.createDiv({ cls: "vc-bubble", text: item.text });
    } else if (item.kind === "assistant") {
      this.renderMarkdown(this.messagesEl.createDiv("vc-msg vc-assistant"), item.text);
    } else if (item.kind === "tool") {
      // Consecutive tool steps share one inset-grouped card.
      let card = this.messagesEl.lastElementChild;
      while (card && (card === this.thinkingEl || card === this.queueEl)) card = card.previousElementSibling;
      if (!card || !card.hasClass("vc-tools")) card = this.messagesEl.createDiv("vc-card vc-tools");
      const el = card.createEl("details", { cls: "vc-tool" });
      this.toolEls.set(item.id, { el, item });
      this.fillTool(el, item);
    } else if (item.kind === "error") {
      this.messagesEl.createDiv({ cls: "vc-error", text: item.text });
    }
    return ret;
  }

  fillTool(el, item) {
    const wasOpen = el.open;
    el.empty();
    const sum = el.createEl("summary", { cls: "vc-tool-row" });
    const status = item.result === undefined ? "is-pending" : item.isError ? "is-failed" : "is-ok";
    sum.createSpan({ cls: "vc-dot " + status });
    sum.createSpan({ cls: "vc-tool-name", text: item.name });
    const path = this.vaultPath(item.input && (item.input.file_path || item.input.notebook_path));
    if (path && FILE_TOOLS.has(item.name)) {
      const link = sum.createEl("a", { cls: "vc-tool-arg vc-link", text: path.split("/").pop().replace(/\.md$/, "") });
      link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.app.workspace.openLinkText(path, "", false); };
    } else {
      sum.createSpan({ cls: "vc-tool-arg", text: toolLabel(item) });
    }
    icon(sum, "chevronRight", "vc-ico-xs vc-tool-chev");
    const body = el.createDiv("vc-tool-body");
    body.createEl("pre", { text: JSON.stringify(item.input, null, 2).slice(0, 3000) });
    if (item.result !== undefined) body.createEl("pre", { text: item.result || "(no output)" });
    el.open = wasOpen;
  }

  vaultPath(abs) {
    if (!abs) return null;
    const root = this.vaultRoot.replace(/\/$/, "") + "/";
    if (this.vaultRoot && abs.startsWith(root)) return abs.slice(root.length);
    if (!abs.startsWith("/")) return abs;
    return null;
  }

  renderMarkdown(el, text, streaming) {
    el.toggleClass("is-streaming", !!streaming);
    el.empty();
    MarkdownRenderer.render(this.app, text, el, "", this);
    el.querySelectorAll("a.internal-link").forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); this.app.workspace.openLinkText(a.getAttr("data-href") || a.getText(), "", false); };
    });
  }

  // Follow new output only while the reader is at the bottom; scrolling up to read stays put.
  scrollDown(force) {
    if (!force && !this.stick) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

const MAX_ATTACHMENT = 20 * 1048576;

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// A small JPEG preview (about 10 KB) so history can show the image without storing it.
function thumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 240 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return content ? JSON.stringify(content) : "";
}

function toolLabel(item) {
  const i = item.input || {};
  const v = i.description || i.command || i.pattern || i.query || i.url || i.prompt || i.file_path || "";
  return String(v).split("\n")[0].slice(0, 80);
}

// ====================================================================================
// Host: on a desktop, the plugin itself serves Claude Code to the sidebar and to paired
// devices (iPad, phone, another computer). Node built-ins only, loaded lazily so the
// plugin still runs on mobile, where these modules don't exist.
// ====================================================================================

const SYSTEM_PROMPT = `You are running inside the user's Obsidian vault through the "Vault Claude" sidebar,
possibly on their iPad or phone. The vault is your working directory. Cite notes as [[note title]];
those links are clickable in the sidebar. Edit notes with your Edit/Write tools. Keep replies
readable on a narrow sidebar.`;

const TRANSCRIBE_PY = `import sys
try:
    from faster_whisper import WhisperModel
except ImportError:
    print("faster-whisper is not installed", file=sys.stderr)
    sys.exit(3)
model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "small", device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], vad_filter=True)
print(" ".join(s.text.strip() for s in segments).strip())
`;

const PERMISSION_MODES = new Set(["acceptEdits", "plan", "default"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function nodeRequire(name) {
  // eslint-disable-next-line no-undef
  return require(name);
}

// The machine's Tailscale address (100.64.0.0/10), if it has one.
function tailscaleIp() {
  const os = nodeRequire("os");
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const [p, q] = a.address.split(".").map(Number);
      if (p === 100 && q >= 64 && q <= 127) return a.address;
    }
  }
  return null;
}

// GUI apps on macOS don't inherit the shell PATH, so look in the usual install spots too.
function findClaude(configured) {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const os = nodeRequire("os");
  if (configured && fs.existsSync(configured)) return configured;
  const home = os.homedir();
  const win = process.platform === "win32";
  const candidates = win
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude", path.join(home, ".claude", "local", "claude")];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  // Last resort: whatever PATH (or the login shell) resolves.
  try {
    const cp = nodeRequire("child_process");
    const out = win
      ? cp.execFileSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true })
      : cp.execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude"], { encoding: "utf8", timeout: 4000 });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l) && !/\.cmd$/i.test(l));
    if (hit) return hit;
  } catch (e) { /* not found */ }
  return null;
}

function findPython() {
  const cp = nodeRequire("child_process");
  const path = nodeRequire("path");
  const os = nodeRequire("os");
  const tries = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []], [path.join(os.homedir(), ".local", "bin", "python3.11.exe"), []]]
    : [["python3", []], ["/opt/homebrew/bin/python3", []], ["/usr/bin/python3", []]];
  for (const [cmd, pre] of tries) {
    try {
      const v = cp.execFileSync(cmd, [...pre, "--version"], { encoding: "utf8", timeout: 4000, windowsHide: true });
      if (/Python 3/.test(v)) return [cmd, pre];
    } catch (e) { /* next */ }
  }
  return null;
}

function sameToken(a, b) {
  const crypto = nodeRequire("crypto");
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Minimal RFC 6455 server connection: text frames, ping/pong, close, fragmentation.
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on("data", (d) => this.feed(d));
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = b1 & 0x80;
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      const opcode = b0 & 0x0f;
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      this.parts.push(payload);
      if (b0 & 0x80) {
        const text = Buffer.concat(this.parts).toString("utf8");
        this.parts = [];
        if (this.onmessage) this.onmessage(text);
      }
    }
  }

  send(obj) {
    if (this.open) this.frame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
  }

  frame(opcode, payload) {
    if (!this.open) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }

  close() {
    if (!this.open) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch (e) { /* gone */ }
    this.socket.end();
    this.closed();
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    if (this.onclose) this.onclose();
  }
}

class Host {
  // config: {vaultPath, port, bind: "tailscale"|"all"|"local", token, claudePath, transcribeCommand}
  constructor(config, log) {
    this.config = config;
    this.log = log || (() => {});
    this.servers = [];
    this.addresses = [];
    this.tmp = null;
  }

  async start() {
    const http = nodeRequire("http");
    const path = nodeRequire("path");
    const os = nodeRequire("os");
    const fs = nodeRequire("fs");
    this.claude = findClaude(this.config.claudePath);
    if (!this.claude) throw new Error("Claude Code wasn't found on this computer. Install it from claude.com/claude-code, or set its path in settings.");
    this.tmp = path.join(os.tmpdir(), "vault-claude");
    fs.mkdirSync(this.tmp, { recursive: true });

    const hosts = [];
    if (this.config.bind === "all") hosts.push("0.0.0.0");
    else {
      hosts.push("127.0.0.1");
      if (this.config.bind !== "local") {
        const ts = tailscaleIp();
        if (ts) hosts.push(ts);
        else this.log("No Tailscale address found; only this computer can connect.");
      }
    }
    for (const h of hosts) {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Vault Claude host. Connect from the Obsidian plugin.\n");
      });
      server.on("upgrade", (req, socket) => this.upgrade(req, socket));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.config.port, h, resolve);
      });
      server.on("error", (e) => this.log("Server error: " + e.message));
      this.servers.push(server);
      this.addresses.push(h);
    }
    this.log(`Hosting on ${this.addresses.map((h) => h + ":" + this.config.port).join(", ")} with ${this.claude}`);
  }

  stop() {
    for (const s of this.servers) { try { s.close(); } catch (e) { /* closed */ } }
    for (const c of this.conns || []) c.close();
    this.servers = [];
    this.addresses = [];
  }

  // The address other devices should use: Tailscale if hosting there, else the first bound one.
  publicUrl() {
    const ts = this.addresses.find((a) => a.startsWith("100."));
    const host = ts || (this.config.bind === "all" ? tailscaleIp() || "127.0.0.1" : this.addresses[0] || "127.0.0.1");
    return `ws://${host}:${this.config.port}`;
  }

  upgrade(req, socket) {
    const crypto = nodeRequire("crypto");
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new WsConn(socket);
    this.conns = this.conns || new Set();
    this.conns.add(ws);
    const peer = socket.remoteAddress;
    let authed = false;
    let proc = null;
    // Unpaired connections get a few seconds to authenticate, then they are dropped.
    const authTimer = setTimeout(() => { if (!authed) ws.close(); }, 5000);

    ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (!authed) {
        if (msg.type === "auth" && sameToken(msg.token, this.config.token)) {
          authed = true;
          clearTimeout(authTimer);
          ws.send({ type: "hello", vault: nodeRequire("path").basename(this.config.vaultPath), vaultRoot: this.config.vaultPath, host: nodeRequire("os").hostname() });
          this.log("Paired device connected: " + peer);
        } else {
          ws.send({ type: "error", code: "auth", message: "This device isn't paired. Paste the pairing code from the host computer in Vault Claude settings." });
          ws.close();
        }
        return;
      }
      if (msg.type === "send") {
        if (proc && proc.exitCode === null) { ws.send({ type: "error", message: "Claude is still working on the last message." }); return; }
        proc = this.runTurn(ws, msg);
      } else if (msg.type === "interrupt") {
        if (proc && proc.exitCode === null) proc.kill();
      } else if (msg.type === "transcribe") {
        this.transcribe(ws, msg);
      } else if (msg.type === "ping") {
        ws.send({ type: "pong" });
      }
    };
    // A running turn keeps going if the device drops, so its edits still land.
    ws.onclose = () => { clearTimeout(authTimer); this.conns.delete(ws); };
  }

  buildPrompt(msg, saved) {
    const ctx = msg.context || {};
    const lines = [];
    if (ctx.activeFile) lines.push(`The note the user is looking at: ${ctx.activeFile}`);
    if (ctx.openFiles && ctx.openFiles.length) lines.push("Other notes they have open in tabs or windows and chose to share (read or edit them as the request needs): " + ctx.openFiles.slice(0, 20).join(", "));
    if (ctx.selection) lines.push("They have this text selected in it:\n<selection>\n" + String(ctx.selection).slice(0, 8000) + "\n</selection>");
    let prompt = String(msg.text || "");
    if (lines.length) prompt = "<obsidian-context>\n" + lines.join("\n") + "\n</obsidian-context>\n\n" + prompt;
    if (saved.length) {
      prompt = "<attachments>\nThe user attached these files. Read them with your Read tool (it handles images and PDFs):\n" +
        saved.map((s) => `- ${s.path} (${s.mime})`).join("\n") + "\n</attachments>\n\n" + prompt;
    }
    return prompt;
  }

  saveAttachments(items) {
    if (!items || !items.length) return [];
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const crypto = nodeRequire("crypto");
    const dir = path.join(this.tmp, "attachments", crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    items.slice(0, 20).forEach((a, i) => {
      const name = path.basename(String(a.name || `file-${i}`)).replace(/[<>:"|?*\x00-\x1f]/g, "_") || `file-${i}`;
      const p = path.join(dir, name);
      try {
        fs.writeFileSync(p, Buffer.from(String(a.data || ""), "base64"));
        saved.push({ path: p, mime: a.mime || "application/octet-stream" });
      } catch (e) { /* skip */ }
    });
    return saved;
  }

  runTurn(ws, msg) {
    const cp = nodeRequire("child_process");
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--append-system-prompt", SYSTEM_PROMPT];
    const mode = PERMISSION_MODES.has(msg.permissionMode) ? msg.permissionMode : "acceptEdits";
    args.push("--permission-mode", mode);
    if (msg.model && /^[\w.-]+$/.test(msg.model)) args.push("--model", msg.model);
    if (EFFORT_LEVELS.has(msg.effort)) args.push("--effort", msg.effort);
    if (msg.sessionId && /^[\w-]+$/.test(msg.sessionId)) args.push("--resume", msg.sessionId);
    const saved = this.saveAttachments(msg.attachments);
    if (saved.length) args.push("--add-dir", nodeRequire("path").dirname(saved[0].path));

    const proc = cp.spawn(this.claude, args, { cwd: this.config.vaultPath, env: process.env, windowsHide: true });
    let sessionId = msg.sessionId || null;
    let pending = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch (e) { continue; }
        if (event.session_id) sessionId = event.session_id;
        ws.send({ type: "event", event });
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on("error", (e) => {
      ws.send({ type: "error", message: "Couldn't start Claude Code: " + e.message });
      ws.send({ type: "done", sessionId, code: -1 });
    });
    proc.on("close", (code) => {
      if (code && stderr.trim()) ws.send({ type: "error", message: stderr.trim().slice(-2000) });
      ws.send({ type: "done", sessionId, code });
    });
    proc.stdin.end(this.buildPrompt(msg, saved));
    return proc;
  }

  transcribeCommand() {
    if (this.config.transcribeCommand) return { shell: this.config.transcribeCommand };
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    if (this.python === undefined) this.python = findPython();
    if (!this.python) return null;
    const script = path.join(this.tmp, "transcribe.py");
    fs.writeFileSync(script, TRANSCRIBE_PY);
    return { file: this.python[0], args: [...this.python[1], script] };
  }

  transcribe(ws, msg) {
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const cp = nodeRequire("child_process");
    const crypto = nodeRequire("crypto");
    const ext = { "audio/mp4": ".m4a", "audio/ogg": ".ogg" }[String(msg.mime || "").split(";")[0]] || ".webm";
    const file = path.join(this.tmp, "dictation-" + crypto.randomBytes(4).toString("hex") + ext);
    fs.writeFileSync(file, Buffer.from(String(msg.data || ""), "base64"));
    const cmd = this.transcribeCommand();
    const done = (payload) => { try { fs.unlinkSync(file); } catch (e) { /* gone */ } ws.send({ type: "transcript", ...payload }); };
    if (!cmd) return done({ error: "Dictation needs Python 3 with faster-whisper on the host computer." });
    const child = cmd.shell
      ? cp.spawn(cmd.shell.includes("{file}") ? cmd.shell.split("{file}").join(`"${file}"`) : `${cmd.shell} "${file}"`, { shell: true, windowsHide: true })
      : cp.spawn(cmd.file, [...cmd.args, file], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => done({ error: "Couldn't run speech-to-text: " + e.message }));
    child.on("close", (code) => {
      if (code === 0) return done({ text: out.trim() });
      if (code === 3) {
        const py = this.python ? [this.python[0], ...this.python[1]].join(" ") : "python3";
        return done({ error: `Speech-to-text isn't installed on the host computer yet. Run this there:\n${py} -m pip install faster-whisper` });
      }
      done({ error: "Couldn't transcribe that recording. " + err.trim().split("\n").pop() });
    });
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newPairingCode() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

class VaultClaudeSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    containerEl.empty();
    containerEl.addClass("vc-settings");

    if (Platform.isDesktopApp) {
      new Setting(containerEl).setName("This computer").setHeading();
      const status = plugin.hosting()
        ? `Running. Claude Code: ${plugin.host.claude}`
        : plugin.hostError || (plugin.hostEnabled() ? "Starting…" : "Off. This device connects to another computer instead.");
      new Setting(containerEl)
        .setName("Run Claude Code on this computer")
        .setDesc(status)
        .addToggle((t) => t.setValue(plugin.hostEnabled()).onChange(async (on) => {
          plugin.setHostEnabled(on);
          if (on) await plugin.startHost(); else plugin.stopHost();
          this.display();
        }));

      if (plugin.hostEnabled()) {
        new Setting(containerEl)
          .setName("Who can connect")
          .setDesc("Tailscale lets your iPad, phone or other computers reach this one from anywhere. Every device still needs the pairing code.")
          .addDropdown((d) => d
            .addOptions({ local: "This computer only", tailscale: "My Tailscale devices", all: "Any network (not recommended)" })
            .setValue(s.hostBind)
            .onChange(async (v) => { s.hostBind = v; await plugin.saveSettings(); await plugin.startHost(); this.display(); }));

        const code = new Setting(containerEl)
          .setName("Pairing code")
          .setDesc("Enter this on your other devices. If your vault syncs (iCloud, Obsidian Sync), they get it automatically.");
        code.controlEl.createEl("code", { cls: "vc-code", text: s.pairingCode || "—" });
        code.addButton((b) => b.setButtonText("Copy").onClick(() => { navigator.clipboard.writeText(s.pairingCode); new Notice("Pairing code copied"); }));
        code.addButton((b) => b.setButtonText("New code").setWarning().onClick(async () => {
          s.pairingCode = newPairingCode();
          if (plugin.host) plugin.host.config.token = s.pairingCode;
          await plugin.saveSettings();
          this.display();
        }));

        if (plugin.hosting() && s.hostBind !== "local") {
          const url = plugin.host.publicUrl();
          const addr = new Setting(containerEl)
            .setName("Address for your other devices")
            .setDesc(s.serverUrl === url ? "Your synced devices already use this address." : "Your other devices use a different address. Tap Use to point them here.");
          addr.controlEl.createEl("code", { cls: "vc-code", text: url });
          addr.addButton((b) => b.setButtonText("Copy").onClick(() => { navigator.clipboard.writeText(url); new Notice("Address copied"); }));
          if (s.serverUrl !== url) addr.addButton((b) => b.setButtonText("Use").setCta().onClick(async () => { s.serverUrl = url; await plugin.saveSettings(); this.display(); }));
        }

        let restartTimer = null;
        const restartSoon = () => { clearTimeout(restartTimer); restartTimer = window.setTimeout(() => plugin.startHost().then(() => this.display()), 1200); };
        new Setting(containerEl)
          .setName("Port")
          .addText((t) => t.setValue(String(s.hostPort)).onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!(n > 0 && n < 65536)) return;
            s.hostPort = n;
            await plugin.saveSettings();
            restartSoon();
          }));
        new Setting(containerEl)
          .setName("Claude Code location")
          .setDesc("Leave blank to find it automatically.")
          .addText((t) => t.setPlaceholder(plugin.host ? plugin.host.claude : "claude").setValue(s.claudePath).onChange(async (v) => {
            s.claudePath = v.trim();
            await plugin.saveSettings();
            restartSoon();
          }));
        new Setting(containerEl)
          .setName("Speech-to-text command")
          .setDesc("Leave blank to use Python with faster-whisper on this computer. Or give a command that prints the text of the audio file at {file}.")
          .addText((t) => t.setPlaceholder("python3 transcribe.py {file}").setValue(s.transcribeCommand).onChange(async (v) => {
            s.transcribeCommand = v.trim();
            if (plugin.host) plugin.host.config.transcribeCommand = s.transcribeCommand;
            await plugin.saveSettings();
          }));
      }
    }

    new Setting(containerEl).setName(Platform.isDesktopApp ? "Connect to another computer" : "Connect to your computer").setHeading();
    if (Platform.isDesktopApp && plugin.hostEnabled()) {
      containerEl.createDiv({ cls: "setting-item-description vc-settings-note", text: "This computer runs Claude Code itself, so it doesn't use these. They are what your other devices use." });
    }
    new Setting(containerEl)
      .setName("Computer address")
      .setDesc("Shown in Vault Claude settings on the computer running Claude Code, for example ws://100.101.102.103:8787.")
      .addText((t) => t.setPlaceholder("ws://100.x.y.z:8787").setValue(s.serverUrl).onChange(async (v) => {
        s.serverUrl = v.trim();
        await plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Pairing code")
      .addText((t) => t.setPlaceholder("XXXX-XXXX-XXXX-XXXX").setValue(s.pairingCode).onChange(async (v) => {
        s.pairingCode = v.trim().toUpperCase();
        if (plugin.host) plugin.host.config.token = s.pairingCode;
        await plugin.saveSettings();
      }))
      .addButton((b) => b.setButtonText("Reconnect").onClick(() => plugin.views().forEach((v) => v.reconnect())));
  }
}

module.exports = class VaultClaudePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.host = null;
    this.hostError = "";
    this.registerView(VIEW_TYPE, (leaf) => new VaultClaudeView(leaf, this));
    this.addRibbonIcon("sparkles", "Open Claude", () => this.activate());
    this.addCommand({ id: "open", name: "Open chat", callback: () => this.activate() });
    this.addCommand({
      id: "ask-about-selection",
      name: "Ask about selection",
      editorCallback: async (editor) => {
        const view = await this.activate();
        if (view && editor.getSelection()) { view.inputEl.value = "About the selected text: "; view.inputEl.focus(); }
      },
    });
    this.addSettingTab(new VaultClaudeSettings(this.app, this));
    if (this.hostEnabled()) this.app.workspace.onLayoutReady(() => this.startHost());
  }

  onunload() {
    this.stopHost();
  }

  // Whether this device hosts is a per-device choice, so it lives in local storage rather than
  // data.json (which syncs to the iPad). Desktops host by default.
  hostEnabled() {
    if (!Platform.isDesktopApp) return false;
    return this.local("host") !== "off";
  }

  setHostEnabled(on) {
    this.local("host", on ? "on" : "off");
  }

  local(key, value) {
    const k = "vault-claude-" + key;
    if (typeof this.app.loadLocalStorage === "function") {
      if (value === undefined) return this.app.loadLocalStorage(k);
      return this.app.saveLocalStorage(k, value);
    }
    const scoped = k + ":" + this.app.vault.getName();
    if (value === undefined) return window.localStorage.getItem(scoped);
    window.localStorage.setItem(scoped, value);
  }

  hosting() {
    return !!(this.host && this.host.servers.length);
  }

  // The host device talks to its own host over localhost; everything else uses serverUrl.
  clientUrl() {
    if (this.hosting()) return `ws://127.0.0.1:${this.host.config.port}`;
    if (this.hostEnabled() && !this.hostError) return ""; // still starting
    return this.settings.serverUrl;
  }

  async startHost() {
    this.stopHost();
    const s = this.settings;
    if (!s.pairingCode) { s.pairingCode = newPairingCode(); await this.saveSettings(); }
    const adapter = this.app.vault.adapter;
    const port = Number(s.hostPort) || 8787;
    const host = new Host({
      vaultPath: typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "",
      port,
      bind: s.hostBind,
      token: s.pairingCode,
      claudePath: s.claudePath,
      transcribeCommand: s.transcribeCommand,
    }, (m) => console.log("[vault-claude]", m));
    try {
      await host.start();
      this.host = host;
      this.hostError = "";
      if (s.hostBind !== "local" && !s.serverUrl) { s.serverUrl = host.publicUrl(); await this.saveSettings(); }
    } catch (e) {
      host.stop();
      this.host = null;
      this.hostError = e && e.code === "EADDRINUSE"
        ? `Port ${port} is already in use on this computer. Choose another port.`
        : `Couldn't start: ${(e && e.message) || e}`;
      console.error("[vault-claude]", e);
    }
    this.views().forEach((v) => v.reconnect());
  }

  stopHost() {
    if (this.host) this.host.stop();
    this.host = null;
  }

  // Another device saved data.json (iCloud, Obsidian Sync). Pick up a new address or pairing
  // code without a restart; chats on this device are left as they are.
  async onExternalSettingsChange() {
    const data = (await this.loadData()) || {};
    let changed = false;
    for (const key of ["serverUrl", "pairingCode"]) {
      if (this.hosting() && key === "pairingCode") continue; // the host owns its code
      if (data[key] && data[key] !== this.settings[key]) { this.settings[key] = data[key]; changed = true; }
    }
    if (changed) this.views().forEach((v) => v.reconnect());
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view);
  }

  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
