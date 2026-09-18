import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Copy the browser harness evidence (screenshots, page dumps, request logs)
// out of the throwaway consumer directory so CI can upload it. The Chrome
// profile and the built consumer stay behind; they are large and reproducible.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const target = resolve(process.argv[2] || join(root, 'dist/app-core-browser-evidence'))
const manifest = join(root, 'dist/shared-packages/app-core-consumer.json')
let consumer
try {
  consumer = JSON.parse(await readFile(manifest, 'utf8')).consumer
} catch {
  console.log('No consumer manifest; nothing to collect.')
  process.exit(0)
}
let copied = 0
for (const entry of await readdir(consumer, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory() || !entry.name.startsWith('browser-')) continue
  const source = join(consumer, entry.name)
  for (const file of await readdir(source)) {
    if (!/\.(?:png|json|txt)$/.test(file)) continue
    if (!(await stat(join(source, file))).isFile()) continue
    await mkdir(join(target, entry.name), { recursive: true })
    await cp(join(source, file), join(target, entry.name, file))
    copied++
  }
}
const result = join(consumer, 'result.json')
if (await stat(result).then((info) => info.isFile()).catch(() => false)) {
  await mkdir(target, { recursive: true })
  await cp(result, join(target, 'package-result.json'))
  copied++
}
console.log(`Collected ${copied} evidence files into ${target}`)
