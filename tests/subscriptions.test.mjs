import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availableSubscriptionPlans, findSubscriptionPlan, formatCompactCap, formatPlanQuota, formatSubscriptionPlanTag, main } from '../src/index.mjs'

const plans = [
  { key: 'day10', label: '10 days', listPriceCents: 500, finalPriceCents: 500 },
  { key: 'day20', label: '20 days', listPriceCents: 1000, finalPriceCents: 1000 },
  { key: 'day30_ultra', label: '30 days', listPriceCents: 3000, finalPriceCents: 2400, discountLabel: '20% off' },
  { key: 'day30_mega', label: '30 days', listPriceCents: 10000, finalPriceCents: 8000, discountLabel: '20% off', isFeatured: true, tokenLimit: 20_000_000_000, rpmIncluded: 200 },
]
const retired = { key: 'day30_standard', label: '30 days', listPriceCents: 2000, finalPriceCents: 2000 }

test('selection uses unique live list prices and exact keys, not partial labels or discounts', () => {
  const reversed = [...plans].reverse()
  assert.equal(findSubscriptionPlan(reversed, '5')?.key, 'day10')
  assert.equal(findSubscriptionPlan(reversed, '10')?.key, 'day20')
  assert.equal(findSubscriptionPlan(reversed, '$30')?.key, 'day30_ultra')
  assert.equal(findSubscriptionPlan(reversed, '$100.00')?.key, 'day30_mega')
  assert.equal(findSubscriptionPlan(reversed, 'DAY30_MEGA')?.key, 'day30_mega')
  assert.equal(findSubscriptionPlan(reversed, '10 days')?.key, 'day10')
  for (const value of ['20', '$24', '30 days', 'days', 'day30', '', '!!!']) {
    assert.equal(findSubscriptionPlan(reversed, value), null, value)
  }
  assert.equal(findSubscriptionPlan(null, '30'), null)
  assert.equal(findSubscriptionPlan([...plans, { ...plans[2], key: 'duplicate' }], '30'), null)
  assert.equal(findSubscriptionPlan([...plans, { ...plans[2] }], 'day30_ultra'), null)
  assert.equal(findSubscriptionPlan([...plans, { ...plans[2], listPriceCents: 2400, enabled: false }], '24'), null)
})

test('retired $20 plan is never offered, even by an old server', () => {
  assert.deepEqual(availableSubscriptionPlans([...plans, retired]), plans)
  assert.equal(findSubscriptionPlan([...plans, retired], 'day30_standard'), null)
  assert.equal(findSubscriptionPlan([...plans, retired], '20'), null)
})

test('featured and discount tags coexist, and existing subscriptions keep their stored quota', () => {
  assert.equal(formatSubscriptionPlanTag(plans[3]), '[Best Value] [20% off]')
  assert.equal(formatSubscriptionPlanTag(plans[2]), '[20% off]')
  assert.equal(formatSubscriptionPlanTag(plans[0]), '')
  assert.equal(formatCompactCap(plans[3].tokenLimit), '20B')
  assert.equal(plans[3].rpmIncluded, 200)
  assert.equal(formatPlanQuota({ subscription: { label: 'Legacy $20', tokensUsed: 123456, tokenLimit: 2500000000 } }), 'Legacy $20 · 123 456/2.5B')
})

test('CLI resolves against billing options and never posts an ambiguous or missing choice', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apinex-cli-test-'))
  const previousHome = process.env.XDG_CONFIG_HOME
  const previousAppData = process.env.APPDATA
  const originalFetch = globalThis.fetch
  const requests = []
  try {
    process.env.XDG_CONFIG_HOME = tmp
    process.env.APPDATA = tmp
    mkdirSync(join(tmp, 'apinex'))
    writeFileSync(join(tmp, 'apinex', 'auth.json'), JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3600000 }))
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url, options })
      if (url.endsWith('/api/cli/billing/options')) {
        return new Response(JSON.stringify({ subscriptions: { plans: [...plans, retired] } }))
      }
      if (url.endsWith('/api/cli/billing/subscription')) {
        return new Response(JSON.stringify({ error: 'mock invoice refusal' }), { status: 400 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    await assert.rejects(main(['subscriptions']), /Specify a plan/)
    assert.equal(requests.length, 0)
    for (const choice of ['20', 'day30_standard', '30 days', '24']) {
      await assert.rejects(main(['subscriptions', choice]), /not found or ambiguous/)
    }
    assert.equal(requests.filter((r) => r.url.endsWith('/subscription')).length, 0)
    for (const [choice, key] of [['30', 'day30_ultra'], ['DAY30_MEGA', 'day30_mega'], ['10', 'day20']]) {
      await assert.rejects(main(['subscriptions', choice]), /mock invoice refusal/)
      const request = requests.at(-1)
      assert.ok(request.url.endsWith('/api/cli/billing/subscription'))
      assert.equal(JSON.parse(request.options.body).planKey, key)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousHome
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('TUI shows the mega offer and does not pay for an invalid selection', { timeout: 10000 }, async () => {
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const tmp = mkdtempSync(join(tmpdir(), 'apinex-tui-test-'))
  const seen = []
  const options = [...plans, retired].map((p) => ({
    ...p,
    kind: 'custom',
    tokenLimit: p.tokenLimit ?? 500000000,
    finalPriceUsd: p.finalPriceCents / 100,
    bonusTokens: 0,
  }))
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/cli/account') {
      res.end(JSON.stringify({ account: { user: { email: 'test@example.com' }, balanceUsd: 0 } }))
    } else if (req.url === '/api/public/models') {
      res.end(JSON.stringify({ models: [] }))
    } else if (req.url === '/api/cli/version') {
      res.end(JSON.stringify({ version: '1.0.3' }))
    } else if (req.url === '/api/cli/billing/options') {
      res.end(JSON.stringify({ subscriptions: { plans: options, activeOffer: { label: '20% off' } } }))
    } else {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Unexpected request' }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let child
  try {
    mkdirSync(join(tmp, 'apinex'))
    writeFileSync(join(tmp, 'apinex', 'auth.json'), JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3600000 }))
    const code = `import { main } from './src/index.mjs'; Object.defineProperty(process.stdin, 'isTTY', { value: true }); process.stdin.setRawMode = () => {}; Object.defineProperty(process.stdout, 'isTTY', { value: true }); process.stdout.columns = 100; process.stdout.rows = 24; await main([])`
    child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, XDG_CONFIG_HOME: tmp, APPDATA: tmp, APINEX_API_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data) => { output += data })
    const wait = async (predicate) => {
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return
        if (child.exitCode !== null) throw new Error(`TUI exited early: ${child.exitCode}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('Timed out waiting for TUI output')
    }
    await wait(() => output.includes('/help'))
    child.stdin.write('/subscriptions 30 days\r')
    await wait(() => output.includes('Plan not found or ambiguous'))
    assert.match(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""), /20B tokens · 200 RPM/)
    assert.match(output, /key: day30_mega/)
    assert.match(output, /\[Best Value\] \[20% off\]/)
    assert.doesNotMatch(output, /key: day30_standard/)
    assert.equal(seen.filter((url) => url === '/api/cli/billing/subscription').length, 0)
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
    await new Promise((resolve) => server.close(resolve))
    rmSync(tmp, { recursive: true, force: true })
  }
})
