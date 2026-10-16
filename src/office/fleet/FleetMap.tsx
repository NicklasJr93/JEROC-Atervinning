import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ChevronRight, Gauge, LockKeyhole, MapPin, Radio, Search, Truck } from 'lucide-react';
import { Fact, Pill } from '../personnel/components/Ui';
import type { FleetSite, FleetState } from './types';
import { number, timestamp, vehicleLabel } from './format';

export default function FleetMap({ state, sites, onOpenVehicle }: { state: FleetState; sites: FleetSite[]; onOpenVehicle: (id: string) => void }) {
  const [query, setQuery] = useState(''), [siteId, setSite] = useState(''), [selected, setSelected] = useState<string>(), [tileError, setTileError] = useState(false);
  const vehicles = state.vehicles.filter(vehicle => (!siteId || state.profiles[vehicle.id]?.siteId === siteId) && [vehicle.name, vehicle.registration, state.people.find(person => person.id === state.profiles[vehicle.id]?.defaultDriverId)?.name].filter(Boolean).join(' ').toLocaleLowerCase('sv-SE').includes(query.toLocaleLowerCase('sv-SE')));
  const positions = useMemo(() => (state.positions ?? []).filter(position => vehicles.some(vehicle => vehicle.id === position.vehicleId) && Number.isFinite(position.lat) && Number.isFinite(position.lng) && Math.abs(position.lat) <= 90 && Math.abs(position.lng) <= 180), [state.positions, state.vehicles, query, siteId]);
  const element = useRef<HTMLDivElement>(null), map = useRef<L.Map | undefined>(undefined), markers = useRef<L.LayerGroup | undefined>(undefined), fitted = useRef(false);
  const chosenVehicle = vehicles.find(vehicle => vehicle.id === selected) ?? vehicles[0], position = positions.find(value => value.vehicleId === chosenVehicle?.id), profile = chosenVehicle && state.profiles[chosenVehicle.id];
  const device = state.telematics?.devices.find(value => value.vehicleId === chosenVehicle?.id);
  const hasPositions = positions.length > 0;
  useEffect(() => {
    if (!element.current || !hasPositions) return;
    const instance = L.map(element.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: true }); map.current = instance;
    L.control.zoom({ position: 'bottomright' }).addTo(instance);
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }).addTo(instance);
    let failures = 0; tiles.on('tileerror', () => { if (++failures >= 3) setTileError(true); }); tiles.on('tileload', () => { setTileError(false); });
    markers.current = L.layerGroup().addTo(instance);
    const resize = new ResizeObserver(() => instance.invalidateSize({ animate: false })); resize.observe(element.current);
    return () => { resize.disconnect(); instance.remove(); map.current = undefined; markers.current = undefined; fitted.current = false; };
  }, [hasPositions]);
  useEffect(() => {
    if (!map.current || !markers.current || !positions.length) return;
    markers.current.clearLayers();
    for (const value of positions) {
      const vehicle = vehicles.find(item => item.id === value.vehicleId), text = document.createElement('span'); text.textContent = `${vehicleLabel(vehicle)}${value.stale ? ' · Gammal position' : ''}`;
      const marker = L.circleMarker([value.lat, value.lng], { radius: value.vehicleId === chosenVehicle?.id ? 11 : 8, color: '#fff', weight: 3, fillColor: value.stale ? '#99a7be' : '#0868eb', fillOpacity: 1 });
      marker.bindTooltip(text, { direction: 'top', permanent: value.vehicleId === chosenVehicle?.id }); marker.on('click', () => setSelected(value.vehicleId)); marker.addTo(markers.current);
    }
    if (!fitted.current) { map.current.fitBounds(L.latLngBounds(positions.map(value => [value.lat, value.lng])), { padding: [48, 48], maxZoom: 14, animate: false }); fitted.current = true; }
  }, [positions, chosenVehicle?.id]);
  useEffect(() => { if (map.current && position) map.current.panTo([position.lat, position.lng], { animate: false }); }, [chosenVehicle?.id]);
  return <div className="fleet-map-workspace"><div className="fleet-section-heading"><div><h2>Karta</h2><p>Senast tillåtna fordonspositioner och kontaktstatus.</p></div>{positions.some(value => value.source === 'simulator') && <Pill>Innehåller simulerade positioner</Pill>}</div>
    <div className="fleet-filters"><label className="fleet-search"><Search size={17} /><input aria-label="Sök fordon på kartan" placeholder="Sök fordon eller förare…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Anläggning på kartan" value={siteId} onChange={event => { setSite(event.target.value); fitted.current = false; }}><option value="">Alla anläggningar</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></div>
    <div className="fleet-map-layout"><section className="fleet-map-list office-panel" aria-label="Fordon på kartan">{vehicles.map(vehicle => { const value = positions.find(item => item.vehicleId === vehicle.id); return <button key={vehicle.id} className={chosenVehicle?.id === vehicle.id ? 'active' : ''} onClick={() => setSelected(vehicle.id)}><Truck size={22} /><div><strong>{vehicleLabel(vehicle)}</strong><span>{vehicle.name}</span><small>{value ? value.stale ? 'Gammal position' : 'Position uppmätt' : 'Ingen tillgänglig position'}</small><small>{value ? timestamp(value.at) : 'Position visas när underlag finns'}</small></div><ChevronRight size={15} /></button>; })}{!vehicles.length && <div className="fleet-empty">Inga fordon matchar urvalet.</div>}</section>
      <div className="fleet-map-canvas" aria-label="Karta med behöriga fordonspositioner">{hasPositions ? <><div ref={element} className="fleet-leaflet" />{tileError && <div className="fleet-map-error">Kartbilderna kunde inte laddas. Positionernas tider visas i listan.</div>}</> : <div className="fleet-empty"><MapPin size={36} /><h3>Inga positioner att visa</h3><p>Privata och oklassificerade positioner visas inte. En saknad position ersätts inte med en äldre tjänsteresa.</p></div>}</div>
      <aside className="office-panel fleet-panel fleet-map-detail">{chosenVehicle ? <><h2>{vehicleLabel(chosenVehicle)}</h2><p>{chosenVehicle.name}</p><Fact label="Standardförare">{state.people.find(person => person.id === profile?.defaultDriverId)?.name ?? 'Ej vald'}</Fact><Fact label="Position uppmätt">{position ? timestamp(position.at) : 'Saknas eller skyddad'}</Fact><Fact label="Kontakt">{device?.lastContactAt ? timestamp(device.lastContactAt) : 'Saknas'}</Fact><Fact label="Mätare"><Gauge size={15} /> {number(profile?.odometerKm)} km</Fact>{position && <Fact label="Datakälla">{position.source === 'simulator' ? 'Simulerad telemetri' : 'GPS-enhet'}</Fact>}<button className="office-btn" onClick={() => onOpenVehicle(chosenVehicle.id)}>Öppna fordonskort <ChevronRight size={15} /></button></> : <h2>Välj ett fordon</h2>}<p className="fleet-privacy"><LockKeyhole size={17} /> Privata och oklassificerade positioner visas inte.</p><p className="fleet-footnote"><Radio size={14} /> En gammal position är inte fordonets bekräftade nuvarande plats.</p></aside>
    </div>
  </div>;
}
