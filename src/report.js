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

module.exports = { sessionReport, historyReport }
