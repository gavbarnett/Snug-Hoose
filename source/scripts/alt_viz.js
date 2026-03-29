// Alternative floor-plan view scaffold: level selector + thermal-colored polygons.
import { formatZoneTemperatureText, getZoneCapacitySummary, getZoneSavingsText } from './zone_text.js';
import { getThermalColorClass, THERMAL_COLOR_BY_CLASS } from './zone_thermal.js';

let selectedLevel = null;
let selectedZoneId = null;
let dragState = null;
let suppressWallSelectionUntil = 0;
const DRAG_START_THRESHOLD_PX = 6;
const DRAG_SNAP_STEP_M = 0.1;
const DRAG_NEAR_SNAP_THRESHOLD_M = 0.18;

function snapOffsetMeters(offset, step) {
  if (!isFinite(offset)) return 0;
  if (!isFinite(step) || step <= 0) return offset;
  return Math.round(offset / step) * step;
}

function dotPointNormal(point, normal) {
  return (point.x * normal.x) + (point.y * normal.y);
}

function snapOffsetToGridAndTargets(rawOffset, baseCoord, targetCoords, step, nearThreshold) {
  if (!isFinite(rawOffset)) return 0;
  const absoluteCoord = baseCoord + rawOffset;

  let snappedCoord = absoluteCoord;
  if (isFinite(step) && step > 0) {
    snappedCoord = Math.round(absoluteCoord / step) * step;
  }

  let bestCoord = snappedCoord;
  let bestDist = Math.abs(snappedCoord - absoluteCoord);

  if (Array.isArray(targetCoords)) {
    for (const target of targetCoords) {
      if (!isFinite(target)) continue;
      const dist = Math.abs(target - absoluteCoord);
      if (dist <= nearThreshold && dist < bestDist) {
        bestDist = dist;
        bestCoord = target;
      }
    }
  }

  return bestCoord - baseCoord;
}

function getSVGPoint(svg, e) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: ((e.clientX - rect.left) / rect.width) * vb.width,
    y: ((e.clientY - rect.top) / rect.height) * vb.height,
  };
}

function computeRenderScale(bounds, canvasW, canvasH, pad) {
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);
  return Math.min((canvasW - pad * 2) / width, (canvasH - pad * 2) / height);
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

function isValidPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  return polygon.every(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number' && isFinite(pt.x) && isFinite(pt.y));
}

function getZoneArea(zone) {
  if (typeof zone?.floor_area === 'number' && zone.floor_area > 0) return zone.floor_area;
  return 12;
}

function buildSeedPolygons(levelRooms) {
  const sorted = levelRooms.slice().sort((a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const cellSpan = 8;
  const map = new Map();

  sorted.forEach((zone, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const area = getZoneArea(zone);

    const width = Math.max(2.6, Math.min(6.5, Math.sqrt(area * 1.25)));
    const height = Math.max(2.2, Math.min(6.5, area / width));

    const x = col * cellSpan;
    const y = row * cellSpan;

    map.set(zone.id, [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ]);
  });

  return map;
}

function getPolygonForZone(zone, previewPolygons) {
  const persisted = zone?.layout?.polygon;
  if (isValidPolygon(persisted)) return persisted;
  return previewPolygons.get(zone.id) || null;
}

function polygonBounds(polygons) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polygon of polygons) {
    for (const pt of polygon) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  }

  return { minX, minY, maxX, maxY };
}

function projectPoint(pt, bounds, scale, pad) {
  return {
    x: pad + (pt.x - bounds.minX) * scale,
    y: pad + (pt.y - bounds.minY) * scale
  };
}

function polygonCentroid(polygon) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }

  if (Math.abs(area2) < 1e-8) {
    const avg = polygon.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: avg.x / polygon.length, y: avg.y / polygon.length };
  }

  return {
    x: cx / (3 * area2),
    y: cy / (3 * area2)
  };
}

function svgPointToWorld(svgPt, bounds, scale, pad) {
  return {
    x: (svgPt.x - pad) / scale + bounds.minX,
    y: (svgPt.y - pad) / scale + bounds.minY
  };
}

function clonePolygon(polygon) {
  return polygon.map(pt => ({ x: pt.x, y: pt.y }));
}

function clonePolygonMap(polygonMap) {
  const cloned = new Map();
  for (const [zoneId, polygon] of polygonMap.entries()) {
    cloned.set(zoneId, clonePolygon(polygon));
  }
  return cloned;
}

function isSamePoint(a, b, epsilon = 1e-6) {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function getPointParam(point, p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return 0;
  return ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / lenSq;
}

function pointLiesOnSegment(point, p0, p1, epsilon = 1e-6) {
  const dx1 = p1.x - p0.x;
  const dy1 = p1.y - p0.y;
  const dx2 = point.x - p0.x;
  const dy2 = point.y - p0.y;
  const cross = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(cross) > epsilon) return false;
  const t = getPointParam(point, p0, p1);
  return t > epsilon && t < 1 - epsilon;
}

function splitPolygonBySharedVertices(polygon, allVertices) {
  const nextPolygon = [];

  for (let index = 0; index < polygon.length; index++) {
    const p0 = polygon[index];
    const p1 = polygon[(index + 1) % polygon.length];
    nextPolygon.push({ x: p0.x, y: p0.y });

    const splits = allVertices
      .filter(point => !isSamePoint(point, p0) && !isSamePoint(point, p1) && pointLiesOnSegment(point, p0, p1))
      .map(point => ({ point, t: getPointParam(point, p0, p1) }))
      .sort((a, b) => a.t - b.t);

    for (const split of splits) {
      const last = nextPolygon[nextPolygon.length - 1];
      if (!isSamePoint(last, split.point)) {
        nextPolygon.push({ x: split.point.x, y: split.point.y });
      }
    }
  }

  return nextPolygon;
}

function normalizePolygonMapForSharedWalls(polygonMap) {
  const allVertices = [];
  for (const polygon of polygonMap.values()) {
    polygon.forEach(point => allVertices.push(point));
  }

  const normalized = new Map();
  for (const [zoneId, polygon] of polygonMap.entries()) {
    normalized.set(zoneId, splitPolygonBySharedVertices(polygon, allVertices));
  }
  return normalized;
}

function areVectorsParallel(p0, p1, q0, q1, epsilon = 1e-6) {
  const ax = p1.x - p0.x;
  const ay = p1.y - p0.y;
  const bx = q1.x - q0.x;
  const by = q1.y - q0.y;
  return Math.abs(ax * by - ay * bx) <= epsilon;
}

function removeConsecutiveDuplicatePoints(points, epsilon = 1e-6) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const out = [];
  for (const pt of points) {
    const last = out[out.length - 1];
    if (!last || !isSamePoint(last, pt, epsilon)) {
      out.push(pt);
    }
  }
  if (out.length > 1 && isSamePoint(out[0], out[out.length - 1], epsilon)) {
    out.pop();
  }
  return out;
}

function simplifyCollinearPoints(points, epsilon = 1e-6) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    if (!areVectorsParallel(prev, curr, curr, next, epsilon)) {
      out.push(curr);
    }
  }
  return out.length >= 3 ? out : points;
}

function pointKey(pt, precision = 4) {
  return `${Number(pt.x).toFixed(precision)},${Number(pt.y).toFixed(precision)}`;
}

function polygonAreaAbs(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % points.length];
    area2 += (p0.x * p1.y) - (p1.x * p0.y);
  }
  return Math.abs(area2 / 2);
}

function extractClosedLoops(points) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const seq = [];
  const lastSeen = new Map();
  const loops = [];

  const walk = points.concat([points[0]]);
  for (const pt of walk) {
    const key = pointKey(pt);
    if (lastSeen.has(key)) {
      const start = lastSeen.get(key);
      const loop = seq.slice(start).concat([{ x: pt.x, y: pt.y }]);
      const deduped = removeConsecutiveDuplicatePoints(loop);
      if (deduped.length >= 3) loops.push(deduped);
    }
    seq.push({ x: pt.x, y: pt.y });
    lastSeen.set(key, seq.length - 1);
  }

  return loops;
}

function cleanupDisconnectedAreas(points) {
  const base = simplifyCollinearPoints(removeConsecutiveDuplicatePoints(points));
  if (!Array.isArray(base) || base.length < 3) return base;

  const candidates = [base, ...extractClosedLoops(base).map(loop => simplifyCollinearPoints(removeConsecutiveDuplicatePoints(loop)))];
  let best = base;
  let bestArea = polygonAreaAbs(base);

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length < 3) continue;
    const area = polygonAreaAbs(candidate);
    if (area > bestArea) {
      bestArea = area;
      best = candidate;
    }
  }

  return best;
}

function buildOrthogonalPolygonFromMovedEdges(basePolygon, movedEdgeIndices, normal, offset) {
  if (!Array.isArray(basePolygon) || basePolygon.length < 3) return clonePolygon(basePolygon || []);
  if (!movedEdgeIndices || movedEdgeIndices.size === 0) return clonePolygon(basePolygon);

  const n = basePolygon.length;
  const movedVertexIndices = new Set();
  movedEdgeIndices.forEach(edgeIndex => {
    movedVertexIndices.add(edgeIndex);
    movedVertexIndices.add((edgeIndex + 1) % n);
  });

  const movedPointAt = (vertexIndex) => {
    const p = basePolygon[vertexIndex];
    if (!movedVertexIndices.has(vertexIndex)) return { x: p.x, y: p.y };
    return {
      x: p.x + normal.x * offset,
      y: p.y + normal.y * offset
    };
  };

  const result = [];
  for (let vertexIndex = 0; vertexIndex < n; vertexIndex++) {
    const prevEdgeIndex = (vertexIndex - 1 + n) % n;
    const nextEdgeIndex = vertexIndex;
    const prevMoved = movedEdgeIndices.has(prevEdgeIndex);
    const nextMoved = movedEdgeIndices.has(nextEdgeIndex);
    const oldPoint = basePolygon[vertexIndex];
    const newPoint = movedPointAt(vertexIndex);

    const prevEdgeStart = basePolygon[prevEdgeIndex];
    const prevEdgeEnd = basePolygon[vertexIndex];
    const nextEdgeStart = basePolygon[vertexIndex];
    const nextEdgeEnd = basePolygon[(vertexIndex + 1) % n];
    const isTJunctionSplit = prevMoved !== nextMoved
      && !isSamePoint(oldPoint, newPoint)
      && areVectorsParallel(prevEdgeStart, prevEdgeEnd, nextEdgeStart, nextEdgeEnd);

    if (isTJunctionSplit) {
      if (prevMoved && !nextMoved) {
        result.push(newPoint);
        result.push({ x: oldPoint.x, y: oldPoint.y });
      } else {
        result.push({ x: oldPoint.x, y: oldPoint.y });
        result.push(newPoint);
      }
      continue;
    }

    result.push(newPoint);
  }

  const deduped = removeConsecutiveDuplicatePoints(result);
  const simplified = simplifyCollinearPoints(deduped);
  return cleanupDisconnectedAreas(simplified);
}

function createEdgeKey(p0, p1) {
  const a = `${Number(p0.x).toFixed(4)},${Number(p0.y).toFixed(4)}`;
  const b = `${Number(p1.x).toFixed(4)},${Number(p1.y).toFixed(4)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildSharedEdgeGroups(polygonMap) {
  const groups = new Map();

  for (const [zoneId, polygon] of polygonMap.entries()) {
    for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
      const p0 = polygon[edgeIndex];
      const p1 = polygon[(edgeIndex + 1) % polygon.length];
      const key = createEdgeKey(p0, p1);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ zoneId, edgeIndex });
    }
  }

  return groups;
}

function collectParallelSnapTargets(polygonMap, dragP0, dragP1, normal, excludeEdgeKey) {
  const targets = [];

  for (const polygon of polygonMap.values()) {
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const key = createEdgeKey(p0, p1);
      if (key === excludeEdgeKey) continue;
      if (!areVectorsParallel(dragP0, dragP1, p0, p1)) continue;
      targets.push(dotPointNormal(p0, normal));
    }
  }

  return targets;
}

function getEdgeCursor(p0, p1) {
  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);
  if (dx >= dy * 2) return 'ns-resize';
  if (dy >= dx * 2) return 'ew-resize';
  return 'move';
}

function updateRenderedZoneGeometry(zoneRenderState, polygon, bounds, scale, pad) {
  if (!zoneRenderState || !isValidPolygon(polygon)) return;

  const projected = polygon.map(pt => projectPoint(pt, bounds, scale, pad));
  zoneRenderState.polygonElement.setAttribute('points', projected.map(p => `${p.x},${p.y}`).join(' '));

  const centroidWorld = polygonCentroid(polygon);
  const centroid = projectPoint(centroidWorld, bounds, scale, pad);
  zoneRenderState.textElement.setAttribute('x', String(centroid.x));
  zoneRenderState.textElement.setAttribute('y', String(centroid.y - ((zoneRenderState.lineCount - 1) * 10)));
  zoneRenderState.tspans.forEach(tspan => {
    tspan.setAttribute('x', String(centroid.x));
  });

  zoneRenderState.edgeElements.forEach((line, idx) => {
    const p0 = projected[idx];
    const p1 = projected[(idx + 1) % projected.length];
    line.setAttribute('x1', String(p0.x));
    line.setAttribute('y1', String(p0.y));
    line.setAttribute('x2', String(p1.x));
    line.setAttribute('y2', String(p1.y));
  });
}

function highlightDraggedEdges(zoneRenderStateById, affectedEdges, active) {
  affectedEdges.forEach(({ zoneId, edgeIndex }) => {
    const zoneRenderState = zoneRenderStateById.get(zoneId);
    const line = zoneRenderState?.edgeElements?.[edgeIndex];
    if (!line) return;
    line.classList.toggle('is-dragging', active);
  });
}

function getEdgeOrientation(polygon, edgeIndex) {
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const centroid = polygonCentroid(polygon);
  const midpoint = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);

  if (dx >= dy) {
    return midpoint.y < centroid.y ? 'north' : 'south';
  }
  return midpoint.x < centroid.x ? 'west' : 'east';
}

function findWallElementForEdge(demo, edgeGroups, polygonMap, zoneId, edgeIndex) {
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  const polygon = polygonMap.get(zoneId);
  if (!polygon) return null;

  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const sharedRefs = edgeGroups.get(createEdgeKey(p0, p1)) || [];
  const adjacentZoneId = sharedRefs.find(ref => ref.zoneId !== zoneId)?.zoneId || null;
  const zoneNodeIds = adjacentZoneId ? [zoneId, adjacentZoneId] : [zoneId];
  const orientation = getEdgeOrientation(polygon, edgeIndex);

  let candidates = elements.filter(element => {
    if (!element || String(element.type || '').toLowerCase() !== 'wall') return false;
    if (!Array.isArray(element.nodes) || !element.nodes.includes(zoneId)) return false;
    if (adjacentZoneId) return element.nodes.includes(adjacentZoneId);
    return element.nodes.some(nodeId => !zoneNodeIds.includes(nodeId));
  });

  if (candidates.length > 1) {
    const orientationMatches = candidates.filter(element => String(element.orientation || '').toLowerCase() === orientation);
    if (orientationMatches.length > 0) candidates = orientationMatches;
  }

  return candidates[0] || null;
}

export function renderAlternativeViz(demo, opts = {}) {
  const root = document.getElementById('alt-viz-container');
  if (!root) return;

  const onZoneSelected = typeof opts.onZoneSelected === 'function' ? opts.onZoneSelected : null;
  const onWallSelected = typeof opts.onWallSelected === 'function' ? opts.onWallSelected : null;
  const onSeedLevelPolygons = typeof opts.onSeedLevelPolygons === 'function' ? opts.onSeedLevelPolygons : null;
  const onDataChanged = typeof opts.onDataChanged === 'function' ? opts.onDataChanged : null;

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
    renderAlternativeViz(demo, opts);
  });

  levelLabel.appendChild(levelSelect);
  toolbar.appendChild(levelLabel);

  const seedBtn = document.createElement('button');
  seedBtn.type = 'button';
  seedBtn.className = 'alt-viz-seed-btn';
  seedBtn.textContent = 'Seed Level Polygons';
  seedBtn.title = 'Create default polygons for rooms on this level.';
  seedBtn.addEventListener('click', () => {
    if (!onSeedLevelPolygons) return;
    const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === selectedLevel);
    const seed = buildSeedPolygons(levelRooms);
    const payload = {};
    for (const [zoneId, polygon] of seed.entries()) {
      payload[zoneId] = polygon;
    }
    onSeedLevelPolygons(selectedLevel, payload);
  });
  toolbar.appendChild(seedBtn);

  root.appendChild(toolbar);

  const hint = document.createElement('div');
  hint.className = 'alt-viz-message';
  hint.textContent = 'Drag walls to reshape joined rooms on the active level, or click a wall to open that fabric element in the editor.';
  root.appendChild(hint);

  renderLegend(root);

  const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === selectedLevel);
  if (levelRooms.length === 0) {
    renderEmptyMessage(root, 'No rooms on selected level.');
    return;
  }

  const previewPolygons = buildSeedPolygons(levelRooms);
  const polygonEntries = levelRooms
    .map(zone => ({ zone, polygon: getPolygonForZone(zone, previewPolygons) }))
    .filter(entry => isValidPolygon(entry.polygon));

  if (polygonEntries.length === 0) {
    renderEmptyMessage(root, 'No valid polygons to render on selected level.');
    return;
  }

  const bounds = polygonBounds(polygonEntries.map(e => e.polygon));

  const svgWrap = document.createElement('div');
  svgWrap.className = 'alt-viz-svg-wrap';

  const canvasW = 1000;
  const canvasH = 700;
  const pad = 48;
  const ns = 'http://www.w3.org/2000/svg';
  const scale = computeRenderScale(bounds, canvasW, canvasH, pad);
  const rawPolygonMap = new Map(polygonEntries.map(({ zone, polygon }) => [zone.id, clonePolygon(polygon)]));
  const polygonMap = normalizePolygonMapForSharedWalls(rawPolygonMap);
  const edgeGroups = buildSharedEdgeGroups(polygonMap);
  const zoneRenderStateById = new Map();

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'alt-viz-svg');
  svg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Alternative polygon room view for level ${selectedLevel}`);

  svg.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const svgPt = getSVGPoint(svg, e);
    const worldPt = svgPointToWorld(svgPt, dragState.bounds, dragState.scale, dragState.pad);
    const delta = {
      x: worldPt.x - dragState.startWorldPoint.x,
      y: worldPt.y - dragState.startWorldPoint.y
    };
    const rawOffset = (delta.x * dragState.normal.x) + (delta.y * dragState.normal.y);
    const offset = snapOffsetToGridAndTargets(
      rawOffset,
      dragState.snapBaseCoord,
      dragState.snapTargets,
      DRAG_SNAP_STEP_M,
      DRAG_NEAR_SNAP_THRESHOLD_M
    );
    dragState.currentOffset = offset;
    const thresholdWorld = DRAG_START_THRESHOLD_PX / dragState.scale;
    if (!dragState.didMove && Math.abs(offset) < thresholdWorld) {
      return;
    }
    if (!dragState.didMove) {
      dragState.didMove = true;
      highlightDraggedEdges(zoneRenderStateById, dragState.affectedEdges, true);
    }
    const nextPolygonMap = clonePolygonMap(dragState.basePolygonMap);

    dragState.affectedEdges.forEach(({ zoneId, edgeIndex }) => {
      const basePolygon = dragState.basePolygonMap.get(zoneId);
      const nextPolygon = nextPolygonMap.get(zoneId);
      if (!basePolygon || !nextPolygon) return;
      const nextIndex = (edgeIndex + 1) % basePolygon.length;
      nextPolygon[edgeIndex] = {
        x: basePolygon[edgeIndex].x + dragState.normal.x * offset,
        y: basePolygon[edgeIndex].y + dragState.normal.y * offset
      };
      nextPolygon[nextIndex] = {
        x: basePolygon[nextIndex].x + dragState.normal.x * offset,
        y: basePolygon[nextIndex].y + dragState.normal.y * offset
      };
    });

    dragState.zoneIds.forEach(zoneId => {
      polygonMap.set(zoneId, nextPolygonMap.get(zoneId));
      updateRenderedZoneGeometry(zoneRenderStateById.get(zoneId), polygonMap.get(zoneId), dragState.bounds, dragState.scale, dragState.pad);
    });
  });

  const finishDrag = () => {
    if (!dragState) return;
    const { onDataChanged: onDC, zoneIds, affectedEdges, didMove, currentOffset = 0 } = dragState;
    if (didMove) {
      highlightDraggedEdges(zoneRenderStateById, affectedEdges, false);
    }
    if (didMove) {
      suppressWallSelectionUntil = Date.now() + 250;
    }
    const changedPolygons = {};
    if (didMove) {
      const movedEdgesByZone = new Map();
      affectedEdges.forEach(({ zoneId, edgeIndex }) => {
        if (!movedEdgesByZone.has(zoneId)) movedEdgesByZone.set(zoneId, new Set());
        movedEdgesByZone.get(zoneId).add(edgeIndex);
      });

      zoneIds.forEach(zoneId => {
        const movedEdgeIndices = movedEdgesByZone.get(zoneId) || new Set();
        const basePolygon = dragState.basePolygonMap.get(zoneId) || [];
        const orthogonalized = buildOrthogonalPolygonFromMovedEdges(
          basePolygon,
          movedEdgeIndices,
          dragState.normal,
          currentOffset
        );
        changedPolygons[zoneId] = orthogonalized;
      });
    }
    dragState = null;
    if (didMove && onDC) onDC(changedPolygons);
  };
  svg.addEventListener('mouseup', finishDrag);
  svg.addEventListener('mouseleave', finishDrag);

  polygonEntries.forEach(({ zone }) => {
    const polygon = polygonMap.get(zone.id);
    const projected = polygon.map(pt => projectPoint(pt, bounds, scale, pad));
    const centroidWorld = polygonCentroid(polygon);
    const centroid = projectPoint(centroidWorld, bounds, scale, pad);

    const className = getThermalColorClass(zone);
    const fill = THERMAL_COLOR_BY_CLASS[className] || '#1ea85a';
    const strokeWidth = selectedZoneId === zone.id ? 4 : 1.6;

    const roomPoly = document.createElementNS(ns, 'polygon');
    roomPoly.setAttribute('points', projected.map(p => `${p.x},${p.y}`).join(' '));
    roomPoly.setAttribute('fill', fill);
    roomPoly.setAttribute('stroke', '#101010');
    roomPoly.setAttribute('stroke-width', String(strokeWidth));
    roomPoly.setAttribute('class', 'alt-room-rect');
    roomPoly.style.cursor = 'pointer';
    roomPoly.addEventListener('click', () => {
      if (dragState) return;
      selectedZoneId = zone.id;
      if (onZoneSelected) onZoneSelected(zone.id);
      renderAlternativeViz(demo, opts);
    });
    svg.appendChild(roomPoly);

    const lines = [];
    lines.push(`${zone.name || zone.id || 'Unnamed room'}${zone.is_boiler_control ? ' 🔥' : ''}`);

    const externalTemp = Number(demo?.meta?.externalTemp) || 3;
    const tempText = formatZoneTemperatureText(zone, externalTemp);
    if (tempText) lines.push(tempText);

    const capacity = getZoneCapacitySummary(zone, externalTemp);
    if (capacity) lines.push(capacity.text);

    const savingsText = getZoneSavingsText(zone);
    if (savingsText) lines.push(savingsText);

    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(centroid.x));
    text.setAttribute('y', String(centroid.y - ((lines.length - 1) * 10)));
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', '14');
    text.setAttribute('font-weight', '700');
    text.setAttribute('text-anchor', 'middle');
    text.style.pointerEvents = 'none';

    lines.forEach((line, idx) => {
      const tspan = document.createElementNS(ns, 'tspan');
      tspan.setAttribute('x', String(centroid.x));
      tspan.setAttribute('dy', idx === 0 ? '0' : '18');
      tspan.textContent = line;
      tspan.setAttribute('font-size', idx === 0 ? '15' : '12');
      tspan.setAttribute('font-weight', idx === 0 ? '700' : '500');
      text.appendChild(tspan);
    });

    svg.appendChild(text);

    const edgeElements = [];
    if (onDataChanged) {
      for (let idx = 0; idx < projected.length; idx++) {
        const p0 = projected[idx];
        const p1 = projected[(idx + 1) % projected.length];
        const worldP0 = polygonMap.get(zone.id)[idx];
        const worldP1 = polygonMap.get(zone.id)[(idx + 1) % polygonMap.get(zone.id).length];
        const handle = document.createElementNS(ns, 'line');
        handle.setAttribute('x1', String(p0.x));
        handle.setAttribute('y1', String(p0.y));
        handle.setAttribute('x2', String(p1.x));
        handle.setAttribute('y2', String(p1.y));
        handle.setAttribute('class', 'alt-wall-handle');
        handle.style.cursor = getEdgeCursor(worldP0, worldP1);
        handle.addEventListener('click', (e) => e.stopPropagation());
        handle.addEventListener('dblclick', (e) => e.stopPropagation());
        handle.addEventListener('mouseenter', () => {
          if (!dragState) handle.classList.add('is-hover');
        });
        handle.addEventListener('mouseleave', () => {
          if (!dragState) handle.classList.remove('is-hover');
        });
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const basePolygon = polygonMap.get(zone.id);
          const baseP0 = basePolygon[idx];
          const baseP1 = basePolygon[(idx + 1) % basePolygon.length];
          const edgeDx = baseP1.x - baseP0.x;
          const edgeDy = baseP1.y - baseP0.y;
          const edgeLength = Math.hypot(edgeDx, edgeDy);
          if (edgeLength < 1e-6) return;
          const normal = { x: -edgeDy / edgeLength, y: edgeDx / edgeLength };
          const startWorldPoint = svgPointToWorld(getSVGPoint(svg, e), bounds, scale, pad);
          const affectedEdges = edgeGroups.get(createEdgeKey(baseP0, baseP1)) || [{ zoneId: zone.id, edgeIndex: idx }];
          const zoneIds = [...new Set(affectedEdges.map(ref => ref.zoneId))];
          const edgeKey = createEdgeKey(baseP0, baseP1);
          const snapBaseCoord = dotPointNormal(baseP0, normal);
          const snapTargets = collectParallelSnapTargets(polygonMap, baseP0, baseP1, normal, edgeKey);
          dragState = {
            bounds,
            scale,
            pad,
            startWorldPoint,
            normal,
            affectedEdges,
            zoneIds,
            basePolygonMap: clonePolygonMap(polygonMap),
            onDataChanged,
            didMove: false,
            currentOffset: 0,
            snapBaseCoord,
            snapTargets,
          };
          handle.classList.remove('is-hover');
        });
        handle.addEventListener('mouseup', (e) => {
          if (!onWallSelected || Date.now() < suppressWallSelectionUntil || dragState?.didMove) return;
          e.stopPropagation();
          const element = findWallElementForEdge(demo, edgeGroups, polygonMap, zone.id, idx);
          if (element) {
            selectedZoneId = zone.id;
            onWallSelected(zone.id, element.id);
            renderAlternativeViz(demo, opts);
          }
        });
        edgeElements.push(handle);
        svg.appendChild(handle);
      }
    }

    zoneRenderStateById.set(zone.id, {
      polygonElement: roomPoly,
      textElement: text,
      tspans: Array.from(text.querySelectorAll('tspan')),
      edgeElements,
      lineCount: lines.length
    });
  });

  svgWrap.appendChild(svg);
  root.appendChild(svgWrap);
}
