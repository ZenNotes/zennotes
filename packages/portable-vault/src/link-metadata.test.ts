import assert from 'node:assert/strict'
import { it } from 'vitest'
import { fetchLinkMetadataOnDevice } from './link-metadata'
import { installTestHost, RecordingHttp } from '../test/test-host'

function page(head: string) {
  installTestHost({
    http: new RecordingHttp(() => ({ status: 200, headers: {}, data: `<html><head>${head}</head></html>`, url: 'https://example.com/post' }))
  })
}

it('decodes each entity once, so an escaped entity stays text', async () => {
  // "&amp;lt;3" is the page saying "&lt;3" in so many characters. Decoding
  // &amp; first turned it into "<3", one unescape too many (CodeQL
  // js/double-escaping on PR #1069).
  page('<title>Fish &amp;lt;3 chips</title><meta property="og:description" content="Tom &amp;amp; Jerry &amp; friends &quot;live&quot;">')
  const meta = await fetchLinkMetadataOnDevice('https://example.com/post')
  assert.equal(meta.title, 'Fish &lt;3 chips')
  assert.equal(meta.description, 'Tom &amp; Jerry & friends "live"')
})

it('still decodes the entities a title carries', async () => {
  page('<meta property="og:title" content="A &lt;b&gt; tag &#39;quoted&#39; &#x2F; &nbsp;done &amp; dusted">')
  const meta = await fetchLinkMetadataOnDevice('https://example.com/post')
  assert.equal(meta.title, "A <b> tag 'quoted' /  done & dusted")
})
