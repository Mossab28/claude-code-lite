'use strict'

const { humanBytes } = require('./meter')

/**
 * Runaway protection.
 *
 * On by default, with thresholds wide enough that a normal session never
 * meets them. The guard exists to stop a session that has gone wrong, not to
 * ration a session that is going well.
 *
 * It never touches the conversation. Injecting an instruction into the prompt
 * to save bandwidth would degrade the reasoning, which is the opposite of the
 * point.
 */

const DEFAULTS = {
  warnSession: 500 * 1024 * 1024,
  capSession: 2 * 1024 * 1024 * 1024,
  warnRequest: 5 * 1024 * 1024
}

class Guard {
  constructor (options = {}) {
    this.opts = { ...DEFAULTS, ...options }
    this.warnedSession = false
    this.warnedRequest = false
  }

  /**
   * @returns {{ stop: boolean, warnings: string[] }}
   */
  check ({ sessionBytes, requestBytes, categories }) {
    const warnings = []

    if (this.opts.warnRequest && requestBytes > this.opts.warnRequest && !this.warnedRequest) {
      this.warnedRequest = true
      warnings.push(
        `${humanBytes(requestBytes)} request — ${describeOffender(categories)}`
      )
    }

    if (this.opts.warnSession && sessionBytes > this.opts.warnSession && !this.warnedSession) {
      this.warnedSession = true
      warnings.push(
        `${humanBytes(sessionBytes)} uploaded this session (cap: ${humanBytes(this.opts.capSession)})`
      )
    }

    const stop = Boolean(this.opts.capSession) && sessionBytes >= this.opts.capSession
    return { stop, warnings }
  }
}

function describeOffender (categories) {
  if (!categories) return 'large context'
  const ranked = Object.entries(categories).sort((a, b) => b[1] - a[1])
  const [name, bytes] = ranked[0] || []
  const labels = {
    images: 'images',
    toolSchemas: 'tool schemas',
    toolResults: 'tool results',
    text: 'conversation text'
  }
  if (!name || !bytes) return 'large context'
  return `mostly ${labels[name] || name} (${humanBytes(bytes)})`
}

module.exports = { Guard, DEFAULTS }
