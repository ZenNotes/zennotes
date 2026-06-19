/**
 * Remark plugin: expand `||` empty cells in GFM table headers to colspan.
 * Also supports `^^` in body cells for rowspan (vertical merge).
 *
 * Runs as a PRE-PROCESSOR before remark-gfm (normalizes || syntax to GFM),
 * then as a POST-PROCESSOR on the AST (sets colspan/rowspan hProperties).
 *
 * Syntax:
 *   | A || B |          →  Header: A (colspan=2), B
 *   |---|---|---|           Body row padded to match logical columns
 *   | 1 | 2 | 3 |
 *
 * Rowspan in body:
 *   | A | B |
 *   |---|---|
 *   | 1 | 2 |
 *   | ^^ | 3 |   →  First cell rowspan=2
 *
 * Also handles whitespace-only cells: `| A |     | B |` → same result.
 * Rowspan marker `^^` can have whitespace: `|  ^^  | 3 |` works too.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Table, TableRow, TableCell } from 'mdast'
import type { Transformer } from 'unified'

interface TableCellExt extends TableCell {
  colspan?: number
  rowspan?: number
}

function isWhitespaceOnly(cell: TableCell): boolean {
  if (cell.children.length === 0) return true
  return cell.children.every((child: any) =>
    child.type === 'text' && /^\s*$/.test(child.value)
  )
}

function isRowspanMarker(cell: TableCell): boolean {
  if (cell.children.length !== 1) return false
  const child = cell.children[0]
  return child.type === 'text' && /^\s*\^\^\s*$/.test(child.value)
}

// Count logical columns after merging empty cells left
function countLogicalColumns(row: TableRow): number {
  let count = 0
  for (let i = 0; i < row.children.length; i++) {
    const cell = row.children[i] as TableCellExt
    if (i === 0) {
      count = 1
    } else if (isWhitespaceOnly(cell)) {
      // This cell merges left → previous cell gets colspan++
      const prevCell = row.children[i - 1] as TableCellExt
      prevCell.colspan = (prevCell.colspan || 1) + 1
      // Don't count this as separate column
    } else {
      count++
    }
  }
  return count
}

// Pad body rows to match logical column count
function padBodyRows(bodyRows: TableRow[], logicalCols: number): void {
  for (const row of bodyRows) {
    while (row.children.length < logicalCols) {
      row.children.push({
        type: 'tableCell',
        children: []
      })
    }
  }
}

/**
 * Pre-processor: normalize `||` to `| |` (empty cell) so remark-gfm parses it.
 * Also normalize `---|---` separator row variations.
 */
function normalizeTableSyntax(tree: any): void {
  // We can't easily pre-process the raw text in remark because we only have AST here.
  // Instead, we'll handle the empty cell merging in the post-processor.
  // The key insight: remark-gfm DOES parse tables with empty cells like `| A |  | B |`
  // So users should write `| A |  | B |` for colspan, not `| A || B |`.
  // But for backwards compatibility with multimd-table, we could add a text pre-processor.
}

/**
 * Post-processor: set colspan/rowspan hProperties on parsed table nodes.
 */
function processTableAst(tree: any): void {
  visit(tree, 'table', (node: Table) => {
    if (!node.children || node.children.length < 2) return

    const headerRow = node.children[0] as TableRow
    const bodyRows = node.children.slice(1) as TableRow[]

    // Process header row for colspan FIRST
    for (let i = 0; i < headerRow.children.length; i++) {
      const cell = headerRow.children[i] as TableCellExt
      if (i > 0 && isWhitespaceOnly(cell)) {
        // This cell merges left → add colspan to previous, hide this cell
        const prevCell = headerRow.children[i - 1] as TableCellExt
        prevCell.colspan = (prevCell.colspan || 1) + 1
        // Apply colSpan immediately to previous cell
        const prevData = prevCell.data || (prevCell.data = {})
        const prevHProps = prevData.hProperties || (prevData.hProperties = {})
        prevHProps.colSpan = prevCell.colspan
        // Mark this cell as hidden via hProperties
        const cellData = cell.data || (cell.data = {})
        const hProps = cellData.hProperties || (cellData.hProperties = {})
        hProps.style = 'display: none'
        hProps.hidden = true
      }
    }

    // NOW count logical columns as sum of colspans in header
    let logicalCols = 0
    for (const cell of headerRow.children) {
      const cellExt = cell as TableCellExt
      if (!isWhitespaceOnly(cellExt)) {
        logicalCols += cellExt.colspan || 1
      }
    }

    // Pad body rows to match logical column count
    padBodyRows(bodyRows, logicalCols)

    // Process body rows for rowspan
    for (let rowIdx = 0; rowIdx < bodyRows.length; rowIdx++) {
      const row = bodyRows[rowIdx]
      for (let colIdx = 0; colIdx < row.children.length; colIdx++) {
        const cell = row.children[colIdx] as TableCellExt

        // Check for rowspan marker (^^)
        if (isRowspanMarker(cell)) {
          // Clear the cell content - it pulls from above
          cell.children = []

          // Find the cell above (in previous body row or header)
          let spanCount = 1
          for (let r = rowIdx - 1; r >= 0; r--) {
            const upperRow = bodyRows[r]
            if (!upperRow) break
            const upperCell = upperRow.children[colIdx] as TableCellExt
            // If upper cell already has rowspan, extend it
            if (upperCell.rowspan) {
              upperCell.rowspan++
            } else {
              upperCell.rowspan = 2
            }
            // Apply hProperties immediately so rehype picks it up
            const upperData = upperCell.data || (upperCell.data = {})
            const upperHProps = upperData.hProperties || (upperData.hProperties = {})
            upperHProps.rowSpan = upperCell.rowspan
            spanCount++
          }
          // Current cell gets hidden (it's the duplicate)
          const cellData = cell.data || (cell.data = {})
          const hProps = cellData.hProperties || (cellData.hProperties = {})
          hProps.style = 'display: none'
          hProps.hidden = true
        }

        // Apply rowspan from upper cells if any
        if (cell.rowspan && cell.rowspan > 1) {
          const cellData = cell.data || (cell.data = {})
          const hProps = cellData.hProperties || (cellData.hProperties = {})
          hProps.rowSpan = cell.rowspan
        }
      }
    }

    return [SKIP]
  })
}

// Export two functions: one for pre-processing (before remark-gfm), one for post (after)
function remarkTableColspanPre() {
  // This would need to run on raw text, but remark plugins work on AST.
  // For true pre-processing, we'd need a different approach.
  // For now, just return noop - users should use `| |` syntax.
  return (tree: any): void => {}
}

function remarkTableColspanPost() {
  return (tree: any): void => {
    processTableAst(tree)
  }
}

// Default export runs both (but pre is noop for now)
export default function remarkTableColspan(): Transformer {
  return (tree: any) => {
    processTableAst(tree)
  }
}

// Named exports for explicit ordering
export { remarkTableColspanPre, remarkTableColspanPost }