export const API_BASE =
  (import.meta.env.VITE_OSS_API as string | undefined) || 'http://127.0.0.1:3088'

/** 等待本地 OSS API 就绪（侧车启动后再连接账号） */
export async function waitForApiReady(maxMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) return true
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export type CredsPayload = {
  accessKeyId: string
  accessKeySecret: string
  region: string
  endpoint?: string
}

export type BucketInfo = {
  name: string
  region: string
  creationDate: string | null
  storageClass: string | null
}

export type FolderItem = {
  type: 'folder'
  name: string
  key: string
}

export type FileItem = {
  type: 'file'
  name: string
  key: string
  size: number
  lastModified: string | null
  etag: string | null
  storageClass: string | null
}

export type ObjectItem = FolderItem | FileItem

async function post<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(120_000)
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  })
  const data = (await res.json()) as T & { ok?: boolean; error?: string }
  if (!res.ok || (data && 'ok' in data && data.ok === false)) {
    throw new Error(
      (data && 'error' in data && data.error) || `Request failed (${res.status})`
    )
  }
  return data
}

export async function connect(creds: CredsPayload) {
  return post<{ ok: true; buckets: BucketInfo[] }>('/api/connect', creds)
}

export type BucketStatInfo = {
  ok: true
  bucket: string
  region: string
  storage: number
  objectCount: number
  multipartUploadCount: number
  liveChannelCount: number
  standardStorage: number
  infrequentAccessStorage: number
  archiveStorage: number
  coldArchiveStorage: number
}

export async function getBucketStat(
  creds: CredsPayload,
  opts: { bucket: string; bucketRegion?: string }
) {
  return post<BucketStatInfo>('/api/bucket-stat', { ...creds, ...opts })
}

export type FolderStatInfo = {
  ok: true
  bucket: string
  prefix: string
  size: number
  objectCount: number
  lastModified: string | null
  truncated: boolean
  pages: number
}

export async function getFolderStat(
  creds: CredsPayload,
  opts: { bucket: string; bucketRegion?: string; prefix: string },
  signal?: AbortSignal,
) {
  return post<FolderStatInfo>('/api/folder-stat', { ...creds, ...opts }, signal)
}

export type SearchHit = FileItem & {
  path: string
}

export async function listObjects(
  creds: CredsPayload,
  opts: {
    bucket: string
    bucketRegion?: string
    prefix?: string
    marker?: string
    continuationToken?: string
    maxKeys?: number
  }
) {
  return post<{
    ok: true
    prefix: string
    nextMarker: string | null
    nextContinuationToken: string | null
    isTruncated: boolean
    items: ObjectItem[]
  }>('/api/objects', { ...creds, ...opts })
}

export async function searchObjects(
  creds: CredsPayload,
  opts: {
    bucket: string
    bucketRegion?: string
    query: string
    prefix?: string
    scope?: 'current' | 'bucket'
    marker?: string
    maxMatches?: number
  }
) {
  return post<{
    ok: true
    query: string
    scope: 'current' | 'bucket'
    prefix: string
    items: SearchHit[]
    nextMarker: string | null
    isTruncated: boolean
    meta: {
      scanned: number
      pages: number
      hitLimit: boolean
      scanLimit: boolean
    }
  }>('/api/search', { ...creds, ...opts })
}

export async function signUrl(
  creds: CredsPayload,
  opts: {
    bucket: string
    bucketRegion?: string
    key: string
    expires?: number
    process?: string
    download?: boolean
    filename?: string
  }
) {
  return post<{ ok: true; url: string }>('/api/sign', { ...creds, ...opts })
}

export async function deleteObject(
  creds: CredsPayload,
  opts: {
    bucket: string
    bucketRegion?: string
    key: string
    type: 'file' | 'folder'
  }
) {
  return post<{
    ok: true
    deleted: number
    key: string
    type: 'file' | 'folder'
  }>('/api/delete', { ...creds, ...opts })
}

export async function deleteObjectsBatch(
  creds: CredsPayload,
  opts: {
    bucket: string
    bucketRegion?: string
    items: { key: string; type: 'file' | 'folder' }[]
  }
) {
  return post<{
    ok: true
    deleted: number
    requested: number
    failed: number
    errors: { key: string; error: string }[]
  }>('/api/delete-batch', { ...creds, ...opts })
}
