import type { FileGuideApi } from './index'

declare global {
  interface Window {
    api: FileGuideApi
  }
}

export {}
