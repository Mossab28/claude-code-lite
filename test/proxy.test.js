'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const zlib = require('zlib')

const { Meter } = require('../src/meter')
const { Guard } = require('../src/guard')
const { createProxy } = require('../src/proxy')

/** A fake API that streams SSE events with a gap between them. */
function fakeUpstream ({ acceptGzip = true, onRequest } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let raw = Buffer.concat(chunks)
        const gzipped = req.headers['content-encoding'] === 'gzip'
        if (gzipped) {
          if (!acceptGzip) {
            res.writeHead(400, { 'content-type': 'application/json' })
            return res.end('{"type":"error","error":{"message":"could not parse body"}}')
          }
          raw = zlib.gunzipSync(raw)
        }
        onRequest?.({ raw, gzipped, headers: req.headers })

        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        setTimeout(() => {
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          res.end()
        }, 40)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function startProxy (upstreamPort, config = {}) {
  const meter = new Meter('test')
  const guard = new Guard(config.guard || {})
  const server = createProxy({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    meter,
    guard,
    config,
    onWarn: () => {},
    onStop: () => {}
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, meter, guard }))
  })
}

function post (port, body, { collectTimings = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length }
    }, (res) => {
      const events = []
      res.on('data', (c) => events.push({ at: Date.now(), text: c.toString() }))
      res.on('end', () => resolve({ status: res.statusCode, events }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('byte accounting matches what actually leaves the machine', async (t) => {
  let seen = null
  const upstream = await fakeUpstream({ onRequest: (info) => { seen = info } })
  const { server, meter } = await startProxy(upstream.address().port, { gzip: false })
  t.after(() => { server.close(); upstream.close() })

  const body = { model: 'test', messages: [{ role: 'user', content: 'hello' }] }
  const expected = Buffer.byteLength(JSON.stringify(body))

  await post(server.address().port, body)

  assert.equal(meter.requests, 1)
  assert.equal(meter.rawUp, expected)
  assert.equal(meter.sentUp, expected, 'with no lever and no compression, sent == raw')
  assert.equal(seen.raw.length, expected, 'the body arrives upstream intact')
  assert.ok(meter.down > 0, 'downloaded bytes are counted')
})

test('SSE is relayed event by event, unbuffered', async (t) => {
  const upstream = await fakeUpstream()
  const { server } = await startProxy(upstream.address().port, { gzip: false })
  t.after(() => { server.close(); upstream.close() })

  const { events } = await post(server.address().port, {
    model: 'test', messages: [{ role: 'user', content: 'x' }]
  })

  assert.ok(events.length >= 2, `expected at least 2 chunks, got ${events.length}`)
  const gap = events[events.length - 1].at - events[0].at
  assert.ok(gap >= 25, `chunks must arrive spread out, measured gap ${gap}ms`)
})

test('compression is enabled when upstream accepts it', async (t) => {
  const seen = []
  const upstream = await fakeUpstream({ onRequest: (info) => seen.push(info) })
  const { server, meter } = await startProxy(upstream.address().port)
  t.after(() => { server.close(); upstream.close() })

  const body = {
    model: 'test',
    messages: [{ role: 'user', content: 'the same sentence repeated. '.repeat(400) }]
  }
  await post(server.address().port, body)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].gzipped, true)
  assert.ok(meter.sentUp < meter.rawUp / 3, 'the compressed body must be much smaller')
  assert.equal(server.gzipState(), 'on')
})

test('compression is silently abandoned when upstream rejects it', async (t) => {
  const seen = []
  const upstream = await fakeUpstream({
    acceptGzip: false,
    onRequest: (info) => seen.push(info)
  })
  const { server } = await startProxy(upstream.address().port)
  t.after(() => { server.close(); upstream.close() })

  const body = {
    model: 'test',
    messages: [{ role: 'user', content: 'text long enough to pass the threshold. '.repeat(60) }]
  }
  const { status } = await post(server.address().port, body)

  assert.equal(status, 200, 'the client must see nothing of the failure')
  assert.equal(server.gzipState(), 'off')
  assert.equal(seen[seen.length - 1].gzipped, false, 'the retry goes out uncompressed')
})

test('the session cap stops the request instead of forwarding it', async (t) => {
  const seen = []
  const upstream = await fakeUpstream({ onRequest: (info) => seen.push(info) })
  const { server } = await startProxy(upstream.address().port, {
    gzip: false,
    guard: { capSession: 10 }
  })
  t.after(() => { server.close(); upstream.close() })

  const { status } = await post(server.address().port, {
    model: 'test', messages: [{ role: 'user', content: 'long enough to exceed ten bytes' }]
  })

  assert.equal(status, 400)
  assert.equal(seen.length, 0, 'nothing must be sent upstream')
})
