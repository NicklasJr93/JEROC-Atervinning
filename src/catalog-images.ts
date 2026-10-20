/** Built-in cell IDs are stable even when the shared catalog changes. */
export const BUILT_IN_ARTICLE_IMAGE_COUNT = 72;

export function builtInArticleImage(index: number, variant: 'thumb' | 'full' = 'thumb') {
  return `/images/catalog/${index}-${variant}.webp`;
}
