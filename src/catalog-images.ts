/** Built-in cell IDs are stable even when the shared catalog changes. */
export function builtInArticleImage(index: number, variant: 'thumb' | 'full' = 'thumb') {
  return `/images/catalog/${index}-${variant}.webp`;
}
