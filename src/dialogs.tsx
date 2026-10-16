import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type ConfirmRequest = {
  type: 'confirm'
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

type DialogRequest = ConfirmRequest

type DialogApi = {
  confirm: (opts: Omit<ConfirmRequest, 'type' | 'resolve'>) => Promise<boolean>
}

const DialogContext = createContext<DialogApi | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null)

  const close = useCallback(() => setReq(null), [])

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise((resolve) => {
          setReq({ ...opts, type: 'confirm', resolve })
        }),
    }),
    [],
  )

  const cancel = () => {
    if (!req) return
    req.resolve(false)
    close()
  }

  const confirmOk = () => {
    if (!req) return
    req.resolve(true)
    close()
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && (
        <div className="modal-backdrop" role="presentation" onClick={cancel}>
          <div
            className="modal-card dialog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-head">
              <h3 id="app-dialog-title">{req.title}</h3>
              <button className="btn-secondary" type="button" onClick={cancel}>
                关闭
              </button>
            </header>

            <div className="dialog-body">
              <p className="dialog-message">{req.message}</p>
            </div>

            <footer className="modal-foot">
              <button className="btn-secondary" type="button" onClick={cancel}>
                {req.cancelLabel || '取消'}
              </button>
              <div className="modal-foot-right">
                <button
                  className={req.danger ? 'btn-danger' : 'btn-primary'}
                  type="button"
                  onClick={confirmOk}
                >
                  {req.confirmLabel || '确定'}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) {
    throw new Error('useDialog 必须在 DialogProvider 内使用')
  }
  return ctx
}
