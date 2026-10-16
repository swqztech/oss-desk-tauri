import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  newAccountId,
  readAccounts,
  readActiveId,
  readBrowseHash,
  removeAccount,
  togglePinAccount,
  upsertAccount,
  writeActiveId,
  writeBrowseHash,
  type OssAccount,
} from './accounts'
import {
  connect,
  deleteObject,
  deleteObjectsBatch,
  getBucketStat,
  getFolderStat,
  listObjects,
  searchObjects,
  signUrl,
  type BucketInfo,
  type ObjectItem,
  type SearchHit,
} from './api'
import { useDialog } from './dialogs'
import {
  isImageName,
  OssGalleryLightbox,
  OssThumb,
  type PreviewItem,
} from './Thumb'
import { toast } from './toast'
import { DownloadPanel, useDownloadBadge } from './DownloadPanel'
import './App.css'

const VIEW_KEY = 'oss-desk:view-mode'
const PAGE_SIZE_KEY = 'oss-desk:page-size'
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]
type ViewMode = 'list' | 'gallery'

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'gallery' ? 'gallery' : 'list'
  } catch {
    return 'list'
  }
}

function writeViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, mode)
  } catch {
    // ignore
  }
}

function readPageSize(): PageSize {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY))
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(n)) {
      return n as PageSize
    }
  } catch {
    // ignore
  }
  return 100
}

function writePageSize(size: PageSize) {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size))
  } catch {
    // ignore
  }
}

const REGIONS = [
  'oss-cn-hangzhou',
  'oss-cn-shanghai',
  'oss-cn-beijing',
  'oss-cn-shenzhen',
  'oss-cn-qingdao',
  'oss-cn-guangzhou',
  'oss-cn-chengdu',
  'oss-cn-hongkong',
  'oss-ap-southeast-1',
  'oss-us-west-1',
  'oss-eu-central-1',
]

type AccountForm = {
  name: string
  accessKeyId: string
  accessKeySecret: string
  region: string
  endpoint: string
  pinned: boolean
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  if (i === 0) return `${bytes} B`
  return `${n.toFixed(2)} ${units[i]}`
}

function formatBucketStorage(bytes: number) {
  const mb = bytes / (1024 * 1024)
  const mbText = mb.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${formatSize(bytes)} · ${mbText} MB`
}

function formatTime(iso: string | null) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function maskKey(id: string) {
  if (id.length <= 8) return id
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

/** 目录永远排在文件前面，同类型按名称；按 key 去重 */
function sortItemsDirsFirst(items: ObjectItem[]): ObjectItem[] {
  const map = new Map<string, ObjectItem>()
  for (const item of items) map.set(item.key, item)
  return [...map.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

function emptyForm(): AccountForm {
  return {
    name: '',
    accessKeyId: '',
    accessKeySecret: '',
    region: 'oss-cn-hangzhou',
    endpoint: '',
    pinned: false,
  }
}

function toCreds(account: OssAccount) {
  return {
    accessKeyId: account.accessKeyId,
    accessKeySecret: account.accessKeySecret,
    region: account.region,
    endpoint: account.endpoint || undefined,
  }
}

export default function App() {
  const dialog = useDialog()
  const booted = useRef(false)
  const [accounts, setAccounts] = useState<OssAccount[]>(() => readAccounts())
  const [activeId, setActiveId] = useState<string | null>(() => readActiveId())
  const [form, setForm] = useState<AccountForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [buckets, setBuckets] = useState<BucketInfo[]>([])
  const [bucketStats, setBucketStats] = useState<
    Record<
      string,
      | { status: 'loading' }
      | { status: 'ok'; storage: number; objectCount: number }
      | { status: 'error'; message: string }
    >
  >({})
  const [bucket, setBucket] = useState<string | null>(null)
  const [bucketRegion, setBucketRegion] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [items, setItems] = useState<ObjectItem[]>([])
  const [loadingObjects, setLoadingObjects] = useState(false)
  const [nextMarker, setNextMarker] = useState<string | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  /** 每一页的起始 marker；第 1 页为 undefined */
  const [pageMarkers, setPageMarkers] = useState<(string | undefined)[]>([
    undefined,
  ])
  const [listPage, setListPage] = useState(1)
  const [jumpPageInput, setJumpPageInput] = useState('')
  const [pageSize, setPageSize] = useState<PageSize>(() => readPageSize())
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchScope, setSearchScope] = useState<'current' | 'bucket'>('current')
  const [searching, setSearching] = useState(false)
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchMarker, setSearchMarker] = useState<string | null>(null)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchMeta, setSearchMeta] = useState<{
    scanned: number
  } | null>(null)
  const [searchPage, setSearchPage] = useState(1)
  const [searchPageMarkers, setSearchPageMarkers] = useState<
    (string | undefined)[]
  >([undefined])
  const [searchJumpInput, setSearchJumpInput] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode())
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)
  const [showDownloads, setShowDownloads] = useState(false)
  const downloadBadge = useDownloadBadge()
  /** 多选：key -> file|folder */
  const [selected, setSelected] = useState<Map<string, 'file' | 'folder'>>(
    () => new Map(),
  )
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [folderStats, setFolderStats] = useState<
    Record<
      string,
      | { status: 'loading' }
      | {
          status: 'ok'
          size: number
          objectCount: number
          lastModified: string | null
          truncated: boolean
        }
      | { status: 'error'; message: string }
    >
  >({})
  const folderStatSlots = useRef(0)
  const folderStatWaiters = useRef<Array<() => void>>([])
  const folderStatInflight = useRef(new Set<string>())
  const folderStatsRef = useRef(folderStats)
  folderStatsRef.current = folderStats

  const searchMode = Boolean(searchQuery)

  const previewItems = useMemo<PreviewItem[]>(() => {
    if (searchMode) {
      return searchHits
        .filter((h) => isImageName(h.name))
        .map((h) => ({ key: h.key, name: h.name }))
    }
    return items
      .filter((i) => i.type === 'file' && isImageName(i.name))
      .map((i) => ({ key: i.key, name: i.name }))
  }, [searchMode, searchHits, items])

  const openGalleryAt = (key: string) => {
    const idx = previewItems.findIndex((p) => p.key === key)
    if (idx >= 0) setGalleryIndex(idx)
  }

  const toggleViewMode = () => {
    setViewMode((m) => {
      const next: ViewMode = m === 'list' ? 'gallery' : 'list'
      writeViewMode(next)
      return next
    })
  }

  const active = useMemo(
    () => accounts.find((a) => a.id === activeId) ?? null,
    [accounts, activeId],
  )

  const withFolderStatSlot = async <T,>(fn: () => Promise<T>): Promise<T> => {
    while (folderStatSlots.current >= 2) {
      await new Promise<void>((resolve) => {
        folderStatWaiters.current.push(resolve)
      })
    }
    folderStatSlots.current += 1
    try {
      return await fn()
    } finally {
      folderStatSlots.current -= 1
      folderStatWaiters.current.shift()?.()
    }
  }

  const loadFolderStat = useCallback(
    async (folderKey: string, opts?: { force?: boolean }) => {
      if (!active || !bucket) return
      const cacheKey = `${bucket}::${folderKey}`
      if (!opts?.force) {
        const cur = folderStatsRef.current[cacheKey]
        if (cur?.status === 'ok' || cur?.status === 'loading') return
      }
      if (folderStatInflight.current.has(cacheKey)) return
      folderStatInflight.current.add(cacheKey)
      setFolderStats((prev) => ({ ...prev, [cacheKey]: { status: 'loading' } }))
      try {
        const res = await withFolderStatSlot(() =>
          getFolderStat(toCreds(active), {
            bucket,
            bucketRegion: bucketRegion || undefined,
            prefix: folderKey,
          }),
        )
        setFolderStats((prev) => ({
          ...prev,
          [cacheKey]: {
            status: 'ok',
            size: res.size,
            objectCount: res.objectCount,
            lastModified: res.lastModified,
            truncated: res.truncated,
          },
        }))
      } catch (err) {
        setFolderStats((prev) => ({
          ...prev,
          [cacheKey]: {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          },
        }))
      } finally {
        folderStatInflight.current.delete(cacheKey)
      }
    },
    [active, bucket, bucketRegion],
  )

  const crumbs = useMemo(() => {
    if (!prefix) return [] as { label: string; prefix: string }[]
    const parts = prefix.split('/').filter(Boolean)
    const out: { label: string; prefix: string }[] = []
    let cur = ''
    for (const part of parts) {
      cur += `${part}/`
      out.push({ label: part, prefix: cur })
    }
    return out
  }, [prefix])

  const applyListPageResult = (
    pageNum: number,
    startMarker: string | undefined,
    res: {
      items: ObjectItem[]
      nextMarker: string | null
      isTruncated: boolean
    },
  ) => {
    const dirs = res.items.filter((i) => i.type === 'folder')
    const fls = res.items.filter((i) => i.type === 'file')
    if (pageNum === 1) {
      setItems(sortItemsDirsFirst([...dirs, ...fls]))
    } else {
      setItems((prev) => {
        const keepDirs = prev.filter((i) => i.type === 'folder')
        return sortItemsDirsFirst([...keepDirs, ...fls])
      })
    }
    setNextMarker(res.nextMarker)
    setIsTruncated(res.isTruncated)
    setListPage(pageNum)
    setPageMarkers((prev) => {
      const next = prev.slice()
      while (next.length < pageNum) next.push(undefined)
      next[pageNum - 1] = startMarker
      if (res.isTruncated && res.nextMarker) {
        next[pageNum] = res.nextMarker
      }
      return next
    })
    setJumpPageInput(String(pageNum))
  }

  const loadObjects = useCallback(
    async (
      acct: OssAccount,
      bucketName: string,
      pref: string,
      region: string | null | undefined,
      opts?: { page?: number; marker?: string; pageSize?: number },
    ) => {
      const pageNum = opts?.page ?? 1
      const startMarker = pageNum === 1 ? undefined : opts?.marker
      const size = opts?.pageSize ?? pageSize
      setLoadingObjects(true)
      try {
        const res = await listObjects(toCreds(acct), {
          bucket: bucketName,
          bucketRegion: region || undefined,
          prefix: pref,
          marker: startMarker,
          maxKeys: size,
        })
        applyListPageResult(pageNum, startMarker, res)
      } catch (err) {
        toast.error(err)
      } finally {
        setLoadingObjects(false)
      }
    },
    [pageSize],
  )

  const goListPage = async (target: number) => {
    if (!active || !bucket || loadingObjects) return
    if (target < 1) return
    if (target === listPage) return

    if (target === 1) {
      await loadObjects(active, bucket, prefix, bucketRegion, { page: 1 })
      return
    }

    // 已有该页起始 marker，直接跳
    const knownMarker = pageMarkers[target - 1]
    if (knownMarker !== undefined) {
      await loadObjects(active, bucket, prefix, bucketRegion, {
        page: target,
        marker: knownMarker,
      })
      return
    }

    if (target < listPage) {
      toast.warning('无法回到未缓存的页，请从第 1 页重新翻页')
      return
    }

    // 从当前页向后逐页走到目标页
    setLoadingObjects(true)
    try {
      let p = listPage
      let marker = nextMarker
      let lastRes: Awaited<ReturnType<typeof listObjects>> | null = null
      const markers = pageMarkers.slice()

      while (p < target) {
        if (!marker) {
          toast.warning(`最多只有 ${p} 页`)
          break
        }
        p += 1
        const start = marker
        lastRes = await listObjects(toCreds(active), {
          bucket,
          bucketRegion: bucketRegion || undefined,
          prefix,
          marker: start,
          maxKeys: pageSize,
        })
        while (markers.length < p) markers.push(undefined)
        markers[p - 1] = start
        if (lastRes.isTruncated && lastRes.nextMarker) {
          markers[p] = lastRes.nextMarker
        }
        marker = lastRes.nextMarker
        if (!lastRes.isTruncated && p < target) {
          toast.warning(`最多只有 ${p} 页`)
          break
        }
      }

      setPageMarkers(markers)
      if (lastRes) {
        applyListPageResult(p, markers[p - 1], lastRes)
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setLoadingObjects(false)
    }
  }

  const runSearch = useCallback(
    async (
      acct: OssAccount,
      bucketName: string,
      pref: string,
      region: string | null | undefined,
      query: string,
      scope: 'current' | 'bucket',
      opts?: { page?: number; marker?: string; pageSize?: number },
    ) => {
      const q = query.trim()
      if (!q) return
      const pageNum = opts?.page ?? 1
      const startMarker = pageNum === 1 ? undefined : opts?.marker
      const size = opts?.pageSize ?? pageSize
      setSearching(true)
      try {
        const res = await searchObjects(toCreds(acct), {
          bucket: bucketName,
          bucketRegion: region || undefined,
          query: q,
          prefix: pref,
          scope,
          marker: startMarker,
          maxMatches: size,
        })
        setSearchHits(res.items)
        setSearchQuery(q)
        setSearchMarker(res.nextMarker)
        setSearchTruncated(res.isTruncated)
        setSearchMeta({ scanned: res.meta.scanned })
        setSearchPage(pageNum)
        setSearchPageMarkers((prev) => {
          const next = prev.slice()
          while (next.length < pageNum) next.push(undefined)
          next[pageNum - 1] = startMarker
          if (res.isTruncated && res.nextMarker) next[pageNum] = res.nextMarker
          return next
        })
        setSearchJumpInput(String(pageNum))
        if (pageNum === 1 && res.items.length === 0) {
          toast.info('没有匹配的文件')
        }
      } catch (err) {
        toast.error(err)
      } finally {
        setSearching(false)
      }
    },
    [pageSize],
  )

  const goSearchPage = async (target: number) => {
    if (!active || !bucket || searching || !searchQuery) return
    if (target < 1 || target === searchPage) return

    if (target === 1) {
      await runSearch(
        active,
        bucket,
        prefix,
        bucketRegion,
        searchQuery,
        searchScope,
        { page: 1 },
      )
      return
    }

    const known = searchPageMarkers[target - 1]
    if (known !== undefined) {
      await runSearch(
        active,
        bucket,
        prefix,
        bucketRegion,
        searchQuery,
        searchScope,
        { page: target, marker: known },
      )
      return
    }

    if (target < searchPage) {
      toast.warning('无法回到未缓存的页，请从第 1 页重新翻页')
      return
    }

    setSearching(true)
    try {
      let p = searchPage
      let marker = searchMarker
      let lastRes: Awaited<ReturnType<typeof searchObjects>> | null = null
      const markers = searchPageMarkers.slice()

      while (p < target) {
        if (!marker) {
          toast.warning(`最多只有 ${p} 页`)
          break
        }
        p += 1
        const start = marker
        lastRes = await searchObjects(toCreds(active), {
          bucket,
          bucketRegion: bucketRegion || undefined,
          query: searchQuery,
          prefix,
          scope: searchScope,
          marker: start,
          maxMatches: pageSize,
        })
        while (markers.length < p) markers.push(undefined)
        markers[p - 1] = start
        if (lastRes.isTruncated && lastRes.nextMarker) {
          markers[p] = lastRes.nextMarker
        }
        marker = lastRes.nextMarker
        if (!lastRes.isTruncated && p < target) {
          toast.warning(`最多只有 ${p} 页`)
          break
        }
      }

      setSearchPageMarkers(markers)
      if (lastRes) {
        setSearchHits(lastRes.items)
        setSearchMarker(lastRes.nextMarker)
        setSearchTruncated(lastRes.isTruncated)
        setSearchMeta({ scanned: lastRes.meta.scanned })
        setSearchPage(p)
        setSearchJumpInput(String(p))
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setSearching(false)
    }
  }

  const clearSearch = () => {
    setSearchInput('')
    setSearchQuery('')
    setSearchHits([])
    setSearchMarker(null)
    setSearchTruncated(false)
    setSearchMeta(null)
    setSearchPage(1)
    setSearchPageMarkers([undefined])
    setSearchJumpInput('')
  }

  const resetListPaging = () => {
    setListPage(1)
    setPageMarkers([undefined])
    setJumpPageInput('1')
    setNextMarker(null)
    setIsTruncated(false)
  }

  /** 切换每页条数：回到第 1 页并重新加载 */
  const changePageSize = (size: PageSize) => {
    if (size === pageSize) return
    writePageSize(size)
    setPageSize(size)
    resetListPaging()
    setSearchPage(1)
    setSearchPageMarkers([undefined])
    setSearchJumpInput('1')

    if (!active || !bucket) return
    if (searchMode && searchQuery) {
      void runSearch(
        active,
        bucket,
        prefix,
        bucketRegion,
        searchQuery,
        searchScope,
        { page: 1, pageSize: size },
      )
    } else {
      void loadObjects(active, bucket, prefix, bucketRegion, {
        page: 1,
        pageSize: size,
      })
    }
  }

  const loadBucketStats = useCallback(async (acct: OssAccount, list: BucketInfo[]) => {
    if (list.length === 0) {
      setBucketStats({})
      return
    }
    setBucketStats(
      Object.fromEntries(list.map((b) => [b.name, { status: 'loading' as const }])),
    )

    const creds = toCreds(acct)
    const concurrency = 4
    let index = 0

    async function worker() {
      while (index < list.length) {
        const current = list[index++]
        if (!current) break
        try {
          const stat = await getBucketStat(creds, {
            bucket: current.name,
            bucketRegion: current.region,
          })
          setBucketStats((prev) => ({
            ...prev,
            [current.name]: {
              status: 'ok',
              storage: stat.storage,
              objectCount: stat.objectCount,
            },
          }))
        } catch (err) {
          setBucketStats((prev) => ({
            ...prev,
            [current.name]: {
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            },
          }))
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, list.length) }, () => worker()),
    )
  }, [])

  const doConnect = useCallback(
    async (
      acct: OssAccount,
      opts?: {
        restore?: {
          bucket?: string
          bucketRegion?: string
          prefix?: string
        }
        /** 切换账号时清路径；恢复浏览时保留 */
        keepPath?: boolean
        silent?: boolean
      },
    ) => {
      setConnecting(true)
      setConnected(false)
      setBuckets([])
      setBucketStats({})
      if (!opts?.keepPath) {
        setBucket(null)
        setBucketRegion(null)
        setPrefix('')
        setItems([])
      }
      try {
        const res = await connect(toCreds(acct))
        setBuckets(res.buckets)
        setConnected(true)
        setActiveId(acct.id)
        writeActiveId(acct.id)

        const restore = opts?.restore
        if (restore?.bucket) {
          const info =
            res.buckets.find((b) => b.name === restore.bucket) || null
          const region = restore.bucketRegion || info?.region || acct.region
          const pref = restore.prefix || ''
          setBucket(restore.bucket)
          setBucketRegion(region)
          setPrefix(pref)
          await loadObjects(acct, restore.bucket, pref, region, { page: 1 })
        }

        if (!opts?.silent) {
          const label = acct.name || maskKey(acct.accessKeyId)
          toast.success(`已连接 ${label}，共 ${res.buckets.length} 个 Bucket`)
        }

        // 异步拉容量，不阻塞进入浏览
        void loadBucketStats(acct, res.buckets)
      } catch (err) {
        toast.error(err)
      } finally {
        setConnecting(false)
      }
    },
    [loadObjects, loadBucketStats],
  )

  // 首次启动：从 URL hash 恢复目录位置
  useEffect(() => {
    if (booted.current) return
    booted.current = true

    const browse = readBrowseHash()
    const id = browse?.accountId || readActiveId()
    if (!id) return
    const acct = readAccounts().find((a) => a.id === id)
    if (!acct) return

    void doConnect(acct, {
      keepPath: true,
      silent: Boolean(browse?.bucket),
      restore: browse?.bucket
        ? {
            bucket: browse.bucket,
            bucketRegion: browse.bucketRegion,
            prefix: browse.prefix || '',
          }
        : undefined,
    })
  }, [doConnect])

  // 浏览位置写入 URL，刷新可还原
  useEffect(() => {
    if (!activeId || !connected) return
    writeBrowseHash({
      accountId: activeId,
      bucket: bucket || undefined,
      bucketRegion: bucketRegion || undefined,
      prefix: prefix || undefined,
    })
  }, [activeId, connected, bucket, bucketRegion, prefix])

  const openBucket = (info: BucketInfo) => {
    if (!active) return
    clearSearch()
    resetListPaging()
    setBucket(info.name)
    setBucketRegion(info.region)
    setPrefix('')
    void loadObjects(active, info.name, '', info.region, { page: 1 })
  }

  const openFolder = (key: string) => {
    if (!active || !bucket) return
    clearSearch()
    resetListPaging()
    setPrefix(key)
    void loadObjects(active, bucket, key, bucketRegion, { page: 1 })
  }

  const goPrefix = (pref: string) => {
    if (!active || !bucket) return
    clearSearch()
    resetListPaging()
    setPrefix(pref)
    void loadObjects(active, bucket, pref, bucketRegion, { page: 1 })
  }

  const backToBuckets = () => {
    clearSearch()
    resetListPaging()
    setBucket(null)
    setBucketRegion(null)
    setPrefix('')
    setItems([])
  }

  /** 定位到文件所在目录 */
  const locateHit = (hit: SearchHit) => {
    if (!active || !bucket) return
    const slash = hit.key.lastIndexOf('/')
    const parent = slash >= 0 ? hit.key.slice(0, slash + 1) : ''
    clearSearch()
    resetListPaging()
    setPrefix(parent)
    void loadObjects(active, bucket, parent, bucketRegion, { page: 1 })
  }

  const submitSearch = () => {
    if (!active || !bucket) return
    const q = searchInput.trim()
    if (!q) {
      toast.warning('请输入要搜索的文件名关键词')
      return
    }
    setSearchPage(1)
    setSearchPageMarkers([undefined])
    void runSearch(active, bucket, prefix, bucketRegion, q, searchScope, {
      page: 1,
    })
  }

  const startAdd = () => {
    setEditingId(null)
    setForm(emptyForm())
    setShowForm(true)
  }

  const startEdit = (acct: OssAccount) => {
    setEditingId(acct.id)
    setForm({
      name: acct.name,
      accessKeyId: acct.accessKeyId,
      accessKeySecret: acct.accessKeySecret,
      region: acct.region,
      endpoint: acct.endpoint || '',
      pinned: Boolean(acct.pinned),
    })
    setShowForm(true)
  }

  const saveForm = async () => {
    const name = form.name.trim()
    const accessKeyId = form.accessKeyId.trim()
    const accessKeySecret = form.accessKeySecret.trim()
    const region = form.region.trim() || 'oss-cn-hangzhou'
    const endpoint = form.endpoint.trim() || undefined

    if (!name) {
      toast.warning('请填写账号名称，方便区分多个账号')
      return
    }
    if (!accessKeyId || !accessKeySecret) {
      toast.warning('请填写 AccessKey ID 与 Secret')
      return
    }

    const prev = editingId
      ? accounts.find((a) => a.id === editingId)
      : undefined

    const account: OssAccount = {
      id: editingId || newAccountId(),
      name,
      accessKeyId,
      accessKeySecret,
      region,
      endpoint,
      pinned: form.pinned,
      pinnedAt: form.pinned
        ? prev?.pinned
          ? prev.pinnedAt || Date.now()
          : Date.now()
        : undefined,
    }

    const list = upsertAccount(account)
    setAccounts(list)
    setShowForm(false)
    toast.success(editingId ? '账号已更新' : '账号已保存')
    await doConnect(account)
  }

  const onTogglePin = (acct: OssAccount) => {
    const list = togglePinAccount(acct.id)
    setAccounts(list)
    toast.success(acct.pinned ? `已取消置顶「${acct.name}」` : `已置顶「${acct.name}」`)
  }

  const deleteAccount = async (acct: OssAccount) => {
    const ok = await dialog.confirm({
      title: '删除账号',
      message: `确定删除「${acct.name}」？本地保存的密钥会一并清除。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    const list = removeAccount(acct.id)
    setAccounts(list)
    if (activeId === acct.id) {
      setActiveId(list[0]?.id ?? null)
      setConnected(false)
      setBuckets([])
      setBucketStats({})
      backToBuckets()
      writeBrowseHash(list[0] ? { accountId: list[0].id } : null)
      if (list[0]) void doConnect(list[0])
    }
    toast.success('已删除账号')
  }

  const copyDownload = async (item: ObjectItem) => {
    if (item.type !== 'file' || !active || !bucket) return
    try {
      const res = await signUrl(toCreds(active), {
        bucket,
        bucketRegion: bucketRegion || undefined,
        key: item.key,
        expires: 3600,
      })
      await navigator.clipboard.writeText(res.url)
      toast.success('下载链接已复制（1 小时有效）')
    } catch (err) {
      toast.error(err)
    }
  }

  const saveDownload = async (item: ObjectItem) => {
    if (item.type !== 'file' || !active || !bucket) return
    try {
      const res = await signUrl(toCreds(active), {
        bucket,
        bucketRegion: bucketRegion || undefined,
        key: item.key,
        expires: 3600,
        download: true,
        filename: item.name,
      })
      const saved = await window.api.saveDownload(res.url, item.name)
      if (saved?.canceled) return
      if (saved?.ok) {
        setShowDownloads(true)
        toast.success('已开始下载，可在下载记录里查看进度')
      }
    } catch (err) {
      toast.error(err)
    }
  }

  const openDownload = async (item: ObjectItem) => {
    if (item.type !== 'file' || !active || !bucket) return
    try {
      const res = await signUrl(toCreds(active), {
        bucket,
        bucketRegion: bucketRegion || undefined,
        key: item.key,
        expires: 3600,
      })
      window.open(res.url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(err)
    }
  }

  const clearSelection = () => setSelected(new Map())

  const toggleSelect = (key: string, type: 'file' | 'folder') => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(key)) next.delete(key)
      else next.set(key, type)
      return next
    })
  }

  const removeObject = async (item: ObjectItem | SearchHit) => {
    if (!active || !bucket) return
    const isFolder = item.type === 'folder'
    const label = isFolder ? `${item.name}/` : item.name
    const ok = await dialog.confirm({
      title: isFolder ? '删除目录' : '删除文件',
      message: isFolder
        ? `确定删除目录「${label}」及其下全部文件？此操作不可恢复。`
        : `确定删除文件「${label}」？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return

    try {
      const res = await deleteObject(toCreds(active), {
        bucket,
        bucketRegion: bucketRegion || undefined,
        key: item.key,
        type: isFolder ? 'folder' : 'file',
      })
      toast.success(
        isFolder
          ? `已删除目录，共 ${res.deleted} 个对象`
          : '文件已删除',
      )

      setSelected((prev) => {
        const next = new Map(prev)
        next.delete(item.key)
        return next
      })

      if (searchMode) {
        setSearchHits((prev) => prev.filter((h) => h.key !== item.key))
        if (galleryIndex != null) setGalleryIndex(null)
      } else {
        setItems((prev) => prev.filter((i) => i.key !== item.key))
        if (galleryIndex != null) setGalleryIndex(null)
        // 目录删除后刷新当前页，避免子文件残留显示
        if (isFolder) {
          void loadObjects(active, bucket, prefix, bucketRegion, {
            page: listPage,
            marker: pageMarkers[listPage - 1],
          })
        }
      }
    } catch (err) {
      toast.error(err)
    }
  }

  const folders = items.filter((i) => i.type === 'folder')
  const files = items.filter((i) => i.type === 'file')

  const folderStatOf = (folderKey: string) =>
    folderStats[`${bucket}::${folderKey}`]

  const renderFolderSize = (folderKey: string) => {
    const stat = folderStatOf(folderKey)
    if (!stat || stat.status === 'error') {
      return (
        <button
          className="btn-tiny folder-stat-btn"
          type="button"
          title={stat?.status === 'error' ? stat.message : '扫描该目录下全部对象以统计大小'}
          onClick={(e) => {
            e.stopPropagation()
            void loadFolderStat(folderKey, { force: true })
          }}
        >
          {stat?.status === 'error' ? '重试' : '统计'}
        </button>
      )
    }
    if (stat.status === 'loading') {
      return <span className="muted">统计中…</span>
    }
    return (
      <button
        className="folder-stat-value"
        type="button"
        title={`${stat.truncated ? '扫描未完成，约为 · ' : ''}${stat.objectCount.toLocaleString('zh-CN')} 个对象 · 点击重新统计`}
        onClick={(e) => {
          e.stopPropagation()
          void loadFolderStat(folderKey, { force: true })
        }}
      >
        {stat.truncated ? '~ ' : ''}
        {formatSize(stat.size)}
      </button>
    )
  }

  const renderFolderTime = (folderKey: string) => {
    const stat = folderStatOf(folderKey)
    if (stat?.status === 'ok') return formatTime(stat.lastModified)
    return '—'
  }

  const selectableItems = useMemo(() => {
    if (searchMode) {
      return searchHits.map((h) => ({
        key: h.key,
        type: 'file' as const,
        name: h.name,
      }))
    }
    return items.map((i) => ({
      key: i.key,
      type: i.type,
      name: i.type === 'folder' ? `${i.name}/` : i.name,
    }))
  }, [searchMode, searchHits, items])

  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every((i) => selected.has(i.key))

  const toggleSelectAll = () => {
    if (allSelected) {
      clearSelection()
      return
    }
    setSelected(new Map(selectableItems.map((i) => [i.key, i.type])))
  }

  const removeSelected = async () => {
    if (!active || !bucket || selected.size === 0 || batchDeleting) return
    const itemsToDelete = [...selected.entries()].map(([key, type]) => ({
      key,
      type,
    }))
    const folderCount = itemsToDelete.filter((i) => i.type === 'folder').length
    const fileCount = itemsToDelete.length - folderCount
    const ok = await dialog.confirm({
      title: '批量删除',
      message: `确定删除选中的 ${itemsToDelete.length} 项（${folderCount} 个目录，${fileCount} 个文件）？目录会递归删除，且不可恢复。`,
      confirmLabel: '全部删除',
      danger: true,
    })
    if (!ok) return

    setBatchDeleting(true)
    try {
      const res = await deleteObjectsBatch(toCreds(active), {
        bucket,
        bucketRegion: bucketRegion || undefined,
        items: itemsToDelete,
      })
      const keys = new Set(itemsToDelete.map((i) => i.key))
      if (searchMode) {
        setSearchHits((prev) => prev.filter((h) => !keys.has(h.key)))
      } else {
        setItems((prev) => prev.filter((i) => !keys.has(i.key)))
        if (folderCount > 0) {
          void loadObjects(active, bucket, prefix, bucketRegion, {
            page: listPage,
            marker: pageMarkers[listPage - 1],
          })
        }
      }
      clearSelection()
      setGalleryIndex(null)
      if (res.failed > 0) {
        toast.warning(
          `已删除 ${res.deleted} 个对象，${res.failed} 项失败`,
        )
      } else {
        toast.success(
          `批量删除完成：请求 ${res.requested} 项，共删除 ${res.deleted} 个对象`,
        )
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setBatchDeleting(false)
    }
  }

  // 翻页 / 换目录 / 搜索切换时清空勾选
  useEffect(() => {
    clearSelection()
  }, [bucket, prefix, listPage, searchQuery, searchPage])

  return (
    <div className="shell">
      {galleryIndex != null && active && bucket && previewItems.length > 0 && (
        <OssGalleryLightbox
          creds={toCreds(active)}
          bucket={bucket}
          bucketRegion={bucketRegion || undefined}
          items={previewItems}
          index={Math.min(galleryIndex, previewItems.length - 1)}
          onClose={() => setGalleryIndex(null)}
          onIndexChange={setGalleryIndex}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <h1>OSS Desk</h1>
          <p>Aliyun Object Storage</p>
        </div>

        <div className="account-head">
          <span>账号</span>
          <button className="btn-ghost" type="button" onClick={startAdd}>
            + 添加
          </button>
        </div>

        <div className="account-list">
          {accounts.length === 0 && (
            <p className="empty-hint">还没有账号，点击上方添加并填写名称</p>
          )}
          {accounts.map((acct) => (
            <div
              key={acct.id}
              className={`account-item ${activeId === acct.id ? 'active' : ''} ${acct.pinned ? 'pinned' : ''}`}
            >
              <button
                className="account-main"
                type="button"
                disabled={connecting}
                onClick={() => void doConnect(acct)}
              >
                <strong>
                  {acct.pinned ? (
                    <span className="pin-mark" title="已置顶">
                      顶
                    </span>
                  ) : null}
                  {acct.name || maskKey(acct.accessKeyId)}
                </strong>
                <span>{maskKey(acct.accessKeyId)}</span>
                <span className="region-tag">{acct.region}</span>
              </button>
              <div className="account-actions">
                <button
                  className={`btn-icon ${acct.pinned ? 'on' : ''}`}
                  type="button"
                  title={acct.pinned ? '取消置顶' : '置顶'}
                  onClick={() => onTogglePin(acct)}
                >
                  {acct.pinned ? '取消顶' : '置顶'}
                </button>
                <button
                  className="btn-icon"
                  type="button"
                  title="编辑"
                  onClick={() => startEdit(acct)}
                >
                  编辑
                </button>
                <button
                  className="btn-icon danger"
                  type="button"
                  title="删除"
                  onClick={() => void deleteAccount(acct)}
                >
                  删
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="status-bar">
          <span className={`status-dot ${connected ? 'ok' : ''}`} />
          <span>
            {connecting
              ? '连接中…'
              : connected
                ? `已连接 · ${buckets.length} 桶`
                : '未连接'}
          </span>
          <button
            className="btn-ghost download-entry"
            type="button"
            onClick={() => setShowDownloads(true)}
          >
            下载记录
            {downloadBadge.activeCount > 0
              ? downloadBadge.percent === -1
                ? ` · 进行中`
                : ` · ${downloadBadge.percent}%`
              : ''}
          </button>
        </div>
      </aside>

      <main className="main">
        {!connected && !showForm && (
          <div className="welcome">
            <h2>登录阿里云 OSS</h2>
            <p>
              使用 AccessKey 登录，可为每个账号自定义名称并置顶，方便区分多个账号。
            </p>
            <button className="btn-primary" type="button" onClick={startAdd}>
              添加账号并登录
            </button>
          </div>
        )}

        {connected && !bucket && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Buckets</h2>
                <p>
                  {active?.name} · {buckets.length} 个
                  <span className="stat-note"> · 容量约有 1 小时延迟</span>
                </p>
              </div>
              <button
                className="btn-light"
                type="button"
                disabled={connecting || !active}
                onClick={() => active && void doConnect(active, { silent: true })}
              >
                刷新
              </button>
            </header>
            <div className="bucket-grid">
              {buckets.map((b) => {
                const stat = bucketStats[b.name]
                return (
                  <button
                    key={b.name}
                    className="bucket-card"
                    type="button"
                    onClick={() => openBucket(b)}
                  >
                    <strong>{b.name}</strong>
                    <span>{b.region}</span>
                    <span className="bucket-stat">
                      {!stat || stat.status === 'loading'
                        ? '容量加载中…'
                        : stat.status === 'error'
                          ? '容量不可用'
                          : `${formatBucketStorage(stat.storage)} · ${stat.objectCount.toLocaleString('zh-CN')} 对象`}
                    </span>
                    <span>{formatTime(b.creationDate)}</span>
                  </button>
                )
              })}
              {buckets.length === 0 && (
                <p className="empty-hint light">该账号下没有 Bucket</p>
              )}
            </div>
          </section>
        )}

        {connected && bucket && (
          <section className="panel objects">
            <header className="panel-head panel-head-stack">
              <div className="panel-head-row">
                <div className="breadcrumbs">
                  <button
                    className="crumb"
                    type="button"
                    onClick={backToBuckets}
                  >
                    Buckets
                  </button>
                  <span>/</span>
                  <button
                    className="crumb"
                    type="button"
                    onClick={() => goPrefix('')}
                  >
                    {bucket}
                  </button>
                  {crumbs.map((c) => (
                    <span key={c.prefix} className="crumb-group">
                      <span>/</span>
                      <button
                        className="crumb"
                        type="button"
                        onClick={() => goPrefix(c.prefix)}
                      >
                        {c.label}
                      </button>
                    </span>
                  ))}
                </div>
                <div className="head-actions">
                  <button
                    className={`btn-light ${viewMode === 'gallery' ? 'btn-toggle-on' : ''}`}
                    type="button"
                    title={viewMode === 'gallery' ? '切换为列表' : '切换为图片预览'}
                    onClick={toggleViewMode}
                  >
                    {viewMode === 'gallery' ? '列表' : '图片'}
                  </button>
                  <button
                    className="btn-light"
                    type="button"
                    disabled={loadingObjects || searching || !active}
                    onClick={() => {
                      if (!active) return
                      if (searchMode) {
                        void runSearch(
                          active,
                          bucket,
                          prefix,
                          bucketRegion,
                          searchQuery,
                          searchScope,
                          {
                            page: searchPage,
                            marker: searchPageMarkers[searchPage - 1],
                          },
                        )
                      } else {
                        void loadObjects(active, bucket, prefix, bucketRegion, {
                          page: listPage,
                          marker: pageMarkers[listPage - 1],
                        })
                      }
                    }}
                  >
                    刷新
                  </button>
                  {!searchMode && folders.length > 0 && (
                    <button
                      className="btn-light"
                      type="button"
                      disabled={!active}
                      title="重新扫描当前页各目录大小（大目录可能较慢）"
                      onClick={() => {
                        for (const item of folders) {
                          void loadFolderStat(item.key, { force: true })
                        }
                      }}
                    >
                      统计目录
                    </button>
                  )}
                </div>
              </div>
              <div className="search-bar">
                <input
                  className="search-input"
                  value={searchInput}
                  placeholder="搜索文件名（递归子孙目录）"
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSearch()
                  }}
                />
                <label className="search-scope">
                  <input
                    type="checkbox"
                    checked={searchScope === 'bucket'}
                    onChange={(e) =>
                      setSearchScope(e.target.checked ? 'bucket' : 'current')
                    }
                  />
                  全桶
                </label>
                <button
                  className="btn-primary"
                  type="button"
                  disabled={searching || !active}
                  onClick={submitSearch}
                >
                  {searching ? '搜索中…' : '搜索'}
                </button>
                {searchMode && (
                  <button
                    className="btn-light"
                    type="button"
                    onClick={clearSearch}
                  >
                    清除
                  </button>
                )}
              </div>
              {(selected.size > 0 || selectableItems.length > 0) && (
                <div className="batch-bar">
                  <label className="batch-check">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectableItems.length === 0}
                      onChange={toggleSelectAll}
                    />
                    全选本页
                  </label>
                  <span className="muted">
                    已选 {selected.size} 项
                  </span>
                  <button
                    className="btn-danger"
                    type="button"
                    disabled={selected.size === 0 || batchDeleting}
                    onClick={() => void removeSelected()}
                  >
                    {batchDeleting ? '删除中…' : '批量删除'}
                  </button>
                  {selected.size > 0 && (
                    <button
                      className="btn-light"
                      type="button"
                      disabled={batchDeleting}
                      onClick={clearSelection}
                    >
                      取消选择
                    </button>
                  )}
                </div>
              )}
            </header>

            {viewMode === 'gallery' ? (
              <div className="gallery-wrap">
                {searchMode ? (
                  <>
                    {searchHits.map((hit) => (
                      <div
                        key={hit.key}
                        className={`gallery-card${selected.has(hit.key) ? ' is-selected' : ''}`}
                      >
                        <label className="card-check">
                          <input
                            type="checkbox"
                            checked={selected.has(hit.key)}
                            onChange={() => toggleSelect(hit.key, 'file')}
                          />
                        </label>
                        {isImageName(hit.name) && active ? (
                          <OssThumb
                            creds={toCreds(active)}
                            bucket={bucket}
                            bucketRegion={bucketRegion || undefined}
                            objectKey={hit.key}
                            alt={hit.name}
                            onPreview={() => openGalleryAt(hit.key)}
                          />
                        ) : (
                          <div className="thumb-frame thumb-file">
                            <span className="icon-file file" aria-hidden />
                          </div>
                        )}
                        <div className="gallery-meta">
                          <strong title={hit.name}>{hit.name}</strong>
                          <span title={hit.path}>{hit.path}</span>
                          <span>{formatSize(hit.size)}</span>
                        </div>
                        <div className="gallery-actions">
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => locateHit(hit)}
                          >
                            定位
                          </button>
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void openDownload(hit)}
                          >
                            打开
                          </button>
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void saveDownload(hit)}
                          >
                            下载
                          </button>
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void copyDownload(hit)}
                          >
                            复制
                          </button>
                          <button
                            className="btn-tiny danger"
                            type="button"
                            onClick={() => void removeObject(hit)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                    {!searching && searchHits.length === 0 && (
                      <p className="empty-hint light">
                        未找到包含「{searchQuery}」的文件
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {prefix && (
                      <button
                        className="gallery-card gallery-folder"
                        type="button"
                        onClick={() => {
                          const parent = prefix.replace(/[^/]+\/$/, '')
                          goPrefix(parent)
                        }}
                      >
                        <div className="thumb-frame thumb-folder">
                          <span className="icon-folder up" aria-hidden />
                        </div>
                        <div className="gallery-meta">
                          <strong>..</strong>
                          <span>上级目录</span>
                        </div>
                      </button>
                    )}
                    {folders.map((item) => (
                      <div
                        key={item.key}
                        className={`gallery-card gallery-folder${selected.has(item.key) ? ' is-selected' : ''}`}
                      >
                        <label className="card-check">
                          <input
                            type="checkbox"
                            checked={selected.has(item.key)}
                            onChange={() => toggleSelect(item.key, 'folder')}
                          />
                        </label>
                        <button
                          type="button"
                          className="gallery-folder-main"
                          onClick={() => openFolder(item.key)}
                        >
                          <div className="thumb-frame thumb-folder">
                            <span className="icon-folder dir" aria-hidden />
                          </div>
                          <div className="gallery-meta">
                            <strong title={item.name}>{item.name}/</strong>
                            <span>{(() => {
                              const stat = folderStatOf(item.key)
                              if (stat?.status === 'loading') return '统计中…'
                              if (stat?.status === 'ok') {
                                return `${stat.truncated ? '~ ' : ''}${formatSize(stat.size)} · ${stat.objectCount.toLocaleString('zh-CN')} 个对象`
                              }
                              return '目录'
                            })()}</span>
                          </div>
                        </button>
                        <div className="gallery-actions">
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => openFolder(item.key)}
                          >
                            打开
                          </button>
                          <button
                            className="btn-tiny danger"
                            type="button"
                            onClick={() => void removeObject(item)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                    {files.map((item) => (
                      <div
                        key={item.key}
                        className={`gallery-card${selected.has(item.key) ? ' is-selected' : ''}`}
                      >
                        <label className="card-check">
                          <input
                            type="checkbox"
                            checked={selected.has(item.key)}
                            onChange={() => toggleSelect(item.key, 'file')}
                          />
                        </label>
                        {isImageName(item.name) && active ? (
                          <OssThumb
                            creds={toCreds(active)}
                            bucket={bucket}
                            bucketRegion={bucketRegion || undefined}
                            objectKey={item.key}
                            alt={item.name}
                            onPreview={() => openGalleryAt(item.key)}
                          />
                        ) : (
                          <div className="thumb-frame thumb-file">
                            <span className="icon-file file" aria-hidden />
                          </div>
                        )}
                        <div className="gallery-meta">
                          <strong title={item.name}>{item.name}</strong>
                          <span>
                            {formatSize(item.size)} ·{' '}
                            {formatTime(item.lastModified)}
                          </span>
                        </div>
                        <div className="gallery-actions">
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void openDownload(item)}
                          >
                            打开
                          </button>
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void saveDownload(item)}
                          >
                            下载
                          </button>
                          <button
                            className="btn-tiny"
                            type="button"
                            onClick={() => void copyDownload(item)}
                          >
                            复制链接
                          </button>
                          <button
                            className="btn-tiny danger"
                            type="button"
                            onClick={() => void removeObject(item)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                    {!loadingObjects && items.length === 0 && (
                      <p className="empty-hint light">当前目录为空</p>
                    )}
                  </>
                )}
              </div>
            ) : (
            <div className="table-wrap">
              <table className="obj-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        disabled={selectableItems.length === 0}
                        onChange={toggleSelectAll}
                        title="全选本页"
                        aria-label="全选本页"
                      />
                    </th>
                    <th>{searchMode ? '路径 / 文件名' : '名称'}</th>
                    <th>大小</th>
                    <th>修改时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {searchMode ? (
                    <>
                      {searchHits.map((hit) => (
                        <tr
                          key={hit.key}
                          className={`row-file${selected.has(hit.key) ? ' is-selected' : ''}`}
                        >
                          <td className="col-check">
                            <input
                              type="checkbox"
                              checked={selected.has(hit.key)}
                              onChange={() => toggleSelect(hit.key, 'file')}
                              aria-label={`选择 ${hit.name}`}
                            />
                          </td>
                          <td>
                            <div className="search-hit">
                              <span className="name-file">
                                {isImageName(hit.name) && active ? (
                                  <OssThumb
                                    className="thumb-inline"
                                    creds={toCreds(active)}
                                    bucket={bucket}
                                    bucketRegion={bucketRegion || undefined}
                                    objectKey={hit.key}
                                    alt={hit.name}
                                    onPreview={() => openGalleryAt(hit.key)}
                                  />
                                ) : (
                                  <span className="icon-file file" aria-hidden />
                                )}
                                {hit.name}
                              </span>
                              <span className="search-path" title={hit.path}>
                                {hit.path}
                              </span>
                            </div>
                          </td>
                          <td>{formatSize(hit.size)}</td>
                          <td>{formatTime(hit.lastModified)}</td>
                          <td className="row-actions">
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => locateHit(hit)}
                            >
                              定位
                            </button>
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void openDownload(hit)}
                            >
                              打开
                            </button>
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void saveDownload(hit)}
                            >
                              下载
                            </button>
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void copyDownload(hit)}
                            >
                              复制链接
                            </button>
                            <button
                              className="btn-tiny danger"
                              type="button"
                              onClick={() => void removeObject(hit)}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!searching && searchHits.length === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            未找到包含「{searchQuery}」的文件
                          </td>
                        </tr>
                      )}
                    </>
                  ) : (
                    <>
                      {prefix && (
                        <tr
                          className="row-folder"
                          onDoubleClick={() => {
                            const parent = prefix.replace(/[^/]+\/$/, '')
                            goPrefix(parent)
                          }}
                        >
                          <td className="col-check" />
                          <td colSpan={4}>
                            <button
                              className="name-btn"
                              type="button"
                              onClick={() => {
                                const parent = prefix.replace(/[^/]+\/$/, '')
                                goPrefix(parent)
                              }}
                            >
                              <span className="icon-folder up" aria-hidden />
                              ..
                            </button>
                          </td>
                        </tr>
                      )}
                      {folders.map((item) => (
                        <tr
                          key={item.key}
                          className={`row-folder${selected.has(item.key) ? ' is-selected' : ''}`}
                          onDoubleClick={() => openFolder(item.key)}
                        >
                          <td className="col-check">
                            <input
                              type="checkbox"
                              checked={selected.has(item.key)}
                              onChange={() => toggleSelect(item.key, 'folder')}
                              aria-label={`选择目录 ${item.name}`}
                            />
                          </td>
                          <td>
                            <button
                              className="name-btn"
                              type="button"
                              onClick={() => openFolder(item.key)}
                            >
                              <span className="icon-folder dir" aria-hidden />
                              {item.name}/
                            </button>
                          </td>
                          <td>{renderFolderSize(item.key)}</td>
                          <td className="muted">{renderFolderTime(item.key)}</td>
                          <td className="row-actions">
                            <button
                              className="btn-tiny danger"
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void removeObject(item)
                              }}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                      {files.map((item) => (
                        <tr
                          key={item.key}
                          className={`row-file${selected.has(item.key) ? ' is-selected' : ''}`}
                        >
                          <td className="col-check">
                            <input
                              type="checkbox"
                              checked={selected.has(item.key)}
                              onChange={() => toggleSelect(item.key, 'file')}
                              aria-label={`选择 ${item.name}`}
                            />
                          </td>
                          <td>
                            <span className="name-file">
                              {isImageName(item.name) && active ? (
                                <OssThumb
                                  className="thumb-inline"
                                  creds={toCreds(active)}
                                  bucket={bucket}
                                  bucketRegion={bucketRegion || undefined}
                                  objectKey={item.key}
                                  alt={item.name}
                                  onPreview={() => openGalleryAt(item.key)}
                                />
                              ) : (
                                <span className="icon-file file" aria-hidden />
                              )}
                              {item.name}
                            </span>
                          </td>
                          <td>{formatSize(item.size)}</td>
                          <td>{formatTime(item.lastModified)}</td>
                          <td className="row-actions">
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void openDownload(item)}
                            >
                              打开
                            </button>
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void saveDownload(item)}
                            >
                              下载
                            </button>
                            <button
                              className="btn-tiny"
                              type="button"
                              onClick={() => void copyDownload(item)}
                            >
                              复制链接
                            </button>
                            <button
                              className="btn-tiny danger"
                              type="button"
                              onClick={() => void removeObject(item)}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!loadingObjects && items.length === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            当前目录为空
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>
            )}

            <footer className="panel-foot">
              <span className="muted">
                {searching || loadingObjects
                  ? '加载中…'
                  : searchMode
                    ? `搜索「${searchQuery}」· 第 ${searchPage} 页 · ${searchHits.length} 条${searchMeta ? ` · 本页扫描 ${searchMeta.scanned}` : ''}${searchScope === 'bucket' ? ' · 全桶' : ' · 当前及子孙'}`
                    : `第 ${listPage} 页 · ${folders.length} 个目录，本页 ${files.length} 个文件`}
              </span>
              <div className="pager">
                <label className="pager-size">
                  每页
                  <select
                    value={pageSize}
                    disabled={loadingObjects || searching}
                    onChange={(e) =>
                      changePageSize(Number(e.target.value) as PageSize)
                    }
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  条
                </label>
                {searchMode ? (
                  <>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={searching || searchPage <= 1}
                      onClick={() => void goSearchPage(searchPage - 1)}
                    >
                      上一页
                    </button>
                    <span className="pager-num">第 {searchPage} 页</span>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={searching || !searchTruncated}
                      onClick={() => void goSearchPage(searchPage + 1)}
                    >
                      下一页
                    </button>
                    <label className="pager-jump">
                      跳转
                      <input
                        value={searchJumpInput}
                        inputMode="numeric"
                        onChange={(e) =>
                          setSearchJumpInput(e.target.value.replace(/\D/g, ''))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const n = Number(searchJumpInput)
                            if (n >= 1) void goSearchPage(n)
                          }
                        }}
                      />
                      页
                    </label>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={searching || !searchJumpInput}
                      onClick={() => {
                        const n = Number(searchJumpInput)
                        if (n >= 1) void goSearchPage(n)
                      }}
                    >
                      GO
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={loadingObjects || listPage <= 1}
                      onClick={() => void goListPage(listPage - 1)}
                    >
                      上一页
                    </button>
                    <span className="pager-num">第 {listPage} 页</span>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={loadingObjects || !isTruncated || !nextMarker}
                      onClick={() => void goListPage(listPage + 1)}
                    >
                      下一页
                    </button>
                    <label className="pager-jump">
                      跳转
                      <input
                        value={jumpPageInput}
                        inputMode="numeric"
                        onChange={(e) =>
                          setJumpPageInput(e.target.value.replace(/\D/g, ''))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const n = Number(jumpPageInput)
                            if (n >= 1) void goListPage(n)
                          }
                        }}
                      />
                      页
                    </label>
                    <button
                      className="btn-light"
                      type="button"
                      disabled={loadingObjects || !jumpPageInput}
                      onClick={() => {
                        const n = Number(jumpPageInput)
                        if (n >= 1) void goListPage(n)
                      }}
                    >
                      GO
                    </button>
                  </>
                )}
              </div>
            </footer>
          </section>
        )}
      </main>

      <DownloadPanel open={showDownloads} onClose={() => setShowDownloads(false)} />

      {showForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowForm(false)}
        >
          <div
            className="modal-card form-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-head">
              <h3>{editingId ? '编辑账号' : '添加账号'}</h3>
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setShowForm(false)}
              >
                关闭
              </button>
            </header>
            <div className="form-body">
              <label>
                <span>账号名称（必填）</span>
                <input
                  value={form.name}
                  placeholder="例如：生产环境 / 图库账号"
                  autoFocus
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.pinned}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pinned: e.target.checked }))
                  }
                />
                <span>置顶此账号（列表最前）</span>
              </label>
              <label>
                <span>AccessKey ID（公钥）</span>
                <input
                  value={form.accessKeyId}
                  placeholder="LTAI..."
                  autoComplete="off"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, accessKeyId: e.target.value }))
                  }
                />
              </label>
              <label>
                <span>AccessKey Secret（密钥）</span>
                <input
                  type="password"
                  value={form.accessKeySecret}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, accessKeySecret: e.target.value }))
                  }
                />
              </label>
              <label>
                <span>Region</span>
                <select
                  value={form.region}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, region: e.target.value }))
                  }
                >
                  {REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>自定义 Endpoint（可选）</span>
                <input
                  value={form.endpoint}
                  placeholder="留空则用默认地域域名"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, endpoint: e.target.value }))
                  }
                />
              </label>
            </div>
            <footer className="modal-foot">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setShowForm(false)}
              >
                取消
              </button>
              <div className="modal-foot-right">
                <button
                  className="btn-primary"
                  type="button"
                  disabled={connecting}
                  onClick={() => void saveForm()}
                >
                  {connecting ? '连接中…' : '保存并登录'}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
