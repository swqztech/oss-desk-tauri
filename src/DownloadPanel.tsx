import { useEffect, useMemo, useState } from 'react'
import { toast } from './toast'

export type DownloadStatus = 'progress' | 'completed' | 'cancelled' | 'interrupted'

export type DownloadRecord = {
  id: string
  filename: string
  filePath: string
  received: number
  total: number
  percent: number
  status: DownloadStatus
  startedAt: number
  finishedAt?: number
  error?: string
}

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function statusLabel(s: DownloadStatus) {
  if (s === 'progress') return '下载中'
  if (s === 'completed') return '已完成'
  if (s === 'cancelled') return '已取消'
  return '失败'
}

export function DownloadPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [list, setList] = useState<DownloadRecord[]>([])

  useEffect(() => {
    const api = window.api
    if (!api?.listDownloads) return
    void api.listDownloads().then(setList).catch(() => undefined)
    return api.onDownloadChanged?.((rec) => {
      setList((prev) => {
        const next = prev.filter((x) => x.id !== rec.id)
        next.unshift(rec)
        return next.slice(0, 80)
      })
    })
  }, [])

  const active = useMemo(() => list.filter((x) => x.status === 'progress'), [list])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card download-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h3>
            下载记录
            {active.length > 0 ? ` · ${active.length} 个进行中` : ''}
          </h3>
          <div className="head-actions">
            <button
              className="btn-secondary"
              type="button"
              disabled={list.length === 0}
              onClick={() => void window.api.clearDownloads()?.then(setList)}
            >
              清空
            </button>
            <button className="btn-secondary" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        <div className="download-list">
          {list.length === 0 && <p className="empty-hint light">还没有下载记录</p>}
          {list.map((rec) => {
            const pct = rec.percent >= 0 ? rec.percent : 0
            const unknown = rec.status === 'progress' && rec.total <= 0
            return (
              <div key={rec.id} className={`download-item is-${rec.status}`}>
                <div className="download-item-top">
                  <strong title={rec.filePath}>{rec.filename}</strong>
                  <span className="download-status">{statusLabel(rec.status)}</span>
                </div>
                <div className="download-bar" aria-hidden>
                  <i
                    style={{
                      width: unknown ? '40%' : `${Math.min(100, pct)}%`,
                      opacity: rec.status === 'progress' ? 1 : rec.status === 'completed' ? 1 : 0.45,
                    }}
                    className={unknown ? 'indeterminate' : ''}
                  />
                </div>
                <p className="download-meta">
                  {rec.status === 'progress'
                    ? unknown
                      ? `已下载 ${formatBytes(rec.received)}`
                      : `${formatBytes(rec.received)} / ${formatBytes(rec.total)} · ${pct}%`
                    : rec.status === 'completed'
                      ? `${formatBytes(rec.received || rec.total)} · ${new Date(rec.finishedAt || rec.startedAt).toLocaleString('zh-CN', { hour12: false })}`
                      : rec.error || statusLabel(rec.status)}
                </p>
                <p className="download-path" title={rec.filePath}>
                  {rec.filePath || '未保存'}
                </p>
                <div className="download-actions">
                  <button
                    className="btn-light"
                    type="button"
                    disabled={rec.status !== 'completed'}
                    onClick={async () => {
                      const r = await window.api.openDownload(rec.id)
                      if (!r?.ok) toast.error(r?.missing ? '文件已不在原位置' : r?.error || '无法打开')
                    }}
                  >
                    打开文件
                  </button>
                  <button
                    className="btn-light"
                    type="button"
                    disabled={!rec.filePath}
                    onClick={async () => {
                      const r = await window.api.showDownload(rec.id)
                      if (!r?.ok) toast.error('找不到保存位置')
                      else if (r.missing) toast.error('文件已不在原位置，已打开所在文件夹')
                    }}
                  >
                    打开所在文件夹
                  </button>
                  <button
                    className="btn-light"
                    type="button"
                    onClick={() => void window.api.removeDownload(rec.id).then(setList)}
                  >
                    移除记录
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function useDownloadBadge() {
  const [activeCount, setActiveCount] = useState(0)
  const [percent, setPercent] = useState<number | null>(null)

  useEffect(() => {
    const api = window.api
    if (!api?.listDownloads) return
    const apply = (list: DownloadRecord[]) => {
      const running = list.filter((x) => x.status === 'progress')
      setActiveCount(running.length)
      if (running.length === 0) {
        setPercent(null)
        return
      }
      const known = running.filter((x) => x.percent >= 0)
      if (known.length === 0) setPercent(-1)
      else setPercent(Math.round(known.reduce((s, x) => s + x.percent, 0) / known.length))
    }
    void api.listDownloads().then(apply).catch(() => undefined)
    return api.onDownloadChanged?.(() => {
      void api.listDownloads().then(apply).catch(() => undefined)
    })
  }, [])

  return { activeCount, percent }
}
