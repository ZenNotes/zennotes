export async function formatMarkdown(source: string): Promise<string> {
  const prettier = await import('prettier/standalone')
  const markdownPlugin = await import('prettier/plugins/markdown')

  return prettier.format(source, {
    parser: 'markdown',
    plugins: [markdownPlugin.default ?? markdownPlugin],
    proseWrap: 'preserve',
    tabWidth: 2,
    useTabs: false
  })
}
