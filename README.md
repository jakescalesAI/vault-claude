# Quartzi Copilot

A chat sidebar for [Claude Code](https://claude.com/claude-code) inside Obsidian. It runs on your own computer with your own Claude subscription, and works in your vault. You can use it from the same computer, or from your iPad or phone anywhere over [Tailscale](https://tailscale.com).

- Chat in an iOS-style sidebar with streaming replies, tool steps, and links to the notes Claude touches.
- Claude sees the notes you have open. With several tabs or windows open, tap the note pill to choose which ones it gets.
- Attach photos and files with **+**, dictate with the mic, and queue messages while Claude works.
- Pick the mode (Edit, Plan, Read), the model and the effort from the brain menu.
- Rename chats by tapping the title, and pin the ones you want to keep at the top.

## How it works

On a desktop, the plugin starts Claude Code itself (`claude -p --output-format stream-json`) in your vault folder. Claude uses the same login, settings, `CLAUDE.md`, MCP servers and memory as Claude Code in your terminal.

Your iPad or phone has no Claude Code of its own. It connects to the desktop over a WebSocket on your Tailscale network and authenticates with a pairing code. The desktop runs each turn and streams the reply back.

```
iPad / phone ── Tailscale ──► Obsidian on your computer ──► Claude Code ──► your vault
```

Nothing goes through a third-party server. Chats are saved in the plugin's `data.json`. Claude Code keeps its own transcripts on the computer.

## Requirements

- **Computer:** Obsidian desktop (Windows, macOS or Linux), plus Claude Code installed and logged in (`claude` in a terminal should work).
- **Other devices (optional):** Tailscale on the computer and on the device, both signed in to the same tailnet.
- **Dictation (optional):** Python 3 with `faster-whisper` on the computer (`pip install faster-whisper`).

## Install

Until it is in the community directory, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. Run **BRAT: Add a beta plugin for testing** and enter this repository's URL.
3. Enable **Quartzi Copilot** under Settings → Community plugins.

Or install it by hand: copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/vault-claude/`.

## Set up

**On your computer.** Open the sidebar from the sparkles icon in the ribbon, or run **Quartzi Copilot: Open chat**. The plugin starts Claude Code automatically, and the status under the title reads *Running on this computer*.

**On your iPad or phone:**

1. On the computer, open Settings → Quartzi Copilot and set **Who can connect** to **My Tailscale devices**. The settings page then shows two things:
   - the **address for your other devices**, for example `ws://100.101.102.103:8787`
   - a **pairing code**
2. If your vault syncs (iCloud, Obsidian Sync, Syncthing), the device picks up the address and code from the synced settings. Install the plugin there and open the sidebar.
3. Otherwise, enter the address and pairing code under Settings → Quartzi Copilot on the device.

Keep Obsidian open on the computer, and keep the computer awake, while you use it from another device.

## Security

- Claude Code runs as you, in your vault. In **Edit** mode it edits files without asking. Use **Plan** or **Read** to keep it read-only.
- By default the host only listens on `127.0.0.1` and, when enabled, your Tailscale address. Every connection must send the pairing code within five seconds, or it is closed.
- **Any network** listens on every interface. Only use it on a network you trust, and prefer Tailscale.
- Tapping **New code** in settings signs out every paired device.
- The connection is plain `ws://`. Tailscale encrypts traffic between your devices. Don't expose the port to the internet.

## Troubleshooting

- **"Claude Code wasn't found"**: set **Claude Code location** in settings to the full path of `claude` (`where claude` on Windows, `which claude` on macOS/Linux).
- **"Port … is already in use"**: choose another port and update the address on your other devices.
- **iPad says "Not connected"**: check that Tailscale is on for both devices, that the computer is awake with Obsidian open, and that the address matches the one shown on the computer. On Windows, allow Obsidian through the firewall for private networks when asked.
- **"Not paired"**: the pairing code on the device doesn't match the computer. Copy it again.
- **Shell commands are refused**: in this headless mode Claude Code can't ask you for approval. Allow the commands you want in Claude Code's `settings.json` permissions.

## Development

There is no build step: `main.js` is plain CommonJS. The host uses only Node built-ins, loaded lazily, so the same file runs on mobile.

```
node test/host-test.cjs main.js /path/to/a/vault
```

This starts the host on port 8799 and runs real Claude Code turns through it: pairing, streaming, resume, attachments and dictation.

Releases: bump `version` in `manifest.json` and `versions.json`, commit, then push a tag with the same version (`git tag 0.4.1 && git push --tags`). The workflow attaches the three plugin files to a GitHub release.

## License

MIT

## Other model providers

Claude uses your Claude login. To add another provider, put its API key in Quartzi Copilot settings on the computer, or set its usual environment variable (for example `DEEPSEEK_API_KEY`). It then appears in the brain menu with the models it currently offers.

Supported: OpenAI, Google Gemini, DeepSeek, xAI, OpenRouter, Groq, Mistral, Moonshot Kimi, Z.ai GLM, Together AI, Ollama, LM Studio, and any OpenAI-compatible address. Requests are translated by a server on 127.0.0.1, so Claude Code's file and shell tools keep working. MCP servers are off for these chats. Keys stay on the computer and never sync.
