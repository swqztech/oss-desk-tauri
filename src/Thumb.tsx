import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { signUrl, type CredsPayload } from './api'

/** 可预览的图片扩展名（含需 OSS 转码的 TIFF） */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|jfif|tiff?)$/i

/** 浏览器无法直接显示，需走 OSS 图片处理转 JPG */
const CONVERT_RE = /\.tiff?$/i

const urlCache = new Map<string, { url: string; expireAt: number }>()

export function isImageName(name: string) {
  return IMAGE_RE.test(name)
}

export function needsOssConvert(name: string) {
  return CONVERT_RE.test(name)
}

/** 预览用的 OSS process：TIFF 转 JPG，缩略图顺便缩小 */
export function previewProcess(
  name: string,
  kind: 'thumb' | 'full',
): string | undefined {
  if (!needsOssConvert(name)) return undefined
  return kind === 'thumb'
    ? 'image/resize,w_640/format,jpg'
    : 'image/resize,w_2560/format,jpg'
}

function cacheKey(bucket: string, key: string, process?: string) {
  return `${bucket}\0${key}\0${process || ''}`
}

export type PreviewItem = {
  key: string
  name: string
}

export async function fetchSignedPreview(
  creds: CredsPayload,
  bucket: string,
  bucketRegion: string | undefined,
  objectKey: string,
  alt: string,
  kind: 'thumb' | 'full',
) {
  const process = previewProcess(alt, kind)
  const ck = cacheKey(bucket, objectKey, process)
  const cached = urlCache.get(ck)
  if (cached && cached.expireAt > Date.now()) {
    return cached.url
  }

  const res = await signUrl(
    {
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      region: creds.region,
      endpoint: creds.endpoint,
    },
    {
      bucket,
      bucketRegion,
      key: objectKey,
      expires: 3600,
      process,
    },
  )
  urlCache.set(ck, {
    url: res.url,
    expireAt: Date.now() + 50 * 60 * 1000,
  })
  return res.url
}

/** 原图比例放大预览：点空白关闭，左右翻页 */
export function ImageLightbox({
  url,
  alt,
  index,
  total,
  loading,
  onClose,
  onPrev,
  onNext,
}: {
  url: string | null
  alt: string
  index: number
  total: number
  loading?: boolean
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}) {
  const [scale, setScale] = useState(1)
  const hasPrev = Boolean(onPrev && index > 0)
  const hasNext = Boolean(onNext && index < total - 1)

  useEffect(() => {
    setScale(1)
  }, [url, index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrev?.()
      if (e.key === 'ArrowRight') onNext?.()
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(5, s + 0.25))
      if (e.key === '-') setScale((s) => Math.max(0.5, s - 0.25))
      if (e.key === '0') setScale(1)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose, onPrev, onNext])

  return createPortal(
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || '图片预览'}
      onClick={onClose}
    >
      <div className="img-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="img-lightbox-title" title={alt}>
          {alt}
          {total > 1 ? (
            <em className="img-lightbox-count">
              {' '}
              · {index + 1}/{total}
            </em>
          ) : null}
        </span>
        <div className="img-lightbox-actions">
          <button
            type="button"
            className="btn-light"
            disabled={!hasPrev}
            onClick={onPrev}
          >
            上一张
          </button>
          <button
            type="button"
            className="btn-light"
            disabled={!hasNext}
            onClick={onNext}
          >
            下一张
          </button>
          <button
            type="button"
            className="btn-light"
            onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
          >
            缩小
          </button>
          <button
            type="button"
            className="btn-light"
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="btn-light"
            onClick={() => setScale((s) => Math.min(5, s + 0.25))}
          >
            放大
          </button>
          <button type="button" className="btn-light" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {/* 点图片两侧空白区域关闭 */}
      <div className="img-lightbox-stage" onClick={onClose}>
        {hasPrev && (
          <button
            type="button"
            className="img-nav img-nav-prev"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              onPrev?.()
            }}
          >
            ‹
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            className="img-nav img-nav-next"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              onNext?.()
            }}
          >
            ›
          </button>
        )}

        <div
          className={`img-lightbox-canvas ${scale > 1 ? 'is-zoomed' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => {
            e.preventDefault()
            const delta = e.deltaY > 0 ? -0.12 : 0.12
            setScale((s) =>
              Math.min(5, Math.max(0.5, Number((s + delta).toFixed(2)))),
            )
          }}
        >
          {loading || !url ? (
            <span className="img-lightbox-loading">加载中…</span>
          ) : (
            <img
              src={url}
              alt={alt}
              className="img-lightbox-img"
              style={{ transform: `scale(${scale})` }}
              draggable={false}
              onClick={() => setScale((s) => (s === 1 ? 2 : 1))}
              title="点击图片放大/还原；点两侧空白关闭；← → 翻页"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 带签名加载与翻页的图库预览 */
export function OssGalleryLightbox({
  creds,
  bucket,
  bucketRegion,
  items,
  index,
  onClose,
  onIndexChange,
}: {
  creds: CredsPayload
  bucket: string
  bucketRegion?: string
  items: PreviewItem[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
}) {
  const current = items[index]
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    let cancelled = false
    setLoading(true)
    setUrl(null)

    void fetchSignedPreview(
      creds,
      bucket,
      bucketRegion,
      current.key,
      current.name,
      'full',
    )
      .then((signed) => {
        if (!cancelled) {
          setUrl(signed)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    // 预取相邻
    const prefetch = [items[index - 1], items[index + 1]].filter(Boolean)
    for (const item of prefetch) {
      void fetchSignedPreview(
        creds,
        bucket,
        bucketRegion,
        item.key,
        item.name,
        'full',
      ).catch(() => {})
    }

    return () => {
      cancelled = true
    }
  }, [
    current,
    index,
    items,
    bucket,
    bucketRegion,
    creds.accessKeyId,
    creds.accessKeySecret,
    creds.region,
    creds.endpoint,
  ])

  if (!current) return null

  return (
    <ImageLightbox
      url={url}
      alt={current.name}
      index={index}
      total={items.length}
      loading={loading}
      onClose={onClose}
      onPrev={
        index > 0 ? () => onIndexChange(index - 1) : undefined
      }
      onNext={
        index < items.length - 1 ? () => onIndexChange(index + 1) : undefined
      }
    />
  )
}

type ThumbProps = {
  creds: CredsPayload
  bucket: string
  bucketRegion?: string
  objectKey: string
  alt: string
  className?: string
  preview?: boolean
  /** 由父级统一打开图库预览（支持翻页） */
  onPreview?: () => void
}

/** 懒加载签名 URL 的图片缩略图 */
export function OssThumb({
  creds,
  bucket,
  bucketRegion,
  objectKey,
  alt,
  className,
  preview = true,
  onPreview,
}: ThumbProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '160px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return

    let cancelled = false
    setFailed(false)

    void fetchSignedPreview(
      creds,
      bucket,
      bucketRegion,
      objectKey,
      alt,
      'thumb',
    )
      .then((signed) => {
        if (!cancelled) setUrl(signed)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [
    visible,
    bucket,
    bucketRegion,
    objectKey,
    alt,
    creds.accessKeyId,
    creds.accessKeySecret,
    creds.region,
    creds.endpoint,
  ])

  const openPreview = () => {
    if (!preview) return
    if (onPreview) {
      onPreview()
      return
    }
  }

  return (
    <div
      ref={ref}
      className={`thumb-frame ${className || ''}`}
      role={preview && url ? 'button' : undefined}
      tabIndex={preview && url ? 0 : undefined}
      onClick={openPreview}
      onKeyDown={
        preview && url
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openPreview()
              }
            }
          : undefined
      }
      title={
        needsOssConvert(alt) ? 'TIFF 预览（经 OSS 转 JPG）' : '点击预览'
      }
    >
      {url ? (
        <img src={url} alt={alt} loading="lazy" draggable={false} />
      ) : failed ? (
        <span className="thumb-fallback">
          {needsOssConvert(alt) ? 'TIFF预览失败' : '无法预览'}
        </span>
      ) : (
        <span className="thumb-fallback muted">加载中</span>
      )}
    </div>
  )
}
