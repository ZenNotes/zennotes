// Thin re-export so existing renderer call sites keep working. The real
// implementation lives in `src/shared/tasklists.ts` so both processes can
// use the same task-index algorithm.
export { FENCE_RE, TASK_LINE_RE, toggleTaskAtIndex } from '@shared/tasklists'
