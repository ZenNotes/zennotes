import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import markdownItContainer from 'markdown-it-container';

type BoxKind = 'grammarbox' | 'indentbox' | 'importantbox';

type BoxMeta = {
  title: string | null;
  attrs: Record<string, string>;
};

type BoxSpec = {
  name: BoxKind;
  tag: 'div' | 'aside';
};

const BOX_SPECS: BoxSpec[] = [
  { name: 'grammarbox', tag: 'div' },
  { name: 'indentbox', tag: 'div' },
  { name: 'importantbox', tag: 'aside' },
];

function escapeHtml(md: MarkdownIt, value: string): string {
  return md.utils.escapeHtml(value);
}

function parseMeta(metaText: string): BoxMeta {
  const result: BoxMeta = { title: null, attrs: {} };

  const titleMatch = metaText.match(/\[([^\]]*)\]/);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    result.title = title.length > 0 ? title : null;
  }

  const attrMatch = metaText.match(/\{([^}]*)\}/);
  if (attrMatch) {
    const attrText = attrMatch[1];
    const attrRegex = /([a-zA-Z][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrText)) !== null) {
      const [, key, quoted, bare] = m;
      result.attrs[key] = (quoted ?? bare ?? '').trim();
    }
  }

  return result;
}

function stripKind(info: string, kind: string): string {
  return info.replace(new RegExp(`^${kind}\\b`), '').trim();
}

function validateParams(kind: string, params: string): boolean {
  const re = new RegExp(
    `^${kind}(\\[[^\\]]*\\])?(\\{[^}]*\\})?\\s*$`
  );
  return re.test(params.trim());
}

function renderOpen(
  md: MarkdownIt,
  tokens: Token[],
  idx: number,
  spec: BoxSpec
): string {
  const token = tokens[idx];
  const info = token.info.trim();
  const metaText = stripKind(info, spec.name);
  const { title, attrs } = parseMeta(metaText);

  const dataAttrs = Object.entries(attrs)
    .map(([key, value]) => {
      const safeKey = escapeHtml(md, key);
      const safeValue = escapeHtml(md, value);
      return ` data-${safeKey}="${safeValue}"`;
    })
    .join('');

  const titleHtml = title
    ? `<div class="md-box__title">${escapeHtml(md, title)}</div>`
    : '';

  return `<${spec.tag} class="md-box md-box--${spec.name}" data-kind="${spec.name}"${dataAttrs}><div class="md-box__inner">${titleHtml}<div class="md-box__body">`;
}

function renderClose(spec: BoxSpec): string {
  return `</div></div></${spec.tag}>`;
}

/**
 * Markdown-it plugin for custom box containers.
 * @param md - Markdown-it instance.
 * @param options - Configuration options.
 * @param options.enabled - Whether the plugin is active (default: false).
 * @param options.kinds - List of container kinds to enable (default: all three).
 */
export default function customBoxesPlugin(
  md: MarkdownIt,
  options: { enabled?: boolean; kinds?: BoxKind[] } = { enabled: false }
): void {
  if (!options?.enabled) {
    // Feature flag off: do nothing.
    return;
  }

  const kindsToEnable = options.kinds ?? BOX_SPECS.map(s => s.name);

  for (const spec of BOX_SPECS) {
    if (!kindsToEnable.includes(spec.name)) {
      continue;
    }

    md.use(markdownItContainer, spec.name, {
      validate(params: string) {
        return validateParams(spec.name, params);
      },
      render(tokens: Token[], idx: number): string {
        return tokens[idx].nesting === 1
          ? renderOpen(md, tokens, idx, spec)
          : renderClose(spec);
      },
    });
  }
}