/// <reference types="vite/client" />
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'

declare global {
  interface Window {
    zen: ZenBridge
  }
}

export {}
