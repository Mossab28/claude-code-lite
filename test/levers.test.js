'use strict'

const test = require('node:test')
const assert = require('node:assert')

const toolOutput = require('../src/levers/tool-output')
const images = require('../src/levers/images')
const { attribute } = require('../src/meter')

function toolResultBody (text) {
  return {
    model: 'test',
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: text }]
      }
    ]
  }
}

test('the tool-output cap truncates the middle and marks the elision', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  const body = toolResultBody(text)

  const saved = toolOutput.apply(body, { maxBytes: 4096 })
  const result = body.messages[1].content[0].content

  assert.ok(saved > 0)
  assert.ok(Buffer.byteLength(result) < Buffer.byteLength(text))
  assert.ok(result.startsWith('line 0'), 'the head is kept')
  assert.ok(result.trimEnd().endsWith('line 4999'), 'the tail is kept')
  assert.match(result, /lines elided/)
})

test('truncation is stable, so the prompt cache stays valid', () => {
  const text = 'x'.repeat(200_000)
  const first = toolResultBody(text)
  const second = toolResultBody(text)

  toolOutput.apply(first, { maxBytes: 4096 })
  toolOutput.apply(second, { maxBytes: 4096 })

  assert.equal(
    first.messages[1].content[0].content,
    second.messages[1].content[0].content,
    'the same input must produce exactly the same output'
  )
})

test('output below the cap is left untouched', () => {
  const body = toolResultBody('short')
  const saved = toolOutput.apply(body, { maxBytes: 4096 })
  assert.equal(saved, 0)
  assert.equal(body.messages[1].content[0].content, 'short')
})

test('recent images are left untouched', () => {
  const makeImage = (size) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(size) }
  })
  const body = {
    messages: [
      { role: 'user', content: [makeImage(1000)] },
      { role: 'user', content: [makeImage(1000)] },
      { role: 'user', content: [makeImage(1000)] }
    ]
  }
  const before = JSON.stringify(body)
  images.apply(body, { keepRecent: 3 })
  assert.equal(JSON.stringify(body), before, 'three images, three untouched')
})

test('byte attribution splits images, schemas and tool results', () => {
  const body = {
    tools: [{ name: 'bash', description: 'd'.repeat(500) }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(2000) } },
          { type: 'tool_result', tool_use_id: 'x', content: 'r'.repeat(300) }
        ]
      }
    ]
  }
  const out = attribute(body)
  assert.equal(out.images, 2000)
  assert.ok(out.toolSchemas > 500)
  assert.ok(out.toolResults > 300)
  assert.ok(out.text > 0)
})

test('which finds an executable on PATH on any platform', () => {
  const { which } = require('../src/which')
  const found = which(process.platform === 'win32' ? 'cmd' : 'node')
  assert.ok(found, 'node must be locatable on PATH')
  assert.ok(require('fs').existsSync(found))
  assert.equal(which('definitely-not-a-real-binary-xyz'), null)
})

const effort = require('../src/levers/effort')

function agenticBody ({ tool = 'Read', isError = false, model = 'claude-opus-5', effortLevel } = {}) {
  const body = {
    model,
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: tool, input: {} }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', ...(isError ? { is_error: true } : {}) }]
      }
    ]
  }
  if (effortLevel) body.output_config = { effort: effortLevel }
  return body
}

test('the effort router downgrades a turn made only of mechanical tool results', () => {
  const body = agenticBody({ effortLevel: 'xhigh' })
  const out = effort.apply(body)
  assert.ok(out.routed)
  assert.strictEqual(body.output_config.effort, 'medium')
  assert.strictEqual(out.from, 'xhigh')
})

test('a user message keeps the session effort untouched', () => {
  const body = agenticBody({ effortLevel: 'xhigh' })
  body.messages.push({ role: 'user', content: 'now refactor everything' })
  const out = effort.apply(body)
  assert.ok(!out.routed)
  assert.strictEqual(body.output_config.effort, 'xhigh')
})

test('an errored tool result keeps full effort', () => {
  const body = agenticBody({ isError: true, effortLevel: 'xhigh' })
  assert.ok(!effort.apply(body).routed)
  assert.strictEqual(body.output_config.effort, 'xhigh')
})

test('an unknown tool keeps full effort', () => {
  const body = agenticBody({ tool: 'Bash', effortLevel: 'xhigh' })
  assert.ok(!effort.apply(body).routed)
})

test('models without effort support are never touched', () => {
  const body = agenticBody({ model: 'claude-haiku-4-5' })
  assert.ok(!effort.apply(body).routed)
  assert.strictEqual(body.output_config, undefined)
})

test('a turn already at or below the target level is left alone', () => {
  assert.ok(!effort.apply(agenticBody({ effortLevel: 'low' })).routed)
  assert.ok(!effort.apply(agenticBody({ effortLevel: 'medium' })).routed)
})

test('the router honors a configured level', () => {
  const body = agenticBody({ effortLevel: 'xhigh' })
  const out = effort.apply(body, { level: 'low' })
  assert.ok(out.routed)
  assert.strictEqual(body.output_config.effort, 'low')
})
