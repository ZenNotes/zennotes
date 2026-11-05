/**
 * A note's excerpt, for a row that already prints its title. The excerpt is the
 * opening of the body with its Markdown stripped, so a note that starts with a
 * heading repeats the title in it: "Old meeting notes The agenda covered". Search
 * keeps the whole excerpt; only what is read beside the title drops it.
 */
export function excerptBesideTitle(title: string, excerpt: string): string {
  const name = title.trim()
  const text = excerpt.trimStart()
  if (!name || !text.startsWith(name)) return excerpt
  const rest = text.slice(name.length)
  // `Plan` must not eat the start of `Planning the week`.
  return rest === '' || /^\s/.test(rest) ? rest.trimStart() : excerpt
}
