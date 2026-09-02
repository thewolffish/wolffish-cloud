#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible mock upstream for local router tests (:9090).
 * Speaks /chat/completions in both JSON and SSE (with usage in the final
 * chunk, as DeepInfra does when stream_options.include_usage is set).
 *
 * Mirrors DeepInfra's verified reasoning behaviour (live, 2026-09-01):
 * `reasoning_effort` is validated against the real enum, and any value
 * except 'none' yields a `reasoning_content` trace next to the content —
 * so the smokes can prove the router forwards the knob both ways.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9090)
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }

  if (body.reasoning_effort !== undefined && !EFFORTS.has(body.reasoning_effort)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message: "Input should be 'none', 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max'",
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: null
        }
      })
    )
    return
  }
  const reasons = body.reasoning_effort !== undefined && body.reasoning_effort !== 'none'

  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, extra = {}) =>
      `data: ${JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra
      })}\n\n`
    if (reasons) res.write(chunk({ role: 'assistant', reasoning_content: 'mock thinking. ' }))
    res.write(chunk(reasons ? { content: 'Hello ' } : { role: 'assistant', content: 'Hello ' }))
    res.write(chunk({ content: 'from mock.' }))
    res.write(`data: ${JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [],
      usage
    })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from mock.',
            ...(reasons ? { reasoning_content: 'mock thinking.' } : {})
          },
          finish_reason: 'stop'
        }
      ],
      usage
    })
  )
}).listen(PORT, () => console.log(`mock deepinfra on :${PORT}`))
