import { Image as ImageIcon } from 'lucide-react';
import type { ArticleImage } from '../catalog-types';
import { builtInArticleImage, BUILT_IN_ARTICLE_IMAGE_COUNT } from '../catalog-images';
import './article-images-editor.css';

export type CatalogImageProps = {
  image?: ArticleImage | null;
  alt?: string;
  name?: string;
  className?: string;
  large?: boolean;
  variant?: 'thumb' | 'full';
};

/** The built-in library and persistent uploads use the same presentation. */
export function CatalogImage({ image, alt, name, className = '', large = false, variant = 'thumb' }: CatalogImageProps) {
  const imageLabel = alt ?? name ?? 'Artikelbild';
  const classes = `office-catalog-image ${large ? 'large' : ''} ${className}`;
  if (typeof image === 'string') {
    return <img className={classes} src={`/api/article-media/${encodeURIComponent(image)}?variant=${variant}`} alt={imageLabel} loading="lazy" decoding="async" />;
  }
  if (typeof image !== 'number' || !Number.isInteger(image) || image < 0 || image >= BUILT_IN_ARTICLE_IMAGE_COUNT) {
    return <span className={`${classes} empty`} role="img" aria-label={`${imageLabel} – bild saknas`}><ImageIcon size={large ? 32 : 22} aria-hidden="true" /></span>;
  }
  return <span className={classes} role="img" aria-label={imageLabel} style={{
    backgroundImage: `url(${builtInArticleImage(image, variant)})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  }} />;
}

export default CatalogImage;
