export default function ProductBrand({ large = false }: { large?: boolean }) {
  return <img className={`platform-brand${large ? ' large' : ''}`} src="/images/scrappilot-logo.svg" alt="ScrapPilot" />;
}
