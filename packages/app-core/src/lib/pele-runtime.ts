/**
 * The one module that imports Pele, reached only through the `import()` in
 * `mermaid-render`.
 *
 * It exists so the renderer's async chunk carries a name of ours,
 * `pele-runtime-*.js`: the perf harness and the packaged-web browser test
 * assert that this chunk is not fetched before a note needs a diagram, and
 * Pele's own module names (`lazy`, hashed chunk ids) are too generic to match.
 * `pele/lazy` keeps each diagram type in a chunk of its own, loaded the first
 * time a diagram of that type renders. The label-math typesetter comes along
 * for the same reason: it is only ever needed once a diagram is drawn.
 */
export { PeleError, render, renderAsync, supports } from 'pele/lazy'
export { typesetLabelMath } from './mermaid-label-math'
