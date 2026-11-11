import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { RELEASE_TARGETS, releaseTag } from './prepare-boundary-release.mjs'

const workflow = await readFile(new URL('../../.github/workflows/boundary-artifact-release.yml', import.meta.url), 'utf8')
const desktopRelease = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))

// The workflow's steps, each as its own text, so a test reads one step's
// condition and command together.
const steps = workflow.split(/\n(?= {6}- )/)

test('the workflow offers exactly the artifacts this script prepares', () => {
  const options = workflow.match(/^ +options: \[([^\]]*)\]$/m)[1].split(',').map((option) => option.trim())
  assert.deepEqual([...options].sort(), Object.keys(RELEASE_TARGETS).sort())
})

test('cloud-web is packed the way npm run artifact:cloud-web packs it', () => {
  assert.equal(packageJson.scripts['artifact:cloud-web'], `node tooling/scripts/${RELEASE_TARGETS['cloud-web'].join(' ')}`)
})

test('cloud-web is published as a pre-release that is never Latest; the others stay drafts', () => {
  const creates = steps.filter((step) => step.includes('gh release create'))
  assert.equal(creates.length, 2, 'one release step for cloud-web and one for the rest, each with a condition')
  const cloudWeb = creates.find((step) => step.includes("if: inputs.artifact == 'cloud-web'"))
  const others = creates.find((step) => step.includes("if: inputs.artifact != 'cloud-web'"))
  assert.ok(cloudWeb && others)
  // The website's CI downloads the pinned archive by URL, which a draft does not serve.
  assert.match(cloudWeb, /--prerelease --latest=false/)
  assert.doesNotMatch(cloudWeb, /--draft/)
  assert.match(others, /--draft --prerelease/)
  for (const step of creates) assert.match(step, /--target "\$SOURCE_COMMIT"/)
})

test('no boundary release tag can start a desktop release', () => {
  // release.yml builds a whole desktop release for every pushed tag that
  // matches this filter. If it changes, check every boundary tag against it.
  assert.match(desktopRelease, /^ {4}tags:\n(?: +#.*\n)* +- "v\[0-9\]\*"\n/m)
  for (const target of Object.keys(RELEASE_TARGETS)) {
    assert.doesNotMatch(releaseTag(target, '1.0.0'), /^v[0-9]/)
  }
})
