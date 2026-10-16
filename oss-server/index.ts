import cors from 'cors'
import express from 'express'
import OSS from 'ali-oss'

const app = express()
const PORT = Number(process.env.PORT) || 3088

app.use(cors())
app.use(express.json({ limit: '2mb' }))

type Creds = {
  accessKeyId: string
  accessKeySecret: string
  region: string
  endpoint?: string
}

function readCreds(body: Partial<Creds>): Creds {
  const accessKeyId = String(body.accessKeyId || '').trim()
  const accessKeySecret = String(body.accessKeySecret || '').trim()
  const region = normalizeRegion(String(body.region || '').trim() || 'oss-cn-hangzhou')
  const endpoint = String(body.endpoint || '').trim() || undefined

  if (!accessKeyId) throw new Error('请填写 AccessKey ID（公钥）')
  if (!accessKeySecret) throw new Error('请填写 AccessKey Secret（密钥）')

  return { accessKeyId, accessKeySecret, region, endpoint }
}

/** 统一成 oss-cn-xxx */
function normalizeRegion(raw: string) {
  let r = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.aliyuncs\.com.*/i, '')
    .replace(/\/$/, '')

  // getBucketLocation 有时返回对象字符串化残留
  if (r.includes('[object')) return 'oss-cn-hangzhou'

  if (!r) return 'oss-cn-hangzhou'
  if (r.startsWith('oss-')) return r
  if (
    r.startsWith('cn-') ||
    r.startsWith('ap-') ||
    r.startsWith('eu-') ||
    r.startsWith('us-') ||
    r.startsWith('me-') ||
    r.startsWith('rus-')
  ) {
    return `oss-${r}`
  }
  return r
}

function unwrapLocation(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    for (const key of ['location', 'Location', 'LocationConstraint', '_', 'region']) {
      const inner = unwrapLocation(o[key])
      if (inner) return inner
    }
  }
  return String(value).trim()
}

function isSignatureError(err: unknown) {
  const msg = errMessage(err).toLowerCase()
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  return (
    code === 'SignatureDoesNotMatch' ||
    msg.includes('signaturedoesnotmatch') ||
    msg.includes('signature we calculated') ||
    msg.includes('does not match the signature')
  )
}

/**
 * 创建 OSS 客户端
 * - 默认 HTTPS
 * - authorizationV4=true 为最新签名协议（OSS4-HMAC-SHA256）
 */
function createClient(
  creds: Creds,
  opts: {
    bucket?: string
    region?: string
    authorizationV4?: boolean
    useCustomEndpoint?: boolean
  } = {},
) {
  const region = normalizeRegion(opts.region || creds.region)
  const authorizationV4 = opts.authorizationV4 !== false

  const clientOpts: OSS.Options = {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    region,
    authorizationV4,
    secure: true,
    timeout: 60_000,
  }

  // 访问具体桶时优先用地域标准域名，避免自定义 endpoint 导致签名 Host 不一致
  if (opts.useCustomEndpoint && creds.endpoint) {
    clientOpts.endpoint = creds.endpoint
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '')
  }

  if (opts.bucket) {
    clientOpts.bucket = opts.bucket
  }

  return new OSS(clientOpts)
}

async function resolveBucketRegion(
  creds: Creds,
  bucket: string,
  bucketRegion?: string,
) {
  if (bucketRegion) return normalizeRegion(bucketRegion)

  // 用账号地域 + V4 查 Location；失败再 V1
  for (const useV4 of [true, false]) {
    try {
      const probe = createClient(creds, {
        authorizationV4: useV4,
        useCustomEndpoint: Boolean(creds.endpoint),
      })
      const loc = await probe.getBucketLocation(bucket)
      const found = unwrapLocation(loc.location)
      if (found) return normalizeRegion(found)
    } catch {
      // 继续尝试
    }
  }

  return normalizeRegion(creds.region)
}

/** 优先 V4，签名失败自动回退 V1 */
async function withBucketClient<T>(
  creds: Creds,
  bucket: string,
  bucketRegion: string | undefined,
  fn: (client: OSS, meta: { region: string; authorizationV4: boolean }) => Promise<T>,
): Promise<T> {
  const region = await resolveBucketRegion(creds, bucket, bucketRegion)
  let lastErr: unknown

  for (const authorizationV4 of [true, false]) {
    try {
      const client = createClient(creds, {
        bucket,
        region,
        authorizationV4,
        useCustomEndpoint: false,
      })
      return await fn(client, { region, authorizationV4 })
    } catch (err) {
      lastErr = err
      if (!isSignatureError(err)) throw err
      // 签名错误则尝试下一协议
    }
  }

  throw lastErr
}

function errMessage(err: unknown) {
  let msg = ''
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string; status?: number }
    if (e.message) msg = e.message
    else if (e.code) msg = String(e.code)
  } else {
    msg = err instanceof Error ? err.message : String(err)
  }
  const lower = msg.toLowerCase()
  if (
    lower.includes('403 forbidden') ||
    lower.includes("don't have permission to access the url") ||
    (lower.includes('<html') && lower.includes('forbidden'))
  ) {
    return '访问被拒绝（403）。列举 Bucket 请使用官方地域域名；自定义 Endpoint 仅用于访问桶内对象。请检查 AccessKey 权限与地域。'
  }
  if (lower.includes('unexpected close tag') && lower.includes('<!doctype')) {
    return 'OSS 返回了网页而非 API 数据，多为自定义 Endpoint 或域名配置不当。已改用地域域名列举 Bucket，请重试；若仍失败请检查密钥与地域。'
  }
  if (msg.length > 280) {
    return `${msg.slice(0, 280)}…`
  }
  return msg || '未知错误'
}

function unwrapPrefix(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    for (const key of ['Prefix', 'prefix', '_']) {
      const inner = unwrapPrefix(o[key])
      if (inner) return inner
    }
  }
  return String(value)
}

type FolderItem = { type: 'folder'; name: string; key: string }
type FileItem = {
  type: 'file'
  name: string
  key: string
  size: number
  lastModified: string | null
  etag: string | null
  storageClass: string | null
}

/**
 * 带 delimiter 列出当前「目录」：
 * OSS 按 key 字典序分页，数字文件名会排在字母目录前面，
 * 第一页可能只看到文件看不到目录。因此会翻页收集全部 CommonPrefixes，
 * 文件只取前 maxFiles 个，目录永远完整且排在前面。
 */
async function listDirFoldersFirst(
  client: OSS,
  prefix: string,
  opts: { marker?: string; maxFiles: number },
) {
  const folderMap = new Map<string, FolderItem>()
  const files: FileItem[] = []
  let marker = opts.marker || undefined
  let pages = 0
  const maxPages = 100
  let ossTruncated = false
  let lastMarker: string | null = null
  const isLoadMore = Boolean(opts.marker)

  do {
    const result = await client.list(
      {
        prefix,
        delimiter: '/',
        marker,
        'max-keys': 1000,
      },
      { timeout: 60_000 },
    )

    // 首页才收集目录；加载更多只补文件，避免目录重复
    if (!isLoadMore) {
      for (const raw of result.prefixes || []) {
        const full = unwrapPrefix(raw)
        if (!full) continue
        const name = full.slice(prefix.length).replace(/\/$/, '')
        if (!name) continue
        folderMap.set(full, { type: 'folder', name, key: full })
      }
    }

    for (const o of result.objects || []) {
      if (!o.name || o.name === prefix) continue
      const key = String(o.name)
      const name = key.slice(prefix.length)
      if (!name) continue
      // 目录占位对象（xxx/）并入目录
      if (name.endsWith('/')) {
        if (!isLoadMore) {
          const dirKey = key.endsWith('/') ? key : `${key}/`
          const dirName = name.replace(/\/$/, '')
          if (dirName && !folderMap.has(dirKey)) {
            folderMap.set(dirKey, {
              type: 'folder',
              name: dirName,
              key: dirKey,
            })
          }
        }
        continue
      }
      if (files.length < opts.maxFiles) {
        files.push({
          type: 'file',
          name,
          key,
          size: Number(o.size) || 0,
          lastModified: o.lastModified || null,
          etag: o.etag || null,
          storageClass: o.storageClass || null,
        })
        lastMarker = key
      }
    }

    ossTruncated = Boolean(result.isTruncated)
    marker = result.nextMarker || undefined
    pages++

    if (!ossTruncated || !marker) break

    // 首页：文件凑满后仍继续翻页，把后面的目录收齐
    // 加载更多：凑满本批文件即可
    if (isLoadMore && files.length >= opts.maxFiles) break
  } while (pages < maxPages)

  const folders = [...folderMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN'),
  )
  // 文件保持 OSS 返回顺序（与 nextMarker 一致），不再按名重排打乱分页

  const fileCapped = files.length >= opts.maxFiles
  const isTruncated = ossTruncated || fileCapped

  return {
    items: [...folders, ...files],
    folderCount: folders.length,
    fileCount: files.length,
    nextMarker: isTruncated ? lastMarker : null,
    isTruncated,
    pages,
  }
}

/** 按前缀递归汇总对象大小（OSS 无原生目录大小） */
async function sumPrefixStats(client: OSS, prefix: string) {
  const dirPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  let marker: string | undefined
  let pages = 0
  const maxPages = 100
  const deadline = Date.now() + 45_000
  let size = 0
  let objectCount = 0
  let lastModified: string | null = null
  let ossTruncated = false

  do {
    const listed = await client.list(
      {
        prefix: dirPrefix,
        marker,
        'max-keys': 1000,
      },
      { timeout: 60_000 },
    )

    for (const o of listed.objects || []) {
      if (!o.name || o.name === dirPrefix) continue
      const key = String(o.name)
      if (key.endsWith('/')) continue
      objectCount++
      size += Number(o.size) || 0
      if (o.lastModified) {
        if (!lastModified || o.lastModified > lastModified) {
          lastModified = o.lastModified
        }
      }
    }

    ossTruncated = Boolean(listed.isTruncated)
    marker = listed.nextMarker || undefined
    pages++
    if (!ossTruncated || !marker) break
    if (Date.now() > deadline) break
  } while (pages < maxPages)

  const hitPageLimit = pages >= maxPages && ossTruncated
  const hitTimeLimit = Date.now() > deadline && ossTruncated
  const truncated = Boolean((ossTruncated && marker) || hitPageLimit || hitTimeLimit)

  return {
    prefix: dirPrefix,
    size,
    objectCount,
    lastModified,
    truncated,
    pages,
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: 7 })
})

/** 校验凭证并列出所有 Bucket */
app.post('/api/connect', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    let result: Awaited<ReturnType<OSS['listBuckets']>> | null = null
    let lastErr: unknown

    for (const authorizationV4 of [true, false]) {
      try {
        // 列举 Bucket 必须走 oss-cn-xxx.aliyuncs.com，自定义 CDN/CNAME 不支持 ListBuckets
        const client = createClient(creds, {
          authorizationV4,
          useCustomEndpoint: false,
        })
        result = await client.listBuckets({ 'max-keys': 1000 })
        break
      } catch (err) {
        lastErr = err
        if (!isSignatureError(err)) throw err
      }
    }

    if (!result) throw lastErr

    // ali-oss 类型在不同版本可能是 Bucket[] 或 { buckets?: Bucket[] }
    const rawList = Array.isArray(result)
      ? result
      : ((result as { buckets?: OSS.Bucket[] }).buckets ?? [])

    const buckets = rawList.map((b) => {
      const raw = b as OSS.Bucket & { location?: string; Location?: string }
      const region = normalizeRegion(
        unwrapLocation(raw.region || raw.location || raw.Location) || creds.region,
      )
      return {
        name: b.name,
        region,
        creationDate: b.creationDate || null,
        storageClass:
          (b as OSS.Bucket & { storageClass?: string }).storageClass ||
          (b as { StorageClass?: string }).StorageClass ||
          null,
      }
    })
    buckets.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    res.json({ ok: true, buckets })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/** 查询单个 Bucket 用量（GetBucketStat，数据可能有约 1 小时延迟） */
app.post('/api/bucket-stat', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    if (!bucket) throw new Error('请指定 Bucket')

    const data = await withBucketClient(creds, bucket, bucketRegion, async (client, meta) => {
      const oss = client as OSS & {
        getBucketStat: (name?: string) => Promise<{
          stat?: Record<string, string | number>
        }>
      }
      if (typeof oss.getBucketStat !== 'function') {
        throw new Error('当前 SDK 不支持 getBucketStat')
      }
      const result = await oss.getBucketStat(bucket)
      const stat = result?.stat || {}
      const num = (key: string) => {
        const v = stat[key] ?? stat[key.replace(/^[A-Z]/, (c) => c.toLowerCase())]
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }
      return {
        region: meta.region,
        storage: num('Storage'),
        objectCount: num('ObjectCount'),
        multipartUploadCount: num('MultipartUploadCount'),
        liveChannelCount: num('LiveChannelCount'),
        standardStorage: num('StandardStorage'),
        infrequentAccessStorage: num('InfrequentAccessStorage'),
        archiveStorage: num('ArchiveStorage'),
        coldArchiveStorage: num('ColdArchiveStorage'),
      }
    })

    res.json({ ok: true, bucket, ...data })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/** 列出指定前缀下的目录与文件（目录完整收集并排前） */
app.post('/api/objects', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    const prefix = String(req.body?.prefix || '')
    const marker = String(req.body?.marker || '') || undefined
    const maxKeys = Math.min(Number(req.body?.maxKeys) || 200, 1000)

    if (!bucket) throw new Error('请指定 Bucket')

    const listed = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        const data = await listDirFoldersFirst(client, prefix, {
          marker,
          maxFiles: maxKeys,
        })
        return { ...data, ...meta }
      },
    )

    res.json({
      ok: true,
      prefix,
      nextMarker: listed.nextMarker,
      nextContinuationToken: null,
      isTruncated: listed.isTruncated,
      items: listed.items,
      meta: {
        region: listed.region,
        authorizationV4: listed.authorizationV4,
        folderCount: listed.folderCount,
        fileCount: listed.fileCount,
        pages: listed.pages,
      },
    })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/** 统计某个「目录」前缀下全部对象的大小与数量 */
app.post('/api/folder-stat', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    let prefix = String(req.body?.prefix || req.body?.key || '').trim()
    if (!bucket) throw new Error('请指定 Bucket')
    if (!prefix) throw new Error('请指定目录')
    if (prefix === '/' || prefix.includes('..')) throw new Error('非法的对象路径')
    if (!prefix.endsWith('/')) prefix = `${prefix}/`

    const data = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        const stats = await sumPrefixStats(client, prefix)
        return { ...stats, ...meta }
      },
    )

    res.json({
      ok: true,
      bucket,
      ...data,
    })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/**
 * 递归搜索文件名（无 delimiter，遍历子孙对象）
 * 匹配规则：文件名或相对路径包含关键词（不区分大小写）
 */
app.post('/api/search', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    const query = String(req.body?.query || '').trim()
    const scope = String(req.body?.scope || 'current') === 'bucket' ? 'bucket' : 'current'
    const prefix =
      scope === 'bucket' ? '' : String(req.body?.prefix || '')
    const marker = String(req.body?.marker || '') || undefined
    const maxMatches = Math.min(Number(req.body?.maxMatches) || 100, 500)
    const maxPages = Math.min(Number(req.body?.maxPages) || 40, 100)

    if (!bucket) throw new Error('请指定 Bucket')
    if (!query) throw new Error('请输入搜索关键词')
    if (query.length > 200) throw new Error('搜索关键词过长')

    const needle = query.toLowerCase()

    const result = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        const matches: Array<FileItem & { path: string }> = []
        let cursor = marker
        let pages = 0
        let scanned = 0
        let ossTruncated = false
        let lastKey: string | null = null

        do {
          const listed = await client.list(
            {
              prefix,
              // 不传 delimiter = 递归列出子孙
              marker: cursor,
              'max-keys': 1000,
            },
            { timeout: 120_000 },
          )

          for (const o of listed.objects || []) {
            if (!o.name || o.name === prefix) continue
            const key = String(o.name)
            if (key.endsWith('/')) continue
            scanned++
            lastKey = key

            const relative = prefix ? key.slice(prefix.length) : key
            const base = relative.includes('/')
              ? relative.slice(relative.lastIndexOf('/') + 1)
              : relative
            const hay = `${relative}\0${base}`.toLowerCase()
            if (!hay.includes(needle)) continue

            matches.push({
              type: 'file',
              name: base,
              path: relative,
              key,
              size: Number(o.size) || 0,
              lastModified: o.lastModified || null,
              etag: o.etag || null,
              storageClass: o.storageClass || null,
            })

            if (matches.length >= maxMatches) break
          }

          ossTruncated = Boolean(listed.isTruncated)
          cursor = listed.nextMarker || undefined
          pages++

          if (matches.length >= maxMatches) break
          if (!ossTruncated || !cursor) break
        } while (pages < maxPages)

        const hitLimit = matches.length >= maxMatches
        const scanLimit = pages >= maxPages && ossTruncated
        const isTruncated = Boolean(
          (ossTruncated && cursor) || hitLimit || scanLimit,
        )

        return {
          items: matches,
          // marker = 从该 key 之后继续扫
          nextMarker: isTruncated ? lastKey || cursor || null : null,
          isTruncated,
          scanned,
          pages,
          hitLimit,
          scanLimit,
          ...meta,
        }
      },
    )

    res.json({
      ok: true,
      query,
      scope,
      prefix,
      items: result.items,
      nextMarker: result.nextMarker,
      isTruncated: result.isTruncated,
      meta: {
        region: result.region,
        authorizationV4: result.authorizationV4,
        scanned: result.scanned,
        pages: result.pages,
        hitLimit: result.hitLimit,
        scanLimit: result.scanLimit,
      },
    })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

type DeleteTarget = { key: string; type: 'file' | 'folder' }

function normalizeDeleteTarget(raw: {
  key?: unknown
  type?: unknown
}): DeleteTarget {
  let key = String(raw.key || '').trim()
  const type = String(raw.type || '').trim() === 'folder' ? 'folder' : 'file'
  if (!key) throw new Error('请指定要删除的对象')
  if (key === '/' || key.includes('..')) throw new Error('非法的对象路径')
  if (type === 'folder' && !key.endsWith('/')) key = `${key}/`
  return { key, type }
}

async function deleteOne(
  client: OSS,
  target: DeleteTarget,
): Promise<number> {
  const { key, type } = target
  if (type === 'file') {
    await client.delete(key)
    return 1
  }

  let marker: string | undefined
  let deleted = 0
  let pages = 0
  const maxPages = 200

  do {
    const listed = await client.list(
      {
        prefix: key,
        marker,
        'max-keys': 1000,
      },
      { timeout: 120_000 },
    )

    const names = (listed.objects || [])
      .map((o) => o.name)
      .filter((n): n is string => Boolean(n))

    if (names.length > 0) {
      await client.deleteMulti(names, { quiet: true })
      deleted += names.length
    }

    marker = listed.nextMarker || undefined
    pages++
    if (!listed.isTruncated || !marker) break
  } while (pages < maxPages)

  try {
    await client.delete(key)
  } catch {
    // ignore
  }

  return deleted
}

/**
 * 删除文件，或递归删除「目录」（该前缀下全部对象）
 * body: { bucket, bucketRegion?, key, type?: 'file' | 'folder' }
 */
app.post('/api/delete', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    if (!bucket) throw new Error('请指定 Bucket')

    const target = normalizeDeleteTarget(req.body || {})
    const result = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        const deleted = await deleteOne(client, target)
        return { deleted, ...target, ...meta }
      },
    )

    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/**
 * 批量删除
 * body: { bucket, bucketRegion?, items: [{ key, type }] }
 */
app.post('/api/delete-batch', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : []

    if (!bucket) throw new Error('请指定 Bucket')
    if (rawItems.length === 0) throw new Error('请选择要删除的项目')
    if (rawItems.length > 500) throw new Error('单次最多删除 500 项')

    const targets = rawItems.map((item: { key?: unknown; type?: unknown }) =>
      normalizeDeleteTarget(item || {}),
    )

    // 目录优先删，避免先删文件再扫目录时重复；按 key 去重
    const map = new Map<string, DeleteTarget>()
    for (const t of targets) map.set(`${t.type}:${t.key}`, t)
    const list = [...map.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.key.localeCompare(b.key)
    })

    const result = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        let deleted = 0
        const errors: { key: string; error: string }[] = []
        for (const target of list) {
          try {
            deleted += await deleteOne(client, target)
          } catch (err) {
            errors.push({ key: target.key, error: errMessage(err) })
          }
        }
        return {
          deleted,
          requested: list.length,
          failed: errors.length,
          errors,
          ...meta,
        }
      },
    )

    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

/** 生成临时下载 / 预览链接（可选 OSS 图片处理） */
app.post('/api/sign', async (req, res) => {
  try {
    const creds = readCreds(req.body || {})
    const bucket = String(req.body?.bucket || '').trim()
    const bucketRegion = String(req.body?.bucketRegion || '').trim() || undefined
    const key = String(req.body?.key || '').trim()
    const expires = Math.min(Number(req.body?.expires) || 3600, 86400)
    // 例：image/resize,w_480/format,jpg —— 用于 TIFF 等浏览器无法直出的格式
    const process = String(req.body?.process || '').trim() || undefined
    const asDownload = Boolean(req.body?.download)
    const filename = String(req.body?.filename || '').trim() || key.split('/').pop() || 'download'

    if (!bucket) throw new Error('请指定 Bucket')
    if (!key) throw new Error('请指定对象 key')
    if (process && !/^[\w/,.=-]+$/.test(process)) {
      throw new Error('非法的图片处理参数')
    }

    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_') || 'download'
    const disposition = `attachment; filename="${asciiName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`

    const url = await withBucketClient(
      creds,
      bucket,
      bucketRegion,
      async (client, meta) => {
        if (meta.authorizationV4) {
          const queries: Record<string, string> = {}
          if (process) queries['x-oss-process'] = process
          if (asDownload) queries['response-content-disposition'] = disposition
          return await client.signatureUrlV4(
            'GET',
            expires,
            Object.keys(queries).length ? { queries } : undefined,
            key,
          )
        }
        return client.signatureUrl(key, {
          expires,
          ...(process ? { process } : {}),
          ...(asDownload ? { response: { 'content-disposition': disposition } } : {}),
        })
      },
    )

    res.json({ ok: true, url })
  } catch (err) {
    res.status(400).json({ ok: false, error: errMessage(err) })
  }
})

export const API_PORT = PORT

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[oss-api] http://127.0.0.1:${PORT} (dirs-first + recursive search)`)
      resolve()
    })
    server.on('error', reject)
  })
}

export function attachRendererStatic(distPath: string) {
  app.use(express.static(distPath))
  app.get(/.*/, (_req, res) => {
    res.sendFile('index.html', { root: distPath })
  })
}

