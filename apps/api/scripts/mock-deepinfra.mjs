#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible mock upstream for local router tests (:9090).
 * Speaks /chat/completions in both JSON and SSE (with usage in the final
 * chunk, as DeepInfra does when stream_options.include_usage is set).
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9090)

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }

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
    res.write(chunk({ role: 'assistant', content: 'Hello ' }))
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
        { index: 0, message: { role: 'assistant', content: 'Hello from mock.' }, finish_reason: 'stop' }
      ],
      usage
    })
  )
}).listen(PORT, () => console.log(`mock deepinfra on :${PORT}`))
