import { useEffect, useId, useRef } from 'react';

type Sample = { x: number; y: number; nx: number; ny: number; position: number; cornerDamping: number };
const tau = Math.PI * 2;
const triangle = (value: number) => Math.asin(Math.sin(value)) * 2 / Math.PI;

/** The approved closed outline, animated without rerendering the card. */
export default function ElectricFocusBorder({ active }: { active: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const filterId = `office-electric-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    const svg = svgRef.current;
    const card = svg?.parentElement;
    if (!active || !svg || !card) return;
    const guide = svg.querySelector<SVGPathElement>('[data-electric-guide]')!;
    const paths = [...svg.querySelectorAll<SVGPathElement>('[data-electric-outline]')];
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let samples: Sample[] = [];
    let dimensions = '';
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let visible = true;

    const render = () => {
      const phase = elapsed / 2500 * tau;
      const points = samples.map(({ x, y, nx, ny, position, cornerDamping }) => {
        const roughness = Math.sin(position * tau * 31 - phase * 2) * .55
          + triangle(position * tau * 73 - phase * 3) * .4
          + Math.sin(position * tau * 127 - phase * 5) * .18;
        const offset = roughness * cornerDamping;
        return `${(x + nx * offset).toFixed(2)} ${(y + ny * offset).toFixed(2)}`;
      });
      const outline = `M${points.join('L')}Z`;
      paths.forEach(path => path.setAttribute('d', outline));
    };
    const resize = () => {
      const width = card.clientWidth;
      const height = card.clientHeight;
      if (!width || !height || dimensions === `${width}/${height}`) return;
      dimensions = `${width}/${height}`;
      const edge = .5;
      const radius = Math.min(parseFloat(getComputedStyle(card).borderTopLeftRadius) || 12, width / 2, height / 2);
      const right = width - edge;
      const bottom = height - edge;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      guide.setAttribute('d', `M${radius} ${edge}H${right - radius}Q${right} ${edge} ${right} ${radius}V${bottom - radius}Q${right} ${bottom} ${right - radius} ${bottom}H${radius}Q${edge} ${bottom} ${edge} ${bottom - radius}V${radius}Q${edge} ${edge} ${radius} ${edge}Z`);
      const length = guide.getTotalLength();
      const count = Math.ceil(length / 2);
      samples = Array.from({ length: count }, (_, index) => {
        const distance = index / count * length;
        const point = guide.getPointAtLength(distance);
        const before = guide.getPointAtLength((distance - .5 + length) % length);
        const after = guide.getPointAtLength((distance + .5) % length);
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const magnitude = Math.hypot(dx, dy) || 1;
        const cornerDistance = Math.max(Math.min(point.x, right - point.x), Math.min(point.y, bottom - point.y));
        const blend = Math.min(1, Math.max(0, (cornerDistance - radius) / 8));
        return { x: point.x, y: point.y, nx: dy / magnitude, ny: -dx / magnitude, position: index / count,
          cornerDamping: .25 + .75 * blend * blend * (3 - 2 * blend) };
      });
      render();
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastFrame < 1000 / 30) return;
      if (lastFrame) elapsed += now - lastFrame;
      lastFrame = now;
      render();
    };
    const updateAnimation = () => {
      cancelAnimationFrame(frame);
      lastFrame = 0;
      if (!motion.matches && !document.hidden && visible) frame = requestAnimationFrame(tick);
    };
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      updateAnimation();
    });
    resize();
    resizeObserver.observe(card);
    intersectionObserver.observe(card);
    motion.addEventListener('change', updateAnimation);
    document.addEventListener('visibilitychange', updateAnimation);
    updateAnimation();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      motion.removeEventListener('change', updateAnimation);
      document.removeEventListener('visibilitychange', updateAnimation);
    };
  }, [active]);

  if (!active) return null;
  return <svg ref={svgRef} className="office-electric-focus-border" aria-hidden="true" focusable="false" preserveAspectRatio="none">
    <defs><filter id={filterId} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.2" /></filter></defs>
    <path data-electric-guide fill="none" stroke="none" />
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path data-electric-outline stroke="#278af2" strokeWidth="4.8" opacity=".24" filter={`url(#${filterId})`} />
      <path data-electric-outline stroke="#2b8cff" strokeWidth="2.1" opacity=".83" />
      <path data-electric-outline stroke="#b6eaff" strokeWidth=".8" opacity=".55" />
    </g>
  </svg>;
}
