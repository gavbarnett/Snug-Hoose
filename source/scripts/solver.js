// Client-side solver orchestrator (ES module). Imports modular calculators and manages UI.

import { computeElementU } from './u_value_calculator.js';
import { computeRoomHeatRequirements } from './heat_calculator.js';
import { renderThermalViz } from './visualizer.js';
import { renderAlternativeViz } from './alt_viz.js';
import { initRoomEditor } from './room_editor.js';
import { initAppUi } from './app_ui.js';

let currentMaterials = null;
let currentRadiators = null;
let currentDemo = null;
let currentOpenings = null;
let roomEditorApi = null;
let appUiApi = null;

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
        { id: 'window_single', name: 'Single Glazing', u_value: 5.7 },
        { id: 'window_double_modern', name: 'Double Glazing (Modern)', u_value: 1.6 }
      ],
      doors: [
        { id: 'door_wood_solid', name: 'Solid Wood Door', u_value: 2.8 },
        { id: 'door_pvc_insulated', name: 'PVC Insulated Door', u_value: 1.8 }
      ]
    };
  }
  
  return [ins, demo, rads, openings];
}

function getOpeningMaterials(openings) {
  if (!openings) return [];
  const windows = Array.isArray(openings.windows) ? openings.windows : [];
  const doors = Array.isArray(openings.doors) ? openings.doors : [];
  const asMaterial = (item) => ({
    id: item.id,
    name: item.name,
    u_value: item.u_value
  });
  return [...windows.map(asMaterial), ...doors.map(asMaterial)];
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
    const indoorTemp = inputTemps && typeof inputTemps.indoorTemp === 'number' && isFinite(inputTemps.indoorTemp) ? inputTemps.indoorTemp : 21;
    const externalTemp = inputTemps && typeof inputTemps.externalTemp === 'number' && isFinite(inputTemps.externalTemp) ? inputTemps.externalTemp : 3;
    const flowTemp = inputTemps && typeof inputTemps.flowTemp === 'number' && isFinite(inputTemps.flowTemp) ? inputTemps.flowTemp : 55;

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

    // Generate thermal visualization
    renderThermalViz(demoRaw, radiators);
    renderAlternativeViz(demoRaw, {
      onZoneSelected: (zoneId) => {
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
        }
      },
      onWallSelected: (zoneId, elementId) => {
        if (roomEditorApi && typeof roomEditorApi.focusElement === 'function') {
          roomEditorApi.focusElement(zoneId, elementId);
          return;
        }
        if (roomEditorApi && typeof roomEditorApi.focusZone === 'function') {
          roomEditorApi.focusZone(zoneId);
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
    solveAndRender(JSON.parse(JSON.stringify(currentDemo)));
  }
}

function isValidLayoutPolygon(polygon) {
  return Array.isArray(polygon) && polygon.length >= 3 && polygon.every(pt => pt && isFinite(pt.x) && isFinite(pt.y));
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

function reconcileWallElementsFromPolygons(demo, changedPolygonsByZoneId) {
  if (!demo || !Array.isArray(demo.zones) || !Array.isArray(demo.elements) || !changedPolygonsByZoneId) return;

  const zones = demo.zones;
  const zoneById = new Map(zones.map(z => [z.id, z]));
  const polygonByZoneId = new Map();
  zones.forEach(zone => {
    const polygon = zone?.layout?.polygon;
    if (isValidLayoutPolygon(polygon)) polygonByZoneId.set(zone.id, polygon);
  });

  const edgeRefs = new Map();
  for (const [zoneId, polygon] of polygonByZoneId.entries()) {
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const key = edgeKeyFromPoints(p0, p1);
      if (!edgeRefs.has(key)) edgeRefs.set(key, []);
      edgeRefs.get(key).push({ zoneId, edgeIndex: i });
    }
  }

  const boundaryOutside = zones.find(z => z && z.type === 'boundary' && String(z.name || '').toLowerCase() === 'outside')
    || zones.find(z => z && z.type === 'boundary');
  const outsideId = boundaryOutside ? boundaryOutside.id : null;

  const existingIds = new Set(demo.elements.map(el => el && el.id).filter(Boolean));
  const additions = [];
  const changedZoneIds = Object.keys(changedPolygonsByZoneId || {});

  for (const zoneId of changedZoneIds) {
    const polygon = polygonByZoneId.get(zoneId);
    if (!polygon) continue;

    const zone = zoneById.get(zoneId);
    const zoneWalls = demo.elements.filter(el => {
      return el && String(el.type || '').toLowerCase() === 'wall' && Array.isArray(el.nodes) && el.nodes.includes(zoneId);
    });

    const desiredBySignature = new Map();
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const refs = edgeRefs.get(edgeKeyFromPoints(p0, p1)) || [];
      const adjacentZoneId = refs.find(ref => ref.zoneId !== zoneId)?.zoneId || null;
      const otherNodeId = adjacentZoneId || outsideId;
      if (!otherNodeId) continue;

      const orientation = getEdgeOrientationFromPolygon(polygon, i);
      const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (!isFinite(length) || length <= 0.05) continue;

      const signature = `${otherNodeId}|${orientation}`;
      if (!desiredBySignature.has(signature)) desiredBySignature.set(signature, []);
      desiredBySignature.get(signature).push({ otherNodeId, orientation, length });
    }

    const existingBySignature = new Map();
    for (const wall of zoneWalls) {
      const otherNodeId = wall.nodes.find(id => id !== zoneId);
      const orientation = String(wall.orientation || '').toLowerCase();
      const signature = `${otherNodeId}|${orientation}`;
      if (!existingBySignature.has(signature)) existingBySignature.set(signature, []);
      existingBySignature.get(signature).push(wall);
    }

    for (const [signature, desiredSegments] of desiredBySignature.entries()) {
      const existingWalls = existingBySignature.get(signature) || [];
      const [otherNodeId, orientation] = signature.split('|');

      for (let i = 0; i < Math.min(existingWalls.length, desiredSegments.length); i++) {
        existingWalls[i].x = Number(desiredSegments[i].length.toFixed(3));
      }

      if (desiredSegments.length > existingWalls.length) {
        const inheritSource = existingWalls[0]
          || zoneWalls.find(w => {
            const other = Array.isArray(w.nodes) ? w.nodes.find(id => id !== zoneId) : null;
            return other === otherNodeId;
          })
          || zoneWalls[0]
          || null;

        for (let i = existingWalls.length; i < desiredSegments.length; i++) {
          const seg = desiredSegments[i];
          const newId = makeWallId(existingIds, zoneId);
          const otherZone = zoneById.get(seg.otherNodeId);
          additions.push(cloneInheritedWall(
            inheritSource,
            newId,
            [zoneId, seg.otherNodeId],
            orientation,
            seg.length,
            zone?.name,
            otherZone?.name
          ));
        }
      }
    }
  }

  if (additions.length > 0) {
    demo.elements.push(...additions);
  }
}

function initVizTabs() {
  const heatMapTab = document.getElementById('heatMapTab');
  const altVizTab = document.getElementById('altVizTab');
  const heatMapPanel = document.getElementById('heatMapPanel');
  const altVizPanel = document.getElementById('altVizPanel');

  if (!heatMapTab || !altVizTab || !heatMapPanel || !altVizPanel) return;

  const showPanel = (panelName) => {
    const showHeatMap = panelName === 'heat';

    heatMapTab.classList.toggle('active', showHeatMap);
    altVizTab.classList.toggle('active', !showHeatMap);
    heatMapPanel.classList.toggle('active', showHeatMap);
    altVizPanel.classList.toggle('active', !showHeatMap);
  };

  heatMapTab.addEventListener('click', () => showPanel('heat'));
  altVizTab.addEventListener('click', () => showPanel('alt'));
}

// Load and initialize on page load
window.addEventListener('load', async () => {
  initVizTabs();

  appUiApi = initAppUi({
    onSolveRequested: triggerSolve,
    onUploadDemo: (uploadedDemo) => {
      currentDemo = uploadedDemo;
      triggerSolve();
    }
  });

  appUiApi.setStatus('Initializing...');
  try {
    const [ins, demo, rads, openings] = await loadDefaultInputs();
    console.log('Loaded data:', { ins: !!ins, demo: !!demo, rads: !!rads, openings: !!openings });
    currentMaterials = ins;
    currentRadiators = rads;
    currentDemo = demo;
    currentOpenings = openings;

    roomEditorApi = initRoomEditor({
      getDemo: () => currentDemo,
      getRadiatorsData: () => currentRadiators,
      getMaterialsData: () => currentMaterials,
      getOpeningsData: () => currentOpenings,
      onDataChanged: triggerSolve,
      onAddRoom: () => {
        alert('Add room (not implemented yet)');
      }
    });
    
    triggerSolve();
  } catch (error) {
    if (appUiApi) appUiApi.setStatus('Initialization error: ' + String(error));
    console.error('Initialization failed:', error);
  }
});
