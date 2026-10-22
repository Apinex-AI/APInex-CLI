import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NATIVE_PASTEBOARD = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/pasteboard')

// Locked to APInex only
const SITE_ORIGIN = process.env.APINEX_SITE_URL || 'https://apinex.bond'
const API_ORIGIN = process.env.APINEX_API_URL || 'https://api.apinex.bond'
const CLIENT_ID = 'apinex-cli'
const VERSION = '1.0.1'
const CLI_SRC = 'apinexcli'
const MODEL_TTL_MS = 10 * 60 * 1000

const CLI_HEADERS = {
  'User-Agent': `APInex-CLI/${VERSION}`,
  src: CLI_SRC,
  'x-apinex-src': CLI_SRC,
}

const COMMIT_PROMPT =
  'Write one concise Conventional Commit subject line (optional short body) for the git diff on stdin. Return only the commit message, no markdown fences.'

function getMascotLines(animFrame) {
  if (animFrame === 1) {
    return [
      `   ${C.gold}✧${C.reset}   `,
      ` ${C.accent}▄█████▄${C.reset} `,
      ` ${C.accent}█${C.cyan}—${C.reset} ${C.cyan}—${C.accent}█${C.reset} `,
      `  ${C.accent}▀   ▀${C.reset}  `,
    ]
  }
  if (animFrame === 2) {
    return [
      `   ${C.gold}★${C.reset}   `,
      ` ${C.accent}▄█████▄${C.reset} `,
      ` ${C.accent}█${C.cyan}◕${C.reset} ${C.cyan}◕${C.accent}█${C.reset} `,
      `  ${C.accent}▀   ▀${C.reset}  `,
    ]
  }
  if (animFrame === 3) {
    return [
      `  ${C.gold}✹✦✹${C.reset}  `,
      ` ${C.accent}▄█████▄${C.reset} `,
      ` ${C.accent}█${C.cyan}◉${C.reset} ${C.cyan}◉${C.accent}█${C.reset} `,
      `  ${C.accent}▀   ▀${C.reset}  `,
    ]
  }
  return [
    `   ${C.gold}✦${C.reset}   `,
    ` ${C.accent}▄█████▄${C.reset} `,
    ` ${C.accent}█${C.cyan}◉${C.reset} ${C.cyan}◉${C.accent}█${C.reset} `,
    `  ${C.accent}▀   ▀${C.reset}  `,
  ]
}

const AGENT_SYSTEM_PROMPT = `You are APInex CLI, an autonomous terminal AI coding assistant running on ${process.platform} in directory: ${process.cwd()}.

You have access to tools to interact directly with the user's filesystem, shell, and the live internet:
- write_file(path, content): Create or overwrite a file.
- edit_file(path, old_str, new_str): Replace text inside an existing file.
- read_file(path): Read file contents.
- grep_search(query, path, case_sensitive): Fast text/regex search across project files with line numbers.
- find_files(pattern, directory): Fast glob/substring search for files in the project.
- web_search(query): Real-time internet search for up-to-date documentation, APIs, error solutions, and libraries.
- web_fetch(url): Fetch and read the full text/markdown content of any web page or documentation link.
- bash(command): Execute shell commands (e.g. curl, git, npm, node, test runners).

CRITICAL INSTRUCTIONS:
1. When asked to perform actions (create, edit, delete files, run commands, fetch data from web/APIs), ALWAYS call the appropriate tool directly.
2. For code discovery, ALWAYS prefer grep_search and find_files over bash commands like grep/find.
3. For latest docs, current library versions, or external research, ALWAYS use web_search and web_fetch.
4. NEVER output markdown code blocks showing bash commands if you can execute them yourself with the bash or file tools.
5. If asked to delete a file, call the bash tool with "rm <path>" (or "del" on Windows).
6. Perform steps sequentially. After each tool execution, verify the result and proceed to the next step until the user's goal is complete.
7. Provide a brief, concise final summary once all actions have been completed.`

function loadProjectRules(cwd = process.cwd()) {
  const candidates = [
    'APINEX.md',
    '.apinexrules',
    'CLAUDE.md',
    '.cursorrules',
    '.cursor/rules',
  ]
  let current = resolve(cwd)
  const root = parse(current).root
  while (true) {
    for (const name of candidates) {
      const full = join(current, name)
      if (existsSync(full)) {
        try {
          const stat = statSync(full)
          if (stat.isFile()) {
            const content = readFileSync(full, 'utf8').trim()
            if (content) {
              return { file: name, fullPath: full, content }
            }
          }
        } catch { /* ignore */ }
      }
    }
    if (current === root || current === homedir()) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function getAgentSystemPrompt(cwd = process.cwd()) {
  let prompt = AGENT_SYSTEM_PROMPT
  const rules = loadProjectRules(cwd)
  if (rules) {
    prompt += `\n\n=============================================================\nPROJECT-SPECIFIC INSTRUCTIONS & CONVENTIONS (Loaded from ${rules.file}):\n${rules.content.slice(0, 30_000)}\n=============================================================`
  }
  return prompt
}

function generateApinexMd(cwd = process.cwd()) {
  const lines = ['# APINEX.md', '']
  lines.push('Project guidelines and conventions for APInex CLI autonomous coding assistant.', '')

  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const name = pkg.name || basename(cwd)
      const desc = pkg.description || ''
      lines.push(`## Overview`)
      lines.push(`- **Project**: ${name}${desc ? ' — ' + desc : ''}`)
      if (pkg.type === 'module') lines.push(`- **Module Type**: ESM (ECMAScript Modules)`)

      let pm = 'npm'
      if (existsSync(join(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm'
      else if (existsSync(join(cwd, 'yarn.lock'))) pm = 'yarn'
      else if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) pm = 'bun'
      lines.push(`- **Package Manager**: \`${pm}\``)
      lines.push('')

      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        lines.push(`## Development Commands`)
        for (const [key, cmd] of Object.entries(pkg.scripts)) {
          if (['build', 'test', 'lint', 'dev', 'start', 'check', 'typecheck'].includes(key)) {
            lines.push(`- **${key}**: \`${pm} run ${key}\` (\`${cmd}\`)`)
          }
        }
        lines.push('')
      }
    } catch { /* ignore */ }
  }

  const cargoPath = join(cwd, 'Cargo.toml')
  if (existsSync(cargoPath)) {
    lines.push(`## Rust Guidelines`)
    lines.push(`- **Build**: \`cargo build\``)
    lines.push(`- **Test**: \`cargo test\``)
    lines.push(`- **Check**: \`cargo check\` and \`cargo clippy\``)
    lines.push('')
  }

  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'setup.py'))) {
    lines.push(`## Python Guidelines`)
    lines.push(`- **Test**: \`pytest\``)
    if (existsSync(join(cwd, 'ruff.toml')) || existsSync(join(cwd, '.ruff.toml'))) {
      lines.push(`- **Lint**: \`ruff check .\``)
    }
    lines.push('')
  }

  if (existsSync(join(cwd, 'go.mod'))) {
    lines.push(`## Go Guidelines`)
    lines.push(`- **Build**: \`go build ./...\``)
    lines.push(`- **Test**: \`go test ./...\``)
    lines.push('')
  }

  lines.push(`## Architecture & Conventions`)
  lines.push(`- **Consistency**: Follow the conventions and patterns in the existing codebase.`)
  lines.push(`- **Surgical Changes**: Make minimal, precise changes; do not reformat unrelated files.`)
  lines.push(`- **Verification**: Run tests and type-checks after editing code to verify correctness.`)
  lines.push(`- **Safety**: Do not commit secrets, API keys, or private environment variables.`)
  lines.push('')

  return lines.join('\n')
}

const isTrueColor = Boolean(
  (process.env.COLORTERM === 'truecolor' ||
   process.env.COLORTERM === '24bit' ||
   process.env.TERM_PROGRAM === 'iTerm.app' ||
   process.env.TERM_PROGRAM === 'ghostty' ||
   process.env.TERM_PROGRAM === 'vscode' ||
   process.env.TERM_PROGRAM === 'WezTerm') &&
  process.env.TERM_PROGRAM !== 'Apple_Terminal'
)

const C = isTrueColor
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      accent: '\x1b[38;2;215;119;87m',
      green: '\x1b[38;2;45;216;106m',
      greenBg: '\x1b[48;2;20;50;25m\x1b[38;2;120;230;140m',
      red: '\x1b[38;2;239;92;92m',
      redBg: '\x1b[48;2;60;20;20m\x1b[38;2;255;140;140m',
      blue: '\x1b[38;2;126;182;246m',
      yellow: '\x1b[38;2;232;179;57m',
      gold: '\x1b[38;2;236;184;78m',
      cyan: '\x1b[38;2;124;246;255m',
      gray: '\x1b[38;2;138;136;146m',
      line: '\x1b[38;2;60;60;66m',
      white: '\x1b[38;2;240;239;237m',
      toolTag: '\x1b[38;2;70;190;120m',
    }
  : {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      accent: '\x1b[38;5;208m',
      green: '\x1b[38;5;48m',
      greenBg: '\x1b[48;5;22m\x1b[38;5;120m',
      red: '\x1b[38;5;203m',
      redBg: '\x1b[48;5;52m\x1b[38;5;210m',
      blue: '\x1b[38;5;75m',
      yellow: '\x1b[38;5;221m',
      gold: '\x1b[38;5;214m',
      cyan: '\x1b[38;5;81m',
      gray: '\x1b[38;5;244m',
      line: '\x1b[38;5;238m',
      white: '\x1b[38;5;255m',
      toolTag: '\x1b[38;5;71m',
    }

const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'Show available slash commands and shortcuts' },
  { cmd: '/init', desc: 'Initialize APINEX.md project instructions & memory' },
  { cmd: '/topup', desc: 'Top up USD balance ($5, $10, $20, $50 + bonuses)' },
  { cmd: '/subscriptions', desc: 'Browse and purchase free-model subscription plans' },
  { cmd: '/rpm', desc: 'Upgrade RPM rate limits (30, 60, 100 RPM)' },
  { cmd: '/model', desc: 'Switch active APInex model' },
  { cmd: '/resume', desc: 'Browse and resume previous sessions' },
  { cmd: '/copy', desc: 'Copy last AI response to clipboard' },
  { cmd: '/commit', desc: 'Auto-generate Conventional Commit & commit' },
  { cmd: '/diff', desc: 'Inspect uncommitted git changes' },
  { cmd: '/save', desc: 'Save current session to disk' },
  { cmd: '/account', desc: 'Refresh live USD balance & plan usage' },
  { cmd: '/compact', desc: 'Compact session context' },
  { cmd: '/clear', desc: 'Clear conversation screen & history' },
  { cmd: '/update', desc: 'Check and install APInex CLI updates' },
  { cmd: '/login', desc: 'Sign in or switch APInex account via browser' },
  { cmd: '/logout', desc: 'Revoke CLI session and exit' },
  { cmd: '/exit', desc: 'Exit APInex CLI' },
]

const FUN_THINKING_PHRASES = [
  'Computing…',
  'Synthesizing…',
  'Deliberating…',
  'Cogitating…',
  'Pondering…',
  'Orchestrating…',
  'Cooking…',
  'Crafting…',
  'Percolating…',
  'Formulating…',
  'Boondoggling…',
  'Mulling over code…',
  'Connecting dots…',
  'Navigating AST…',
  'Brewing response…',
]

function readNativeClipboard() {
  if (process.platform === 'darwin' && existsSync(NATIVE_PASTEBOARD)) {
    try {
      const out = execFileSync(NATIVE_PASTEBOARD, { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (out.startsWith('IMAGE:')) {
        return { type: 'image', base64: out.slice(6) }
      }
      if (out.startsWith('TEXT:')) {
        return { type: 'text', text: out.slice(5) }
      }
      return null
    } catch {
      return null
    }
  }
  return null
}

function getClipboardImageBase64() {
  const native = readNativeClipboard()
  if (native?.type === 'image') {
    return { base64: native.base64, mediaType: 'image/png' }
  }
  if (process.platform === 'darwin') {
    try {
      const res = execSync('osascript -e "get the clipboard as «class PNGf»"', { encoding: 'utf8', timeout: 2500, stdio: ['pipe', 'pipe', 'ignore'] })
      const m = res.match(/«data PNGf([0-9A-Fa-f]+)»/)
      if (m && m[1]) return { base64: Buffer.from(m[1], 'hex').toString('base64'), mediaType: 'image/png' }
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    try {
      const script = '[Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object IO.MemoryStream; $img.Save($ms, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }'
      const res = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf8', timeout: 3500, stdio: ['pipe', 'pipe', 'ignore'] }).trim()
      if (res && res.length > 50) return { base64: res, mediaType: 'image/png' }
    } catch {
      return null
    }
  }
  try {
    const wayland = execSync('wl-paste -t image/png 2>/dev/null', { timeout: 2000, maxBuffer: 10 * 1024 * 1024 })
    if (wayland && wayland.length > 50) return { base64: Buffer.from(wayland).toString('base64'), mediaType: 'image/png' }
  } catch {}
  try {
    const x11 = execSync('xclip -selection clipboard -t image/png -o 2>/dev/null', { timeout: 2000, maxBuffer: 10 * 1024 * 1024 })
    if (x11 && x11.length > 50) return { base64: Buffer.from(x11).toString('base64'), mediaType: 'image/png' }
  } catch {}
  return null
}

function getClipboardText() {
  const native = readNativeClipboard()
  if (native?.type === 'text') {
    return native.text
  }
  if (process.platform === 'darwin') {
    try {
      return execSync('/usr/bin/pbpaste', { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }
  if (process.platform === 'win32') {
    try {
      return execSync('powershell -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 1500, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }
  try {
    return execSync('wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null', { encoding: 'utf8', timeout: 1000 })
  } catch {
    return ''
  }
}

const SEL_BG = isTrueColor
  ? '\x1b[48;2;60;80;110m\x1b[38;2;255;255;255m'
  : '\x1b[48;5;60m\x1b[38;5;255m'
const SEL_RESET = '\x1b[0m'
const CODE_BG = isTrueColor
  ? '\x1b[48;2;36;36;42m'
  : '\x1b[48;5;236m'

function highlightAnsiLine(rawLine, startCol, endCol) {
  let visCol = 0
  let startIdx = -1
  let endIdx = -1
  let i = 0

  while (i < rawLine.length) {
    if (rawLine[i] === '\x1b' && rawLine[i + 1] === '[') {
      const ANSI_P_RE = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`)
      const m = rawLine.slice(i).match(ANSI_P_RE)
      if (m) {
        i += m[0].length
        continue
      }
    }
    if (visCol === startCol && startIdx === -1) startIdx = i
    if (visCol === endCol && endIdx === -1) endIdx = i
    visCol += 1
    i += 1
  }
  if (startIdx === -1) startIdx = i
  if (endIdx === -1) endIdx = i
  if (startIdx >= endIdx) return rawLine

  return rawLine.slice(0, startIdx) + SEL_BG + rawLine.slice(startIdx, endIdx) + SEL_RESET + rawLine.slice(endIdx)
}

function applyVisualSelection(lines, start, end) {
  let [r1, c1, r2, c2] = [start.row - 1, start.col - 1, end.row - 1, end.col - 1]
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    ;[r1, c1, r2, c2] = [r2, c2, r1, c1]
  }
  return lines.map((line, r) => {
    if (r < r1 || r > r2) return line
    if (r1 === r2) {
      return highlightAnsiLine(line, c1, c2)
    }
    if (r === r1) {
      return highlightAnsiLine(line, c1, 999)
    }
    if (r === r2) {
      return highlightAnsiLine(line, 0, c2)
    }
    return highlightAnsiLine(line, 0, 999)
  })
}

function deleteWordBackward(str, cur) {
  if (cur <= 0) return { str, cur }
  let i = cur
  while (i > 0 && str[i - 1] === ' ') i -= 1
  while (i > 0 && str[i - 1] !== ' ') i -= 1
  const newStr = str.slice(0, i) + str.slice(cur)
  return { str: newStr, cur: i }
}

function jumpWordLeft(str, cur) {
  let i = cur
  while (i > 0 && str[i - 1] === ' ') i -= 1
  while (i > 0 && str[i - 1] !== ' ') i -= 1
  return Math.max(0, i)
}

function jumpWordRight(str, cur) {
  let i = cur
  while (i < str.length && str[i] === ' ') i += 1
  while (i < str.length && str[i] !== ' ') i += 1
  return Math.min(str.length, i)
}

const BRACKETED_PASTE_RE = new RegExp(`(${String.fromCharCode(27)}\\[20[01]~|\\[20[01]~)`, 'g')

function extractSelectedText(allLines, start, end) {
  let [r1, c1] = [start.row - 1, start.col - 1]
  let [r2, c2] = [end.row - 1, end.col - 1]
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    const tr = r1; r1 = r2; r2 = tr
    const tc = c1; c1 = c2; c2 = tc
  }
  const selected = []
  for (let r = r1; r <= r2; r += 1) {
    const raw = allLines[r] || ''
    const clean = stripAnsi(raw).replace(BRACKETED_PASTE_RE, '')
    if (r1 === r2) {
      selected.push(clean.slice(c1, c2))
    } else if (r === r1) {
      selected.push(clean.slice(c1))
    } else if (r === r2) {
      selected.push(clean.slice(0, c2))
    } else {
      selected.push(clean)
    }
  }
  return selected.join('\n').replace(/\n+$/, '')
}

function computeLineDiff(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n')
  const b = String(newStr ?? '').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1
  }
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }
  const prefix = a.slice(0, start).map((line) => ({ type: 'same', line }))
  const suffix = a.slice(endA + 1).map((line) => ({ type: 'same', line }))
  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)

  if (midA.length === 0 && midB.length === 0) {
    return prefix.concat(suffix)
  }
  if (midA.length * midB.length > 2_000_000) {
    return prefix
      .concat(midA.map((line) => ({ type: 'del', line })))
      .concat(midB.map((line) => ({ type: 'add', line })))
      .concat(suffix)
  }

  const m = midA.length, n = midB.length
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (midA[i] === midB[j]) dp[i + 1][j + 1] = dp[i][j] + 1
      else dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const midResult = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midA[i - 1] === midB[j - 1]) {
      midResult.push({ type: 'same', line: midA[i - 1] })
      i -= 1; j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      midResult.push({ type: 'add', line: midB[j - 1] })
      j -= 1
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      midResult.push({ type: 'del', line: midA[i - 1] })
      i -= 1
    }
  }
  return [...prefix, ...midResult.reverse(), ...suffix]
}

function copyToClipboard(text) {
  if (!text) return false
  const clean = stripAnsi(String(text)).replace(BRACKETED_PASTE_RE, '')
  if (process.platform === 'darwin') {
    try {
      execSync('/usr/bin/pbcopy', { input: clean, encoding: 'utf8', timeout: 1000 })
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') {
    try {
      execSync('clip', { input: clean, encoding: 'utf8', timeout: 1500 })
      return true
    } catch {
      return false
    }
  }
  try {
    execSync('wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null', { input: clean, timeout: 1000 })
    return true
  } catch {
    return false
  }
}

export {
  copyToClipboard,
  formatInlineMarkdown,
  wrapText,
  computeLineDiff,
  stripAnsi,
  parseSemver,
  isNewerVersion,
  parseContextTokens,
  estimateTokens,
  generateApinexMd,
}

function formatInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, `${C.bold}${C.white}$1${C.reset}`)
    .replace(/__([^_]+)__/g, `${C.bold}${C.white}$1${C.reset}`)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `\x1b[3m$1${C.reset}`)
    .replace(/(?<!_)_([^_]+)_(?!_)/g, `\x1b[3m$1${C.reset}`)
    .replace(/`([^`]+)`/g, `${CODE_BG}${C.yellow} $1 ${C.reset}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.cyan}$1${C.reset} (${C.dim}$2${C.reset})`)
}

function renderMarkdownLines(text, cols) {
  const lines = []
  const rawLines = String(text ?? '').split('\n')
  let inCode = false
  let codeLang = ''

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]
    const fenceMatch = raw.match(/^```(\w*)/)
    if (fenceMatch) {
      if (!inCode) {
        inCode = true
        codeLang = fenceMatch[1] || ''
        lines.push(`  ${C.gray}┌── ${codeLang ? C.cyan + codeLang + ' ' + C.gray : ''}─────────────────────────${C.reset}`)
      } else {
        inCode = false
        lines.push(`  ${C.gray}└───────────────────────────────────${C.reset}`)
      }
      continue
    }

    if (inCode) {
      lines.push(`  ${C.gray}│${C.reset} ${C.white}${raw}${C.reset}`)
      continue
    }

    if (!raw.trim()) {
      lines.push('')
      continue
    }

    if (raw.startsWith('### ')) {
      lines.push(`${C.bold}${C.cyan}${formatInlineMarkdown(raw.slice(4))}${C.reset}`)
      continue
    }
    if (raw.startsWith('## ')) {
      lines.push(`${C.bold}${C.white}${formatInlineMarkdown(raw.slice(3))}${C.reset}`)
      continue
    }
    if (raw.startsWith('# ')) {
      lines.push(`${C.bold}${C.accent}${formatInlineMarkdown(raw.slice(2))}${C.reset}`)
      continue
    }

    const listMatch = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (listMatch) {
      const indent = listMatch[1]
      const bullet = /^\d+\./.test(listMatch[2]) ? `${C.accent}${listMatch[2]}${C.reset}` : `${C.accent}•${C.reset}`
      lines.push(`  ${indent}${bullet} ${formatInlineMarkdown(listMatch[3])}`)
      continue
    }

    if (raw.startsWith('> ')) {
      lines.push(`  ${C.gray}│${C.reset} \x1b[3m${formatInlineMarkdown(raw.slice(2))}${C.reset}`)
      continue
    }

    lines.push(formatInlineMarkdown(raw))
  }

  const wrapped = []
  for (const ln of lines) {
    wrapped.push(...wrapText(ln, cols - 4))
  }
  return wrapped
}

function parseContextTokens(cw) {
  if (!cw) return 128_000
  const s = String(cw).trim().toUpperCase()
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000)
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000)
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : 128_000
}

function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += (part.text || '').length
        else if (part.type === 'image_url') chars += 1600
      }
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / 3.6)
}

const CTRL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g')
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g')
function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '')
}

function configDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'apinex')
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'apinex')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeSecretJson(file, value) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try { chmodSync(file, 0o600) } catch { /* ignore */ }
  }
}

const authFile = () => join(configDir(), 'auth.json')
const cfgFile = () => join(configDir(), 'config.json')
const modelsFile = () => join(configDir(), 'models.json')
const updateFile = () => join(configDir(), 'update.json')
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function parseSemver(v) {
  const parts = String(v || '').replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function isNewerVersion(current, remote) {
  const [cMaj, cMin, cPat] = parseSemver(current)
  const [rMaj, rMin, rPat] = parseSemver(remote)
  if (rMaj > cMaj) return true
  if (rMaj === cMaj && rMin > cMin) return true
  if (rMaj === cMaj && rMin === cMin && rPat > cPat) return true
  return false
}

function loadCachedUpdate() {
  const data = readJson(updateFile(), null)
  if (!data) return null
  return data
}

async function checkRemoteVersion(force = false) {
  const cached = loadCachedUpdate()
  if (!force && cached?.checkedAt && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    return cached
  }
  try {
    const res = await fetch(`${API_ORIGIN}/api/cli/version`, {
      headers: { ...CLI_HEADERS },
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) return cached
    const data = await res.json()
    const latestVersion = String(data.version || '').replace(/^v/, '')
    const hasUpdate = isNewerVersion(VERSION, latestVersion)
    const updateInfo = {
      checkedAt: Date.now(),
      latestVersion,
      hasUpdate,
      critical: Boolean(data.critical),
      changelog: String(data.changelog || ''),
      releaseUrl: String(data.releaseUrl || 'https://github.com/Apinex-AI/APInex-CLI/releases'),
      installCommand: String(data.installCommand || 'npm install -g apinex-cli'),
    }
    writeSecretJson(updateFile(), updateInfo)
    return updateInfo
  } catch {
    return cached
  }
}

function triggerBackgroundUpdateCheck(onUpdateFound) {
  const cached = loadCachedUpdate()
  if (!cached?.checkedAt || Date.now() - cached.checkedAt >= UPDATE_CHECK_INTERVAL_MS) {
    checkRemoteVersion(true)
      .then((info) => {
        if (info?.hasUpdate && typeof onUpdateFound === 'function') {
          onUpdateFound(info)
        }
      })
      .catch(() => undefined)
  }
}

function printConsoleUpdateNotice(info) {
  if (!info?.hasUpdate || !process.stderr.isTTY) return
  const cur = `v${VERSION}`
  const next = `v${info.latestVersion}`
  const line1 = `  💡 Update available: ${cur} → ${next}`
  const line2 = `  Run ${C.bold}${C.white}apinex update${C.reset} to install the latest version`
  process.stderr.write(`\n${C.yellow}╭──────────────────────────────────────────────────────────╮${C.reset}\n`)
  process.stderr.write(`${C.yellow}│${C.reset}${line1.padEnd(58)}${C.yellow}│${C.reset}\n`)
  process.stderr.write(`${C.yellow}│${C.reset}${line2.padEnd(81)}${C.yellow}│${C.reset}\n`)
  process.stderr.write(`${C.yellow}╰──────────────────────────────────────────────────────────╯${C.reset}\n\n`)
}

function loadAuth() { return readJson(authFile(), null) }
function loadCfg() { return readJson(cfgFile(), { defaultModel: 'deepseek-v4-flash' }) }
function saveCfg(next) { writeSecretJson(cfgFile(), { ...loadCfg(), ...next }) }

const sessionsDir = () => join(configDir(), 'sessions')

function saveSessionFile(name, data) {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
  const sanitized = (name || 'last').replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = join(sessionsDir(), `${sanitized}.json`)
  writeSecretJson(file, data)
  return file
}

function loadSessionFile(name) {
  const sanitized = (name || 'last').replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = join(sessionsDir(), `${sanitized}.json`)
  if (!existsSync(file)) return null
  return readJson(file, null)
}

function formatRelativeDate(d) {
  const date = d instanceof Date ? d : new Date(d)
  const now = new Date()
  const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`
  return date.toLocaleDateString()
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function listSavedSessions() {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  let files = []
  try { files = readdirSync(dir) } catch { return [] }
  const sessions = []
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'last.json') continue
    const full = join(dir, f)
    try {
      let st = null
      try { st = statSync(full) } catch { /* ignore */ }
      const d = JSON.parse(readFileSync(full, 'utf8'))
      const id = d.sessionId || f.replace(/\.json$/, '')
      const firstUser = (d.history || []).find((m) => m.role === 'user')
      let preview = ''
      if (typeof firstUser?.content === 'string') {
        preview = firstUser.content.replace(/^❯\s*/, '').replace(/[\r\n]+/g, ' ').trim()
      } else if (Array.isArray(firstUser?.content)) {
        preview = (firstUser.content.find((p) => p.type === 'text')?.text || '').replace(/^❯\s*/, '').replace(/[\r\n]+/g, ' ').trim()
      }
      const titleStr = preview.slice(0, 50) || '(empty session)'
      sessions.push({
        id: String(id),
        savedAt: d.savedAt ? new Date(d.savedAt) : (st ? new Date(st.mtimeMs) : new Date()),
        model: String(d.model || 'default'),
        cwd: String(d.cwd || ''),
        title: titleStr,
        preview: titleStr,
        turns: Array.isArray(d.history) ? Math.floor(d.history.length / 2) : 0,
        size: st ? formatBytes(st.size) : '0 B',
        file: full,
      })
    } catch { /* ignore corrupted */ }
  }
  sessions.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime())
  return sessions
}

const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist_next',
  '.next',
  'build',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.turbo',
  'data',
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'Photos Library.photoslibrary',
  'Downloads',
  '.Trash',
  '.npm',
  '.cargo',
  '.rustup',
  '.local',
  '.docker',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.android',
  '.nvm',
  '.gem',
  '.nuget',
  'target',
  'vendor',
  'venv',
  '.venv',
])

let cachedWorkspaceFiles = null
let lastWorkspaceScanTime = 0

function getWorkspaceFiles() {
  const now = Date.now()
  if (cachedWorkspaceFiles && now - lastWorkspaceScanTime < 4000) {
    return cachedWorkspaceFiles
  }
  const files = []
  const maxFiles = 2500
  const root = process.cwd()

  function walk(dir, relPrefix = '') {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) return
      const name = ent.name
      if (name.startsWith('.') && name !== '.gitignore' && name !== '.env.example' && name !== '.env.dev') continue
      if (IGNORED_SCAN_DIRS.has(name)) continue
      const relPath = relPrefix ? `${relPrefix}/${name}` : name
      if (ent.isDirectory()) {
        walk(join(dir, name), relPath)
      } else {
        files.push(relPath)
      }
    }
  }

  walk(root)
  cachedWorkspaceFiles = files
  lastWorkspaceScanTime = now
  return files
}

function formatUsd(usd) {
  const n = Number(usd) || 0
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
}

export function formatSpacedTokens(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0))
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function formatCompactCap(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n >= 1_000_000_000) return `${+(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`
  return String(Math.floor(n))
}

export function formatPlanQuota(account) {
  if (!account) return 'Free · 0/0'
  const sub = account.subscription
  if (sub) {
    const used = formatSpacedTokens(sub.tokensUsed ?? 0)
    const total = sub.unlimited ? '∞' : formatCompactCap(sub.tokenLimit ?? 0)
    return `${sub.label} · ${used}/${total}`
  }
  const access = account.access || {}
  const used = formatSpacedTokens(access.used ?? 0)
  const total = formatCompactCap(access.limit ?? 0)
  return `Free · ${used}/${total}`
}

function printAccount(account) {
  if (!account) return
  process.stderr.write(
    `Account:      ${account.user.email}\n` +
    `Balance:      ${formatUsd(account.balanceUsd)}\n` +
    `Plan:         ${formatPlanQuota(account)}\n`,
  )
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

async function postOAuth(path, body) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { ...CLI_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, src: CLI_SRC }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`)
    err.code = data.error
    throw err
  }
  return data
}

function saveTokenResponse(tokens) {
  writeSecretJson(authFile(), {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    account: tokens.account ?? null,
  })
}

async function ensureAccessToken() {
  const auth = loadAuth()
  if (!auth?.accessToken) throw new Error('Not signed in. Run `apinex login`.')
  if (auth.expiresAt && Date.now() < auth.expiresAt - 30_000) return auth.accessToken
  if (!auth.refreshToken) throw new Error('Session expired. Run `apinex login`.')
  try {
    const refreshed = await postOAuth('/api/cli/oauth/token', {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: auth.refreshToken,
    })
    saveTokenResponse(refreshed)
    return refreshed.access_token
  } catch (err) {
    if (existsSync(authFile())) {
      try { rmSync(authFile(), { force: true }) } catch { /* ignore */ }
    }
    throw new Error(`Session expired (${err.message}). Run \`apinex login\` to sign in again.`)
  }
}

async function refreshModels(token) {
  const headers = { ...CLI_HEADERS, Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_ORIGIN}/api/public/models`, { headers })
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  const models = Array.isArray(data.models)
    ? data.models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow || '128K',
        dollarsPer1M: m.dollarsPer1M,
        outputDollarsPer1M: m.outputDollarsPer1M,
        health: m.health,
      }))
    : []
  if (models.length) {
    writeSecretJson(modelsFile(), { updatedAt: Date.now(), models })
  }
  return models
}

async function cachedOrLiveModels(force = false) {
  const cached = readJson(modelsFile(), null)
  if (!force && cached?.models?.length && Date.now() - cached.updatedAt < MODEL_TTL_MS) {
    return cached.models
  }
  return refreshModels().catch(() => cached?.models ?? [])
}

async function loginBrowser({ silent = false } = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get('error')
      const gotState = url.searchParams.get('state')
      const gotCode = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;background:#111113;color:#f0efed;display:grid;place-items:center;height:90vh"><div>APInex CLI connected. You can close this tab.</div></body>')
      server.close()
      if (err) reject(new Error(err))
      else if (gotState !== state || !gotCode) reject(new Error('Invalid OAuth callback state'))
      else resolve({ code: gotCode, redirectUri: `http://127.0.0.1:${port}/callback` })
    })
    let port = 0
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Login timed out. Run `apinex login --device` for headless login.'))
    }, 180_000)
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      const redirectUri = `http://127.0.0.1:${port}/callback`
      const url = new URL('/cli/connect', SITE_ORIGIN)
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      if (!silent) process.stderr.write(`Opening browser to sign in:\n${url}\n\n`)
      openBrowser(url.toString())
    })
    server.on('close', () => clearTimeout(timer))
  })

  const tokens = await postOAuth('/api/cli/oauth/token', {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: code.code,
    code_verifier: verifier,
    redirect_uri: code.redirectUri,
  })
  saveTokenResponse(tokens)
  await refreshModels(tokens.access_token)
  if (!silent) printAccount(tokens.account)
  return tokens.account
}

async function loginDevice() {
  const start = await postOAuth('/api/cli/oauth/device', { client_id: CLIENT_ID })
  process.stderr.write(
    `Open: ${start.verification_uri_complete}\nCode: ${start.user_code}\nWaiting for approval...\n`,
  )
  openBrowser(start.verification_uri_complete)
  const deadline = Date.now() + Number(start.expires_in || 900) * 1000
  let waitSec = Number(start.interval || 5)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitSec * 1000))
    try {
      const tokens = await postOAuth('/api/cli/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: start.device_code,
      })
      saveTokenResponse(tokens)
      await refreshModels(tokens.access_token)
      printAccount(tokens.account)
      return tokens.account
    } catch (err) {
      if (err.code === 'authorization_pending') continue
      if (err.code === 'slow_down') { waitSec += 5; continue }
      throw err
    }
  }
  throw new Error('Device code expired')
}

async function fetchAccount() {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/account`, {
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  const auth = loadAuth()
  if (auth) writeSecretJson(authFile(), { ...auth, account: data.account })
  return data.account
}

async function fetchBillingOptions() {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/billing/options`, {
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function createTopupInvoice(amountDollars) {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/billing/topup`, {
    method: 'POST',
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ amountDollars, src: CLI_SRC }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function createSubscriptionInvoice(planKey) {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/billing/subscription`, {
    method: 'POST',
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ planKey, src: CLI_SRC }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function createRpmInvoice(planKey) {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/billing/rpm`, {
    method: 'POST',
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ planKey, src: CLI_SRC }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function checkPaymentStatus(type, paymentId) {
  const token = await ensureAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/cli/billing/check-payment?type=${encodeURIComponent(type)}&paymentId=${encodeURIComponent(paymentId)}&src=${CLI_SRC}`, {
    headers: { ...CLI_HEADERS, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

// -------------------------------------------------------------
// AGENT TOOLS DEFINITION
// -------------------------------------------------------------
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path' },
          content: { type: 'string', description: 'Complete content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an existing block of text inside a file with new text',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_str: { type: 'string', description: 'Exact string to find and replace' },
          new_str: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Fast text or regex search across project files with line numbers',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (defaults to .)' },
          case_sensitive: { type: 'boolean', description: 'Whether search is case-sensitive' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files matching a glob or substring pattern in the workspace',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename or glob pattern (e.g. *.ts, Header, test*)' },
          directory: { type: 'string', description: 'Directory to search in (defaults to .)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for documentation, error solutions, current versions, APIs, or real-time information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords or question to look up online' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and parse the readable markdown/text content of any URL or documentation link',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute HTTP/HTTPS URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash shell command (e.g. curl, rm, git, ls, npm)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command line to execute' },
        },
        required: ['command'],
      },
    },
  },
]

function sendOsNotification({ title = 'APInex CLI', message = '', sound = 'Glass' } = {}) {
  try {
    process.stdout.write('\x07')
  } catch { /* ignore */ }

  try {
    if (process.platform === 'darwin') {
      const soundClause = sound ? ` sound name "${sound}"` : ''
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${soundClause}`
      const p = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true })
      p.unref()
    } else if (process.platform === 'linux') {
      const p = spawn('notify-send', ['-a', title, title, message], { stdio: 'ignore', detached: true })
      p.unref()
    } else if (process.platform === 'win32') {
      const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $n = $t.GetElementsByTagName('text'); $n.Item(0).AppendChild($t.CreateTextNode(${JSON.stringify(title)})) | Out-Null; $n.Item(1).AppendChild($t.CreateTextNode(${JSON.stringify(message)})) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('APInex').Show([Windows.UI.Notifications.ToastNotification]::new($t))`
      const p = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', detached: true })
      p.unref()
    }
  } catch {
    /* notifications must never throw */
  }
}

function resolveSafePath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

async function toolGrepSearch({ query, path: searchPath, case_sensitive }) {
  if (!query) throw new Error('Query parameter is required')
  const root = searchPath ? resolveSafePath(searchPath) : process.cwd()
  if (!existsSync(root)) throw new Error(`Path not found: ${searchPath}`)

  const flags = case_sensitive ? 'g' : 'gi'
  let regex
  try {
    regex = new RegExp(query, flags)
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }

  const results = []
  const maxMatches = 60
  const maxFilesToScan = 2000
  const maxDepth = 6
  const deadline = Date.now() + 3500 // 3.5s hard time budget
  let filesScanned = 0

  const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz',
    '.sqlite', '.sqlite-wal', '.bin', '.exe', '.woff', '.woff2', '.ttf', '.eot',
    '.mp4', '.mov', '.mp3', '.wav', '.dmg', '.pkg', '.dylib', '.so', '.a', '.o',
  ])

  function searchInFile(filePath) {
    if (results.length >= maxMatches || filesScanned >= maxFilesToScan || Date.now() > deadline) return
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    if (BINARY_EXTS.has(`.${ext}`)) return
    try {
      const st = statSync(filePath)
      if (st.size > 1024 * 1024) return // Skip files > 1MB
    } catch {
      return
    }
    filesScanned += 1
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      return
    }
    const rel = relative(process.cwd(), filePath)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (results.length >= maxMatches) break
      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`)
      }
    }
  }

  async function walk(dir, depth = 0) {
    if (results.length >= maxMatches || filesScanned >= maxFilesToScan || Date.now() > deadline || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (results.length >= maxMatches || filesScanned >= maxFilesToScan || Date.now() > deadline) break
      const name = ent.name
      if (name.startsWith('.') && name !== '.env.example' && name !== '.env.dev') continue
      if (IGNORED_SCAN_DIRS.has(name)) continue
      const full = join(dir, name)
      if (ent.isDirectory()) {
        if (filesScanned % 60 === 0) {
          // Non-blocking cooperative yield to keep event loop and UI alive
          await new Promise((r) => setImmediate(r))
        }
        await walk(full, depth + 1)
      } else {
        searchInFile(full)
      }
    }
  }

  const stat = statSync(root)
  if (stat.isDirectory()) {
    await walk(root, 0)
  } else {
    searchInFile(root)
  }

  const output = results.length > 0 ? results.join('\n') : `No matches found for "${query}" (scanned ${filesScanned} files)`
  return {
    output,
    meta: {
      type: 'grep',
      query,
      matchCount: results.length,
      preview: results.slice(0, 6),
    },
  }
}

async function toolFindFiles({ pattern, directory }) {
  if (!pattern) throw new Error('Pattern parameter is required')
  const root = directory ? resolveSafePath(directory) : process.cwd()
  if (!existsSync(root)) throw new Error(`Directory not found: ${directory}`)

  const pat = pattern.toLowerCase()
  const results = []
  const maxMatches = 80
  const maxDepth = 6
  const deadline = Date.now() + 3500 // 3.5s hard time budget
  let count = 0

  async function walk(dir, depth = 0) {
    if (results.length >= maxMatches || count >= 2500 || Date.now() > deadline || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (results.length >= maxMatches || count >= 2500 || Date.now() > deadline) break
      count += 1
      const name = ent.name
      if (name.startsWith('.') && name !== '.env.example' && name !== '.env.dev') continue
      if (IGNORED_SCAN_DIRS.has(name)) continue
      const full = join(dir, name)
      const rel = relative(process.cwd(), full)
      if (ent.isDirectory()) {
        if (rel.toLowerCase().includes(pat) || name.toLowerCase().includes(pat)) {
          results.push(`${rel}/`)
        }
        if (count % 80 === 0) {
          await new Promise((r) => setImmediate(r))
        }
        await walk(full, depth + 1)
      } else {
        if (rel.toLowerCase().includes(pat) || name.toLowerCase().includes(pat)) {
          results.push(rel)
        }
      }
    }
  }

  const stat = statSync(root)
  if (stat.isDirectory()) {
    await walk(root, 0)
  } else {
    const rel = relative(process.cwd(), root)
    if (rel.toLowerCase().includes(pat)) results.push(rel)
  }

  const output = results.length > 0 ? results.join('\n') : `No files found matching "${pattern}"`
  return {
    output,
    meta: {
      type: 'find',
      pattern,
      fileCount: results.length,
      preview: results.slice(0, 8),
    },
  }
}

async function executeTool(name, args, { requestPermission } = {}) {
  if (name === 'write_file') {
    const target = resolveSafePath(args.path)
    const content = String(args.content ?? '')
    const exists = existsSync(target)
    let oldContent = ''
    if (exists) {
      try { oldContent = readFileSync(target, 'utf8') } catch { /* ignore */ }
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    const linesCount = content.split('\n').length
    return {
      output: `Wrote ${linesCount} lines to ${args.path}`,
      meta: {
        type: exists ? 'update' : 'write',
        path: args.path,
        oldContent: exists ? oldContent : null,
        newContent: content,
        linesCount,
      },
    }
  }

  if (name === 'edit_file') {
    const target = resolveSafePath(args.path)
    if (!existsSync(target)) throw new Error(`File not found: ${args.path}`)
    const oldContent = readFileSync(target, 'utf8')
    const oldStr = String(args.old_str ?? '')
    const newStr = String(args.new_str ?? '')
    if (!oldStr) throw new Error('old_str cannot be empty')
    let newContent
    if (oldContent.includes(oldStr)) {
      newContent = oldContent.replace(oldStr, newStr)
    } else {
      const normFile = oldContent.replace(/\r\n/g, '\n')
      const normOld = oldStr.replace(/\r\n/g, '\n')
      if (normFile.includes(normOld)) {
        newContent = normFile.replace(normOld, newStr.replace(/\r\n/g, '\n'))
      } else {
        throw new Error(`old_str not found in ${args.path}`)
      }
    }
    writeFileSync(target, newContent, 'utf8')
    return {
      output: `Updated ${args.path}`,
      meta: {
        type: 'update',
        path: args.path,
        oldContent,
        newContent,
        replacedOld: oldStr,
        replacedNew: newStr,
      },
    }
  }

  if (name === 'read_file') {
    const target = resolveSafePath(args.path)
    if (!existsSync(target)) throw new Error(`File not found: ${args.path}`)
    const content = readFileSync(target, 'utf8')
    return {
      output: content,
      meta: { type: 'read', path: args.path, lines: content.split('\n').length },
    }
  }

  if (name === 'grep_search') {
    return await toolGrepSearch(args)
  }

  if (name === 'find_files') {
    return await toolFindFiles(args)
  }

  if (name === 'web_search') {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('query is required')
    const token = await ensureAccessToken()
    try {
      const res = await fetch(`${API_ORIGIN}/v1/tools/web/search`, {
        method: 'POST',
        headers: {
          ...CLI_HEADERS,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, count: 6, src: CLI_SRC }),
      })
      if (res.ok) {
        const data = await res.json()
        const items = data.results?.web || []
        if (items.length > 0) {
          const formatted = items.map((it, idx) => `[${idx + 1}] ${it.title}\nURL: ${it.url}\n${it.description || ''}`).join('\n\n')
          return {
            output: formatted,
            meta: { type: 'web_search', query, count: items.length },
          }
        }
      }
    } catch { /* fall through to search fallback */ }

    try {
      const encoded = encodeURIComponent(query)
      const raw = execSync(`curl -sL --max-time 8 "https://html.duckduckgo.com/html/?q=${encoded}" -A "Mozilla/5.0"`, { encoding: 'utf8' })
      const matches = [...raw.matchAll(/<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
      if (matches.length > 0) {
        const items = matches.slice(0, 5).map((m, idx) => {
          const url = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '')
          const snippet = m[3].replace(/<[^>]+>/g, '').trim()
          return `[${idx + 1}] Result\nURL: ${decodeURIComponent(url)}\n${snippet}`
        })
        return {
          output: items.join('\n\n'),
          meta: { type: 'web_search', query, count: items.length },
        }
      }
    } catch { /* ignore */ }

    return { output: `No search results found for "${query}"`, meta: { type: 'web_search', query, count: 0 } }
  }

  if (name === 'web_fetch') {
    const url = String(args.url ?? '').trim()
    if (!url) throw new Error('url is required')
    const token = await ensureAccessToken()
    try {
      const res = await fetch(`${API_ORIGIN}/v1/tools/web/contents`, {
        method: 'POST',
        headers: {
          ...CLI_HEADERS,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls: [url], src: CLI_SRC }),
      })
      if (res.ok) {
        const data = await res.json()
        const item = data.results?.[0]
        if (item) {
          const title = item.title || url
          const content = item.markdown || item.text || ''
          return {
            output: `# ${title}\n\n${content.slice(0, 15_000)}`,
            meta: { type: 'web_fetch', url, title, chars: content.length },
          }
        }
      }
    } catch { /* fall through to fetch fallback */ }

    try {
      const raw = execFileSync('curl', ['-sL', '--max-time', '10', url, '-A', 'Mozilla/5.0'], { encoding: 'utf8' })
      const text = raw.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        output: text.slice(0, 15_000) || '(empty page)',
        meta: { type: 'web_fetch', url, chars: text.length },
      }
    } catch (err) {
      throw new Error(`Failed to fetch ${url}: ${err.message}`)
    }
  }

  if (name === 'bash') {
    const cmd = String(args.command ?? '')
    if (requestPermission) {
      await requestPermission(cmd)
    }
    try {
      const out = execSync(cmd, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      })
      return { output: out.trim() || '(no output)', meta: { type: 'bash', cmd, out: out.trim() } }
    } catch (err) {
      const combined = (err.stdout ? String(err.stdout) : '') + (err.stderr ? String(err.stderr) : '')
      const msg = combined.trim() || err.message
      return { output: `Command failed: ${msg}`, isError: true, meta: { type: 'bash', cmd, out: msg, error: true } }
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}

// -------------------------------------------------------------
// STREAMING & API CALLS
// -------------------------------------------------------------
async function streamChatTurn({ model, messages, tools, signal, onDelta }) {
  const token = await ensureAccessToken()
  const payload = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    src: CLI_SRC,
  }
  if (tools?.length) payload.tools = tools

  const res = await fetch(`${API_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...CLI_HEADERS,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`)
  }

  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let usage = null
  const toolCallsMap = new Map()

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const dataStr = line.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      let parsed
      try {
        parsed = JSON.parse(dataStr)
      } catch {
        continue
      }
      if (parsed.usage) {
        usage = parsed.usage
      }
      if (parsed.error?.message) throw new Error(parsed.error.message)
      const delta = parsed.choices?.[0]?.delta
      if (!delta) continue

      if (delta.content) {
        content += delta.content
        if (typeof onDelta === 'function') {
          onDelta({ type: 'content', delta: delta.content })
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || `call_${idx}`,
              name: tc.function?.name || '',
              arguments: '',
            })
          }
          const existing = toolCallsMap.get(idx)
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name = tc.function.name
          if (tc.function?.arguments) existing.arguments += tc.function.arguments
        }
      }
    }
  }

  const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
    let parsedArgs = {}
    try {
      parsedArgs = JSON.parse(tc.arguments)
    } catch {
      parsedArgs = { raw: tc.arguments }
    }
    return {
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(parsedArgs) },
      name: tc.name,
      args: parsedArgs,
    }
  })

  return { content, toolCalls, usage }
}

async function streamPrompt({ model, system, prompt }) {
  const messages = []
  const sys = system !== undefined ? system : getAgentSystemPrompt()
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push({ role: 'user', content: prompt })
  await streamChatTurn({
    model,
    messages,
    onDelta: (d) => {
      if (d.type === 'content') process.stdout.write(d.delta)
    },
  })
  process.stdout.write('\n')
}

function wrapText(text, maxWidth) {
  const width = Math.max(20, maxWidth)
  const out = []
  for (const rawLine of String(text ?? '').split('\n')) {
    if (stripAnsi(rawLine).length <= width) {
      out.push(rawLine)
      continue
    }
    let curLine = ''
    let curVisWidth = 0
    let i = 0
    const CSI_RE = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`)
    while (i < rawLine.length) {
      if (rawLine[i] === '\x1b' && rawLine[i + 1] === '[') {
        const m = rawLine.slice(i).match(CSI_RE)
        if (m) {
          curLine += m[0]
          i += m[0].length
          continue
        }
      }
      curLine += rawLine[i]
      curVisWidth += 1
      i += 1
      if (curVisWidth >= width && i < rawLine.length) {
        out.push(curLine + C.reset)
        curLine = ''
        curVisWidth = 0
      }
    }
    if (curLine) out.push(curLine)
  }
  return out
}

// -------------------------------------------------------------
// BEAUTIFUL TOOL & DIFF FORMATTING (CLAUDE CODE STYLE)
// -------------------------------------------------------------
function renderDiff(meta, maxCols) {
  const lines = []
  const width = Math.max(40, maxCols - 6)

  if (meta.type === 'write') {
    lines.push(`  ${C.cyan}◆ Tool: ${C.bold}write_file${C.reset}${C.gray}(${meta.path})${C.reset} · ${C.green}+${meta.linesCount} lines${C.reset}`)
    const preview = (meta.newContent || '').split('\n').slice(0, 5)
    preview.forEach((ln, idx) => {
      lines.push(`      ${C.dim}${(idx + 1).toString().padStart(3)} |${C.reset} ${ln}`)
    })
    if (meta.linesCount > 5) {
      lines.push(`      ${C.dim}... (${meta.linesCount - 5} more lines)${C.reset}`)
    }
    return lines
  }

  if (meta.type === 'update') {
    const diff = computeLineDiff(meta.oldContent ?? '', meta.newContent ?? '')
    const added = diff.filter((d) => d.type === 'add').length
    const removed = diff.filter((d) => d.type === 'del').length
    const addStr = added > 0 ? ` ${C.green}+${added} lines${C.reset}` : ''
    const delStr = removed > 0 ? ` ${C.red}-${removed} lines${C.reset}` : ''
    lines.push(`  ${C.cyan}◆ Tool: ${C.bold}edit_file${C.reset}${C.gray}(${meta.path})${C.reset} ·${addStr}${delStr}`)

    const changedOnly = []
    let inHunk = false
    for (let i = 0; i < diff.length; i += 1) {
      const item = diff[i]
      if (item.type !== 'same') {
        // Grab 1 leading context line if available
        if (!inHunk && i > 0 && diff[i - 1].type === 'same') {
          changedOnly.push(diff[i - 1])
        }
        changedOnly.push(item)
        inHunk = true
        // Grab 1 trailing context line
        if (i + 1 < diff.length && diff[i + 1].type === 'same') {
          changedOnly.push(diff[i + 1])
        }
      } else {
        inHunk = false
      }
    }

    const itemsToRender = changedOnly.length ? changedOnly : diff.slice(0, 10)
    itemsToRender.forEach((d) => {
      if (d.type === 'same') {
        lines.push(`        ${C.gray}${d.line}${C.reset}`)
      } else if (d.type === 'del') {
        lines.push(`      ${C.redBg} - ${d.line.padEnd(width - 8)} ${C.reset}`)
      } else if (d.type === 'add') {
        lines.push(`      ${C.greenBg} + ${d.line.padEnd(width - 8)} ${C.reset}`)
      }
    })
    return lines
  }

  if (meta.type === 'bash') {
    const isErr = meta.error
    const icon = isErr ? `${C.red}✕` : `${C.yellow}◆`
    lines.push(`  ${icon} Tool: ${C.bold}bash${C.reset}${C.gray}(${meta.cmd})${C.reset}`)
    if (meta.out) {
      const outLines = meta.out.split('\n').slice(0, 8)
      outLines.forEach((l) => lines.push(`    ${C.dim}│${C.reset} ${l}`))
    }
    return lines
  }

  if (meta.type === 'read') {
    lines.push(`  ${C.gray}◆ Tool: ${C.bold}read_file${C.reset}${C.gray}(${meta.path}) · ${meta.lines} lines${C.reset}`)
    return lines
  }

  if (meta.type === 'grep') {
    lines.push(`  ${C.yellow}◆ Tool: ${C.bold}grep_search${C.reset}${C.gray}("${meta.query}") · ${meta.matchCount} matches${C.reset}`)
    if (meta.preview?.length) {
      meta.preview.forEach((l) => lines.push(`    ${C.dim}│${C.reset} ${l}`))
    }
    return lines
  }

  if (meta.type === 'find') {
    lines.push(`  ${C.cyan}◆ Tool: ${C.bold}find_files${C.reset}${C.gray}("${meta.pattern}") · ${meta.fileCount} files${C.reset}`)
    if (meta.preview?.length) {
      meta.preview.forEach((l) => lines.push(`    ${C.dim}│${C.reset} ${l}`))
    }
    return lines
  }

  if (meta.type === 'web_search') {
    lines.push(`  ${C.blue}🌐 Tool: ${C.bold}web_search${C.reset}${C.gray}("${meta.query}") · ${meta.count || 0} results${C.reset}`)
    return lines
  }

  if (meta.type === 'web_fetch') {
    lines.push(`  ${C.blue}🌐 Tool: ${C.bold}web_fetch${C.reset}${C.gray}(${meta.url})${C.reset}`)
    return lines
  }

  return lines
}

// -------------------------------------------------------------
// INTERACTIVE TUI WITH MULTI-LINE INPUT & AGENTIC LOOP
// -------------------------------------------------------------
async function startInteractiveTui(initialModel, { resumeSession, pickResume } = {}) {
  let auth = loadAuth()
  let account = null
  if (!auth?.accessToken) {
    process.stderr.write('Signing in via browser…\n')
    account = await loginBrowser({ silent: true })
  } else {
    account = await fetchAccount().catch(() => auth?.account ?? null)
  }

  let models = await cachedOrLiveModels(false)
  let currentModel = initialModel || loadCfg().defaultModel || 'deepseek-v4-flash'
  if (models.length && !models.some((m) => m.id === currentModel)) {
    const fallback = models.find((m) => m.id === 'deepseek-v4-flash') || models[0]
    if (fallback) {
      currentModel = fallback.id
      saveCfg({ defaultModel: currentModel })
    }
  }

  // Trigger non-blocking update check in background with live callback
  let availableUpdate = loadCachedUpdate()
  triggerBackgroundUpdateCheck((info) => {
    availableUpdate = info
    const tag = info.critical ? '⚠️ Critical update required: ' : '💡 Update available: '
    transcript.push({
      role: 'notice',
      text: `${tag}v${VERSION} → v${info.latestVersion}\n   ${info.changelog ? "What's new: " + info.changelog + '\n   ' : ''}Type /update or run "apinex update" in your shell to upgrade.`,
    })
    showNotice(`${tag}v${info.latestVersion}! Type /update to upgrade`, 6000)
    renderScreen()
  })

  let sessionId = (resumeSession && resumeSession !== 'last') ? resumeSession : randomUUID()
  const history = []
  const transcript = []

  if (availableUpdate?.hasUpdate) {
    const tag = availableUpdate.critical ? '⚠️ Critical update required: ' : '💡 Update available: '
    transcript.push({
      role: 'notice',
      text: `${tag}v${VERSION} → v${availableUpdate.latestVersion}\n   ${availableUpdate.changelog ? "What's new: " + availableUpdate.changelog + '\n   ' : ''}Type /update or run "apinex update" in your shell to upgrade.`,
    })
  }

  // Check and announce project rules memory file (APINEX.md / CLAUDE.md / .apinexrules)
  const initialRules = loadProjectRules()
  if (initialRules) {
    transcript.push({
      role: 'notice',
      text: `✓ Loaded project rules from ${initialRules.file}`,
    })
  }
  const promptHistory = []
  const promptQueue = []
  const imagesStore = []
  let historyIndex = -1
  let isBrowsingHistory = false
  let stashInput = ''
  let input = ''
  let cursor = 0
  let mode = 'chat' // 'chat' | 'model-picker' | 'streaming' | 'permission-prompt'
  let slashIndex = 0
  let atFileIndex = 0
  let modelIndex = 0
  let modelFilter = ''
  let statusNotice = ''
  let statusNoticeTimer = null
  let scrollOffset = 0
  let lastRenderedLines = []
  let mouseDragStart = null
  let isMouseDragging = false
  let selectionRange = null
  let alwaysAllowDestructive = false
  let pendingPermission = null
  let sessionContextTokens = 0
  let isStreaming = false
  let isExecutingQueue = false
  let toolActionPhrase = null

  const getActiveActionPhrase = () => {
    if (toolActionPhrase) return toolActionPhrase
    const idx = Math.floor(spinnerTick / 16) % FUN_THINKING_PHRASES.length
    return FUN_THINKING_PHRASES[idx]
  }

  let sessionIndex = 0
  let sessionFilter = ''
  let savedSessionsList = []

  let billingData = null
  let topupIndex = 1
  let subscriptionIndex = 0
  let rpmIndex = 0
  const activePollers = new Map()

  const startPaymentPoller = (type, paymentId, desc) => {
    if (activePollers.has(paymentId)) return
    const interval = setInterval(async () => {
      try {
        const st = await checkPaymentStatus(type, paymentId)
        if (st.credited || st.status === 'finished') {
          clearInterval(interval)
          activePollers.delete(paymentId)
          try { process.stdout.write('\x07') } catch {}
          sendOsNotification({
            title: 'APInex · Payment Confirmed!',
            message: `${desc} credited to your account!`,
            sound: 'Glass',
          })
          transcript.push({
            role: 'notice',
            text: `✓ Payment confirmed! ${desc} has been credited to your account.`,
          })
          fetchAccount().then((fresh) => {
            account = fresh
            renderScreen()
          }).catch(() => undefined)
          showNotice(`✓ Payment confirmed: ${desc}`, 4000)
        } else if (st.status === 'failed' || st.status === 'expired') {
          clearInterval(interval)
          activePollers.delete(paymentId)
          transcript.push({
            role: 'error',
            text: `Payment ${paymentId} expired or failed.`,
          })
          renderScreen()
        }
      } catch {
        /* keep polling */
      }
    }, 3500)
    activePollers.set(paymentId, interval)
  }

  const executeTopupPayment = async (amountDollars) => {
    mode = 'chat'
    statusNotice = `Creating invoice for $${amountDollars}…`
    renderScreen()
    try {
      const invoice = await createTopupInvoice(amountDollars)
      openBrowser(invoice.invoiceUrl)
      const q = invoice.quote
      const bonusPct = q?.bonusPct || 0
      const bonusUsd = bonusPct > 0 ? Number(((amountDollars * bonusPct) / 100).toFixed(2)) : 0
      const totalCreditUsd = Number((amountDollars + bonusUsd).toFixed(2))
      const bonusText = bonusUsd > 0 ? ` (+${bonusPct}% bonus: +$${bonusUsd.toFixed(2)})` : ''
      transcript.push({
        role: 'notice',
        text: `💳 Top-Up Invoice: $${amountDollars}.00 → +$${totalCreditUsd.toFixed(2)} balance${bonusText}\n   Opening NowPayments: ${invoice.invoiceUrl}\n   Complete payment in your browser. Live balance will auto-credit as soon as confirmed!`,
      })
      showNotice(`Opened NowPayments invoice for $${amountDollars}`, 3500)
      startPaymentPoller('topup', invoice.paymentId, `+$${totalCreditUsd.toFixed(2)} balance top-up`)
    } catch (err) {
      transcript.push({ role: 'error', text: `Failed to create top-up invoice: ${err.message}` })
      statusNotice = ''
      renderScreen()
    }
  }

  const executeSubscriptionPayment = async (planKey) => {
    mode = 'chat'
    statusNotice = `Creating subscription invoice…`
    renderScreen()
    try {
      const invoice = await createSubscriptionInvoice(planKey)
      openBrowser(invoice.invoiceUrl)
      const tokensDesc = invoice.tokenLimit ? ` (${formatCompactCap(invoice.tokenLimit)} tokens)` : ' (Unlimited)'
      transcript.push({
        role: 'notice',
        text: `💳 Subscription Invoice: ${invoice.planLabel || planKey}${tokensDesc} for $${invoice.amountUsd}\n   Opening NowPayments: ${invoice.invoiceUrl}\n   Complete payment in your browser. Subscription will activate automatically!`,
      })
      showNotice(`Opened subscription invoice: $${invoice.amountUsd}`, 3500)
      startPaymentPoller('subscription', invoice.paymentId, `Subscription: ${invoice.planLabel || planKey}${tokensDesc}`)
    } catch (err) {
      transcript.push({ role: 'error', text: `Failed to create subscription invoice: ${err.message}` })
      statusNotice = ''
      renderScreen()
    }
  }

  const executeRpmPayment = async (planKey) => {
    mode = 'chat'
    statusNotice = `Creating RPM invoice…`
    renderScreen()
    try {
      const invoice = await createRpmInvoice(planKey)
      openBrowser(invoice.invoiceUrl)
      transcript.push({
        role: 'notice',
        text: `💳 RPM Upgrade Invoice: ${invoice.rpm} RPM for $${invoice.priceUsd} (30 days)\n   Opening NowPayments: ${invoice.invoiceUrl}\n   Complete payment in your browser. RPM limit will upgrade automatically!`,
      })
      showNotice(`Opened RPM invoice: ${invoice.rpm} RPM`, 3500)
      startPaymentPoller('rpm', invoice.paymentId, `${invoice.rpm} RPM upgrade`)
    } catch (err) {
      transcript.push({ role: 'error', text: `Failed to create RPM invoice: ${err.message}` })
      statusNotice = ''
      renderScreen()
    }
  }

  const openTopupPicker = async (preselectedAmount = null) => {
    if (preselectedAmount && [5, 10, 20, 50].includes(Number(preselectedAmount))) {
      await executeTopupPayment(Number(preselectedAmount))
      return
    }
    statusNotice = 'Loading top-up options…'
    renderScreen()
    try {
      billingData = await fetchBillingOptions()
      mode = 'topup-picker'
      topupIndex = 1 // default select $10
      statusNotice = ''
      renderScreen()
    } catch (err) {
      showNotice(`Failed to load top-up options: ${err.message}`, 3000)
    }
  }

  const openSubscriptionPicker = async (preselectedPlan = null) => {
    statusNotice = 'Loading subscription plans…'
    renderScreen()
    try {
      billingData = await fetchBillingOptions()
      if (preselectedPlan) {
        const norm = preselectedPlan.toLowerCase().replace(/[^a-z0-9_]/g, '')
        const found = billingData?.subscriptions?.plans?.find(
          (p) => p.key === norm || p.label.toLowerCase().includes(norm) || (norm === '10' && p.key === 'day10') || (norm === '20' && p.key === 'day20') || (norm === '30' && p.key === 'day30_standard')
        )
        if (found) {
          await executeSubscriptionPayment(found.key)
          return
        }
      }
      mode = 'subscription-picker'
      subscriptionIndex = 0
      statusNotice = ''
      renderScreen()
    } catch (err) {
      showNotice(`Failed to load subscriptions: ${err.message}`, 3000)
    }
  }

  const openRpmPicker = async (preselectedRpm = null) => {
    statusNotice = 'Loading RPM rate plans…'
    renderScreen()
    try {
      billingData = await fetchBillingOptions()
      if (preselectedRpm) {
        const norm = String(preselectedRpm).toLowerCase().replace(/[^a-z0-9]/g, '')
        const found = billingData?.rpm?.plans?.find((p) => p.key === norm || String(p.rpm) === norm)
        if (found) {
          await executeRpmPayment(found.key)
          return
        }
      }
      mode = 'rpm-picker'
      rpmIndex = 0
      statusNotice = ''
      renderScreen()
    } catch (err) {
      showNotice(`Failed to load RPM plans: ${err.message}`, 3000)
    }
  }

  const openSessionPicker = () => {
    savedSessionsList = listSavedSessions()
    mode = 'session-picker'
    sessionIndex = 0
    sessionFilter = ''
    renderScreen()
  }

  const loadSessionIntoState = (id) => {
    const loaded = loadSessionFile(id)
    if (loaded) {
      history.length = 0
      transcript.length = 0
      promptHistory.length = 0
      if (Array.isArray(loaded.history)) history.push(...loaded.history)
      if (Array.isArray(loaded.transcript)) transcript.push(...loaded.transcript)
      if (Array.isArray(loaded.promptHistory)) promptHistory.push(...loaded.promptHistory)
      if (loaded.model) currentModel = loaded.model
      if (loaded.sessionId) sessionId = loaded.sessionId
      sessionContextTokens = estimateTokens(history)
      showNotice(`✓ Resumed session (${history.length} turns)`, 2500)
    } else {
      showNotice(`Session not found: ${id}`, 2500)
    }
  }

  const showNotice = (msg, ms = 2000) => {
    statusNotice = msg
    renderScreen()
    if (statusNoticeTimer) clearTimeout(statusNoticeTimer)
    statusNoticeTimer = setTimeout(() => {
      if (statusNotice === msg) {
        statusNotice = ''
        renderScreen()
      }
    }, ms)
  }
  let abortController = null
  let spinnerTick = 0
  let spinnerTimer = null
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  const matchingSlash = () => {
    if (isBrowsingHistory || !input.startsWith('/')) return []
    const q = input.trim().toLowerCase()
    return SLASH_COMMANDS.filter((item) => item.cmd.startsWith(q))
  }

  const getAtQuery = () => {
    if (isBrowsingHistory || mode !== 'chat') return null
    const beforeCursor = input.slice(0, cursor)
    const match = beforeCursor.match(/@([^\s]*)$/)
    if (!match) return null
    return {
      query: match[1].toLowerCase(),
      matchIndex: match.index,
      raw: match[0],
    }
  }

  const matchingAtFiles = () => {
    const at = getAtQuery()
    if (!at) return []
    const all = getWorkspaceFiles()
    const q = at.query
    if (!q) return all.slice(0, 8)
    return all.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }

  const requestPermission = (cmd) => {
    if (alwaysAllowDestructive) return Promise.resolve(true)
    const DESTRUCTIVE_CMD_RE = /(?:^|[;&|]\s*|\b)(rm\s+|rmdir\b|unlink\s+|shred\s+|del\s+|erase\s+|git\s+(?:reset|clean|restore|checkout\s+--)|git\s+push\s+.*(?:--force|-f)|drop\s+(?:table|database)|kill\b|pkill\b|killall\b|truncate\s+|dd\s+)/i
    if (!DESTRUCTIVE_CMD_RE.test(cmd)) return Promise.resolve(true)

    sendOsNotification({
      title: 'APInex CLI · Approval Required',
      message: `Permission needed: ${cmd.slice(0, 80)}`,
      sound: 'Basso',
    })

    return new Promise((resolve, reject) => {
      mode = 'permission-prompt'
      pendingPermission = { cmd, resolve, reject }
      renderScreen()
    })
  }

  const filteredModels = () => {
    const q = modelFilter.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || String(m.provider || '').toLowerCase().includes(q),
    )
  }

  const renderScreen = () => {
    const cols = Math.max(50, (process.stdout.columns || 80) - 1)
    const rows = Math.max(18, process.stdout.rows || 28)
    const hr = `${C.line}${'─'.repeat(cols)}${C.reset}`

    if (mode === 'session-picker') {
      const q = sessionFilter.trim().toLowerCase()
      const list = q
        ? savedSessionsList.filter(
            (s) =>
              String(s.id || '').toLowerCase().includes(q) ||
              String(s.title || s.preview || '').toLowerCase().includes(q) ||
              String(s.model || '').toLowerCase().includes(q) ||
              String(s.cwd || '').toLowerCase().includes(q),
          )
        : savedSessionsList

      const currentIdx = list.length ? Math.max(0, Math.min(sessionIndex, list.length - 1)) : 0
      const headerText = `Resume session (${list.length ? currentIdx + 1 : 0} of ${list.length})`
      const topBar = `${C.line}─── ${C.bold}${C.white}${headerText}${C.reset} ${C.line}${'─'.repeat(Math.max(0, cols - headerText.length - 6))}${C.reset}`

      // Rounded Search Box
      const boxW = Math.max(20, cols - 4)
      const topBorder = `  ${C.line}╭${'─'.repeat(boxW - 2)}╮${C.reset}`
      const bottomBorder = `  ${C.line}╰${'─'.repeat(boxW - 2)}╯${C.reset}`
      const searchInner = sessionFilter ? sessionFilter : `${C.gray}Search...${C.reset}`
      const searchPadding = ' '.repeat(Math.max(0, boxW - 5 - stripAnsi(sessionFilter || 'Search...').length))
      const searchLine = `  ${C.line}│${C.reset} ${C.cyan}⌕${C.reset} ${searchInner}${searchPadding}${C.line}│${C.reset}`

      const projectName = basename(process.cwd()) || process.cwd()
      const projectLine = `  ${C.gray}${projectName}${C.reset}`

      const screenLines = [topBar, '', topBorder, searchLine, bottomBorder, '', projectLine, '']

      // Calculate vertical space for session items: each takes 2 lines + 1 empty line
      const itemLinesBudget = Math.max(6, rows - screenLines.length - 2)
      const itemsPerPage = Math.max(1, Math.floor(itemLinesBudget / 3))
      const start = Math.max(0, Math.min(currentIdx - Math.floor(itemsPerPage / 2), Math.max(0, list.length - itemsPerPage)))
      const visible = list.slice(start, start + itemsPerPage)

      if (!visible.length) {
        screenLines.push(`    ${C.gray}No matching sessions found${C.reset}`)
      } else {
        visible.forEach((s, idx) => {
          const real = start + idx
          const sel = real === currentIdx
          const mark = sel ? `${C.accent}❯${C.reset}` : ' '
          const title = sel ? `${C.bold}${C.white}${s.title}${C.reset}` : `${C.white}${s.title}${C.reset}`
          const timeStr = formatRelativeDate(s.savedAt)
          const metaLine = `    ${C.gray}${timeStr} · ${s.model} · ${s.size}${C.reset}`
          screenLines.push(`  ${mark} ${title}`)
          screenLines.push(metaLine)
          screenLines.push('')
        })
      }

      while (screenLines.length < rows - 1) {
        screenLines.push('')
      }

      screenLines.push(`  ${C.gray}↑/↓ navigate · Enter resume · Esc cancel · Type to search${C.reset}`)

      const finalLines = screenLines.slice(0, rows)
      while (finalLines.length < rows) finalLines.push('')
      lastRenderedLines = finalLines.slice()

      let out = '\x1b[?25l'
      for (let r = 0; r < rows; r += 1) {
        out += `\x1b[${r + 1};1H\x1b[2K${finalLines[r]}`
      }
      // Place cursor inside search box: row 4, col 7 + typed filter length
      const cursorCol = Math.min(boxW - 1, 7 + stripAnsi(sessionFilter).length)
      out += `\x1b[4;${cursorCol}H\x1b[?25h`
      process.stdout.write(out)
      return
    }

    if (mode === 'topup-picker') {
      const opts = billingData?.topup?.options || [
        { usd: 5, tokensCredit: 5000000, baseTokens: 5000000, bonusTokens: 0, bonusPct: 0 },
        { usd: 10, tokensCredit: 10000000, baseTokens: 10000000, bonusTokens: 0, bonusPct: 0 },
        { usd: 20, tokensCredit: 20000000, baseTokens: 20000000, bonusTokens: 0, bonusPct: 0 },
        { usd: 50, tokensCredit: 50000000, baseTokens: 50000000, bonusTokens: 0, bonusPct: 0 },
      ]
      const currentIdx = Math.max(0, Math.min(topupIndex, opts.length - 1))
      const headerText = `Top up USD Balance (${currentIdx + 1} of ${opts.length})`
      const topBar = `${C.line}─── ${C.bold}${C.white}${headerText}${C.reset} ${C.line}${'─'.repeat(Math.max(0, cols - headerText.length - 6))}${C.reset}`

      const screenLines = [topBar, '']
      const activePromo = billingData?.topup?.activePromo
      const nftBoost = billingData?.topup?.nftBoost
      const bonusParts = []
      if (nftBoost?.name && nftBoost?.topupBonusPct > 0) {
        bonusParts.push(`${C.gold}${nftBoost.name} (+${nftBoost.topupBonusPct}%)${C.reset}`)
      }
      if (activePromo?.bonusPercent > 0) {
        bonusParts.push(`${C.green}Promo (+${activePromo.bonusPercent}%)${C.reset}`)
      }
      if (bonusParts.length > 0) {
        screenLines.push(`  🎁 Active Bonuses: ${bonusParts.join(` ${C.gray}+${C.reset} `)}`)
        screenLines.push('')
      } else {
        screenLines.push(`  ${C.gray}Direct NowPayments crypto checkout · 4 instant tiers${C.reset}`)
        screenLines.push('')
      }

      opts.forEach((o, idx) => {
        const sel = idx === currentIdx
        const ptr = sel ? `${C.accent}❯${C.reset}` : ' '
        const amountStr = `$${o.usd}.00`.padEnd(8)
        const amountStyled = sel ? `${C.bold}${C.white}${amountStr}${C.reset}` : `${C.white}${amountStr}${C.reset}`
        const bonusUsd = o.bonusPct > 0 ? Number(((o.usd * o.bonusPct) / 100).toFixed(2)) : 0
        const totalCreditUsd = Number((o.usd + bonusUsd).toFixed(2))
        let bonusStr = ''
        if (bonusUsd > 0) {
          bonusStr = ` ${C.green}(+$${bonusUsd.toFixed(2)} bonus! +${o.bonusPct}%)${C.reset}`
        }
        screenLines.push(`  ${ptr} ${amountStyled} →  ${C.bold}${C.green}+$${totalCreditUsd.toFixed(2)} balance${C.reset}${bonusStr}`)
        screenLines.push('')
      })

      while (screenLines.length < rows - 2) screenLines.push('')
      screenLines.push(`  ${C.gray}↑/↓ navigate · Enter pay via NOWPayments · Esc cancel${C.reset}`)

      const finalLines = screenLines.slice(0, rows)
      while (finalLines.length < rows) finalLines.push('')
      lastRenderedLines = finalLines.slice()
      let out = '\x1b[?25l'
      for (let r = 0; r < rows; r += 1) {
        out += `\x1b[${r + 1};1H\x1b[2K${finalLines[r]}`
      }
      process.stdout.write(out)
      return
    }

    if (mode === 'subscription-picker') {
      const plans = billingData?.subscriptions?.plans || []
      const currentIdx = Math.max(0, Math.min(subscriptionIndex, Math.max(0, plans.length - 1)))
      const headerText = `Free-Model Subscriptions (${plans.length ? currentIdx + 1 : 0} of ${plans.length})`
      const topBar = `${C.line}─── ${C.bold}${C.white}${headerText}${C.reset} ${C.line}${'─'.repeat(Math.max(0, cols - headerText.length - 6))}${C.reset}`

      const screenLines = [topBar, '']
      screenLines.push(`  ${C.gray}Replaces daily 10M limit with massive 24/7 token pools for all free models.${C.reset}`)

      const activeOffer = billingData?.subscriptions?.activeOffer
      if (activeOffer) {
        screenLines.push(`  🏷 ${C.yellow}Active Discount: ${activeOffer.label}!${C.reset}`)
      }
      screenLines.push('')

      if (!plans.length) {
        screenLines.push(`    ${C.gray}No subscription plans available.${C.reset}`)
      } else {
        plans.forEach((p, idx) => {
          const sel = idx === currentIdx
          const ptr = sel ? `${C.accent}❯${C.reset}` : ' '
          const labelStyled = sel ? `${C.bold}${C.white}${p.label.padEnd(9)}${C.reset}` : `${C.white}${p.label.padEnd(9)}${C.reset}`
          const priceStr = `$${p.finalPriceUsd.toFixed(2)}`
          const priceStyled = sel ? `${C.bold}${C.green}${priceStr.padEnd(7)}${C.reset}` : `${C.green}${priceStr.padEnd(7)}${C.reset}`

          let tokenStr = p.kind === 'unlimited' ? 'Unlimited' : `${formatCompactCap(p.tokenLimit)} tokens`
          let bonusText = ''
          if (p.bonusTokens > 0) {
            bonusText = ` ${C.green}(+${formatCompactCap(p.bonusTokens)} bonus)${C.reset}`
          }

          let tag = ''
          if (p.isFeatured) tag = `  ${C.gold}[Featured · Ultra]${C.reset}`
          else if (p.finalPriceCents < p.listPriceCents) {
            tag = `  ${C.yellow}[${p.discountLabel || 'Discounted'}]${C.reset}`
          }

          screenLines.push(`  ${ptr} ${labelStyled} · ${priceStyled} · ${C.bold}${C.cyan}${tokenStr}${C.reset}${bonusText}${tag}`)
          screenLines.push('')
        })
      }

      while (screenLines.length < rows - 2) screenLines.push('')
      screenLines.push(`  ${C.gray}↑/↓ navigate · Enter pay via NOWPayments · Esc cancel${C.reset}`)

      const finalLines = screenLines.slice(0, rows)
      while (finalLines.length < rows) finalLines.push('')
      lastRenderedLines = finalLines.slice()
      let out = '\x1b[?25l'
      for (let r = 0; r < rows; r += 1) {
        out += `\x1b[${r + 1};1H\x1b[2K${finalLines[r]}`
      }
      process.stdout.write(out)
      return
    }

    if (mode === 'rpm-picker') {
      const plans = billingData?.rpm?.plans || [
        { key: 'plan30', label: 'Boost', rpm: 30, priceUsd: 10, days: 30 },
        { key: 'plan60', label: 'Turbo', rpm: 60, priceUsd: 20, days: 30 },
        { key: 'plan100', label: 'Enterprise', rpm: 100, priceUsd: 30, days: 30 },
      ]
      const currentIdx = Math.max(0, Math.min(rpmIndex, plans.length - 1))
      const headerText = `RPM Rate Limits Upgrade (${currentIdx + 1} of ${plans.length})`
      const topBar = `${C.line}─── ${C.bold}${C.white}${headerText}${C.reset} ${C.line}${'─'.repeat(Math.max(0, cols - headerText.length - 6))}${C.reset}`

      const curRpm = billingData?.rpm?.current?.rpm || 5
      const curPlan = billingData?.rpm?.current?.plan || 'free'
      const curExpires = billingData?.rpm?.current?.expiresAt
      const curExpiryStr = curExpires ? ` (expires ${formatRelativeDate(curExpires)})` : ''

      const screenLines = [topBar, '']
      screenLines.push(`  Current limit: ${C.bold}${C.cyan}${curRpm} RPM${C.reset} ${C.gray}(${curPlan})${curExpiryStr}${C.reset}`)
      screenLines.push(`  ${C.gray}High-concurrency rate limit boost for 30 days${C.reset}`)
      screenLines.push('')

      plans.forEach((p, idx) => {
        const sel = idx === currentIdx
        const ptr = sel ? `${C.accent}❯${C.reset}` : ' '
        const rpmStr = `${p.rpm} RPM`.padEnd(9)
        const rpmStyled = sel ? `${C.bold}${C.cyan}${rpmStr}${C.reset}` : `${C.cyan}${rpmStr}${C.reset}`
        const priceStr = `$${p.priceUsd.toFixed(2)} / 30d`.padEnd(14)
        const priceStyled = sel ? `${C.bold}${C.green}${priceStr}${C.reset}` : `${C.green}${priceStr}${C.reset}`
        const labelStyled = `${C.gray}(${p.label})${C.reset}`

        screenLines.push(`  ${ptr} ${rpmStyled} · ${priceStyled} · ${labelStyled}`)
        screenLines.push('')
      })

      while (screenLines.length < rows - 2) screenLines.push('')
      screenLines.push(`  ${C.gray}↑/↓ navigate · Enter pay via NOWPayments · Esc cancel${C.reset}`)

      const finalLines = screenLines.slice(0, rows)
      while (finalLines.length < rows) finalLines.push('')
      lastRenderedLines = finalLines.slice()
      let out = '\x1b[?25l'
      for (let r = 0; r < rows; r += 1) {
        out += `\x1b[${r + 1};1H\x1b[2K${finalLines[r]}`
      }
      process.stdout.write(out)
      return
    }

    const bal = account ? formatUsd(account.balanceUsd) : '$0.00'
    const plan = account ? formatPlanQuota(account) : 'Free · 0/0'

    const animFrame = isStreaming ? (Math.floor(spinnerTick / 2) % 4) : 0
    const mascot = getMascotLines(animFrame)

    const activeModelObj = models.find((m) => m.id === currentModel)
    const contextLimit = parseContextTokens(activeModelObj?.contextWindow || '128K')
    const currentTokens = sessionContextTokens > 0 ? sessionContextTokens : estimateTokens(history)
    const ratio = contextLimit > 0 ? currentTokens / contextLimit : 0
    const ratioColor = ratio >= 0.8 ? C.red : ratio >= 0.5 ? C.yellow : C.gray
    const contextMeter = `${ratioColor}${formatSpacedTokens(currentTokens)} / ${formatCompactCap(contextLimit)}${C.reset}`

    const updateTag = availableUpdate?.hasUpdate
      ? ` ${C.yellow}→ v${availableUpdate.latestVersion} available (/update)${C.reset}`
      : ''
    const cleanCwd = process.cwd().startsWith(homedir())
      ? '~' + process.cwd().slice(homedir().length)
      : process.cwd()
    const rpmStr = account?.rpm ? ` · ${C.yellow}${account.rpm} RPM${C.reset}` : ''
    const headerLines = [
      ` ${mascot[0]}  ${C.bold}${C.white}APInex CLI${C.reset} ${C.gray}v${VERSION}${C.reset}${updateTag}`,
      ` ${mascot[1]}  ${C.green}${bal}${C.gray} · ${C.blue}${plan}${C.reset}${rpmStr}`,
      ` ${mascot[2]}  ${C.gray}${cleanCwd}${C.reset}`,
      ` ${mascot[3]}`,
      ` ${C.gray}│ Using ${C.white}${currentModel}${C.gray} · type ${C.white}/model${C.gray} to switch · ${C.white}/help${C.gray} for commands${C.reset}`,
      '',
    ]

    const footerLines = []
    let promptCursorRow = 0
    let promptCursorCol = 0

    if (mode === 'model-picker') {
      const list = filteredModels()
      const maxItems = Math.min(10, Math.max(5, rows - headerLines.length - 8))
      const clampedIdx = list.length ? Math.max(0, Math.min(modelIndex, list.length - 1)) : 0
      const start = Math.max(0, Math.min(clampedIdx - Math.floor(maxItems / 2), Math.max(0, list.length - maxItems)))
      const visible = list.slice(start, start + maxItems)

      footerLines.push(hr)
      footerLines.push(
        ` ${C.bold}Select model (${list.length ? clampedIdx + 1 : 0} of ${list.length})${C.reset} ${C.gray}(↑/↓ navigate · Enter select · Esc cancel)${C.reset}` +
        (modelFilter ? `  ${C.yellow}filter: ${modelFilter}${C.reset}` : `  ${C.gray}type to filter…${C.reset}`),
      )
      if (start > 0) footerLines.push(`   ${C.gray}▲ ${start} more above…${C.reset}`)
      if (!visible.length) {
        footerLines.push(`   ${C.gray}No matching models${C.reset}`)
      } else {
        visible.forEach((m, idx) => {
          const real = start + idx
          const sel = real === clampedIdx
          const isCurrent = m.id === currentModel
          const curBadge = isCurrent ? ` ${C.cyan}● current${C.reset}` : ''
          const price = m.dollarsPer1M === 0 ? 'free' : `$${m.dollarsPer1M}/1M in · $${m.outputDollarsPer1M}/1M out`
          if (sel) {
            footerLines.push(` ${C.accent}❯ ${C.bold}${m.id.padEnd(28)} ${String(m.provider || '').padEnd(10)} ${price}${curBadge}${C.reset}`)
          } else {
            const priceColor = m.dollarsPer1M === 0 ? C.green : C.gray
            footerLines.push(`   ${C.white}${m.id.padEnd(28)}${C.reset} ${C.gray}${String(m.provider || '').padEnd(10)}${C.reset} ${priceColor}${price}${C.reset}${curBadge}`)
          }
        })
      }
      if (start + maxItems < list.length) {
        footerLines.push(`   ${C.gray}▼ ${list.length - (start + maxItems)} more below…${C.reset}`)
      }
      footerLines.push(hr)
    } else {
      const atFiles = matchingAtFiles()
      const slash = matchingSlash()

      if (atFiles.length > 0 && mode === 'chat') {
        const maxFiles = Math.min(6, Math.max(3, rows - headerLines.length - 12))
        const clamped = Math.max(0, Math.min(atFileIndex, atFiles.length - 1))
        const start = Math.max(0, Math.min(clamped - Math.floor(maxFiles / 2), Math.max(0, atFiles.length - maxFiles)))
        const visible = atFiles.slice(start, start + maxFiles)

        footerLines.push(hr)
        footerLines.push(` ${C.bold}Insert file reference${C.reset} ${C.gray}(↑/↓ navigate · Tab/Enter insert · Esc cancel)${C.reset}`)
        if (start > 0) footerLines.push(`   ${C.gray}▲ ${start} more above…${C.reset}`)
        for (let i = 0; i < visible.length; i += 1) {
          const item = visible[i]
          const realIdx = start + i
          const active = realIdx === clamped
          if (active) {
            footerLines.push(` ${C.accent}❯ ${C.bold}@${item}${C.reset}`)
          } else {
            footerLines.push(`   ${C.gray}@${item}${C.reset}`)
          }
        }
        if (start + maxFiles < atFiles.length) {
          footerLines.push(`   ${C.gray}▼ ${atFiles.length - (start + maxFiles)} more below…${C.reset}`)
        }
      } else if (slash.length > 0 && mode === 'chat') {
        const maxSlash = Math.min(6, Math.max(3, rows - headerLines.length - 12))
        const clamped = Math.max(0, Math.min(slashIndex, slash.length - 1))
        const start = Math.max(0, Math.min(clamped - Math.floor(maxSlash / 2), Math.max(0, slash.length - maxSlash)))
        const visible = slash.slice(start, start + maxSlash)

        footerLines.push(hr)
        footerLines.push(` ${C.bold}Commands (${clamped + 1} of ${slash.length})${C.reset} ${C.gray}(↑/↓ navigate · Tab/Enter run · Esc cancel)${C.reset}`)
        if (start > 0) footerLines.push(`   ${C.gray}▲ ${start} more above…${C.reset}`)
        for (let i = 0; i < visible.length; i += 1) {
          const item = visible[i]
          const realIdx = start + i
          const active = realIdx === clamped
          if (active) {
            footerLines.push(` ${C.accent}❯ ${C.bold}${item.cmd.padEnd(16)} ${item.desc}${C.reset}`)
          } else {
            footerLines.push(`   ${C.white}${item.cmd.padEnd(16)}${C.reset} ${C.gray}${item.desc}${C.reset}`)
          }
        }
        if (start + maxSlash < slash.length) {
          footerLines.push(`   ${C.gray}▼ ${slash.length - (start + maxSlash)} more below…${C.reset}`)
        }
      }

      // Status line placed above the divider and input box while generating/working,
      // replaced with Permission Prompt above the divider when permission is required
      if (mode === 'permission-prompt' && pendingPermission) {
        footerLines.push(` ${C.yellow}⚠ Permission Required${C.reset} · ${C.bold}Allow execution of command?${C.reset}`)
        footerLines.push(`   ${C.bold}${C.white}${pendingPermission.cmd}${C.reset}`)
        footerLines.push(` ${C.gray}[${C.green}y${C.gray}] Allow once  ·  [${C.blue}a${C.gray}] Always allow this session  ·  [${C.red}n${C.gray}] Deny (Esc)${C.reset}`)
      } else if (isStreaming || isExecutingQueue) {
        const frame = spinnerFrames[spinnerTick % spinnerFrames.length]
        const action = isStreaming ? getActiveActionPhrase() : 'Executing queued commands…'
        const queueTag = promptQueue.length > 0 ? `  ${C.accent}[${promptQueue.length} queued]${C.reset}` : ''
        footerLines.push(` ${C.yellow}${frame} ${action}${C.reset}${queueTag} ${C.gray}(Esc to clear queue · Ctrl+C to cancel)${C.reset}`)
      }

      footerLines.push(hr)

      if (!input) {
        const placeholder = (mode === 'permission-prompt')
          ? `${C.gray}Press [y]es, [a]lways, or [n]o/Esc…${C.reset}`
          : (isStreaming || isExecutingQueue)
          ? `${C.gray}Type next prompt or command while busy…${C.reset}`
          : `${C.gray}Ask anything or type / for commands…${C.reset}`
        footerLines.push(` ${C.accent}❯${C.reset} ${placeholder}`)
        promptCursorRow = footerLines.length
        promptCursorCol = 4
      } else {
        // Multi-line wrap for long prompts
        const maxInputWidth = cols - 5
        const wrappedInput = wrapText(input, maxInputWidth)
        wrappedInput.forEach((line, lineIdx) => {
          footerLines.push(lineIdx === 0 ? ` ${C.accent}❯${C.reset} ${line}` : `   ${line}`)
        })
        const linesBefore = wrapText(input.slice(0, cursor), maxInputWidth)
        promptCursorRow = footerLines.length - (wrappedInput.length - linesBefore.length)
        const lastLineLen = stripAnsi(linesBefore[linesBefore.length - 1] || '').length
        promptCursorCol = 4 + lastLineLen
      }

      footerLines.push(hr)

      const rightNotice = statusNotice
        ? `${C.green}✓ ${statusNotice}${C.reset}`
        : `${C.gray}Context: ${contextMeter} · ${C.white}/help${C.gray} for commands${C.reset}`
      footerLines.push(`   ${rightNotice}`)
    }

    const bodyBudget = Math.max(2, rows - headerLines.length - footerLines.length - 1)
    const renderedBody = []
    for (const item of transcript) {
      if (item.role === 'user') {
        const userLines = wrapText(item.text, cols - 6)
        userLines.forEach((l, idx) => {
          renderedBody.push(idx === 0 ? ` ${C.accent}❯${C.reset} ${C.bold}${C.white}${l}${C.reset}` : `   ${C.bold}${C.white}${l}${C.reset}`)
        })
        renderedBody.push('')
      } else if (item.role === 'assistant') {
        if (item.text) {
          const lines = renderMarkdownLines(item.text, cols - 6)
          lines.forEach((line, idx) => {
            renderedBody.push(idx === 0 ? ` ${C.accent}◆${C.reset} ${line}` : `   ${line}`)
          })
          if (item.stats) {
            renderedBody.push(`   ${C.dim}⏱ ${item.stats}${C.reset}`)
          }
          renderedBody.push('')
        }
      } else if (item.role === 'tool') {
        const toolLines = renderDiff(item.meta, cols)
        renderedBody.push(...toolLines)
        if (item.stats) {
          renderedBody.push(`   ${C.gray}${item.stats}${C.reset}`)
        }
        renderedBody.push('')
      } else if (item.role === 'notice') {
        renderedBody.push(`   ${C.gray}${item.text}${C.reset}`)
        renderedBody.push('')
      } else if (item.role === 'error') {
        renderedBody.push(`   ${C.red}✕ ${item.text}${C.reset}`)
        renderedBody.push('')
      }
    }

    const maxScroll = Math.max(0, renderedBody.length - bodyBudget)
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll))
    const endIdx = renderedBody.length - scrollOffset
    const startIdx = Math.max(0, endIdx - bodyBudget)
    const visibleBody = renderedBody.slice(startIdx, endIdx)
    while (visibleBody.length < bodyBudget) {
      visibleBody.push('')
    }

    const allLines = [...headerLines, ...visibleBody, ...footerLines].slice(0, rows)
    while (allLines.length < rows) allLines.push('')
    lastRenderedLines = allLines.slice()

    let displayLines = allLines
    if (selectionRange && selectionRange.start && selectionRange.end) {
      displayLines = applyVisualSelection(allLines, selectionRange.start, selectionRange.end)
    }

    let out = '\x1b[?25l'
    for (let r = 0; r < rows; r += 1) {
      out += `\x1b[${r + 1};1H\x1b[2K${displayLines[r]}`
    }

    if (mode === 'chat' || isStreaming || isExecutingQueue) {
      const baseRow = headerLines.length + visibleBody.length
      const targetRow = Math.min(rows - 1, baseRow + (promptCursorRow || 1))
      const targetCol = Math.min(cols, promptCursorCol || 4)
      out += `\x1b[${targetRow};${targetCol}H\x1b[?25h`
    }
    process.stdout.write(out)
  }

  const exitCleanly = () => {
    process.removeListener('SIGINT', handleUserExit)
    process.removeListener('SIGTERM', handleUserExit)
    if (statusNoticeTimer) clearTimeout(statusNoticeTimer)
    if (spinnerTimer) clearInterval(spinnerTimer)
    for (const timer of activePollers.values()) clearInterval(timer)
    activePollers.clear()
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write('\x1b[?7h\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l')
  }

  const handleUserExit = () => {
    try {
      const sessionData = {
        sessionId,
        model: currentModel,
        history,
        promptHistory,
        transcript,
        savedAt: new Date().toISOString(),
        cwd: process.cwd(),
      }
      saveSessionFile(sessionId, sessionData)
      saveSessionFile('last', sessionData)
    } catch { /* ignore */ }

    exitCleanly()
    process.stdout.write(`\nResume this session with:\n  ${C.bold}apinex --resume ${sessionId}${C.reset}\n\n`)
    process.exit(0)
  }

  const openModelPicker = async () => {
    mode = 'model-picker'
    modelFilter = ''
    if (!models.length) {
      models = await cachedOrLiveModels(true)
    }
    modelIndex = 0 // Start from the top (1st model like on website)
    renderScreen()
  }

  const runSlashCommand = async (rawLine) => {
    const parts = rawLine.trim().split(/\s+/)
    const cmd = parts[0].toLowerCase()
    const arg = parts[1]

    if (cmd === '/help' || cmd === '/?' || cmd === 'help') {
      const helpLines = [
        `\n  ${C.bold}${C.white}Available Slash Commands:${C.reset}`,
        ...SLASH_COMMANDS.map((c) => `    ${C.accent}${c.cmd.padEnd(16)}${C.reset} ${C.gray}${c.desc}${C.reset}`),
        `\n  ${C.bold}${C.white}Keyboard Shortcuts & Features:${C.reset}`,
        `    ${C.accent}@<filename>    ${C.reset} ${C.gray}Fuzzy autocomplete and insert workspace file path${C.reset}`,
        `    ${C.accent}Ctrl+V         ${C.reset} ${C.gray}Paste clipboard text or image screenshot${C.reset}`,
        `    ${C.accent}Ctrl+C / Esc   ${C.reset} ${C.gray}Cancel active AI generation (or quit when idle)${C.reset}`,
        `    ${C.accent}↑ / ↓          ${C.reset} ${C.gray}Browse prompt history or menu options${C.reset}`,
        `    ${C.accent}Tab            ${C.reset} ${C.gray}Select highlighted autocomplete option${C.reset}`,
      ].join('\n')
      transcript.push({ role: 'notice', text: helpLines })
      renderScreen()
      return
    }

    if (cmd === '/exit' || cmd === '/quit') {
      handleUserExit()
      return
    }
    if (cmd === '/init') {
      const target = join(process.cwd(), 'APINEX.md')
      const exists = existsSync(target)
      statusNotice = 'Scanning project and creating APINEX.md…'
      renderScreen()
      try {
        const mdContent = generateApinexMd(process.cwd())
        writeFileSync(target, mdContent, 'utf8')
        if (history.length > 0 && history[0].role === 'system') {
          history[0].content = getAgentSystemPrompt()
        }
        transcript.push({
          role: 'notice',
          text: `✓ ${exists ? 'Updated' : 'Created'} APINEX.md in ${process.cwd()}\n   APInex CLI will now automatically follow these project rules and commands on every prompt.`,
        })
        showNotice(`✓ ${exists ? 'Updated' : 'Created'} APINEX.md`, 3500)
      } catch (err) {
        transcript.push({ role: 'error', text: `Failed to create APINEX.md: ${err.message}` })
        statusNotice = ''
      }
      renderScreen()
      return
    }
    if (cmd === '/topup') {
      const cleanArg = arg ? arg.replace(/^\$/, '') : null
      await openTopupPicker(cleanArg)
      return
    }
    if (cmd === '/subscriptions' || cmd === '/subscription' || cmd === '/sub') {
      await openSubscriptionPicker(arg)
      return
    }
    if (cmd === '/rpm') {
      await openRpmPicker(arg)
      return
    }
    if (cmd === '/clear') {
      history.length = 0
      transcript.length = 0
      sessionContextTokens = 0
      statusNotice = 'Conversation cleared'
      renderScreen()
      return
    }
    if (cmd === '/update') {
      statusNotice = 'Checking for updates…'
      renderScreen()
      try {
        const info = await checkRemoteVersion(true)
        if (!info?.hasUpdate) {
          showNotice(`✓ You are on the latest version (v${VERSION})`, 3000)
          return
        }
        transcript.push({
          role: 'notice',
          text: `🚀 Updating APInex CLI from v${VERSION} to v${info.latestVersion}…\n   ${info.changelog ? "What's new: " + info.changelog : ''}`,
        })
        statusNotice = `Updating to v${info.latestVersion}…`
        renderScreen()
        try {
          execSync('npm install -g apinex-cli@latest', { stdio: 'pipe', encoding: 'utf8', timeout: 60000 })
        } catch {
          execSync('npm install -g apinex@latest', { stdio: 'pipe', encoding: 'utf8', timeout: 60000 })
        }
        availableUpdate = null
        transcript.push({
          role: 'notice',
          text: `✓ Successfully updated to v${info.latestVersion}! Please restart your CLI session to apply.`,
        })
        showNotice(`✓ Updated to v${info.latestVersion}!`, 4000)
      } catch (err) {
        transcript.push({
          role: 'error',
          text: `Update failed: ${err.message}. You can manually update with: npm install -g apinex-cli@latest`,
        })
        statusNotice = ''
      }
      renderScreen()
      return
    }
    if (cmd === '/resume') {
      openSessionPicker()
      return
    }
    if (cmd === '/copy' || cmd === '/cp') {
      let lastText = ''
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        if (transcript[i].role === 'assistant' && transcript[i].text) {
          lastText = transcript[i].text
          break
        }
      }
      if (lastText) {
        copyToClipboard(lastText)
        showNotice(`✓ Copied last response (${lastText.length} chars) to clipboard`, 2500)
      } else {
        showNotice('No assistant response to copy yet', 2000)
      }
      renderScreen()
      return
    }
    if (cmd === '/diff') {
      try {
        const status = execSync('git status --short', { encoding: 'utf8', timeout: 5000 }).trim()
        if (!status) {
          showNotice('✓ Working tree clean (no git changes)', 2500)
          return
        }
        let diff = ''
        try {
          diff = execSync('git diff HEAD', { encoding: 'utf8', timeout: 10000 }).trim()
        } catch {
          diff = execSync('git diff', { encoding: 'utf8', timeout: 10000 }).trim()
        }
        const fullOut = status + (diff ? '\n\n' + diff : '')
        transcript.push({
          role: 'tool',
          meta: { type: 'bash', cmd: 'git diff', out: fullOut },
        })
        renderScreen()
      } catch (err) {
        transcript.push({ role: 'error', text: `Git diff failed: ${err.message}` })
        renderScreen()
      }
      return
    }
    if (cmd.startsWith('/commit')) {
      const explicitMsg = rawLine.trim().slice(7).trim()
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim()
        if (!status) {
          showNotice('Nothing to commit (working tree clean)', 2500)
          return
        }

        let commitMsg = explicitMsg
        if (!commitMsg) {
          statusNotice = 'Analyzing git diff for Conventional Commit…'
          renderScreen()
          try { execSync('git add -A', { encoding: 'utf8', timeout: 5000 }) } catch { /* ignore */ }
          let stagedDiff = ''
          try {
            stagedDiff = execSync('git diff --cached', { encoding: 'utf8', timeout: 10000 })
          } catch {
            stagedDiff = status
          }
          if (!stagedDiff.trim()) {
            showNotice('Nothing to commit', 2000)
            return
          }

          const diffSample = stagedDiff.slice(0, 7000)
          const commitPrompt = [
            {
              role: 'system',
              content: 'You are a git commit assistant. Based on the git diff, output ONLY a concise single-line Conventional Commit subject (e.g. "feat(cli): add autocomplete and git commands", "fix(auth): correct token refresh"). Do NOT wrap in quotes, backticks, or markdown.',
            },
            {
              role: 'user',
              content: `Generate a conventional commit message for this diff:\n\n${diffSample}`,
            },
          ]
          const res = await streamChatTurn({
            model: currentModel,
            messages: commitPrompt,
            tools: null,
          })
          commitMsg = (res.content || '').trim().replace(/^['"`]|['"`]$/g, '').split('\n')[0].trim()
        }

        if (!commitMsg) commitMsg = 'chore: update changes'

        try { execSync('git add -A', { encoding: 'utf8', timeout: 5000 }) } catch { /* ignore */ }
        let commitOut = ''
        try {
          commitOut = execFileSync('git', ['commit', '-m', commitMsg], { encoding: 'utf8', timeout: 10000 }).trim()
        } catch {
          commitOut = execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 10000 }).trim()
        }
        transcript.push({
          role: 'notice',
          text: `✓ Committed: ${commitMsg}\n${commitOut.split('\n')[0]}`,
        })
        showNotice(`✓ Committed: ${commitMsg}`, 3000)
        renderScreen()
      } catch (err) {
        transcript.push({ role: 'error', text: `Commit failed: ${err.message}` })
        renderScreen()
      }
      return
    }
    if (cmd.startsWith('/save')) {
      const name = rawLine.trim().slice(5).trim() || `session-${Date.now()}`
      try {
        const file = saveSessionFile(name, {
          model: currentModel,
          history,
          promptHistory,
          transcript,
          savedAt: new Date().toISOString(),
          cwd: process.cwd(),
        })
        showNotice(`✓ Session saved as ${name}`)
        transcript.push({ role: 'notice', text: `Saved session to ${file}. Resume anytime with: apinex -r ${name}` })
        renderScreen()
      } catch (err) {
        transcript.push({ role: 'error', text: `Save session failed: ${err.message}` })
        renderScreen()
      }
      return
    }
    if (cmd === '/compact') {
      await performCompaction({ manual: true })
      return
    }
    if (cmd === '/account' || cmd === '/balance') {
      statusNotice = 'Refreshing account…'
      renderScreen()
      try {
        account = await fetchAccount()
        statusNotice = `Synced: ${formatUsd(account.balanceUsd)} · ${formatPlanQuota(account)}`
      } catch (err) {
        transcript.push({ role: 'error', text: err.message })
        statusNotice = ''
      }
      renderScreen()
      return
    }
    if (cmd === '/model' || cmd === '/models' || cmd === '/use') {
      if (arg) {
        if (!models.length) models = await cachedOrLiveModels(true)
        const found = models.find((m) => m.id === arg)
        if (!found) {
          transcript.push({ role: 'error', text: `Unknown model "${arg}". Use /model to choose from the list.` })
        } else {
          currentModel = found.id
          saveCfg({ defaultModel: currentModel })
          statusNotice = `Switched to ${currentModel}`
        }
        renderScreen()
        return
      }
      await openModelPicker()
      return
    }
    if (cmd === '/login') {
      statusNotice = 'Opening browser to sign in…'
      renderScreen()
      try {
        account = await loginBrowser({ silent: true })
        statusNotice = 'Signed in successfully'
      } catch (err) {
        transcript.push({ role: 'error', text: err.message })
        statusNotice = ''
      }
      renderScreen()
      return
    }
    if (cmd === '/logout') {
      const cur = loadAuth()
      if (cur?.accessToken) {
        await fetch(`${API_ORIGIN}/api/cli/logout`, {
          method: 'POST',
          headers: { ...CLI_HEADERS, Authorization: `Bearer ${cur.accessToken}` },
        }).catch(() => undefined)
      }
      if (existsSync(authFile())) rmSync(authFile(), { force: true })
      exitCleanly()
      process.stderr.write('Logged out.\n')
      process.exit(0)
    }

    transcript.push({
      role: 'error',
      text: `Unknown command "${cmd}". Available: ${SLASH_COMMANDS.map((c) => c.cmd).join(', ')}`,
    })
    renderScreen()
  }

  const performCompaction = async ({ manual = false } = {}) => {
    if (history.length <= 3) {
      if (manual) {
        statusNotice = 'Context is already compact'
        renderScreen()
      }
      return
    }

    transcript.push({ role: 'notice', text: 'Compacting session context…' })
    renderScreen()

    const oldTokens = sessionContextTokens > 0 ? sessionContextTokens : estimateTokens(history)
    const lastUserIdx = history.findLastIndex((m) => m.role === 'user')
    const splitIdx = lastUserIdx > 1 ? lastUserIdx : Math.max(1, history.length - 2)
    const toSummarize = history.slice(1, splitIdx)
    const recent = history.slice(splitIdx)

    try {
      const prompt = [
        { role: 'system', content: 'You are a technical context compressor.' },
        {
          role: 'user',
          content:
            'Summarize the following conversation concisely. Capture decisions made, user preferences, created or modified files, paths, and active state. Keep under 300 words:\n\n' +
            JSON.stringify(toSummarize),
        },
      ]

      const summary = await streamChatTurn({
        model: currentModel,
        messages: prompt,
        onDelta: () => {},
      })

      const summaryText = summary.content.trim() || 'Earlier context condensed.'
      history.length = 0
      history.push({ role: 'system', content: getAgentSystemPrompt() })
      history.push({ role: 'system', content: `Previous session summary:\n${summaryText}` })
      for (const msg of recent) {
        history.push(msg)
      }

      const newTokens = estimateTokens(history)
      sessionContextTokens = newTokens
      transcript.push({
        role: 'notice',
        text: `Context compacted (${formatSpacedTokens(oldTokens)} → ${formatSpacedTokens(newTokens)} tokens).`,
      })
      statusNotice = `Compacted: ${formatSpacedTokens(newTokens)} tokens`
    } catch (err) {
      transcript.push({ role: 'error', text: `Compaction failed: ${err.message}` })
    }
    renderScreen()
  }

  // Multi-step Agent Loop with Tools (Write, Edit, Bash, Read)
  const submitPrompt = async (text) => {
    statusNotice = ''
    transcript.push({ role: 'user', text })

    if (history.length === 0) {
      history.push({ role: 'system', content: getAgentSystemPrompt() })
    }

    let userContent = text
    if (imagesStore.length > 0 && text.includes('[Image #')) {
      const parts = []
      for (const img of imagesStore) {
        if (text.includes(img.tag)) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
          })
        }
      }
      parts.push({ type: 'text', text })
      userContent = parts
    }

    history.push({ role: 'user', content: userContent })

    isStreaming = true
    mode = 'streaming'
    abortController = new AbortController()
    spinnerTick = 0
    spinnerTimer = setInterval(() => {
      spinnerTick += 1
      renderScreen()
    }, 90)
    renderScreen()

    try {
      const maxToolTurns = 30
      let turns = 0
      const requestStartTime = Date.now()
      let totalPromptTokens = 0
      let totalCompletionTokens = 0
      let totalUsageTokens = 0

      while (turns < maxToolTurns) {
        turns += 1
        const assistantEntry = { role: 'assistant', text: '' }
        transcript.push(assistantEntry)

        const turn = await streamChatTurn({
          model: currentModel,
          messages: history,
          tools: AGENT_TOOLS,
          signal: abortController.signal,
          onDelta: (d) => {
            if (d.type === 'content') {
              assistantEntry.text += d.delta
              renderScreen()
            }
          },
        })

        if (!assistantEntry.text.trim() && !turn.toolCalls.length) {
          transcript.pop()
        }

        if (turn.usage) {
          const pt = Number(turn.usage.prompt_tokens ?? turn.usage.input_tokens ?? 0)
          const ct = Number(turn.usage.completion_tokens ?? turn.usage.output_tokens ?? 0)
          const tt = Number(turn.usage.total_tokens ?? (pt + ct))
          totalPromptTokens += pt
          totalCompletionTokens += ct
          totalUsageTokens += tt
          sessionContextTokens = tt
        } else {
          const estP = estimateTokens(history)
          const estC = Math.max(1, Math.ceil((turn.content || '').length / 4))
          totalPromptTokens += estP
          totalCompletionTokens += estC
          totalUsageTokens += estP + estC
          sessionContextTokens = totalUsageTokens
        }

        const msgRecord = { role: 'assistant', content: turn.content || null }
        if (turn.toolCalls.length) {
          msgRecord.tool_calls = turn.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        }
        history.push(msgRecord)

        if (!turn.toolCalls.length) {
          // Model finished its work
          break
        }

        // Execute tools and append results
        for (const tc of turn.toolCalls) {
          if (tc.name === 'bash') {
            toolActionPhrase = `Running bash: ${(tc.args?.command || '').slice(0, 45)}…`
          } else if (tc.name === 'read_file') {
            toolActionPhrase = `Reading ${tc.args?.path || ''}…`
          } else if (tc.name === 'write_file') {
            toolActionPhrase = `Writing ${tc.args?.path || ''}…`
          } else if (tc.name === 'edit_file') {
            toolActionPhrase = `Editing ${tc.args?.path || ''}…`
          } else if (tc.name === 'grep_search') {
            toolActionPhrase = `Searching "${(tc.args?.query || '').slice(0, 30)}"…`
          } else if (tc.name === 'find_files') {
            toolActionPhrase = `Finding files "${tc.args?.pattern || ''}"…`
          } else if (tc.name === 'web_search') {
            toolActionPhrase = `Searching web: "${(tc.args?.query || '').slice(0, 35)}"…`
          } else if (tc.name === 'web_fetch') {
            toolActionPhrase = `Fetching web page: ${(tc.args?.url || '').slice(0, 35)}…`
          } else {
            toolActionPhrase = `Running ${tc.name}…`
          }
          renderScreen()

          try {
            const res = await executeTool(tc.name, tc.args, { requestPermission })
            transcript.push({
              role: 'tool',
              meta: res.meta || { type: 'bash', cmd: tc.name, out: res.output },
            })
            history.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: String(res.output ?? ''),
            })
          } catch (err) {
            transcript.push({
              role: 'error',
              text: `${tc.name} failed: ${err.message}`,
            })
            history.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: ${err.message}`,
            })
          } finally {
            toolActionPhrase = null
          }
          renderScreen()
        }
      }

      // If loop ended while waiting for assistant to summarize tool results, force one final text turn
      const lastHist = history[history.length - 1]
      if (lastHist?.role === 'tool') {
        const finalEntry = { role: 'assistant', text: '' }
        transcript.push(finalEntry)
        const finalTurn = await streamChatTurn({
          model: currentModel,
          messages: history,
          tools: null, // Force model to speak, no more tools
          signal: abortController.signal,
          onDelta: (d) => {
            if (d.type === 'content') {
              finalEntry.text += d.delta
              renderScreen()
            }
          },
        })
        if (finalTurn.usage) {
          const pt = Number(finalTurn.usage.prompt_tokens ?? 0)
          const ct = Number(finalTurn.usage.completion_tokens ?? 0)
          totalPromptTokens += pt
          totalCompletionTokens += ct
          totalUsageTokens += pt + ct
        }
        history.push({ role: 'assistant', content: finalTurn.content || null })
      }

      // Attach summed time and in+out tokens strictly to the final entry in transcript
      const totalElapsedMs = Date.now() - requestStartTime
      const totalElapsedSec = (totalElapsedMs / 1000).toFixed(1) + 's'
      const finalStats = `${totalElapsedSec} · ${formatSpacedTokens(totalUsageTokens)} tokens (${formatSpacedTokens(totalPromptTokens)} in · ${formatSpacedTokens(totalCompletionTokens)} out)`

      if (totalElapsedMs >= 10000) {
        sendOsNotification({
          title: 'APInex CLI · Task Completed',
          message: `Finished in ${totalElapsedSec} (${formatSpacedTokens(totalUsageTokens)} tokens)`,
          sound: 'Glass',
        })
      }

      if (transcript.length > 0) {
        transcript[transcript.length - 1].stats = finalStats
      }

      // Auto-save session state
      try {
        const sessionData = {
          sessionId,
          model: currentModel,
          history,
          promptHistory,
          transcript,
          savedAt: new Date().toISOString(),
          cwd: process.cwd(),
        }
        saveSessionFile(sessionId, sessionData)
        saveSessionFile('last', sessionData)
      } catch { /* ignore */ }

      fetchAccount()
        .then((fresh) => {
          account = fresh
          renderScreen()
        })
        .catch(() => undefined)

      // Auto-compact when 80% of model context window is used
      const activeObj = models.find((m) => m.id === currentModel)
      const maxCtx = parseContextTokens(activeObj?.contextWindow || '128K')
      if (maxCtx > 0 && estimateTokens(history) / maxCtx >= 0.8) {
        await performCompaction({ manual: false })
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        transcript.push({ role: 'notice', text: 'Cancelled.' })
      } else {
        let errText = err.message || String(err)
        if (errText.includes('Insufficient balance')) {
          errText += ' · Run /topup to add balance, or /model to switch to a free model.'
        } else if (errText.includes('Subscription') || errText.includes('subscription') || errText.includes('allowance') || errText.includes('tokens used')) {
          errText += ' · Run /subscriptions to upgrade plans, or /topup to add balance.'
        }
        transcript.push({ role: 'error', text: errText })
      }
    } finally {
      if (spinnerTimer) {
        clearInterval(spinnerTimer)
        spinnerTimer = null
      }
      abortController = null
      isStreaming = false
      toolActionPhrase = null
      mode = 'chat'
      renderScreen()
    }
  }

  const processQueue = async () => {
    if (isExecutingQueue) return
    isExecutingQueue = true
    try {
      while (promptQueue.length > 0) {
        const nextItem = promptQueue.shift()
        renderScreen()
        try {
          if (nextItem.startsWith('/')) {
            await runSlashCommand(nextItem)
          } else {
            await submitPrompt(nextItem)
          }
        } catch (err) {
          transcript.push({ role: 'error', text: `Queue item failed: ${err?.message || err}` })
        }
      }
    } finally {
      isExecutingQueue = false
      renderScreen()
    }
  }

  const emergencyRestore = () => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdout.write('\x1b[?7h\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l')
    } catch { /* ignore */ }
  }

  process.on('uncaughtException', (err) => {
    emergencyRestore()
    console.error('\n' + (err?.stack || err?.message || String(err)))
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    emergencyRestore()
    console.error('\n' + (err?.stack || err?.message || String(err)))
    process.exit(1)
  })
  process.on('exit', emergencyRestore)
  process.on('SIGINT', handleUserExit)
  process.on('SIGTERM', handleUserExit)

  process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?7l\x1b[2J\x1b[3J')
  process.stdout.on('resize', renderScreen)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  if (pickResume) {
    openSessionPicker()
  } else if (resumeSession) {
    loadSessionIntoState(resumeSession)
  }

  renderScreen()

  let inBracketedPaste = false
  let pasteBuffer = ''

  await new Promise(() => {
    process.stdin.on('data', async (buf) => {
      try {
        let seq = buf.toString('utf8')

      // Terminal Focus In / Focus Out
      if (seq.includes('\x1b[I')) {
        seq = seq.split('\x1b[I').join('')
        if (!seq) return
      }
      if (seq.includes('\x1b[O')) {
        seq = seq.split('\x1b[O').join('')
        if (!seq) return
      }

      // Bracketed paste mode support (handles multi-chunk pasted blocks)
      if (seq.includes('\x1b[200~') || inBracketedPaste) {
        isBrowsingHistory = false
        inBracketedPaste = true
        pasteBuffer += seq
        if (!pasteBuffer.includes('\x1b[201~')) {
          return // Keep buffering until end-of-paste signal arrives
        }
        inBracketedPaste = false
        const pasteContent = pasteBuffer.replace(BRACKETED_PASTE_RE, '').trim()
        pasteBuffer = ''
        if (!pasteContent || pasteContent.includes('[APINEX_IMAGE_PASTE]')) {
          // Empty or bridged bracketed paste: check native pasteboard for image
          const native = readNativeClipboard()
          if (native?.type === 'image') {
            const tag = `[Image #${imagesStore.length + 1}]`
            imagesStore.push({ tag, base64: native.base64, mediaType: 'image/png' })
            input = input.slice(0, cursor) + tag + input.slice(cursor)
            cursor += tag.length
            showNotice(`Pasted ${tag}`)
            return
          }
        }
        // If image file path was pasted in bracketed paste
        const trimmedPath = pasteContent.trim().replace(/^['"]|['"]$/g, '')
        if (/\.(png|jpe?g|webp|gif)$/i.test(trimmedPath) && existsSync(trimmedPath)) {
          try {
            const b64 = readFileSync(trimmedPath).toString('base64')
            const ext = trimmedPath.split('.').pop().toLowerCase()
            const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
            const tag = `[Image #${imagesStore.length + 1}]`
            imagesStore.push({ tag, base64: b64, mediaType: mime })
            input = input.slice(0, cursor) + tag + input.slice(cursor)
            cursor += tag.length
            showNotice(`Attached ${basename(trimmedPath)} as ${tag}`)
            return
          } catch {
            /* fall through */
          }
        }
        if (pasteContent) {
          const cleanPaste = pasteContent.replace(/[\r\n]/g, ' ')
          input = input.slice(0, cursor) + cleanPaste + input.slice(cursor)
          cursor += cleanPaste.length
          renderScreen()
          return
        }
        return
      }

      // If an isolated bracketed paste tag arrives, strip it completely
      if (seq.includes('\x1b[201~') || seq.includes('\x1b[200~') || seq.includes('[201~') || seq.includes('[200~')) {
        seq = seq.replace(BRACKETED_PASTE_RE, '')
        if (!seq) return
      }

      // SGR Mouse Drag / Selection to Auto-Copy (like Claude Code)
      const SGR_CLICK_RE = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g')
      const sgrMatches = [...seq.matchAll(SGR_CLICK_RE)]
      if (sgrMatches.length > 0) {
        for (const m of sgrMatches) {
          const btn = Number(m[1])
          const col = Number(m[2])
          const row = Number(m[3])
          const type = m[4]

          if (type === 'M') {
            if (btn === 64) {
              scrollOffset += 2
              renderScreen()
            } else if (btn === 65) {
              scrollOffset = Math.max(0, scrollOffset - 2)
              renderScreen()
            } else if (btn === 0 || btn === 32) {
              if (!mouseDragStart) {
                mouseDragStart = { col, row }
              } else if (Math.abs(col - mouseDragStart.col) > 0 || Math.abs(row - mouseDragStart.row) > 0) {
                isMouseDragging = true
                selectionRange = { start: mouseDragStart, end: { col, row } }
                renderScreen()
              }
            }
          } else if (type === 'm') {
            if (isMouseDragging && mouseDragStart && lastRenderedLines.length > 0) {
              const sel = extractSelectedText(lastRenderedLines, mouseDragStart, { col, row })
              if (sel && sel.trim().length > 0) {
                copyToClipboard(sel)
                showNotice(`✓ Copied ${sel.length} characters to clipboard`, 2000)
              }
            }
            mouseDragStart = null
            isMouseDragging = false
            selectionRange = null
            renderScreen()
          }
        }
        // Strip every mouse packet cleanly so zero mouse characters leak into prompt
        seq = seq.replace(SGR_CLICK_RE, '')
        if (!seq) return
      }

      if (seq.startsWith('\x1b[<') || seq.startsWith('\x1b[M')) {
        return
      }

      if (seq === '\x03') {
        if (isStreaming && abortController) {
          abortController.abort()
          promptQueue.length = 0
          showNotice('Generation cancelled')
          renderScreen()
          return
        }
        handleUserExit()
        return
      }

      if (seq === '\x1a') {
        handleUserExit()
        return
      }

      if (mode === 'permission-prompt') {
        if (seq === 'y' || seq === 'Y' || seq === '\r' || seq === '\n') {
          const res = pendingPermission?.resolve
          pendingPermission = null
          mode = 'streaming'
          renderScreen()
          res?.(true)
          return
        }
        if (seq === 'a' || seq === 'A') {
          alwaysAllowDestructive = true
          const res = pendingPermission?.resolve
          pendingPermission = null
          mode = 'streaming'
          showNotice('Always allowing destructive commands this session', 2500)
          res?.(true)
          return
        }
        if (seq === 'n' || seq === 'N' || seq === '\x1b') {
          const rej = pendingPermission?.reject
          pendingPermission = null
          mode = 'streaming'
          renderScreen()
          rej?.(new Error('Command cancelled by user'))
          return
        }
        return
      }

      if (mode === 'session-picker') {
        const q = sessionFilter.trim().toLowerCase()
        const list = q
          ? savedSessionsList.filter(
              (s) =>
                String(s.id || '').toLowerCase().includes(q) ||
                String(s.title || s.preview || '').toLowerCase().includes(q) ||
                String(s.model || '').toLowerCase().includes(q) ||
                String(s.cwd || '').toLowerCase().includes(q),
            )
          : savedSessionsList

        if (seq === '\x1b') {
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x1b[A') {
          sessionIndex = list.length ? (sessionIndex - 1 + list.length) % list.length : 0
          renderScreen()
          return
        }
        if (seq === '\x1b[B') {
          sessionIndex = list.length ? (sessionIndex + 1) % list.length : 0
          renderScreen()
          return
        }
        if (seq === '\r' || seq === '\n') {
          const picked = list[Math.max(0, Math.min(sessionIndex, list.length - 1))]
          if (picked) {
            loadSessionIntoState(picked.id)
          }
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x7f' || seq === '\b') {
          sessionFilter = sessionFilter.slice(0, -1)
          sessionIndex = 0
          renderScreen()
          return
        }
        if (!seq.startsWith('\x1b') && seq.length > 0) {
          const clean = seq.replace(/[\r\n\t]/g, '').replace(CTRL_RE, '')
          if (clean) {
            sessionFilter += clean
            sessionIndex = 0
            renderScreen()
          }
          return
        }
        return
      }

      if (mode === 'model-picker') {
        const list = filteredModels()
        if (seq === '\x1b') {
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x1b[A') {
          modelIndex = list.length ? (modelIndex - 1 + list.length) % list.length : 0
          renderScreen()
          return
        }
        if (seq === '\x1b[B') {
          modelIndex = list.length ? (modelIndex + 1) % list.length : 0
          renderScreen()
          return
        }
        if (seq === '\r' || seq === '\n') {
          const picked = list[Math.max(0, Math.min(modelIndex, list.length - 1))]
          if (picked) {
            currentModel = picked.id
            saveCfg({ defaultModel: currentModel })
            statusNotice = `Using ${currentModel}`
          }
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x7f' || seq === '\b') {
          modelFilter = modelFilter.slice(0, -1)
          modelIndex = 0
          renderScreen()
          return
        }
        if (seq.length === 1 && seq >= ' ' && seq <= '~') {
          modelFilter += seq
          modelIndex = 0
          renderScreen()
        }
        return
      }

      if (mode === 'topup-picker') {
        const opts = billingData?.topup?.options || []
        if (seq === '\x1b') {
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x1b[A') {
          topupIndex = opts.length ? (topupIndex - 1 + opts.length) % opts.length : 0
          renderScreen()
          return
        }
        if (seq === '\x1b[B') {
          topupIndex = opts.length ? (topupIndex + 1) % opts.length : 0
          renderScreen()
          return
        }
        if (seq === '\r' || seq === '\n') {
          const picked = opts[Math.max(0, Math.min(topupIndex, opts.length - 1))]
          if (picked) {
            await executeTopupPayment(picked.usd)
          }
          return
        }
        return
      }

      if (mode === 'subscription-picker') {
        const plans = billingData?.subscriptions?.plans || []
        if (seq === '\x1b') {
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x1b[A') {
          subscriptionIndex = plans.length ? (subscriptionIndex - 1 + plans.length) % plans.length : 0
          renderScreen()
          return
        }
        if (seq === '\x1b[B') {
          subscriptionIndex = plans.length ? (subscriptionIndex + 1) % plans.length : 0
          renderScreen()
          return
        }
        if (seq === '\r' || seq === '\n') {
          const picked = plans[Math.max(0, Math.min(subscriptionIndex, plans.length - 1))]
          if (picked) {
            await executeSubscriptionPayment(picked.key)
          }
          return
        }
        return
      }

      if (mode === 'rpm-picker') {
        const plans = billingData?.rpm?.plans || []
        if (seq === '\x1b') {
          mode = 'chat'
          renderScreen()
          return
        }
        if (seq === '\x1b[A') {
          rpmIndex = plans.length ? (rpmIndex - 1 + plans.length) % plans.length : 0
          renderScreen()
          return
        }
        if (seq === '\x1b[B') {
          rpmIndex = plans.length ? (rpmIndex + 1) % plans.length : 0
          renderScreen()
          return
        }
        if (seq === '\r' || seq === '\n') {
          const picked = plans[Math.max(0, Math.min(rpmIndex, plans.length - 1))]
          if (picked) {
            await executeRpmPayment(picked.key)
          }
          return
        }
        return
      }

      // Option+Delete / Alt+Backspace / Ctrl+W: delete one word backward
      if (seq === '\x1b\x7f' || seq === '\x1b\x08' || seq === '\x17' || seq === '\x1b[3;3~') {
        isBrowsingHistory = false
        const res = deleteWordBackward(input, cursor)
        input = res.str
        cursor = res.cur
        slashIndex = 0
        renderScreen()
        return
      }

      // Option+Left / Alt+Left: jump word left
      if (seq === '\x1b[1;3D' || seq === '\x1bb') {
        cursor = jumpWordLeft(input, cursor)
        renderScreen()
        return
      }

      // Option+Right / Alt+Right: jump word right
      if (seq === '\x1b[1;3C' || seq === '\x1bf') {
        cursor = jumpWordRight(input, cursor)
        renderScreen()
        return
      }

      // Cmd+Left / Home / Ctrl+A: jump to start of line
      if (seq === '\x1b[H' || seq === '\x1b[1~' || seq === '\x01') {
        cursor = 0
        renderScreen()
        return
      }

      // Cmd+Right / End / Ctrl+E: jump to end of line
      if (seq === '\x1b[F' || seq === '\x1b[4~' || seq === '\x05') {
        cursor = input.length
        renderScreen()
        return
      }

      // Cmd+Delete / Ctrl+U: delete to start of line
      if (seq === '\x15') {
        isBrowsingHistory = false
        input = input.slice(cursor)
        cursor = 0
        slashIndex = 0
        renderScreen()
        return
      }

      const atFiles = matchingAtFiles()
      const slash = matchingSlash()

      if (seq === '\x1b[A') {
        if (atFiles.length > 0) {
          atFileIndex = (atFileIndex - 1 + atFiles.length) % atFiles.length
          renderScreen()
          return
        }
        if (slash.length > 0) {
          slashIndex = (slashIndex - 1 + slash.length) % slash.length
          renderScreen()
          return
        }
        if (promptHistory.length > 0) {
          isBrowsingHistory = true
          if (historyIndex === -1) {
            stashInput = input
            historyIndex = promptHistory.length - 1
          } else if (historyIndex > 0) {
            historyIndex -= 1
          }
          input = promptHistory[historyIndex]
          cursor = input.length
          renderScreen()
          return
        }
        return
      }

      if (seq === '\x1b[B') {
        if (atFiles.length > 0) {
          atFileIndex = (atFileIndex + 1) % atFiles.length
          renderScreen()
          return
        }
        if (slash.length > 0) {
          slashIndex = (slashIndex + 1) % slash.length
          renderScreen()
          return
        }
        if (historyIndex !== -1) {
          isBrowsingHistory = true
          if (historyIndex < promptHistory.length - 1) {
            historyIndex += 1
            input = promptHistory[historyIndex]
          } else {
            historyIndex = -1
            isBrowsingHistory = false
            input = stashInput
          }
          cursor = input.length
          renderScreen()
          return
        }
        return
      }

      if (seq === '\x1b[D') {
        cursor = Math.max(0, cursor - 1)
        renderScreen()
        return
      }
      if (seq === '\x1b[C') {
        cursor = Math.min(input.length, cursor + 1)
        renderScreen()
        return
      }
      if (seq === '\x1b') {
        if (atFiles.length > 0) {
          input = input.slice(0, cursor) + ' ' + input.slice(cursor)
          cursor += 1
          atFileIndex = 0
          renderScreen()
          return
        }
        if (input.length > 0) {
          input = ''
          cursor = 0
          slashIndex = 0
          atFileIndex = 0
          renderScreen()
          return
        }
        if (promptQueue.length > 0) {
          const count = promptQueue.length
          promptQueue.length = 0
          showNotice(`Cleared queue (${count} removed)`, 2000)
          renderScreen()
          return
        }
        if (isStreaming && abortController) {
          abortController.abort()
          promptQueue.length = 0
          showNotice('Generation cancelled')
          renderScreen()
          return
        }
        isBrowsingHistory = false
        input = ''
        cursor = 0
        slashIndex = 0
        atFileIndex = 0
        statusNotice = ''
        renderScreen()
        return
      }

      // Ctrl+V: Check clipboard image first, then text
      if (seq === '\x16') {
        const img = getClipboardImageBase64()
        if (img) {
          const tag = `[Image #${imagesStore.length + 1}]`
          imagesStore.push({ tag, base64: img.base64, mediaType: img.mediaType })
          isBrowsingHistory = false
          input = input.slice(0, cursor) + tag + input.slice(cursor)
          cursor += tag.length
          showNotice(`Pasted ${tag}`)
          return
        }
        const text = getClipboardText()
        if (text) {
          const cleanText = text.replace(/[\r\n]/g, ' ').trim()
          isBrowsingHistory = false
          input = input.slice(0, cursor) + cleanText + input.slice(cursor)
          cursor += cleanText.length
          renderScreen()
          return
        }
      }

      if (seq === '\t') {
        if (atFiles.length > 0) {
          const chosen = atFiles[Math.max(0, Math.min(atFileIndex, atFiles.length - 1))]
          const at = getAtQuery()
          if (at && chosen) {
            const beforeAt = input.slice(0, at.matchIndex)
            const afterCursor = input.slice(cursor)
            input = `${beforeAt}@${chosen} ${afterCursor}`
            cursor = beforeAt.length + chosen.length + 2
            atFileIndex = 0
            renderScreen()
          }
          return
        }
        if (slash.length > 0) {
          const chosen = slash[Math.max(0, Math.min(slashIndex, slash.length - 1))]
          input = chosen.cmd
          cursor = input.length
          slashIndex = 0
          renderScreen()
        }
        return
      }

      if (seq === '\r' || seq === '\n' || seq.endsWith('\r') || seq.endsWith('\n')) {
        if (seq.length > 1) {
          const typedPrefix = seq.slice(0, -1).replace(/[\r\n\t]/g, ' ').replace(CTRL_RE, '')
          if (typedPrefix) {
            input = input.slice(0, cursor) + typedPrefix + input.slice(cursor)
            cursor += typedPrefix.length
          }
        }
        if (atFiles.length > 0) {
          const chosen = atFiles[Math.max(0, Math.min(atFileIndex, atFiles.length - 1))]
          const at = getAtQuery()
          if (at && chosen) {
            const beforeAt = input.slice(0, at.matchIndex)
            const afterCursor = input.slice(cursor)
            input = `${beforeAt}@${chosen} ${afterCursor}`
            cursor = beforeAt.length + chosen.length + 2
            atFileIndex = 0
            renderScreen()
            return
          }
        }
        const trimmed = input.trim()
        if (!trimmed) return
        if (trimmed && (promptHistory.length === 0 || promptHistory[promptHistory.length - 1] !== trimmed)) {
          promptHistory.push(trimmed)
        }
        historyIndex = -1
        isBrowsingHistory = false
        stashInput = ''
        let itemToProcess = trimmed
        if (slash.length > 0 && trimmed.startsWith('/') && !trimmed.includes(' ')) {
          const chosen = slash[Math.max(0, Math.min(slashIndex, slash.length - 1))]
          itemToProcess = chosen.cmd
        }
        input = ''
        cursor = 0
        slashIndex = 0

        if (isStreaming || isExecutingQueue) {
          promptQueue.push(itemToProcess)
          const isCmd = itemToProcess.startsWith('/')
          showNotice(`✓ Queued ${isCmd ? 'command' : 'prompt'} (${promptQueue.length} queued)`, 2000)
          renderScreen()
          return
        }

        promptQueue.push(itemToProcess)
        await processQueue()
        return
      }

      if (seq === '\x7f' || seq === '\b') {
        isBrowsingHistory = false
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor)
          cursor -= 1
          slashIndex = 0
          atFileIndex = 0
          renderScreen()
        }
        return
      }

      // Printable text (including pasted strings and Cyrillic/UTF-8)
      isBrowsingHistory = false
      let clean = seq
        .replace(BRACKETED_PASTE_RE, '')
        .replace(/[\r\n\t]/g, ' ')
        .replace(CTRL_RE, '')
      // If user pasted a local image path (e.g. dragged image from Finder)
      const trimmedPath = clean.trim().replace(/^['"]|['"]$/g, '')
      if (/\.(png|jpe?g|webp|gif)$/i.test(trimmedPath) && existsSync(trimmedPath)) {
        try {
          const b64 = readFileSync(trimmedPath).toString('base64')
          const ext = trimmedPath.split('.').pop().toLowerCase()
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
          const tag = `[Image #${imagesStore.length + 1}]`
          imagesStore.push({ tag, base64: b64, mediaType: mime })
          clean = tag
          statusNotice = `Attached ${basename(trimmedPath)} as ${tag}`
        } catch {
          /* keep text as is */
        }
      }
      if (clean) {
        input = input.slice(0, cursor) + clean + input.slice(cursor)
        cursor += clean.length
        slashIndex = 0
        if (!statusNotice) statusNotice = ''
        renderScreen()
      }
    } catch (err) {
      showNotice(`Error: ${err?.message || err}`, 3500)
      renderScreen()
    }
  })
})
}

function completionScript(shell) {
  const allCmds = 'login logout account models use topup subscriptions rpm init update version commit-msg completion'
  if (shell === 'zsh') {
    return `#compdef apinex
_apinex() {
  local -a models subcmds
  subcmds=('login:Sign in with OAuth' 'logout:Revoke CLI session' 'account:Show balance & subscription' 'models:List active APInex models' 'use:Set default model' 'topup:Crypto balance top-up' 'subscriptions:Manage subscriptions' 'rpm:Upgrade rate limits' 'init:Create APINEX.md rules' 'update:Update APInex CLI' 'version:Show version' 'commit-msg:Generate commit message from piped diff' 'completion:Print shell completion script')
  if (( CURRENT == 2 )); then
    _describe 'command' subcmds
  fi
  if [[ "\${words[CURRENT-1]}" == "-m" || "\${words[CURRENT-1]}" == "--model" || "\${words[2]}" == "use" ]]; then
    models=(\${(f)"$(apinex __complete-models 2>/dev/null)"})
    _describe 'model' models
  fi
}
compdef _apinex apinex`
  }
  if (shell === 'fish') {
    return `complete -c apinex -f
complete -c apinex -n "__fish_use_subcommand" -a "${allCmds}"
complete -c apinex -s m -l model -xa "(apinex __complete-models 2>/dev/null)"
complete -c apinex -n "__fish_seen_subcommand_from use" -xa "(apinex __complete-models 2>/dev/null)"`
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    return `Register-ArgumentCompleter -Native -CommandName apinex -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.ToString().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($tokens.Count -ge 2 -and ($tokens[-1] -in @('-m','--model','use') -or $tokens[-2] -in @('-m','--model','use'))) {
    apinex __complete-models | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  } else {
    @(${allCmds.split(' ').map((s) => `'${s}'`).join(',')}) | Where-Object { $_ -like "$wordToComplete*" }
  }
}`
  }
  return `_apinex_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "$prev" == "-m" || "$prev" == "--model" || "$prev" == "use" ]]; then
    COMPREPLY=( $(compgen -W "$(apinex __complete-models 2>/dev/null)" -- "$cur") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "${allCmds} -m --model -v --version -h --help" -- "$cur") )
}
complete -F _apinex_completions apinex`
}

function help() {
  process.stdout.write(`APInex CLI — Autonomous AI Coding Assistant & Terminal TUI

Usage:
  apinex                            Launch full-screen APInex CLI session
  apinex -r [session-id]            Resume previous session (interactive picker if omitted)
  apinex login                      Sign in with your APInex account via browser
  apinex account                    Show live USD balance & plan usage
  apinex topup [5|10|20|50]         Direct crypto top-up via NowPayments
  apinex subscriptions [plan]       Purchase free-model subscription
  apinex rpm [30|60|100]            Upgrade RPM rate limit
  apinex init                       Initialize APINEX.md project memory & rules
  apinex update                     Update APInex CLI to latest version
  apinex models                     List active APInex catalog models
  apinex use <model-id>             Set your default model
  apinex [-m <model>] "<prompt>"    One-shot prompt (reads stdin pipe if present)
  git diff | apinex commit-msg      Generate a commit message from piped diff
  apinex logout                     Log out and revoke CLI session
`)
}

export async function main(argv) {
  let model = null
  let json = false
  let device = false
  let refresh = false
  let resumeSession = null
  let pickResume = false
  const pos = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-m' || arg === '--model') {
      model = argv[++i]
    } else if (arg.startsWith('--model=')) {
      model = arg.slice(8)
    } else if (arg === '-r' || arg === '--resume') {
      const nextArg = argv[i + 1]
      if (nextArg && !nextArg.startsWith('-')) {
        resumeSession = nextArg
        i += 1
      } else {
        pickResume = true
      }
    } else if (arg.startsWith('--resume=')) {
      const val = arg.slice(9).trim()
      if (val) resumeSession = val
      else pickResume = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--device') {
      device = true
    } else if (arg === '--refresh') {
      refresh = true
    } else if (arg === '-h' || arg === '--help') {
      help()
      return
    } else if (arg === '-v' || arg === '--version' || arg === '-V') {
      process.stdout.write(`apinex v${VERSION}\n`)
      return
    } else if (arg.startsWith('--base-url') || arg.startsWith('--provider') || arg.startsWith('--api-key')) {
      throw new Error('Custom providers and base URLs are disabled. APInex CLI uses only your APInex OAuth account.')
    } else {
      pos.push(arg)
    }
  }

  const cmd = pos[0]
  if (cmd === 'version') {
    process.stdout.write(`apinex v${VERSION}\n`)
    return
  }
  if (cmd === '__complete-models') {
    const models = await cachedOrLiveModels(false)
    for (const m of models) process.stdout.write(`${m.id}\n`)
    return
  }
  if (cmd === 'login') {
    await (device || (!process.stdout.isTTY && !process.stdin.isTTY) ? loginDevice() : loginBrowser())
    return
  }
  if (cmd === 'logout') {
    const auth = loadAuth()
    if (auth?.accessToken) {
      await fetch(`${API_ORIGIN}/api/cli/logout`, {
        method: 'POST',
        headers: { ...CLI_HEADERS, Authorization: `Bearer ${auth.accessToken}` },
      }).catch(() => undefined)
    }
    if (existsSync(authFile())) rmSync(authFile(), { force: true })
    process.stderr.write('Logged out.\n')
    return
  }
  if (cmd === 'account' || cmd === 'whoami' || cmd === 'balance') {
    const account = await fetchAccount()
    if (json) process.stdout.write(`${JSON.stringify(account, null, 2)}\n`)
    else printAccount(account)
    return
  }
  if (cmd === 'topup') {
    const rawAmt = pos[1] ? pos[1].replace(/^\$/, '') : '10'
    const amt = Number(rawAmt)
    if (![5, 10, 20, 50].includes(amt)) {
      throw new Error('Allowed top-up amounts are 5, 10, 20, or 50. E.g.: apinex topup 10')
    }
    process.stderr.write(`Creating NowPayments top-up invoice for $${amt}…\n`)
    const inv = await createTopupInvoice(amt)
    const q = inv.quote
    const bonusUsd = q?.bonusPct > 0 ? (amt * q.bonusPct) / 100 : 0
    const totalUsd = amt + bonusUsd
    const bonusStr = bonusUsd > 0 ? ` (+$${bonusUsd.toFixed(2)} bonus! +${q.bonusPct}%)` : ''
    process.stdout.write(`Invoice URL: ${inv.invoiceUrl}\nCredited:    +$${totalUsd.toFixed(2)} balance${bonusStr}\n`)
    openBrowser(inv.invoiceUrl)
    return
  }
  if (cmd === 'subscriptions' || cmd === 'subscription' || cmd === 'sub') {
    const plan = pos[1] || 'day10'
    process.stderr.write(`Creating NowPayments subscription invoice for ${plan}…\n`)
    const inv = await createSubscriptionInvoice(plan)
    process.stdout.write(`Invoice URL: ${inv.invoiceUrl}\nPlan:        ${inv.planLabel || plan} ($${inv.amountUsd})\n`)
    openBrowser(inv.invoiceUrl)
    return
  }
  if (cmd === 'rpm') {
    const rawRpm = pos[1] || '30'
    const plan = rawRpm.startsWith('plan') ? rawRpm : `plan${rawRpm}`
    process.stderr.write(`Creating NowPayments RPM invoice for ${plan}…\n`)
    const inv = await createRpmInvoice(plan)
    process.stdout.write(`Invoice URL: ${inv.invoiceUrl}\nRPM:         ${inv.rpm} RPM ($${inv.priceUsd})\n`)
    openBrowser(inv.invoiceUrl)
    return
  }
  if (cmd === 'update') {
    process.stderr.write('Checking for updates…\n')
    const info = await checkRemoteVersion(true)
    if (!info?.hasUpdate) {
      process.stdout.write(`You are already on the latest version (v${VERSION}).\n`)
      return
    }
    process.stdout.write(`New version available: v${VERSION} → v${info.latestVersion}\n`)
    if (info.changelog) process.stdout.write(`Changelog: ${info.changelog}\n`)
    process.stdout.write(`Updating APInex CLI…\n`)
    try {
      execSync('npm install -g apinex-cli@latest', { stdio: 'inherit', timeout: 60000 })
      process.stdout.write(`✓ Successfully updated to v${info.latestVersion}!\n`)
    } catch {
      try {
        execSync('npm install -g apinex@latest', { stdio: 'inherit', timeout: 60000 })
        process.stdout.write(`✓ Successfully updated to v${info.latestVersion}!\n`)
      } catch (err) {
        process.stderr.write(`Update failed: ${err.message}\nRun manually: npm install -g apinex-cli@latest\n`)
      }
    }
    return
  }
  if (cmd === 'init') {
    const target = join(process.cwd(), 'APINEX.md')
    const exists = existsSync(target)
    process.stderr.write('Scanning project and generating APINEX.md…\n')
    const content = generateApinexMd(process.cwd())
    writeFileSync(target, content, 'utf8')
    process.stdout.write(`✓ ${exists ? 'Updated' : 'Created'} ${target}\n`)
    process.stdout.write(`APInex CLI will now automatically load and follow these project guidelines on every run.\n`)
    return
  }
  if (cmd === 'models') {
    const models = await cachedOrLiveModels(refresh)
    const def = loadCfg().defaultModel
    for (const m of models) {
      const mark = m.id === def ? '*' : ' '
      const price = m.dollarsPer1M === 0 ? 'free' : `$${m.dollarsPer1M}/1M in · $${m.outputDollarsPer1M}/1M out`
      process.stdout.write(`${mark} ${m.id.padEnd(28)} ${String(m.provider || '').padEnd(10)} ${price}\n`)
    }
    return
  }
  if (cmd === 'use') {
    const next = pos[1]
    if (!next) throw new Error('Usage: apinex use <model-id>')
    const models = await cachedOrLiveModels(false)
    if (models.length && !models.some((m) => m.id === next)) {
      throw new Error(`Unknown APInex model "${next}". Run \`apinex models\` to see active models.`)
    }
    saveCfg({ defaultModel: next })
    process.stderr.write(`Default model set to ${next}\n`)
    return
  }
  if (cmd === 'completion') {
    process.stdout.write(`${completionScript(pos[1] || 'zsh')}\n`)
    return
  }

  const piped = await readStdin()
  const activeModel = model || loadCfg().defaultModel || 'deepseek-v4-flash'

  if (cmd === 'commit-msg') {
    if (!piped) throw new Error('Pipe a diff into commit-msg, e.g. `git diff --staged | apinex commit-msg`')
    const extra = pos.slice(1).join(' ').trim()
    await streamPrompt({
      model: activeModel,
      system: COMMIT_PROMPT,
      prompt: extra ? `${extra}\n\n${piped}` : piped,
    })
    printConsoleUpdateNotice(loadCachedUpdate())
    return
  }

  const question = pos.join(' ').trim()
  if (!question && !piped) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await startInteractiveTui(model, { resumeSession, pickResume })
      return
    }
    help()
    return
  }
  const prompt = question && piped ? `${question}\n\n${piped}` : question || piped
  await streamPrompt({ model: activeModel, prompt })
  printConsoleUpdateNotice(loadCachedUpdate())
}
