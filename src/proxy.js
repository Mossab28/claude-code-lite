'use strict'

const http = require('http')
const https = require('https')
const zlib = require('zlib')
const { URL } = require('url')

const { attribute, humanBytes } = require('./meter')
const { applyAll } = require('./levers')
const effort = require('./levers/effort')

/**
 * The local proxy that sits between Claude Code and the API.
 *
 * Two rules govern everything here:
 *
 *  - Headers are forwarded verbatim. Authentication passes straight through
 *    and is never read, stored, or logged.
 *  - The response is relayed unbuffered, chunk by chunk. Buffering would kill
 *    the streaming and make the tool unusable, which no amount of saved
 *    bandwidth would justify.
 */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'
])

function createProxy ({ upstream, meter, guard, config = {}, onStop, onWarn }) {
  const target = new URL(upstream)
  const transport = target.protocol === 'http:' ? http : https

  // Connection reuse: a TLS handshake costs ~6 KB, and a long session makes
  // hundreds of requests.
  const agent = new transport.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 8
  })

  // 'probe' until the API tells us whether it accepts a compressed body.
  let gzipState = config.gzip === false ? 'off' : 'probe'

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('error', () => res.destroy())
    req.on('end', () => {
      handle(Buffer.concat(chunks)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
        }
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `ccl proxy: ${err.message}` }
        }))
      })
    })

    async function handle (rawBody) {
      const rawSize = rawBody.length
      let outgoing = rawBody
      let savings = null
      let categories = null
      let effortRoute = null

      // Only /v1/messages carries a body worth transforming. Anything else is
      // forwarded untouched.
      const isJson = (req.headers['content-type'] || '').includes('application/json')
      if (isJson && rawSize > 0) {
        try {
          const body = JSON.parse(rawBody.toString('utf8'))
          categories = attribute(body)
          const applied = applyAll(body, config.levers || {})
          const routed = config.levers?.effort === false
            ? { routed: false }
            : effort.apply(body, config.levers?.effort || {})
          if (routed.routed) effortRoute = routed
          if (applied.total > 0 || routed.routed) {
            outgoing = Buffer.from(JSON.stringify(body), 'utf8')
            savings = applied.savings
          }
        } catch {
          // Not the shape we expected. Forward it exactly as received.
        }
      }

      const verdict = guard.check({
        sessionBytes: meter.sentUp + outgoing.length,
        requestBytes: outgoing.length,
        categories
      })
      for (const warning of verdict.warnings) onWarn?.(warning)
      if (verdict.stop) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `ccl: session cap reached (${humanBytes(meter.sentUp)}). ` +
              'Session closed. Resume with `ccl --resume`, or raise the cap with --cap.'
          }
        }))
        onStop?.(meter.sentUp)
        return
      }

      await forward(outgoing, { rawSize, savings, categories, effortRoute })
    }

    function buildHeaders (bodyBuffer, compressed) {
      const headers = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value
      }
      headers.host = target.host
      headers['content-length'] = String(bodyBuffer.length)
      if (compressed) headers['content-encoding'] = 'gzip'
      else delete headers['content-encoding']
      return headers
    }

    function forward (bodyBuffer, accounting, { allowRetry = true } = {}) {
      const compress = gzipState !== 'off' && bodyBuffer.length > 1024
      const payload = compress ? zlib.gzipSync(bodyBuffer, { level: 6 }) : bodyBuffer
      const startedAt = Date.now()
      let firstByteAt = 0

      return new Promise((resolve, reject) => {
        const upstreamReq = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          path: joinPath(target.pathname, req.url),
          method: req.method,
          headers: buildHeaders(payload, compress),
          agent
        }, (upstreamRes) => {
          // The compression probe: if the API rejects a compressed body, it
          // does so before streaming anything, so a silent retry is safe.
          const rejectedCompression = compress && gzipState === 'probe' &&
            upstreamRes.statusCode >= 400 && upstreamRes.statusCode !== 401 &&
            upstreamRes.statusCode !== 403 && upstreamRes.statusCode !== 429
          if (rejectedCompression && allowRetry) {
            upstreamRes.resume()
            gzipState = 'off'
            forward(bodyBuffer, accounting, { allowRetry: false }).then(resolve, reject)
            return
          }
          if (compress && gzipState === 'probe' && upstreamRes.statusCode < 400) {
            gzipState = 'on'
          }

          meter.record({
            raw: accounting.rawSize,
            transformed: bodyBuffer.length,
            sent: payload.length,
            categories: accounting.categories,
            savings: accounting.savings
          })
          const timed = Boolean(accounting.categories) && upstreamRes.statusCode < 400

          const headers = {}
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value
          }
          res.writeHead(upstreamRes.statusCode, headers)
          res.socket?.setNoDelay(true)

          upstreamRes.on('data', (chunk) => {
            if (!firstByteAt) firstByteAt = Date.now()
            meter.recordDownload(chunk.length)
            res.write(chunk)
            res.flushHeaders?.()
          })
          upstreamRes.on('end', () => {
            if (timed) {
              meter.recordTiming({
                routed: Boolean(accounting.effortRoute?.routed),
                ttftMs: (firstByteAt || Date.now()) - startedAt,
                durationMs: Date.now() - startedAt
              })
            }
            res.end()
            resolve()
          })
          upstreamRes.on('error', reject)
        })

        upstreamReq.on('error', reject)
        upstreamReq.end(payload)
      })
    }
  })

  server.gzipState = () => gzipState
  return server
}

function joinPath (basePath, requestUrl) {
  const base = basePath.replace(/\/$/, '')
  return base ? base + requestUrl : requestUrl
}

module.exports = { createProxy }
