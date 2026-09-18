// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitExportImageBoxes, settleExportImages } from './export-images'

// #769: the preview lazy-loads local images, so in the hidden export window an
// image below the viewport never loaded and printed as an empty frame. The
// export now flips deferred images to eager and waits for every load to end.

function image(src: string | null, loading?: string): HTMLImageElement {
  const img = document.createElement('img')
  if (src !== null) img.setAttribute('src', src)
  if (loading) img.setAttribute('loading', loading)
  document.body.append(img)
  return img
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('settleExportImages', () => {
  it('turns lazy images eager and resolves once every load has ended', async () => {
    const lazy = image('zen-asset://v/bottom.png', 'lazy')
    const plain = image('https://example.test/remote.png')
    let settled = false
    const done = settleExportImages(document).then(() => {
      settled = true
    })

    expect(lazy.getAttribute('loading')).toBe('eager')
    await Promise.resolve()
    expect(settled).toBe(false)

    lazy.dispatchEvent(new Event('load'))
    await Promise.resolve()
    expect(settled).toBe(false)

    // A failed load ends the wait too: the export prints the broken image
    // rather than hanging on it.
    plain.dispatchEvent(new Event('error'))
    await done
    expect(settled).toBe(true)
  })

  it('resolves at once when nothing is pending', async () => {
    image(null)
    image('')
    await expect(settleExportImages(document)).resolves.toBeUndefined()
  })

  it('gives up after the timeout so a dead source cannot hang the export', async () => {
    vi.useFakeTimers()
    image('https://example.test/never.png', 'lazy')
    let settled = false
    const done = settleExportImages(document, 500).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toBe(true)
  })
})

describe('fitExportImageBoxes', () => {
  function sizedImage(width: number, height: number, boxWidth: number, boxHeight: number) {
    const img = image('zen-asset://v/screenshot.png')
    Object.defineProperties(img, {
      naturalWidth: { value: width },
      naturalHeight: { value: height }
    })
    img.style.width = `${width}px`
    img.style.height = `${height}px`
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      width: boxWidth,
      height: boxHeight
    } as DOMRect)
    return img
  }

  it('removes empty vertical space when a sized screenshot is constrained to the page width', () => {
    const img = sizedImage(1200, 750, 640, 750)
    fitExportImageBoxes(document)
    expect(img.style.width).toBe('640px')
    // The browser must derive 400px from the aspect ratio, including if the
    // printable column becomes narrower; the old 750px box wasted 350px.
    expect(img.style.height).toBe('auto')
  })

  it('shrinks a portrait frame to the picture constrained by the page height', () => {
    const img = sizedImage(800, 1600, 640, 864)
    fitExportImageBoxes(document)
    expect(img.style.width).toBe('432px')
    expect(img.style.height).toBe('auto')
  })

  it('preserves small images and author-requested smaller sizes', () => {
    const small = sizedImage(80, 40, 80, 40)
    const resized = sizedImage(1200, 750, 320, 200)
    fitExportImageBoxes(document)
    expect(small.style.width).toBe('80px')
    expect(resized.style.width).toBe('320px')
  })

  it('reserves room for a portrait caption and its preceding heading on the same page', () => {
    const img = sizedImage(800, 1600, 640, 864)
    const heading = document.createElement('h2')
    heading.style.margin = '20px 0'
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({ height: 50 } as DOMRect)
    const figure = document.createElement('figure')
    figure.style.margin = '10px 0'
    // The caption and frame occupy another 40px beyond the image itself.
    vi.spyOn(figure, 'getBoundingClientRect').mockReturnValue({ height: 904 } as DOMRect)
    figure.append(img)
    document.body.append(heading, figure)

    fitExportImageBoxes(document, 920)
    expect(img.style.width).toBe('385px')
    expect(img.style.height).toBe('auto')
  })

  it('leaves failed and hidden images alone', () => {
    const failed = sizedImage(0, 0, 100, 100)
    const hidden = sizedImage(800, 400, 0, 0)
    fitExportImageBoxes(document)
    expect(failed.style.height).toBe('0px')
    expect(hidden.style.height).toBe('400px')
  })
})
