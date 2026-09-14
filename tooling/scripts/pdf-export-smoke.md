# Desktop PDF export test

A sample note exported by the ZenNotes desktop renderer on September 14, 2026. Both versions use the same content: one has a white page, and the other uses the dark theme.

This document exercises headings, long paragraphs, blockquotes, image captions, and images of different sizes. The green test images have borders and diagonal lines so clipping or distortion is easy to spot.

## Paragraph flow

A long note needs to remain comfortable to read when it becomes a printed document. The text should follow a consistent column from one page to the next. A paragraph may continue across a page boundary when there is more text than the current page can hold. The break should occur between complete lines, and the continuation should begin inside the top margin. The page background should extend behind the margins in the themed version, keeping the surrounding color consistent throughout the document.

Headings provide landmarks in that flow. When there is enough space for a heading but too little space for the beginning of its section, the heading should move with the text that follows it. This prevents a reader from reaching a section label at the bottom of a page and having to turn the page before seeing what the section contains. Short paragraphs remain readable, while longer paragraphs can use the available space without being treated as a single indivisible block.

The same principles apply to material quoted from another note. A long quotation may span more than one page, and its lines should remain inside the printable area. The indentation and background help distinguish the quotation from the surrounding text. They should not prevent the document from continuing naturally. Reading the end of one page and the start of the next should feel like following one continuous note, with no missing line or text pressed against the paper edge.

## Result

This heading should appear with the beginning of this paragraph. The section deliberately follows several paragraphs so the export must decide whether enough room remains for both the heading and its content.

## Landscape image

The following image has an explicit 1200 by 750 size hint. It should scale down to the reading column without retaining an oversized empty box around the visible picture.

![[image.png|1200x750]]

The image caption belongs with the image. When enough room remains to keep an image readable, it should scale proportionally to use that space. Its aspect ratio should remain unchanged, and all four edges should be visible.

## A quotation across pages

> A useful export preserves the order and meaning of the original note. A reader can move from an observation to its supporting explanation, then inspect the image that illustrates it. The document should not require the reader to guess which heading belongs to which paragraph or whether an image has been cut off. Consistent spacing helps the eye follow the sequence of the note, while the page margins keep text clear of the edges. These details matter most in longer documents, where the same patterns repeat over several pages and small inconsistencies become distracting. This quotation is intentionally long enough to exercise that continuation behavior. It remains one paragraph even though it contains several sentences. When it reaches a page boundary, the renderer should carry the remaining lines onto the next sheet without dropping content or reserving a large empty region just because the paragraph continues. The first line on the new page should sit inside the same top margin used elsewhere. The final sentence of the quotation marks the end of this test passage.

## Follow-up text

This section follows the quotation and should remain in document order. It provides another heading and paragraph pair for the renderer to place. The heading is useful only when readers can immediately see the content it introduces. If a page ends before both can fit, they should begin together on the next page.

## Portrait image

![[portrait.png]]

## Small image

![[small.png]]

The small image above is only 80 by 40 pixels. It should stay small rather than stretching to the width of the document.

## End of test

Check that every image has its caption, the portrait shares a page with its heading, and the white or dark background remains consistent at each page edge.

<h2 style="break-before: page">Paragraph continuity</h2>

<!-- CONTINUITY_SAMPLE -->

<h2 style="break-before: page">Successive images</h2>

Successive image introduction stays with the first picture.

<div style="height: 440px"></div>

![[sequence-first.png]]

![[sequence-second.png]]

The second picture should use its full reading-column width after the first picture has fitted on the preceding page.

The forced break starts after this sentence.

<div style="break-before: page"></div>

## Forced page begins here

![[forced.png]]

The explicit page break remains in effect even when the image would fit on the preceding page.
