// Alternative floor-plan view scaffold: level selector + setpoint-colored room cards.
import { formatZoneTemperatureText, getZoneCapacitySummary, getZoneSavingsText } from './zone_text.js';
import { getThermalColorClass, THERMAL_COLOR_BY_CLASS } from './zone_thermal.js';

let selectedLevel = null;
let selectedZoneId = null;

function getRoomZones(demo) {
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  return zones.filter(z => z && z.type !== 'boundary');
}

function ensureSelectedLevel(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    selectedLevel = null;
    return;
  }
  if (!levels.includes(selectedLevel)) {
    selectedLevel = levels[0];
  }
}

function createLegendChip(label, className) {
  const chip = document.createElement('span');
  chip.className = 'alt-viz-chip';
  chip.style.background = THERMAL_COLOR_BY_CLASS[className] || '#666';
  chip.textContent = label;
  return chip;
}

function renderLegend(container) {
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

function renderEmptyMessage(container, message) {
  const empty = document.createElement('div');
  empty.className = 'alt-viz-message';
  empty.textContent = message;
  container.appendChild(empty);
}

export function renderAlternativeViz(demo, opts = {}) {
  const root = document.getElementById('alt-viz-container');
  if (!root) return;

  const onZoneSelected = typeof opts.onZoneSelected === 'function' ? opts.onZoneSelected : null;

  root.innerHTML = '';

  const rooms = getRoomZones(demo);
  if (rooms.length === 0) {
    renderEmptyMessage(root, 'No rooms available for floor-plan view.');
    return;
  }

  const levels = [...new Set(rooms.map(z => (typeof z.level === 'number' ? z.level : 0)))].sort((a, b) => a - b);
  ensureSelectedLevel(levels);

  const toolbar = document.createElement('div');
  toolbar.className = 'alt-viz-toolbar';

  const levelLabel = document.createElement('label');
  levelLabel.className = 'alt-viz-level-label';
  levelLabel.textContent = 'Active Level';

  const levelSelect = document.createElement('select');
  levelSelect.className = 'alt-viz-level-select';
  levels.forEach(level => {
    const option = document.createElement('option');
    option.value = String(level);
    option.textContent = `Level ${level}`;
    if (level === selectedLevel) option.selected = true;
    levelSelect.appendChild(option);
  });

  levelSelect.addEventListener('change', () => {
    selectedLevel = Number(levelSelect.value);
    renderAlternativeViz(demo);
  });

  levelLabel.appendChild(levelSelect);
  toolbar.appendChild(levelLabel);
  root.appendChild(toolbar);

  renderLegend(root);

  const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === selectedLevel);
  if (levelRooms.length === 0) {
    renderEmptyMessage(root, 'No rooms on selected level.');
    return;
  }

  const svgWrap = document.createElement('div');
  svgWrap.className = 'alt-viz-svg-wrap';

  const cols = Math.max(1, Math.ceil(Math.sqrt(levelRooms.length)));
  const cellW = 220;
  const cellH = 165;
  const gap = 18;
  const rows = Math.ceil(levelRooms.length / cols);
  const width = cols * cellW + (cols + 1) * gap;
  const height = rows * cellH + (rows + 1) * gap;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'alt-viz-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Alternative room view for level ${selectedLevel}`);

  levelRooms.forEach((zone, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = gap + col * (cellW + gap);
    const y = gap + row * (cellH + gap);

    const className = getThermalColorClass(zone);
    const fill = THERMAL_COLOR_BY_CLASS[className] || '#1ea85a';

    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'alt-room-group');

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(cellW));
    rect.setAttribute('height', String(cellH));
    rect.setAttribute('rx', '10');
    rect.setAttribute('fill', fill);
    rect.setAttribute('stroke', '#111');
    rect.setAttribute('stroke-width', selectedZoneId === zone.id ? '4' : '1.5');
    rect.setAttribute('class', 'alt-room-rect');
    rect.style.cursor = 'pointer';
    rect.addEventListener('click', () => {
      selectedZoneId = zone.id;
      if (onZoneSelected) {
        onZoneSelected(zone.id);
      }
      renderAlternativeViz(demo, opts);
    });
    group.appendChild(rect);

    const name = document.createElementNS(ns, 'text');
    name.setAttribute('x', String(x + 12));
    name.setAttribute('y', String(y + 30));
    name.setAttribute('fill', '#ffffff');
    name.setAttribute('font-size', '16');
    name.setAttribute('font-weight', '700');
    name.textContent = `${zone.name || zone.id || 'Unnamed room'}${zone.is_boiler_control ? ' 🔥' : ''}`;
    name.style.pointerEvents = 'none';
    group.appendChild(name);

    const tempText = formatZoneTemperatureText(zone, Number(demo?.meta?.externalTemp) || 3);
    if (tempText) {
      const temperature = document.createElementNS(ns, 'text');
      temperature.setAttribute('x', String(x + 12));
      temperature.setAttribute('y', String(y + 58));
      temperature.setAttribute('fill', '#ffffff');
      temperature.setAttribute('font-size', '13');
      temperature.setAttribute('opacity', '0.95');
      temperature.textContent = tempText;
      temperature.style.pointerEvents = 'none';
      group.appendChild(temperature);
    }

    const capacity = getZoneCapacitySummary(zone, Number(demo?.meta?.externalTemp) || 3);
    if (capacity) {
      const capacityText = document.createElementNS(ns, 'text');
      capacityText.setAttribute('x', String(x + 12));
      capacityText.setAttribute('y', String(y + 82));
      capacityText.setAttribute('fill', '#ffffff');
      capacityText.setAttribute('font-size', '12');
      capacityText.setAttribute('opacity', '0.9');
      capacityText.textContent = capacity.text;
      capacityText.style.pointerEvents = 'none';
      group.appendChild(capacityText);
    }

    const savingsText = getZoneSavingsText(zone);
    if (savingsText) {
      const savings = document.createElementNS(ns, 'text');
      savings.setAttribute('x', String(x + 12));
      savings.setAttribute('y', String(y + 104));
      savings.setAttribute('fill', '#d9ffdc');
      savings.setAttribute('font-size', '12');
      savings.setAttribute('opacity', '0.95');
      savings.textContent = savingsText;
      savings.style.pointerEvents = 'none';
      group.appendChild(savings);
    }

    svg.appendChild(group);
  });

  svgWrap.appendChild(svg);
  root.appendChild(svgWrap);
}
