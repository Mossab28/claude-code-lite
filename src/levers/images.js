'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { which } = require('../which')

/**
 * Shrink images that Claude has already looked at.
 *
 * A screenshot is 1-2 MB of base64 and the stateless API re-uploads it on
 * every subsequent turn. One screenshot at turn 20 of a 300-turn session
 * costs several hundred megabytes. This is usually the single largest line
 * in the budget.
 *
 * The rule is deliberately conservative: the most recent images pass through
 * untouched, older ones are re-encoded smaller, and nothing is ever removed.
 * Claude keeps full fidelity on what it is looking at now, and a legible
 * version of what it has already used.
 */

const DEFAULTS = { keepRecent: 3, maxWidth: 1024, quality: 70 }

// Resizing the same image on every turn would burn CPU for nothing.
const cache = new Map()

let resizer // undefined = not probed yet, null = none available

function findResizer () {
  if (resizer !== undefined) return resizer
  const candidates = [
    ...(process.platform === 'darwin' ? [{ bin: 'sips', kind: 'sips' }] : []),
    { bin: 'magick', kind: 'magick' },
    { bin: 'convert', kind: 'magick' },
    { bin: 'ffmpeg', kind: 'ffmpeg' }
  ]
  for (const candidate of candidates) {
    const found = which(candidate.bin)
    if (found) {
      resizer = { ...candidate, path: found }
      return resizer
    }
  }
  resizer = null
  return resizer
}

function extensionFor (mediaType) {
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.jpg'
}

/**
 * Re-encode one image buffer. Returns null when no resizer is available or
 * the result would not be smaller — in which case the original is kept.
 */
function shrink (buffer, mediaType, opts) {
  const tool = findResizer()
  if (!tool) return null

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-img-'))
  const input = path.join(dir, `in${extensionFor(mediaType)}`)
  const output = path.join(dir, 'out.jpg')
  try {
    fs.writeFileSync(input, buffer)
    let result
    if (tool.kind === 'sips') {
      result = spawnSync(tool.path, [
        '-Z', String(opts.maxWidth),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(opts.quality),
        input, '--out', output
      ], { encoding: 'utf8' })
    } else if (tool.kind === 'magick') {
      const args = tool.bin === 'magick' ? [input] : [input]
      result = spawnSync(tool.path, [
        ...args,
        '-resize', `${opts.maxWidth}x${opts.maxWidth}>`,
        '-quality', String(opts.quality),
        output
      ], { encoding: 'utf8' })
    } else {
      result = spawnSync(tool.path, [
        '-y', '-loglevel', 'error', '-i', input,
        '-vf', `scale='min(${opts.maxWidth},iw)':-2`,
        '-q:v', '6', output
      ], { encoding: 'utf8' })
    }
    if (result.status !== 0 || !fs.existsSync(output)) return null
    const shrunk = fs.readFileSync(output)
    if (shrunk.length >= buffer.length) return null
    return { buffer: shrunk, mediaType: 'image/jpeg' }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Collect every base64 image block in the body, in conversation order. */
function collect (body) {
  const found = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.type === 'image' && node.source &&
        node.source.type === 'base64' && typeof node.source.data === 'string') {
      found.push(node)
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(body.messages)
  return found
}

/**
 * @param body parsed request body, mutated in place
 * @returns bytes of base64 payload removed
 */
function apply (body, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (!body || !Array.isArray(body.messages)) return 0

  const images = collect(body)
  const stale = images.slice(0, Math.max(0, images.length - opts.keepRecent))
  if (stale.length === 0) return 0
  if (!findResizer()) return 0

  let saved = 0
  for (const node of stale) {
    const before = node.source.data.length
    const key = crypto.createHash('sha256')
      .update(node.source.data.slice(0, 4096))
      .update(String(before))
      .update(`${opts.maxWidth}x${opts.quality}`)
      .digest('hex')

    let replacement = cache.get(key)
    if (replacement === undefined) {
      const raw = Buffer.from(node.source.data, 'base64')
      const shrunk = shrink(raw, node.source.media_type, opts)
      replacement = shrunk
        ? { data: shrunk.buffer.toString('base64'), media_type: shrunk.mediaType }
        : null
      cache.set(key, replacement)
    }
    if (!replacement) continue

    node.source.data = replacement.data
    node.source.media_type = replacement.media_type
    saved += before - replacement.data.length
  }
  return saved
}

module.exports = { apply, DEFAULTS, _findResizer: findResizer, _cache: cache }
