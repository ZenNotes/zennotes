import { defaultGenId, type GenId } from '../database-csv'
import {
  DEFAULT_ID_FIELD_NAME,
  EMPTY_GROUP,
  type DatabaseSidecar,
  type DbField,
  type DbRow,
  type DbView,
  type FilterOp,
  type FilterRule,
  type SelectOption,
  type SortRule
} from '../databases'
import { assetMarkdown } from './blocks'
import type { NotionAsset, NotionIssueKind, NotionLinkTarget } from './render-context'
import { wikilink } from './rich-text'
import {
  plainText,
  type NotionPage,
  type NotionPropertySchema,
  type NotionPropertyValue,
  type NotionView,
  type NotionViewFilter
} from './types'

export interface NotionDatabaseInput {
  schema: Record<string, NotionPropertySchema>
  rows: NotionPage[]
  views: NotionView[]
  resolveRow(id: string): NotionLinkTarget | null
  assetFor(key: string): NotionAsset | null
  issue(kind: NotionIssueKind, detail: string): void
  genId?: GenId
}

export interface BuiltNotionDatabase {
  sidecar: DatabaseSidecar
  rows: DbRow[]
  /** Row id to the Markdown of the files in its `files` columns: a CSV cell
   *  can only name a file, so the record page is where they embed. */
  rowFiles: Map<string, string[]>
}

/** The key a `files` property entry is stored under. */
export function propertyFileKey(rowId: string, propertyId: string, index: number): string {
  return `prop-${rowId}-${encodeURIComponent(decodeProp(propertyId))}-${index}`
}

function decodeProp(id: string): string {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

const OPTION_COLORS: Record<string, string> = {
  gray: 'gray',
  brown: 'gray',
  orange: 'yellow',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  purple: 'purple',
  pink: 'red',
  red: 'red'
}

interface Column {
  field: DbField
  /** The Notion property it came from; a date range makes more than one. */
  property: string
  /** The first column a property makes is the one views refer to. */
  primary: boolean
  read(value: NotionPropertyValue | undefined, row: NotionPage): string
}

function userNames(users: Array<{ name?: string | null }> | undefined): string {
  return (users ?? [])
    .map((user) => user.name?.trim())
    .filter(Boolean)
    .join(', ')
}

function datePart(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : ''
}

function timePart(value: string | null | undefined): string {
  return value && value.includes('T') ? value.slice(11, 16) : ''
}

/** Any property value as readable text, for the columns with no typed form:
 *  a rollup that shows its related values, chiefly. */
function valueToText(value: NotionPropertyValue | undefined, input: NotionDatabaseInput): string {
  if (!value) return ''
  switch (value.type) {
    case 'title':
      return plainText(value.title)
    case 'rich_text':
      return plainText(value.rich_text)
    case 'number':
      return value.number == null ? '' : String(value.number)
    case 'select':
      return value.select?.name ?? ''
    case 'status':
      return value.status?.name ?? ''
    case 'multi_select':
      return (value.multi_select ?? []).map((option) => option.name).join(', ')
    case 'date':
      return value.date ? [value.date.start, value.date.end].filter(Boolean).join(' to ') : ''
    case 'checkbox':
      return value.checkbox ? 'true' : 'false'
    case 'url':
      return value.url ?? ''
    case 'email':
      return value.email ?? ''
    case 'phone_number':
      return value.phone_number ?? ''
    case 'people':
      return userNames(value.people)
    case 'created_by':
      return userNames(value.created_by ? [value.created_by] : [])
    case 'last_edited_by':
      return userNames(value.last_edited_by ? [value.last_edited_by] : [])
    case 'created_time':
      return value.created_time ?? ''
    case 'last_edited_time':
      return value.last_edited_time ?? ''
    case 'files':
      return (value.files ?? []).map((file) => file.name ?? '').join(', ')
    case 'relation':
      return (value.relation ?? [])
        .map((link) => input.resolveRow(link.id)?.title ?? '')
        .filter(Boolean)
        .join(', ')
    case 'unique_id':
      return value.unique_id?.number == null
        ? ''
        : [value.unique_id.prefix, value.unique_id.number].filter((part) => part != null && part !== '').join('-')
    case 'verification':
      return value.verification?.state ?? ''
    default:
      return ''
  }
}

function computedScalar(value: NotionPropertyValue | undefined): {
  kind: 'number' | 'boolean' | 'date' | 'text' | 'empty'
  text: string
} {
  const computed = value?.formula ?? value?.rollup
  if (!computed) return { kind: 'empty', text: '' }
  switch (computed.type) {
    case 'number':
      return computed.number == null
        ? { kind: 'empty', text: '' }
        : { kind: 'number', text: String(computed.number) }
    case 'boolean':
      return computed.boolean == null
        ? { kind: 'empty', text: '' }
        : { kind: 'boolean', text: computed.boolean ? 'true' : 'false' }
    case 'date':
      return computed.date
        ? { kind: 'date', text: datePart(computed.date.start) }
        : { kind: 'empty', text: '' }
    case 'string':
      return computed.string
        ? { kind: 'text', text: computed.string }
        : { kind: 'empty', text: '' }
    default:
      return { kind: 'empty', text: '' }
  }
}

/** Multi-select cells are comma-joined, so an option can't hold a comma. */
function multiOptionValue(name: string): string {
  return name.replace(/,/g, ';').trim()
}

function selectOptions(
  options: Array<{ name: string; color?: string }> | undefined,
  genId: GenId,
  value: (name: string) => string = (name) => name
): SelectOption[] {
  return (options ?? []).map((option) => {
    const color = option.color ? OPTION_COLORS[option.color] : undefined
    return { id: genId(), value: value(option.name), ...(color ? { color } : {}) }
  })
}

/** Headers double as frontmatter keys on the record page, where a colon would
 *  end the key early. */
function safeFieldName(name: string): string {
  const safe = name
    .replace(/[\r\n]+/g, ' ')
    .replace(/:/g, ' -')
    .replace(/\s+/g, ' ')
    .trim()
  return safe || 'Untitled'
}

function columnsForProperty(
  schema: NotionPropertySchema,
  input: NotionDatabaseInput,
  genId: GenId
): Column[] {
  const name = safeFieldName(schema.name)
  const key = schema.name
  const values = (): Array<NotionPropertyValue | undefined> =>
    input.rows.map((row) => row.properties?.[key])
  const column = (
    field: Partial<DbField> & Pick<DbField, 'type'>,
    read: Column['read'],
    fieldName = name,
    primary = true
  ): Column => ({
    field: { id: genId(), name: fieldName, ...field },
    property: key,
    primary,
    read
  })

  switch (schema.type) {
    case 'title':
    case 'rich_text':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'people':
    case 'created_by':
    case 'last_edited_by':
    case 'unique_id':
    case 'verification':
    case 'place':
      return [column({ type: 'text' }, (value) => valueToText(value, input))]
    case 'number':
      return [column({ type: 'number' }, (value) => valueToText(value, input))]
    case 'checkbox':
      return [column({ type: 'checkbox' }, (value) => (value?.checkbox ? 'true' : 'false'))]
    case 'select':
      return [
        column(
          { type: 'select', options: selectOptions(schema.select?.options, genId) },
          (value) => value?.select?.name ?? ''
        )
      ]
    case 'status':
      return [
        column(
          { type: 'select', options: selectOptions(schema.status?.options, genId) },
          (value) => value?.status?.name ?? ''
        )
      ]
    case 'multi_select': {
      const options = schema.multi_select?.options ?? []
      if (options.some((option) => option.name.includes(','))) {
        input.issue('option-renamed', `Commas in "${schema.name}" options became semicolons`)
      }
      return [
        column(
          { type: 'multiSelect', options: selectOptions(options, genId, multiOptionValue) },
          (value) => (value?.multi_select ?? []).map((option) => multiOptionValue(option.name)).join(', ')
        )
      ]
    }
    case 'date': {
      // A date cell holds one day. Notion's can hold a range and a time, so
      // those ride in their own columns only when some row has them.
      const dates = values().map((value) => value?.date)
      const columns = [column({ type: 'date' }, (value) => datePart(value?.date?.start))]
      if (dates.some((date) => date?.end)) {
        columns.push(
          column({ type: 'date' }, (value) => datePart(value?.date?.end), `${name} end`, false)
        )
      }
      if (dates.some((date) => timePart(date?.start) || timePart(date?.end))) {
        columns.push(
          column(
            { type: 'text' },
            (value) =>
              [timePart(value?.date?.start), timePart(value?.date?.end)].filter(Boolean).join(' to '),
            `${name} time`,
            false
          )
        )
      }
      return columns
    }
    case 'created_time':
      return [column({ type: 'date' }, (value) => datePart(value?.created_time))]
    case 'last_edited_time':
      return [column({ type: 'date' }, (value) => datePart(value?.last_edited_time))]
    case 'relation':
      return [
        column({ type: 'noteMulti' }, (value) =>
          (value?.relation ?? [])
            .map((link) => input.resolveRow(link.id))
            .filter((target): target is NotionLinkTarget => target !== null)
            .map((target) => wikilink(target.target, target.title))
            .join(' ')
        )
      ]
    case 'files':
      return [
        column({ type: 'text' }, (value, row) =>
          (value?.files ?? [])
            .map((file, index) => {
              const stored = input.assetFor(propertyFileKey(row.id, schema.id, index))
              if (stored) return stored.name
              return file.type === 'external' ? file.name || file.external?.url || '' : (file.name ?? '')
            })
            .filter(Boolean)
            .join(', ')
        )
      ]
    case 'formula':
    case 'rollup': {
      // Notion's schema doesn't say what a formula returns, and the import
      // freezes the results anyway, so the column takes the type they share.
      const kinds = new Set(values().map((value) => computedScalar(value).kind))
      kinds.delete('empty')
      const only = kinds.size === 1 ? [...kinds][0] : 'text'
      const type: DbField['type'] =
        only === 'number' ? 'number' : only === 'boolean' ? 'checkbox' : only === 'date' ? 'date' : 'text'
      let reportedEmpty = false
      return [
        column({ type }, (value) => {
          const computed = value?.formula ?? value?.rollup
          if (computed?.type === 'array') {
            return (value?.rollup?.array ?? [])
              .map((item) => valueToText(item, input))
              .filter(Boolean)
              .join(', ')
          }
          if ((computed?.type === 'unsupported' || computed?.type === 'incomplete') && !reportedEmpty) {
            reportedEmpty = true
            input.issue('computed-empty', `"${schema.name}" has values Notion would not compute over the API`)
          }
          return computedScalar(value).text
        })
      ]
    }
    default:
      // Button properties and anything newer. Nothing to keep in a cell.
      input.issue('unknown-block', `Property "${schema.name}" of type ${schema.type}`)
      return []
  }
}

const SIMPLE_OPS: Record<string, FilterOp> = {
  contains: 'contains',
  does_not_contain: 'notContains',
  greater_than: 'gt',
  less_than: 'lt',
  before: 'before',
  after: 'after'
}

/** One Notion condition as a rule, or null when ZenNotes has no equal for it:
 *  relative dates, `on_or_after`, conditions on people or formulas. */
function translateLeaf(
  leaf: NotionViewFilter,
  fieldFor: (property: string) => DbField | null
): FilterRule | null {
  if (!leaf.property) return null
  const field = fieldFor(leaf.property)
  if (!field) return null
  const typeKey = Object.keys(leaf).find((key) => key !== 'property')
  if (!typeKey) return null
  if (!['title', 'rich_text', 'number', 'checkbox', 'select', 'status', 'multi_select', 'date', 'url', 'email', 'phone_number'].includes(typeKey)) {
    return null
  }
  const conditions = leaf[typeKey] as Record<string, unknown> | undefined
  const entries = Object.entries(conditions ?? {})
  if (entries.length !== 1) return null
  const [condition, raw] = entries[0]
  const fieldId = field.id
  const value = raw == null ? undefined : typeKey === 'date' ? datePart(String(raw)) : String(raw)

  if (condition === 'is_empty' && raw === true) return { fieldId, op: 'isEmpty' }
  if (condition === 'is_not_empty' && raw === true) return { fieldId, op: 'isNotEmpty' }
  if (typeKey === 'checkbox') {
    if (condition === 'equals') return { fieldId, op: raw === true ? 'checked' : 'unchecked' }
    if (condition === 'does_not_equal') return { fieldId, op: raw === true ? 'unchecked' : 'checked' }
    return null
  }
  if (condition === 'equals') return { fieldId, op: 'is', value }
  if (condition === 'does_not_equal') return { fieldId, op: 'isNot', value }
  const op = SIMPLE_OPS[condition]
  return op ? { fieldId, op, value } : null
}

/**
 * A Notion filter as flat rules, keeping the view honest. From an `and`, a
 * clause with no equal can be dropped: the view shows more than Notion's did,
 * and the report says so. From an `or` it can't: dropping one would hide rows
 * the clause admitted, so the whole filter goes instead.
 */
function translateFilter(
  filter: NotionViewFilter | null | undefined,
  fieldFor: (property: string) => DbField | null
): { rules: FilterRule[]; conjunction: 'and' | 'or'; dropped: boolean } {
  if (!filter) return { rules: [], conjunction: 'and', dropped: false }
  if (filter.or) {
    const rules = filter.or.map((leaf) => translateLeaf(leaf, fieldFor))
    if (rules.some((rule) => rule === null)) return { rules: [], conjunction: 'and', dropped: true }
    return { rules: rules as FilterRule[], conjunction: 'or', dropped: false }
  }
  if (filter.and) {
    const rules: FilterRule[] = []
    let dropped = false
    for (const clause of filter.and) {
      if (clause.and) {
        const nested = translateFilter(clause, fieldFor)
        rules.push(...nested.rules)
        dropped ||= nested.dropped
        continue
      }
      const rule = translateLeaf(clause, fieldFor)
      if (rule) rules.push(rule)
      else dropped = true
    }
    return { rules, conjunction: 'and', dropped }
  }
  const rule = translateLeaf(filter, fieldFor)
  return { rules: rule ? [rule] : [], conjunction: 'and', dropped: !rule }
}

function buildView(
  view: NotionView,
  columns: Column[],
  idField: DbField,
  titleField: DbField | undefined,
  fieldFor: (property: string) => DbField | null,
  input: NotionDatabaseInput,
  genId: GenId
): DbView {
  const stated = view.name?.trim()
  // Notion calls a view it has no name for "Untitled", or leaves it blank.
  const name =
    stated && stated !== 'Untitled' ? stated : view.type.charAt(0).toUpperCase() + view.type.slice(1)
  const { rules, conjunction, dropped } = translateFilter(view.filter, fieldFor)
  if (dropped) {
    input.issue('filter-dropped', `View "${name}": part of its filter has no ZenNotes equal`)
  }

  const sorts: SortRule[] = []
  for (const sort of view.sorts ?? []) {
    const field = sort.property ? fieldFor(sort.property) : null
    if (field) sorts.push({ fieldId: field.id, direction: sort.direction === 'descending' ? 'desc' : 'asc' })
    else input.issue('sort-dropped', `View "${name}": a sort on ${sort.timestamp ?? sort.property}`)
  }

  // Columns a config leaves out stay visible: a surplus column costs less than
  // one that looks lost.
  const configured = view.configuration?.properties ?? []
  const hidden = new Set<string>([idField.id])
  const ordered: string[] = []
  const widths: Record<string, number> = {}
  for (const entry of configured) {
    const field = fieldFor(entry.property_id)
    if (!field) continue
    const family = columns.filter(
      (column) => column.property === columns.find((other) => other.field.id === field.id)?.property
    )
    for (const member of family) {
      ordered.push(member.field.id)
      if (entry.visible === false && member.field.id !== titleField?.id) hidden.add(member.field.id)
    }
    if (entry.width && entry.width > 0) widths[field.id] = Math.round(entry.width)
  }
  const allIds = [idField.id, ...columns.map((column) => column.field.id)]
  const columnOrder = [
    idField.id,
    ...(titleField ? [titleField.id] : []),
    ...ordered.filter((id) => id !== titleField?.id),
    ...allIds
  ].filter((id, index, list) => list.indexOf(id) === index)

  const base = {
    id: genId(),
    name,
    filters: rules,
    ...(conjunction === 'or' ? { filterConjunction: 'or' as const } : {}),
    sorts
  }
  const tableView: DbView = {
    ...base,
    type: 'table',
    columnOrder,
    hiddenFieldIds: [...hidden],
    ...(Object.keys(widths).length > 0 ? { columnWidths: widths } : {})
  }

  if (view.type === 'board') {
    const groupId = view.configuration?.group_by?.property_id
    const group = groupId ? fieldFor(groupId) : null
    if (group?.type === 'select') {
      return {
        ...base,
        type: 'board',
        groupByFieldId: group.id,
        boardColumnOrder: [...(group.options ?? []).map((option) => option.value), EMPTY_GROUP],
        cardFieldIds: columnOrder.filter(
          (id) => !hidden.has(id) && id !== group.id && id !== titleField?.id
        )
      }
    }
    input.issue('view-converted', `Board "${name}" is grouped by something other than a select or status, so it became a table`)
    return tableView
  }
  if (view.type !== 'table') {
    input.issue('view-converted', `The ${view.type} view "${name}" became a table`)
  }
  return tableView
}

export function buildNotionDatabase(input: NotionDatabaseInput): BuiltNotionDatabase {
  const genId = input.genId ?? defaultGenId
  const properties = Object.values(input.schema)
  // The first non-id field is a record's title everywhere in ZenNotes.
  properties.sort((a, b) => Number(b.type === 'title') - Number(a.type === 'title'))

  const columns: Column[] = properties.flatMap((schema) => columnsForProperty(schema, input, genId))
  const taken = new Set([DEFAULT_ID_FIELD_NAME])
  for (const column of columns) {
    let name = column.field.name
    if (taken.has(name.toLowerCase())) name = `${name} (Notion)`
    let n = 1
    const base = name
    while (taken.has(name.toLowerCase())) {
      n += 1
      name = `${base} ${n}`
    }
    taken.add(name.toLowerCase())
    column.field.name = name
  }

  const idField: DbField = { id: genId(), name: DEFAULT_ID_FIELD_NAME, type: 'text', hidden: true }
  const fields = [idField, ...columns.map((column) => column.field)]
  const titleField = columns.find((column) => input.schema[column.property]?.type === 'title')?.field

  const fieldByProperty = new Map<string, DbField>()
  for (const column of columns) {
    if (!column.primary) continue
    fieldByProperty.set(column.property, column.field)
    const propertyId = input.schema[column.property]?.id
    if (propertyId) {
      fieldByProperty.set(propertyId, column.field)
      fieldByProperty.set(decodeProp(propertyId), column.field)
    }
  }
  const fieldFor = (property: string): DbField | null =>
    fieldByProperty.get(property) ?? fieldByProperty.get(decodeProp(property)) ?? null

  const rowFiles = new Map<string, string[]>()
  const rows: DbRow[] = input.rows.map((page) => {
    const cells: Record<string, string> = { [idField.id]: page.id }
    for (const column of columns) {
      cells[column.field.id] = column.read(page.properties?.[column.property], page)
    }
    const files: string[] = []
    for (const schema of properties) {
      if (schema.type !== 'files') continue
      for (const [index, file] of (page.properties?.[schema.name]?.files ?? []).entries()) {
        const asset = input.assetFor(propertyFileKey(page.id, schema.id, index))
        if (asset) files.push(assetMarkdown(asset.path, asset.name))
        else if (file.type === 'external' && file.external?.url) {
          files.push(`[${file.name || file.external.url}](${file.external.url})`)
        } else input.issue('file-missing', `"${file.name ?? 'file'}" in "${schema.name}"`)
      }
    }
    if (files.length > 0) rowFiles.set(page.id, files)
    return { id: page.id, cells }
  })

  const views = input.views.map((view) =>
    buildView(view, columns, idField, titleField, fieldFor, input, genId)
  )
  if (views.length === 0) {
    views.push({
      id: genId(),
      name: 'Table',
      type: 'table',
      filters: [],
      sorts: [],
      columnOrder: fields.map((field) => field.id),
      hiddenFieldIds: [idField.id]
    })
  }

  return {
    sidecar: { version: 1, idFieldId: idField.id, fields, views, activeViewId: views[0].id },
    rows,
    rowFiles
  }
}
