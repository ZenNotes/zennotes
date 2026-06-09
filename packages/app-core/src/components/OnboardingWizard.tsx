import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { resolveAuto, THEMES, type ThemeFamily, type ThemeMode } from '../lib/themes'
import {
  DEFAULT_DAILY_NOTES_DIRECTORY,
  type PrimaryNotesLocation,
  type VaultSettings
} from '@shared/ipc'
import { normalizeDailyNotesDirectory } from '../lib/vault-layout'
import { Button } from './ui/Button'
import appIcon from '../assets/zennotes-app-icon.png'

type StepId = 'welcome' | 'vim' | 'theme' | 'vault' | 'layout' | 'done'

const STEP_ORDER: StepId[] = ['welcome', 'vim', 'theme', 'vault', 'layout', 'done']

const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  vim: 'Vim mode',
  theme: 'Theme',
  vault: 'Vault',
  layout: 'Layout',
  done: 'Done'
}

interface Swatch {
  bg: string
  fg: string
  accent: string
}

interface ThemeFamilyDescriptor {
  family: ThemeFamily
  label: string
  light: Swatch
  dark: Swatch
}

const FAMILY_DESCRIPTORS: ThemeFamilyDescriptor[] = [
  {
    family: 'apple',
    label: 'Apple',
    light: { bg: '#f6f6f6', fg: '#1c1c1e', accent: '#0a84ff' },
    dark: { bg: '#1c1c1e', fg: '#f5f5f7', accent: '#0a84ff' }
  },
  {
    family: 'gruvbox',
    label: 'Gruvbox',
    light: { bg: '#fbf1c7', fg: '#3c3836', accent: '#d65d0e' },
    dark: { bg: '#282828', fg: '#ebdbb2', accent: '#fabd2f' }
  },
  {
    family: 'catppuccin',
    label: 'Catppuccin',
    light: { bg: '#eff1f5', fg: '#4c4f69', accent: '#8839ef' },
    dark: { bg: '#1e1e2e', fg: '#cdd6f4', accent: '#cba6f7' }
  },
  {
    family: 'github',
    label: 'GitHub',
    light: { bg: '#ffffff', fg: '#24292f', accent: '#0969da' },
    dark: { bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff' }
  },
  {
    family: 'solarized',
    label: 'Solarized',
    light: { bg: '#fdf6e3', fg: '#586e75', accent: '#268bd2' },
    dark: { bg: '#002b36', fg: '#93a1a1', accent: '#268bd2' }
  },
  {
    family: 'one',
    label: 'One',
    light: { bg: '#fafafa', fg: '#383a42', accent: '#4078f2' },
    dark: { bg: '#282c34', fg: '#abb2bf', accent: '#61afef' }
  },
  {
    family: 'nord',
    label: 'Nord',
    light: { bg: '#eceff4', fg: '#2e3440', accent: '#5e81ac' },
    dark: { bg: '#2e3440', fg: '#d8dee9', accent: '#88c0d0' }
  },
  {
    family: 'tokyo-night',
    label: 'Tokyo Night',
    light: { bg: '#e1e2e7', fg: '#3760bf', accent: '#2e7de9' },
    dark: { bg: '#1a1b26', fg: '#a9b1d6', accent: '#7aa2f7' }
  }
]

function prefersDarkSystem(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function swatchForMode(d: ThemeFamilyDescriptor, mode: ThemeMode): Swatch {
  if (mode === 'light') return d.light
  if (mode === 'dark') return d.dark
  return prefersDarkSystem() ? d.dark : d.light
}

export function OnboardingWizard(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const vimMode = useStore((s) => s.vimMode)
  const setVimMode = useStore((s) => s.setVimMode)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const themeId = useStore((s) => s.themeId)
  const setTheme = useStore((s) => s.setTheme)
  const openVaultPicker = useStore((s) => s.openVaultPicker)
  const connectRemoteWorkspace = useStore((s) => s.connectRemoteWorkspace)
  const workspaceSetupError = useStore((s) => s.workspaceSetupError)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const setVaultSettings = useStore((s) => s.setVaultSettings)
  const completeOnboarding = useStore((s) => s.completeOnboarding)
  const openHelpView = useStore((s) => s.openHelpView)

  const capabilities = window.zen.getCapabilities()
  const appInfo = window.zen.getAppInfo()
  const isServerVaultSetup =
    appInfo.runtime === 'web' && !capabilities.supportsLocalFilesystemPickers
  const canConnectRemote = appInfo.runtime === 'desktop' && capabilities.supportsRemoteWorkspace

  // Start where the user actually needs to act: skip to the vault step if a
  // vault is already connected (returning user who never finished onboarding).
  const [stepId, setStepId] = useState<StepId>(vault ? 'layout' : 'welcome')
  // Auto-advance from `vault` to `layout` runs once per session — once the
  // user has reached `layout`, going back to `vault` should be a real visit
  // (so they can pick a different folder) instead of an instant bounce.
  const autoAdvancedRef = useRef<boolean>(!!vault)
  // Highest step the user has reached. The rail uses this to gate forward
  // jumps so unreached steps stay non-interactive.
  const [maxReachedIndex, setMaxReachedIndex] = useState<number>(
    vault ? STEP_ORDER.indexOf('layout') : 0
  )

  const stepIndex = STEP_ORDER.indexOf(stepId)

  const goToStep = (next: StepId): void => {
    setStepId(next)
    const nextIdx = STEP_ORDER.indexOf(next)
    if (nextIdx > maxReachedIndex) setMaxReachedIndex(nextIdx)
  }
  const goNext = (): void => {
    const next = STEP_ORDER[stepIndex + 1]
    if (next) goToStep(next)
  }
  const goBack = (): void => {
    const prev = STEP_ORDER[stepIndex - 1]
    if (prev) goToStep(prev)
  }
  const finish = (): void => {
    completeOnboarding()
  }
  const skip = (): void => {
    completeOnboarding()
  }

  // Once a vault becomes available on the 'vault' step, advance automatically
  // so the wizard reflects the user's progress without an extra click. Only
  // fires the first time — otherwise clicking Back from `layout` would bounce
  // straight forward again.
  useEffect(() => {
    if (stepId === 'vault' && vault && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true
      setStepId('layout')
    }
  }, [stepId, vault])

  // Enter to advance, Esc to skip, ←/→ to navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          (target as HTMLElement).isContentEditable)
      if (e.key === 'Escape') {
        e.preventDefault()
        skip()
        return
      }
      if (inEditable) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (stepId === 'done') {
          finish()
          return
        }
        // Don't auto-advance from 'vault' — that step needs a vault picked
        // before progress is meaningful.
        if (stepId === 'vault' && !vault) return
        goNext()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (stepId === 'vault' && !vault) return
        if (stepId !== 'done') goNext()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (stepIndex > 0) goBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepId, stepIndex, vault])

  return (
    <div className="flex h-[calc(100vh-2.75rem)] w-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <StepRail
          current={stepIndex}
          maxReached={maxReachedIndex}
          steps={STEP_ORDER}
          onSelect={(target) => goToStep(target)}
        />

        <div className="rounded-3xl border border-paper-300/60 bg-paper-50/70 p-8 shadow-panel">
          {stepId === 'welcome' && <WelcomeStep onNext={goNext} />}
          {stepId === 'vim' && (
            <VimStep vimMode={vimMode} setVimMode={setVimMode} onBack={goBack} onNext={goNext} />
          )}
          {stepId === 'theme' && (
            <ThemeStep
              themeFamily={themeFamily}
              themeMode={themeMode}
              themeId={themeId}
              setTheme={setTheme}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {stepId === 'vault' && (
            <VaultStep
              isServerVaultSetup={isServerVaultSetup}
              canConnectRemote={canConnectRemote}
              openVaultPicker={openVaultPicker}
              connectRemoteWorkspace={connectRemoteWorkspace}
              workspaceSetupError={workspaceSetupError}
              hasVault={!!vault}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {stepId === 'layout' && (
            <LayoutStep
              primaryLocation={vaultSettings.primaryNotesLocation}
              dailyEnabled={vaultSettings.dailyNotes.enabled}
              dailyDirectory={vaultSettings.dailyNotes.directory}
              setVaultSettings={setVaultSettings}
              hasVault={!!vault}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {stepId === 'done' && (
            <DoneStep
              hasVault={!!vault}
              onBack={goBack}
              onFinish={() => {
                finish()
              }}
              onOpenHelp={() => {
                finish()
                void openHelpView()
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-end text-xs text-ink-500">
          <Button variant="ghost" size="sm" onClick={skip}>
            Skip setup
          </Button>
        </div>
      </div>

      <BrandMark />
    </div>
  )
}

function BrandMark(): JSX.Element {
  return (
    <div className="pointer-events-none fixed left-6 top-16 hidden items-center gap-2 text-xs text-ink-500 md:flex">
      <img src={appIcon} alt="" className="h-6 w-6 rounded-md" />
      <span className="font-medium tracking-wide">ZenNotes</span>
    </div>
  )
}

function StepRail({
  current,
  maxReached,
  steps,
  onSelect
}: {
  current: number
  maxReached: number
  steps: StepId[]
  onSelect: (step: StepId) => void
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      {steps.map((step, i) => {
        const active = i === current
        const done = i < current
        const reachable = i <= maxReached
        return (
          <button
            key={step}
            type="button"
            onClick={() => {
              if (reachable && !active) onSelect(step)
            }}
            disabled={!reachable || active}
            aria-current={active ? 'step' : undefined}
            aria-label={`${STEP_LABELS[step]} — step ${i + 1} of ${steps.length}`}
            className={[
              'group flex flex-1 flex-col items-stretch gap-1.5 rounded-md p-1 text-left transition-colors',
              reachable && !active
                ? 'cursor-pointer hover:bg-paper-200/40'
                : 'cursor-default'
            ].join(' ')}
          >
            <span
              className={[
                'h-1.5 w-full rounded-full transition-colors',
                done
                  ? 'bg-accent'
                  : active
                    ? 'bg-accent/70'
                    : reachable
                      ? 'bg-paper-300/80'
                      : 'bg-paper-300/40'
              ].join(' ')}
            />
            <span
              className={[
                'text-2xs font-medium uppercase tracking-[0.12em] transition-colors',
                active
                  ? 'text-ink-900'
                  : reachable
                    ? 'text-ink-600 group-hover:text-ink-800'
                    : 'text-ink-400'
              ].join(' ')}
            >
              {STEP_LABELS[step]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function StepHeading({
  eyebrow,
  title,
  subtitle
}: {
  eyebrow: string
  title: string
  subtitle?: string
}): JSX.Element {
  return (
    <div className="mb-6">
      <div className="form-label">{eyebrow}</div>
      <h2 className="mt-2 font-serif text-2xl font-semibold text-ink-900">{title}</h2>
      {subtitle && <p className="mt-3 max-w-prose text-sm leading-6 text-ink-600">{subtitle}</p>}
    </div>
  )
}

function StepFooter({
  primaryLabel,
  primaryDisabled,
  onPrimary,
  onBack,
  hideBack,
  hint
}: {
  primaryLabel: string
  primaryDisabled?: boolean
  onPrimary: () => void
  onBack?: () => void
  hideBack?: boolean
  hint?: string
}): JSX.Element {
  return (
    <div className="mt-8 flex items-center justify-between gap-4">
      {hideBack ? (
        <span />
      ) : (
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
      )}
      <div className="flex items-center gap-3">
        {hint && <span className="text-xs text-ink-500">{hint}</span>}
        <Button
          variant="primary"
          size="md"
          onClick={onPrimary}
          disabled={primaryDisabled}
          className="shadow-panel"
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  )
}

function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div>
      <div className="flex flex-col items-center text-center">
        <img
          src={appIcon}
          alt="ZenNotes app icon"
          className="h-[72px] w-[72px] rounded-2xl shadow-panel"
        />
        <div className="mt-5">
          <h1 className="font-serif text-3xl font-semibold text-ink-900">Welcome to ZenNotes</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-ink-600">
            A keyboard-first markdown vault. Let's set up the few things that change how the app
            feels, then you can pick your folder of notes and start writing.
          </p>
        </div>
      </div>
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Vim mode" value="On / off" />
        <Tile label="Theme" value="Light · Dark · Auto" />
        <Tile label="Vault" value="Local or remote" />
      </div>
      <StepFooter
        primaryLabel="Get started →"
        onPrimary={onNext}
        hideBack
        hint="Enter ↵ to continue · Esc to skip"
      />
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-paper-300/60 bg-paper-100/60 px-4 py-3 text-left">
      <div className="form-label">{label}</div>
      <div className="mt-1 text-sm font-medium text-ink-900">{value}</div>
    </div>
  )
}

function VimStep({
  vimMode,
  setVimMode,
  onBack,
  onNext
}: {
  vimMode: boolean
  setVimMode: (on: boolean) => void
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  return (
    <div>
      <StepHeading
        eyebrow="Step 1"
        title="Vim mode"
        subtitle="ZenNotes is built around Vim motions — leader keys, normal/insert, gg/G, hjkl across the sidebar. You can change this any time in Settings."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoiceCard
          selected={vimMode}
          onClick={() => setVimMode(true)}
          title="Vim mode on"
          description="Normal mode, motions, leader, ex commands like :q and :w."
        />
        <ChoiceCard
          selected={!vimMode}
          onClick={() => setVimMode(false)}
          title="Vim mode off"
          description="A regular text editor with system shortcuts. Cmd+F searches, etc."
        />
      </div>
      <StepFooter primaryLabel="Continue →" onPrimary={onNext} onBack={onBack} />
    </div>
  )
}

function ChoiceCard({
  selected,
  onClick,
  title,
  description
}: {
  selected: boolean
  onClick: () => void
  title: string
  description: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex flex-col items-start gap-2 rounded-2xl border px-4 py-4 text-left transition-colors',
        selected
          ? 'border-accent/60 bg-accent/10 shadow-[0_0_0_2px_rgb(var(--z-accent)/0.25)_inset]'
          : 'border-paper-300/60 bg-paper-100/60 hover:bg-paper-200/60'
      ].join(' ')}
      aria-pressed={selected}
    >
      <span className="text-sm font-medium text-ink-900">{title}</span>
      <p className="text-xs leading-5 text-ink-600">{description}</p>
    </button>
  )
}

function ThemeStep({
  themeFamily,
  themeMode,
  themeId,
  setTheme,
  onBack,
  onNext
}: {
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  themeId: string
  setTheme: (next: { id: string; family: ThemeFamily; mode: ThemeMode }) => void
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  const applyFamily = (family: ThemeFamily): void => {
    const prefersDark =
      themeMode === 'dark' ||
      (themeMode === 'auto' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    const id = resolveAuto(family, prefersDark, themeId)
    setTheme({ id, family, mode: themeMode })
  }

  const applyMode = (mode: ThemeMode): void => {
    const prefersDark =
      mode === 'dark' ||
      (mode === 'auto' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    const id = resolveAuto(themeFamily, prefersDark, themeId)
    setTheme({ id, family: themeFamily, mode })
  }

  // Some families ship multiple flavors of the same mode (Gruvbox hard/medium/
  // soft, GitHub default/dimmed/high-contrast, Catppuccin frappe/macchiato/
  // mocha, etc.). Expose them as a contrast picker beneath Family.
  const resolvedMode: 'light' | 'dark' =
    themeMode === 'light'
      ? 'light'
      : themeMode === 'dark'
        ? 'dark'
        : prefersDarkSystem()
          ? 'dark'
          : 'light'
  const variants = useMemo(
    () => THEMES.filter((t) => t.family === themeFamily && t.mode === resolvedMode),
    [themeFamily, resolvedMode]
  )

  return (
    <div>
      <StepHeading
        eyebrow="Step 2"
        title="Pick your theme"
        subtitle="Each family has light + dark variants. Auto follows your system."
      />
      <div className="mb-5">
        <div className="form-label mb-2">Mode</div>
        <div className="inline-flex rounded-xl border border-paper-300/60 bg-paper-100/60 p-1">
          {(['light', 'dark', 'auto'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => applyMode(mode)}
              className={[
                'rounded-lg px-3 py-1.5 text-xs capitalize transition-colors',
                themeMode === mode
                  ? 'bg-paper-50 text-ink-900 shadow-sm'
                  : 'text-ink-600 hover:text-ink-900'
              ].join(' ')}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="form-label mb-2">Family</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {FAMILY_DESCRIPTORS.map((d) => (
          <ThemeFamilyTile
            key={d.family}
            descriptor={d}
            mode={themeMode}
            selected={themeFamily === d.family}
            onClick={() => applyFamily(d.family)}
          />
        ))}
      </div>

      {variants.length > 1 && (
        <div className="mt-5">
          <div className="form-label mb-2">Variant</div>
          <div className="flex flex-wrap gap-2">
            {variants.map((variant) => {
              const selected = variant.id === themeId
              return (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() =>
                    setTheme({ id: variant.id, family: themeFamily, mode: themeMode })
                  }
                  aria-pressed={selected}
                  className={[
                    'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                    selected
                      ? 'border-accent/60 bg-accent/10 text-ink-900 shadow-[0_0_0_2px_rgb(var(--z-accent)/0.25)_inset]'
                      : 'border-paper-300/60 bg-paper-100/60 text-ink-700 hover:bg-paper-200/60'
                  ].join(' ')}
                >
                  {variant.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <StepFooter primaryLabel="Continue →" onPrimary={onNext} onBack={onBack} />
    </div>
  )
}

function ThemeFamilyTile({
  descriptor,
  mode,
  selected,
  onClick
}: {
  descriptor: ThemeFamilyDescriptor
  mode: ThemeMode
  selected: boolean
  onClick: () => void
}): JSX.Element {
  const swatch = swatchForMode(descriptor, mode)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'group flex flex-col items-start gap-2 rounded-2xl border px-3 py-3 text-left transition-colors',
        selected
          ? 'border-accent/60 bg-accent/10 shadow-[0_0_0_2px_rgb(var(--z-accent)/0.25)_inset]'
          : 'border-paper-300/60 bg-paper-100/60 hover:bg-paper-200/60'
      ].join(' ')}
    >
      <div
        className="flex h-12 w-full items-center justify-between overflow-hidden rounded-lg px-2"
        style={{ background: swatch.bg }}
      >
        <span className="text-xs font-medium" style={{ color: swatch.fg }}>
          Aa
        </span>
        <span className="h-3 w-3 rounded-full" style={{ background: swatch.accent }} />
      </div>
      <div className="text-xs font-medium text-ink-900">{descriptor.label}</div>
    </button>
  )
}

function VaultStep({
  isServerVaultSetup,
  canConnectRemote,
  openVaultPicker,
  connectRemoteWorkspace,
  workspaceSetupError,
  hasVault,
  onBack,
  onNext
}: {
  isServerVaultSetup: boolean
  canConnectRemote: boolean
  openVaultPicker: () => Promise<void>
  connectRemoteWorkspace: () => Promise<void>
  workspaceSetupError: string | null
  hasVault: boolean
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  return (
    <div>
      <StepHeading
        eyebrow="Step 3"
        title="Choose a vault"
        subtitle={
          isServerVaultSetup
            ? 'Pick the folder on the server that ZenNotes should treat as your vault.'
            : 'Pick a folder on this machine. ZenNotes stores notes as plain .md files — yours to keep, back up, and sync however you like.'
        }
      />

      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <Button
          variant="primary"
          size="md"
          onClick={() => void openVaultPicker()}
          className="shadow-panel"
        >
          {isServerVaultSetup ? 'Connect to server vault' : 'Choose vault folder'}
        </Button>
        {canConnectRemote && (
          <Button
            variant="secondary"
            size="md"
            onClick={() => void connectRemoteWorkspace()}
            className="shadow-panel"
          >
            Connect to ZenNotes Server
          </Button>
        )}
      </div>

      {hasVault && (
        <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink-800">
          Vault connected. Continue to finish setup.
        </div>
      )}

      {workspaceSetupError && (
        <p className="mt-4 max-w-lg text-sm text-[rgb(var(--z-red))]">{workspaceSetupError}</p>
      )}

      <StepFooter
        primaryLabel={hasVault ? 'Continue →' : 'Pick a vault to continue'}
        primaryDisabled={!hasVault}
        onPrimary={onNext}
        onBack={onBack}
      />
    </div>
  )
}

function LayoutStep({
  primaryLocation,
  dailyEnabled,
  dailyDirectory,
  setVaultSettings,
  hasVault,
  onBack,
  onNext
}: {
  primaryLocation: PrimaryNotesLocation
  dailyEnabled: boolean
  dailyDirectory: string
  setVaultSettings: (next: VaultSettings) => Promise<void>
  hasVault: boolean
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  // Local draft so the directory input doesn't normalize on every keystroke.
  const [dirDraft, setDirDraft] = useState<string>(dailyDirectory)

  useEffect(() => {
    setDirDraft(dailyDirectory)
  }, [dailyDirectory])

  const commit = (patch: {
    primaryNotesLocation?: PrimaryNotesLocation
    dailyEnabled?: boolean
    dailyDirectory?: string
  }): void => {
    const current = useStore.getState().vaultSettings
    void setVaultSettings({
      ...current,
      primaryNotesLocation: patch.primaryNotesLocation ?? current.primaryNotesLocation,
      dailyNotes: {
        enabled: patch.dailyEnabled ?? current.dailyNotes.enabled,
        directory:
          patch.dailyDirectory !== undefined
            ? normalizeDailyNotesDirectory(patch.dailyDirectory)
            : current.dailyNotes.directory
      }
    })
  }

  if (!hasVault) {
    return (
      <div>
        <StepHeading
          eyebrow="Step 4"
          title="Vault layout"
          subtitle="Pick a vault first — these settings live inside the vault."
        />
        <StepFooter primaryLabel="Back to vault" onPrimary={onBack} hideBack />
      </div>
    )
  }

  return (
    <div>
      <StepHeading
        eyebrow="Step 4"
        title="Vault layout"
        subtitle="How the vault should be organized. You can change either of these later in Settings."
      />

      <div className="space-y-6">
        <div>
          <div className="form-label mb-2">Primary notes location</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoiceCard
              selected={primaryLocation === 'inbox'}
              onClick={() => commit({ primaryNotesLocation: 'inbox' })}
              title="Inbox folder"
              description="Notes live under inbox/. Keeps ZenNotes' lifecycle structure: inbox → archive → trash."
            />
            <ChoiceCard
              selected={primaryLocation === 'root'}
              onClick={() => commit({ primaryNotesLocation: 'root' })}
              title="Vault root"
              description="Top-level .md files become the primary view. Obsidian-style flat vault."
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="form-label">Daily notes</div>
            <button
              type="button"
              role="switch"
              aria-checked={dailyEnabled}
              onClick={() => commit({ dailyEnabled: !dailyEnabled })}
              className={[
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                dailyEnabled ? 'bg-accent' : 'bg-paper-300'
              ].join(' ')}
            >
              <span
                className={[
                  'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                  dailyEnabled ? 'translate-x-4' : 'translate-x-0.5'
                ].join(' ')}
              />
            </button>
          </div>
          <p className="text-xs leading-5 text-ink-600">
            One note per day with a YYYY-MM-DD title, opened with a single command.
          </p>
          {dailyEnabled && (
            <div className="mt-3 flex items-center gap-2">
              <label className="text-xs text-ink-600" htmlFor="onboarding-daily-dir">
                Folder
              </label>
              <input
                id="onboarding-daily-dir"
                value={dirDraft}
                onChange={(e) => setDirDraft(e.target.value)}
                onBlur={() => commit({ dailyDirectory: dirDraft })}
                placeholder={DEFAULT_DAILY_NOTES_DIRECTORY}
                className="flex-1 rounded-lg border border-paper-300/70 bg-paper-100/60 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
              />
            </div>
          )}
        </div>
      </div>

      <StepFooter primaryLabel="Continue →" onPrimary={onNext} onBack={onBack} />
    </div>
  )
}

function DoneStep({
  hasVault,
  onBack,
  onFinish,
  onOpenHelp
}: {
  hasVault: boolean
  onBack: () => void
  onFinish: () => void
  onOpenHelp: () => void
}): JSX.Element {
  const tips = useMemo(
    () => [
      { keys: '⌘P', label: 'Find a note' },
      { keys: '⇧⌘P', label: 'Command palette' },
      { keys: '⇧⌘N', label: 'New quick note' },
      { keys: '⌘.', label: 'Toggle zen mode' },
      { keys: '⌘,', label: 'Settings' }
    ],
    []
  )

  return (
    <div>
      <StepHeading
        eyebrow="All set"
        title={hasVault ? "You're ready to write" : 'Choose a vault when you want to start'}
        subtitle={
          hasVault
            ? "Here are a few shortcuts to get you started. You can revisit any of this from Settings."
            : 'You skipped the vault step — open the welcome screen any time to pick one.'
        }
      />

      <div className="overflow-hidden rounded-2xl border border-paper-300/60 bg-paper-100/60">
        <ul className="divide-y divide-paper-300/45">
          {tips.map((tip) => (
            <li key={tip.keys} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-ink-800">{tip.label}</span>
              <kbd className="rounded-md border border-paper-300/70 bg-paper-50/80 px-2 py-0.5 font-mono text-xs text-ink-700">
                {tip.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8 flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <div className="flex items-center gap-3">
          {hasVault && (
            <Button
              variant="secondary"
              size="md"
              onClick={onOpenHelp}
              className="shadow-panel"
            >
              Open the help guide
            </Button>
          )}
          <Button variant="primary" size="md" onClick={onFinish} className="shadow-panel">
            {hasVault ? 'Start writing' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  )
}
