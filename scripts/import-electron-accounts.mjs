/**
 * 从 Electron OSS Desk 的 Local Storage 导入账号到 %APPDATA%/oss/accounts.json
 * 用法: node scripts/import-electron-accounts.mjs
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ossDir = join(homedir(), 'AppData', 'Roaming', 'oss')
const leveldb = join(ossDir, 'Local Storage', 'leveldb')
const outPath = join(ossDir, 'accounts.json')

function findKey(data, key) {
  const kb = Buffer.from(key)
  for (let i = 0; i <= data.length - kb.length; i++) {
    if (data.subarray(i, i + kb.length).equals(kb)) return i
  }
  return -1
}

function extractAccounts(data) {
  const start = findKey(data, 'oss-desk:accounts')
  if (start < 0) return null
  const tail = data.subarray(start + 'oss-desk:accounts'.length)
  const rel = tail.indexOf(Buffer.from([0x5b, 0x00])) // [\x00
  if (rel < 0) return null
  const jsonStart = start + 'oss-desk:accounts'.length + rel
  for (let end = jsonStart + 4; end < Math.min(data.length, jsonStart + 200000); end += 2) {
    const slice = data.subarray(jsonStart, end)
    if (slice.length % 2 !== 0) continue
    let s = ''
    try {
      s = slice.toString('utf16le')
    } catch {
      continue
    }
    const t = s.trim()
    if (!t.endsWith(']')) continue
    try {
      const v = JSON.parse(t)
      if (Array.isArray(v)) return v
    } catch {
      // continue
    }
  }
  return null
}

function extractActiveId(data) {
  const start = findKey(data, 'oss-desk:active-id')
  if (start < 0) return null
  const rest = data.subarray(start + 'oss-desk:active-id'.length + 2)
  let end = 0
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i]
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d) {
      end = i + 1
    } else break
  }
  if (end < 8) return null
  return rest.subarray(0, end).toString('utf8')
}

let accounts = null
let activeId = null

try {
  for (const name of readdirSync(leveldb)) {
    if (!name.endsWith('.log') && !name.endsWith('.ldb')) continue
    const data = readFileSync(join(leveldb, name))
    if (!accounts) accounts = extractAccounts(data)
    if (!activeId) activeId = extractActiveId(data)
  }
} catch (e) {
  console.error('未找到 Electron 数据目录:', leveldb)
  console.error(e.message)
  process.exit(1)
}

if (!accounts?.length) {
  console.error('未在 Electron 缓存里找到账号，请先用旧版 OSS Desk 登录过一次。')
  process.exit(1)
}

if (!activeId) activeId = accounts[0].id

mkdirSync(ossDir, { recursive: true })
writeFileSync(outPath, JSON.stringify({ accounts, activeId }, null, 2), 'utf8')
console.log(`已写入 ${accounts.length} 个账号 -> ${outPath}`)
