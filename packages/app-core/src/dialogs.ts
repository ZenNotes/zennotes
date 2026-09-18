import { promptApp, getPromptRequest } from './lib/prompt-requests'
import { confirmApp, getConfirmRequest } from './lib/confirm-requests'
import type { PromptOptions } from './components/PromptModal'
import type { ConfirmOptions } from './components/ConfirmModal'

export type { PromptOptions, PromptSuggestion } from './components/PromptModal'
export type { ConfirmOptions } from './components/ConfirmModal'
/** A second host dialog is cancelled instead of replacing an unresolved request. */
export function prompt(options: PromptOptions): Promise<string | null> {
  if (getPromptRequest() || getConfirmRequest()) return Promise.resolve(null)
  return promptApp({ ...options, suggestions: options.suggestions?.map(suggestion => ({ ...suggestion })) })
}
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (getPromptRequest() || getConfirmRequest()) return Promise.resolve(false)
  return confirmApp({ ...options })
}
