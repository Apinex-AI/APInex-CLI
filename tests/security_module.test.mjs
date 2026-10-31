import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  stripAnsi,
  sanitizeTerminalOutput,
  resolveSafePath,
  isSensitiveFile,
  isCommandSafe,
  verifyNativeBinary,
  sanitizeAppleScriptParam,
} from '../src/security.mjs'

test('Defensive Security Module (src/security.mjs)', async (t) => {
  await t.test('1. stripAnsi comprehensively strips ANSI codes', () => {
    // Null, undefined, empty handling
    assert.equal(stripAnsi(null), '')
    assert.equal(stripAnsi(undefined), '')
    assert.equal(stripAnsi(''), '')
    assert.equal(stripAnsi(123), '123')

    // CSI sequences: colors, styles, cursor positions, clears
    assert.equal(stripAnsi('\x1b[31mRed\x1b[0m'), 'Red')
    assert.equal(stripAnsi('\x1b[1;32mBold Green\x1b[0m'), 'Bold Green')
    assert.equal(stripAnsi('\x1b[?25hVisibleCursor\x1b[?25l'), 'VisibleCursor')
    assert.equal(stripAnsi('\x1b[38;2;255;100;50mRGB Color\x1b[0m'), 'RGB Color')
    assert.equal(stripAnsi('\x1b[38:2::255:100:50mColon Color\x1b[0m'), 'Colon Color')
    assert.equal(stripAnsi('\x1b[1;2HCursorPos\x1b[2K'), 'CursorPos')
    assert.equal(stripAnsi('\x1b[200~BracketedPaste\x1b[201~'), 'BracketedPaste')
    assert.equal(stripAnsi('\u009B31mC1_CSI\u009B0m'), 'C1_CSI')

    // OSC sequences: title, clipboard OSC 52, hyperlinks OSC 8
    assert.equal(stripAnsi('\x1b]0;Window Title\x07CleanText'), 'CleanText')
    assert.equal(stripAnsi('\x1b]0;Window Title\x1b\\CleanText'), 'CleanText')
    assert.equal(stripAnsi('\x1b]52;c;YWxhcm0=\x07ClipboardHijack'), 'ClipboardHijack')
    assert.equal(stripAnsi('\x1b]8;;https://example.com\x1b\\Link Text\x1b]8;;\x1b\\'), 'Link Text')
    assert.equal(stripAnsi('\u009D0;C1_OSC\x07CleanText'), 'CleanText')

    // DCS, APC, PM, SOS sequences
    assert.equal(stripAnsi('\x1bP1$q"p\x1b\\DCS_Text'), 'DCS_Text')
    assert.equal(stripAnsi('\x1b^PrivacyMessage\x07PM_Text'), 'PM_Text')
    assert.equal(stripAnsi('\x1b_ApplicationProgramCommand\x1b\\APC_Text'), 'APC_Text')
    assert.equal(stripAnsi('\x1bXStartOfString\x07SOS_Text'), 'SOS_Text')

    // Charset switches and 2-byte escapes
    assert.equal(stripAnsi('\x1b(BASCII\x1b(0Graphics'), 'ASCIIGraphics')
    assert.equal(stripAnsi('\x1b=KeypadApp\x1b>KeypadNum'), 'KeypadAppKeypadNum')
    assert.equal(stripAnsi('\x1bMReverseIndex\x1bE'), 'ReverseIndex')
    assert.equal(stripAnsi('\x1b7SaveCursor\x1b8Restore'), 'SaveCursorRestore')
    assert.equal(stripAnsi('\x1bcReset'), 'Reset')
  })

  await t.test('2. sanitizeTerminalOutput strips hijacking codes and normalizes newlines', () => {
    assert.equal(sanitizeTerminalOutput(null), '')
    assert.equal(sanitizeTerminalOutput(undefined), '')

    // Normalizes \r\n to \n and strips lone \r
    assert.equal(sanitizeTerminalOutput('Line 1\r\nLine 2\r\n'), 'Line 1\nLine 2\n')
    assert.equal(sanitizeTerminalOutput('Line 1\rLine 2 Spoofed'), 'Line 1Line 2 Spoofed')

    // Preserves \t and \n
    assert.equal(sanitizeTerminalOutput('Col 1\tCol 2\nRow 2'), 'Col 1\tCol 2\nRow 2')

    // Strips dangerous C0/C1 control codes (NUL, BEL, BS, orphaned ESC, DEL, etc.)
    assert.equal(sanitizeTerminalOutput('Text\x00With\x07Control\x08Chars\x1b\x7fEnd'), 'TextWithControlCharsEnd')

    // Strips Unicode directional override characters (Trojan Source protection)
    assert.equal(sanitizeTerminalOutput('Hello \u202EWorld\u202C'), 'Hello World')
    assert.equal(sanitizeTerminalOutput('\u200BZeroWidth\uFEFF'), 'ZeroWidth')

    // Strips DSR cursor reports and OSC 52
    assert.equal(sanitizeTerminalOutput('\x1b[6n\x1b]52;c;payload\x07Safe Output'), 'Safe Output')
  })

  await t.test('3. resolveSafePath canonicalizes and blocks escapes, .git internals, and ADS', () => {
    // Normal resolution
    const resolvedPkg = resolveSafePath('package.json')
    assert.ok(resolvedPkg.endsWith('package.json'))

    // Non-existing file with existing parent directory
    const resolvedNew = resolveSafePath('src/non_existing_file.mjs')
    assert.ok(resolvedNew.endsWith('src/non_existing_file.mjs'))

    // Directory traversal escaping workspace root
    assert.throws(() => {
      resolveSafePath('../../../etc/passwd')
    }, /escapes workspace root/)

    assert.throws(() => {
      resolveSafePath('/etc/shadow')
    }, /escapes workspace root/)

    // Null bytes rejection
    assert.throws(() => {
      resolveSafePath('package.json\0.evil')
    }, /contains null bytes/)

    // Windows Alternate Data Streams (::$DATA)
    assert.throws(() => {
      resolveSafePath('package.json::$DATA')
    }, /Windows Alternate Data Streams/)

    assert.throws(() => {
      resolveSafePath('src/file.js:stream')
    }, /Windows Alternate Data Streams/)

    // .git internal access lockdown (case-insensitive)
    assert.throws(() => {
      resolveSafePath('.git/hooks/pre-commit')
    }, /modifying \.git repository internals is forbidden/)

    assert.throws(() => {
      resolveSafePath('.GIT/config')
    }, /modifying \.git repository internals is forbidden/)

    assert.throws(() => {
      resolveSafePath('subfolder/.Git/HEAD')
    }, /modifying \.git repository internals is forbidden/)

    assert.throws(() => {
      resolveSafePath('.git')
    }, /modifying \.git repository internals is forbidden/)

    // Symlink escape outside workspace root
    const tmpRoot = join(tmpdir(), `sec_test_${Date.now()}`)
    mkdirSync(tmpRoot, { recursive: true })
    const outsideTarget = join(tmpdir(), `sec_outside_${Date.now()}`)
    mkdirSync(outsideTarget, { recursive: true })
    const symlinkPath = join(tmpRoot, 'symlink_outside')

    try {
      symlinkSync(outsideTarget, symlinkPath)
      assert.throws(() => {
        resolveSafePath('symlink_outside/evil.txt', tmpRoot)
      }, /escapes workspace root/)
    } finally {
      try { unlinkSync(symlinkPath) } catch {}
      try { rmdirSync(outsideTarget) } catch {}
      try { rmdirSync(tmpRoot) } catch {}
    }
  })

  await t.test('4. isSensitiveFile identifies workspace integrity files', () => {
    // Package manifests and lockfiles
    assert.equal(isSensitiveFile('package.json'), true)
    assert.equal(isSensitiveFile('subfolder/package.json'), true)
    assert.equal(isSensitiveFile('package-lock.json'), true)
    assert.equal(isSensitiveFile('pnpm-lock.yaml'), true)
    assert.equal(isSensitiveFile('yarn.lock'), true)
    assert.equal(isSensitiveFile('bun.lockb'), true)

    // Config & environment files
    assert.equal(isSensitiveFile('.gitignore'), true)
    assert.equal(isSensitiveFile('.npmrc'), true)
    assert.equal(isSensitiveFile('.env'), true)
    assert.equal(isSensitiveFile('.env.production'), true)
    assert.equal(isSensitiveFile('.env.local'), true)
    assert.equal(isSensitiveFile('Makefile'), true)
    assert.equal(isSensitiveFile('makefile'), true)

    // .github and .vscode directories
    assert.equal(isSensitiveFile('.github/workflows/deploy.yml'), true)
    assert.equal(isSensitiveFile('.vscode/settings.json'), true)

    // Shell scripts
    assert.equal(isSensitiveFile('deploy.sh'), true)
    assert.equal(isSensitiveFile('setup.bat'), true)
    assert.equal(isSensitiveFile('run.ps1'), true)
    assert.equal(isSensitiveFile('task.cmd'), true)

    // Git hooks
    assert.equal(isSensitiveFile('.husky/pre-commit'), true)
    assert.equal(isSensitiveFile('.githooks/post-commit'), true)

    // Normal non-sensitive files
    assert.equal(isSensitiveFile('src/index.mjs'), false)
    assert.equal(isSensitiveFile('README.md'), false)
    assert.equal(isSensitiveFile('assets/logo.png'), false)
    assert.equal(isSensitiveFile(null), false)
    assert.equal(isSensitiveFile(''), false)
  })

  await t.test('5. isCommandSafe strictly enforces read-only whitelist and blocks unsafe patterns', () => {
    // Whitelisted safe commands
    assert.equal(isCommandSafe('git status'), true)
    assert.equal(isCommandSafe('git diff'), true)
    assert.equal(isCommandSafe('git log'), true)
    assert.equal(isCommandSafe('git log -n 5'), true)
    assert.equal(isCommandSafe('git --no-pager log -n 5'), true)
    assert.equal(isCommandSafe('pwd'), true)
    assert.equal(isCommandSafe('ls'), true)
    assert.equal(isCommandSafe('ls -la'), true)
    assert.equal(isCommandSafe('npm test'), true)
    assert.equal(isCommandSafe('npm t'), true)
    assert.equal(isCommandSafe('npm run test'), true)
    assert.equal(isCommandSafe('pnpm test'), true)
    assert.equal(isCommandSafe('cargo test'), true)
    assert.equal(isCommandSafe('cargo check'), true)
    assert.equal(isCommandSafe('go test ./...'), true)
    assert.equal(isCommandSafe('pytest tests/'), true)

    // Modifying / destructive git commands
    assert.equal(isCommandSafe('git reset --hard'), false)
    assert.equal(isCommandSafe('git checkout main'), false)
    assert.equal(isCommandSafe('git commit -m "msg"'), false)
    assert.equal(isCommandSafe('git push origin main'), false)
    assert.equal(isCommandSafe('git clean -fd'), false)
    assert.equal(isCommandSafe('git rm file.txt'), false)

    // Dangerous git flags that can execute arbitrary commands
    assert.equal(isCommandSafe('git log --ext-diff'), false)
    assert.equal(isCommandSafe('git diff --output=out.txt'), false)
    assert.equal(isCommandSafe('git log -c core.pager=sh'), false)

    // Shell chaining, redirection, subshells, pipes
    assert.equal(isCommandSafe('git status; rm -rf /'), false)
    assert.equal(isCommandSafe('git status && rm -rf /'), false)
    assert.equal(isCommandSafe('git status || rm -rf /'), false)
    assert.equal(isCommandSafe('git status | grep foo'), false)
    assert.equal(isCommandSafe('git status > out.txt'), false)
    assert.equal(isCommandSafe('git status >> out.txt'), false)
    assert.equal(isCommandSafe('git status < in.txt'), false)
    assert.equal(isCommandSafe('git log $(whoami)'), false)
    assert.equal(isCommandSafe('git log `whoami`'), false)
    assert.equal(isCommandSafe('git status\nrm -rf /'), false)

    // Arbitrary network calls and dangerous binaries
    assert.equal(isCommandSafe('curl https://example.com'), false)
    assert.equal(isCommandSafe('wget https://example.com'), false)
    assert.equal(isCommandSafe('nc -lvp 4444'), false)
    assert.equal(isCommandSafe('python -c "print(1)"'), false)
    assert.equal(isCommandSafe('node -e "process.exit()"'), false)
    assert.equal(isCommandSafe('sh script.sh'), false)
    assert.equal(isCommandSafe('bash script.sh'), false)
    assert.equal(isCommandSafe('rm -rf /'), false)

    // Non-string or empty
    assert.equal(isCommandSafe(''), false)
    assert.equal(isCommandSafe(null), false)
    assert.equal(isCommandSafe(undefined), false)
  })

  await t.test('6. verifyNativeBinary validates files, architectures, and permissions', () => {
    assert.equal(verifyNativeBinary(null), false)
    assert.equal(verifyNativeBinary(''), false)
    assert.equal(verifyNativeBinary('/non/existent/path/binary'), false)

    // Directory rejection
    assert.equal(verifyNativeBinary(process.cwd()), false)

    // Create temporary files to test regular file, symlink, and world-writable permissions
    const tmpBin = join(tmpdir(), `test_bin_${Date.now()}`)
    const tmpSymlink = join(tmpdir(), `test_sym_${Date.now()}`)
    writeFileSync(tmpBin, '#!/bin/sh\necho test\n', { mode: 0o755 })

    try {
      // Regular file with 0755
      const expectedArch = (process.platform === 'darwin' && process.arch !== 'arm64') ? false : true
      assert.equal(verifyNativeBinary(tmpBin), expectedArch)

      // Symbolic link rejection
      symlinkSync(tmpBin, tmpSymlink)
      assert.equal(verifyNativeBinary(tmpSymlink), false)

      // World-writable permission rejection (0o777 has 0o002 bit set)
      chmodSync(tmpBin, 0o777)
      assert.equal(verifyNativeBinary(tmpBin), false)
    } finally {
      try { unlinkSync(tmpSymlink) } catch {}
      try { unlinkSync(tmpBin) } catch {}
    }
  })

  await t.test('7. sanitizeAppleScriptParam prevents code injection in osascript parameters', () => {
    // Safe inputs (alphanumeric and spaces)
    assert.equal(sanitizeAppleScriptParam('Glass'), 'Glass')
    assert.equal(sanitizeAppleScriptParam('Ping'), 'Ping')
    assert.equal(sanitizeAppleScriptParam('Task Finished'), 'Task Finished')
    assert.equal(sanitizeAppleScriptParam('Alert 123'), 'Alert 123')
    assert.equal(sanitizeAppleScriptParam('  Trimmed Sound  '), 'Trimmed Sound')

    // Dangerous injection attempts rejected with null
    assert.equal(sanitizeAppleScriptParam('Sound" with title "Spoof'), null)
    assert.equal(sanitizeAppleScriptParam('Glass" & do shell script "rm -rf /"'), null)
    assert.equal(sanitizeAppleScriptParam('Sound\nwith title'), null)
    assert.equal(sanitizeAppleScriptParam('Sound; do shell script'), null)
    assert.equal(sanitizeAppleScriptParam('`whoami`'), null)
    assert.equal(sanitizeAppleScriptParam('$(id)'), null)

    // Invalid / empty inputs
    assert.equal(sanitizeAppleScriptParam(null), null)
    assert.equal(sanitizeAppleScriptParam(undefined), null)
    assert.equal(sanitizeAppleScriptParam(''), null)
    assert.equal(sanitizeAppleScriptParam('   '), null)
  })
})
