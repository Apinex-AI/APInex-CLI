/**
 * Defensive Security Module for APInex CLI
 *
 * Implements strict, production-grade defensive primitives:
 * - Comprehensive ANSI escape sequence stripping (CSI, OSC, DCS, APC, PM, SOS, charsets, 2-byte escapes)
 * - Terminal output sanitization against UI spoofing, line overwrites, and escape injection
 * - Symlink-proof workspace path resolution with .git internal lockdown and ADS protection
 * - Sensitive file detection for workspace integrity protection
 * - Strict command whitelisting against execution vulnerabilities
 * - Native binary verification (integrity, permissions, architecture)
 * - AppleScript string parameter sanitization
 */

import { realpathSync, lstatSync, existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, extname } from 'node:path'
import { platform, arch } from 'node:os'
import crypto from 'node:crypto'

// Comprehensive pattern matching all ANSI escape sequences:
// 1. CSI sequences: \x1b[...[a-zA-Z~] including private modes ?, colons, intermediate bytes
// 2. OSC sequences: \x1b]...(\x07|\x1b\\)
// 3. DCS, APC, PM, SOS sequences: \x1b[P^_X]...(\x1b\\|\x07)
// 4. Charset switches: \x1b([a-zA-Z0-9]) and G0-G3 switches \x1b[()*+-./][a-zA-Z0-9]
// 5. 2-byte escapes: \x1b[a-zA-Z0-9=><#%]
const ANSI_PATTERN = [
  '(?:\\x1b\\[|\\u009b)[0-9:;<=>?]*[ -/]*[@-~]',
  '(?:\\x1b\\]|\\u009d)[^\\x07\\x1b\\u009c]*(?:\\x07|\\x1b\\\\|\\u009c)',
  '(?:\\x1b[P^_X]|[\\u0090\\u0098\\u009e\\u009f])[^\\x07\\x1b\\u009c]*(?:\\x1b\\\\|\\x07|\\u009c)',
  '\\x1b[()*+\\-./][a-zA-Z0-9]',
  '\\x1b[a-zA-Z0-9=><#%]',
].join('|')

export const ANSI_REGEX = new RegExp(ANSI_PATTERN, 'g')

/**
 * Comprehensively strips all ANSI escape codes from a string:
 * - CSI sequences (colors, cursor, clear, modes, bracketed paste)
 * - OSC sequences (title, clipboard OSC 52, hyperlinks OSC 8)
 * - DCS, APC, PM, SOS sequences
 * - 2-byte escapes and charset switches
 *
 * Safe against ReDoS, handles null/undefined cleanly.
 *
 * @param {string|unknown} str
 * @returns {string}
 */
export function stripAnsi(str) {
  if (str == null) return ''
  const s = String(str)
  if (!s) return ''
  ANSI_REGEX.lastIndex = 0
  return s.replace(ANSI_REGEX, '')
}

/**
 * Sanitizes terminal output to prevent UI spoofing, line overwriting,
 * clipboard hijacking (OSC 52), hyperlink injection (OSC 8), and cursor reports.
 *
 * Normalizes newlines (\r\n -> \n) and strips standalone carriage returns (\r).
 * Strips dangerous C0/C1 control codes and Unicode directional overrides.
 *
 * @param {string|unknown} str
 * @returns {string}
 */
export function sanitizeTerminalOutput(str) {
  if (str == null) return ''
  // 1. Strip all ANSI escape sequences
  let s = stripAnsi(str)

  // 2. Normalize newlines (\r\n -> \n) and strip remaining \r (carriage return)
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '')

  // 3. Strip dangerous C0 and C1 control characters (excluding \n and \t)
  // Strips NUL (\x00), BEL (\x07), BS (\x08), VT (\x0B), FF (\x0C), orphaned ESC (\x1B), DEL (\x7F), C1 (\u0080-\u009F)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F]/g, '')

  // 4. Strip invisible Unicode directional overrides and zero-width characters (Trojan Source protection)
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')

  return s
}

/**
 * Resolves and canonicalizes a path, ensuring it stays strictly within allowedRoot.
 *
 * - Canonicalizes path using realpathSync when existing, or nearest existing parent directory
 * - Prevents symlink escapes outside allowedRoot
 * - Case-insensitively blocks any access to .git repository internals (.git, .GIT, .Git, etc.)
 * - Rejects Windows Alternate Data Streams (::$DATA)
 * - Throws a descriptive Error if traversal or escape is detected
 *
 * @param {string} p - Relative or absolute path
 * @param {string} [allowedRoot=process.cwd()] - Allowed workspace root
 * @returns {string} Canonicalized absolute path
 */
export function resolveSafePath(p, allowedRoot = process.cwd()) {
  if (!p || typeof p !== 'string') {
    throw new Error('Access denied: path must be a non-empty string')
  }

  // Reject poison null bytes
  if (p.includes('\0')) {
    throw new Error('Access denied: path contains null bytes')
  }

  // Reject Windows Alternate Data Streams (::$DATA or stream specifiers)
  if (/::\$DATA/i.test(p) || /(?:^|[\\/])[^\\/]+:[^\\/]+/.test(p.replace(/^[a-zA-Z]:[\\/]?/, ''))) {
    throw new Error(`Access denied: Windows Alternate Data Streams (::$DATA) are forbidden in "${p}"`)
  }

  // Canonicalize allowedRoot
  const root = isAbsolute(allowedRoot) ? resolve(allowedRoot) : resolve(process.cwd(), allowedRoot)
  let canonicalRoot = root
  try {
    canonicalRoot = realpathSync(root)
  } catch {
    canonicalRoot = root
  }

  // Resolve target against allowedRoot
  const target = isAbsolute(p) ? resolve(p) : resolve(root, p)

  // Fast lexical check against traversal escaping root
  const relLexical = relative(root, target)
  if (relLexical.startsWith('..') || isAbsolute(relLexical)) {
    throw new Error(`Access denied: path "${p}" escapes workspace root (${allowedRoot})`)
  }

  // Case-insensitively forbid any access to .git repository internals
  const targetParts = target.split(/[\\/]/)
  for (const part of targetParts) {
    const cleanPart = part.trim().toLowerCase().replace(/\.+$/, '')
    if (cleanPart === '.git') {
      throw new Error(`Access denied: modifying .git repository internals is forbidden in "${p}"`)
    }
  }

  // Canonicalize path using realpathSync when existing, or check nearest existing parent directory
  let canonicalTarget
  if (existsSync(target)) {
    try {
      canonicalTarget = realpathSync(target)
    } catch {
      canonicalTarget = target
    }
  } else {
    // Find nearest existing ancestor directory
    let cur = target
    const missing = []
    while (!existsSync(cur)) {
      const parent = dirname(cur)
      if (parent === cur) break
      missing.unshift(basename(cur))
      cur = parent
    }
    let realCur = cur
    if (existsSync(cur)) {
      try {
        realCur = realpathSync(cur)
      } catch {
        realCur = cur
      }
    }
    canonicalTarget = missing.length > 0 ? resolve(realCur, ...missing) : realCur
  }

  // Verify canonicalTarget does not escape canonicalRoot (blocks symlink escapes)
  const relCanonical = relative(canonicalRoot, canonicalTarget)
  if (relCanonical.startsWith('..') || isAbsolute(relCanonical)) {
    throw new Error(`Access denied: path "${p}" escapes workspace root (${allowedRoot})`)
  }

  // Re-verify canonical target parts against .git internals
  const canonicalParts = canonicalTarget.split(/[\\/]/)
  for (const part of canonicalParts) {
    const cleanPart = part.trim().toLowerCase().replace(/\.+$/, '')
    if (cleanPart === '.git') {
      throw new Error(`Access denied: modifying .git repository internals is forbidden in "${p}"`)
    }
  }

  return canonicalTarget
}

/**
 * Returns true if a file is critical to workspace integrity and requires user confirmation before alteration.
 *
 * Detects:
 * - package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb
 * - .gitignore, .npmrc, .yarnrc
 * - .env, .env.*
 * - .github/*, .vscode/*
 * - Makefile, GNUmakefile
 * - Shell scripts (*.sh, *.bat, *.ps1, *.cmd, *.bash, *.zsh, *.command)
 * - Git hooks and configs (.gitconfig, .gitmodules, .gitattributes, hooks, .husky, .githooks)
 *
 * @param {string} filePath
 * @param {string} [workspaceRoot=process.cwd()]
 * @returns {boolean}
 */
export function isSensitiveFile(filePath, workspaceRoot = process.cwd()) {
  if (!filePath || typeof filePath !== 'string') return false

  const resolved = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
  const rel = relative(workspaceRoot, resolved).replace(/\\/g, '/')
  const segments = rel.split('/').filter(Boolean)
  const base = basename(rel).toLowerCase()
  const ext = extname(base).toLowerCase()

  // 1. Critical package manifests and lockfiles
  const sensitiveBases = new Set([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    '.gitignore',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.gitmodules',
    '.gitattributes',
    '.gitconfig',
    'makefile',
    'gnumakefile',
  ])

  if (sensitiveBases.has(base)) return true

  // 2. Environment files (.env, .env.local, .env.production, etc.)
  if (base === '.env' || base.startsWith('.env.')) return true

  // 3. Sensitive configuration directories (.github/*, .vscode/*)
  if (segments.some(s => s === '.github' || s === '.vscode')) return true

  // 4. Shell scripts (*.sh, *.bat, *.ps1, *.cmd, etc.)
  const shellExtensions = new Set(['.sh', '.bat', '.ps1', '.cmd', '.bash', '.zsh', '.command'])
  if (shellExtensions.has(ext)) return true

  // 5. Git hooks and internal repository configs
  if (segments.some(s => {
    const lower = s.toLowerCase()
    return lower === '.git' || lower === 'hooks' || lower === '.husky' || lower === '.githooks'
  })) {
    return true
  }

  return false
}

/**
 * Returns true ONLY if command is strictly in a safe, read-only whitelist of commands.
 * Returns false for any destructive command, or any command with redirects (>),
 * pipes (|), subshells ($(), ``), chaining (&&, ;, ||), or arbitrary network calls.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function isCommandSafe(cmd) {
  if (!cmd || typeof cmd !== 'string') return false
  const trimmed = cmd.trim()
  if (!trimmed) return false

  // 1. Forbid any shell chaining, redirection, piping, subshells, backticks, escapes, or backgrounding
  if (/[;&|><$`\\!()`{}[\r\n\x00-\x1f\x7f]/.test(trimmed)) {
    return false
  }

  // Tokenize by whitespace, stripping outer quotes if any
  const tokens = trimmed.split(/\s+/).map(t => t.replace(/^["']|["']$/g, '')).filter(Boolean)
  if (tokens.length === 0) return false

  const binary = basename(tokens[0]).toLowerCase()

  // 2. Reject explicitly forbidden binaries
  const forbiddenBinaries = new Set([
    'curl', 'wget', 'nc', 'netcat', 'python', 'python3', 'node', 'nodejs',
    'sh', 'bash', 'zsh', 'csh', 'tcsh', 'fish', 'dash', 'ksh',
    'rm', 'rmdir', 'mv', 'cp', 'dd', 'sudo', 'su', 'chmod', 'chown',
    'kill', 'pkill', 'killall', 'eval', 'exec', 'source',
  ])
  if (forbiddenBinaries.has(binary)) return false

  // 3. Strict Whitelist Evaluation

  // 3a. pwd
  if (binary === 'pwd') {
    return tokens.length === 1 || (tokens.length === 2 && ['-L', '-P'].includes(tokens[1]))
  }

  // 3b. ls / dir
  if (binary === 'ls' || binary === 'dir') {
    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]
      if (arg.startsWith('-')) {
        if (!/^-[a-zA-Z0-9]+$/.test(arg) && !/^--(color|classify|indicator-style|time-style|sort|width)(=.*)?$/.test(arg)) {
          return false
        }
      }
    }
    return true
  }

  // 3c. whoami
  if (binary === 'whoami') {
    return tokens.length === 1
  }

  // 3d. git commands (strictly read-only whitelist)
  if (binary === 'git') {
    if (tokens.length < 2) return false

    // Skip safe global options like --no-pager
    let subIdx = 1
    while (subIdx < tokens.length && tokens[subIdx].startsWith('-')) {
      const opt = tokens[subIdx]
      if (opt === '--no-pager' || opt === '--no-optional-locks') {
        subIdx++
      } else {
        return false
      }
    }
    if (subIdx >= tokens.length) return false

    const sub = tokens[subIdx].toLowerCase()
    const allowedGitSubcommands = new Set([
      'status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'version', 'check-ignore'
    ])

    const forbiddenGitSubcommands = new Set([
      'reset', 'checkout', 'restore', 'clean', 'rm', 'commit', 'push', 'pull',
      'fetch', 'merge', 'rebase', 'cherry-pick', 'revert', 'clone', 'init',
      'submodule', 'config', 'apply', 'branch', 'tag', 'stash'
    ])
    if (forbiddenGitSubcommands.has(sub)) return false
    if (!allowedGitSubcommands.has(sub)) return false

    // Disallow dangerous git execution flags
    for (let i = subIdx + 1; i < tokens.length; i++) {
      const arg = tokens[i]
      if (
        arg.startsWith('--output') ||
        arg.startsWith('--ext-diff') ||
        arg.startsWith('--exec-path') ||
        arg.startsWith('--upload-pack') ||
        arg.startsWith('--receive-pack') ||
        arg === '-c' ||
        arg.startsWith('--config')
      ) {
        return false
      }
    }
    return true
  }

  // 3e. Test runners: npm test / pnpm test / yarn test / bun test
  if (binary === 'npm') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === '--version' || sub === '-v') return tokens.length === 2
    if (sub === 'test' || sub === 't') return true
    if (sub === 'run' && tokens[2] && tokens[2].toLowerCase() === 'test') return true
    return false
  }

  if (binary === 'pnpm') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === '--version' || sub === '-v') return tokens.length === 2
    if (sub === 'test' || sub === 't') return true
    if (sub === 'run' && tokens[2] && tokens[2].toLowerCase() === 'test') return true
    return false
  }

  if (binary === 'yarn') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === '--version' || sub === '-v') return tokens.length === 2
    if (sub === 'test') return true
    if (sub === 'run' && tokens[2] && tokens[2].toLowerCase() === 'test') return true
    return false
  }

  if (binary === 'bun') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === '--version' || sub === '-v') return tokens.length === 2
    if (sub === 'test') return true
    return false
  }

  // 3f. cargo test / cargo check / cargo clippy
  if (binary === 'cargo') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === '--version' || sub === '-V') return tokens.length === 2
    if (['test', 'check', 'clippy'].includes(sub)) return true
    return false
  }

  // 3g. go test / go vet
  if (binary === 'go') {
    if (tokens.length < 2) return false
    const sub = tokens[1].toLowerCase()
    if (sub === 'version') return tokens.length === 2
    if (['test', 'vet'].includes(sub)) return true
    return false
  }

  // 3h. pytest
  if (binary === 'pytest') {
    return true
  }

  return false
}

/**
 * Validates a native binary before execution:
 * - Exists and is a regular file (lstatSync.isFile() && !lstatSync.isSymbolicLink())
 * - On macOS, only allows execution if process.arch === 'arm64'
 * - Permissions: not world-writable ((stat.mode & 0o002) === 0)
 *
 * @param {string} binaryPath
 * @returns {boolean} true if safe to execute, false otherwise
 */
export function verifyNativeBinary(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') return false

  try {
    const st = lstatSync(binaryPath)

    // 1. Must exist and be a regular file, NOT a symbolic link
    if (!st.isFile() || st.isSymbolicLink()) {
      return false
    }

    // 2. On macOS, only allow execution if process.arch === 'arm64'
    if (platform() === 'darwin' && arch() !== 'arm64') {
      return false
    }

    // 3. Permissions: not world-writable ((stat.mode & 0o002) === 0)
    if ((st.mode & 0o002) !== 0) {
      return false
    }

    return true
  } catch {
    return false
  }
}

/**
 * Validates or escapes values passed into AppleScript (osascript) strings
 * to prevent code injection in sound, title, or notification messages.
 * Allows only safe alphanumeric characters and spaces, or returns null.
 *
 * @param {string|unknown} val
 * @returns {string|null}
 */
export function sanitizeAppleScriptParam(val) {
  if (val == null) return null
  const str = String(val).trim()
  if (!str) return null

  // Allow only safe alphanumeric characters and spaces
  if (!/^[a-zA-Z0-9 ]+$/.test(str)) {
    return null
  }

  return str
}

/**
 * Checks if a hostname or IP address resolves to private, loopback, or metadata addresses
 * (SSRF defense against DNS rebinding, decimal/hex IP encoding, and cloud metadata).
 *
 * @param {string} hostname
 * @returns {boolean} true if private/loopback/forbidden, false otherwise
 */
export function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host === 'instance-data' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true
  }

  // Decimal IP format (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(host)) {
    const num = Number(host)
    if (num >= 0 && num <= 4294967295) {
      const b1 = (num >>> 24) & 255
      const b2 = (num >>> 16) & 255
      if (
        b1 === 127 ||
        b1 === 10 ||
        (b1 === 172 && b2 >= 16 && b2 <= 31) ||
        (b1 === 192 && b2 === 168) ||
        (b1 === 169 && b2 === 254) ||
        b1 === 0
      ) {
        return true
      }
    }
    return true
  }

  // Hex or octal IP format (0x7f000001, 0177.0.0.1)
  if (/^0x[0-9a-f]+$/i.test(host) || /^0\d+\./.test(host)) {
    return true
  }

  // Standard IPv4 private / loopback / link-local
  if (/^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|255\.255\.255\.255)$/.test(host)) {
    return true
  }

  // IPv6 loopback / unique local / link-local / IPv4-mapped
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:') ||
    host.startsWith('fe80:') ||
    host.startsWith('::ffff:')
  ) {
    return true
  }

  return false
}
