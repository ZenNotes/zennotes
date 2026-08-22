// Block-anchor grammar and walks live in shared-domain so the desktop main
// process (DOCX export) and any future pipeline resolve the same rules as the
// renderer. This module keeps the app-core import path stable.
export {
  extractBlock,
  findBlockAnchor,
  parseBlockAnchors,
  stripBlockAnchorMarkers,
  trailingBlockIdRange,
  type BlockAnchor
} from '@shared/block-anchors'
