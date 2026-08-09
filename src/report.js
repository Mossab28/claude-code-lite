'use strict'

const fs = require('fs')
const { LEDGER, humanBytes } = require('./meter')

const LABELS = {
  images: 'images',
  toolSchemas: 'tool schemas',
  toolResults: 'tool results',
  text: 'text'
}

const LEVER_LABELS = {
  images: 'image downscaling',
  toolOutput: 'tool-output cap'
}

function seconds (ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Average timing of a bucket, or null when it recorded nothing. */
function averages (bucket) {
  if (!bucket || !bucket.count) return null
  return {
    count: bucket.count,
    ttft: bucket.ttftMs / bucket.count,
    duration: bucket.durationMs / bucket.count
  }
}

/**
 * Time saved by the effort router, estimated from the session itself: each
 * routed turn is assumed to have taken the average duration of the unrouted
 * turns instead. Approximate by construction, but measured on this machine
 * against this workload, not invented.
 */
function estimateSavedMs (timing) {
  const routed = averages(timing?.routed)
  const base = averages(timing?.base)
  if (!routed || !base) return 0
  return Math.max(0, (base.duration - routed.duration) * routed.count)
}

/** One-session summary, printed when `ccl` exits. */
function sessionReport (row, { warnings = [], gzip = 'off' } = {}) {
  if (row.requests === 0) return ''

  const lines = []
  lines.push('')
  lines.push(`  ccl — ${row.requests} requests`)
  lines.push(`  sent      ${humanBytes(row.sentUp)}`)
  lines.push(`  received  ${humanBytes(row.down)}`)

  const saved = row.rawUp - row.sentUp
  if (saved > 0) {
    const factor = row.sentUp > 0 ? row.rawUp / row.sentUp : 1
    lines.push(`  saved     ${humanBytes(saved)} — without ccl: ${humanBytes(row.rawUp)} (${factor.toFixed(1)}x)`)
  }

  const detail = []
  if (gzip === 'on') detail.push('compression')
  for (const [name, bytes] of Object.entries(row.levers || {})) {
    if (bytes > 0) detail.push(`${LEVER_LABELS[name] || name} ${humanBytes(bytes)}`)
  }
  if (detail.length) lines.push(`  levers    ${detail.join(', ')}`)

  const routed = averages(row.timing?.routed)
  const base = averages(row.timing?.base)
  if (routed) {
    const saved = estimateSavedMs(row.timing)
    let line = `  effort    ${routed.count} turns routed down`
    if (base) {
      line += ` — avg ${seconds(routed.duration)} vs ${seconds(base.duration)} full effort`
      if (saved > 0) line += `, ~${seconds(saved)} saved`
    }
    lines.push(line)
  }

  const ranked = Object.entries(row.categories || {})
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  if (ranked.length) {
    lines.push(`  breakdown ${ranked.map(([n, b]) => `${LABELS[n] || n} ${humanBytes(b)}`).join(', ')}`)
  }

  for (const warning of warnings) lines.push(`  ! ${warning}`)
  lines.push('')
  return lines.join('\n')
}

/** History across every recorded session. */
function historyReport () {
  let rows
  try {
    rows = fs.readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return 'No sessions recorded yet. Run `ccl` once.'
  }
  if (rows.length === 0) return 'No sessions recorded yet.'

  const totals = rows.reduce((acc, row) => {
    acc.requests += row.requests || 0
    acc.sentUp += row.sentUp || 0
    acc.rawUp += row.rawUp || 0
    acc.down += row.down || 0
    return acc
  }, { requests: 0, sentUp: 0, rawUp: 0, down: 0 })

  const lines = ['']
  for (const row of rows.slice(-10)) {
    const when = (row.startedAt || '').slice(0, 16).replace('T', ' ')
    lines.push(`  ${when}  ${String(row.requests).padStart(4)} req  up ${humanBytes(row.sentUp).padStart(8)}  (raw ${humanBytes(row.rawUp)})`)
  }
  lines.push('')
  lines.push(`  ${rows.length} sessions · ${totals.requests} requests`)
  lines.push(`  sent ${humanBytes(totals.sentUp)} · received ${humanBytes(totals.down)}`)
  const saved = totals.rawUp - totals.sentUp
  if (saved > 0) lines.push(`  saved ${humanBytes(saved)} in total`)
  lines.push('')
  return lines.join('\n')
}

/** Time-savings analytics across every recorded session — `ccl gain`. */
function gainReport () {
  let rows
  try {
    rows = fs.readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return 'No sessions recorded yet. Run `ccl` once.'
  }

  const totals = {
    routed: { count: 0, ttftMs: 0, durationMs: 0 },
    base: { count: 0, ttftMs: 0, durationMs: 0 },
    savedMs: 0
  }
  for (const row of rows) {
    for (const key of ['routed', 'base']) {
      const bucket = row.timing?.[key]
      if (!bucket) continue
      totals[key].count += bucket.count || 0
      totals[key].ttftMs += bucket.ttftMs || 0
      totals[key].durationMs += bucket.durationMs || 0
    }
    totals.savedMs += estimateSavedMs(row.timing)
  }

  const routed = averages(totals.routed)
  const base = averages(totals.base)
  if (!routed && !base) {
    return 'No timing recorded yet. Run a session with this version of ccl.'
  }

  const lines = ['']
  lines.push(`  ccl gain — effort router, ${rows.length} sessions`)
  lines.push('')
  if (base) {
    lines.push(`  full effort   ${String(base.count).padStart(5)} turns · avg ${seconds(base.duration)} (TTFT ${seconds(base.ttft)})`)
  }
  if (routed) {
    lines.push(`  routed down   ${String(routed.count).padStart(5)} turns · avg ${seconds(routed.duration)} (TTFT ${seconds(routed.ttft)})`)
  } else {
    lines.push('  routed down       0 turns — no mechanical turns seen yet')
  }
  if (routed && base && totals.savedMs > 0) {
    const perTurn = (base.duration - routed.duration)
    lines.push('')
    lines.push(`  estimated time saved: ~${seconds(totals.savedMs)} total (${seconds(perTurn)} per routed turn)`)
    lines.push('  (routed turns priced at the average duration of full-effort turns)')
  }
  lines.push('')
  return lines.join('\n')
}

module.exports = { sessionReport, historyReport, gainReport }
