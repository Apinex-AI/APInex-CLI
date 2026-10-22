# APInex CLI

<p align="center">
  <img src="https://raw.githubusercontent.com/Apinex-AI/APInex-CLI/main/assets/apinex-mascot.svg" width="160" alt="APInex Mascot NEX" />
</p>

<p align="center">
  <strong>Zero-config autonomous terminal AI coding assistant &amp; Unix CLI for <a href="https://apinex.bond">APInex</a>.</strong><br>
  Built for macOS, Linux, and Windows.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/apinex-cli"><img src="https://img.shields.io/npm/v/apinex-cli.svg?style=flat-square&color=2dd4bf" alt="npm version" /></a>
  <a href="https://github.com/Apinex-AI/APInex-CLI/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square" alt="node version" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Apinex-AI/APInex-CLI/main/assets/cli-demo.svg" width="100%" alt="APInex CLI Terminal Interface Demo" />
</p>

---

## Highlights

- 🖥️ **Full-Screen Terminal TUI** — Launches in the alternate screen buffer (`apinex`). Exits cleanly without polluting terminal scrollback.
- 👾 **Animated Pixel Mascot (NEX)** — Interactive companion with live 4-frame blinking & thinking animations during AI generation.
- ⚡ **Autonomous Coding Agent with Native Tools**:
  - `write_file(path, content)` — Creates and writes files with automatic directory scaffolding.
  - `edit_file(path, old_str, new_str)` — Precision surgical replacements with red/green (`-` / `+`) unified diff previews.
  - `read_file(path)` — Reads files into context with encoding safety.
  - `grep_search(query, path)` — Fast recursive regex search with line numbers, binary exclusions, and 3.5s budget guard.
  - `find_files(pattern, directory)` — Workspace glob and substring file finder.
  - `web_search(query)` — Live internet search for up-to-date documentation, API specs, and error fixes.
  - `web_fetch(url)` — Fetches and parses readable markdown content from any documentation link.
  - `bash(command)` — Runs build tools, test suites, linters, package managers, and git operations.
- 🛡️ **Permission Guard** — Intercepts potentially destructive commands (`rm`, `git reset`, `git push --force`, `kill`, `drop table`, etc.) with interactive confirmation (`[y]es / [n]o / [a]lways`) and desktop notifications.
- 🖼️ **Multimodal Clipboard Image Paste (`Ctrl+V`)** — Auto-detects screenshots in your OS clipboard, shows a preview tag, and forwards high-resolution images to Vision-capable models.
- 📂 **Interactive `@` File Picker** — Type `@` inside the prompt to fuzzy-search workspace files with arrow navigation and Tab completion.
- 📜 **Project Guidelines & Memory (`APINEX.md`)** — Run `apinex init` to scan your repository and scaffold project conventions. Guidelines are automatically loaded into the agent context on every session.
- 🌿 **Built-in Git Assistant** — `/diff` inspects workspace modifications, and `/commit` automatically writes Conventional Commit messages and commits changes.
- 💳 **In-CLI Crypto Billing** — Top up USD balance (`/topup`), upgrade free-model subscription plans (`/subscriptions`), and adjust RPM limits (`/rpm`) via NowPayments directly from the terminal.
- 💾 **Session Save & Resume** — Auto-saves sessions on exit. Browse and resume past conversations with `apinex -r`.
- 🔐 **Zero-Config OAuth 2.0 PKCE** — Browser login with localhost callback or `--device` code for headless servers and SSH environments. No manual API keys required.
- 🌊 **Unix Pipes & One-Shot Execution** — Supports `git diff --staged | apinex commit-msg` and `apinex -m <model> "prompt"`.

---

## Installation

Install globally using `npm` (requires Node.js 20+):

```sh
npm install -g apinex-cli
```

Or run instantly without installing:

```sh
npx apinex
```

> **Troubleshooting: `command not found: apinex`**  
> If `apinex` is not found after running `npm install -g`, your shell needs npm's global bin directory in your `$PATH`. Run:
> 
> ```sh
> # macOS (Zsh)
> echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> 
> # Linux / macOS (Bash)
> echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
> ```

---

## Quick Start

```sh
# 1. Sign in via browser OAuth
apinex login

# 2. Launch the full-screen interactive session
apinex

# 3. Check live account balance, subscriptions, and RPM quota
apinex account

# 4. Generate a Conventional Commit from git diff
git diff --staged | apinex commit-msg

# 5. Execute a quick one-shot prompt
apinex -m free/deepseek-v4.1-flash "Explain how to structure an ESM CLI"
```

---

## Command-Line Usage

```text
Usage:
  apinex                            Launch full-screen APInex CLI session
  apinex -r [session-id]            Resume previous session (interactive picker if omitted)
  apinex login [--device]           Sign in via browser OAuth (or device code for SSH/servers)
  apinex account                    Show live USD balance, active plan, and RPM tier
  apinex topup [5|10|20|50]         Direct crypto top-up via NowPayments
  apinex subscriptions [plan]       Browse & purchase free-model subscription plans
  apinex rpm [30|60|100]            Upgrade RPM rate limit
  apinex init                       Scaffold APINEX.md project conventions & rules
  apinex update                     Check for updates and upgrade to latest version
  apinex models [--refresh]         List active catalog models with pricing & providers
  apinex use <model-id>             Set your default active model
  apinex [-m <model>] "<prompt>"    One-shot prompt (reads piped stdin if available)
  git diff | apinex commit-msg      Generate Conventional Commit from piped diff
  apinex logout                     Revoke CLI tokens and sign out
```

---

## Interactive TUI Features & Shortcuts

Launch with `apinex` in any repository or project directory:

```
┌────────────────────────────────────────────────────────────────────────┐
│ APInex CLI v1.0.0 · $10.00 · Pro Day · 12K/500K · 60 RPM               │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│     ✦                                                                  │
│   ▄█████▄      APInex CLI v1.0.0                                       │
│   █◉ ◉█      Autonomous coding assistant & terminal agent              │
│    ▀   ▀                                                               │
│                                                                        │
│ ❯ Explain and refactor the auth token rotation                         │
│                                                                        │
│ ◆ Tool: edit_file(server/auth.ts) · +14 lines -6 lines                 │
│ ✓ Refactored token rotation with cryptographic verification.           │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│ Context: 842 / 128K · Turn: 1.4s · 320 in · 148 out                    │
│ ❯ Add tests for the new token rotation flow_                           │
└────────────────────────────────────────────────────────────────────────┘
```

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Display list of available slash commands and shortcuts |
| `/init` | Initialize or update `APINEX.md` project memory |
| `/model [id]` | Interactive model selector with fuzzy search, or switch by ID |
| `/diff` | Review uncommitted git workspace changes with colorized diff |
| `/commit [msg]` | Auto-generate Conventional Commit from diff and commit |
| `/save [name]` | Save current conversation session to disk |
| `/resume` | Open interactive session picker to restore past sessions |
| `/copy` | Copy last assistant answer to system clipboard |
| `/account` | Refresh live wallet balance, active subscription, and rate limits |
| `/topup [amt]` | Open NowPayments top-up picker ($5, $10, $20, $50 + bonuses) |
| `/subscriptions` | Browse and activate free-model unlimited token pools |
| `/rpm [rate]` | Upgrade RPM rate limit tier (30, 60, 100 RPM) |
| `/compact` | Summarize and condense conversation context |
| `/clear` | Clear screen and start a fresh session |
| `/update` | Check for newer versions and auto-update |
| `/login` | Re-authenticate or switch accounts |
| `/logout` | Log out and remove local tokens |
| `/exit` | Save session and exit cleanly |

### Keyboard Shortcuts

- **Enter** — Send prompt to the agent
- **Shift + Enter / Alt + Enter** — Insert newline in multi-line prompts
- **Ctrl + C** — Cancel active stream / tool execution, or exit if idle
- **Ctrl + V** — Paste image from clipboard as multimodal Vision attachment
- **@** — Open fuzzy file picker to insert file paths into prompt
- **↑ / ↓** — Navigate prompt history
- **Mouse Wheel** — Scroll conversation history up and down
- **Mouse Click & Drag** — Highlight text and auto-copy to OS clipboard

---

## Project Instructions (`APINEX.md`)

APInex CLI respects project-specific conventions. When launched, it searches the workspace root for instruction files in the following order:

1. `APINEX.md`
2. `.apinexrules`
3. `CLAUDE.md`
4. `.cursorrules`
5. `.cursor/rules`

To generate an initial `APINEX.md` tailored to your stack:

```sh
apinex init
```

This scans your repository (detecting Node, Rust, Python, Go, package managers, and test scripts) and generates a structured guide that the agent automatically reads and follows.

---

## Shell Autocomplete Setup

Add tab-completion for subcommands and model names to your shell:

### Zsh
```sh
echo 'source <(apinex completion zsh)' >> ~/.zshrc
```

### Bash
```sh
echo 'source <(apinex completion bash)' >> ~/.bashrc
```

### Fish
```sh
echo 'apinex completion fish | source' >> ~/.config/fish/config.fish
```

### PowerShell (Windows)
```powershell
apinex completion pwsh | Out-String | Invoke-Expression
```

---

## Architecture & Security

- **Strict Loopback OAuth**: Browser redirects only accept `http://127.0.0.1:<ephemeral-port>/callback`.
- **Credential Storage**: Access and refresh tokens are stored in `~/.apinex/auth.json` with strict POSIX file permissions (`0o600`).
- **Permission Guard**: Destructive shell operations are caught before execution and require user consent.
- **Direct APInex Routing**: Only connects to official APInex endpoints (`api.apinex.bond`). Arbitrary third-party endpoints cannot be injected.

---

## License

[MIT](LICENSE) © 2026 APInex
