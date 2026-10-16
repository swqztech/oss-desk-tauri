import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

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

export const desktopApi = {
  saveDownload: (
    url: string,
    filename: string
  ): Promise<{ ok: boolean; canceled?: boolean; id?: string; filePath?: string }> =>
    invoke('download_url', { url, filename }),
  listDownloads: (): Promise<DownloadRecord[]> => invoke('download_list'),
  clearDownloads: (): Promise<DownloadRecord[]> => invoke('download_clear'),
  removeDownload: (id: string): Promise<DownloadRecord[]> => invoke('download_remove', { id }),
  showDownload: (id: string): Promise<{ ok: boolean; missing?: boolean }> =>
    invoke('download_show', { id }),
  openDownload: (id: string): Promise<{ ok: boolean; missing?: boolean; error?: string }> =>
    invoke('download_open', { id }),
  onDownloadChanged: (cb: (rec: DownloadRecord) => void) => {
    let unlisten: UnlistenFn | undefined
    void listen<DownloadRecord>('download:changed', (ev) => {
      cb(ev.payload)
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      void unlisten?.()
    }
  }
}

declare global {
  interface Window {
    api: typeof desktopApi
  }
}

export function installDesktopApi() {
  window.api = desktopApi
}
