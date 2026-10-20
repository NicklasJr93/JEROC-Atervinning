export default function ProductBrand({ large = false }: { large?: boolean }) {
  return <img className={`platform-brand${large ? ' large' : ''}`} src="/images/scrapplanner-logo.png" alt="ScrapPlanner" />;
}
