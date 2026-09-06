/**
 * The extension socket's handshake gate.
 *
 * The server binds to 127.0.0.1 and, until now, that was the whole control:
 * anything able to reach loopback was accepted — including a page in a
 * browser the user merely visited, because WebSocket is not subject to CORS.
 * That page could read the conversation list and the browsing trail, and
 * register as a browser to answer the agent's own commands with fabricated
 * page content.
 *
 * These are the cases that matter: a page can never be let in, and a real
 * client can never be shut out.
 *
 * Run from apps/desktop:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/extension-origin.test.ts
 */
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'wolffish-origin-'))

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.1.0-test',
        getName: () => 'wfc-desktop'
      },
      safeStorage: { isEncryptionAvailable: () => false }
    }
  }
  return origLoad.apply(this, args)
}

async function main(): Promise<void> {
  const { verifyExtensionOrigin } = await import('@main/channels/extension/server')
  let pass = 0
  let fail = 0
  const ok = (name: string, cond: boolean): void => {
    if (cond) pass++
    else fail++
    console.log(`${cond ? '✅' : '❌'} ${name}`)
  }
  const accepts = (origin?: string): boolean =>
    verifyExtensionOrigin({ origin, req: { headers: origin ? { origin } : {} } })

  console.log("── a web page must never reach the agent's browser channel ──")
  ok('https://evil.example refused', accepts('https://evil.example') === false)
  ok(
    'http://localhost:3000 refused — a dev server is still a page',
    accepts('http://localhost:3000') === false
  )
  ok(
    'HTTPS://Evil.Example refused — the scheme test is case-insensitive',
    accepts('HTTPS://Evil.Example') === false
  )
  ok(
    'https://mail.google.com refused — a site the user is signed into',
    accepts('https://mail.google.com') === false
  )

  console.log('\n── and a real client must still connect ──')
  ok(
    'chrome-extension:// accepted',
    accepts('chrome-extension://abcdefghijklmnopabcdefghijklmnop') === true
  )
  ok(
    'moz-extension:// accepted',
    accepts('moz-extension://11111111-2222-3333-4444-555555555555') === true
  )
  ok('no origin accepted — a native client sends none', accepts(undefined) === true)
  ok('empty origin accepted', accepts('') === true)

  console.log(`\n${fail === 0 ? `${pass} passed, 0 failed` : `${fail}/${pass + fail} failed`}`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
