/** Numeric references point to the built-in example library; UUIDs to stored uploads. */
export type ArticleImage = number | string;

export type ArticleGroup = {
  id: string;
  name: string;
  description: string;
  photo: ArticleImage | null;
  parentId?: string;
  sortOrder: number;
  active: boolean;
  revision: number;
};

export type SaveArticleGroup = {
  group: Omit<ArticleGroup, 'id' | 'revision'> & { id?: string };
  expectedRevision?: number;
};

export function sortArticleGroups(groups: readonly ArticleGroup[]): ArticleGroup[] {
  return [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'sv') || a.id.localeCompare(b.id));
}

export function articleGroupPath(groups: readonly ArticleGroup[], groupId: string): ArticleGroup[] {
  const group = groups.find(item => item.id === groupId);
  if (!group) return [];
  const parent = group.parentId ? groups.find(item => item.id === group.parentId) : undefined;
  return parent ? [parent, group] : [group];
}

/** A subgroup is hidden when either it or its parent is inactive. */
export function activeArticleGroups(groups: readonly ArticleGroup[]): ArticleGroup[] {
  return sortArticleGroups(groups.filter(group => group.active && (!group.parentId || groups.some(parent => parent.id === group.parentId && parent.active))));
}

export function rootArticleGroups(groups: readonly ArticleGroup[], activeOnly = false): ArticleGroup[] {
  return sortArticleGroups((activeOnly ? activeArticleGroups(groups) : groups).filter(group => !group.parentId));
}

export function childArticleGroups(groups: readonly ArticleGroup[], parentId: string, activeOnly = false): ArticleGroup[] {
  return sortArticleGroups((activeOnly ? activeArticleGroups(groups) : groups).filter(group => group.parentId === parentId));
}
