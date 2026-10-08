import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation } from 'lucide-react';
import {
  actionLabels, transportStatusLabels, vesselTypes,
  type ContainerType, type TransportDriver, type TransportFocusRequest, type TransportOrder,
} from './types';
import './transport-map.css';

interface TransportMapProps {
  orders: TransportOrder[];
  drivers: TransportDriver[];
  focusDriverId: string;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null, sourceId?: string) => void;
  onSelect: (id: string) => void;
  focusRequest?: TransportFocusRequest;
  pickingLocation?: boolean;
  onPickLocation?: (location: { lat: number; lng: number }) => void;
}

interface MapPinElements {
  button: HTMLButtonElement;
  contour: SVGPathElement;
  fill: SVGPathElement;
  symbol: SVGGElement;
  tooltip: HTMLDivElement;
  tooltipTitle: HTMLSpanElement;
  tooltipDetails: HTMLSpanElement;
}

interface MarkerEntry extends MapPinElements {
  marker: L.Marker;
  vesselType: ContainerType;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PIN_PATH = 'M22 3C11.6 3 4 10.4 4 20.5C4 32 22 49 22 49S40 32 40 20.5C40 10.4 32.4 3 22 3Z';
const UNASSIGNED_COLOR = '#758394';

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

function paintVesselSymbol(group: SVGGElement, type: ContainerType) {
  group.replaceChildren();
  const shape = (tag: 'rect' | 'path', attributes: Record<string, string>) => {
    group.appendChild(svgElement(tag, attributes));
  };
  if (type === 'container') {
    shape('rect', { x: '12', y: '14', width: '20', height: '13', rx: '1.4' });
    shape('path', { d: 'M17 14v13m5-13v13m5-13v13M11 28h22' });
  } else if (type === 'battery') {
    shape('rect', { x: '13', y: '15', width: '18', height: '13', rx: '1.8' });
    shape('path', { d: 'M17 15v-3h3v3m5 0v-3h3v3M16 21h5m-2.5-2.5v5M25 21h3' });
  } else if (type === 'bin') {
    shape('path', { d: 'M15 16h14l-1.5 13h-11L15 16Zm-2-3h18m-13-3h8m-7 9v7m6-7v7' });
  } else {
    shape('rect', { x: '13', y: '12', width: '18', height: '18', rx: '1.3' });
    shape('path', { d: 'M19 12v18m6-18v18m-12-12h18m-18 6h18' });
  }
}

function makePin(id: string): MapPinElements {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'transport-map-pin';
  button.dataset.orderId = id;
  button.dataset.testid = `transport-pin-${id}`;
  const svg = svgElement('svg', { viewBox: '0 0 44 54', 'aria-hidden': 'true' });
  const contour = svgElement('path', {
    d: PIN_PATH, fill: 'none', stroke: UNASSIGNED_COLOR, 'stroke-width': '6',
    'stroke-linejoin': 'round', class: 'transport-map-pin-contour',
  });
  const fill = svgElement('path', {
    d: PIN_PATH, fill: vesselTypes.container.color, stroke: '#ffffff', 'stroke-width': '2',
    'stroke-linejoin': 'round', class: 'transport-map-pin-fill',
  });
  const symbol = svgElement('g', {
    fill: 'none', stroke: '#ffffff', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  svg.append(contour, fill, symbol);
  button.append(svg);
  const tooltip = document.createElement('div');
  const tooltipTitle = document.createElement('span');
  tooltipTitle.className = 'transport-map-tooltip-title';
  const tooltipDetails = document.createElement('span');
  tooltipDetails.className = 'transport-map-tooltip-details';
  tooltip.append(tooltipTitle, tooltipDetails);
  return { button, contour, fill, symbol, tooltip, tooltipTitle, tooltipDetails };
}

function clockTime(minutes: number) {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeLabel(order: TransportOrder) {
  if (order.status === 'unbooked' || order.startMinute === undefined) return 'Ej tidsbokat';
  const dateLabel = order.date
    ? new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' })
      .format(new Date(`${order.date}T12:00:00`))
    : '';
  return `${dateLabel ? `${dateLabel} · ` : ''}${clockTime(order.startMinute)}–${clockTime(order.startMinute + order.durationMinutes)}`;
}

function hasCoordinates(order: TransportOrder) {
  return Number.isFinite(order.lat) && Number.isFinite(order.lng)
    && order.lat >= -90 && order.lat <= 90 && order.lng >= -180 && order.lng <= 180;
}

function driverColor(driver?: TransportDriver) {
  return driver && /^#[\da-f]{3,8}$/i.test(driver.color) ? driver.color : UNASSIGNED_COLOR;
}

export default function TransportMap(props: TransportMapProps) {
  const { orders, drivers, focusDriverId, hoveredId, selectedId, focusRequest, pickingLocation } = props;
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, MarkerEntry>());
  const lastRaisedId = useRef<string | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const validOrders = orders.filter(hasCoordinates);
  const missingCoordinates = orders.length - validOrders.length;

  useLayoutEffect(() => {
    if (!mapElement.current) return;
    const map = L.map(mapElement.current, {
      center: [59.758, 18.706], zoom: 11, zoomControl: false,
      scrollWheelZoom: false, keyboard: true, attributionControl: true,
    });
    mapRef.current = map;
    const initialOrders = latestProps.current.orders.filter(hasCoordinates);
    if (initialOrders.length) {
      map.fitBounds(L.latLngBounds(initialOrders.map((order) => [order.lat, order.lng])), {
        padding: [48, 48], maxZoom: 14, animate: false,
      });
    }
    const zoom = L.control.zoom({ position: 'bottomright' }).addTo(map);
    zoom.getContainer()?.querySelector('.leaflet-control-zoom-in')?.setAttribute('aria-label', 'Zooma in kartan');
    zoom.getContainer()?.querySelector('.leaflet-control-zoom-out')?.setAttribute('aria-label', 'Zooma ut kartan');
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    let errors = 0;
    let loadedTiles = 0;
    const tilesLoading = () => {
      errors = 0;
      loadedTiles = 0;
    };
    const tileError = () => {
      errors += 1;
      if (errors >= 3 && loadedTiles === 0) setTilesUnavailable(true);
    };
    const tileLoaded = () => {
      loadedTiles += 1;
      setTilesUnavailable(false);
    };
    tiles.on('tileerror', tileError);
    tiles.on('tileload', tileLoaded);
    tiles.on('loading', tilesLoading);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => map.invalidateSize({ pan: true, animate: false })) : null;
    resizeObserver?.observe(mapElement.current);
    const resize = () => map.invalidateSize({ pan: true, animate: false });
    window.addEventListener('resize', resize);
    const pickLocation = (event: L.LeafletMouseEvent) => {
      if (latestProps.current.pickingLocation) {
        latestProps.current.onPickLocation?.({ lat: event.latlng.lat, lng: event.latlng.lng });
      }
    };
    map.on('click', pickLocation);
    const currentMarkers = markers.current;
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', resize);
      tiles.off('tileerror', tileError);
      tiles.off('tileload', tileLoaded);
      tiles.off('loading', tilesLoading);
      map.off('click', pickLocation);
      currentMarkers.forEach(({ marker }) => marker.remove());
      currentMarkers.clear();
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (hoveredId) lastRaisedId.current = hoveredId;
    const existingIds = new Set(orders.filter(hasCoordinates).map((order) => order.id));
    markers.current.forEach((entry, id) => {
      if (!existingIds.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    });
    orders.filter(hasCoordinates).forEach((order) => {
      let entry = markers.current.get(order.id);
      if (!entry) {
        const elements = makePin(order.id);
        const marker = L.marker([order.lat, order.lng], {
          icon: L.divIcon({
            html: elements.button, className: 'transport-map-marker', iconSize: [44, 54], iconAnchor: [22, 50],
          }),
          keyboard: false, riseOnHover: false,
        }).addTo(map);
        marker.bindTooltip(elements.tooltip, {
          direction: 'top', offset: [0, -44], opacity: 1, className: 'transport-map-tooltip',
        });
        const enter = () => {
          if (!latestProps.current.pickingLocation) latestProps.current.onHover(order.id);
        };
        const leave = () => {
          if (!latestProps.current.pickingLocation) latestProps.current.onHover(null, order.id);
        };
        elements.button.addEventListener('mouseenter', enter);
        elements.button.addEventListener('mouseleave', leave);
        elements.button.addEventListener('focus', enter);
        elements.button.addEventListener('blur', leave);
        elements.button.addEventListener('click', () => {
          if (!latestProps.current.pickingLocation) latestProps.current.onSelect(order.id);
        });
        L.DomEvent.disableClickPropagation(elements.button);
        entry = { ...elements, marker, vesselType: order.vesselType };
        markers.current.set(order.id, entry);
        paintVesselSymbol(entry.symbol, order.vesselType);
      }
      const driver = drivers.find((candidate) => candidate.id === order.driverId);
      // Hover changes appearance only; avoid repositioning a pin under the pointer.
      const position = entry.marker.getLatLng();
      if (position.lat !== order.lat || position.lng !== order.lng) entry.marker.setLatLng([order.lat, order.lng]);
      entry.contour.setAttribute('stroke', driverColor(driver));
      entry.contour.setAttribute('stroke-dasharray', order.status === 'unbooked' ? '4 4' : 'none');
      entry.fill.setAttribute('fill', vesselTypes[order.vesselType].color);
      if (entry.vesselType !== order.vesselType) {
        paintVesselSymbol(entry.symbol, order.vesselType);
        entry.vesselType = order.vesselType;
      }
      const highlighted = order.id === hoveredId;
      const selected = order.id === selectedId;
      const muted = Boolean(focusDriverId && order.driverId && order.driverId !== focusDriverId);
      entry.button.classList.toggle('is-unbooked', order.status === 'unbooked');
      entry.button.classList.toggle('is-hovered', highlighted);
      entry.button.classList.toggle('is-selected', selected);
      entry.button.classList.toggle('is-muted', muted && !highlighted && !selected);
      entry.button.setAttribute('aria-pressed', String(selected));
      entry.button.tabIndex = pickingLocation ? -1 : 0;
      entry.button.setAttribute('aria-label',
        `${order.id}, ${order.customerName}, ${actionLabels[order.action]}, ${vesselTypes[order.vesselType].label}, ${transportStatusLabels[order.status]}, ${timeLabel(order)}${driver ? `, ${driver.name}` : ', ingen förare tilldelad'}`);
      entry.tooltipTitle.textContent = `${order.id} · ${order.customerName}`;
      entry.tooltipDetails.textContent = `${transportStatusLabels[order.status]} · ${timeLabel(order)}${driver ? ` · ${driver.name}` : ''}`;
      // Keep its stacking order while moving from the linked list to the pin.
      // Removing the highlight must not put a nearby pin under the pointer.
      entry.marker.setZIndexOffset(highlighted ? 3000 : selected ? 2000 : order.id === lastRaisedId.current ? 1000 : muted ? -100 : 0);
      if (!pickingLocation && (highlighted || selected)) entry.marker.openTooltip();
      else entry.marker.closeTooltip();
    });
  }, [orders, drivers, focusDriverId, hoveredId, selectedId, pickingLocation]);

  useEffect(() => {
    if (!focusRequest) return;
    const order = latestProps.current.orders.find((candidate) => candidate.id === focusRequest.id);
    if (order && hasCoordinates(order)) {
      const map = mapRef.current;
      if (map) map.setView([order.lat, order.lng], Math.max(map.getZoom(), 13), { animate: false });
    }
  }, [focusRequest?.id, focusRequest?.nonce]);

  const frameOrders = () => {
    const map = mapRef.current;
    if (map && validOrders.length) {
      map.fitBounds(L.latLngBounds(validOrders.map((order) => [order.lat, order.lng])), {
        padding: [48, 48], maxZoom: 14, animate: false,
      });
    }
  };

  return <section className={`transport-map${pickingLocation ? ' is-picking-location' : ''}`} aria-label="Karta med arbetsordrar">
    <div ref={mapElement} className="transport-map-canvas" aria-label="Interaktiv karta över arbetsordrarnas platser" />
    <div className="transport-map-toolbar">
      <div className="transport-map-title"><MapPin size={15} /><strong>Arbetsordrar på kartan</strong><span>{validOrders.length} platser</span></div>
      <button type="button" className="transport-map-fit" onClick={frameOrders} disabled={!validOrders.length}><Navigation size={13} /> Visa alla</button>
    </div>
    {pickingLocation && <div className="transport-map-picking-notice" role="status"><MapPin size={14} /> Klicka på kartan för att välja plats</div>}
    <div className="transport-map-legend" aria-label="Kartans färgförklaring">
      <div className="transport-map-legend-group"><span className="transport-map-legend-label">Kärltyp</span>
        {Object.entries(vesselTypes).map(([type, value]) => <span className="transport-map-legend-item" key={type}><i className="transport-map-fill-key" style={{ background: value.color }} />{value.label}</span>)}
      </div>
      <div className="transport-map-legend-group"><span className="transport-map-legend-label">Kontur = förare</span>
        {drivers.map((driver) => <span key={driver.id} className={`transport-map-legend-item${focusDriverId && focusDriverId !== driver.id ? ' is-muted' : ''}`}><i className="transport-map-driver-key" style={{ borderColor: driverColor(driver) }} />{driver.name.split(' ')[0]}</span>)}
        <span className="transport-map-legend-item"><i className="transport-map-driver-key" style={{ borderColor: UNASSIGNED_COLOR }} />Ej tilldelad</span>
      </div>
      <div className="transport-map-legend-group"><span className="transport-map-legend-item"><i className="transport-map-booking-key" />Bokat</span><span className="transport-map-legend-item"><i className="transport-map-booking-key is-unbooked" />Obokat · pulserar</span></div>
    </div>
    {tilesUnavailable && <div className="transport-map-notice" role="status">Kartbakgrunden kunde inte laddas. Arbetsordrarnas nålar fungerar fortfarande.</div>}
    {!validOrders.length && <div className="transport-map-empty" role="status"><MapPin size={24} /><strong>{orders.length ? 'Arbetsordrarna saknar kartposition' : 'Inga arbetsordrar i vald vy'}</strong><span>{orders.length ? 'Välj plats på kartan i arbetsorderns uppgifter.' : 'Välj ett annat datum eller skapa ett nytt uppdrag.'}</span></div>}
    {missingCoordinates > 0 && <div className="transport-map-coordinate-notice" role="status">{missingCoordinates} uppdrag saknar kartposition och visas i listan.</div>}
  </section>;
}
