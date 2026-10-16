import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation } from 'lucide-react';
import { currentPlaceName, type TestCarSnapshot } from './types';

const sv = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const carIcon = '<svg viewBox="0 0 24 24" width="25" height="25" aria-hidden="true"><path d="m5 9 2-5h10l2 5m-15 1h16v8H4zM7 18v2m10-2v2M7 13h2m6 0h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function fallbackMap(bounds: L.LatLngBounds, car: TestCarSnapshot) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1000 800');
  svg.innerHTML = '<defs><pattern id="testcar-blocks" width="100" height="85" patternUnits="userSpaceOnUse"><rect width="100" height="85" fill="#edf2e9"/><rect x="13" y="12" width="65" height="48" rx="5" fill="#e1e8df"/><path d="M0 78H100M92 0V85" stroke="#fff" stroke-width="10"/></pattern></defs><rect width="1000" height="800" fill="url(#testcar-blocks)"/><path d="M710 800 680 640 790 520 860 400 1000 365V800Z" fill="#b6dced"/><path d="M60 260 200 100 350 110 325 300 160 380Z" fill="#d2e6cb"/><path d="M690 20 850 0 960 180 795 240 685 120Z" fill="#d2e6cb"/><path d="M0 590 260 510 530 445 740 280 1000 170" stroke="#d4d9d8" stroke-width="25" fill="none"/><path d="M0 590 260 510 530 445 740 280 1000 170" stroke="#fff" stroke-width="17" fill="none"/><path d="M335 0 420 250 500 470 550 800" stroke="#d4d9d8" stroke-width="22" fill="none"/><path d="M335 0 420 250 500 470 550 800" stroke="#fff" stroke-width="14" fill="none"/><text x="510" y="350" text-anchor="middle" font-family="system-ui,sans-serif" font-size="34" font-weight="650" fill="#566977">Norrtälje</text><text x="810" y="665" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-style="italic" fill="#568fae">Norrtäljeviken</text>';
  for (const place of car.destinations) {
    const x = (place.lng - bounds.getWest()) / (bounds.getEast() - bounds.getWest()) * 1000;
    const y = (bounds.getNorth() - place.lat) / (bounds.getNorth() - bounds.getSouth()) * 800;
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', `M${x} ${y} L${(x + 500) / 2} ${y} L500 470`);
    path.setAttribute('stroke', '#fff'); path.setAttribute('stroke-width', '12'); path.setAttribute('fill', 'none');
    svg.append(path);
  }
  return svg;
}

export function TestCarMap({ car }: { car: TestCarSnapshot }) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const initial = useRef(car);
  const fittedRoute = useRef<string | null>(null);
  const [tilesReady, setTilesReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const destination = car.destinations.find(place => place.id === car.destinationId);

  useEffect(() => {
    if (!element.current) return;
    let map: L.Map | undefined;
    let observer: ResizeObserver | undefined;
    let tileLayer: L.TileLayer | undefined;
    const loaded = () => setTilesReady(true);
    try {
      map = L.map(element.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: true });
      mapRef.current = map;
      const bounds = L.latLngBounds(initial.current.destinations.map(place => [place.lat, place.lng] as L.LatLngTuple)).pad(0.22);
      map.fitBounds(bounds, { padding: [36, 36], animate: false });
      map.createPane('testcarBackdrop').style.zIndex = '150';
      L.svgOverlay(fallbackMap(bounds, initial.current), bounds, { pane: 'testcarBackdrop', interactive: false }).addTo(map);
      tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map);
      tileLayer.on('tileload', loaded);
      const zoom = L.control.zoom({ position: 'bottomright' }).addTo(map);
      zoom.getContainer()?.querySelector('.leaflet-control-zoom-in')?.setAttribute('aria-label', 'Zooma in kartan');
      zoom.getContainer()?.querySelector('.leaflet-control-zoom-out')?.setAttribute('aria-label', 'Zooma ut kartan');
      layers.current = L.layerGroup().addTo(map);
      observer = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
      observer.observe(element.current);
    } catch {
      setMapFailed(true);
    }
    return () => {
      observer?.disconnect();
      tileLayer?.off('tileload', loaded);
      map?.remove();
      mapRef.current = null;
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = layers.current;
    if (!map || !group) return;
    group.clearLayers();
    for (const place of car.destinations) {
      const label = document.createElement('div');
      label.className = `testcar-map-pin${place.id === car.destinationId ? ' is-destination' : ''}`;
      const glyph = document.createElement('span');
      glyph.textContent = place.id === 'office' ? '▦' : place.id === 'home' ? '⌂' : '▤';
      const name = document.createElement('strong'); name.textContent = place.name;
      label.append(glyph, name);
      L.marker([place.lat, place.lng], { icon: L.divIcon({ html: label, className: 'testcar-map-marker', iconSize: [120, 36], iconAnchor: [17, 18] }), keyboard: false, interactive: false }).addTo(group);
    }
    if (car.route?.points.length) {
      L.polyline(car.route.points.map(point => [point.lat, point.lng]), { color: '#fff', weight: 10, opacity: 0.95, interactive: false }).addTo(group);
      L.polyline(car.route.points.map(point => [point.lat, point.lng]), { color: '#80bafa', weight: 6, opacity: 0.9, interactive: false }).addTo(group);
      if (car.route.traveled.length > 1) L.polyline(car.route.traveled.map(point => [point.lat, point.lng]), { color: '#087cf0', weight: 6, interactive: false }).addTo(group);
    }
    const marker = document.createElement('div'); marker.className = 'testcar-position-pin'; marker.innerHTML = carIcon;
    L.marker([car.currentPlace.lat, car.currentPlace.lng], { icon: L.divIcon({ html: marker, className: 'testcar-map-marker', iconSize: [42, 42], iconAnchor: [21, 21] }), zIndexOffset: 1000, keyboard: false, interactive: false }).addTo(group);
    const routeKey = car.route ? `${car.destinationId}:${car.route.points[0]?.lat}:${car.route.points[0]?.lng}` : 'all';
    if (fittedRoute.current !== routeKey) {
      const points = car.route?.points.length ? car.route.points : car.destinations;
      map.fitBounds(L.latLngBounds(points.map(point => [point.lat, point.lng] as L.LatLngTuple)), { padding: [60, 65], maxZoom: 14, animate: false });
      fittedRoute.current = routeKey;
    }
  }, [car]);

  const heading = car.mode === 'driving' ? `På väg till ${destination?.name ?? 'målet'}`
    : car.mode === 'paused' ? `Pausad på väg till ${destination?.name ?? 'målet'}`
      : `Parkerad vid ${currentPlaceName(car)}`;
  return <section className="testcar-card testcar-map-card" aria-labelledby="testcar-map-heading">
    <div className="testcar-card-heading">
      <h2 id="testcar-map-heading"><span className={`testcar-status-dot ${car.mode === 'driving' ? 'is-moving' : car.engineOn ? 'is-idle' : ''}`} />{heading}</h2>
      <span className="testcar-badge is-green"><Navigation size={14} />Simulerad GPS</span>
    </div>
    <div className={`testcar-map-wrap${mapFailed ? ' is-unavailable' : ''}`}>
      <div ref={element} className="testcar-map" role="img" aria-label={`Simulerad karta över Norrtälje. Nuvarande plats: ${currentPlaceName(car)}.`} />
      {(!tilesReady || mapFailed) && <div className="testcar-map-note">Översiktskarta · simulerad resa</div>}
      {mapFailed && <div className="testcar-map-unavailable"><Navigation size={40} /><strong>Din resa fortsätter här</strong><span>Kartvyn kunde inte öppnas. Bilens läge och resan uppdateras nedan.</span></div>}
      <div className="testcar-location-overlay"><MapPin size={24} /><div><span>Du är här: <strong>{currentPlaceName(car)}</strong></span><small>{car.route && destination ? `${sv.format(car.route.remainingKm)} km kvar till ${destination.name}` : 'Välj nästa plats och ge dig iväg.'}</small></div></div>
    </div>
  </section>;
}
