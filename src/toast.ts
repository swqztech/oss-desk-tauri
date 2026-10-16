import { toast as sonner } from 'sonner'

function text(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

export const toast = {
  success: (message: string) => sonner.success(message),
  error: (err: unknown) => sonner.error(text(err)),
  info: (message: string) => sonner.message(message),
  warning: (message: string) => sonner.warning(message),
}
