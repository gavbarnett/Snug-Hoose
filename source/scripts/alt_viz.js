// Alternative floor-plan view scaffold: level selector + setpoint-colored room cards.

const COLOR_BY_CLASS = {
  'thermal-unheated': '#4c4c4c',
  'thermal-extreme-cold': '#1840a8',
  'thermal-cold': '#2f78df',
  'thermal-cool': '#2f78df',
  'thermal-neutral': '#1ea85a',
  'thermal-warm': '#dd5a33',
  'thermal-hot': '#dd5a33',
  'thermal-extreme-hot': '#bb2525'
};

let selectedLevel = null;

function zoneSetpointClass(zone) {
  if (!zone) return 'thermal-neutral';
  if (zone.is_unheated === true) return 'thermal-unheated';

  const setpoint = typeof zone.setpoint_temperature === 'number' ? zone.setpoint_temperature : null;
  if (setpoint === null) return 'thermal-neutral';

  if (setpoint <= 16) return 'thermal-extreme-cold';
  if (setpoint <= 18) return 'thermal-cold';
  if (setpoint < 20) return 'thermal-cool';
  if (setpoint <= 22) return 'thermal-neutral';
  if (setpoint <= 24) return 'thermal-hot';
  return 'thermal-extreme-hot';
}

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
  chip.style.background = COLOR_BY_CLASS[className] || '#666';
  chip.textContent = label;
  return chip;
}

function renderLegend(container) {
  const legend = document.createElement('div');
  legend.className = 'alt-viz-legend';
  legend.appendChild(createLegendChip('<=16C', 'thermal-extreme-cold'));
  legend.appendChild(createLegendChip('17-18C', 'thermal-cold'));
  legend.appendChild(createLegendChip('19C', 'thermal-cool'));
  legend.appendChild(createLegendChip('20-22C', 'thermal-neutral'));
  legend.appendChild(createLegendChip('23-24C', 'thermal-hot'));
  legend.appendChild(createLegendChip('>=25C', 'thermal-extreme-hot'));
  legend.appendChild(createLegendChip('Unheated', 'thermal-unheated'));
  container.appendChild(legend);
}

function renderEmptyMessage(container, message) {
  const empty = document.createElement('div');
  empty.className = 'alt-viz-message';
  empty.textContent = message;
  container.appendChild(empty);
}

export function renderAlternativeViz(demo) {
  const root = document.getElementById('alt-viz-container');
  if (!root) return;

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
  const cellH = 130;
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

    const className = zoneSetpointClass(zone);
    const fill = COLOR_BY_CLASS[className] || '#1ea85a';

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
    rect.setAttribute('stroke-width', '1.5');
    group.appendChild(rect);

    const name = document.createElementNS(ns, 'text');
    name.setAttribute('x', String(x + 12));
    name.setAttribute('y', String(y + 30));
    name.setAttribute('fill', '#ffffff');
    name.setAttribute('font-size', '16');
    name.setAttribute('font-weight', '700');
    name.textContent = zone.name || zone.id || 'Unnamed room';
    group.appendChild(name);

    const setpoint = document.createElementNS(ns, 'text');
    setpoint.setAttribute('x', String(x + 12));
    setpoint.setAttribute('y', String(y + 58));
    setpoint.setAttribute('fill', '#ffffff');
    setpoint.setAttribute('font-size', '13');
    setpoint.setAttribute('opacity', '0.95');
    const sp = typeof zone.setpoint_temperature === 'number' ? `${zone.setpoint_temperature.toFixed(1)}C` : 'n/a';
    setpoint.textContent = `Target: ${sp}`;
    group.appendChild(setpoint);

    const meta = document.createElementNS(ns, 'text');
    meta.setAttribute('x', String(x + 12));
    meta.setAttribute('y', String(y + 82));
    meta.setAttribute('fill', '#ffffff');
    meta.setAttribute('font-size', '12');
    meta.setAttribute('opacity', '0.9');
    meta.textContent = `Type: ${zone.is_unheated === true ? 'Unheated' : 'Heated'}`;
    group.appendChild(meta);

    svg.appendChild(group);
  });

  svgWrap.appendChild(svg);
  root.appendChild(svgWrap);
}
