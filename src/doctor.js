'use strict'

const { spawnSync } = require('child_process')
const images = require('./levers/images')

/**
 * Report what `ccl` can and cannot do on this machine, and what the user
 * could change on their side for a further win.
 */
function doctor () {
  const lines = ['']

  const node = process.versions.node
  const nodeOk = Number(node.split('.')[0]) >= 18
  lines.push(row(nodeOk, `Node ${node}`, nodeOk ? '' : 'Node 18 or newer is required'))

  const claude = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' })
  const hasClaude = claude.status === 0 && claude.stdout.trim()
  lines.push(row(hasClaude, 'Claude Code found',
    hasClaude ? claude.stdout.trim().split('\n')[0] : 'install it before running ccl'))

  const resizer = images._findResizer()
  lines.push(row(Boolean(resizer), 'Image downscaling',
    resizer ? `using ${resizer.bin}` : 'no image tool found — lever inactive (install ImageMagick or ffmpeg)'))

  lines.push(row(true, 'Tool-output cap', '32 KB per result'))
  lines.push(row(true, 'Request body compression', 'probed on the first call, enabled if accepted'))
  lines.push(row(true, 'Connection reuse', 'keep-alive enabled'))

  lines.push('')
  lines.push('  On your Claude Code setup:')
  lines.push('')
  lines.push('  · Every active MCP server adds its tool schemas to every single')
  lines.push('    request. Turning off the ones you do not use is often the')
  lines.push('    largest win available to you.')
  lines.push('  · A higher reasoning effort lowers bandwidth: thinking costs output')
  lines.push('    tokens, flailing re-uploads the whole context on every tool call.')
  lines.push('  · `/clear` between topics costs less than one session that keeps')
  lines.push('    growing, because upload scales with the square of session length.')
  lines.push('')
  return lines.join('\n')
}

function row (ok, label, detail) {
  const mark = ok ? '+' : 'x'
  return `  ${mark} ${label}${detail ? `  —  ${detail}` : ''}`
}

module.exports = { doctor }
