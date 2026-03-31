import { getThermalColorClass, THERMAL_COLOR_BY_CLASS } from './zone_thermal.js';

function createLegendChip(label, className) {
  const chip = document.createElement('span');
  chip.className = 'alt-viz-chip';
  chip.style.background = THERMAL_COLOR_BY_CLASS[className] || '#666';
  chip.textContent = label;
  return chip;
}

export function renderLegend(container) {
  const legend = document.createElement('div');
  legend.className = 'alt-viz-legend';
  legend.appendChild(createLegendChip('Deficit <= -2.0C', 'thermal-extreme-cold'));
  legend.appendChild(createLegendChip('Deficit <= -0.4C', 'thermal-cold'));
  legend.appendChild(createLegendChip('Within +/-0.4C', 'thermal-neutral'));
  legend.appendChild(createLegendChip('Excess < 2.0C', 'thermal-hot'));
  legend.appendChild(createLegendChip('Excess >= 2.0C', 'thermal-extreme-hot'));
  legend.appendChild(createLegendChip('Unheated', 'thermal-unheated'));
  container.appendChild(legend);
}

export function createLevelMiniViews(rooms, levels, activeLevel, onSelectLevel, deps = {}) {
  const {
    buildSeedPolygons,
    getPolygonForZone,
    isValidPolygon,
    polygonBounds,
    computeRenderScale,
    projectPoint
  } = deps;

  const wrap = document.createElement('div');
  wrap.className = 'alt-viz-level-miniviews';

  const ns = 'http://www.w3.org/2000/svg';

  levels.forEach(level => {
    const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === level);

    const card = document.createElement('div');
    card.className = 'alt-viz-level-mini';
    if (level === activeLevel) card.classList.add('is-active');

    const clickZone = document.createElement('div');
    clickZone.className = 'alt-viz-level-mini-click';
    clickZone.setAttribute('role', 'button');
    clickZone.setAttribute('tabindex', '0');
    clickZone.setAttribute('aria-label', `Switch to level ${level}`);
    clickZone.title = `Level ${level}`;
    clickZone.addEventListener('click', () => {
      if (typeof onSelectLevel === 'function') onSelectLevel(level);
    });
    clickZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (typeof onSelectLevel === 'function') onSelectLevel(level);
      }
    });

    const header = document.createElement('div');
    header.className = 'alt-viz-level-mini-header';
    header.textContent = `Level ${level}`;

    const content = document.createElement('div');
    content.className = 'alt-viz-level-mini-content';

    const previewPolygons = buildSeedPolygons(levelRooms);
    const polygonEntries = levelRooms
      .map(zone => ({ zone, polygon: getPolygonForZone(zone, previewPolygons) }))
      .filter(entry => isValidPolygon(entry.polygon));

    if (polygonEntries.length > 0) {
      const miniW = 150;
      const miniH = 96;
      const miniPad = 8;
      const bounds = polygonBounds(polygonEntries.map(entry => entry.polygon));
      const scale = computeRenderScale(bounds, miniW, miniH, miniPad);

      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'alt-viz-level-mini-svg');
      svg.setAttribute('viewBox', `0 0 ${miniW} ${miniH}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Preview of level ${level}`);

      polygonEntries.forEach(({ zone, polygon }) => {
        const pts = polygon.map(pt => projectPoint(pt, bounds, scale, miniPad));
        const thermalClass = getThermalColorClass(zone);

        const poly = document.createElementNS(ns, 'polygon');
        poly.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', THERMAL_COLOR_BY_CLASS[thermalClass] || '#4d7fd1');
        poly.setAttribute('fill-opacity', '0.42');
        poly.setAttribute('stroke', 'rgba(255,255,255,0.75)');
        poly.setAttribute('stroke-width', '1');
        svg.appendChild(poly);
      });

      content.appendChild(svg);
    } else {
      const empty = document.createElement('div');
      empty.className = 'alt-viz-level-mini-empty';
      empty.textContent = 'No rooms';
      content.appendChild(empty);
    }

    const meta = document.createElement('div');
    meta.className = 'alt-viz-level-mini-meta';
    meta.textContent = `${levelRooms.length} room${levelRooms.length === 1 ? '' : 's'}`;

    clickZone.appendChild(header);
    clickZone.appendChild(content);
    clickZone.appendChild(meta);
    card.appendChild(clickZone);

    wrap.appendChild(card);
  });

  return wrap;
}
