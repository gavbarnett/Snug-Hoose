// Client-side solver orchestrator (ES module). Imports modular calculators and manages UI.

import { computeElementU } from './u_value_calculator.js';
import { computeRoomHeatRequirements } from './heat_calculator.js';
import { renderAlternativeViz } from './alt_viz.js';
import { initRoomEditor } from './room_editor.js';
import { initAppUi } from './app_ui.js';

let currentMaterials = null;
let currentRadiators = null;
let currentDemo = null;
let currentOpenings = null;
let currentVentilation = null;
let roomEditorApi = null;
let appUiApi = null;
let defaultDemoTemplate = null;
let lastFocusedZoneId = null;
let undoStack = [];
let redoStack = [];
let isApplyingHistory = false;
let variantState = null;

const MAX_HISTORY_STEPS = 100;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(16).slice(2, 14)}`;
}

function getIsoTimestamp() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return '';
  }
}

function sanitizeVariantName(raw, fallback = 'Variant') {
  const trimmed = String(raw || '').trim();
  return trimmed || fallback;
}

function stripVariantPayload(demo) {
  const cloned = deepClone(demo || {});
  if (cloned?.meta?.variants) {
    delete cloned.meta.variants;
  }
  if (cloned?.meta?.active_variant_id) {
    delete cloned.meta.active_variant_id;
  }
  if (cloned?.meta?.active_variant_name) {
    delete cloned.meta.active_variant_name;
  }
  return cloned;
}

function buildVariantSnapshotFromDemo(demo) {
  return stripVariantPayload(demo || {});
}

function listVariantEntries(state) {
  return Array.isArray(state?.variants) ? state.variants : [];
}

function getActiveVariantEntry(state = variantState) {
  const entries = listVariantEntries(state);
  if (entries.length === 0) return null;
  return entries.find(item => item?.id === state?.activeVariantId) || entries[0];
}

function getVariantStateForMenu() {
  const entries = listVariantEntries(variantState).map(item => ({
    id: item.id,
    name: item.name,
    metrics: getComparisonMetricsForDemo(item.snapshot)
  }));
  const active = getActiveVariantEntry(variantState);
  return {
    activeVariantId: active?.id || null,
    activeVariantName: active?.name || null,
    variants: entries,
    canDelete: entries.length > 1
  };
}

function syncActiveVariantSnapshot() {
  if (!variantState || !currentDemo) return;
  const active = getActiveVariantEntry(variantState);
  if (!active) return;
  active.snapshot = buildVariantSnapshotFromDemo(currentDemo);
  active.updatedAt = getIsoTimestamp();
}

function ensureVariantStateFromDemo(demo) {
  if (!demo || typeof demo !== 'object') {
    variantState = null;
    return;
  }

  const embedded = demo?.meta?.variants;
  if (embedded && Array.isArray(embedded.items) && embedded.items.length > 0) {
    const hydrated = embedded.items
      .map(item => {
        if (!item || !item.id || !item.snapshot) return null;
        return {
          id: String(item.id),
          name: sanitizeVariantName(item.name, 'Variant'),
          createdAt: String(item.created_at || item.createdAt || ''),
          updatedAt: String(item.updated_at || item.updatedAt || ''),
          snapshot: buildVariantSnapshotFromDemo(item.snapshot)
        };
      })
      .filter(Boolean);

    if (hydrated.length > 0) {
      const activeId = String(embedded.active_variant_id || hydrated[0].id);
      variantState = {
        activeVariantId: hydrated.some(item => item.id === activeId) ? activeId : hydrated[0].id,
        variants: hydrated
      };
      const active = getActiveVariantEntry(variantState);
      currentDemo = deepClone(active.snapshot);
      ensureBoundaryZones(currentDemo);
      return;
    }
  }

  const baselineId = 'variant_baseline';
  variantState = {
    activeVariantId: baselineId,
    variants: [{
      id: baselineId,
      name: 'Baseline',
      createdAt: getIsoTimestamp(),
      updatedAt: getIsoTimestamp(),
      snapshot: buildVariantSnapshotFromDemo(demo)
    }]
  };
  currentDemo = deepClone(variantState.variants[0].snapshot);
  ensureBoundaryZones(currentDemo);
}

function createVariantFromCurrent(name, switchToNew = true) {
  if (!currentDemo) return null;
  if (!variantState) ensureVariantStateFromDemo(currentDemo);
  syncActiveVariantSnapshot();

  const entry = {
    id: generateId('variant'),
    name: sanitizeVariantName(name, `Variant ${listVariantEntries(variantState).length + 1}`),
    createdAt: getIsoTimestamp(),
    updatedAt: getIsoTimestamp(),
    snapshot: buildVariantSnapshotFromDemo(currentDemo)
  };
  variantState.variants.push(entry);
  if (switchToNew) {
    variantState.activeVariantId = entry.id;
  }
  return entry;
}

function switchActiveVariant(nextVariantId) {
  if (!variantState || !nextVariantId) return false;
  const next = listVariantEntries(variantState).find(item => item.id === nextVariantId);
  if (!next) return false;
  syncActiveVariantSnapshot();
  variantState.activeVariantId = next.id;
  currentDemo = deepClone(next.snapshot);
  ensureBoundaryZones(currentDemo);
  clearHistory();
  return true;
}

function renameVariantById(variantId, nextName) {
  if (!variantState || !variantId) return false;
  const target = listVariantEntries(variantState).find(item => item.id === variantId);
  if (!target) return false;
  target.name = sanitizeVariantName(nextName, target.name || 'Variant');
  target.updatedAt = getIsoTimestamp();
  return true;
}

function renameActiveVariant(nextName) {
  const active = getActiveVariantEntry(variantState);
  if (!active) return false;
  return renameVariantById(active.id, nextName);
}

function deleteVariantById(variantId) {
  if (!variantState) return false;
  const entries = listVariantEntries(variantState);
  if (entries.length <= 1) return false;
  const index = entries.findIndex(item => item.id === String(variantId));
  if (index < 0) return false;
  const wasActive = variantState.activeVariantId === String(variantId);
  entries.splice(index, 1);
  if (wasActive) {
    const fallback = entries[Math.max(0, index - 1)] || entries[0];
    variantState.activeVariantId = fallback.id;
    currentDemo = deepClone(fallback.snapshot);
    ensureBoundaryZones(currentDemo);
    clearHistory();
  }
  return true;
}

function deleteActiveVariant() {
  const active = getActiveVariantEntry(variantState);
  if (!active) return false;
  return deleteVariantById(active.id);
}

function serializeProjectWithVariants() {
  syncActiveVariantSnapshot();
  const active = getActiveVariantEntry(variantState);
  const base = buildVariantSnapshotFromDemo(active?.snapshot || currentDemo || {});
  base.meta = base.meta || {};

  base.meta.variants = {
    active_variant_id: active?.id || null,
    items: listVariantEntries(variantState).map(item => ({
      id: item.id,
      name: item.name,
      created_at: item.createdAt || '',
      updated_at: item.updatedAt || '',
      snapshot: buildVariantSnapshotFromDemo(item.snapshot)
    }))
  };
  return base;
}

function getComparisonMetricsForDemo(demoRaw) {
  if (!demoRaw) return null;
  const working = deepClone(demoRaw);
  ensureBoundaryZones(working);
  const baseMaterials = currentMaterials ? (currentMaterials.materials || currentMaterials) : [];
  const openingMaterials = getOpeningMaterials(currentOpenings);
  const materials = [...baseMaterials, ...openingMaterials];
  const radiators = currentRadiators ? (currentRadiators.radiators || []) : [];
  const elements = Array.isArray(working.elements) ? working.elements : [];
  const buildupTemplates = (working.meta && working.meta.build_up_templates) || {};

  for (const el of elements) {
    try {
      computeElementU(el, materials, buildupTemplates);
    } catch (_) {
      // Ignore per-element calculation failures in compare mode.
    }
  }

  const indoorTemp = Number.isFinite(working?.meta?.indoorTemp) ? Number(working.meta.indoorTemp) : 21;
  const externalTemp = Number.isFinite(working?.meta?.externalTemp) ? Number(working.meta.externalTemp) : 3;
  const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
  const heat = computeRoomHeatRequirements(working, radiators, { indoorTemp, externalTemp, flowTemp });
  const annualDemand = Math.max(0, (Number(heat.total_delivered_heat || 0) * 24 * 365) / 1000);
  const roomCount = Array.isArray(heat.rooms) ? heat.rooms.length : 0;

  const totalFloorArea = (Array.isArray(heat.rooms) ? heat.rooms : [])
    .filter(r => !r.is_unheated)
    .reduce((sum, r) => {
      const area = Number(r.floorArea);
      return sum + (isFinite(area) && area > 0 ? area : 0);
    }, 0);
  const intensityKwhM2Yr = totalFloorArea > 0 ? (annualDemand / totalFloorArea) : null;

  let epcLetter = 'N/A';
  if (intensityKwhM2Yr !== null && isFinite(intensityKwhM2Yr)) {
    if (intensityKwhM2Yr <= 50) epcLetter = 'A';
    else if (intensityKwhM2Yr <= 90) epcLetter = 'B';
    else if (intensityKwhM2Yr <= 150) epcLetter = 'C';
    else if (intensityKwhM2Yr <= 230) epcLetter = 'D';
    else if (intensityKwhM2Yr <= 330) epcLetter = 'E';
    else if (intensityKwhM2Yr <= 450) epcLetter = 'F';
    else epcLetter = 'G';
  }

  return {
    roomCount,
    epcLetter,
    totalHeatLoss: Number(heat.total_heat_loss || 0),
    totalDeliveredHeat: Number(heat.total_delivered_heat || 0),
    totalAch: Number(heat.total_air_changes_per_hour || 0),
    totalVentilationConductance: Number(heat.total_ventilation_conductance || 0),
    annualDemandKwhYr: annualDemand
  };
}

function formatVariantCompareReport() {
  if (!variantState || listVariantEntries(variantState).length === 0) {
    return 'No variants are available to compare.';
  }
  const rows = listVariantEntries(variantState).map(item => {
    const metrics = getComparisonMetricsForDemo(item.snapshot);
    return {
      name: item.name,
      metrics
    };
  });

  const lines = [];
  lines.push('Variant Comparison (Whole Home)');
  lines.push('');
  lines.push('Name | Rooms | Heat Loss (W) | Delivered (W) | Annual (kWh/yr) | ACH | Vent Conductance (W/K)');
  lines.push('-----|-------|---------------|---------------|------------------|-----|-----------------------');
  rows.forEach(row => {
    if (!row.metrics) {
      lines.push(`${row.name} | n/a | n/a | n/a | n/a | n/a | n/a`);
      return;
    }
    lines.push(
      `${row.name} | ${row.metrics.roomCount} | ${row.metrics.totalHeatLoss.toFixed(0)} | ${row.metrics.totalDeliveredHeat.toFixed(0)} | ${row.metrics.annualDemandKwhYr.toFixed(0)} | ${row.metrics.totalAch.toFixed(2)} | ${row.metrics.totalVentilationConductance.toFixed(1)}`
    );
  });
  return lines.join('\n');
}

function clearHistory() {
  undoStack = [];
  redoStack = [];
}

function pushUndoSnapshot(snapshot) {
  if (!snapshot || isApplyingHistory) return;
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY_STEPS) {
    undoStack.splice(0, undoStack.length - MAX_HISTORY_STEPS);
  }
  redoStack = [];
}

function applyHistorySnapshot(snapshot) {
  if (!snapshot) return;
  isApplyingHistory = true;
  currentDemo = deepClone(snapshot);
  ensureBoundaryZones(currentDemo);
  isApplyingHistory = false;
  triggerSolve();
}

function handleUndo() {
  if (!currentDemo || undoStack.length === 0) return;
  const previous = undoStack.pop();
  redoStack.push(deepClone(currentDemo));
  applyHistorySnapshot(previous);
}

function handleRedo() {
  if (!currentDemo || redoStack.length === 0) return;
  const next = redoStack.pop();
  undoStack.push(deepClone(currentDemo));
  if (undoStack.length > MAX_HISTORY_STEPS) {
    undoStack.splice(0, undoStack.length - MAX_HISTORY_STEPS);
  }
  applyHistorySnapshot(next);
}

function ensureBoundaryZones(demo) {
  if (!demo || !Array.isArray(demo.zones)) demo.zones = [];
  const required = [
    { id: 'outside', name: 'outside', type: 'boundary' },
    { id: 'ground', name: 'ground', type: 'boundary' },
    { id: 'loft', name: 'loft', type: 'boundary' }
  ];
  const existing = new Set(demo.zones.map(zone => zone?.id));
  required.forEach(boundary => {
    if (!existing.has(boundary.id)) demo.zones.push(boundary);
  });
}

function getRoomZones(demo) {
  return Array.isArray(demo?.zones) ? demo.zones.filter(zone => zone && zone.type !== 'boundary') : [];
}

function getZoneById(demo, zoneId) {
  return Array.isArray(demo?.zones) ? demo.zones.find(zone => zone?.id === zoneId) : null;
}

function getNextLevel(demo) {
  const roomZones = getRoomZones(demo);
  if (roomZones.length === 0) return 0;
  const maxLevel = Math.max(...roomZones.map(zone => Number.isFinite(zone.level) ? zone.level : 0));
  return maxLevel + 1;
}

function getBoundaryZoneId(demo, role) {
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  const normalizedRole = String(role || '').trim().toLowerCase();
  const byName = zones.find(zone => {
    if (!zone || zone.type !== 'boundary') return false;
    const name = String(zone.name || '').trim().toLowerCase();
    return name === normalizedRole;
  });
  if (byName?.id) return byName.id;

  const byId = zones.find(zone => {
    if (!zone || zone.type !== 'boundary') return false;
    return String(zone.id || '').trim().toLowerCase() === normalizedRole;
  });
  return byId?.id || null;
}

function polygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    twiceArea += Number(p0.x) * Number(p1.y) - Number(p1.x) * Number(p0.y);
  }
  return Math.abs(twiceArea) / 2;
}

function polygonBounds(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  polygon.forEach(pt => {
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  return { minX, maxX, minY, maxY };
}

function createDefaultRoomPolygon(demo, level) {
  const zones = getRoomZones(demo).filter(zone => (Number.isFinite(zone?.level) ? zone.level : 0) === level);
  const existingPolygons = zones
    .map(zone => zone?.layout?.polygon)
    .filter(poly => Array.isArray(poly) && poly.length >= 3);

  const width = 4;
  const height = 4;

  let originX = 0;
  let originY = 0;
  if (existingPolygons.length > 0) {
    const bounds = existingPolygons
      .map(poly => polygonBounds(poly))
      .reduce((acc, b) => ({
        minX: Math.min(acc.minX, b.minX),
        maxX: Math.max(acc.maxX, b.maxX),
        minY: Math.min(acc.minY, b.minY),
        maxY: Math.max(acc.maxY, b.maxY)
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    originX = isFinite(bounds.maxX) ? bounds.maxX + 1 : 0;
    originY = isFinite(bounds.minY) ? bounds.minY : 0;
  }

  return [
    { x: originX, y: originY },
    { x: originX + width, y: originY },
    { x: originX + width, y: originY + height },
    { x: originX, y: originY + height }
  ];
}

function ensureRoomHorizontalElements(demo, zone, polygon) {
  if (!demo || !zone) return;
  if (!Array.isArray(demo.elements)) demo.elements = [];

  const groundId = getBoundaryZoneId(demo, 'ground');
  const loftId = getBoundaryZoneId(demo, 'loft');
  const bounds = polygonBounds(polygon);
  const spanX = Math.max(0.5, Number((bounds.maxX - bounds.minX).toFixed(3)));
  const spanY = Math.max(0.5, Number((bounds.maxY - bounds.minY).toFixed(3)));

  if (groundId) {
    const existingFloor = demo.elements.find(element => {
      if (!element || String(element.type || '').toLowerCase() !== 'floor') return false;
      const nodes = Array.isArray(element.nodes) ? element.nodes : [];
      return nodes.includes(zone.id) && nodes.includes(groundId);
    });
    if (!existingFloor) {
      demo.elements.push({
        id: generateId('el'),
        name: `${zone.name || zone.id} - Ground Floor`,
        type: 'floor',
        nodes: [zone.id, groundId],
        x: spanX,
        y: spanY
      });
    }
  }

  if (loftId) {
    const existingCeiling = demo.elements.find(element => {
      if (!element) return false;
      const type = String(element.type || '').toLowerCase();
      if (type !== 'ceiling' && type !== 'floor_ceiling') return false;
      const nodes = Array.isArray(element.nodes) ? element.nodes : [];
      return nodes.includes(zone.id) && nodes.includes(loftId);
    });
    if (!existingCeiling) {
      demo.elements.push({
        id: generateId('el'),
        name: `${zone.name || zone.id} - Ceiling`,
        type: 'ceiling',
        nodes: [zone.id, loftId],
        x: spanX,
        y: spanY
      });
    }
  }
}

function createRoomOnLevel(demo, level, namePrefix = 'Room', opts = {}) {
  if (!demo) return null;
  if (!Array.isArray(demo.zones)) demo.zones = [];
  if (!Array.isArray(demo.elements)) demo.elements = [];

  const roomCount = getRoomZones(demo).length + 1;
  const zoneId = generateId('id');
  const polygon = createDefaultRoomPolygon(demo, level);
  const centerX = Number(opts.centerX);
  const centerY = Number(opts.centerY);
  if (isFinite(centerX) && isFinite(centerY) && Array.isArray(polygon) && polygon.length >= 4) {
    const bounds = polygonBounds(polygon);
    const currentCenterX = (bounds.minX + bounds.maxX) / 2;
    const currentCenterY = (bounds.minY + bounds.maxY) / 2;
    const dx = centerX - currentCenterX;
    const dy = centerY - currentCenterY;
    polygon.forEach(pt => {
      pt.x = Number((pt.x + dx).toFixed(3));
      pt.y = Number((pt.y + dy).toFixed(3));
    });
  }
  const zone = {
    id: zoneId,
    name: `${namePrefix} ${roomCount}`,
    level,
    layout: { polygon: polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) })) },
    radiators: [],
    ventilation_elements: []
  };
  demo.zones.push(zone);
  ensureRoomHorizontalElements(demo, zone, polygon);
  return zone;
}

function removeRoomFromDemo(demo, zoneId) {
  if (!demo || !zoneId) return { removed: false, fallbackZoneId: null };
  if (!Array.isArray(demo.zones)) demo.zones = [];
  if (!Array.isArray(demo.elements)) demo.elements = [];

  const target = demo.zones.find(zone => zone && zone.id === zoneId && zone.type !== 'boundary');
  if (!target) return { removed: false, fallbackZoneId: null };

  const targetLevel = Number.isFinite(target.level) ? target.level : 0;
  demo.zones = demo.zones.filter(zone => !zone || zone.id !== zoneId);

  demo.elements = demo.elements
    .filter(element => {
      const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
      return !nodes.includes(zoneId);
    })
    .map(element => {
      if (!element || typeof element !== 'object') return element;
      if (Array.isArray(element.windows)) {
        element.windows = element.windows.filter(windowSpec => (windowSpec?.zone_id || null) !== zoneId);
      }
      if (Array.isArray(element.doors)) {
        element.doors = element.doors.filter(doorSpec => (doorSpec?.zone_id || null) !== zoneId);
      }
      return element;
    });

  const remainingRooms = getRoomZones(demo);
  const sameLevelZone = remainingRooms.find(zone => (Number.isFinite(zone?.level) ? zone.level : 0) === targetLevel);
  return {
    removed: true,
    fallbackZoneId: sameLevelZone?.id || remainingRooms[0]?.id || null
  };
}

function countOpeningsForZoneOnWall(wall, zoneId, kind) {
  const list = kind === 'door'
    ? (Array.isArray(wall?.doors) ? wall.doors : [])
    : (Array.isArray(wall?.windows) ? wall.windows : []);

  const ownerZoneId = Array.isArray(wall?.nodes) && wall.nodes.length > 0 ? wall.nodes[0] : null;
  return list.filter(opening => {
    const openingZone = opening?.zone_id || ownerZoneId;
    return openingZone === zoneId;
  }).length;
}

function pickPreferredWallForZone(demo, zoneId, purpose = 'generic') {
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  const boundaryIds = new Set(
    (Array.isArray(demo?.zones) ? demo.zones : [])
      .filter(zone => zone?.type === 'boundary')
      .map(zone => zone.id)
  );
  const zone = getZoneById(demo, zoneId);
  const zoneRadiators = Array.isArray(zone?.radiators) ? zone.radiators : [];
  const radiatorCountByWallId = new Map();
  zoneRadiators.forEach(radiator => {
    const wallId = radiator?.wall_element_id;
    if (!wallId) return;
    radiatorCountByWallId.set(wallId, (radiatorCountByWallId.get(wallId) || 0) + 1);
  });

  const wallElements = elements.filter(element => {
    if (!element || String(element.type || '').toLowerCase() !== 'wall') return false;
    if (!Array.isArray(element.nodes) || !element.nodes.includes(zoneId)) return false;
    return true;
  });
  if (wallElements.length === 0) return null;

  const scored = wallElements.map(wall => {
    const windowsCount = countOpeningsForZoneOnWall(wall, zoneId, 'window');
    const doorsCount = countOpeningsForZoneOnWall(wall, zoneId, 'door');
    const radiatorCount = radiatorCountByWallId.get(wall.id) || 0;
    const openingOccupancy = windowsCount + doorsCount;
    const occupancy = openingOccupancy + radiatorCount;
    const isExternal = wall.nodes.some(nodeId => boundaryIds.has(nodeId));
    const hasWindow = windowsCount > 0;
    const hasDoor = doorsCount > 0;
    return { wall, occupancy, openingOccupancy, radiatorCount, isExternal, hasWindow, hasDoor };
  });

  if (purpose === 'window') {
    scored.sort((a, b) => {
      if (a.openingOccupancy !== b.openingOccupancy) return a.openingOccupancy - b.openingOccupancy;
      if (a.isExternal !== b.isExternal) return a.isExternal ? -1 : 1;
      const aHasRadiator = a.radiatorCount > 0;
      const bHasRadiator = b.radiatorCount > 0;
      if (aHasRadiator !== bHasRadiator) return aHasRadiator ? -1 : 1;
      if (a.radiatorCount !== b.radiatorCount) return b.radiatorCount - a.radiatorCount;
      return 0;
    });
  } else if (purpose === 'door') {
    scored.sort((a, b) => {
      if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
      if (a.openingOccupancy !== b.openingOccupancy) return a.openingOccupancy - b.openingOccupancy;
      if (a.radiatorCount !== b.radiatorCount) return a.radiatorCount - b.radiatorCount;
      return 0;
    });
  } else if (purpose === 'radiator') {
    scored.sort((a, b) => {
      if (a.hasWindow !== b.hasWindow) return a.hasWindow ? -1 : 1;
      if (a.radiatorCount !== b.radiatorCount) return a.radiatorCount - b.radiatorCount;
      if (a.isExternal !== b.isExternal) return a.isExternal ? -1 : 1;
      if (a.openingOccupancy !== b.openingOccupancy) return a.openingOccupancy - b.openingOccupancy;
      return 0;
    });
  } else {
    scored.sort((a, b) => {
      if (a.occupancy !== b.occupancy) return a.occupancy - b.occupancy;
      if (a.isExternal !== b.isExternal) return a.isExternal ? -1 : 1;
      return 0;
    });
  }

  return scored[0]?.wall || null;
}

function addWindowToZoneWall(demo, openingsData, zoneId, opts = {}) {
  const wall = pickPreferredWallForZone(demo, zoneId, 'window');
  if (!wall) return false;
  if (!Array.isArray(wall.windows)) wall.windows = [];

  const firstOption = Array.isArray(openingsData?.windows) && openingsData.windows.length > 0
    ? openingsData.windows[0]
    : { id: 'window_double_modern', air_leakage_m3_h_m2: 1.2, has_trickle_vent: false, trickle_vent_flow_m3_h: 0 };

  const width = Number.isFinite(opts.width) ? opts.width : 1000;
  const height = Number.isFinite(opts.height) ? opts.height : 1200;

  wall.windows.push({
    id: generateId('id'),
    name: `Window ${wall.windows.length + 1}`,
    glazing_id: opts.glazingId || firstOption.id,
    width,
    height,
    area: Number(((width / 1000) * (height / 1000)).toFixed(3)),
    length_m: Number((width / 1000).toFixed(3)),
    position_ratio: 0.5,
    air_leakage_m3_h_m2: Number((firstOption.air_leakage_m3_h_m2 || 0).toFixed(3)),
    has_trickle_vent: firstOption.has_trickle_vent === true,
    trickle_vent_flow_m3_h: Number((firstOption.trickle_vent_flow_m3_h || 0).toFixed(2)),
    zone_id: zoneId
  });
  return true;
}

function addDoorToZoneWall(demo, openingsData, zoneId, opts = {}) {
  const wall = pickPreferredWallForZone(demo, zoneId, 'door');
  if (!wall) return false;
  if (!Array.isArray(wall.doors)) wall.doors = [];

  const firstOption = Array.isArray(openingsData?.doors) && openingsData.doors.length > 0
    ? openingsData.doors[0]
    : { id: 'door_wood_solid', air_leakage_m3_h_m2: 2.5 };

  const width = Number.isFinite(opts.width) ? opts.width : 900;
  const height = Number.isFinite(opts.height) ? opts.height : 2000;

  wall.doors.push({
    id: generateId('id'),
    name: `Door ${wall.doors.length + 1}`,
    material_id: opts.materialId || firstOption.id,
    width,
    height,
    area: Number(((width / 1000) * (height / 1000)).toFixed(3)),
    length_m: Number((width / 1000).toFixed(3)),
    position_ratio: 0.5,
    hinge_side: 'left',
    air_leakage_m3_h_m2: Number((firstOption.air_leakage_m3_h_m2 || 0).toFixed(3)),
    zone_id: zoneId
  });
  return true;
}

function addRadiatorToZone(demo, radiatorsData, zoneId, trvEnabled, opts = {}) {
  const zone = getZoneById(demo, zoneId);
  if (!zone) return false;
  if (!Array.isArray(zone.radiators)) zone.radiators = [];
  const wall = pickPreferredWallForZone(demo, zoneId, 'radiator');
  if (!wall) return false;

  const defaultType = Array.isArray(radiatorsData?.radiators) && radiatorsData.radiators.length > 0
    ? radiatorsData.radiators[0].id
    : 'type_11';

  const width = Number.isFinite(opts.width) ? opts.width : 800;
  const height = Number.isFinite(opts.height) ? opts.height : 600;

  zone.radiators.push({
    id: generateId('id'),
    radiator_id: opts.radiatorId || defaultType,
    wall_element_id: wall.id,
    width,
    height,
    surface_area: Number(((width / 1000) * (height / 1000)).toFixed(3)),
    trv_enabled: !!trvEnabled,
    position_ratio: 0.5
  });
  return true;
}

function addVentilationToZone(demo, ventilationData, zoneId, opts = {}) {
  const zone = getZoneById(demo, zoneId);
  if (!zone) return false;
  if (!Array.isArray(zone.ventilation_elements)) zone.ventilation_elements = [];

  const library = Array.isArray(ventilationData?.elements) ? ventilationData.elements : [];
  const preset = library.find(item => item?.id === opts.ventilationId)
    || library.find(item => item?.type === opts.type)
    || null;

  const flow = Number.isFinite(opts.flow_m3_h)
    ? opts.flow_m3_h
    : (Number.isFinite(preset?.default_flow_m3_h) ? preset.default_flow_m3_h : 30);
  const recovery = Number.isFinite(opts.heat_recovery_efficiency)
    ? Math.max(0, Math.min(1, opts.heat_recovery_efficiency))
    : (Number.isFinite(preset?.default_heat_recovery_efficiency)
      ? Math.max(0, Math.min(1, preset.default_heat_recovery_efficiency))
      : 0);

  const ventType = opts.type || preset?.type || 'extractor_bathroom';
  const baseName = preset?.name || (ventType === 'heat_exchanger' ? 'Heat Exchanger' : 'Extractor Fan');

  zone.ventilation_elements.push({
    id: generateId('id'),
    ventilation_id: preset?.id || opts.ventilationId || null,
    type: ventType,
    name: baseName,
    flow_m3_h: Number(flow.toFixed(2)),
    heat_recovery_efficiency: Number(recovery.toFixed(3)),
    enabled: true
  });

  return true;
}

function getTargetZoneId(context = {}) {
  const selectedZoneId = context.selectedZoneId || null;
  if (selectedZoneId) return selectedZoneId;
  return lastFocusedZoneId || null;
}

function saveCurrentProject() {
  if (!currentDemo) return;
  const projectJson = serializeProjectWithVariants();
  const blob = new Blob([JSON.stringify(projectJson, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(currentDemo?.meta?.name || 'project').replace(/[^a-z0-9_-]/gi, '_')}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function loadProjectFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      currentDemo = parsed;
      ensureVariantStateFromDemo(currentDemo);
      clearHistory();
      triggerSolve();
    } catch (error) {
      console.error(error);
      if (appUiApi) appUiApi.setStatus(`Error loading project: ${String(error)}`);
    }
  });
  input.click();
}

function createNewProjectBlank() {
  const blank = {
    meta: {
      name: 'Blank Project',
      global_target_temperature: 21,
      externalTemp: 3,
      indoorTemp: 21,
      flowTemp: 55,
      build_up_templates: (currentDemo?.meta?.build_up_templates && typeof currentDemo.meta.build_up_templates === 'object')
        ? deepClone(currentDemo.meta.build_up_templates)
        : {}
    },
    zones: [],
    elements: []
  };
  ensureBoundaryZones(blank);
  currentDemo = blank;
  ensureVariantStateFromDemo(currentDemo);
  clearHistory();
  triggerSolve();
}

function createNewProjectFromTemplate() {
  if (!defaultDemoTemplate) {
    createNewProjectBlank();
    return;
  }
  currentDemo = deepClone(defaultDemoTemplate);
  ensureVariantStateFromDemo(currentDemo);
  clearHistory();
  triggerSolve();
}

function handleAltVizMenuAction(action, item, context = {}) {
  if (!action) return;

  const selectedZoneId = getTargetZoneId(context);
  const selectedLevel = Number.isFinite(context.selectedLevel) ? context.selectedLevel : 0;
  const payload = item?.payload || {};

  switch (action) {
    case 'edit.undo':
      handleUndo();
      return;
    case 'edit.redo':
      handleRedo();
      return;
    case 'environment.set.indoor': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.indoorTemp = value;
      triggerSolve();
      return;
    }
    case 'environment.set.external': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.externalTemp = value;
      triggerSolve();
      return;
    }
    case 'environment.set.flow': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.flowTemp = value;
      triggerSolve();
      return;
    }
    case 'file.new.blank':
      createNewProjectBlank();
      return;
    case 'file.new.from_template':
      createNewProjectFromTemplate();
      return;
    case 'file.save_project':
      saveCurrentProject();
      return;
    case 'file.load_project':
      loadProjectFromFile();
      return;
    case 'file.variants.save_as':
    case 'file.variants.create': {
      if (!currentDemo) return;
      const nextName = sanitizeVariantName(
        payload.name,
        `Variant ${listVariantEntries(variantState).length + 1}`
      );
      createVariantFromCurrent(nextName, true);
      clearHistory();
      triggerSolve();
      return;
    }
    case 'file.variants.switch': {
      const targetVariantId = String(payload.variantId || '');
      if (!targetVariantId) return;
      if (switchActiveVariant(targetVariantId)) {
        lastFocusedZoneId = null;
        triggerSolve();
      }
      return;
    }
    case 'file.variants.rename_active':
    case 'file.variants.rename': {
      const targetVariantId = String(payload.variantId || getActiveVariantEntry(variantState)?.id || '');
      const nextName = String(payload.name || '');
      if (!targetVariantId || !nextName.trim()) return;
      if (renameVariantById(targetVariantId, nextName)) {
        triggerSolve();
      }
      return;
    }
    case 'file.variants.delete_active': {
      if (deleteActiveVariant()) {
        lastFocusedZoneId = null;
        triggerSolve();
      }
      return;
    }
    case 'file.variants.delete': {
      const variantId = String(payload.variantId || '');
      if (!variantId) return;
      if (deleteVariantById(variantId)) {
        lastFocusedZoneId = null;
        triggerSolve();
      }
      return;
    }
    case 'file.variants.compare_overall': {
      const report = formatVariantCompareReport();
      if (appUiApi && typeof appUiApi.setStatus === 'function') {
        appUiApi.setStatus(report);
      }
      return;
    }
    case 'structure.add.room': {
      if (!currentDemo) return;
      pushUndoSnapshot(deepClone(currentDemo));
      const level = selectedZoneId
        ? (getZoneById(currentDemo, selectedZoneId)?.level ?? selectedLevel)
        : selectedLevel;
      const zone = createRoomOnLevel(currentDemo, level, 'Room');
      triggerSolve();
      if (zone) {
        lastFocusedZoneId = zone.id;
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zone.id);
      }
      return;
    }
    case 'structure.add.room.at': {
      if (!currentDemo) return;
      pushUndoSnapshot(deepClone(currentDemo));
      const level = Number.isFinite(payload.level)
        ? payload.level
        : (selectedZoneId ? (getZoneById(currentDemo, selectedZoneId)?.level ?? selectedLevel) : selectedLevel);
      const zone = createRoomOnLevel(currentDemo, level, 'Room', {
        centerX: Number(payload.x),
        centerY: Number(payload.y)
      });
      triggerSolve();
      if (zone) {
        lastFocusedZoneId = zone.id;
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zone.id);
      }
      return;
    }
    case 'structure.add.floor': {
      if (!currentDemo) return;
      pushUndoSnapshot(deepClone(currentDemo));
      const level = getNextLevel(currentDemo);
      const zone = createRoomOnLevel(currentDemo, level, `Floor ${level} Room`);
      triggerSolve();
      if (zone) {
        lastFocusedZoneId = zone.id;
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zone.id);
      }
      return;
    }
    case 'structure.delete.room': {
      if (!currentDemo) return;
      const zoneId = payload.zoneId || selectedZoneId;
      if (!zoneId) return;
      const zone = getZoneById(currentDemo, zoneId);
      if (!zone || zone.type === 'boundary') return;
      pushUndoSnapshot(deepClone(currentDemo));
      const { removed, fallbackZoneId } = removeRoomFromDemo(currentDemo, zoneId);
      if (!removed) return;
      lastFocusedZoneId = fallbackZoneId || null;
      triggerSolve();
      if (fallbackZoneId && roomEditorApi?.focusZone) roomEditorApi.focusZone(fallbackZoneId);
      return;
    }
    case 'openings.windows.add':
    case 'openings.windows.types.standard_sizes': {
      if (!currentDemo || !selectedZoneId) return;
      const before = deepClone(currentDemo);
      if (addWindowToZoneWall(currentDemo, currentOpenings, selectedZoneId, {
        width: Number(payload.width),
        height: Number(payload.height),
        glazingId: payload.glazingId
      })) {
        pushUndoSnapshot(before);
        lastFocusedZoneId = selectedZoneId;
        triggerSolve();
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(selectedZoneId);
      }
      return;
    }
    case 'openings.doors.add':
    case 'openings.doors.types.standard_sizes': {
      if (!currentDemo || !selectedZoneId) return;
      const before = deepClone(currentDemo);
      if (addDoorToZoneWall(currentDemo, currentOpenings, selectedZoneId, {
        width: Number(payload.width),
        height: Number(payload.height),
        materialId: payload.materialId
      })) {
        pushUndoSnapshot(before);
        lastFocusedZoneId = selectedZoneId;
        triggerSolve();
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(selectedZoneId);
      }
      return;
    }
    case 'hvac.radiators.add':
    case 'hvac.radiators.standard_sizes.trv':
    case 'hvac.radiators.standard_sizes.no_trv': {
      if (!currentDemo || !selectedZoneId) return;
      const before = deepClone(currentDemo);
      const trv = typeof payload.trvEnabled === 'boolean' ? payload.trvEnabled : action.endsWith('.trv');
      if (addRadiatorToZone(currentDemo, currentRadiators, selectedZoneId, trv, {
        width: Number(payload.width),
        height: Number(payload.height),
        radiatorId: payload.radiatorId
      })) {
        pushUndoSnapshot(before);
        lastFocusedZoneId = selectedZoneId;
        triggerSolve();
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(selectedZoneId);
      }
      return;
    }
    case 'hvac.boiler_thermostat': {
      if (!currentDemo || !selectedZoneId) return;
      const zone = getZoneById(currentDemo, selectedZoneId);
      if (!zone) return;
      pushUndoSnapshot(deepClone(currentDemo));
      zone.is_boiler_control = true;
      delete zone.is_unheated;
      lastFocusedZoneId = selectedZoneId;
      triggerSolve();
      if (roomEditorApi?.focusZone) roomEditorApi.focusZone(selectedZoneId);
      return;
    }
    case 'hvac.ventilation.add': {
      if (!currentDemo || !selectedZoneId) return;
      const before = deepClone(currentDemo);
      if (addVentilationToZone(currentDemo, currentVentilation, selectedZoneId, {
        ventilationId: payload.ventilationId,
        type: payload.type,
        flow_m3_h: Number(payload.flow_m3_h),
        heat_recovery_efficiency: Number(payload.heat_recovery_efficiency)
      })) {
        pushUndoSnapshot(before);
        lastFocusedZoneId = selectedZoneId;
        triggerSolve();
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(selectedZoneId);
      }
      return;
    }
    case 'zones.rename': {
      if (!currentDemo) return;
      const zoneId = payload.zoneId || selectedZoneId;
      if (!zoneId) return;
      const zone = getZoneById(currentDemo, zoneId);
      if (!zone) return;
      pushUndoSnapshot(deepClone(currentDemo));
      const nextName = String(payload.name || '').trim();
      if (nextName) {
        zone.name = nextName;
      } else {
        delete zone.name;
      }
      lastFocusedZoneId = zoneId;
      triggerSolve();
      if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zoneId);
      return;
    }
    case 'zones.setpoint': {
      if (!currentDemo) return;
      const zoneId = payload.zoneId || selectedZoneId;
      if (!zoneId) return;
      const zone = getZoneById(currentDemo, zoneId);
      if (!zone) return;
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      zone.setpoint_temperature = value;
      delete zone.is_unheated;
      lastFocusedZoneId = zoneId;
      triggerSolve();
      if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zoneId);
      return;
    }
    case 'zones.heating': {
      if (!currentDemo) return;
      const zoneId = payload.zoneId || selectedZoneId;
      if (!zoneId) return;
      const zone = getZoneById(currentDemo, zoneId);
      if (!zone) return;
      pushUndoSnapshot(deepClone(currentDemo));
      const isUnheated = !!payload.isUnheated;
      if (isUnheated) {
        zone.is_unheated = true;
        delete zone.setpoint_temperature;
        zone.is_boiler_control = false;
      } else {
        delete zone.is_unheated;
      }
      lastFocusedZoneId = zoneId;
      triggerSolve();
      if (roomEditorApi?.focusZone) roomEditorApi.focusZone(zoneId);
      return;
    }
    default:
      console.info(`[alt-viz menu] action selected: ${action}`);
  }
}

function isEditableEventTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('input, textarea, select')) return true;
  if (target.closest('[contenteditable=""], [contenteditable="true"]')) return true;
  return false;
}

function handleGlobalShortcut(event) {
  if (!event) return;
  if (isEditableEventTarget(event.target)) return;

  const key = String(event.key || '').toLowerCase();

  if ((key === 'delete' || key === 'backspace') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    handleAltVizMenuAction('structure.delete.room', { action: 'structure.delete.room' }, {});
    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.altKey) return;

  // Undo / Redo
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    handleAltVizMenuAction('edit.undo', { action: 'edit.undo' }, {});
    return;
  }
  if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault();
    handleAltVizMenuAction('edit.redo', { action: 'edit.redo' }, {});
    return;
  }

  // File shortcuts
  if (key === 's') {
    event.preventDefault();
    handleAltVizMenuAction('file.save_project', { action: 'file.save_project' }, {});
    return;
  }
  if (key === 'o') {
    event.preventDefault();
    handleAltVizMenuAction('file.load_project', { action: 'file.load_project' }, {});
    return;
  }
  if (key === 'n' && !event.shiftKey) {
    event.preventDefault();
    handleAltVizMenuAction('file.new.blank', { action: 'file.new.blank' }, {});
    return;
  }
  if (key === 'n' && event.shiftKey) {
    event.preventDefault();
    handleAltVizMenuAction('file.new.from_template', { action: 'file.new.from_template' }, {});
  }
}

async function tryFetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Fetch failed');
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function loadDefaultInputs() {
  let ins = await tryFetchJson('./source/resources/insulation.json');
  if (!ins) {
    console.warn('Failed to load insulation.json, using fallback materials');
    ins = {
      materials: [
        { id: "brick", name: "Brick", thermal_conductivity: 0.77 },
        { id: "concrete", name: "Concrete", thermal_conductivity: 1.4 },
        { id: "pir", name: "PIR board", thermal_conductivity: 0.022 },
        { id: "glass", name: "Glass", thermal_conductivity: 0.96 },
        { id: "air", name: "Air gap", thermal_conductivity: 0.025 }
      ]
    };
  }
  
  let demo = await tryFetchJson('./source/resources/demo_house.json');
  if (!demo) {
    console.warn('Failed to load demo_house.json, using fallback demo');
    demo = {
      meta: { name: "Fallback Demo House" },
      zones: [
        { id: "living_room", level: 0, elements: ["wall1", "window1"], radiators: [{ radiator_id: "panel_rad", surface_area: 2.0 }] }
      ],
      elements: [
        { id: "wall1", type: "wall", area: 20, orientation: "north", layers: [{ material: "brick", thickness: 0.1 }, { material: "pir", thickness: 0.1 }] },
        { id: "window1", type: "window", area: 4, orientation: "north", material: "glass", thickness: 0.006 }
      ]
    };
  }
  
  let rads = await tryFetchJson('./source/resources/radiators.json');
  if (!rads) {
    console.warn('Failed to load radiators.json, using fallback radiators');
    rads = {
      radiators: [
        { id: "panel_rad", name: "Panel Radiator", heat_transfer_coefficient: 100 }
      ]
    };
  }

  let openings = await tryFetchJson('./source/resources/openings.json');
  if (!openings) {
    console.warn('Failed to load openings.json, using fallback opening options');
    openings = {
      windows: [
        { id: 'window_single', name: 'Single Glazing', u_value: 5.7, air_leakage_m3_h_m2: 3.2, has_trickle_vent: false, trickle_vent_flow_m3_h: 0 },
        { id: 'window_double_modern', name: 'Double Glazing (Modern)', u_value: 1.6, air_leakage_m3_h_m2: 1.2, has_trickle_vent: false, trickle_vent_flow_m3_h: 0 }
      ],
      doors: [
        { id: 'door_wood_solid', name: 'Solid Wood Door', u_value: 2.8, air_leakage_m3_h_m2: 3.0 },
        { id: 'door_pvc_insulated', name: 'PVC Insulated Door', u_value: 1.8, air_leakage_m3_h_m2: 1.8 }
      ]
    };
  }

  let ventilation = await tryFetchJson('./source/resources/ventilation.json');
  if (!ventilation) {
    console.warn('Failed to load ventilation.json, using fallback ventilation options');
    ventilation = {
      elements: [
        {
          id: 'extractor_oven_hood',
          name: 'Oven Hood Extractor',
          type: 'extractor_kitchen',
          default_flow_m3_h: 60,
          default_heat_recovery_efficiency: 0,
          enabled: true
        },
        {
          id: 'extractor_bathroom',
          name: 'Bathroom Vent',
          type: 'extractor_bathroom',
          default_flow_m3_h: 30,
          default_heat_recovery_efficiency: 0,
          enabled: true
        },
        {
          id: 'heat_exchanger_mvhr',
          name: 'Heat Exchanger (MVHR)',
          type: 'heat_exchanger',
          default_flow_m3_h: 35,
          default_heat_recovery_efficiency: 0.75,
          enabled: true
        }
      ]
    };
  }
  
  return [ins, demo, rads, openings, ventilation];
}

function getOpeningMaterials(openings) {
  if (!openings) return [];
  const windows = Array.isArray(openings.windows) ? openings.windows : [];
  const doors = Array.isArray(openings.doors) ? openings.doors : [];
  const asMaterial = (item) => ({
    id: item.id,
    name: item.name,
    u_value: item.u_value,
    air_leakage_m3_h_m2: item.air_leakage_m3_h_m2,
    trickle_vent_flow_m3_h: item.trickle_vent_flow_m3_h
  });
  return [...windows.map(asMaterial), ...doors.map(asMaterial)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseSyntheticIndex(id, prefix) {
  const match = String(id || '').match(new RegExp(`^${prefix}_(\\d+)$`));
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function findOpeningInWall(wall, openingKind, openingId) {
  if (!wall) return { list: null, index: -1, opening: null };
  const listKey = openingKind === 'window' ? 'windows' : 'doors';
  if (!Array.isArray(wall[listKey])) wall[listKey] = [];
  const list = wall[listKey];

  let index = list.findIndex(item => String(item?.id || '') === String(openingId || ''));
  if (index < 0) {
    const syntheticIndex = parseSyntheticIndex(openingId, 'opening');
    if (syntheticIndex !== null && syntheticIndex < list.length) {
      index = syntheticIndex;
    }
  }

  return {
    list,
    index,
    opening: index >= 0 ? list[index] : null
  };
}

function moveOpeningAcrossWalls(payload) {
  if (!currentDemo || !Array.isArray(currentDemo.elements) || !payload) return false;
  const {
    openingKind,
    openingId,
    sourceWallElementId,
    targetWallElementId,
    targetZoneId,
    targetPositionRatio
  } = payload;

  const sourceWall = currentDemo.elements.find(el => el?.id === sourceWallElementId);
  const targetWall = currentDemo.elements.find(el => el?.id === targetWallElementId);
  if (!sourceWall || !targetWall) return false;

  const sourceMatch = findOpeningInWall(sourceWall, openingKind, openingId);
  if (!sourceMatch.opening) return false;
  const opening = sourceMatch.opening;
  opening.position_ratio = Number(clamp(Number(targetPositionRatio), 0, 1).toFixed(3));
  if (targetZoneId) {
    opening.zone_id = targetZoneId;
  }

  if (sourceWall.id === targetWall.id) {
    return true;
  }

  sourceMatch.list.splice(sourceMatch.index, 1);
  const targetListKey = openingKind === 'window' ? 'windows' : 'doors';
  if (!Array.isArray(targetWall[targetListKey])) targetWall[targetListKey] = [];
  targetWall[targetListKey].push(opening);
  return true;
}

function moveRadiatorAcrossZones(payload) {
  if (!currentDemo || !Array.isArray(currentDemo.zones) || !payload) return false;
  const { sourceZoneId, targetZoneId, radiatorId, targetWallElementId, targetPositionRatio } = payload;
  const sourceZone = currentDemo.zones.find(zone => zone?.id === sourceZoneId);
  const targetZone = currentDemo.zones.find(zone => zone?.id === targetZoneId);
  if (!sourceZone || !targetZone) return false;
  if (!Array.isArray(sourceZone.radiators)) sourceZone.radiators = [];
  if (!Array.isArray(targetZone.radiators)) targetZone.radiators = [];

  let index = sourceZone.radiators.findIndex(rad => String(rad?.id || '') === String(radiatorId || ''));
  if (index < 0) {
    const syntheticIndex = parseSyntheticIndex(radiatorId, 'radiator');
    if (syntheticIndex !== null && syntheticIndex < sourceZone.radiators.length) {
      index = syntheticIndex;
    }
  }
  if (index < 0) return false;

  const radiator = sourceZone.radiators[index];
  if (!radiator.id && radiatorId && !String(radiatorId).startsWith('radiator_')) {
    radiator.id = String(radiatorId);
  }
  if (targetWallElementId) {
    radiator.wall_element_id = targetWallElementId;
  }
  if (typeof targetPositionRatio === 'number' && isFinite(targetPositionRatio)) {
    radiator.position_ratio = Number(clamp(targetPositionRatio, 0, 1).toFixed(3));
  }

  if (sourceZone.id === targetZone.id) {
    return true;
  }

  sourceZone.radiators.splice(index, 1);
  targetZone.radiators.push(radiator);
  return true;
}

async function solveAndRender(demoRaw) {
  try {
    if (!currentMaterials) {
      throw new Error('Materials data not loaded. Please check that insulation.json is available.');
    }
    const baseMaterials = currentMaterials.materials || currentMaterials;
    const openingMaterials = getOpeningMaterials(currentOpenings);
    const materials = [...baseMaterials, ...openingMaterials];
    const radiators = currentRadiators ? (currentRadiators.radiators || []) : [];
    const elements = demoRaw.elements || demoRaw.rooms || [];
    if (!Array.isArray(elements)) throw new Error('No elements array found in demo json');

    // Calculate U-values for all elements
    const buildupTemplates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
    for (const el of elements) {
      try { computeElementU(el, materials, buildupTemplates); } catch (err) { el._calc_error = String(err); }
    }

    // Get input values and calculate room heat requirements
    const inputTemps = appUiApi ? appUiApi.getTemperatureInputs() : {};
    const indoorTemp = inputTemps && typeof inputTemps.indoorTemp === 'number' && isFinite(inputTemps.indoorTemp)
      ? inputTemps.indoorTemp
      : (Number.isFinite(demoRaw?.meta?.indoorTemp) ? Number(demoRaw.meta.indoorTemp) : 21);
    const externalTemp = inputTemps && typeof inputTemps.externalTemp === 'number' && isFinite(inputTemps.externalTemp)
      ? inputTemps.externalTemp
      : (Number.isFinite(demoRaw?.meta?.externalTemp) ? Number(demoRaw.meta.externalTemp) : 3);
    const flowTemp = inputTemps && typeof inputTemps.flowTemp === 'number' && isFinite(inputTemps.flowTemp)
      ? inputTemps.flowTemp
      : (Number.isFinite(demoRaw?.meta?.flowTemp) ? Number(demoRaw.meta.flowTemp) : 55);

    const heatResults = computeRoomHeatRequirements(demoRaw, radiators, { indoorTemp, externalTemp, flowTemp });

    // Annotate demo JSON with results
    demoRaw.meta = demoRaw.meta || {};
    demoRaw.meta.indoorTemp = indoorTemp;
    demoRaw.meta.externalTemp = externalTemp;
    demoRaw.meta.flowTemp = flowTemp;
    demoRaw.meta.total_heat_loss = heatResults.total_heat_loss;
    demoRaw.meta.total_heat_loss_baseline = heatResults.total_heat_loss_baseline;
    demoRaw.meta.total_heat_savings = heatResults.total_heat_savings;
    demoRaw.meta.total_delivered_heat = heatResults.total_delivered_heat;
    demoRaw.meta.total_delivered_heat_savings = heatResults.total_delivered_heat_savings;
    demoRaw.meta.total_infiltration_airflow_m3_h = heatResults.total_infiltration_airflow_m3_h;
    demoRaw.meta.total_mechanical_ventilation_airflow_m3_h = heatResults.total_mechanical_ventilation_airflow_m3_h;
    demoRaw.meta.total_heat_recovered_airflow_m3_h = heatResults.total_heat_recovered_airflow_m3_h;
    demoRaw.meta.total_ventilation_conductance = heatResults.total_ventilation_conductance;
    demoRaw.meta.total_air_changes_per_hour = heatResults.total_air_changes_per_hour;
    demoRaw.meta.total_radiator_output = heatResults.total_radiator_output;
    demoRaw.meta.total_radiator_output_baseline = heatResults.total_radiator_output_baseline;
    demoRaw.meta.total_balance = heatResults.total_balance;
    demoRaw.meta.total_balance_baseline = heatResults.total_balance_baseline;
    demoRaw.meta.effective_flow_temp = heatResults.effectiveFlowTemp;
    demoRaw.meta.max_flow_temp = heatResults.maxFlowTemp;
    demoRaw.meta.control_zone_id = heatResults.controlZoneId;
    demoRaw.meta.control_zone_name = heatResults.controlZoneName;

    // Merge room heat results into zones
    for (const zone of demoRaw.zones) {
      const room = heatResults.rooms.find(r => r.zoneId === zone.id);
      if (room) {
        zone.floor_area = room.floorArea;
        zone.total_conductance = room.total_conductance;
        zone.heat_loss = room.heat_loss;
        zone.heat_loss_baseline = room.heat_loss_baseline;
        zone.heat_savings = room.heat_savings;
        zone.heat_loss_per_unit_area = room.heat_loss_per_unit_area;
        zone.delivered_indoor_temperature = room.delivered_indoor_temperature;
        zone.delivered_heat = room.delivered_heat;
        zone.delivered_heat_per_unit_area = room.delivered_heat_per_unit_area;
        zone.delivered_heat_savings = room.delivered_heat_savings;
        zone.room_volume_m3 = room.room_volume_m3;
        zone.infiltration_airflow_m3_h = room.infiltration_airflow_m3_h;
        zone.mechanical_ventilation_airflow_m3_h = room.mechanical_ventilation_airflow_m3_h;
        zone.heat_recovered_airflow_m3_h = room.heat_recovered_airflow_m3_h;
        zone.ventilation_conductance = room.ventilation_conductance;
        zone.infiltration_ach = room.infiltration_ach;
        zone.air_changes_per_hour = room.air_changes_per_hour;
        zone.radiator_surface_area = room.radiator_surface_area;
        zone.radiator_coefficient = room.radiator_coefficient;
        zone.radiator_output = room.radiator_output;
        zone.heating_balance = room.heating_balance;
        zone.is_unheated = room.is_unheated;
        zone.can_reach_setpoint = room.can_reach_setpoint;
        zone.max_achievable_temperature = room.max_achievable_temperature;
        zone.setpoint_shortfall = room.setpoint_shortfall;
        zone.balance_status = room.balance_status;
        zone.contributing_elements = room.contributing_elements;
        zone.setpoint_temperature = room.setpoint_temperature;
        zone.is_boiler_control = room.is_boiler_control;
      }
    }

    const variantMenuState = getVariantStateForMenu();
    demoRaw.meta = demoRaw.meta || {};
    if (variantMenuState.activeVariantId) {
      demoRaw.meta.active_variant_id = variantMenuState.activeVariantId;
    }
    if (variantMenuState.activeVariantName) {
      demoRaw.meta.active_variant_name = variantMenuState.activeVariantName;
    }

    renderAlternativeViz({
      ...demoRaw,
      openings: currentOpenings,
      radiators: currentRadiators,
      ventilation: currentVentilation,
      variant_state: variantMenuState
    }, {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      onMenuAction: handleAltVizMenuAction,
      onZoneSelected: (zoneId) => {
        lastFocusedZoneId = zoneId;
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
        }
      },
      onWallSelected: (zoneId, elementId) => {
        lastFocusedZoneId = zoneId;
        if (roomEditorApi && typeof roomEditorApi.focusElement === 'function') {
          roomEditorApi.focusElement(zoneId, elementId);
          return;
        }
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
        }
      },
      onOpeningSelected: (zoneId, elementId, kind, openingId) => {
        lastFocusedZoneId = zoneId;
        if (roomEditorApi && typeof roomEditorApi.focusOpening === 'function') {
          roomEditorApi.focusOpening(zoneId, elementId, kind, openingId);
          return;
        }
        if (roomEditorApi && typeof roomEditorApi.focusElement === 'function') {
          roomEditorApi.focusElement(zoneId, elementId);
          return;
        }
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
        }
      },
      onRadiatorSelected: (zoneId, radiatorId) => {
        lastFocusedZoneId = zoneId;
        if (roomEditorApi && typeof roomEditorApi.focusRadiator === 'function') {
          roomEditorApi.focusRadiator(zoneId, radiatorId);
          return;
        }
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
        }
      },
      onObjectMoved: (payload) => {
        if (!payload || !currentDemo) return;
        const before = deepClone(currentDemo);
        let changed = false;
        if (payload.kind === 'opening') {
          changed = moveOpeningAcrossWalls(payload);
        } else if (payload.kind === 'radiator') {
          changed = moveRadiatorAcrossZones(payload);
        }
        if (changed) {
          pushUndoSnapshot(before);
          triggerSolve();
        }
      },
      onSeedLevelPolygons: (_level, polygonsByZoneId) => {
        if (!currentDemo || !Array.isArray(currentDemo.zones) || !polygonsByZoneId) return;

        for (const zone of currentDemo.zones) {
          if (!zone || !zone.id) continue;
          const polygon = polygonsByZoneId[zone.id];
          if (!Array.isArray(polygon) || polygon.length < 3) continue;
          zone.layout = zone.layout || {};
          zone.layout.polygon = polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) }));
        }

        triggerSolve();
      },
      onDataChanged: (changedPolygons, maybePolygon) => {
        if (!currentDemo || !Array.isArray(currentDemo.zones)) return;
        const before = deepClone(currentDemo);

        const polygonsByZoneId = Array.isArray(maybePolygon)
          ? { [changedPolygons]: maybePolygon }
          : changedPolygons;

        if (!polygonsByZoneId || typeof polygonsByZoneId !== 'object') return;

        for (const zone of currentDemo.zones) {
          if (!zone || !zone.id) continue;
          const polygon = polygonsByZoneId[zone.id];
          if (!Array.isArray(polygon) || polygon.length < 3) continue;
          zone.layout = zone.layout || {};
          zone.layout.polygon = polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) }));
        }

        reconcileWallElementsFromPolygons(currentDemo, polygonsByZoneId);

        pushUndoSnapshot(before);
        triggerSolve();
      }
    });
    if (roomEditorApi && typeof roomEditorApi.refreshSelectedZone === 'function') {
      roomEditorApi.refreshSelectedZone();
    }

    // Output results
    const solved = JSON.stringify(demoRaw, null, 2);
    if (appUiApi) appUiApi.setSolvedOutput(solved);
  } catch (err) {
    if (appUiApi) appUiApi.setStatus('Solver error: ' + String(err));
    console.error(err);
  }
}

function triggerSolve() {
  if (currentDemo) {
    syncActiveVariantSnapshot();
    const polygonsByZoneId = collectLayoutPolygonsByZoneId(currentDemo);
    if (Object.keys(polygonsByZoneId).length > 0) {
      reconcileWallElementsFromPolygons(currentDemo, polygonsByZoneId);
      reconcileInterlevelElementsFromPolygons(currentDemo, polygonsByZoneId);
    }
    solveAndRender(JSON.parse(JSON.stringify(currentDemo)));
  }
}

function isValidLayoutPolygon(polygon) {
  return Array.isArray(polygon) && polygon.length >= 3 && polygon.every(pt => pt && isFinite(pt.x) && isFinite(pt.y));
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

function pointKey(pt, precision = 6) {
  return `${Number(pt.x).toFixed(precision)},${Number(pt.y).toFixed(precision)}`;
}

function isCollinear(prev, curr, next, epsilon = 1e-6) {
  const ax = curr.x - prev.x;
  const ay = curr.y - prev.y;
  const bx = next.x - curr.x;
  const by = next.y - curr.y;
  return Math.abs(ax * by - ay * bx) <= epsilon;
}

function simplifyPolygonPreservingSharedVertices(polygon, sharedPointKeys) {
  if (!Array.isArray(polygon) || polygon.length < 4) return polygon || [];

  let out = polygon.map(pt => ({ x: pt.x, y: pt.y }));
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const next = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const prev = out[(i - 1 + n) % n];
      const curr = out[i];
      const after = out[(i + 1) % n];

      const keepForShared = sharedPointKeys.has(pointKey(curr));
      if (!keepForShared && isCollinear(prev, curr, after)) {
        changed = true;
        continue;
      }
      next.push(curr);
    }
    out = next;
  }

  return out;
}

function edgeAxis(p0, p1, epsilon = 1e-6) {
  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);
  if (dx <= epsilon && dy <= epsilon) return null;
  if (dy <= epsilon) return 'h';
  if (dx <= epsilon) return 'v';
  return 'o';
}

function normalizePolygonEntriesForSharedWalls(entries) {
  const allVertices = [];
  for (const polygon of entries.values()) {
    polygon.forEach(point => allVertices.push(point));
  }

  const splitMap = new Map();
  for (const [zoneId, polygon] of entries.entries()) {
    splitMap.set(zoneId, splitPolygonBySharedVertices(polygon, allVertices));
  }

  const zoneIdsByPointKey = new Map();
  const axesByPointKey = new Map();
  for (const [zoneId, polygon] of splitMap.entries()) {
    const seen = new Set();
    for (let i = 0; i < polygon.length; i++) {
      const pt = polygon[i];
      const prev = polygon[(i - 1 + polygon.length) % polygon.length];
      const next = polygon[(i + 1) % polygon.length];
      const key = pointKey(pt);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!zoneIdsByPointKey.has(key)) zoneIdsByPointKey.set(key, new Set());
      zoneIdsByPointKey.get(key).add(zoneId);

      if (!axesByPointKey.has(key)) axesByPointKey.set(key, new Set());
      const prevAxis = edgeAxis(prev, pt);
      const nextAxis = edgeAxis(pt, next);
      if (prevAxis) axesByPointKey.get(key).add(prevAxis);
      if (nextAxis) axesByPointKey.get(key).add(nextAxis);
    }
  }

  const junctionPointKeys = new Set(
    Array.from(zoneIdsByPointKey.entries())
      .filter(([key, zoneIds]) => {
        if (zoneIds.size <= 1) return false;
        const axes = axesByPointKey.get(key) || new Set();
        // Keep a collinear split only when it is an actual junction (T/cross), not a straight shared run.
        return axes.has('h') && axes.has('v');
      })
      .map(([key]) => key)
  );

  const normalized = new Map();
  for (const [zoneId, polygon] of splitMap.entries()) {
    normalized.set(zoneId, simplifyPolygonPreservingSharedVertices(polygon, junctionPointKeys));
  }

  return normalized;
}

function collectLayoutPolygonsByZoneId(demo) {
  const polygonsByZoneId = {};
  if (!demo || !Array.isArray(demo.zones)) return polygonsByZoneId;

  for (const zone of demo.zones) {
    const polygon = zone?.layout?.polygon;
    if (!isValidLayoutPolygon(polygon)) continue;
    polygonsByZoneId[zone.id] = polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) }));
  }

  return polygonsByZoneId;
}

function getPolygonIntervalsAtY(polygon, y) {
  const xs = [];
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    if (Math.abs(p0.y - p1.y) < 1e-9) continue;
    const minY = Math.min(p0.y, p1.y);
    const maxY = Math.max(p0.y, p1.y);
    if (y < minY || y >= maxY) continue;
    const t = (y - p0.y) / (p1.y - p0.y);
    xs.push(p0.x + t * (p1.x - p0.x));
  }

  xs.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const left = xs[i];
    const right = xs[i + 1];
    if (right - left > 1e-9) intervals.push([left, right]);
  }
  return intervals;
}

function getIntervalsOverlapLength(aIntervals, bIntervals) {
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < aIntervals.length && j < bIntervals.length) {
    const [a0, a1] = aIntervals[i];
    const [b0, b1] = bIntervals[j];
    const left = Math.max(a0, b0);
    const right = Math.min(a1, b1);
    if (right > left) total += right - left;
    if (a1 < b1) i += 1;
    else j += 1;
  }
  return total;
}

function polygonOverlapArea(polyA, polyB) {
  const ys = [...new Set([...polyA.map(pt => pt.y), ...polyB.map(pt => pt.y)])].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    const height = y1 - y0;
    if (height <= 1e-9) continue;
    const yMid = (y0 + y1) / 2;
    const aIntervals = getPolygonIntervalsAtY(polyA, yMid);
    const bIntervals = getPolygonIntervalsAtY(polyB, yMid);
    const widthOverlap = getIntervalsOverlapLength(aIntervals, bIntervals);
    area += widthOverlap * height;
  }
  return area;
}

function makeFloorCeilingId(existingIds, lowerZoneId) {
  let i = 1;
  while (true) {
    const id = `el_${String(lowerZoneId).replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_fc_auto_${i}`;
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
    i += 1;
  }
}

function canonicalizeInterlevelPair(demo, nodes) {
  if (!Array.isArray(nodes) || nodes.length < 2) return null;
  const zoneById = new Map((demo.zones || []).map(zone => [zone.id, zone]));
  const z0 = zoneById.get(nodes[0]);
  const z1 = zoneById.get(nodes[1]);
  if (!z0 || !z1 || z0.type === 'boundary' || z1.type === 'boundary') return null;
  const l0 = getZoneLevel(z0);
  const l1 = getZoneLevel(z1);
  if (Math.abs(l0 - l1) !== 1) return null;
  return l0 < l1 ? [z0.id, z1.id] : [z1.id, z0.id];
}

export function reconcileInterlevelElementsFromPolygons(demo, changedPolygonsByZoneId) {
  if (!demo || !Array.isArray(demo.zones) || !Array.isArray(demo.elements)) return;

  const zoneById = new Map(demo.zones.map(zone => [zone.id, zone]));
  const polygonsByZone = new Map();
  for (const zone of demo.zones) {
    if (!zone || zone.type === 'boundary') continue;
    const polygon = zone?.layout?.polygon;
    if (isValidLayoutPolygon(polygon)) {
      polygonsByZone.set(zone.id, polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) })));
    }
  }

  const changedZoneIds = Object.keys(changedPolygonsByZoneId || {});
  const affectedLevels = new Set(
    changedZoneIds
      .map(zoneId => zoneById.get(zoneId))
      .filter(zone => zone && zone.type !== 'boundary')
      .map(zone => getZoneLevel(zone))
  );

  if (affectedLevels.size === 0) {
    for (const zoneId of polygonsByZone.keys()) {
      const zone = zoneById.get(zoneId);
      affectedLevels.add(getZoneLevel(zone));
    }
  }

  const levelsToProcess = new Set();
  affectedLevels.forEach(level => {
    levelsToProcess.add(level - 1);
    levelsToProcess.add(level);
    levelsToProcess.add(level + 1);
  });

  const zonesByLevel = new Map();
  for (const [zoneId] of polygonsByZone.entries()) {
    const zone = zoneById.get(zoneId);
    const level = getZoneLevel(zone);
    if (!levelsToProcess.has(level)) continue;
    if (!zonesByLevel.has(level)) zonesByLevel.set(level, []);
    zonesByLevel.get(level).push(zoneId);
  }

  const desiredByPair = new Map();
  const overlapThreshold = 0.02;
  for (const [level, lowerZoneIds] of zonesByLevel.entries()) {
    const upperZoneIds = zonesByLevel.get(level + 1) || [];
    if (upperZoneIds.length === 0) continue;
    for (const lowerZoneId of lowerZoneIds) {
      const lowerPoly = polygonsByZone.get(lowerZoneId);
      if (!lowerPoly) continue;
      for (const upperZoneId of upperZoneIds) {
        const upperPoly = polygonsByZone.get(upperZoneId);
        if (!upperPoly) continue;
        const overlapArea = polygonOverlapArea(lowerPoly, upperPoly);
        if (!isFinite(overlapArea) || overlapArea <= overlapThreshold) continue;
        desiredByPair.set(`${lowerZoneId}|${upperZoneId}`, overlapArea);
      }
    }
  }

  const existingIds = new Set(demo.elements.map(el => el && el.id).filter(Boolean));
  const candidateElements = demo.elements.filter(element => String(element?.type || '').toLowerCase() === 'floor_ceiling');
  const existingByPair = new Map();
  const removals = new Set();

  for (const element of candidateElements) {
    const pair = canonicalizeInterlevelPair(demo, element.nodes);
    if (!pair) continue;
    const [lowerZoneId, upperZoneId] = pair;
    const lowerLevel = getZoneLevel(zoneById.get(lowerZoneId));
    if (!levelsToProcess.has(lowerLevel) && !levelsToProcess.has(lowerLevel + 1)) continue;
    const pairKey = `${lowerZoneId}|${upperZoneId}`;
    if (!existingByPair.has(pairKey)) existingByPair.set(pairKey, []);
    existingByPair.get(pairKey).push(element);
  }

  const additions = [];
  const fallbackTemplate = candidateElements.find(element => element?.build_up_template_id)?.build_up_template_id || null;
  const fallbackBuildUp = candidateElements.find(element => Array.isArray(element?.build_up))?.build_up || null;

  for (const [pairKey, area] of desiredByPair.entries()) {
    const existing = existingByPair.get(pairKey) || [];
    const [lowerZoneId, upperZoneId] = pairKey.split('|');
    const areaValue = Number(area.toFixed(3));

    if (existing.length > 0) {
      const keeper = existing[0];
      keeper.nodes = [lowerZoneId, upperZoneId];
      keeper.x = areaValue;
      keeper.y = 1;
      keeper._autoLayoutLink = true;
      for (let i = 1; i < existing.length; i++) {
        if (existing[i]?.id) removals.add(existing[i].id);
      }
      continue;
    }

    const lowerZone = zoneById.get(lowerZoneId);
    const upperZone = zoneById.get(upperZoneId);
    const newElement = {
      id: makeFloorCeilingId(existingIds, lowerZoneId),
      name: `${lowerZone?.name || lowerZoneId} - ${upperZone?.name || upperZoneId} Floor/Ceiling`,
      type: 'floor_ceiling',
      nodes: [lowerZoneId, upperZoneId],
      x: areaValue,
      y: 1,
      _autoLayoutLink: true,
    };
    if (fallbackTemplate) newElement.build_up_template_id = fallbackTemplate;
    if (!fallbackTemplate && Array.isArray(fallbackBuildUp)) newElement.build_up = JSON.parse(JSON.stringify(fallbackBuildUp));
    additions.push(newElement);
  }

  for (const [pairKey, elements] of existingByPair.entries()) {
    if (desiredByPair.has(pairKey)) continue;
    elements.forEach(element => {
      if (element?._autoLayoutLink !== true) return;
      if (element?.id) removals.add(element.id);
    });
  }

  if (additions.length > 0) demo.elements.push(...additions);
  if (removals.size > 0) {
    demo.elements = demo.elements.filter(element => !element || !removals.has(element.id));
  }
}

function edgeKeyFromPoints(p0, p1) {
  const a = `${Number(p0.x).toFixed(4)},${Number(p0.y).toFixed(4)}`;
  const b = `${Number(p1.x).toFixed(4)},${Number(p1.y).toFixed(4)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function getEdgeOrientationFromPolygon(polygon, edgeIndex) {
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const midpoint = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };

  let cx = 0;
  let cy = 0;
  for (const pt of polygon) {
    cx += pt.x;
    cy += pt.y;
  }
  cx /= polygon.length;
  cy /= polygon.length;

  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);
  if (dx >= dy) {
    return midpoint.y < cy ? 'north' : 'south';
  }
  return midpoint.x < cx ? 'west' : 'east';
}

function makeWallId(existingIds, zoneId) {
  let i = 1;
  while (true) {
    const id = `el_${String(zoneId).replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_wall_split_${i}`;
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
    i += 1;
  }
}

function cloneInheritedWall(source, newId, nodes, orientation, length, zoneName, otherName) {
  const clone = {
    id: newId,
    name: `${zoneName || nodes[0]} - ${otherName || nodes[1]} Wall (split)`,
    type: 'wall',
    nodes,
    orientation,
    x: Number(length.toFixed(3)),
    y: typeof source?.y === 'number' ? source.y : 2.4,
  };

  if (source && source.build_up_template_id) clone.build_up_template_id = source.build_up_template_id;
  if (source && Array.isArray(source.build_up)) clone.build_up = JSON.parse(JSON.stringify(source.build_up));
  if (source && source._templateEditMode) clone._templateEditMode = source._templateEditMode;

  return clone;
}

function mergeWallDetails(target, source) {
  if (!target || !source) return;

  if (source.build_up_template_id && !target.build_up_template_id && !Array.isArray(target.build_up)) {
    target.build_up_template_id = source.build_up_template_id;
  }
  if (Array.isArray(source.build_up)) {
    if (!Array.isArray(target.build_up)) target.build_up = [];
    target.build_up.push(...JSON.parse(JSON.stringify(source.build_up)));
    delete target.build_up_template_id;
  }

  if (Array.isArray(source.windows) && source.windows.length > 0) {
    if (!Array.isArray(target.windows)) target.windows = [];
    target.windows.push(...JSON.parse(JSON.stringify(source.windows)));
  }
  if (Array.isArray(source.doors) && source.doors.length > 0) {
    if (!Array.isArray(target.doors)) target.doors = [];
    target.doors.push(...JSON.parse(JSON.stringify(source.doors)));
  }
  if ((!target.name || String(target.name).trim() === '') && source.name) {
    target.name = source.name;
  }
}

function parseWallSignature(signature) {
  const idx = signature.lastIndexOf('|');
  if (idx === -1) return { otherNodeId: signature, orientation: '' };
  return {
    otherNodeId: signature.slice(0, idx),
    orientation: signature.slice(idx + 1)
  };
}

function getZoneLevel(zone) {
  return typeof zone?.level === 'number' ? zone.level : 0;
}

function getPolygonCentroidX(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  let sumX = 0;
  let count = 0;
  for (const pt of polygon) {
    const x = Number(pt?.x);
    if (!isFinite(x)) continue;
    sumX += x;
    count += 1;
  }
  if (count === 0) return null;
  return sumX / count;
}

function getZoneLabel(zoneById, zoneId) {
  return zoneById.get(zoneId)?.name || zoneId || 'Unknown';
}

function orderWallNodesForDisplay(nodes, zoneById, polygonByZoneId, boundaryIds) {
  if (!Array.isArray(nodes) || nodes.length < 2) return Array.isArray(nodes) ? nodes.slice(0, 2) : [];

  const leftId = nodes[0];
  const rightId = nodes[1];
  const leftIsBoundary = boundaryIds.has(leftId);
  const rightIsBoundary = boundaryIds.has(rightId);

  if (leftIsBoundary && !rightIsBoundary) return [rightId, leftId];
  if (!leftIsBoundary && rightIsBoundary) return [leftId, rightId];

  const leftX = getPolygonCentroidX(polygonByZoneId.get(leftId));
  const rightX = getPolygonCentroidX(polygonByZoneId.get(rightId));

  if (isFinite(leftX) && isFinite(rightX) && Math.abs(leftX - rightX) > 1e-6) {
    return leftX <= rightX ? [leftId, rightId] : [rightId, leftId];
  }

  const leftName = String(getZoneLabel(zoneById, leftId));
  const rightName = String(getZoneLabel(zoneById, rightId));
  return leftName.localeCompare(rightName) <= 0 ? [leftId, rightId] : [rightId, leftId];
}

function buildDynamicWallName(nodes, zoneById, polygonByZoneId, boundaryIds) {
  const ordered = orderWallNodesForDisplay(nodes, zoneById, polygonByZoneId, boundaryIds);
  if (ordered.length < 2) return 'Wall';
  const leftName = getZoneLabel(zoneById, ordered[0]);
  const rightName = getZoneLabel(zoneById, ordered[1]);
  return `${leftName} - ${rightName} Wall`;
}

function getOppositeOrientation(orientation) {
  const normalized = String(orientation || '').toLowerCase();
  if (normalized === 'north') return 'south';
  if (normalized === 'south') return 'north';
  if (normalized === 'east') return 'west';
  if (normalized === 'west') return 'east';
  return normalized;
}

function canonicalizeWallRecord(nodes, orientation, boundaryIds) {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return {
      nodes: Array.isArray(nodes) ? nodes.slice(0, 2) : [],
      orientation: String(orientation || '').toLowerCase()
    };
  }

  const left = nodes[0];
  const right = nodes[1];
  const leftIsBoundary = boundaryIds.has(left);
  const rightIsBoundary = boundaryIds.has(right);
  const normalizedOrientation = String(orientation || '').toLowerCase();

  if (leftIsBoundary && !rightIsBoundary) {
    return {
      nodes: [right, left],
      orientation: getOppositeOrientation(normalizedOrientation)
    };
  }

  if (!leftIsBoundary && !rightIsBoundary && String(left).localeCompare(String(right)) > 0) {
    return {
      nodes: [right, left],
      orientation: getOppositeOrientation(normalizedOrientation)
    };
  }

  return {
    nodes: [left, right],
    orientation: normalizedOrientation
  };
}

function applyDynamicNamesToWalls(demo, zoneById, polygonByZoneId, boundaryIds) {
  if (!Array.isArray(demo?.elements)) return;
  for (const element of demo.elements) {
    if (!element || String(element.type || '').toLowerCase() !== 'wall') continue;
    if (!Array.isArray(element.nodes) || element.nodes.length < 2) continue;
    element.name = buildDynamicWallName(element.nodes, zoneById, polygonByZoneId, boundaryIds);
  }
}

export function reconcileWallElementsFromPolygons(demo, changedPolygonsByZoneId) {
  if (!demo || !Array.isArray(demo.zones) || !Array.isArray(demo.elements) || !changedPolygonsByZoneId) return;

  const zones = demo.zones;
  const zoneById = new Map(zones.map(z => [z.id, z]));
  const polygonByZoneId = new Map();

  const boundaryOutside = zones.find(z => z && z.type === 'boundary' && String(z.name || '').toLowerCase() === 'outside')
    || zones.find(z => z && z.type === 'boundary');
  const outsideId = boundaryOutside ? boundaryOutside.id : null;
  const boundaryIds = new Set(zones.filter(z => z?.type === 'boundary').map(z => z.id));

  const existingIds = new Set(demo.elements.map(el => el && el.id).filter(Boolean));
  const additions = [];
  const removals = new Set();
  const changedZoneIds = Object.keys(changedPolygonsByZoneId || {});
  const affectedLevels = new Set(
    changedZoneIds
      .map(zoneId => zoneById.get(zoneId))
      .filter(zone => zone && zone.type !== 'boundary')
      .map(zone => (typeof zone.level === 'number' ? zone.level : 0))
  );
  const zonesToReconcile = zones
    .filter(zone => zone && zone.type !== 'boundary')
    .filter(zone => affectedLevels.has(typeof zone.level === 'number' ? zone.level : 0))
    .map(zone => zone.id);

  const normalizedPolygonsByZoneId = new Map();
  for (const level of affectedLevels) {
    const levelEntries = new Map();
    zones
      .filter(zone => zone && zone.type !== 'boundary' && getZoneLevel(zone) === level)
      .forEach(zone => {
        const polygon = zone?.layout?.polygon;
        if (isValidLayoutPolygon(polygon)) {
          levelEntries.set(zone.id, polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) })));
        }
      });

    const normalizedLevelEntries = normalizePolygonEntriesForSharedWalls(levelEntries);
    for (const [zoneId, polygon] of normalizedLevelEntries.entries()) {
      normalizedPolygonsByZoneId.set(zoneId, polygon);
      const zone = zoneById.get(zoneId);
      if (zone) {
        zone.layout = zone.layout || {};
        zone.layout.polygon = polygon.map(pt => ({ x: pt.x, y: pt.y }));
      }
    }
  }

  zones.forEach(zone => {
    if (normalizedPolygonsByZoneId.has(zone.id)) {
      polygonByZoneId.set(zone.id, normalizedPolygonsByZoneId.get(zone.id));
      return;
    }
    const polygon = zone?.layout?.polygon;
    if (isValidLayoutPolygon(polygon)) polygonByZoneId.set(zone.id, polygon);
  });

  const affectedZoneIdSet = new Set(zonesToReconcile);
  const edgeRefs = new Map();
  for (const [zoneId, polygon] of polygonByZoneId.entries()) {
    const zone = zoneById.get(zoneId);
    const level = getZoneLevel(zone);
    if (!affectedLevels.has(level)) continue;
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const key = `${level}::${edgeKeyFromPoints(p0, p1)}`;
      if (!edgeRefs.has(key)) edgeRefs.set(key, []);
      edgeRefs.get(key).push({ zoneId, edgeIndex: i, level });
    }
  }

  const desiredBySignature = new Map();
  for (const refs of edgeRefs.values()) {
    if (!Array.isArray(refs) || refs.length === 0) continue;
    const relevantRefs = refs.filter(ref => affectedZoneIdSet.has(ref.zoneId));
    if (relevantRefs.length === 0) continue;

    const sortedRefs = refs.slice().sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId)));
    const primaryRef = sortedRefs[0];
    const primaryPolygon = polygonByZoneId.get(primaryRef.zoneId);
    const primaryZone = zoneById.get(primaryRef.zoneId);
    if (!primaryPolygon || !primaryZone) continue;

    const p0 = primaryPolygon[primaryRef.edgeIndex];
    const p1 = primaryPolygon[(primaryRef.edgeIndex + 1) % primaryPolygon.length];
    const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (!isFinite(length) || length <= 0.05) continue;

    const adjacentZoneId = sortedRefs[1]?.zoneId || outsideId;
    if (!adjacentZoneId) continue;

    const canonical = canonicalizeWallRecord([primaryRef.zoneId, adjacentZoneId], getEdgeOrientationFromPolygon(primaryPolygon, primaryRef.edgeIndex), boundaryIds);
    const signature = `${canonical.nodes[0]}|${canonical.nodes[1]}|${canonical.orientation}`;
    if (!desiredBySignature.has(signature)) desiredBySignature.set(signature, []);
    desiredBySignature.get(signature).push({
      nodes: canonical.nodes,
      orientation: canonical.orientation,
      length,
      zoneName: zoneById.get(canonical.nodes[0])?.name,
      otherName: zoneById.get(canonical.nodes[1])?.name,
    });
  }

  const existingWalls = demo.elements.filter(el => {
    return el
      && String(el.type || '').toLowerCase() === 'wall'
      && Array.isArray(el.nodes)
      && el.nodes.some(nodeId => affectedZoneIdSet.has(nodeId));
  });

  const existingBySignature = new Map();
  for (const wall of existingWalls) {
    const canonical = canonicalizeWallRecord(wall.nodes, wall.orientation, boundaryIds);
    if (!Array.isArray(canonical.nodes) || canonical.nodes.length < 2) {
      if (wall?.id) removals.add(wall.id);
      continue;
    }
    const signature = `${canonical.nodes[0]}|${canonical.nodes[1]}|${canonical.orientation}`;
    if (!existingBySignature.has(signature)) existingBySignature.set(signature, []);
    existingBySignature.get(signature).push(wall);
  }

  for (const [signature, desiredSegments] of desiredBySignature.entries()) {
    const existingForSignature = existingBySignature.get(signature) || [];
    const [zoneId, otherNodeId, orientation] = signature.split('|');

    for (let i = 0; i < Math.min(existingForSignature.length, desiredSegments.length); i++) {
      existingForSignature[i].nodes = [zoneId, otherNodeId];
      existingForSignature[i].orientation = orientation;
      existingForSignature[i].x = Number(desiredSegments[i].length.toFixed(3));
    }

    if (desiredSegments.length < existingForSignature.length) {
      const keeperCount = Math.max(1, desiredSegments.length);
      for (let i = keeperCount; i < existingForSignature.length; i++) {
        const wallToRemove = existingForSignature[i];
        const keeper = existingForSignature[keeperCount - 1] || existingForSignature[0];
        if (keeper && wallToRemove && keeper !== wallToRemove) {
          mergeWallDetails(keeper, wallToRemove);
        }
        if (wallToRemove?.id) removals.add(wallToRemove.id);
      }
    }

    if (desiredSegments.length > existingForSignature.length) {
      const desired = desiredSegments[0];
      const inheritSource = existingForSignature[0]
        || existingWalls.find(wall => {
          const canonical = canonicalizeWallRecord(wall.nodes, wall.orientation, boundaryIds);
          return canonical.nodes[0] === zoneId || canonical.nodes[1] === zoneId;
        })
        || null;

      for (let i = existingForSignature.length; i < desiredSegments.length; i++) {
        const seg = desiredSegments[i];
        const newId = makeWallId(existingIds, zoneId);
        additions.push(cloneInheritedWall(
          inheritSource,
          newId,
          [zoneId, otherNodeId],
          orientation,
          seg.length,
          desired.zoneName,
          desired.otherName
        ));
      }
    }
  }

  for (const [signature, staleWalls] of existingBySignature.entries()) {
    if (desiredBySignature.has(signature) || staleWalls.length === 0) continue;
    const keeper = demo.elements.find(el => {
      if (!el || removals.has(el.id)) return false;
      if (String(el.type || '').toLowerCase() !== 'wall') return false;
      const canonical = canonicalizeWallRecord(el.nodes, el.orientation, boundaryIds);
      const existingSignature = `${canonical.nodes[0]}|${canonical.nodes[1]}|${canonical.orientation}`;
      return existingSignature === signature && !staleWalls.includes(el);
    });

    staleWalls.forEach(staleWall => {
      if (!staleWall?.id) return;
      if (keeper && keeper !== staleWall) {
        mergeWallDetails(keeper, staleWall);
      }
      removals.add(staleWall.id);
    });
  }

  if (additions.length > 0) {
    demo.elements.push(...additions);
  }
  if (removals.size > 0) {
    demo.elements = demo.elements.filter(el => !el || !removals.has(el.id));
  }

  applyDynamicNamesToWalls(demo, zoneById, polygonByZoneId, boundaryIds);
}

// Load and initialize on page load
if (typeof window !== 'undefined') window.addEventListener('load', async () => {
  window.addEventListener('keydown', handleGlobalShortcut);

  appUiApi = initAppUi({
    onSolveRequested: triggerSolve,
    onUploadDemo: (uploadedDemo) => {
      currentDemo = uploadedDemo;
      ensureVariantStateFromDemo(currentDemo);
      clearHistory();
      triggerSolve();
    }
  });

  appUiApi.setStatus('Initializing...');
  try {
    const [ins, demo, rads, openings, ventilation] = await loadDefaultInputs();
    console.log('Loaded data:', { ins: !!ins, demo: !!demo, rads: !!rads, openings: !!openings, ventilation: !!ventilation });
    currentMaterials = ins;
    currentRadiators = rads;
    currentDemo = demo;
    currentOpenings = openings;
    currentVentilation = ventilation;
    defaultDemoTemplate = deepClone(demo);
    ensureVariantStateFromDemo(currentDemo);

    roomEditorApi = initRoomEditor({
      getDemo: () => currentDemo,
      getRadiatorsData: () => currentRadiators,
      getMaterialsData: () => currentMaterials,
      getOpeningsData: () => currentOpenings,
      getVentilationData: () => currentVentilation,
      onDataChanged: triggerSolve,
    });
    
    triggerSolve();
  } catch (error) {
    if (appUiApi) appUiApi.setStatus('Initialization error: ' + String(error));
    console.error('Initialization failed:', error);
  }
});
