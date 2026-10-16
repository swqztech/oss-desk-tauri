export type OssAccount = {
  id: string
  name: string
  accessKeyId: string
  accessKeySecret: string
  region: string
  endpoint?: string
  /** 是否置顶 */
  pinned?: boolean
  /** 置顶时间，越新越靠前 */
  pinnedAt?: number
}

export type BrowseState = {
  accountId: string
  bucket?: string
  bucketRegion?: string
  prefix?: string
}

const STORAGE_KEY = 'oss-desk:accounts'
const ACTIVE_KEY = 'oss-desk:active-id'

export function readAccounts(): OssAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as OssAccount[]
    return Array.isArray(list) ? sortAccounts(list) : []
  } catch {
    return []
  }
}

export function writeAccounts(list: OssAccount[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // 忽略配额不足
  }
}

export function sortAccounts(list: OssAccount[]): OssAccount[] {
  return [...list].sort((a, b) => {
    const ap = a.pinned ? 1 : 0
    const bp = b.pinned ? 1 : 0
    if (ap !== bp) return bp - ap
    if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0)
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function writeActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // ignore
  }
}

export function upsertAccount(account: OssAccount): OssAccount[] {
  const list = readAccounts()
  const idx = list.findIndex((a) => a.id === account.id)
  if (idx >= 0) list[idx] = { ...list[idx], ...account }
  else list.unshift(account)
  const sorted = sortAccounts(list)
  writeAccounts(sorted)
  return sorted
}

export function removeAccount(id: string): OssAccount[] {
  const list = sortAccounts(readAccounts().filter((a) => a.id !== id))
  writeAccounts(list)
  if (readActiveId() === id) writeActiveId(list[0]?.id ?? null)
  return list
}

export function togglePinAccount(id: string): OssAccount[] {
  const list = readAccounts()
  const idx = list.findIndex((a) => a.id === id)
  if (idx < 0) return sortAccounts(list)
  const cur = list[idx]
  const pinned = !cur.pinned
  list[idx] = {
    ...cur,
    pinned,
    pinnedAt: pinned ? Date.now() : undefined,
  }
  const sorted = sortAccounts(list)
  writeAccounts(sorted)
  return sorted
}

export function newAccountId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 从 URL hash 读取浏览位置，格式：#a=账号&b=桶&r=地域&p=前缀 */
export function readBrowseHash(): BrowseState | null {
  try {
    const raw = window.location.hash.replace(/^#/, '')
    if (!raw) return null
    const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
    const accountId = q.get('a')?.trim()
    if (!accountId) return null
    const bucket = q.get('b')?.trim() || undefined
    const bucketRegion = q.get('r')?.trim() || undefined
    const prefix = q.get('p') ?? undefined
    return { accountId, bucket, bucketRegion, prefix }
  } catch {
    return null
  }
}

/** 写入浏览位置到 hash（不产生历史记录堆叠） */
export function writeBrowseHash(state: BrowseState | null) {
  try {
    if (!state?.accountId) {
      if (window.location.hash) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      }
      return
    }
    const q = new URLSearchParams()
    q.set('a', state.accountId)
    if (state.bucket) {
      q.set('b', state.bucket)
      if (state.bucketRegion) q.set('r', state.bucketRegion)
      if (state.prefix) q.set('p', state.prefix)
    }
    const next = `#${q.toString()}`
    if (window.location.hash !== next) {
      history.replaceState(null, '', next)
    }
  } catch {
    // ignore
  }
}
