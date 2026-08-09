'use strict'

/**
 * Route the reasoning effort per turn.
 *
 * Claude Code runs every request at its default effort, including the turns
 * where the model has nothing to think about: it just read a file, listed a
 * directory, or ticked a todo, and the next step is obvious. On those turns
 * the thinking budget is pure latency.
 *
 * The rule is conservative by construction: a turn is downgraded only when
 * the message being answered consists exclusively of successful results from
 * read-only tools. A user message, an error, a write, or any tool we do not
 * recognize keeps the session's own effort untouched. Quality-sensitive
 * turns are therefore never affected — only the mechanical glue between them.
 */

const DEFAULTS = { level: 'medium' }

// Tools whose successful result never needs deep reasoning to be consumed.
const MECHANICAL_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TodoRead', 'NotebookRead'
])

// Effort exists on 4.6+ models. Older families reject output_config.effort.
const SUPPORTED = /(opus|sonnet)-(5|4-[678])|fable-5|mythos-5/

function supportsEffort (model) {
  return typeof model === 'string' && SUPPORTED.test(model)
}

/**
 * @returns {{ routed: boolean, from: string|undefined, to: string|undefined }}
 */
function apply (body, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const none = { routed: false }

  if (!body || !supportsEffort(body.model)) return none
  if (!Array.isArray(body.messages) || body.messages.length < 2) return none

  const last = body.messages[body.messages.length - 1]
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return none

  const results = last.content.filter((b) => b && b.type === 'tool_result')
  if (results.length === 0 || results.length !== last.content.length) return none
  if (results.some((b) => b.is_error)) return none

  // Map each result back to the tool that produced it, via the assistant
  // turn's tool_use blocks. An unmatched result means we don't know what ran,
  // so we don't touch the turn.
  const names = toolNames(body.messages)
  for (const result of results) {
    const name = names.get(result.tool_use_id)
    if (!name || !MECHANICAL_TOOLS.has(name)) return none
  }

  const current = body.output_config?.effort
  if (current === 'low' || current === opts.level) return none

  body.output_config = { ...body.output_config, effort: opts.level }
  return { routed: true, from: current, to: opts.level }
}

function toolNames (messages) {
  const names = new Map()
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_use') names.set(block.id, block.name)
    }
  }
  return names
}

module.exports = { apply, supportsEffort, MECHANICAL_TOOLS }
