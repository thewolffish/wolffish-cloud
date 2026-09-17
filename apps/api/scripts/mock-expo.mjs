#!/usr/bin/env node
/**
 * Mock Expo push service for the local notification lane (:9094).
 *
 * Speaks the two endpoints exp.host does — POST /--/api/v2/push/send and
 * POST /--/api/v2/push/getReceipts — including the one shape that makes real
 * push so easy to get wrong: BOTH answer HTTP 200 while reporting per-message
 * failure in the body. A client that reads `res.ok` as success sees nothing
 * but green here, which is exactly the bug this mock exists to catch.
 *
 * It also enforces the authorization header the real service enforces when a
 * project has Enhanced Security for Push Notifications switched on (the org's
 * does): no bearer token, or the wrong one, and every call answers 401.
 *
 * The OUTCOME is chosen by the push token, so one smoke run can walk every
 * branch without waiting for a real handset to fail:
 *
 *   ExponentPushToken[mock-ok]        ticket ok  → receipt ok
 *   ExponentPushToken[mock-dead]      ticket error DeviceNotRegistered
 *   ExponentPushToken[mock-badcreds]  ticket ok  → receipt InvalidCredentials
 *   ExponentPushToken[mock-toobig]    ticket error MessageTooBig
 *   anything else                     ticket ok  → receipt ok
 *
 * GET /stats reports what arrived (and the last batch, so a test can assert
 * the priority, channelId and data fields the phone depends on); POST /reset
 * clears it.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9094)
const TOKEN = process.env.MOCK_EXPO_TOKEN ?? 'mock-expo-token'

let sends = 0
let receiptCalls = 0
let lastBatch = []
/** ticketId → the receipt it will answer with. */
const receipts = new Map()
let nextTicket = 1

const outcomeFor = (to) => {
  if (typeof to !== 'string') return 'ok'
  if (to.includes('mock-dead')) return 'dead'
  if (to.includes('mock-badcreds')) return 'badcreds'
  if (to.includes('mock-toobig')) return 'toobig'
  return 'ok'
}

const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

const body = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || 'null'))
      } catch {
        resolve(null)
      }
    })
  })

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/stats') {
    return json(res, 200, {
      sends,
      receiptCalls,
      lastBatch,
      pending: receipts.size
    })
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    sends = 0
    receiptCalls = 0
    lastBatch = []
    receipts.clear()
    return json(res, 200, { ok: true })
  }

  // Enhanced Security: the header is not optional, and the failure is total.
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${TOKEN}`) {
    return json(res, 401, {
      errors: [{ code: 'UNAUTHORIZED', message: 'unauthorized' }]
    })
  }

  if (req.method === 'POST' && url.pathname === '/--/api/v2/push/send') {
    const messages = await body(req)
    if (!Array.isArray(messages)) return json(res, 400, { errors: [{ code: 'BAD_REQUEST' }] })
    sends += 1
    lastBatch = messages
    const data = messages.map((message) => {
      const outcome = outcomeFor(message?.to)
      if (outcome === 'dead') {
        return {
          status: 'error',
          message: '"ExponentPushToken[…]" is not a registered push notification recipient',
          details: { error: 'DeviceNotRegistered' }
        }
      }
      if (outcome === 'toobig') {
        return {
          status: 'error',
          message: 'message too big',
          details: { error: 'MessageTooBig' }
        }
      }
      const id = `mock-ticket-${nextTicket++}`
      receipts.set(
        id,
        outcome === 'badcreds'
          ? {
              status: 'error',
              message: 'could not find FCM credentials',
              details: { error: 'InvalidCredentials' }
            }
          : { status: 'ok' }
      )
      return { status: 'ok', id }
    })
    // 200, with the failures inside — the whole point.
    return json(res, 200, { data })
  }

  if (req.method === 'POST' && url.pathname === '/--/api/v2/push/getReceipts') {
    const payload = await body(req)
    receiptCalls += 1
    const ids = Array.isArray(payload?.ids) ? payload.ids : []
    const data = {}
    for (const id of ids) {
      const receipt = receipts.get(id)
      // An id Expo has no receipt for is simply absent from the map, never an
      // error — the caller must treat "no receipt" as "nothing proven".
      if (receipt) data[id] = receipt
    }
    return json(res, 200, { data })
  }

  json(res, 404, { errors: [{ code: 'NOT_FOUND' }] })
}).listen(PORT, () => {
  console.log(`[mock-expo] listening on http://127.0.0.1:${PORT} (token ${TOKEN})`)
})
