#!/usr/bin/env node
import { main } from '../src/index.mjs'

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
})
process.stderr.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
})

main(process.argv.slice(2)).catch((err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  try {
    process.stdout.write('\x1b[?7h\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch { /* ignore */ }
  const message = process.env.DEBUG ? (err?.stack || err?.message) : (err?.message || String(err))
  process.stderr.write(`apinex: ${message}\n`)
  process.exit(1)
})
