#!/usr/bin/env node
/**
 * Mint a PBKDF2 hash + salt for seeding users, with parameters identical
 * to src/lib/crypto.ts (PBKDF2-SHA256, 100k iterations, 16-byte salt).
 *
 *   node scripts/hash-password.mjs <password> [saltHex]
 *
 * Deterministic when saltHex is provided — the demo seed uses that so
 * re-seeding produces byte-identical rows.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto'

const [password, saltArg] = process.argv.slice(2)
if (!password) {
  console.error('usage: hash-password.mjs <password> [saltHex]')
  process.exit(1)
}
const salt = saltArg ?? randomBytes(16).toString('hex')
const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
console.log(JSON.stringify({ salt, hash }))
