import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import App from './App'
import { bootstrapAccounts } from './accounts'
import { DialogProvider } from './dialogs'
import { installDesktopApi } from './desktopApi'
import './index.css'

installDesktopApi()

const root = document.getElementById('root')!

void bootstrapAccounts().then(() => {
  createRoot(root).render(
    <StrictMode>
      <DialogProvider>
        <App />
        <Toaster
          position="top-center"
          richColors
          closeButton
          duration={4200}
          toastOptions={{
            className: 'oss-toast',
          }}
        />
      </DialogProvider>
    </StrictMode>,
  )
})
