import { useToastStore } from '../../lib/toast'

export function ToastHost(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-toast flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-lg bg-ink-900 px-4 py-3 text-sm text-paper-100 shadow-lg"
        >
          <span className="text-base">{t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}</span>
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick()
                useToastStore.getState().removeToast(t.id)
              }}
              className="ml-1 text-accent hover:text-accent/80 underline"
            >
              {t.action.label}
            </button>
          )}
          <button
            onClick={() => useToastStore.getState().removeToast(t.id)}
            className="ml-2 text-paper-400 hover:text-paper-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
