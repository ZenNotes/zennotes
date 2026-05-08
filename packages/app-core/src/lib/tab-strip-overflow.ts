export interface TabStripOverflowMetrics {
  scrollWidth: number
  clientWidth: number
}

export function isTabStripOverflowing(metrics: TabStripOverflowMetrics): boolean {
  return metrics.scrollWidth - metrics.clientWidth > 1
}
