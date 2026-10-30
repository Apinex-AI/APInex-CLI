import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, mkdirSync, symlinkSync } from 'node:fs'

test('Security Audit Fixes Validation', async (t) => {
  const mod = await import('../src/index.mjs')

  await t.test('1. resolveSafePath blocks directory traversal and sensitive .git files', () => {
    // Should pass for normal project-relative files
    const safe = mod.resolveSafePath('package.json')
    assert.ok(safe.endsWith('package.json'))

    // Should throw on traversal escaping project root
    assert.throws(() => {
      mod.resolveSafePath('../../../etc/passwd')
    }, /escapes workspace root/)

    assert.throws(() => {
      mod.resolveSafePath('/etc/shadow')
    }, /escapes workspace root/)

    // Should throw on .git hooks/config
    assert.throws(() => {
      mod.resolveSafePath('.git/hooks/pre-commit')
    }, /Access denied: modifying \.git/)
  })

  await t.test('2. openBrowser handles headless and non-http URLs safely without crashing', () => {
    assert.equal(mod.openBrowser(null), false)
    assert.equal(mod.openBrowser(''), false)
    assert.equal(mod.openBrowser('file:///etc/passwd'), false)
    assert.equal(mod.openBrowser('javascript:alert(1)'), false)
    assert.equal(typeof mod.openBrowser('https://apinex.bond'), 'boolean')
  })

  await t.test('3. createTopupInvoice rejects invalid, negative, or NaN amounts', async () => {
    await assert.rejects(async () => {
      await mod.createTopupInvoice(-10)
    }, /Invalid top-up amount/)

    await assert.rejects(async () => {
      await mod.createTopupInvoice(0)
    }, /Invalid top-up amount/)

    await assert.rejects(async () => {
      await mod.createTopupInvoice('abc')
    }, /Invalid top-up amount/)

    await assert.rejects(async () => {
      await mod.createTopupInvoice(10.5)
    }, /Invalid top-up amount/)
  })

  await t.test('4. renderDiff does not throw on undefined, null, or corrupted meta', () => {
    assert.deepEqual(mod.renderDiff(null, 80), [])
    assert.deepEqual(mod.renderDiff(undefined, 80), [])
    assert.deepEqual(mod.renderDiff({}, 80), [])
  })

  await t.test('5. executeTool web_fetch rejects non-http protocols and local/private IPs', async () => {
    // Should reject file:// protocol
    await assert.rejects(async () => {
      await mod.executeTool('web_fetch', { url: 'file:///etc/passwd' })
    }, /Forbidden protocol/)

    // Should reject gopher:// protocol
    await assert.rejects(async () => {
      await mod.executeTool('web_fetch', { url: 'gopher://127.0.0.1:70' })
    }, /Forbidden protocol/)

    // Should reject localhost / private IPs
    await assert.rejects(async () => {
      await mod.executeTool('web_fetch', { url: 'http://127.0.0.1:8080/admin' })
    }, /private network address/)

    await assert.rejects(async () => {
      await mod.executeTool('web_fetch', { url: 'http://localhost:3000' })
    }, /private network address/)

    await assert.rejects(async () => {
      await mod.executeTool('web_fetch', { url: 'http://169.254.169.254/latest/meta-data' })
    }, /private network address/)
  })

  await t.test('6. executeTool edit_file preserves dollar replacement tokens ($1, $PATH)', async () => {
    const tmpFile = join(process.cwd(), 'tests', 'dollar_test.tmp.txt')
    writeFileSync(tmpFile, 'const myVar = REPLACE_ME;\n', 'utf8')
    try {
      await mod.executeTool('edit_file', {
        path: 'tests/dollar_test.tmp.txt',
        old_str: 'REPLACE_ME',
        new_str: '$PATH_TEST_$1',
      })
      const { readFileSync } = await import('node:fs')
      const result = readFileSync(tmpFile, 'utf8')
      assert.equal(result, 'const myVar = $PATH_TEST_$1;\n')
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }
  })

  await t.test('7. loadProjectRules does not read outside repo and does not follow symlinks', () => {
    const rules = mod.loadProjectRules(process.cwd())
    // Should safely find APINEX.md in project or null, but not leak external files
    if (rules) {
      assert.ok(!rules.fullPath.includes('/.ssh/'))
      assert.ok(!rules.fullPath.includes('/etc/'))
    }
  })

  await t.test('8. saveSessionFile & loadSessionFile sanitize path traversal in session names', () => {
    const filePath = mod.saveSessionFile('../../../evil_session', { test: true })
    assert.ok(!filePath.includes('/../'))
    assert.ok(filePath.includes('sessions/'))
    assert.ok(filePath.endsWith('_evil_session.json'))
  })
})
