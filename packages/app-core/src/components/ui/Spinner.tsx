export function Spinner({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`flex items-center justify-center py-8 ${className}`}>
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-300 border-t-accent" />
    </div>
  )
}
