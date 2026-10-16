import { startServer } from './index'

startServer().catch((err) => {
  console.error('[oss-api] failed to start', err)
  process.exit(1)
})
