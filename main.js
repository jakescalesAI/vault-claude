/* Quartzi Copilot: a chat sidebar for Claude Code, on your own computer and your own Claude login.
   On a desktop the plugin hosts Claude Code itself (see Host below) and other devices (iPad,
   phone) connect to it over Tailscale with a pairing code. The chat UI uses no Node APIs, so it
   runs on mobile. Styled after Apple's HIG; see styles.css. */
const { addIcon, normalizePath, Plugin, ItemView, PluginSettingTab, Setting, MarkdownRenderer, MarkdownView, Platform, Notice, requestUrl, TFile } = require("obsidian");

const VIEW_TYPE = "vault-claude-view";
const DEFAULT_SETTINGS = {
  serverUrl: "", // the host other devices connect to, e.g. ws://100.x.y.z:8787 (kept on each device, see LOCAL_SETTINGS)
  pairingCode: "", // made by the host and typed into each other device once (kept on each device)
  hostPort: 8787,
  placement: "beside", // iPad: "beside" the note or "sidebar"
  hostBind: "local", // "local" | "tailscale" | "all"
  claudePath: "",
  transcribeCommand: "",
  model: "sonnet",
  effort: "medium",
  permissionMode: "acceptEdits",
  provider: "claude",
  providerModel: "",
  sendContext: true,
  logPath: "0 Home/0 Quartzi Copilot/Build log.md", // outside the sorter and the scheduler
  keepToolOutput: false, // keep what tools returned in saved chats (kept on each device)
  sessions: [], // [{id, title, updated, pinned?, items: [...]}] newest first
};
// Settings that belong to one device and never go into data.json. data.json syncs to every device and can
// be read by anything that reads the vault, and these either let a device run things on the host (the
// pairing code), decide what the host runs (Claude Code's path, the speech command), or where it listens.
const LOCAL_SETTINGS = ["serverUrl", "pairingCode", "hostPort", "hostBind", "claudePath", "transcribeCommand", "keepToolOutput"];
const MIN_CODE_LENGTH = 16;

// What a saved chat keeps of a tool call when tool output is not kept: its name and the short facts
// that say what it touched, never what came back.
function trimToolItem(item) {
  if (!item || item.kind !== "tool") return item;
  const input = {};
  for (const k of ["file_path", "notebook_path", "path", "pattern", "command", "url", "description", "query"]) {
    if (item.input && item.input[k] !== undefined) input[k] = String(item.input[k]).slice(0, 300);
  }
  const out = Object.assign({}, item, { input, trimmed: true });
  if (item.result !== undefined) out.result = "";
  return out;
}

function trimSession(s) {
  return Object.assign({}, s, { items: (s.items || []).map(trimToolItem) });
}

// Model replies are shown as markdown. A picture in markdown loads from the internet as soon as it is
// drawn, which would let a reply send words from the chat to any address without anyone clicking.
// Pictures become plain links, and HTML that loads things is shown as text. Vault embeds (![[...]]) stay.
// Code blocks and inline code are left exactly as they are.
function safeMarkdown(text) {
  const parts = String(text || "").split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/);
  return parts.map((p, i) => {
    if (i % 2) return p; // code
    return p
      .replace(/!\[(?!\[)/g, "[")
      .replace(/<(?=\/?\s*(img|image|iframe|frame|video|audio|source|track|embed|object|picture|link|meta|base|svg|style|script)\b)/gi, "&lt;");
  }).join("");
}
const MODELS = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const QUARTZI_MARK = '<g transform="scale(1.5625)" fill="currentColor"><polygon points="35.54,12.91 39.42,16.80 16.80,39.42 12.91,35.54"/><polygon opacity=".85" points="39.42,16.80 47.20,24.58 24.58,47.20 16.80,39.42"/><polygon opacity=".45" points="47.20,24.58 51.09,28.46 28.46,51.09 24.58,47.20"/><polygon opacity=".95" points="35.54,12.91 39.42,16.80 51.09,12.91"/><polygon opacity=".9" points="39.42,16.80 47.20,24.58 51.09,12.91"/><polygon opacity=".55" points="47.20,24.58 51.09,28.46 51.09,12.91"/><polygon opacity=".93" points="12.91,35.54 16.80,39.42 12.91,51.09"/><polygon opacity=".78" points="16.80,39.42 24.58,47.20 12.91,51.09"/><polygon opacity=".35" points="24.58,47.20 28.46,51.09 12.91,51.09"/></g>';
const EFFORTS = [["low", "Low"], ["medium", "Med"], ["high", "High"], ["max", "Max"]];
const MODES = [["auto", "Auto"], ["acceptEdits", "Edit"], ["plan", "Plan"], ["default", "Read"]];
// Plan and Auto read files anywhere on the computer without asking, and an outside chat would send them on.
const OUTSIDE_MODES = MODES.filter(([v]) => v === "acceptEdits" || v === "default");
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
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  xmark: '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>',
  paperclip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  pin: '<path d="M12 17v4"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  pinFill: '<path d="M12 17v4"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" fill="currentColor"/>',
};
function icon(parent, name, cls) {
  const span = parent.createSpan({ cls: "vc-ico" + (cls ? " " + cls : "") });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// Why a request to the host's /status failed. The words differ by platform, so the time it took
// is the tie-break: a refusal comes back at once, silence takes a while.
function probeFailure(message, ms) {
  const m = String(message || "");
  if (/offline|no route|unreachable|not connected to the internet|network connection was lost/i.test(m)) return { offline: true };
  if (/refused|could not connect|err_connection_refused/i.test(m)) return { refused: true };
  if (/timed? ?out/i.test(m)) return { timeout: true };
  return ms < 1500 ? { refused: true } : { timeout: true };
}

// Which versions each end runs, and whether they differ.
function versionsText(mine, host, hostAt) {
  const seen = host === undefined ? "not reached yet" : !host ? "older than 0.9.0" : host + (hostAt ? ` (last seen ${whenText(hostAt)})` : "");
  const line = `This device: ${mine}. Your computer: ${seen}.`;
  return host !== undefined && host !== mine ? line + " The versions differ, so update the older one." : line;
}

// Names the reason this device can't use the host. probe is what /status said: {ok, version},
// {refused}, {offline} or {timeout}. last is what the host reported the last time it was reached.
function diagnose({ url, mobile, unpaired, probe, version, last }) {
  const host = probe && probe.ok ? probe.version || "" : last ? last.version : undefined;
  const at = probe && probe.ok ? 0 : last && last.at;
  const end = (cause, title, why) => ({ cause, title, message: [why, versionsText(version, host, at)].filter(Boolean).join("\n\n") });
  if (!url) return end("setup", "Not Set Up", "Add your computer's address and pairing code in Quartzi Copilot settings.");
  if (mobile && /\/\/(127\.|localhost)/.test(url)) return end("loopback", "Wrong Address", `${url} only works on the computer itself. Use the address shown in Quartzi Copilot settings on your computer.`);
  if (unpaired) return end("pairing", "Pairing Code Doesn't Match", "Your computer is reachable, but it rejected the pairing code. Copy the code from Quartzi Copilot settings on your computer and paste it here.");
  const tailnet = /\/\/100\./.test(url);
  if (probe && probe.ok) return end("socket", "Can't Open the Chat", `Quartzi Copilot is running on your computer, but this device couldn't open the chat connection to ${url}. Tap Retry. If it keeps failing, restart Obsidian on both.`);
  if (probe && probe.refused) return end("closed", "Quartzi Copilot Isn't Running There", `Your computer answered at ${url}, but nothing is listening. Obsidian is closed on it, this vault isn't open, or Who can connect is set to This computer only.`);
  if (probe && probe.offline) return end("offline", "This Device Isn't Connected", tailnet ? `This device has no route to ${url}. Open the Tailscale app here and turn it on.` : `This device has no route to ${url}. Check its network.`);
  if (last && last.notOnTailscale) return end("no-tailscale", "Your Computer Isn't on Tailscale", `No answer from ${url}, and your computer said it wasn't on Tailscale the last time it was reached. Open Tailscale on it and connect.`);
  return end("asleep", "Can't Reach Your Computer", `No answer from ${url}. Your laptop is probably asleep or off. Wake it and keep Obsidian open.` + (tailnet ? " If it's awake, check that Tailscale says Connected on it and on this device." : " If it's awake, check the address and that its firewall allows Obsidian."));
}

// Why the build log can't go at this path, or "" if it can.
// The money folder. Since 11-12-2026 a chat that runs on Claude or on a model on this computer
// can read and edit it like any other folder.
// A chat that leaves for another provider still cannot: what a chat reads reaches whichever provider it runs on.
// It is "6 Money" now and was "10 Money" before the folders were renumbered, and both names are covered.
const PRIVATE_FOLDERS = ["6 Money", "10 Money"]; const PRIVATE_DENY = PRIVATE_FOLDERS.flatMap((f) => [`Read(./${f}/**)`, `Edit(./${f}/**)`, `Bash(*${f}*)`, `PowerShell(*${f}*)`]);
// Chats that leave this computer get no shell, because a plain grep -r would carry the money folder with it,
// no Obsidian trash or git history, because both can hold copies from there, and no .obsidian,
// because plugin data holds pairing codes and sync logins, and plugin code runs when edited.
function outsideDeny(configDir, tmp, claudeConfig) {
  const folders = [".trash", ".git", ".obsidian*"].concat(configDir ? [configDir] : []);
  return ["Bash", "PowerShell", "Monitor", ...folders.flatMap((d) => [`Read(./${d}/**)`, `Edit(./${d}/**)`]),
    // Attachments from every other kind of chat live here.
    `Read(${absoluteRule(tmp)}/**)`, `Edit(${absoluteRule(tmp)}/**)`,
    // Claude Code lets a chat write its memory folder without asking, even with memory off.
    `Edit(${absoluteRule(claudeConfig)}/projects/*/memory/**)`];
}
// Every chat, whatever it runs on, may not change Obsidian's settings or plugins.
function configDeny(configDir) {
  const dirs = Array.from(new Set([".obsidian", configDir || ".obsidian"]));
  return dirs.flatMap((d) => [`Edit(./${d}/**)`, `Bash(*${d}*)`, `PowerShell(*${d}*)`]);
}
// An absolute path in a permission rule starts with two slashes, and a Windows drive loses its colon.
function absoluteRule(p) { return "/" + String(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1"); }
const NO_SHELL_PROMPT = "Shell commands are off in this chat. If a task needs one, say so plainly.";
const PRIVATE_PROMPT = `Never read, search, list or edit the ${PRIVATE_FOLDERS[0]} folder, even if asked. Leave it out of any shell search, for example grep --exclude-dir="${PRIVATE_FOLDERS[0]}".`;

function isPrivate(path) {
  return String(path || "").replace(/\\/g, "/").split("/").some((p) => PRIVATE_FOLDERS.some((f) => p.trim().toLowerCase() === f.toLowerCase()));
}

function logProblem(path) {
  const parts = String(path || "").split("/").map((p) => p.trim().toLowerCase());
  if (!/\.md$/i.test(path || "")) return "The build log has to be a note ending in .md.";
  if (parts.includes("..") || parts.includes("")) return "The build log path isn't valid.";
  if (isPrivate(path)) return `The build log can't live in ${PRIVATE_FOLDERS[0]}.`;
  return "";
}

// One plain bullet, never a checkbox: the scheduler books any checkbox it finds.
function logLine(text, when, version, device) {
  const clean = String(text).replace(/\s+/g, " ").replace(/^[-*+]\s+/, "").replace(/^\[[ xX]?\]\s*/, "").trim();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `- ${stamp} · ${clean} · Copilot ${version}, ${device}`;
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
  getDisplayText() { return "Quartzi Copilot"; }
  getIcon() { return "quartzi"; }

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
    const statusRow = titles.createDiv({ cls: "vc-status-row", attr: { role: "button", "aria-label": "Check connection" } });
    statusRow.onclick = () => this.connectionAlert();
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
    this.replyEl = composer.createDiv("vc-reply-bar");
    this.trayEl = composer.createDiv("vc-tray");
    const field = composer.createDiv("vc-field");
    this.inputEl = field.createEl("textarea", { cls: "vc-input", attr: { placeholder: "Message", rows: "1" } });
    this.inputEl.addEventListener("input", () => { this.autosize(); this.updateSendButton(); });
    // A tap on the rounded field around the box counts as a tap on the box, so the keyboard comes up either way.
    field.addEventListener("click", (e) => { if (e.target === field) this.inputEl.focus(); });
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
    this.usageBtn = controls.createEl("button", { cls: "vc-icon-btn vc-usage", attr: { "aria-description": "Usage" } });
    this.usageBtn.onclick = (e) => {
      e.stopPropagation();
      // A click keeps a hover-opened card open; a second click closes it.
      if (this.menuEl && this.menuEl.hasClass("is-hover")) this.menuEl.removeClass("is-hover");
      else this.openUsage();
    };
    this.usageBtn.onmouseenter = () => { if (!this.menuEl) this.openUsage(true); };
    this.usageBtn.onmouseleave = () => { if (this.menuEl && this.menuEl.hasClass("is-hover")) this.closeMenu(); };
    this.brainBtn = this.iconButton(controls, "brain", "Mode, model and effort", (e) => { e.stopPropagation(); this.openSettingsMenu(); });
    this.brainBtn.addClass("vc-brain");
    this.updateUsage();

    // Keep the last message clear of the floating composer, whatever its height.
    // On a phone Obsidian's floating toolbar lies over the bottom of a view in the main area, right where the message
    // box is, and takes the taps meant for it. Measure how far it reaches into this view and stay above it.
    const nav = () => {
      const bar = document.querySelector(".mobile-navbar");
      let up = 0;
      if (bar && document.body.classList.contains("is-floating-nav")) {
        const b = bar.getBoundingClientRect(), r = root.getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.top < r.bottom && b.bottom > r.top && b.left < r.right && b.right > r.left) up = Math.max(0, Math.round(r.bottom - b.top) + 8);
      }
      root.style.setProperty("--vc-nav", up + "px");
    };
    const fit = () => { nav(); root.style.setProperty("--vc-composer-h", composer.offsetHeight + "px"); };
    this.registerEvent(this.app.workspace.on("layout-change", () => window.setTimeout(nav, 150)));
    this.registerDomEvent(window, "resize", () => window.setTimeout(nav, 150));
    this.registerDomEvent(this.inputEl, "focus", () => window.setTimeout(nav, 400));
    this.registerDomEvent(this.inputEl, "blur", () => window.setTimeout(nav, 400));
    const vv = window.visualViewport;
    if (vv && (Platform.isMobile || !Platform.isDesktopApp)) {
      let hint = null; // the height the keyboard announced, until Obsidian's own value has caught up
      const lift = (glide) => {
        // Obsidian's phone app publishes the keyboard's height. A side drawer does not shrink for the keyboard the way
        // the main area does, so the part of this view the keyboard covers is worked out from that height as well.
        const shell = hint === null ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-height")) || 0) : hint;
        const visibleBottom = Math.min(vv.offsetTop + vv.height, window.innerHeight - shell);
        const kb = Math.max(0, Math.round(root.getBoundingClientRect().bottom - visibleBottom));
        const was = this.kb || 0;
        this.kb = kb;
        if (this.kbNote) this.kbNote(shell);
        if (kb === was) return; // nothing moved: leave a glide that is under way alone
        // Glide only when the keyboard itself is moving. Anything else (Obsidian resizing the view) is applied at once.
        root.toggleClass("vc-kb-glide", glide === true);
        root.style.setProperty("--vc-kb", kb + "px");
        root.toggleClass("vc-keyboard", kb > 40);
        if (kb > was && this.messagesEl) this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: glide === true ? "smooth" : "auto" });
      };
      this.registerDomEvent(vv, "resize", lift);
      this.registerDomEvent(vv, "scroll", lift);
      this.registerDomEvent(this.inputEl, "focus", () => { window.setTimeout(() => lift(true), 50); window.setTimeout(lift, 400); });
      this.registerDomEvent(this.inputEl, "blur", () => window.setTimeout(lift, 300));
      // Obsidian announces the keyboard with these two events and moves its own layout over the next half second.
      // The move starts the instant the keyboard does, in one glide. The later looks only correct it, without animation.
      // The keyboard announces itself before it moves: "will show" carries the height it is about to have, "will hide"
      // means it is going to zero. Obsidian's own --keyboard-height only changes once the keyboard has finished, so
      // waiting for it left the box behind. The announced height is used until Obsidian's value has caught up.
      let turn = 0;
      const settle = (open, e) => {
        const mine = ++turn;
        const told = e ? Number(e.keyboardHeight || (e.detail && e.detail.keyboardHeight) || 0) : 0;
        hint = open ? (told > 0 ? told : null) : 0;
        nav(); lift(true);
        // No height announced: catch Obsidian's value the moment it is set.
        if (open && hint === null) for (const ms of [16, 40, 80, 140, 220]) window.setTimeout(() => { if (mine === turn) lift(true); }, ms);
        window.setTimeout(() => { if (mine === turn) { nav(); lift(); } }, 420);
        window.setTimeout(() => { if (mine === turn) { hint = null; nav(); lift(); } }, 1000);
      };
      // Obsidian resizes its main area when its own keyboard animation ends. Follow that in the same frame.
      if (window.ResizeObserver) {
        const watch = new ResizeObserver(() => lift());
        watch.observe(root);
        this.register(() => watch.disconnect());
      }
      this.registerDomEvent(window, "keyboardWillShow", (e) => settle(true, e));
      this.registerDomEvent(window, "keyboardWillHide", (e) => settle(false, e));
      // A line of keyboard measurements above the message box, hidden unless switched on in this device's settings.
      // It is there so a layout problem on a phone can be read off a screenshot.
      const note = createDiv({ cls: "vc-kb-note" });
      composer.insertBefore(note, field);
      this.kbNote = (shell) => {
        const on = this.plugin.local("kbdebug") === "on";
        note.style.display = on ? "" : "none";
        if (!on) return;
        if (shell === undefined) shell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-height")) || 0;
        const r = root.getBoundingClientRect();
        note.setText(`build ${BUILD} · lift ${this.kb || 0} · keyboard ${shell} · visible ${Math.round(vv.height)} at ${Math.round(vv.offsetTop)} · screen ${window.innerHeight} · view ends ${Math.round(r.bottom)} · ${root.closest(".workspace-drawer") ? "drawer" : "main"}`);
      };
      this.kbNote();
    }
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
    this.registerDomEvent(this.messagesEl, "contextmenu", (e) => {
      const el = this.messageAt(e.target);
      if (!el) return;
      e.preventDefault();
      this.openMessageMenu(el, e.clientX, e.clientY);
    });
    // Touch: hold a message for half a second.
    let press = null;
    const clearPress = () => { if (press) clearTimeout(press.timer); press = null; };
    this.registerDomEvent(this.messagesEl, "touchstart", (e) => {
      const el = this.messageAt(e.target);
      if (!el || e.touches.length !== 1) return;
      const t = e.touches[0];
      press = { x: t.clientX, y: t.clientY, timer: window.setTimeout(() => { press = null; this.openMessageMenu(el, t.clientX, t.clientY); }, 500) };
    }, { passive: true });
    this.registerDomEvent(this.messagesEl, "touchmove", (e) => {
      if (press && e.touches[0] && Math.hypot(e.touches[0].clientX - press.x, e.touches[0].clientY - press.y) > 10) clearPress();
    }, { passive: true });
    this.registerDomEvent(this.messagesEl, "touchend", clearPress);
    this.registerDomEvent(this.messagesEl, "touchcancel", clearPress);
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
    const providers = this.readyProviders();
    const provider = providers.find((x) => x.id === s.provider);
    group("Mode", provider && provider.kind !== "anthropic" && !provider.local ? OUTSIDE_MODES : MODES, "permissionMode");
    const pick = (title, options, value, onChange) => {
      menu.createDiv({ cls: "vc-menu-section", text: title });
      const sel = menu.createEl("select", { cls: "dropdown vc-select" });
      for (const [v, label] of options) sel.createEl("option", { text: label, attr: { value: v } });
      sel.value = value;
      sel.onchange = () => onChange(sel.value);
    };
    const redraw = () => { this.plugin.saveSettings(); this.updateBrain(); this.closeMenu(); this.openSettingsMenu(); };
    pick("Provider", [["claude", "Claude"], ...providers.map((x) => [x.id, x.name])], provider ? s.provider : "claude", (v) => {
      s.provider = v;
      const next = providers.find((x) => x.id === v);
      s.providerModel = next ? next.models[0] || "" : "";
      redraw();
    });
    if (provider) {
      const listed = provider.models.includes(s.providerModel);
      const label = (m) => m.replace(/^models\//, "") + ((provider.noTools || []).includes(m) ? " · text only" : "");
      if (provider.models.length) pick("Model", [...provider.models.map((m) => [m, label(m)]), ["", "Type a model…"]], listed ? s.providerModel : "", (v) => { s.providerModel = v; redraw(); });
      if (!listed) {
        if (!provider.models.length) menu.createDiv({ cls: "vc-menu-section", text: "Model" });
        const typed = menu.createEl("input", { cls: "vc-model-input", attr: { type: "text", placeholder: "Type the model name", "aria-label": "Model name", autocapitalize: "off", spellcheck: "false" } });
        typed.value = s.providerModel || "";
        typed.onchange = () => { s.providerModel = typed.value.trim(); this.plugin.saveSettings(); this.updateBrain(); };
      }
      if (provider.kind === "anthropic") group("Effort", EFFORTS, "effort");
    } else {
      group("Model", MODELS, "model");
      group("Effort", EFFORTS, "effort");
    }
    if (!providers.length) menu.createDiv({ cls: "vc-caption vc-usage-note", text: "Add other providers in Quartzi Copilot settings on your computer." });
    this.placeMenu(menu, this.brainBtn, 4);
  }

  // Tint the brain when anything differs from the defaults, so the state is visible at a glance.
  // ---------- usage ----------
  // A ring fills as the chat uses its context window; the popover adds plan limits, like Quartzi.
  updateUsage() {
    if (!this.usageBtn) return;
    const c = (this.session && this.session.context) || {};
    const frac = c.used && c.window ? Math.min(1, c.used / c.window) : 0;
    const R = 7, C = 2 * Math.PI * R;
    this.usageBtn.innerHTML = `<svg viewBox="0 0 20 20" class="vc-ring"><circle cx="10" cy="10" r="${R}" class="vc-ring-track"/><circle cx="10" cy="10" r="${R}" class="vc-ring-fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>`;
    this.usageBtn.toggleClass("is-high", frac >= 0.8);
    if (this.menuEl && this.menuEl.hasClass("vc-menu-usage")) { const hover = this.menuEl.hasClass("is-hover"); this.closeMenu(); this.openUsage(hover); }
  }

  openUsage(hover) {
    if (this.closeMenu() && !hover) return;
    const menu = this.root.createDiv("vc-menu vc-menu-usage vc-material" + (hover ? " is-hover" : ""));
    menu.onclick = (e) => e.stopPropagation();
    const bar = (label, sub, value, frac) => {
      const row = menu.createDiv("vc-usage-row");
      const head = row.createDiv("vc-usage-head");
      const l = head.createSpan({ cls: "vc-usage-label", text: label });
      if (sub) l.createSpan({ cls: "vc-usage-sub", text: " · " + sub });
      head.createSpan({ cls: "vc-usage-value vc-num", text: value });
      const track = row.createDiv("vc-usage-track");
      const fill = track.createDiv("vc-usage-fill");
      fill.style.width = Math.round(Math.min(1, Math.max(0, frac)) * 100) + "%";
      if (frac >= 0.8) fill.addClass("is-high");
    };
    const c = (this.session && this.session.context) || {};
    if (c.used && c.window) bar("Context window", "", `${tokens(c.used)} / ${tokens(c.window)} (${Math.round((c.used / c.window) * 100)}%)`, c.used / c.window);
    else bar("Context window", "", "New chat", 0);
    const onClaude = this.plugin.settings.provider === "claude";
    const info = onClaude ? this.plugin.settings.limits : null;
    const windows = (info && info.unifiedWindows) || {};
    const names = Object.keys(windows).sort((a, b) => (a === "five_hour" ? -1 : b === "five_hour" ? 1 : a.localeCompare(b)));
    for (const k of names) {
      const w = windows[k];
      if (typeof w.utilization !== "number") continue;
      bar(limitName(k), w.resetsAt ? "resets in " + untilText(w.resetsAt) : "", Math.round(w.utilization * 100) + "%", w.utilization);
    }
    if (!names.length && onClaude) menu.createDiv({ cls: "vc-caption vc-usage-note", text: "Plan limits appear after your first reply." });
    this.placeMenu(menu, this.usageBtn, 6);
  }

  // Opens above the anchor, lined up with it, but never past either edge of the pane.
  placeMenu(menu, anchor, gap) {
    const r = anchor.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    const wanted = box.right - r.right;
    menu.style.right = `${Math.max(8, Math.min(wanted, box.width - menu.offsetWidth - 8))}px`;
    menu.style.bottom = `${box.bottom - r.top + gap}px`;
    this.menuEl = menu;
  }

  updateBrain() {
    const s = this.plugin.settings;
    this.brainBtn.toggleClass("is-custom", s.provider !== "claude" || s.permissionMode !== "acceptEdits" || s.model !== DEFAULT_SETTINGS.model || s.effort !== DEFAULT_SETTINGS.effort);
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

  // Asks the host's /status over plain HTTP, which still answers when the chat socket can't open.
  async probeHost(url) {
    const started = Date.now();
    const ask = requestUrl({ url: url.replace(/^ws/, "http").replace(/\/+$/, "") + "/status", throw: false }).then((res) => {
      let body = null;
      try { body = JSON.parse(res.text); } catch (e) { /* a host older than 0.9.0 sends plain text */ }
      return { ok: true, version: (body && body.version) || "" };
    }).catch((e) => probeFailure(e && e.message, Date.now() - started));
    return Promise.race([ask, new Promise((resolve) => window.setTimeout(() => resolve({ timeout: true }), 5000))]);
  }

  // The connection as this device sees it right now, with both versions.
  async connectionAlert() {
    const retry = { label: "Retry", primary: true, run: () => this.reconnect() };
    const version = this.plugin.manifest.version;
    if (this.isReady()) {
      const notes = this.hostWarnings || [];
      this.alert(notes.length ? "Connected, With a Problem" : "Connected", [...notes, versionsText(version, this.hostVersion || "")].join("\n\n"), [{ label: "OK", primary: true }]);
      return;
    }
    if (this.state === "connecting" && this.plugin.clientUrl()) return this.alert("Still Connecting", `Trying ${this.plugin.clientUrl()}. Give it a few seconds, then send again.`, [{ label: "OK" }, retry]);
    const url = this.plugin.clientUrl();
    const unpaired = this.state === "unpaired" || this.lastFail === "unpaired";
    const probe = url && !unpaired ? await this.probeHost(url) : null;
    const d = diagnose({ url, mobile: !Platform.isDesktopApp, unpaired, probe, version, last: this.plugin.lastHost() });
    this.alert(d.title, d.message, d.cause === "setup" ? [{ label: "OK", primary: true }] : [{ label: "OK" }, retry]);
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
    const started = Date.now();
    ws.onopen = () => { this.opened = true; ws.send(JSON.stringify({ type: "auth", token: this.plugin.settings.pairingCode, version: this.plugin.manifest.version })); };
    ws.onmessage = (e) => { try { this.onServer(JSON.parse(e.data)); } catch (err) { console.error("vault-claude", err); } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.lastFail = this.unpaired ? "unpaired" : ws.vcOpened || this.opened ? "closed" : Date.now() - started < 1500 ? "refused" : "timeout";
      this.opened = false;
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
    this.state = state;
    this.statusDot.className = "vc-dot is-" + (state === "on" ? "on" : state === "connecting" ? "connecting" : "off");
    const local = this.plugin.hosting();
    this.statusText.setText({
      on: (local ? "Running on this computer" : `Connected to ${this.hostName || "your computer"}`) + (local || this.hostVersion === this.plugin.manifest.version ? "" : ` · host ${this.hostVersion || "older"}, this device ${this.plugin.manifest.version}`),
      off: "Not connected",
      connecting: "Connecting…",
      unpaired: "Not paired · add the pairing code in settings",
      setup: "Set up in Quartzi Copilot settings",
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
    // On Claude the money folder is open like the rest. On any other provider a money note is never offered.
    return this.plugin.settings.provider === "claude" ? files : files.filter((f) => !isPrivate(f.path));
  }

  includedNotes() {
    if (!this.plugin.settings.sendContext) return [];
    return this.openNotes().filter((f) => !this.excluded.has(f.path));
  }

  // "Ask Quartzi" on selected text: the chat holds on to that text and the note it came from until the
  // next message is sent, because once the chat box has focus the note is no longer the active view.
  askAbout(file, text) {
    const s = this.plugin.settings;
    if (s.provider !== "claude" && isPrivate(file.path)) { this.toast("That note stays out of chats on this provider."); return; }
    this.asked = { path: file.path, name: file.basename, text: String(text).slice(0, 8000) };
    this.updateContext();
    this.inputEl.focus();
    this.updateSendButton();
  }

  askedContext() {
    const a = this.asked;
    if (!a) return {};
    if (this.plugin.settings.provider !== "claude" && isPrivate(a.path)) return {};
    return { activeFile: a.path, selection: a.text };
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
    if (this.asked) {
      // The selected text goes with the next message, whatever else is open.
      const chip = this.contextEl.createEl("button", { cls: "vc-chip vc-chip-asked", attr: { "aria-label": "Selected text goes with your next message. Tap to leave it out." } });
      icon(chip, "doc", "vc-ico-sm");
      const words = this.asked.text.replace(/\s+/g, " ").trim();
      chip.createSpan({ cls: "vc-chip-name", text: `“${words.length > 40 ? words.slice(0, 40) + "…" : words}”` });
      chip.createSpan({ cls: "vc-chip-note", text: this.asked.name });
      icon(chip, "xmark", "vc-ico-sm vc-chip-chev");
      chip.onclick = (e) => { e.stopPropagation(); this.asked = null; this.updateContext(); };
      return;
    }
    const notes = this.openNotes();
    const open = new Set(notes.map((f) => f.path));
    for (const p of this.excluded) if (!open.has(p)) this.excluded.delete(p);
    if (!notes.length) return;
    const included = this.includedNotes();
    const on = included.length > 0;
    const many = notes.length > 1;
    const chip = this.contextEl.createEl("button", {
      cls: "vc-chip" + (on ? "" : " is-off"),
      attr: { "aria-label": many ? "Choose which open notes Copilot sees" : "Include or leave out the open note" },
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
    menu.createDiv({ cls: "vc-menu-section", text: "Open notes Copilot can see" });
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
    window.setTimeout(() => this.updateUsage(), 0);
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
    empty.createDiv("vc-empty-ico vc-empty-mark").innerHTML = `<svg viewBox="0 0 100 100">${QUARTZI_MARK}</svg>`;
    empty.createDiv({ cls: "vc-large-title", text: "Quartzi Copilot" });
    empty.createDiv({ cls: "vc-empty-sub", text: "Your models, working in this vault from your computer. It sees the notes you have open." });
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
    // Written by this device, so it works with any model and with the host unreachable.
    const log = /^\/log\s+([\s\S]+)/.exec(text);
    if (log && !attachments.length) {
      this.inputEl.value = "";
      this.autosize();
      this.updateSendButton();
      this.plugin.appendLog(log[1]).then(() => this.toast("Added to the build log"), (e) => this.addItem({ kind: "error", text: e.message }));
      return;
    }
    if (!this.running && (!this.isReady())) {
      this.connectionAlert();
      return;
    }
    // Text sent with "Ask Quartzi" goes along even when open notes are left out: it was asked for.
    const ctx = Object.assign(this.plugin.settings.sendContext ? this.currentContext() : {}, this.askedContext());
    if (this.asked) { this.asked = null; this.updateContext(); }
    const reply = this.replyTo || null;
    this.setReply(null);
    this.inputEl.value = "";
    this.autosize();
    this.pending = [];
    this.renderTray();
    if (this.running) this.enqueue(text, ctx, attachments, reply);
    else this.dispatch([{ text, ctx, attachments, reply }]);
    this.updateSendButton();
  }

  enqueue(text, ctx, attachments, reply) {
    if (!this.queueEl) this.queueEl = this.messagesEl.createDiv("vc-queue");
    const wrap = this.queueEl.createDiv("vc-user-wrap is-queued");
    this.renderAttachments(wrap, attachments);
    if (text) wrap.createDiv({ cls: "vc-bubble", text });
    wrap.createDiv({ cls: "vc-caption", text: "Queued · tap to cancel" });
    const entry = { text, ctx, attachments, reply, el: wrap };
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
    for (const { text, ctx, attachments, reply } of entries) {
      // History keeps names and small previews only; the full files go to the host once.
      const files = (attachments || []).map((a) => ({ name: a.name, mime: a.mime, thumb: a.thumb || null }));
      const item = { kind: "user", text, file: ctx.activeFile || null, files, at: Date.now() };
      if (reply) item.reply = reply;
      this.session.items.push(item);
      const el = this.renderItem(item);
      if (!fromQueue) this.flyIn(el);
    }
    const s = this.plugin.settings;
    this.ws.send(JSON.stringify({
      type: "send",
      text: entries.map((e) => (e.reply ? quoteFor(e.reply) : "") + (e.text || "")).filter(Boolean).join("\n\n") || "(See the attached files.)",
      sessionId: this.session.id,
      model: s.model, effort: s.effort, permissionMode: s.permissionMode,
      provider: s.provider, providerModel: s.providerModel,
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
  // Hosts before 0.9.0 send no version. Remembered per device, so a host that can't be reached can
  // still be named by version.
  onHostStatus(msg) {
    this.hostVersion = msg.version || "";
    this.hostWarnings = msg.warnings || [];
    this.plugin.lastHost({ version: this.hostVersion, at: Date.now(), notOnTailscale: this.hostWarnings.some((w) => /isn't on Tailscale/.test(w)) });
  }

  // Providers that can be used now. Hosts before 0.9.0 only send those, with no set field.
  readyProviders() {
    return (this.providers || []).filter((x) => x.set !== false);
  }

  onServer(msg) {
    if (msg.type === "hello") {
      this.vaultRoot = msg.vaultRoot || "";
      this.hostName = msg.host || "";
      this.onHostStatus(msg);
      this.ws.send(JSON.stringify({ type: "models" }));
      this.ready = true;
      this.unpaired = false;
      this.setStatus("on");
      if (!this.running) this.flushQueue();
      return;
    }
    if (msg.type === "status") { this.onHostStatus(msg); if (this.ready) this.setStatus("on"); return; }
    if (msg.type === "warning") { this.addItem({ kind: "note", text: msg.message }); return; }
    if (msg.type === "transcript") { this.onTranscript(msg); return; }
    if (msg.type === "notice") { this.session.id = null; this.addItem({ kind: "note", text: msg.message }); return; }
    if (msg.type === "models") {
      this.providers = msg.providers || [];
      const s = this.plugin.settings;
      if (s.provider !== "claude" && !this.readyProviders().some((x) => x.id === s.provider)) { s.provider = "claude"; this.plugin.saveSettings(); this.updateBrain(); }
      return;
    }
    if (msg.type === "error" && msg.code === "auth") { this.unpaired = true; this.setStatus("unpaired"); return; }
    if (msg.type === "error") { this.addItem({ kind: "error", text: msg.message }); return; }
    if (msg.type === "done") { this.finishTurn(msg.sessionId); return; }
    if (msg.type !== "event") return;
    const ev = msg.event;

    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) this.session.id = ev.session_id;
    if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      this.plugin.settings.limits = Object.assign({}, ev.rate_limit_info, { seen: Date.now() });
      this.updateUsage();
    }
    // Each top-level API call's usage is what the conversation now takes up.
    if (ev.type === "assistant" && !ev.parent_tool_use_id && ev.message && ev.message.usage) {
      const u = ev.message.usage;
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      if (used) this.session.context = Object.assign({}, this.session.context, { used, model: ev.message.model });
      this.updateUsage();
    }
    if (ev.type === "result" && ev.modelUsage) {
      const ctx = this.session.context || {};
      const m = (ctx.model && ev.modelUsage[ctx.model]) || Object.values(ev.modelUsage).sort((a, b) => (b.cacheReadInputTokens + b.inputTokens) - (a.cacheReadInputTokens + a.inputTokens))[0];
      if (m && m.contextWindow) this.session.context = Object.assign({}, ctx, { window: m.contextWindow });
      this.updateUsage();
    }

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
    const item = { kind: "assistant", text, at: Date.now() };
    this.session.items.push(item);
    let t = this.live;
    if (!t) {
      t = { el: this.messagesEl.createDiv("vc-msg vc-assistant is-new"), target: "", shown: 0, rendered: -1, lastRender: 0 };
    }
    t.el.vcItem = item;
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
    const item = { kind: "assistant", text: t.target, at: Date.now() };
    this.session.items.push(item);
    t.el.vcItem = item;
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
  // Tap to talk, tap again to stop; the text lands in the message box to check before sending.
  // Where the device has its own speech recognition (iPad, iPhone), words appear live as you
  // speak, the way Quartzi does it. Otherwise (desktop) the clip is recorded and the host
  // computer transcribes it with faster-whisper, which it warms up as soon as the mic opens.
  async toggleRecording() {
    if (this.speech) return this.stopSpeech();
    if (this.recorder) { this.recorder.stop(); return; }
    if (this.transcribing) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && !Platform.isDesktopApp && !this.speechBroken) return this.startSpeech(SR);
    return this.startRecorder();
  }

  startSpeech(SR) {
    let rec;
    try { rec = new SR(); } catch (e) { this.speechBroken = true; return this.startRecorder(); }
    const input = this.inputEl;
    const session = { rec, base: input.value, heard: false };
    this.speech = session;
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const end = () => {
      if (this.speech !== session) return;
      clearTimeout(session.stopTimer);
      this.speech = null;
      rec.onresult = rec.onerror = rec.onend = null;
      this.setMicState("idle");
    };
    rec.onresult = (event) => {
      if (this.speech !== session) return;
      // Results are cumulative: rebuild the whole utterance each time so revised words
      // never repeat.
      const parts = [];
      for (let i = 0; i < event.results.length; i++) {
        const t = event.results[i] && event.results[i][0] && event.results[i][0].transcript;
        if (t) parts.push(t.trim());
      }
      const spoken = parts.filter(Boolean).join(" ");
      const sep = session.base && spoken && !/\s$/.test(session.base) ? " " : "";
      input.value = session.base + sep + spoken;
      session.heard = session.heard || !!spoken;
      this.autosize();
      this.updateSendButton();
    };
    rec.onerror = (event) => {
      const code = event && event.error;
      end();
      // No speech service in this app: fall back to recording for the host to transcribe.
      if (code === "service-not-allowed" || code === "network" || code === "language-not-supported") {
        this.speechBroken = true;
        return this.startRecorder();
      }
      if (code === "not-allowed") return this.alert("Microphone Access", "Allow microphone and speech recognition for Obsidian in Settings, then try again.", [{ label: "OK", primary: true }]);
      if (code === "audio-capture") return this.alert("No Microphone", "No microphone is available.", [{ label: "OK", primary: true }]);
      if (code !== "no-speech" && code !== "aborted") this.toast("Dictation stopped");
    };
    rec.onend = () => { end(); if (session.heard) input.focus(); };
    try { rec.start(); } catch (e) { end(); this.speechBroken = true; return this.startRecorder(); }
    this.setMicState("recording");
  }

  stopSpeech() {
    const session = this.speech;
    if (!session) return;
    // stop() asks for the final words; don't leave the mic stuck if the end event never comes.
    session.stopTimer = window.setTimeout(() => {
      if (this.speech === session) { try { session.rec.abort(); } catch (e) { /* stopped */ } if (session.rec.onend) session.rec.onend(); }
    }, 2500);
    try { session.rec.stop(); } catch (e) { if (session.rec.onend) session.rec.onend(); }
  }

  async startRecorder() {
    if (!this.isReady()) {
      this.alert("Not Connected", "Dictation is transcribed on your computer, so it needs a connection.", [{ label: "OK", primary: true }]);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      this.alert("Microphone Unavailable", "This device doesn't allow recording here. Use the keyboard's dictation key instead.", [{ label: "OK", primary: true }]);
      return;
    }
    this.ws.send(JSON.stringify({ type: "warmup" })); // load the speech model while you talk
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = e && e.name;
      const msg = name === "NotFoundError" ? "No microphone was found. Connect one and try again."
        : name === "NotReadableError" ? "Another app is using the microphone. Close it and try again."
        : Platform.isWin ? "Windows blocked the microphone. Open Settings → Privacy & security → Microphone, turn on \"Let desktop apps access your microphone\", then try again."
        : Platform.isMacOS ? "Allow Obsidian in System Settings → Privacy & Security → Microphone, then try again."
        : "Allow microphone access for Obsidian, then try again.";
      this.alert("Microphone Access", msg, [{ label: "OK", primary: true }]);
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { rec = new MediaRecorder(stream); }
    const chunks = [];
    const started = Date.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(this.recordLimit);
      this.recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      if (!blob.size || Date.now() - started < 400) { this.setMicState("idle"); return; }
      this.setMicState("transcribing");
      const data = await readBase64(blob);
      if (!this.isReady()) {
        this.setMicState("idle");
        this.alert("Not Connected", "The recording couldn't be sent. Try again once connected.", [{ label: "OK", primary: true }]);
        return;
      }
      this.ws.send(JSON.stringify({ type: "transcribe", mime: blob.type, data }));
      // Never leave the mic stuck on "Transcribing" if the answer doesn't come.
      clearTimeout(this.transcribeTimer);
      this.transcribeTimer = window.setTimeout(() => {
        if (this.transcribing) { this.setMicState("idle"); this.toast("Dictation timed out"); }
      }, 90000);
    };
    rec.start(250);
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
    clearTimeout(this.transcribeTimer);
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

  // ---------- message menu ----------
  messageAt(target) {
    let el = target && target.closest ? target.closest(".vc-bubble, .vc-assistant, .vc-user-wrap") : null;
    while (el && !el.vcItem && el !== this.messagesEl) el = el.parentElement && el.parentElement.closest(".vc-bubble, .vc-assistant, .vc-user-wrap");
    return el && el.vcItem ? el : null;
  }

  // Like Quartzi: when it was sent, then Reply and Copy (Copy selection if text is selected).
  openMessageMenu(el, x, y) {
    this.closeMenu();
    const item = el.vcItem;
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString().trim() : "";
    const menu = this.root.createDiv("vc-menu vc-menu-msg vc-material");
    menu.onclick = (e) => e.stopPropagation();
    menu.createDiv({ cls: "vc-menu-time vc-caption vc-num", text: (item.kind === "user" ? "You · " : "Copilot · ") + (item.at ? whenText(item.at) : "Earlier") });
    const row = (name, label, run) => {
      const b = menu.createEl("button", { cls: "vc-menu-row" });
      b.createSpan({ cls: "vc-menu-label", text: label });
      icon(b, name, "vc-ico-sm vc-menu-ico");
      b.onclick = () => { this.closeMenu(); run(); };
    };
    row("reply", "Reply", () => this.setReply({ who: item.kind === "user" ? "you" : "claude", text: excerpt(selected || item.text || (item.files || []).map((f) => f.name).join(", ")) }));
    const copyText = selected || item.text || "";
    if (copyText) row("copy", selected ? "Copy Selection" : "Copy", async () => {
      this.toast((await this.copyText(copyText)) ? "Copied" : "Couldn't copy");
    });
    // A long press belongs to this menu, so picking out part of a message happens on a sheet of its own.
    if (item.text) row("doc", "Select Text", () => this.openSelectText(item));
    const box = this.root.getBoundingClientRect();
    menu.style.transformOrigin = "top left";
    const w = 220;
    menu.style.left = `${Math.max(8, Math.min(x - box.left, box.width - w - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y - box.top, box.height - 150))}px`;
    this.menuEl = menu;
  }

  // Copy that works on every device: the clipboard call first, and if the device refuses it, the older way.
  async copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* refused, try the older way */ }
    }
    const back = document.activeElement;
    const src = document.body.createEl("textarea", { cls: "vc-copy-src" });
    src.value = text;
    src.setAttribute("readonly", "");
    src.select();
    src.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    src.remove();
    if (back && back.focus) back.focus();
    return ok;
  }

  // The message as plain text on a sheet, where the device's own press-and-drag selection and Copy work.
  openSelectText(item) {
    const scrim = this.root.createDiv("vc-scrim vc-scrim-sheet");
    const sheet = scrim.createDiv("vc-sheet");
    const close = () => { sheet.addClass("is-out"); scrim.addClass("is-out"); window.setTimeout(() => scrim.remove(), 300); };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    const bar = sheet.createDiv("vc-sheet-bar vc-material");
    bar.createEl("button", { cls: "vc-plain", text: "Copy All" }).onclick = async () => { this.toast((await this.copyText(item.text)) ? "Copied" : "Couldn't copy"); };
    bar.createDiv({ cls: "vc-sheet-title", text: "Select Text" });
    bar.createEl("button", { cls: "vc-plain is-bold", text: "Done" }).onclick = close;
    sheet.createDiv({ cls: "vc-sheet-body vc-select-text", text: item.text });
  }

  setReply(reply) {
    this.replyTo = reply;
    this.replyEl.empty();
    this.replyEl.toggleClass("is-on", !!reply);
    if (!reply) return;
    icon(this.replyEl, "reply", "vc-ico-sm vc-reply-ico");
    const body = this.replyEl.createDiv("vc-reply-body");
    body.createDiv({ cls: "vc-reply-who", text: reply.who === "you" ? "Replying to yourself" : "Replying to Copilot" });
    body.createDiv({ cls: "vc-reply-text", text: reply.text });
    const x = this.iconButton(this.replyEl, "xmark", "Cancel reply", () => this.setReply(null));
    x.addClass("vc-reply-x");
    this.inputEl.focus();
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
      if (item.reply) {
        const q = wrap.createDiv("vc-reply-quote");
        q.createDiv({ cls: "vc-reply-who", text: item.reply.who === "you" ? "You" : "Copilot" });
        q.createDiv({ cls: "vc-reply-text", text: item.reply.text });
      }
      if (item.text) wrap.createDiv({ cls: "vc-bubble", text: item.text }).vcItem = item;
      else if (item.files && item.files.length) wrap.vcItem = item;
    } else if (item.kind === "assistant") {
      const el = this.messagesEl.createDiv("vc-msg vc-assistant");
      el.vcItem = item;
      this.renderMarkdown(el, item.text);
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
    } else if (item.kind === "note") {
      this.messagesEl.createDiv({ cls: "vc-note", text: item.text });
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
    if (item.result !== undefined) body.createEl("pre", { text: item.result || (item.trimmed ? "(output not kept in saved chats)" : "(no output)") });
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
    MarkdownRenderer.render(this.app, safeMarkdown(text), el, "", this);
    // A second guard: anything that still tries to load from outside the vault is removed before it can.
    el.querySelectorAll("img, iframe, video, audio, source, embed, object").forEach((m) => {
      const src = m.getAttribute("src") || m.getAttribute("data") || "";
      if (/^(https?:)?\/\//i.test(src.trim())) m.remove();
    });
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

function tokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function untilText(resetsAt) {
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.max(1, Math.round(ms / 60000))}m`;
}

// five_hour -> Session, seven_day -> Weekly, seven_day_opus -> Weekly (Opus)
function limitName(key) {
  if (key === "five_hour") return "Session";
  const m = /^seven_day(?:_(.+))?$/.exec(key);
  if (m) return m[1] ? `Weekly (${m[1].replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase())})` : "Weekly";
  return key.replace(/_/g, " ");
}

function excerpt(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 280 ? t.slice(0, 277) + "…" : t;
}

function quoteFor(reply) {
  return (reply.who === "you" ? "Replying to my earlier message:" : "Replying to this part of your reply:") + "\n> " + reply.text + "\n\n";
}

function whenText(at) {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + " " + time;
}

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

const SYSTEM_PROMPT = `You are running inside the user's Obsidian vault through the "Quartzi Copilot" sidebar,
possibly on their iPad or phone. The vault is your working directory. Cite notes as [[note title]];
those links are clickable in the sidebar. Edit notes with your Edit/Write tools. Keep replies
readable on a narrow sidebar.`;

const TRANSCRIBE_PY = `import json, sys
try:
    from faster_whisper import WhisperModel
except ImportError:
    print("faster-whisper is not installed", file=sys.stderr)
    sys.exit(3)
model = WhisperModel(sys.argv[1] if len(sys.argv) > 1 else "base.en", device="cpu", compute_type="int8")
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        segments, _ = model.transcribe(path, vad_filter=True, beam_size=1, without_timestamps=True, condition_on_previous_text=False, language="en")
        print(json.dumps({"text": " ".join(s.text.strip() for s in segments).strip()}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
`;

const PERMISSION_MODES = new Set(["auto", "acceptEdits", "plan", "default"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Providers Claude Code reaches through the local translator, except kind "anthropic", which it
// calls itself with an API key. "env" is the key's variable on the host. Keys live there or in the
// OS keychain, never in data.json, which syncs. Custom endpoints are added per host in settings.
const PROVIDERS = {
  claude: { name: "Claude" },
  anthropic: { name: "Anthropic API", base: "https://api.anthropic.com", env: "ANTHROPIC_API_KEY", kind: "anthropic" },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", env: "OPENAI_API_KEY" },
  gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", env: "GEMINI_API_KEY" },
  deepseek: { name: "DeepSeek", base: "https://api.deepseek.com/v1", env: "DEEPSEEK_API_KEY" },
  xai: { name: "xAI Grok", base: "https://api.x.ai/v1", env: "XAI_API_KEY" },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY" },
  groq: { name: "Groq", base: "https://api.groq.com/openai/v1", env: "GROQ_API_KEY" },
  mistral: { name: "Mistral", base: "https://api.mistral.ai/v1", env: "MISTRAL_API_KEY", noUsage: true },
  moonshot: { name: "Moonshot Kimi", base: "https://api.moonshot.ai/v1", env: "MOONSHOT_API_KEY" },
  zai: { name: "Z.ai GLM", base: "https://api.z.ai/api/paas/v4", env: "ZAI_API_KEY" },
  together: { name: "Together AI", base: "https://api.together.xyz/v1", env: "TOGETHER_API_KEY" },
  ollama: { name: "Ollama (local)", base: "http://127.0.0.1:11434/v1", local: true },
  lmstudio: { name: "LM Studio (local)", base: "http://127.0.0.1:1234/v1", local: true },
};
const MODEL_ID = /^\w[\w.\/:@~+-]*$/;

// Not chat models, so never offered in the picker.
const NOT_CHAT = /embed|tts|whisper|transcri|moderation|image|imagen|veo|lyria|banana|audio|realtime|live|robotics|aqa|dall-e|sora|rerank|computer-use|deep-research|antigravity/i;

// Why a custom endpoint can't be used, or "" if it can. Keys never go in the address, and a key
// variable has to look like one, so an endpoint can't be pointed at some other variable.
function endpointProblem(c) {
  if (!String(c.name || "").trim()) return "Give it a name.";
  let url;
  try { url = new URL(c.base); } catch (e) { return "Base URL isn't valid. Example: https://host/v1"; }
  if (!/^https?:$/.test(url.protocol)) return "Base URL must start with http:// or https://";
  if (url.username || url.password || url.search) return "Keep keys out of the base URL. Use a key variable.";
  if (c.keyEnv && !/^[A-Za-z_]\w*$/.test(c.keyEnv)) return "Key variable can only hold letters, numbers and _.";
  if (c.keyEnv && !/key|token|secret/i.test(c.keyEnv)) return "Key variable's name must contain KEY, TOKEN or SECRET.";
  return "";
}

function hideKey(text, key) {
  return key ? String(text).split(key).join("[key hidden]") : String(text);
}

function upstream(cfg, path, body, timeout) {
  const url = new URL(cfg.base + path);
  const lib = nodeRequire(url.protocol === "https:" ? "https" : "http");
  const headers = { "content-type": "application/json" };
  if (cfg.kind === "anthropic") { headers["x-api-key"] = cfg.key; headers["anthropic-version"] = "2023-06-01"; }
  else if (cfg.key) headers.authorization = "Bearer " + cfg.key;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: body ? "POST" : "GET", headers }, resolve);
    req.on("error", reject);
    req.setTimeout(timeout || (cfg.local ? 300000 : 120000), () => req.destroy(new Error("The provider took too long to answer.")));
    req.end(payload);
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    let s = "";
    res.setEncoding("utf8");
    res.on("data", (d) => { s += d; });
    res.on("end", () => resolve(s));
    res.on("error", reject);
  });
}

// What the provider offers right now. ok is false when it has no list to give, so the model is
// typed by hand. noTools holds models the list itself says can't call tools.
async function listModels(cfg) {
  try {
    const res = await upstream(cfg, cfg.kind === "anthropic" ? "/v1/models?limit=1000" : "/models", null, 8000);
    if (res.statusCode !== 200) { res.resume(); return { ok: false, ids: [], noTools: [] }; }
    const body = JSON.parse(await readAll(res));
    const list = (Array.isArray(body) ? body : body.data || body.models || []).filter((m) => (m.id || m.name) && !NOT_CHAT.test(m.id || m.name));
    return {
      ok: true,
      ids: list.map((m) => m.id || m.name).sort(),
      noTools: list.filter((m) => Array.isArray(m.supported_parameters) && !m.supported_parameters.includes("tools")).map((m) => m.id || m.name),
    };
  } catch (e) { return { ok: false, ids: [], noTools: [] }; }
}

// Some providers reject JSON Schema keywords that Claude Code's tools use.
function cleanSchema(v) {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v)) if (k !== "$schema" && k !== "propertyNames") out[k] = cleanSchema(v[k]);
  return out;
}

// Anthropic Messages request -> OpenAI chat completions request. memo keeps what a provider must
// see again on the next request (DeepSeek reasoning, Gemini thought signatures) by tool call id.
// bare leaves tools out, for a model that can't call them: no tool list, and past tool steps
// drop out of the history.
function toOpenAI(body, cfg, memo, bare) {
  const messages = [];
  const textOf = (c) => (typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
  const system = [textOf(body.system), bare ? NO_TOOLS_PROMPT : ""].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  for (const m of body.messages || []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    if (m.role === "assistant") {
      const out = { role: "assistant", content: blocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null };
      const calls = bare ? [] : blocks.filter((b) => b.type === "tool_use");
      if (bare && !out.content) continue;
      if (calls.length) {
        out.tool_calls = calls.map((b) => {
          const call = { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } };
          const seen = memo.get(b.id);
          if (seen && seen.extra) call.extra_content = seen.extra;
          if (seen && seen.reasoning) out.reasoning_content = seen.reasoning;
          return call;
        });
      }
      messages.push(out);
      continue;
    }
    for (const b of blocks) {
      if (b.type !== "tool_result" || bare) continue;
      const text = typeof b.content === "string" ? b.content : (b.content || []).map((c) => (c.type === "text" ? c.text : "[" + c.type + " omitted]")).join("\n");
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + text });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source && b.source.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (parts.length) messages.push({ role: "user", content: parts.every((x) => x.type === "text") ? parts.map((x) => x.text).join("\n") : parts });
  }
  const out = { model: body.model, messages, stream: !!body.stream };
  if (body.stream && !cfg.noUsage) out.stream_options = { include_usage: true };
  if (body.tools && body.tools.length && !bare) {
    out.tools = body.tools.filter((t) => t.input_schema).map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: cleanSchema(t.input_schema) } }));
    if (!out.tools.length) delete out.tools;
  }
  return out;
}

const STOP_REASONS = { tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal" };
const NO_TOOLS_PROMPT = "No tools are available in this chat: you can't read, search or change the vault. Never write tool calls. Answer from what the user tells you, and say so if you would need to see a note.";
// How providers word "this model can't call tools".
const TOOLS_REFUSED = /(tool|function)s?[ _-]?(call\w*|use|choice)?\b.{0,60}(not|un)[ -]?(supported|enabled|available)|(not|n't|unable to)\s.{0,30}support.{0,40}(tool|function)|enable-auto-tool-choice|no endpoints found.{0,40}tool/i;

async function providerError(cfg, up) {
  const text = await readAll(up).catch(() => "");
  let detail = text.slice(0, 500);
  try { let j = JSON.parse(text); if (Array.isArray(j)) j = j[0]; detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (e) { /* keep raw */ }
  return hideKey(detail, cfg.key);
}

// A status Claude Code acts on itself would hide the provider's words behind its own login advice
// or minutes of retries, so these go back as a plain failed request.
function providerFailure(cfg, status, detail) {
  if (status === 401 || status === 403) return [400, `${cfg.name} refused the key: ${detail}`];
  return [status === 429 ? 429 : 400, `${cfg.name}: ${detail}`];
}

// Runs one request against the provider and answers in Anthropic's format. tools.has(model) says a
// model is known not to call tools; tools.add(model) records one that turned out not to, and
// tools.warn(model) tells the chat its turn is running without them.
async function translateTurn(cfg, body, res, memo, fail, tools) {
  const hadTools = !!(body.tools && body.tools.length);
  let bare = hadTools && tools.has(body.model);
  const ask = () => upstream(cfg, "/chat/completions", toOpenAI(body, cfg, memo, bare));
  let up;
  try {
    up = await ask();
    if (up.statusCode !== 200) {
      const detail = await providerError(cfg, up);
      if (bare || !hadTools || up.statusCode >= 500 || !TOOLS_REFUSED.test(detail)) return fail(...providerFailure(cfg, up.statusCode, detail));
      tools.add(body.model);
      bare = true;
      up = await ask();
      if (up.statusCode !== 200) return fail(...providerFailure(cfg, up.statusCode, await providerError(cfg, up)));
    }
  } catch (e) { return fail(400, `Couldn't reach ${cfg.name}: ${hideKey(e.message, cfg.key)}`); }
  if (bare) tools.warn(body.model);
  const id = "msg_" + Date.now().toString(36);
  const remember = (call, reasoning) => {
    if (!call.extra && !reasoning) return;
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    memo.set(call.id, { extra: call.extra, reasoning });
  };

  if (!body.stream) {
    const j = JSON.parse(await readAll(up));
    const c = (j.choices || [])[0] || {};
    const m = c.message || {};
    const content = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const t of m.tool_calls || []) {
      remember({ id: t.id, extra: t.extra_content }, m.reasoning_content);
      let input = {};
      try { input = JSON.parse(t.function.arguments || "{}"); } catch (e) { /* empty */ }
      content.push({ type: "tool_use", id: t.id, name: t.function.name, input });
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content, stop_reason: STOP_REASONS[c.finish_reason] || "end_turn", stop_sequence: null,
      usage: { input_tokens: (j.usage && j.usage.prompt_tokens) || 0, output_tokens: (j.usage && j.usage.completion_tokens) || 0 } }));
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, data))}\n\n`);
  emit("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1, open = null, reasoning = "", stop = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const calls = new Map();
  const closeBlock = () => { if (open) emit("content_block_stop", { index }); open = null; };
  const onChunk = (j) => {
    if (j.usage) usage = { input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 };
    const c = (j.choices || [])[0];
    if (!c) return;
    const d = c.delta || {};
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (d.content) {
      if (open !== "text") { closeBlock(); index++; open = "text"; emit("content_block_start", { index, content_block: { type: "text", text: "" } }); }
      emit("content_block_delta", { index, delta: { type: "text_delta", text: d.content } });
    }
    for (const [pos, t] of (d.tool_calls || []).entries()) {
      const key = t.index !== undefined ? t.index : pos;
      let call = calls.get(key);
      if (!call) {
        closeBlock(); index++;
        call = { id: t.id || `call_${id}_${key}`, extra: t.extra_content, block: index };
        calls.set(key, call);
        open = "tool";
        emit("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: t.function.name, input: {} } });
      }
      if (t.extra_content) call.extra = t.extra_content;
      const args = t.function && t.function.arguments;
      if (args) emit("content_block_delta", { index: call.block, delta: { type: "input_json_delta", partial_json: args } });
    }
    if (c.finish_reason) stop = STOP_REASONS[c.finish_reason] || "end_turn";
  };
  let buf = "";
  up.setEncoding("utf8");
  up.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try { onChunk(JSON.parse(data)); } catch (e) { /* skip a bad chunk */ }
    }
  });
  const finish = () => {
    closeBlock();
    for (const call of calls.values()) remember(call, reasoning);
    emit("message_delta", { delta: { stop_reason: calls.size ? "tool_use" : stop, stop_sequence: null }, usage });
    emit("message_stop", {});
    res.end();
  };
  up.on("end", finish);
  up.on("error", finish);
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LOGIN_NEEDED = /not logged in|please run \/login|invalid api key|oauth token (has )?(expired|revoked)/i;

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
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
       // Installed with npm: the real program sits inside the package, behind a .cmd launcher.
       path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude", path.join(home, ".claude", "local", "claude")];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  // Last resort: whatever PATH (or the login shell) resolves.
  try {
    const cp = nodeRequire("child_process");
    const out = win
      ? cp.execFileSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true })
      : cp.execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude"], { encoding: "utf8", timeout: 4000 });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (win) {
      // An npm launcher (claude, claude.cmd) can't be started directly. Use the program it points at.
      for (const l of lines) {
        const real = path.join(path.dirname(l), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (fs.existsSync(real)) return real;
      }
      const exe = lines.find((l) => /\.exe$/i.test(l) && fs.existsSync(l));
      if (exe) return exe;
      return null;
    }
    const hit = lines.find((l) => fs.existsSync(l));
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

// The host's working folder in the system temp folder. On a shared computer another user could make
// it first, or leave a link there, and swap the speech script before it runs. So it must be a plain
// folder that belongs to this user, and only this user may open it.
function privateDir(p) {
  const fs = nodeRequire("fs");
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${p} is not a plain folder. Remove it and restart Obsidian.`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${p} belongs to another user. Remove it and restart Obsidian.`);
    fs.chmodSync(p, 0o700);
  }
  return p;
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
    this.partsLen = 0;
    // Before pairing a device may send only small messages, so an unpaired peer can't fill memory.
    // Paired, a message may carry attachments (up to 20 MB each, sent as text).
    this.maxMessage = 64 * 1024;
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on("data", (d) => this.feed(d));
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }

  feed(chunk) {
    // Whole frames are handled as soon as they arrive, so at most one part-frame waits here, and its
    // size was checked against maxMessage as soon as its header came in.
    if (!this.open) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > this.maxMessage || this.partsLen + len > this.maxMessage) { this.buf = Buffer.alloc(0); this.close(); return; }
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
      this.partsLen += payload.length;
      if (b0 & 0x80) {
        const text = Buffer.concat(this.parts).toString("utf8");
        this.parts = [];
        this.partsLen = 0;
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
    const path = nodeRequire("path");
    const os = nodeRequire("os");
    const fs = nodeRequire("fs");
    this.claude = findClaude(this.config.claudePath);
    if (!this.claude) throw new Error("Claude Code wasn't found on this computer. Install it from claude.com/claude-code, or set its path in settings.");
    this.tmp = privateDir(path.join(os.tmpdir(), "vault-claude"));
    privateDir(this.attachRoot(false));
    privateDir(this.attachRoot(true));
    this.sweepAttachments();

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
    for (const h of hosts) await this.listenOn(h);
    // Tailscale often comes up after the host does (a restart, waking from sleep).
    if (this.config.bind === "tailscale") {
      this.tailscaleTimer = setInterval(() => this.joinTailscale(), 30000);
      if (this.tailscaleTimer.unref) this.tailscaleTimer.unref();
    }
    this.chats = new Set();
    await this.startTranslator();
    this.checkLogin();
    if (!this.config.transcribeCommand) setTimeout(() => this.whisper(), 2000);
    setTimeout(() => this.ensureSpare(this.signature({})), 1000);
    this.log(`Hosting on ${this.addresses.map((h) => h + ":" + this.config.port).join(", ")} with ${this.claude}`);
  }

  async listenOn(address) {
    const server = nodeRequire("http").createServer((req, res) => {
      // Lets a device tell "Copilot is up but the chat socket failed" from "nothing is listening".
      if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ app: "quartzi-copilot", version: this.config.version || "" }));
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Quartzi Copilot host. Connect from the Obsidian plugin.\n");
    });
    server.on("upgrade", (req, socket) => this.upgrade(req, socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, address, resolve);
    });
    server.on("error", (e) => this.log("Server error: " + e.message));
    this.servers.push(server);
    this.addresses.push(address);
  }

  async joinTailscale() {
    const ts = tailscaleIp();
    if (this.stopped || !ts || this.addresses.includes(ts)) return;
    try {
      await this.listenOn(ts);
      this.log("Tailscale is up; now also listening on " + ts);
      this.broadcastStatus();
    } catch (e) { this.log("Couldn't listen on Tailscale: " + e.message); }
  }

  // Asks Claude Code whether it's signed in. Stays null if this version can't say.
  checkLogin() {
    nodeRequire("child_process").execFile(this.claude, ["auth", "status", "--json"], { env: this.childEnv(), timeout: 15000, windowsHide: true }, (err, stdout) => {
      let was = this.loggedIn, now = null;
      try { now = JSON.parse(stdout).loggedIn === true; } catch (e) { /* older Claude Code */ }
      this.loggedIn = now;
      if (now !== was) this.broadcastStatus();
    });
  }

  // What stops this host working for other devices, in plain words.
  warnings() {
    const out = [];
    const name = nodeRequire("os").hostname();
    if (this.loggedIn === false) out.push(`Claude Code isn't logged in on ${name}. Open a terminal there, run claude, then /login.`);
    if (this.config.bind === "local") out.push(`Who can connect is set to This computer only, so your phone and iPad can't reach ${name}.`);
    else if (this.config.bind === "tailscale" && !this.addresses.some((a) => a.startsWith("100."))) out.push(`${name} isn't on Tailscale right now, so your phone and iPad can't reach it. Open Tailscale there and connect.`);
    return out;
  }

  statusMessage() {
    return { version: this.config.version || "", loggedIn: this.loggedIn === undefined ? null : this.loggedIn, warnings: this.warnings() };
  }

  broadcastStatus() {
    for (const c of this.conns || []) if (c.authed) c.send(Object.assign({ type: "status" }, this.statusMessage()));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tailscaleTimer);
    if (this.translator) { this.translator.close(); this.translator = null; }
    for (const c of this.chats || []) this.kill(c);
    if (this.spare) this.kill(this.spare);
    this.spare = null;
    if (this.worker) { try { this.worker.proc.kill(); } catch (e) { /* gone */ } this.worker = null; }
    for (const s of this.servers) { try { s.close(); } catch (e) { /* closed */ } }
    for (const c of this.conns || []) c.close();
    this.servers = [];
    this.addresses = [];
  }

  // A new pairing code takes effect at once: every device paired with the old one is let go,
  // and has to connect again with the new code.
  setToken(code) {
    this.config.token = code;
    for (const c of this.conns || []) if (c.authed) c.close();
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
    ws.current = null; // the chat process running this device's turn
    // Unpaired connections get a few seconds to authenticate, then they are dropped.
    const authTimer = setTimeout(() => { if (!authed) ws.close(); }, 5000);

    ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (!authed) {
        if (msg.type === "auth" && String(this.config.token || "").length >= MIN_CODE_LENGTH && sameToken(msg.token, this.config.token)) {
          authed = true;
          ws.authed = true;
          ws.maxMessage = 128 * 1048576;
          clearTimeout(authTimer);
          ws.send(Object.assign({ type: "hello", vault: nodeRequire("path").basename(this.config.vaultPath), vaultRoot: this.config.vaultPath, host: nodeRequire("os").hostname() }, this.statusMessage()));
          this.log(`Paired device connected: ${peer}${msg.version ? " (plugin " + msg.version + ")" : ""}`);
          this.checkLogin();
        } else {
          ws.send({ type: "error", code: "auth", message: "This device isn't paired. Paste the pairing code from the host computer in Quartzi Copilot settings." });
          ws.close();
        }
        return;
      }
      if (msg.type === "send") {
        if (ws.current && ws.current.turn) { ws.send({ type: "error", message: "Copilot is still working on the last message." }); return; }
        this.runTurn(ws, msg);
      } else if (msg.type === "models") {
        this.listProviders().then((providers) => ws.send({ type: "models", providers }));
      } else if (msg.type === "interrupt") {
        if (ws.current && ws.current.turn) { ws.current.interrupted = true; this.kill(ws.current); }
      } else if (msg.type === "warmup") {
        if (!this.config.transcribeCommand) this.whisper();
      } else if (msg.type === "transcribe") {
        this.transcribe(ws, msg);
      } else if (msg.type === "ping") {
        ws.send({ type: "pong" });
      }
    };
    // A running turn keeps going if the device drops, so its edits still land.
    ws.onclose = () => { clearTimeout(authTimer); this.conns.delete(ws); };
  }

  // A link can lead into the private folder, so where the note really is decides.
  noteExists(file) {
    return nodeRequire("fs").existsSync(nodeRequire("path").resolve(this.config.vaultPath, file));
  }

  privateNote(file) {
    if (isPrivate(file)) return true;
    if (!file) return false;
    const path = nodeRequire("path");
    const fs = nodeRequire("fs");
    try {
      const root = fs.realpathSync(this.config.vaultPath);
      return isPrivate(path.relative(root, fs.realpathSync(path.resolve(root, file))));
    } catch (e) {
      return false;
    }
  }

  buildPrompt(msg, saved) {
    const ctx = msg.context || {};
    const lines = [];
    // Money notes are held back only from a chat that leaves this computer for another provider.
    // Checked here too, because a device on an older version still sends these.
    const outside = this.offComputer(this.providerDef(msg.provider) ? msg.provider : "claude");
    const hidden = outside && this.privateNote(ctx.activeFile);
    const others = (ctx.openFiles || []).filter((p) => !(outside && this.privateNote(p)));
    if (ctx.activeFile && !hidden) lines.push(`The note the user is looking at: ${ctx.activeFile}`);
    if (others.length) lines.push("Other notes they have open in tabs or windows and chose to share (read or edit them as the request needs): " + others.slice(0, 20).join(", "));
    if (ctx.selection && ctx.activeFile && !hidden && this.noteExists(ctx.activeFile)) lines.push("They have this text selected in it:\n<selection>\n" + String(ctx.selection).slice(0, 8000) + "\n</selection>");
    let prompt = String(msg.text || "");
    if (lines.length) prompt = "<obsidian-context>\n" + lines.join("\n") + "\n</obsidian-context>\n\n" + prompt;
    if (saved.length) {
      prompt = "<attachments>\nThe user attached these files. Read them with your Read tool (it handles images and PDFs):\n" +
        saved.map((s) => `- ${s.path} (${s.mime})`).join("\n") + "\n</attachments>\n\n" + prompt;
    }
    return prompt;
  }

  attachRoot(outside) {
    const path = nodeRequire("path");
    return outside ? this.tmp + "-outside" : path.join(this.tmp, "attachments");
  }

  // A crash leaves folders behind. Another vault's host can share these, so only old ones go.
  sweepAttachments() {
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    for (const root of [this.attachRoot(false), this.attachRoot(true)]) {
      let names = [];
      try { names = fs.readdirSync(root); } catch (e) { continue; }
      for (const name of names) {
        const p = path.join(root, name);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* in use */ }
      }
    }
  }

  saveAttachments(items, chatDir) {
    if (!items || !items.length) return [];
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const crypto = nodeRequire("crypto");
    const dir = path.join(chatDir, crypto.randomBytes(6).toString("hex"));
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

  // ---------- other providers ----------
  providerDef(id) {
    if (PROVIDERS[id]) return PROVIDERS[id];
    const c = this.customs().find((x) => x.id === id);
    return c ? { name: c.name, base: c.base, env: c.keyEnv, models: c.models || [], custom: true, noUsage: true } : null;
  }

  customs() {
    return ((this.config.getCustom && this.config.getCustom()) || []).filter((c) => /^[\w-]+$/.test(c.id) && !endpointProblem(c));
  }

  providerIds() {
    return Object.keys(PROVIDERS).concat(this.customs().map((c) => c.id));
  }

  // The keychain copy first, then the host's environment. Nothing here leaves this process except
  // in the request to that provider.
  keyFor(id) {
    const p = this.providerDef(id);
    return (this.config.getKey && this.config.getKey(id)) || (p && p.env && process.env[p.env]) || "";
  }

  keySource(id) {
    const p = this.providerDef(id);
    const saved = this.config.keySource && this.config.keySource(id);
    return saved || (p && p.env && process.env[p.env] ? "environment" : "");
  }

  providerConfig(id) {
    const p = this.providerDef(id);
    if (!p || id === "claude") return null;
    const key = this.keyFor(id);
    if (!p.base || (!key && !p.local && !(p.custom && !p.env))) return null;
    return { id, name: p.name, base: p.base.replace(/\/+$/, ""), key, noUsage: p.noUsage, local: p.local, kind: p.kind };
  }

  // Every provider with whether it's set up (never its key) and, when it is, the models it says it
  // has right now. hand means it gave no list, so the model is typed by hand.
  async listProviders() {
    const rows = await Promise.all(this.providerIds().filter((id) => id !== "claude").map(async (id) => {
      const p = this.providerDef(id);
      const cfg = this.providerConfig(id);
      const row = { id, name: p.name, kind: p.kind || "openai", local: !!p.local, env: p.env || "", set: !!cfg, source: cfg ? this.keySource(id) : "", models: [], noTools: [], hand: false };
      if (!cfg) return row;
      const live = await listModels(cfg);
      if (p.local && !live.ok) row.set = false; // not running right now
      row.models = [...new Set([...(p.models || []), ...live.ids])];
      row.noTools = live.noTools;
      row.hand = !row.models.length;
      for (const m of live.noTools) this.toolless.add(id + "|" + m);
      return row;
    }));
    return rows;
  }

  // Provider keys stay out of Claude Code's environment, so a tool step can't print them. The one
  // exception is ANTHROPIC_API_KEY: Claude Code itself reads that one.
  // An outside chat sees none of the user's Claude Code setup: no memory, hooks, extra folders or
  // old transcripts. Its own config also means a chat from elsewhere can't be resumed into it.
  outsideConfig() {
    const dir = nodeRequire("path").join(nodeRequire("os").homedir(), ".quartzi-copilot", "outside-claude");
    nodeRequire("fs").mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  childEnv() {
    const env = Object.assign({}, process.env);
    for (const id of this.providerIds()) {
      const v = this.providerDef(id).env;
      if (v && v !== "ANTHROPIC_API_KEY") delete env[v];
    }
    return env;
  }

  providerEnv(provider, model) {
    const cfg = this.providerConfig(provider);
    const env = this.childEnv();
    // Inside a Claude desktop session this makes Claude Code send its login wherever the chat goes.
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (cfg.kind === "anthropic") {
      delete env.ANTHROPIC_AUTH_TOKEN;
      return Object.assign(env, { ANTHROPIC_API_KEY: cfg.key, ANTHROPIC_BASE_URL: cfg.base });
    }
    if (this.offComputer(provider)) {
      // Git Bash stays: Claude Code won't start on Windows without it, even with the shell off.
      for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/.test(k) && k !== "CLAUDE_CODE_GIT_BASH_PATH") delete env[k];
      env.CLAUDE_CONFIG_DIR = this.outsideConfig();
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    }
    return Object.assign(env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.translatorPort}/p/${provider}`,
      ANTHROPIC_AUTH_TOKEN: this.translatorToken,
      // Its own header, so the token still arrives if a login takes the authorization header.
      ANTHROPIC_CUSTOM_HEADERS: `x-copilot-token: ${this.translatorToken}`,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  }

  // Tells a chat once that this model is running without tools.
  warnToolless(provider, model) {
    for (const c of this.chats) {
      const [, m, , p] = c.sig.split("|");
      if (m !== model || p !== provider || !c.turn || c.warnedToolless) continue;
      c.warnedToolless = true;
      c.turn.ws.send({ type: "warning", message: `${model} can't use tools, so this chat is text only: it can't read, search or edit your notes. Pick another model to work on the vault.` });
    }
  }

  async startTranslator() {
    this.translatorToken = nodeRequire("crypto").randomBytes(24).toString("hex");
    this.toolless = new Set(); // provider|model pairs that can't call tools
    const memo = new Map();
    this.translator = nodeRequire("http").createServer((req, res) => {
      const m = /^\/p\/([\w-]+)\/v1\/messages(\/count_tokens)?/.exec(req.url);
      const auth = req.headers["x-copilot-token"] || String(req.headers.authorization || "").replace(/^Bearer /, "") || req.headers["x-api-key"];
      const fail = (code, message) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } })); };
      if (!m || auth !== this.translatorToken) return fail(404, "Not found");
      const cfg = this.providerConfig(m[1]);
      if (!cfg) return fail(400, "That provider isn't set up.");
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let body;
        try { body = JSON.parse(raw); } catch (e) { return fail(400, "Bad JSON"); }
        if (m[2]) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) })); }
        translateTurn(cfg, body, res, memo, fail, {
          has: (model) => this.toolless.has(m[1] + "|" + model),
          add: (model) => this.toolless.add(m[1] + "|" + model),
          warn: (model) => this.warnToolless(m[1], model),
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.translator.once("error", reject);
      this.translator.listen(0, "127.0.0.1", resolve);
    });
    this.translatorPort = this.translator.address().port;
  }

  // ---------- Claude processes ----------
  // Starting Claude Code (hooks, MCP servers) takes 10-20 s. So each chat keeps one process
  // running between messages (stream-json input), and one spare is kept warm for the next
  // new chat. Changing mode, model or effort starts a new process that resumes the same chat.
  signature(msg) {
    const provider = this.providerDef(msg.provider) ? msg.provider : "claude";
    const mode = this.allowedMode(msg.permissionMode, provider) ? msg.permissionMode : "acceptEdits";
    const effort = EFFORT_LEVELS.has(msg.effort) ? msg.effort : DEFAULT_SETTINGS.effort;
    if (provider !== "claude") return [mode, MODEL_ID.test(msg.providerModel || "") ? msg.providerModel : "", effort, provider].join("|");
    const model = msg.model && /^[\w.-]+$/.test(msg.model) ? msg.model : DEFAULT_SETTINGS.model;
    return [mode, model, effort].join("|");
  }

  allowedMode(mode, provider) {
    if (!PERMISSION_MODES.has(mode)) return false;
    return !this.offComputer(provider) || OUTSIDE_MODES.some(([v]) => v === mode);
  }

  // Every provider but the local ones sends the chat to a third party. A custom endpoint counts
  // as outside even at a localhost address, since it can forward anywhere.
  offComputer(provider) {
    const p = provider && provider !== "claude" && this.providerDef(provider);
    return !!p && p.kind !== "anthropic" && !p.local;
  }

  systemPrompt(noShell) {
    const log = this.config.logPath;
    // noShell is true exactly for a chat that leaves this computer for another provider: only that one is told to stay out of the money folder.
    const base = [SYSTEM_PROMPT, noShell ? PRIVATE_PROMPT : "", noShell ? NO_SHELL_PROMPT : ""].filter(Boolean).join("\n");
    return log ? `${base}\nWhen the user asks you to log a build or a publish, add one plain bullet (never a checkbox) with the date to the note ${log}.` : base;
  }

  spawnClaude(sig, resume) {
    const cp = nodeRequire("child_process");
    const path = nodeRequire("path");
    const fs = nodeRequire("fs");
    const [mode, model, effort, provider] = sig.split("|");
    const outside = this.offComputer(provider);
    // Each chat reads only its own attachments, and they go when it ends. Outside chats keep theirs
    // apart from the rest, so the others can be denied whatever the permission mode.
    const attachDir = path.join(this.attachRoot(outside), nodeRequire("crypto").randomBytes(6).toString("hex"));
    fs.mkdirSync(attachDir, { recursive: true, mode: 0o700 });
    // Git instructions would put file names and commit messages from the vault's repo in the first request.
    const settings = outside
      ? { permissions: { deny: PRIVATE_DENY.concat(outsideDeny(this.config.configDir, this.tmp, this.outsideConfig())) }, disableAllHooks: true, includeGitInstructions: false }
      // On Claude or a local model the whole vault is open, the money folder included, except Obsidian's own
      // settings and plugins: a note with hidden instructions must not get a chat to rewrite plugin code,
      // which would run the next time Obsidian starts.
      : { permissions: { deny: configDeny(this.config.configDir) } };
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--append-system-prompt", this.systemPrompt(outside), "--add-dir", attachDir,
      "--permission-mode", mode, "--model", model, "--settings", JSON.stringify(settings)];
    if (outside) args.push("--setting-sources", "user");
    // Other providers run through the local translator with Claude Code's built-in tools.
    // MCP servers stay off there: their hundreds of tools exceed what those APIs accept.
    const translated = provider && this.providerDef(provider).kind !== "anthropic";
    if (translated) args.push("--strict-mcp-config");
    else args.push("--effort", effort);
    if (resume) args.push("--resume", resume);
    const proc = cp.spawn(this.claude, args, { cwd: this.config.vaultPath, env: provider ? this.providerEnv(provider, model) : this.childEnv(), windowsHide: true });
    const c = { proc, sig, attachDir, resumed: resume, sessionId: resume, turn: null, buf: "", stderr: "", dead: false, idleTimer: null };
    this.chats.add(c);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      c.buf += chunk;
      let nl;
      while ((nl = c.buf.indexOf("\n")) >= 0) {
        const line = c.buf.slice(0, nl).trim();
        c.buf = c.buf.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch (e) { continue; }
        if (event.session_id) c.sessionId = event.session_id;
        if (!c.turn) continue;
        // A resumed chat that doesn't exist here answers with an empty error result.
        if (c.resumed && !c.turn.events && event.type === "result" && event.is_error && !event.num_turns) {
          c.resumeFailed = true;
          this.kill(c);
          continue;
        }
        if (event.type !== "system") c.turn.events++;
        if (event.type === "result" && event.is_error && event.result) event.result = this.plainError(c, event.result);
        c.turn.ws.send({ type: "event", event });
        if (event.type === "result") this.finishTurn(c, event.is_error ? 1 : 0);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => { c.stderr = (c.stderr + d).slice(-4000); });
    proc.stdin.on("error", () => { /* the close handler reports it */ });
    const ended = (code, startError) => {
      if (c.dead) return;
      c.dead = true;
      this.clearAttachments(c);
      clearTimeout(c.idleTimer);
      this.chats.delete(c);
      if (this.spare === c) this.spare = null;
      const t = c.turn;
      c.turn = null;
      if (!t) return;
      // A chat from another computer or an older setup can't be resumed here: rerun the
      // message as a new conversation instead of failing.
      if (c.resumed && !t.events && (c.resumeFailed || /No conversation found/i.test(c.stderr))) {
        const [, , , pid] = sig.split("|");
        t.ws.send({ type: "notice", message: this.offComputer(pid) ? `Started a new conversation. The earlier messages in this chat weren't sent to ${this.providerDef(pid).name}.` : "Started a new conversation. The earlier one can't continue here." });
        this.runTurn(t.ws, Object.assign({}, t.msg, { sessionId: null }));
        return;
      }
      const err = startError || c.stderr.replace(/\S+ hook \[[\s\S]*?\] failed: Hook cancelled\s*/g, "").trim();
      if (!c.interrupted && err) t.ws.send({ type: "error", message: this.plainError(c, err).slice(-2000) });
      t.ws.send({ type: "done", sessionId: c.sessionId, code: c.interrupted ? 0 : (code || 1) });
    };
    proc.on("error", (e) => ended(-1, "Couldn't start Claude Code: " + e.message));
    proc.on("close", (code) => ended(code));
    return c;
  }

  // Claude Code's own wording for "sign in" means nothing on a phone, and a provider's error can
  // quote the key it refused.
  plainError(c, text) {
    const pid = c.sig.split("|")[3];
    if (!pid && LOGIN_NEEDED.test(text)) {
      this.loggedIn = false;
      return `Claude Code isn't logged in on ${nodeRequire("os").hostname()}. Open a terminal there, run claude, then /login.`;
    }
    return pid ? hideKey(text, this.keyFor(pid)) : String(text);
  }

  finishTurn(c, code) {
    const t = c.turn;
    c.turn = null;
    t.ws.send({ type: "done", sessionId: c.sessionId, code });
    // Close processes that sit idle, and keep at most a few chats warm.
    clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => this.kill(c), 15 * 60 * 1000);
    const idle = [...this.chats].filter((x) => x !== this.spare && !x.turn && !x.dead);
    while (idle.length > 3) this.kill(idle.shift());
  }

  kill(c) {
    if (!c || c.dead) return;
    try { c.proc.stdin.end(); } catch (e) { /* closed */ }
    try { c.proc.kill(); } catch (e) { /* gone */ }
    // Obsidian can quit before the process closes.
    this.clearAttachments(c);
  }

  clearAttachments(c) {
    try { nodeRequire("fs").rmSync(c.attachDir, { recursive: true, force: true }); } catch (e) { /* still open: goes when the chat closes */ }
  }

  ensureSpare(sig) {
    if (this.stopped) return;
    // The key can go between the turn and this timer.
    const provider = sig.split("|")[3];
    if (provider && !this.providerConfig(provider)) return;
    if (this.spare && !this.spare.dead && this.spare.sig === sig) return;
    if (this.spare) this.kill(this.spare);
    this.spare = this.spawnClaude(sig, null);
  }

  // Returns the chat process now running this turn.
  runTurn(ws, msg) {
    const sig = this.signature(msg);
    const [, sigModel, , pid] = sig.split("|");
    const refuse = (message) => { ws.send({ type: "error", message }); ws.send({ type: "done" }); return null; };
    if (pid && !this.providerConfig(pid)) return refuse(`${this.providerDef(pid).name} isn't set up. Add its key in Quartzi Copilot settings on your computer.`);
    if (pid && !sigModel) return refuse(`Choose a model for ${this.providerDef(pid).name} in the brain menu.`);
    const sid = msg.sessionId && /^[\w-]+$/.test(msg.sessionId) ? msg.sessionId : null;
    let c = null;
    if (sid) {
      for (const x of this.chats) if (!x.dead && x !== this.spare && x.sessionId === sid) c = x;
      if (c && c.sig !== sig) { this.kill(c); c = null; }
    } else if (this.spare && !this.spare.dead && this.spare.sig === sig) {
      c = this.spare;
      this.spare = null;
    }
    if (!c) c = this.spawnClaude(sig, sid);
    clearTimeout(c.idleTimer);
    c.interrupted = false;
    c.turn = { ws, msg, events: 0 };
    ws.current = c;
    // An older device can still ask for a mode the menu no longer offers.
    const refused = PERMISSION_MODES.has(msg.permissionMode) && !this.allowedMode(msg.permissionMode, pid);
    if (refused && !ws.toldMode) ws.send({ type: "warning", message: `Plan and Auto are off for ${this.providerDef(pid).name}, because they can read files anywhere on your computer. This chat runs in Edit.` });
    ws.toldMode = refused;
    if (this.offComputer(pid) && !c.warnedShell) {
      c.warnedShell = true;
      ws.send({ type: "warning", message: `Shell commands are off for ${this.providerDef(pid).name}, because this chat leaves your computer. It can still read and edit your notes.` });
    }
    c.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: this.buildPrompt(msg, this.saveAttachments(msg.attachments, c.attachDir)) } }) + "\n");
    // Have the next new chat's process ready by the time it's wanted.
    setTimeout(() => this.ensureSpare(sig), 4000);
    return c;
  }

  // One Python process keeps the speech model loaded, so each recording takes about a second
  // instead of reloading the model every time. The sidebar sends "warmup" when the mic opens.
  whisper() {
    if (this.worker && !this.worker.dead) return this.worker;
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const cp = nodeRequire("child_process");
    if (this.python === undefined) this.python = findPython();
    if (!this.python) return null;
    if (this.stopped || !this.tmp) return null; // the host was stopped while this waited to start
    const script = path.join(this.tmp, "transcribe.py");
    fs.writeFileSync(script, TRANSCRIBE_PY, { mode: 0o600 });
    const proc = cp.spawn(this.python[0], [...this.python[1], script, "base.en"], {
      windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }),
    });
    const w = { proc, queue: [], buf: "", err: "", dead: false };
    const fail = (message) => { w.dead = true; w.queue.splice(0).forEach((cb) => cb({ error: message })); };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      w.buf += d;
      let nl;
      while ((nl = w.buf.indexOf("\n")) >= 0) {
        const line = w.buf.slice(0, nl).trim();
        w.buf = w.buf.slice(nl + 1);
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (obj.ready) continue;
        const cb = w.queue.shift();
        if (cb) cb(obj);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => { w.err = (w.err + d).slice(-2000); });
    proc.on("error", (e) => fail("Couldn't run speech-to-text: " + e.message));
    proc.on("close", (code) => {
      if (code === 3) {
        const py = [this.python[0], ...this.python[1]].join(" ");
        return fail(`Speech-to-text isn't installed on the host computer yet. Run this there:\n${py} -m pip install faster-whisper`);
      }
      fail("Speech-to-text stopped. " + (w.err.trim().split("\n").pop() || ""));
    });
    this.worker = w;
    return w;
  }

  transcribe(ws, msg) {
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const cp = nodeRequire("child_process");
    const crypto = nodeRequire("crypto");
    const ext = { "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav" }[String(msg.mime || "").split(";")[0]] || ".webm";
    const file = path.join(this.tmp, "dictation-" + crypto.randomBytes(4).toString("hex") + ext);
    fs.writeFileSync(file, Buffer.from(String(msg.data || ""), "base64"));
    const done = (payload) => {
      try { fs.unlinkSync(file); } catch (e) { /* gone */ }
      if (payload.error) payload.error = String(payload.error).startsWith("Speech") || String(payload.error).startsWith("Couldn")
        ? payload.error : "Couldn't transcribe that recording. " + payload.error;
      ws.send({ type: "transcript", text: payload.text, error: payload.error });
    };
    if (this.config.transcribeCommand) {
      const cmd = this.config.transcribeCommand;
      const child = cp.spawn(cmd.includes("{file}") ? cmd.split("{file}").join(`"${file}"`) : `${cmd} "${file}"`, { shell: true, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
      child.on("error", (e) => done({ error: "Couldn't run speech-to-text: " + e.message }));
      child.on("close", (code) => done(code === 0 ? { text: out.trim() } : { error: err.trim().split("\n").pop() || "exit " + code }));
      return;
    }
    const w = this.whisper();
    if (!w) return done({ error: "Speech-to-text needs Python 3 with faster-whisper on the host computer." });
    w.queue.push(done);
    w.proc.stdin.write(file + "\n");
  }
}

const BUILD = "11-12 c";
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
        .setDesc([status, ...(plugin.hosting() ? plugin.host.warnings() : [])].join(" "))
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
          .setDesc("Type this, and the address below, into Quartzi Copilot settings on each of your other devices, once. It stays on each device and never syncs. New code lets every paired device go until it has the new one.");
        code.controlEl.createEl("code", { cls: "vc-code", text: s.pairingCode || "—" });
        code.addButton((b) => b.setButtonText("Copy").onClick(() => { navigator.clipboard.writeText(s.pairingCode); new Notice("Pairing code copied"); }));
        code.addButton((b) => b.setButtonText("New code").setWarning().onClick(async () => {
          await plugin.newCode();
          this.display();
        }));

        if (plugin.hosting() && s.hostBind !== "local") {
          const url = plugin.host.publicUrl();
          const addr = new Setting(containerEl)
            .setName("Address for your other devices")
            .setDesc("Type this into Quartzi Copilot settings on each of your other devices.");
          addr.controlEl.createEl("code", { cls: "vc-code", text: url });
          addr.addButton((b) => b.setButtonText("Copy").onClick(() => { navigator.clipboard.writeText(url); new Notice("Address copied"); }));
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

    if (Platform.isTablet) {
      new Setting(containerEl)
        .setName("Open chat")
        .setDesc("Beside your note keeps both on screen. Sidebar slides over from the right.")
        .addDropdown((d) => d.addOption("beside", "Beside the note").addOption("sidebar", "In the sidebar").setValue(s.placement || "beside")
          .onChange(async (v) => { s.placement = v; await plugin.saveSettings(); plugin.app.workspace.detachLeavesOfType(VIEW_TYPE); await plugin.activate(); }));
    }
    if (Platform.isDesktopApp && plugin.hostEnabled()) this.providerSettings(containerEl);
    else this.providerStatus(containerEl);
    new Setting(containerEl)
      .setName("Show keyboard numbers")
      .setDesc("Shows the keyboard measurements above the message box on this device, for fixing layout. Build " + BUILD + ".")
      .addToggle((t) => t.setValue(plugin.local("kbdebug") === "on").onChange((on) => { plugin.local("kbdebug", on ? "on" : "off"); plugin.views().forEach((v) => v.kbNote && v.kbNote()); }));
    // A computer that runs Claude Code itself connects to itself, so these are only for other devices.
    if (!(Platform.isDesktopApp && plugin.hostEnabled())) {
      new Setting(containerEl).setName(Platform.isDesktopApp ? "Connect to another computer" : "Connect to your computer").setHeading();
      containerEl.createDiv({ cls: "setting-item-description vc-settings-note", text: "Both are kept on this device only and never sync. Find them in Quartzi Copilot settings on the computer running Claude Code." });
      new Setting(containerEl)
        .setName("Computer address")
        .setDesc("For example ws://100.101.102.103:8787.")
        .addText((t) => t.setPlaceholder("ws://100.x.y.z:8787").setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim();
          await plugin.saveSettings();
        }));
      new Setting(containerEl)
        .setName("Pairing code")
        .addText((t) => { t.inputEl.type = "password"; t.setPlaceholder("XXXX-XXXX-XXXX-XXXX").setValue(s.pairingCode).onChange(async (v) => {
          s.pairingCode = v.trim().toUpperCase();
          await plugin.saveSettings();
        }); })
        .addButton((b) => b.setButtonText("Reconnect").onClick(() => plugin.views().forEach((v) => v.reconnect())));
    }

    new Setting(containerEl).setName("Saved chats").setHeading();
    new Setting(containerEl)
      .setName("Keep tool output")
      .setDesc("Saved chats sync to your other devices. Off, they keep what each tool was asked to do but not what it returned, such as the text of notes it read. Kept on this device only.")
      .addToggle((t) => t.setValue(!!s.keepToolOutput).onChange(async (on) => { s.keepToolOutput = on; await plugin.saveSettings(); }));

    new Setting(containerEl).setName("Connection").setHeading();
    new Setting(containerEl)
      .setName("Check connection")
      .setDesc(`This device runs ${plugin.manifest.version}.`)
      .addButton((b) => b.setButtonText("Check").onClick(async () => {
        const view = plugin.views()[0] || await plugin.activate();
        if (view) view.connectionAlert();
      }));
    new Setting(containerEl).setName("Build log").setHeading();
    new Setting(containerEl)
      .setName("Note")
      .setDesc(logProblem(s.logPath) || "Type /log and a line in the chat to add to it, on any device and with any model.")
      .addText((t) => t.setValue(s.logPath).onChange(async (v) => {
        s.logPath = v.trim();
        await plugin.saveSettings();
        if (plugin.host) plugin.host.config.logPath = logProblem(s.logPath) ? "" : s.logPath;
      }));
  }

  // On the host: where each key comes from, never its value. The box is always empty.
  providerSettings(containerEl) {
    const plugin = this.plugin;
    const refresh = () => plugin.views().forEach((v) => { if (v.isReady()) v.ws.send(JSON.stringify({ type: "models" })); });
    const secure = !!plugin.keychain();
    new Setting(containerEl).setName("Model providers").setHeading();
    containerEl.createDiv({ cls: "setting-item-description vc-settings-note", text: "Claude uses your Claude login. Other providers appear in the brain menu once they have a key. Keys stay on this computer and never sync. Those chats use the built-in file and shell tools, without your MCP servers." });
    const keyRow = (row, id, env) => {
      const saved = plugin.keySource(id);
      const state = saved === "keychain" ? "Set, in this computer's keychain."
        : saved === "plain" ? `Set, but not encrypted on this computer. Move it to the ${env || "keychain"}.`
        : env && process.env[env] ? `Set, from ${env}.` : "Not set.";
      row.setDesc(secure || !env ? state : `${state}${state === "Not set." ? ` Set ${env} on this computer and restart Obsidian.` : ""}`);
      if (secure) {
        let typed = "";
        row.addText((t) => { t.inputEl.type = "password"; t.setPlaceholder("Paste a key").onChange((v) => { typed = v.trim(); }); });
        row.addButton((b) => b.setButtonText("Save").onClick(() => { if (typed) { plugin.setKey(id, typed); refresh(); this.display(); } }));
      }
      if (saved) row.addButton((b) => b.setButtonText("Clear").setWarning().onClick(() => { plugin.setKey(id, ""); refresh(); this.display(); }));
    };
    for (const id of Object.keys(PROVIDERS)) {
      const p = PROVIDERS[id];
      if (id === "claude" || p.local) continue;
      keyRow(new Setting(containerEl).setName(p.name), id, p.env);
    }
    containerEl.createDiv({ cls: "setting-item-description vc-settings-note", text: "Ollama and LM Studio appear on their own while they are running on this computer." });

    new Setting(containerEl).setName("Custom endpoints").setHeading();
    containerEl.createDiv({ cls: "setting-item-description vc-settings-note", text: "Any OpenAI-compatible API. Models it doesn't list go in Model list, separated by commas." });
    const list = plugin.customs();
    let refreshTimer = null;
    const save = () => { plugin.saveCustoms(list); clearTimeout(refreshTimer); refreshTimer = window.setTimeout(refresh, 800); };
    list.forEach((c) => {
      const problem = endpointProblem(c);
      new Setting(containerEl).setName(c.name || "New endpoint").setDesc(problem).setHeading()
        .addButton((b) => b.setButtonText("Remove").setWarning().onClick(() => {
          plugin.setKey(c.id, "");
          list.splice(list.indexOf(c), 1);
          save();
          this.display();
        }));
      const field = (name, key, hint, parse) => new Setting(containerEl).setName(name).addText((t) => t.setPlaceholder(hint).setValue(key === "models" ? (c.models || []).join(", ") : c[key] || "").onChange((v) => { c[key] = parse ? parse(v) : v.trim(); save(); }));
      field("Name", "name", "My server");
      field("Base URL", "base", "https://host/v1");
      field("Key variable", "keyEnv", "MY_API_KEY");
      field("Model list", "models", "model-a, model-b", (v) => v.split(",").map((m) => m.trim()).filter((m) => MODEL_ID.test(m)));
      keyRow(new Setting(containerEl).setName("Key"), c.id, c.keyEnv);
    });
    new Setting(containerEl).addButton((b) => b.setButtonText("Add endpoint").onClick(() => {
      list.push({ id: "custom-" + Date.now().toString(36), name: "", base: "", keyEnv: "", models: [] });
      save();
      this.display();
    }));
  }

  // On other devices: what the host says is ready. Keys can't be set from here.
  providerStatus(containerEl) {
    const view = this.plugin.views().find((v) => v.isReady());
    if (!view || !view.providers) return;
    new Setting(containerEl).setName("Model providers").setHeading();
    for (const p of view.providers) new Setting(containerEl).setName(p.name).setDesc(p.set === false ? "Not set" : "Set");
  }
}

module.exports = class VaultClaudePlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.loadLocalSettings(data);
    // Older versions saved "" for Default/Auto; those choices are gone.
    if (!this.settings.provider) this.settings.provider = "claude";
    if (!MODELS.some(([v]) => v === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model;
    if (!EFFORTS.some(([v]) => v === this.settings.effort)) this.settings.effort = DEFAULT_SETTINGS.effort;
    this.host = null;
    this.hostError = "";
    this.registerView(VIEW_TYPE, (leaf) => new VaultClaudeView(leaf, this));
    if (addIcon) addIcon("quartzi", QUARTZI_MARK);
    this.addRibbonIcon("quartzi", "Open Quartzi Copilot", () => this.activate());
    this.addCommand({ id: "open", name: "Open chat", callback: () => this.activate() });
    this.addCommand({
      id: "ask-about-selection",
      name: "Ask about selection",
      editorCheckCallback: (checking, editor, info) => {
        if (!editor.getSelection().trim() || !info || !info.file) return false;
        if (!checking) this.askQuartzi(info.file, editor.getSelection());
        return true;
      },
    });
    // Right-click on selected text in a note: "Ask Quartzi" opens the chat with that text attached.
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const text = editor.getSelection();
      const file = info && info.file;
      if (!text.trim() || !file) return;
      menu.addItem((item) => item.setTitle("Ask Quartzi").setIcon("quartzi").onClick(() => this.askQuartzi(file, text)));
    }));
    this.addCommand({
      id: "add-to-build-log",
      name: "Add to build log",
      callback: async () => {
        const view = await this.activate();
        if (view) { view.inputEl.value = "/log "; view.inputEl.focus(); view.updateSendButton(); }
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

  // ---------- settings kept on this device ----------
  // The values in LOCAL_SETTINGS live in this device's own storage, never in data.json. Builds before
  // 11-12 b kept them in data.json. On the first start of this build each device takes over what it
  // had there, except the pairing code: that one has been in a synced file, so the host makes a new
  // one and every other device is given it by hand. Then they are taken out of data.json.
  loadLocalSettings(data) {
    let inData = false;
    for (const k of LOCAL_SETTINGS) {
      if (data[k] !== undefined) inData = true;
      const kept = this.localSetting(k);
      if (kept !== undefined) this.settings[k] = kept;
      else if (k === "pairingCode") this.settings[k] = "";
      else if (data[k] !== undefined) this.localSetting(k, data[k]);
      else this.settings[k] = DEFAULT_SETTINGS[k];
    }
    // Take them out of data.json now, so a sync copy made before this build stops carrying them.
    if (inData) this.saveSettings();
  }

  localSetting(key, value) {
    if (value === undefined) {
      const raw = this.local("set-" + key);
      if (raw === null || raw === undefined || raw === "") return undefined;
      try { return JSON.parse(raw); } catch (e) { return undefined; }
    }
    this.local("set-" + key, JSON.stringify(value));
  }

  // A new code for this host. Every device paired with the old one is let go.
  async newCode() {
    this.settings.pairingCode = newPairingCode();
    await this.saveSettings();
    if (this.host) this.host.setToken(this.settings.pairingCode);
    this.views().forEach((v) => v.reconnect());
  }

  // What this device last heard from the host, for naming it when it can't be reached.
  lastHost(value) {
    if (value) return this.local("last-host", JSON.stringify(value));
    try { return JSON.parse(this.local("last-host")) || null; } catch (e) { return null; }
  }

  // ---------- keys (host only) ----------
  // Electron's safeStorage encrypts with the OS keychain (DPAPI on Windows). The encrypted copy
  // sits in this device's local storage, which doesn't sync. No keychain means no saved keys.
  keychain() {
    if (!Platform.isDesktopApp) return null;
    try {
      const electron = nodeRequire("electron");
      const store = electron.safeStorage || (electron.remote && electron.remote.safeStorage);
      return store && store.isEncryptionAvailable() ? store : null;
    } catch (e) { return null; }
  }

  getKey(id) {
    const sealed = this.local("key-" + id);
    const store = sealed && this.keychain();
    if (store) { try { return store.decryptString(Buffer.from(sealed, "base64")); } catch (e) { return ""; } }
    return this.local("provider-" + id) || ""; // 0.8.0 kept these unencrypted
  }

  setKey(id, value) {
    const store = this.keychain();
    this.local("provider-" + id, "");
    this.local("key-" + id, value && store ? Buffer.from(store.encryptString(value)).toString("base64") : "");
  }

  keySource(id) {
    if (this.local("key-" + id)) return "keychain";
    return this.local("provider-" + id) ? "plain" : "";
  }

  // 0.8.0 kept one custom address and plain keys. Moves them where 0.9.0 reads them.
  migrateKeys() {
    const url = this.local("provider-custom-url");
    if (url) {
      const list = this.customs();
      if (!list.some((c) => c.id === "custom")) this.saveCustoms(list.concat({ id: "custom", name: "Custom", base: url, keyEnv: "", models: [] }));
      this.local("provider-custom-url", "");
    }
    if (!this.keychain()) return;
    for (const id of [...Object.keys(PROVIDERS), ...this.customs().map((c) => c.id)]) {
      const plain = this.local("provider-" + id);
      if (plain) this.setKey(id, plain);
    }
  }

  // Custom endpoints are this host's own: synced settings can't point a key at a new address.
  customs() {
    try { return JSON.parse(this.local("custom-endpoints")) || []; } catch (e) { return []; }
  }

  saveCustoms(list) {
    this.local("custom-endpoints", JSON.stringify(list));
  }

  // ---------- build log ----------
  async appendLog(text) {
    const path = normalizePath(this.settings.logPath || DEFAULT_SETTINGS.logPath);
    const problem = logProblem(path);
    if (problem) throw new Error(problem);
    const device = Platform.isDesktopApp ? "computer" : Platform.isTablet ? "iPad" : "phone";
    const line = logLine(text, new Date(), this.manifest.version, device);
    const { vault } = this.app;
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return vault.process(file, (data) => data.replace(/\s*$/, "\n") + line + "\n");
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    return vault.create(path, `# Build log\n\n${line}\n`);
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
    if (String(s.pairingCode || "").replace(/-/g, "").length < MIN_CODE_LENGTH) { s.pairingCode = newPairingCode(); await this.saveSettings(); }
    this.migrateKeys();
    const adapter = this.app.vault.adapter;
    const port = Number(s.hostPort) || 8787;
    const host = new Host({
      vaultPath: typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "",
      configDir: this.app.vault.configDir,
      port,
      bind: s.hostBind,
      getKey: (id) => this.getKey(id),
      keySource: (id) => this.keySource(id),
      getCustom: () => this.customs(),
      version: this.manifest.version,
      logPath: logProblem(s.logPath) ? "" : s.logPath,
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

  // Another device saved data.json (iCloud, Obsidian Sync). The address and pairing code are no longer
  // taken from it: each device keeps its own, so an edit to a synced file can't point this device at
  // another computer or change what the host accepts. Chats on this device are left as they are.
  async onExternalSettingsChange() {}

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view);
  }

  async activate() {
    const ws = this.app.workspace;
    const beside = Platform.isTablet && this.settings.placement !== "sidebar";
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf && beside && leaf.getRoot() !== ws.rootSplit) { leaf.detach(); leaf = null; }
    if (!leaf) {
      leaf = beside ? ws.getLeaf("split", "vertical") : ws.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    return leaf.view;
  }

  async askQuartzi(file, text) {
    const view = await this.activate();
    if (view && typeof view.askAbout === "function") view.askAbout(file, text);
  }

  // data.json gets everything but the settings kept on this device. Unless this device keeps tool
  // output, saved chats keep only what each tool was asked to do.
  async saveSettings() {
    const out = Object.assign({}, this.settings);
    for (const k of LOCAL_SETTINGS) { this.localSetting(k, this.settings[k]); delete out[k]; }
    if (!this.settings.keepToolOutput) out.sessions = (this.settings.sessions || []).map(trimSession);
    await this.saveData(out);
  }
};

// For checks outside Obsidian only; Obsidian ignores this.
module.exports.securityCore = { VaultClaudeView, safeMarkdown, trimSession, trimToolItem, configDeny, privateDir, WsConn, Host, LOCAL_SETTINGS, MIN_CODE_LENGTH, newPairingCode };
