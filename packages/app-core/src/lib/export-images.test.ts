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

// #1078: an embedded Excalidraw drawing is not an <img> when the preview says it
// has rendered. Its host is hydrated by a React root that loads the drawing
// bundle and exports the scene to a PNG first, so the export printed the empty
// loading placeholder. The settle now waits for every drawing to finish.
describe('settleExportImages with Excalidraw embeds', () => {
  function drawingHost(target = 'diagram.excalidraw'): HTMLElement {
    const host = document.createElement('div')
    host.setAttribute('data-excalidraw-embed', target)
    document.body.append(host)
    return host
  }

  function drawingState(host: HTMLElement, state: 'loading' | 'error'): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-excalidraw-state', state)
    host.replaceChildren(el)
    return el
  }

  function drawingImage(host: HTMLElement): HTMLImageElement {
    const img = document.createElement('img')
    img.setAttribute('data-excalidraw-state', 'ready')
    img.setAttribute('loading', 'lazy')
    img.setAttribute('src', 'data:image/png;base64,AAAA')
    host.replaceChildren(img)
    return img
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('waits for a drawing to render, then for its image to load', async () => {
    const host = drawingHost()
    drawingState(host, 'loading')
    let settled = false
    const done = settleExportImages(document).then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    const img = drawingImage(host)
    await flush()
    // The drawing's image is lazy like any preview image, so it goes eager too.
    expect(img.getAttribute('loading')).toBe('eager')
    expect(settled).toBe(false)

    img.dispatchEvent(new Event('load'))
    await done
    expect(settled).toBe(true)
  })

  it('waits for a host whose React root has not mounted anything yet', async () => {
    const host = drawingHost()
    let settled = false
    const done = settleExportImages(document).then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    const img = drawingImage(host)
    await flush()
    img.dispatchEvent(new Event('load'))
    await done
    expect(settled).toBe(true)
  })

  it('stops waiting on a drawing that failed to render', async () => {
    const host = drawingHost()
    drawingState(host, 'loading')
    const done = settleExportImages(document)
    await flush()
    drawingState(host, 'error')
    await expect(done).resolves.toBeUndefined()
  })

  it('ignores a host with no target, which the preview never hydrates', async () => {
    drawingHost('  ')
    await expect(settleExportImages(document)).resolves.toBeUndefined()
  })

  it('shares one timeout between the drawings and the images', async () => {
    vi.useFakeTimers()
    const host = drawingHost()
    drawingState(host, 'loading')
    let settled = false
    const done = settleExportImages(document, 500).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(300)
    // The drawing renders late; its image never loads.
    drawingImage(host)
    await vi.advanceTimersByTimeAsync(199)
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
