/**
 * Compare two display names "naturally": numeric-aware so "2 Foo" sorts before
 * "10 Foo", and case-insensitive. Used for folder, note, and asset name
 * sorting so leading numbers/letters order the way users expect. (#168)
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
