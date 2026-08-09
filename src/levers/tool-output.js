'use strict'

/**
 * Cap the size of tool results.
 *
 * A chatty command enters the context once and is re-uploaded on every turn
 * that follows. One accidental `find /` can cost more than the rest of the
 * session put together.
 *
 * Truncation takes from the middle: the head and tail of a command's output
 * carry the information, the belly rarely does. The elision is marked
 * explicitly so Claude knows something is missing and can ask again.
 *
 * The transform is a pure function of the content, so a given tool result is
 * truncated identically on every turn. That stability is what keeps the
 * prompt cache intact.
 */

const DEFAULTS = { maxBytes: 32 * 1024 }

function truncateText (text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return null
  const head = Math.floor(maxBytes * 0.6)
  const tail = maxBytes - head
  const start = text.slice(0, head)
  const end = text.slice(text.length - tail)
  const removedLines = text.slice(head, text.length - tail).split('\n').length
  return `${start}\n\n[cct: ${removedLines} lines elided — ask for this output again if you need it]\n\n${end}`
}

/**
 * @param body parsed request body, mutated in place
 * @returns bytes removed
 */
function apply (body, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (!body || !Array.isArray(body.messages)) return 0

  let saved = 0
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return

    if (node.type === 'tool_result') {
      if (typeof node.content === 'string') {
        const next = truncateText(node.content, opts.maxBytes)
        if (next !== null) {
          saved += Buffer.byteLength(node.content) - Buffer.byteLength(next)
          node.content = next
        }
      } else if (Array.isArray(node.content)) {
        for (const block of node.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            const next = truncateText(block.text, opts.maxBytes)
            if (next !== null) {
              saved += Buffer.byteLength(block.text) - Buffer.byteLength(next)
              block.text = next
            }
          }
        }
      }
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(body.messages)
  return saved
}

module.exports = { apply, DEFAULTS, _truncateText: truncateText }
