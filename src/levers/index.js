'use strict'

const images = require('./images')
const toolOutput = require('./tool-output')

/**
 * Apply every enabled lever to a parsed request body.
 *
 * Order matters only for accounting: each lever reports the bytes it removed
 * from the body it was handed, so the numbers stay additive.
 *
 * @returns {{ savings: Record<string, number>, total: number }}
 */
function applyAll (body, config = {}) {
  const savings = {}
  let total = 0

  if (config.images !== false) {
    const saved = images.apply(body, config.images || {})
    if (saved > 0) savings.images = saved
    total += saved
  }

  if (config.toolOutput !== false) {
    const saved = toolOutput.apply(body, config.toolOutput || {})
    if (saved > 0) savings.toolOutput = saved
    total += saved
  }

  return { savings, total }
}

module.exports = { applyAll, images, toolOutput }
