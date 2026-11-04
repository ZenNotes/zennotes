/**
 * Tool calls are handled concurrently, and a read of a note followed by a write
 * of it would lose whatever landed in between, so whatever edits one note takes
 * turns: the tools the agent edit recorder wraps, and the link rewrite after an
 * attachment moves.
 */

const queues = new Map<string, Promise<unknown>>()

export function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(key, next)
  const forget = (): void => {
    if (queues.get(key) === next) queues.delete(key)
  }
  next.then(forget, forget)
  return next
}

export function noteTurn<T>(root: string, rel: string, run: () => Promise<T>): Promise<T> {
  return oneAtATime(`${root}\0${rel}`, run)
}
