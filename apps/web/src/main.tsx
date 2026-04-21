import { renderZenNotesApp } from '@zennotes/app-core/main'
import { installBridge } from './bridge/http-bridge'

installBridge()
renderZenNotesApp(document.getElementById('root')!)
