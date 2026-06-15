/**
 * Minimal i18n for the Electron main process.
 *
 * The renderer owns the UI language (a zustand setting persisted to
 * localStorage), which the main process can't read. So the renderer pushes the
 * chosen language over IPC.APP_SET_LANGUAGE (on startup and on change) and we
 * cache it here. Until that arrives we default to English.
 *
 * Like the renderer's i18n, keys are the English source strings ("natural
 * keys") — an untranslated key just renders in English. This covers only the
 * strings main shows directly: native update dialogs, the update notifications,
 * and the updater `message` field (which the renderer surfaces verbatim).
 *
 * `{name}` placeholders are filled from the params object so interpolated
 * strings (versions, percentages) still translate.
 */
type MainLanguage = 'en' | 'zh'

let currentLanguage: MainLanguage = 'en'

export function setMainLanguage(language: string): void {
  currentLanguage = language === 'zh' ? 'zh' : 'en'
}

export function getMainLanguage(): MainLanguage {
  return currentLanguage
}

const ZH: Record<string, string> = {
  // Updater state messages (updater.ts) — also shown verbatim in Settings.
  'Updates are only available in packaged builds.': '更新仅在打包版本中可用。',
  'Check GitHub releases for a newer ZenNotes build.': '前往 GitHub releases 查看更新的 ZenNotes 版本。',
  'Unknown updater error.': '未知的更新错误。',
  'Update checks only work in packaged ZenNotes builds.': '更新检查仅在打包的 ZenNotes 版本中有效。',
  'Checking GitHub releases for updates…': '正在检查 GitHub releases 上的更新…',
  'ZenNotes {version} is available. Download it from inside the app.':
    'ZenNotes {version} 可用,可在应用内下载。',
  "You're already on ZenNotes {version}.": '你已经在使用 ZenNotes {version}。',
  'Downloading ZenNotes {version}… {percent}%.': '正在下载 ZenNotes {version}… {percent}%。',
  'ZenNotes {version} is ready. Restart to install the update.':
    'ZenNotes {version} 已就绪,重启即可安装更新。',
  'GitHub update check hit a temporary server error. Retrying ({attempt}/{total})…':
    'GitHub 更新检查遇到临时服务器错误,正在重试({attempt}/{total})…',
  'Downloading ZenNotes {version}…': '正在下载 ZenNotes {version}…',
  'Installing ZenNotes {version}… approve the administrator prompt to finish.':
    '正在安装 ZenNotes {version}… 请在管理员提示中确认以完成。',
  'Update install was canceled. Click “Install and Relaunch” to try again.':
    '更新安装已取消。点击“安装并重启”重试。',

  // Native notifications (showNativeUpdateNotification).
  'ZenNotes Update Available': 'ZenNotes 有可用更新',
  'ZenNotes {version} is available. Click to open Settings and download it.':
    'ZenNotes {version} 可用。点击打开设置并下载。',
  'ZenNotes Update Ready': 'ZenNotes 更新已就绪',
  'ZenNotes {version} is downloaded and ready to install. Click to open Settings.':
    'ZenNotes {version} 已下载并可安装。点击打开设置。',

  // Native "Check for Updates" dialogs (runMenuUpdateCheck in index.ts).
  'Download Update': '下载更新',
  Later: '稍后',
  OK: '确定',
  'ZenNotes {version} is available.': 'ZenNotes {version} 可用。',
  'Downloading Update': '正在下载更新',
  'ZenNotes {version} is downloading in the background.': 'ZenNotes {version} 正在后台下载。',
  'Open Settings → About to track progress and install when the download finishes.':
    '打开“设置 → 关于”可跟踪进度,并在下载完成后安装。',
  'Install and Relaunch': '安装并重启',
  'ZenNotes {version} is ready to install.': 'ZenNotes {version} 已可安装。',
  'Checking for updates…': '正在检查更新…',
  'Downloading update…': '正在下载更新…',
  'ZenNotes Updates': 'ZenNotes 更新',
  'ZenNotes is up to date.': 'ZenNotes 已是最新版本。',
  'Update checks are unavailable.': '更新检查不可用。',
  'Could not check for updates.': '无法检查更新。',

  // Native macOS application menu (installAppMenu in index.ts).
  'About ZenNotes': '关于 ZenNotes',
  'Check for Updates…': '检查更新…',
  'Settings…': '设置…',
  'Hide ZenNotes': '隐藏 ZenNotes',
  'Quit ZenNotes': '退出 ZenNotes',
  File: '文件',
  'Open Vault in New Window…': '在新窗口打开仓库…',
  Edit: '编辑',
  Copy: '复制',
  Paste: '粘贴',
  View: '视图',
  'Actual Size': '实际大小',
  'Zoom In': '放大',
  'Zoom Out': '缩小',
  Window: '窗口',
  Help: '帮助',
  'ZenNotes Website': 'ZenNotes 网站',
  'Join Discord': '加入 Discord',
  'GitHub Repository': 'GitHub 仓库',
  'Latest Release': '最新版本',
  'Report an Issue': '报告问题',

  // Native file/save dialogs (showOpenDialog / showSaveDialog in index.ts).
  'Open Vault in New Window': '在新窗口打开仓库',
  'Open Vault': '打开仓库',
  'Choose a vault folder': '选择仓库文件夹',
  'Export Note as PDF': '导出笔记为 PDF',
  'Export PDF': '导出 PDF',
  'Add to assets': '添加到素材',
  Add: '添加'
}

export function t(source: string, params?: Record<string, string | number>): string {
  const translated = currentLanguage === 'zh' ? ZH[source] ?? source : source
  if (!params) return translated
  return translated.replace(/\{(\w+)\}/g, (_match, key: string) =>
    key in params ? String(params[key]) : `{${key}}`
  )
}
