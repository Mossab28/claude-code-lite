#!/usr/bin/env node
'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')

const { Meter } = require('../src/meter')
const { Guard } = require('../src/guard')
const { createProxy } = require('../src/proxy')
const { sessionReport, historyReport, gainReport } = require('../src/report')
const { doctor } = require('../src/doctor')

const UPSTREAM = process.env.CCL_UPSTREAM || process.env.ANTHROPIC_BASE_URL ||
  'https://api.anthropic.com'

const USAGE = `
  cct — Claude Code, faster and lighter

    cct [claude args...]   run Claude Code in turbo mode
    cct report             bandwidth per session
    cct gain               time saved by the effort router
    cct doctor             which levers are active on this machine

  cct options (everything else is passed through to claude):

    --cap <size>       session cap, default 2GB (--no-cap to remove)
    --warn <size>      warning threshold, default 500MB
    --tool-cap <size>  cap per tool result, default 32KB
    --effort <level>   effort for mechanical turns, default medium
    --no-effort        disable the effort router
    --no-images        disable image downscaling
    --no-gzip          disable request body compression
`

main()

function main () {
  const argv = process.argv.slice(2)

  if (argv[0] === 'report') return console.log(historyReport())
  if (argv[0] === 'gain') return console.log(gainReport())
  if (argv[0] === 'doctor') return console.log(doctor())
  if (argv[0] === '--help' && argv.length === 1) return console.log(USAGE)
  if (argv[0] === '--version' && argv.length === 1) {
    return console.log(require('../package.json').version)
  }

  const { config, rest } = parseArgs(argv)
  run(config, rest)
}

function parseArgs (argv) {
  const config = {
    guard: {},
    levers: {},
    gzip: true
  }
  const rest = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--cap':
        config.guard.capSession = parseSize(argv[++i]); break
      case '--no-cap':
        config.guard.capSession = 0; break
      case '--warn':
        config.guard.warnSession = parseSize(argv[++i]); break
      case '--tool-cap':
        config.levers.toolOutput = { maxBytes: parseSize(argv[++i]) }; break
      case '--effort': {
        const level = (argv[++i] || '').toLowerCase()
        if (!['low', 'medium', 'high'].includes(level)) {
          throw new Error(`cct: --effort must be low, medium, or high (got "${level}")`)
        }
        config.levers.effort = { level }; break
      }
      case '--no-effort':
        config.levers.effort = false; break
      case '--no-images':
        config.levers.images = false; break
      case '--no-gzip':
        config.gzip = false; break
      default:
        rest.push(arg)
    }
  }
  return { config, rest }
}

function parseSize (input) {
  if (!input) throw new Error('cct: missing size')
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(input.trim())
  if (!match) throw new Error(`cct: cannot parse size "${input}"`)
  const scale = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 }
  return Math.round(Number(match[1]) * (scale[(match[2] || 'b').toLowerCase()]))
}

function run (config, claudeArgs) {
  const meter = new Meter(crypto.randomUUID())
  const guard = new Guard(config.guard)
  const warnings = []
  let child = null
  let stopped = false

  const server = createProxy({
    upstream: UPSTREAM,
    meter,
    guard,
    config,
    // The TUI owns the terminal while it runs, so warnings are collected and
    // shown in the exit report rather than written over the interface.
    onWarn: (message) => warnings.push(message),
    onStop: () => {
      stopped = true
      child?.kill('SIGTERM')
    }
  })

  server.on('error', (err) => {
    console.error(`cct: the proxy failed to start — ${err.message}`)
    process.exit(1)
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()

    // On Windows `claude` is a .cmd shim, which spawn only resolves via a shell.
    child = spawn('claude', claudeArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        // Traffic that has nothing to do with the conversation.
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_BUG_COMMAND: '1',
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
        CCL_ACTIVE: '1'
      }
    })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error('cct: `claude` not found. Install Claude Code first.')
      } else {
        console.error(`cct: ${err.message}`)
      }
      server.close()
      process.exit(1)
    })

    child.on('exit', (code, signal) => {
      const row = meter.finalize()
      server.close()
      const output = sessionReport(row, { warnings, gzip: server.gzipState() })
      if (output) process.stdout.write(output + '\n')
      if (stopped) {
        process.stdout.write('  Session closed by the ccl cap. Resume with `cct --resume`.\n\n')
      }
      process.exit(signal ? 1 : (code ?? 0))
    })

    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child?.kill(sig))
    }
  })
}
