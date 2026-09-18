/** Public publishers are untrusted. These libraries accept executable expressions
 * or unsanitized HTML after the Markdown sanitizer has already run. Keep them out
 * of the public bundle until a separate validated rendering contract exists. */
function unavailable(): never {
  throw new Error('Interactive plot rendering is unavailable on public shares. Use the source button to read the diagram code.')
}
export const JSXGraph = { initBoard: unavailable }
export default Object.assign(unavailable, { JSXGraph })
