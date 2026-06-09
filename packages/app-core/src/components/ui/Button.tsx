import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

/**
 * Shared button primitive. One source of truth for every clickable action
 * in the app — variants encode hierarchy (primary is the single emphasized
 * action; secondary/ghost recede), sizes encode density. Colors resolve to
 * theme tokens, so all 29 themes are honored automatically.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE =
  'inline-flex items-center justify-center gap-1.5 font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink-900 text-paper-50 hover:bg-ink-800',
  secondary: 'border border-paper-300 bg-paper-100 text-ink-800 hover:bg-paper-200',
  ghost: 'text-ink-600 hover:bg-paper-200 hover:text-ink-900',
  danger: 'bg-danger text-white hover:bg-danger/90'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'rounded-md px-3 py-1.5 text-sm',
  md: 'rounded-lg px-4 py-2 text-sm'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', className = '', type = 'button', children, ...rest },
  ref
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={[BASE, VARIANTS[variant], SIZES[size], className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
})

/**
 * Square icon-only button. Standardizes the icon hit-area (previously a mix
 * of h-5/h-6/h-[34px] across the app). The glyph inside controls its own size.
 */
export type IconButtonSize = 'sm' | 'md'

const ICON_SIZES: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8'
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'ghost' | 'secondary'
  size?: IconButtonSize
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className = '', type = 'button', children, ...rest },
  ref
): JSX.Element {
  const look =
    variant === 'secondary'
      ? 'border border-paper-300 bg-paper-100 text-ink-700 hover:bg-paper-200 hover:text-ink-900'
      : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
  return (
    <button
      ref={ref}
      type={type}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        ICON_SIZES[size],
        look,
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
})
