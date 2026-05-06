export interface SettingsSearchItem {
  id: string
  title: string
  description?: string
  keywords?: string[]
  targetId?: string
  available?: boolean
}

export interface SettingsSearchCategory<TCategoryId extends string = string> {
  id: TCategoryId
  title: string
  description: string
  keywords: string[]
  searchItems?: SettingsSearchItem[]
}

export type SettingsSearchResult<
  TCategory extends SettingsSearchCategory = SettingsSearchCategory
> =
  | {
      id: string
      type: 'category'
      title: string
      description: string
      category: TCategory
    }
  | {
      id: string
      type: 'setting'
      title: string
      description: string
      targetId: string
      category: TCategory
      item: SettingsSearchItem
    }

function includesQuery(value: string | undefined, query: string): boolean {
  return value?.toLowerCase().includes(query) ?? false
}

function itemMatches(item: SettingsSearchItem, query: string): boolean {
  return (
    includesQuery(item.title, query) ||
    includesQuery(item.description, query) ||
    (item.keywords ?? []).some((keyword) => includesQuery(keyword, query))
  )
}

function categoryMatches<TCategoryId extends string>(
  category: SettingsSearchCategory<TCategoryId>,
  query: string
): boolean {
  return (
    includesQuery(category.title, query) ||
    includesQuery(category.description, query) ||
    category.keywords.some((keyword) => includesQuery(keyword, query))
  )
}

function categoryResult<TCategory extends SettingsSearchCategory>(
  category: TCategory
): SettingsSearchResult<TCategory> {
  return {
    id: `${category.id}:category`,
    type: 'category',
    title: category.title,
    description: category.description,
    category
  }
}

function settingResult<TCategory extends SettingsSearchCategory>(
  category: TCategory,
  item: SettingsSearchItem
): SettingsSearchResult<TCategory> {
  return {
    id: `${category.id}:${item.id}`,
    type: 'setting',
    title: item.title,
    description: item.description ?? category.description,
    targetId: item.targetId ?? item.id,
    category,
    item
  }
}

export function getSettingsSearchResults<TCategory extends SettingsSearchCategory>(
  categories: TCategory[],
  query: string
): SettingsSearchResult<TCategory>[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return categories.map(categoryResult)

  return categories.flatMap((category) => {
    const matchedItems = (category.searchItems ?? []).filter(
      (item) => item.available !== false && itemMatches(item, normalized)
    )
    if (matchedItems.length > 0) {
      return matchedItems.map((item) => settingResult(category, item))
    }
    return categoryMatches(category, normalized) ? [categoryResult(category)] : []
  })
}
