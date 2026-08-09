'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = path.join(os.homedir(), '.ccl')
const LEDGER = path.join(HOME, 'sessions.jsonl')
const CURRENT = path.join(HOME, 'current.json')

/**
 * Byte accounting for one `ccl` session.
 *
 * Every number here is measured off the wire, never estimated from tokens.
 * `raw` is what Claude Code handed us; `sent` is what actually left the
 * machine. The gap between them is the whole product.
 */
class Meter {
  constructor (sessionId) {
    this.sessionId = sessionId
    this.startedAt = new Date().toISOString()
    this.requests = 0
    this.rawUp = 0
    this.sentUp = 0
    this.down = 0
    // Attribution of the raw upload, so a report can name the offender.
    this.categories = { images: 0, toolSchemas: 0, toolResults: 0, text: 0 }
    // Per-lever savings, in bytes of raw body removed.
    this.levers = {}
    // Wall-clock accounting per API turn, split by whether the effort router
    // downgraded the turn. The counterfactual cannot be measured directly;
    // comparing the two populations is the honest approximation.
    this.timing = {
      routed: { count: 0, ttftMs: 0, durationMs: 0 },
      base: { count: 0, ttftMs: 0, durationMs: 0 }
    }
  }

  /** Record wall-clock timing for one successful /v1/messages turn. */
  recordTiming ({ routed, ttftMs, durationMs }) {
    const bucket = routed ? this.timing.routed : this.timing.base
    bucket.count++
    bucket.ttftMs += Math.max(0, ttftMs)
    bucket.durationMs += Math.max(0, durationMs)
    this.writeCurrent()
  }

  /** Record one request/response round-trip. */
  record ({ raw, transformed, sent, categories, savings }) {
    this.requests++
    this.rawUp += raw
    this.sentUp += sent
    if (categories) {
      for (const key of Object.keys(this.categories)) {
        this.categories[key] += categories[key] || 0
      }
    }
    if (savings) {
      for (const [name, bytes] of Object.entries(savings)) {
        this.levers[name] = (this.levers[name] || 0) + bytes
      }
    }
    this.writeCurrent()
  }

  recordDownload (bytes) {
    this.down += bytes
  }

  /** Bytes that would have gone out with no levers at all. */
  get baseline () {
    return this.rawUp
  }

  get saved () {
    return Math.max(0, this.rawUp - this.sentUp)
  }

  get ratio () {
    return this.sentUp > 0 ? this.rawUp / this.sentUp : 1
  }

  writeCurrent () {
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.writeFileSync(CURRENT, JSON.stringify({
        sessionId: this.sessionId,
        requests: this.requests,
        sentUp: this.sentUp,
        rawUp: this.rawUp,
        down: this.down
      }))
    } catch {
      // The counter is a convenience. Never let it break a session.
    }
  }

  finalize () {
    const row = {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      requests: this.requests,
      rawUp: this.rawUp,
      sentUp: this.sentUp,
      down: this.down,
      categories: this.categories,
      levers: this.levers,
      timing: this.timing
    }
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n')
      fs.rmSync(CURRENT, { force: true })
    } catch {
      // Same: a failed write must not mask the session's exit code.
    }
    return row
  }
}

/**
 * Attribute the bytes of a parsed request body to categories.
 * Approximate by construction — a JSON body has no clean partition — but
 * stable enough to rank offenders, which is all a report needs.
 */
function attribute (body) {
  const out = { images: 0, toolSchemas: 0, toolResults: 0, text: 0 }
  if (!body || typeof body !== 'object') return out

  if (Array.isArray(body.tools)) {
    out.toolSchemas = Buffer.byteLength(JSON.stringify(body.tools))
  }

  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.type === 'image' && node.source && typeof node.source.data === 'string') {
      out.images += node.source.data.length
      return
    }
    if (node.type === 'tool_result') {
      out.toolResults += Buffer.byteLength(JSON.stringify(node.content ?? ''))
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(body.messages)
  walk(body.system)

  const total = Buffer.byteLength(JSON.stringify(body))
  out.text = Math.max(0, total - out.images - out.toolSchemas - out.toolResults)
  return out
}

function humanBytes (n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

module.exports = { Meter, attribute, humanBytes, LEDGER, CURRENT, HOME }
