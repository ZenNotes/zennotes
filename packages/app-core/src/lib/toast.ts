import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: ToastType
  action?: ToastAction
}

interface ToastStore {
  toasts: Toast[]
  addToast: (message: string, type?: ToastType, action?: ToastAction) => void
  removeToast: (id: string) => void
}

function nextToastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  addToast: (message, type = 'info', action?: ToastAction) => {
    const id = nextToastId()
    set((s) => ({ toasts: [...s.toasts, { id, message, type, action }] }))
    setTimeout(() => get().removeToast(id), 4000)
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
