// Client-side solver orchestrator (ES module). Imports modular calculators and manages UI.

import { computeElementU } from './u_value_calculator.js';
import { computeRoomHeatRequirements } from './heat_calculator.js';
import { renderAlternativeViz } from './alt_viz.js';
import { initRoomEditor } from './room_editor.js';
import { initAppUi } from './app_ui.js';
import {
  getRecommendationCostModel as resolveRecommendationCostModel,
  buildPerformanceRecommendations as buildPerformanceRecommendationsCore,
  applyRecommendationById as applyRecommendationByIdCore
} from './recommendations.js';
import {
  estimateBoilerCopFromFlowTemp,
  estimateHeatPumpCopFromFlowTemp
} from './heating_performance.js';

let currentMaterials = null;
let currentRadiators = null;
let currentDemo = null;
let currentOpenings = null;
let currentVentilation = null;
let currentCosts = null;
let roomEditorApi = null;
let appUiApi = null;
let defaultDemoTemplate = null;
let lastFocusedZoneId = null;
let undoStack = [];
let redoStack = [];
let isApplyingHistory = false;
let variantState = null;
let scheduledSolveHandle = null;
let isSolveRunning = false;
let solveRequestedWhileRunning = false;
let latestSolveRevision = 0;
let latestRenderedVizDemo = null;
let latestRenderedVariantMenuState = null;
let latestRenderedRecommendations = [];
let recommendationsRefreshHandle = null;
let recommendationApplyInProgress = false;
let recommendationApplyText = '';
let recommendationApplyId = '';
let recommendationsEnabled = true;

const MAX_HISTORY_STEPS = 100;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scheduleAnimationFrame(callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 0);
}

function scheduleLowPriority(callback) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, { timeout: 250 });
  }
  return window.setTimeout(callback, 50);
}

function cancelLowPriority(handle) {
  if (handle === null || handle === undefined) return;
  if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

function renderCurrentAlternativeViz(demoPayload, variantMenuState, recommendations, recommendationsPending) {
  latestRenderedVizDemo = demoPayload;
  latestRenderedVariantMenuState = variantMenuState;
  latestRenderedRecommendations = Array.isArray(recommendations) ? recommendations : [];

  renderAlternativeViz({
    ...demoPayload,
    openings: currentOpenings,
    radiators: currentRadiators,
    ventilation: currentVentilation,
    variant_state: variantMenuState,
    recommendations: latestRenderedRecommendations,
    recommendationsPending: recommendationsPending === true,
    recommendationApplyPending: recommendationApplyInProgress,
    recommendationApplyText: recommendationApplyText,
    recommendationApplyId: recommendationApplyId,
    recommendationsEnabled: recommendationsEnabled
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
    onZoneEditorRequested: (zoneId) => {
      lastFocusedZoneId = zoneId;
      if (roomEditorApi && typeof roomEditorApi.openZoneEditor === 'function') {
        roomEditorApi.openZoneEditor(zoneId);
        return;
      }
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
    onOpeningSelected: (zoneId, openingId) => {
      lastFocusedZoneId = zoneId;
      if (roomEditorApi && typeof roomEditorApi.focusOpening === 'function') {
        roomEditorApi.focusOpening(zoneId, openingId);
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
}

function scheduleRecommendationsRefresh(demoForRecommendations, solveRevision) {
  if (!recommendationsEnabled) {
    if (!latestRenderedVizDemo || !latestRenderedVariantMenuState) return;
    recommendationApplyInProgress = false;
    recommendationApplyText = '';
    recommendationApplyId = '';
    latestRenderedRecommendations = [];
    renderCurrentAlternativeViz(
      latestRenderedVizDemo,
      latestRenderedVariantMenuState,
      [],
      false
    );
    return;
  }
  cancelLowPriority(recommendationsRefreshHandle);
  recommendationsRefreshHandle = scheduleLowPriority(() => {
    recommendationsRefreshHandle = null;
    const recommendations = buildPerformanceRecommendations(demoForRecommendations);
    const applicableRecommendations = (Array.isArray(recommendations) ? recommendations : [])
      .filter(item => {
        const recommendationId = String(item?.recommendationId || '');
        if (!recommendationId) return false;
        const demoClone = deepClone(demoForRecommendations);
        return applyRecommendationById(demoClone, recommendationId) === true;
      });
    if (solveRevision !== latestSolveRevision) return;
    if (!latestRenderedVizDemo || !latestRenderedVariantMenuState) return;
    recommendationApplyInProgress = false;
    recommendationApplyText = '';
    recommendationApplyId = '';
    renderCurrentAlternativeViz(
      latestRenderedVizDemo,
      latestRenderedVariantMenuState,
      applicableRecommendations,
      false
    );
  });
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
  const externalTemp = getSystemMinOutsideTemp(working?.meta);
  const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
  const heat = computeRoomHeatRequirements(working, radiators, { indoorTemp, externalTemp, flowTemp });
  const annualModel = computeSeasonalAnnualEnergyModel(working, radiators, getRecommendationCostModel());
  const annualDemand = Number(annualModel.annualHeatDemandKwhYr || 0);
  const effectiveFlowTempForCop = Number.isFinite(heat.effectiveFlowTemp) ? heat.effectiveFlowTemp : flowTemp;
  const heatingInputs = getNormalizedHeatingInputs(working?.meta, effectiveFlowTempForCop, getRecommendationCostModel());
  const runningCost = {
    annualInputEnergyKwh: annualModel.annualInputEnergyKwhYr,
    annualCost: annualModel.annualRunningCost,
    effectiveSystemEfficiency: annualModel.annualAverageCop,
    effectiveScop: annualModel.annualAverageCop
  };
  const roomCount = Array.isArray(heat.rooms) ? heat.rooms.length : 0;
  const unmetSetpointRoomCount = (Array.isArray(heat.rooms) ? heat.rooms : []).filter(room => room && room.can_reach_setpoint === false).length;

  const totalFloorArea = (Array.isArray(heat.rooms) ? heat.rooms : [])
    .filter(r => !r.is_unheated)
    .reduce((sum, r) => {
      const area = Number(r.floorArea);
      return sum + (isFinite(area) && area > 0 ? area : 0);
    }, 0);
  const annualInputEnergy = Number(runningCost.annualInputEnergyKwh || 0);
  const intensityKwhM2Yr = totalFloorArea > 0 ? (annualInputEnergy / totalFloorArea) : null;

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
    annualDemandKwhYr: annualDemand,
    annualRunningCost: runningCost.annualCost,
    annualInputEnergyKwhYr: annualInputEnergy,
    heatSourceType: heatingInputs.heatSourceType,
    heatSourceLabel: heatingInputs.heatSourceLabel,
    effectiveSystemEfficiency: runningCost.effectiveSystemEfficiency,
    effectiveScop: runningCost.effectiveScop,
    unmetSetpointRoomCount
  };
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!isFinite(numeric)) return min;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

function getHeatingCostDefaults(costModel) {
  const heating = costModel && typeof costModel === 'object' && costModel.heating && typeof costModel.heating === 'object'
    ? costModel.heating
    : {};
  const resolveDefault = (value, fallback, min, max) => {
    if (!Number.isFinite(Number(value))) return fallback;
    return clampNumber(value, min, max);
  };
  return {
    gasRate: resolveDefault(heating.gas_rate_per_kwh, 0.07, 0.01, 2),
    electricRate: resolveDefault(heating.electric_rate_per_kwh, 0.24, 0.01, 2),
    gasBoilerEfficiency: resolveDefault(heating.gas_boiler_efficiency, 0.9, 0.6, 0.99),
    heatPumpScop: resolveDefault(heating.heat_pump_scop, 3.2, 1.8, 6)
  };
}

function getSystemMinOutsideTemp(meta) {
  if (Number.isFinite(Number(meta?.systemMinExternalTemp))) {
    return Number(meta.systemMinExternalTemp);
  }
  if (Number.isFinite(Number(meta?.externalTemp))) {
    return Number(meta.externalTemp);
  }
  return 3;
}

function getSeasonalOutsideTempBounds(meta) {
  const systemMin = getSystemMinOutsideTemp(meta);
  const seasonalMinRaw = Number(meta?.seasonalMinExternalTemp);
  const seasonalMaxRaw = Number(meta?.seasonalMaxExternalTemp);
  const seasonalMin = Number.isFinite(seasonalMinRaw) ? seasonalMinRaw : systemMin;
  const seasonalMax = Number.isFinite(seasonalMaxRaw) ? seasonalMaxRaw : 16;
  return {
    seasonalMin: Math.min(seasonalMin, seasonalMax),
    seasonalMax: Math.max(seasonalMin, seasonalMax)
  };
}

function getSeasonalOutsideTempForMonth(monthIndex, seasonalMin, seasonalMax) {
  const offset = (seasonalMin + seasonalMax) / 2;
  const amplitude = (seasonalMax - seasonalMin);
  const monthNumber = monthIndex + 1;
  const phase = ((2 * Math.PI) / 12) * monthNumber;
  return offset + (amplitude * Math.sin(phase));
}

export function computeSeasonalAnnualEnergyModel(demo, radiators, costModel) {
  const indoorTemp = Number.isFinite(Number(demo?.meta?.indoorTemp)) ? Number(demo.meta.indoorTemp) : 21;
  const maxFlowTemp = Number.isFinite(Number(demo?.meta?.flowTemp)) ? Number(demo.meta.flowTemp) : 55;
  const { seasonalMin, seasonalMax } = getSeasonalOutsideTempBounds(demo?.meta);
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthlyPointCache = new Map();

  let annualHeatDemandKwhYr = 0;
  let annualInputEnergyKwhYr = 0;
  let annualRunningCost = 0;

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const externalTemp = getSeasonalOutsideTempForMonth(monthIndex, seasonalMin, seasonalMax);
    const monthHours = monthDays[monthIndex] * 24;
    const monthKey = externalTemp.toFixed(6);
    let monthPoint = monthlyPointCache.get(monthKey);
    if (!monthPoint) {
      const heat = computeRoomHeatRequirements(demo, radiators, {
        indoorTemp,
        externalTemp,
        flowTemp: maxFlowTemp
      });
      const deliveredHeatW = Math.max(0, Number(heat?.total_delivered_heat || 0));
      const effectiveFlowTemp = Number.isFinite(Number(heat?.effectiveFlowTemp))
        ? Number(heat.effectiveFlowTemp)
        : maxFlowTemp;
      const heatingInputs = getNormalizedHeatingInputs(demo?.meta, effectiveFlowTemp, costModel);
      const perHourCostModel = computeAnnualRunningCostFromDemand(deliveredHeatW / 1000, heatingInputs);
      monthPoint = {
        demandKwhPerHour: deliveredHeatW / 1000,
        inputKwhPerHour: Number(perHourCostModel?.annualInputEnergyKwh || 0),
        runningCostPerHour: Number(perHourCostModel?.annualCost || 0)
      };
      monthlyPointCache.set(monthKey, monthPoint);
    }

    annualHeatDemandKwhYr += monthPoint.demandKwhPerHour * monthHours;
    annualInputEnergyKwhYr += monthPoint.inputKwhPerHour * monthHours;
    annualRunningCost += monthPoint.runningCostPerHour * monthHours;
  }

  const annualAverageCop = annualInputEnergyKwhYr > 0
    ? (annualHeatDemandKwhYr / annualInputEnergyKwhYr)
    : null;

  return {
    annualHeatDemandKwhYr,
    annualInputEnergyKwhYr,
    annualRunningCost,
    annualAverageCop,
    seasonalMin,
    seasonalMax
  };
}

function getNormalizedHeatingInputs(meta, flowTemp, costModel) {
  const defaults = getHeatingCostDefaults(costModel);
  const sourceRaw = String(meta?.heatSourceType || '').trim().toLowerCase();
  const heatSourceType = sourceRaw === 'heat_pump' || sourceRaw === 'direct_electric' || sourceRaw === 'gas_boiler'
    ? sourceRaw
    : 'gas_boiler';

  const gasRate = clampNumber(meta?.gasUnitRate, 0.01, 2);
  const electricRate = clampNumber(meta?.electricUnitRate, 0.01, 2);
  const gasBoilerEfficiency = clampNumber(meta?.gasBoilerEfficiency, 0.6, 0.99);

  // Unified COP mode: new copMode field; fallback to legacy heatPumpScopMode for HP saves
  const legacyScopModeRaw = String(meta?.heatPumpScopMode || '').trim().toLowerCase();
  const unifiedCopModeRaw = String(meta?.copMode || '').trim().toLowerCase();
  const resolvedCopModeRaw = unifiedCopModeRaw === 'fixed' || unifiedCopModeRaw === 'auto'
    ? unifiedCopModeRaw
    : legacyScopModeRaw;
  const copMode = resolvedCopModeRaw === 'fixed' ? 'fixed' : 'auto';

  const autoScop = estimateHeatPumpCopFromFlowTemp(flowTemp);
  const boilerAutoCop = estimateBoilerCopFromFlowTemp(flowTemp, gasBoilerEfficiency);

  const effectiveGasRate = Number.isFinite(Number(meta?.gasUnitRate)) ? gasRate : defaults.gasRate;
  const effectiveElectricRate = Number.isFinite(Number(meta?.electricUnitRate)) ? electricRate : defaults.electricRate;
  const effectiveBoilerCopAt55C = Number.isFinite(Number(meta?.gasBoilerEfficiency)) ? gasBoilerEfficiency : defaults.gasBoilerEfficiency;
  const effectiveBoilerCop = estimateBoilerCopFromFlowTemp(flowTemp, effectiveBoilerCopAt55C);

  // Unified fixed COP value: new copFixedValue field first; fallback to legacy HP field
  const legacyFixedScop = Number.isFinite(Number(meta?.heatPumpFixedScop))
    ? clampNumber(meta.heatPumpFixedScop, 1.8, 6)
    : defaults.heatPumpScop;
  const unifiedFixedCop = Number.isFinite(Number(meta?.copFixedValue)) ? Number(meta.copFixedValue) : null;
  const rawFixedCop = unifiedFixedCop ?? (heatSourceType === 'heat_pump' ? legacyFixedScop : null);

  // Clamp fixed COP to source-appropriate range
  const clampedFixedCop = heatSourceType === 'heat_pump'
    ? clampNumber(rawFixedCop, 1.8, 6)
    : (heatSourceType === 'gas_boiler' ? clampNumber(rawFixedCop, 0.6, 0.99) : 1);

  // Auto COP per source
  const autoSystemCop = heatSourceType === 'heat_pump'
    ? autoScop
    : (heatSourceType === 'gas_boiler' ? effectiveBoilerCop : 1);

  const effectiveSystemCop = heatSourceType === 'direct_electric'
    ? 1
    : (copMode === 'fixed' && rawFixedCop != null ? clampedFixedCop : autoSystemCop);

  return {
    heatSourceType,
    heatSourceLabel: heatSourceType === 'heat_pump'
      ? 'Heat Pump'
      : (heatSourceType === 'direct_electric' ? 'Direct Electric' : 'Gas Boiler'),
    gasRate: effectiveGasRate,
    electricRate: effectiveElectricRate,
    gasBoilerEfficiency: effectiveBoilerCopAt55C,
    gasBoilerAutoCop: boilerAutoCop,
    copMode,
    heatPumpScopMode: copMode,       // backward compat alias
    heatPumpFixedScop: rawFixedCop != null ? clampedFixedCop : defaults.heatPumpScop,
    heatPumpAutoScop: autoScop,
    effectiveBoilerCop,
    effectiveScop: effectiveSystemCop,
    effectiveSystemCop
  };
}

function computeAnnualRunningCostFromDemand(annualHeatDemandKwhYr, heatingInputs) {
  const demand = Math.max(0, Number(annualHeatDemandKwhYr) || 0);
  const source = heatingInputs?.heatSourceType || 'gas_boiler';
  if (source === 'direct_electric') {
    const directElectricCop = 1;
    const annualInput = demand / directElectricCop;
    const annualCost = annualInput * Number(heatingInputs?.electricRate || 0);
    return {
      annualInputEnergyKwh: annualInput,
      annualCost,
      effectiveSystemEfficiency: directElectricCop,
      effectiveScop: directElectricCop
    };
  }
  if (source === 'heat_pump') {
    const scop = clampNumber(heatingInputs?.effectiveScop, 1.8, 6);
    const annualInput = demand / scop;
    const annualCost = annualInput * Number(heatingInputs?.electricRate || 0);
    return {
      annualInputEnergyKwh: annualInput,
      annualCost,
      effectiveSystemEfficiency: scop,
      effectiveScop: scop
    };
  }
  const gasCop = clampNumber(heatingInputs?.effectiveScop, 0.6, 0.99);
  const annualInput = demand / gasCop;
  const annualCost = annualInput * Number(heatingInputs?.gasRate || 0);
  return {
    annualInputEnergyKwh: annualInput,
    annualCost,
    effectiveSystemEfficiency: gasCop,
    effectiveScop: gasCop
  };
}

function getComfortSnapshotForDemo(demoRaw) {
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
  const externalTemp = getSystemMinOutsideTemp(working?.meta);
  const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
  const heat = computeRoomHeatRequirements(working, radiators, { indoorTemp, externalTemp, flowTemp });
  const rooms = Array.isArray(heat?.rooms) ? heat.rooms : [];
  const conditionedRooms = rooms.filter(room => room && room.is_unheated !== true);

  let below18Count = 0;
  let belowTargetCount = 0;
  let unmetSetpointRoomCount = 0;
  let minDeliveredTemp = Infinity;
  const zoneTempById = {};

  conditionedRooms.forEach(room => {
    const zoneId = String(room?.zoneId || '');
    const delivered = Number(room?.delivered_indoor_temperature);
    if (zoneId && isFinite(delivered)) {
      zoneTempById[zoneId] = delivered;
    }
    if (isFinite(delivered)) {
      if (delivered < 17.95) below18Count += 1;
      const setpoint = Number(room?.setpoint_temperature);
      const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
      if (delivered < targetTemp - 0.1) belowTargetCount += 1;
      minDeliveredTemp = Math.min(minDeliveredTemp, delivered);
    }
    if (room?.can_reach_setpoint === false) {
      unmetSetpointRoomCount += 1;
    }
  });

  return {
    below18Count,
    belowTargetCount,
    unmetSetpointRoomCount,
    minDeliveredTemp: isFinite(minDeliveredTemp) ? minDeliveredTemp : null,
    zoneTempById
  };
}

function getComfortDeficitRoomsForDemo(demoRaw) {
  if (!demoRaw) {
    return {
      count: 0,
      below18Count: 0,
      rooms: []
    };
  }

  const working = deepClone(demoRaw);
  ensureBoundaryZones(working);
  refreshElementUFabricForDemo(working);

  const radiatorCatalog = currentRadiators ? (currentRadiators.radiators || []) : [];
  const indoorTemp = Number.isFinite(working?.meta?.indoorTemp) ? Number(working.meta.indoorTemp) : 21;
  const externalTemp = getSystemMinOutsideTemp(working?.meta);
  const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
  const heat = computeRoomHeatRequirements(working, radiatorCatalog, { indoorTemp, externalTemp, flowTemp });
  const rooms = Array.isArray(heat?.rooms) ? heat.rooms : [];

  const deficits = rooms
    .filter(room => room && room.is_unheated !== true)
    .map(room => {
      const setpoint = Number(room?.setpoint_temperature);
      const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
      const currentTemp = Number(room?.delivered_indoor_temperature);
      const shortfallC = isFinite(currentTemp)
        ? Math.max(0, targetTemp - currentTemp)
        : Math.max(0, targetTemp - externalTemp);
      return {
        zoneId: String(room?.zoneId || ''),
        zoneName: String(room?.zoneName || room?.name || room?.zoneId || 'Unnamed room'),
        currentTemp,
        targetTemp,
        shortfallC,
        below18: isFinite(currentTemp) && currentTemp < 17.95
      };
    })
    .filter(room => room.shortfallC > 0.1)
    .sort((a, b) => b.shortfallC - a.shortfallC);

  return {
    count: deficits.length,
    below18Count: deficits.filter(room => room.below18).length,
    rooms: deficits
  };
}

function moveBoilerControlThermostatToZone(demo, zoneId) {
  if (!demo || !zoneId) return false;
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  let moved = false;
  let targetFound = false;

  zones.forEach(zone => {
    if (!zone || zone.type === 'boundary') return;
    const isTarget = String(zone.id || '') === String(zoneId);
    if (isTarget) {
      targetFound = true;
      if (zone.is_boiler_control !== true) {
        zone.is_boiler_control = true;
        moved = true;
      }
      delete zone.is_unheated;
      return;
    }
    if (zone.is_boiler_control === true) {
      zone.is_boiler_control = false;
      moved = true;
    }
  });

  return targetFound && moved;
}

function pickBoilerControlZoneByHeatRatio(demo, radiatorCatalog, externalTemp, nominalFlowTemp) {
  if (!demo) return null;
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  if (zones.length === 0) return null;

  const zonesWithoutControl = zones.map(zone => {
    if (!zone || zone.type === 'boundary') return zone;
    return { ...zone, is_boiler_control: false };
  });

  refreshElementUFabricForDemo(demo);
  const heat = computeRoomHeatRequirements(
    { ...demo, zones: zonesWithoutControl },
    radiatorCatalog,
    {
      indoorTemp: 21,
      externalTemp,
      flowTemp: nominalFlowTemp
    }
  );

  const rooms = Array.isArray(heat?.rooms) ? heat.rooms : [];
  let best = null;

  rooms.forEach(room => {
    if (!room || room.is_unheated === true) return;
    const zoneId = String(room?.zoneId || '');
    if (!zoneId) return;
    const heatLoss = Number(room?.heat_loss || 0);
    const heatOutput = Number(room?.radiator_output || room?.delivered_heat || 0);
    if (!isFinite(heatLoss) || heatLoss <= 0) return;
    if (!isFinite(heatOutput) || heatOutput < 0) return;

    const ratio = heatOutput / heatLoss;
    if (!isFinite(ratio)) return;

    if (!best || ratio < best.ratio || (ratio === best.ratio && heatLoss > best.heatLoss)) {
      best = {
        zoneId,
        zoneName: String(room?.zoneName || zoneId),
        ratio,
        heatLoss
      };
    }
  });

  return best;
}

function isHeatedExternalWallElement(element, demo, outsideBoundaryId) {
  if (!element || String(element?.type || '').toLowerCase() !== 'wall') return false;
  if (!outsideBoundaryId) return false;

  const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
  if (!nodes.includes(outsideBoundaryId)) return false;

  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  const zoneById = new Map(zones.map(zone => [String(zone?.id || ''), zone]));
  return nodes.some(nodeId => {
    const zone = zoneById.get(String(nodeId || ''));
    if (!zone || zone.type === 'boundary') return false;
    return zone.is_unheated !== true;
  });
}

function getEpcBandFromIntensity(intensityKwhM2Yr) {
  if (typeof intensityKwhM2Yr !== 'number' || !isFinite(intensityKwhM2Yr)) return 'N/A';
  if (intensityKwhM2Yr <= 50) return 'A';
  if (intensityKwhM2Yr <= 90) return 'B';
  if (intensityKwhM2Yr <= 150) return 'C';
  if (intensityKwhM2Yr <= 230) return 'D';
  if (intensityKwhM2Yr <= 330) return 'E';
  if (intensityKwhM2Yr <= 450) return 'F';
  return 'G';
}

function getElementAreaM2(element) {
  const x = Number(element?.x);
  const y = Number(element?.y);
  if (!isFinite(x) || !isFinite(y) || x <= 0 || y <= 0) return 0;
  return x * y;
}

function getOpeningAreaFromSpecM2(opening) {
  const directArea = Number(opening?.area ?? opening?.total_area);
  if (isFinite(directArea) && directArea > 0) return directArea;

  const width = Number(opening?.width ?? opening?.width_m ?? opening?.w);
  const height = Number(opening?.height ?? opening?.height_m ?? opening?.h);
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return 0;

  const widthM = width > 10 ? (width / 1000) : width;
  const heightM = height > 10 ? (height / 1000) : height;
  const area = widthM * heightM;
  return isFinite(area) && area > 0 ? area : 0;
}

function getElementNetInsulationAreaM2(element) {
  const grossArea = getElementAreaM2(element);
  if (!isFinite(grossArea) || grossArea <= 0) return 0;

  let openingsArea = Number(element?.openings_area);
  if (!isFinite(openingsArea) || openingsArea < 0) {
    openingsArea = 0;
    const windows = Array.isArray(element?.windows) ? element.windows : [];
    const doors = Array.isArray(element?.doors) ? element.doors : [];
    windows.forEach(window => { openingsArea += getOpeningAreaFromSpecM2(window); });
    doors.forEach(door => { openingsArea += getOpeningAreaFromSpecM2(door); });
  }

  return Math.max(0, grossArea - Math.min(grossArea, openingsArea));
}

function resolveElementBuildUpForEdit(element, templates) {
  if (Array.isArray(element?.build_up) && element.build_up.length > 0) {
    return deepClone(element.build_up);
  }
  const templateId = element?.build_up_template_id;
  if (!templateId) return [];
  const template = templates && templates[templateId];
  if (!template || !Array.isArray(template.build_up)) return [];
  return deepClone(template.build_up);
}

function formatCurrencyEstimate(amount, currency) {
  const safeAmount = Number(amount);
  if (!isFinite(safeAmount) || safeAmount <= 0) return 'n/a';
  const rounded = Math.round(safeAmount);
  if (String(currency || '').toUpperCase() === 'GBP') {
    return `GBP ${rounded.toLocaleString('en-GB')}`;
  }
  return `${rounded.toLocaleString()} ${currency || ''}`.trim();
}

function formatCurrencyAmount(amount, currency) {
  const safeAmount = Number(amount);
  if (!isFinite(safeAmount)) return 'n/a';
  const rounded = Math.round(safeAmount);
  if (String(currency || '').toUpperCase() === 'GBP') {
    return `GBP ${rounded.toLocaleString('en-GB')}`;
  }
  return `${rounded.toLocaleString()} ${currency || ''}`.trim();
}

function normalizeCostResult(costResult, currency) {
  if (typeof costResult === 'number') {
    return {
      total: Number(costResult || 0),
      breakdown: [{ label: 'Estimated cost', amount: Number(costResult || 0) }]
    };
  }

  if (!costResult || typeof costResult !== 'object') {
    return { total: 0, breakdown: [] };
  }

  const breakdown = Array.isArray(costResult.breakdown)
    ? costResult.breakdown
        .map(item => ({ label: String(item?.label || 'Estimated cost'), amount: Number(item?.amount || 0) }))
        .filter(item => isFinite(item.amount))
    : [];
  const summed = breakdown.reduce((sum, item) => sum + item.amount, 0);
  const explicitTotal = Number(costResult.total);
  const total = isFinite(explicitTotal) ? explicitTotal : summed;

  return {
    total,
    breakdown: breakdown.length > 0 ? breakdown : [{ label: 'Estimated cost', amount: total }],
    formattedBreakdown: breakdown.map(item => ({
      label: item.label,
      amount: item.amount,
      amountText: formatCurrencyAmount(item.amount, currency)
    }))
  };
}

function getMaterialCatalogEntry(materialId) {
  const materials = currentMaterials ? (currentMaterials.materials || currentMaterials) : [];
  if (!Array.isArray(materials) || !materialId) return null;
  const target = String(materialId);
  return materials.find(item => String(item?.id || '') === target) || null;
}

function getMaterialDisplayName(materialId) {
  if (!materialId) return 'unknown material';
  const entry = getMaterialCatalogEntry(materialId);
  return String(entry?.name || materialId);
}

function getWindowCatalogEntry(windowId) {
  const options = [
    ...(Array.isArray(currentOpenings?.windows) ? currentOpenings.windows : []),
    ...(Array.isArray(currentOpenings?.air_bricks) ? currentOpenings.air_bricks : [])
  ];
  if (!windowId) return null;
  return options.find(opt => String(opt?.id || '') === String(windowId)) || null;
}

function getDoorCatalogEntry(doorId) {
  const options = Array.isArray(currentOpenings?.doors) ? currentOpenings.doors : [];
  if (!doorId) return null;
  return options.find(opt => String(opt?.id || '') === String(doorId)) || null;
}

function getElementDisplayName(element, fallbackLabel) {
  const fromName = String(element?.name || '').trim();
  if (fromName) return fromName;
  const fromId = String(element?.id || '').trim();
  if (fromId) return fromId;
  return fallbackLabel;
}

function createUniqueElementNameResolver(elements, defaultFallbackLabel = 'Element') {
  const list = Array.isArray(elements) ? elements : [];
  const baseNames = list.map((element, index) => getElementDisplayName(element, `${defaultFallbackLabel} ${index + 1}`));
  const totalsByKey = new Map();
  const seenByKey = new Map();
  const uniqueById = new Map();
  const uniqueByRef = new WeakMap();

  baseNames.forEach(baseName => {
    const key = String(baseName || '').trim().toLowerCase();
    totalsByKey.set(key, Number(totalsByKey.get(key) || 0) + 1);
  });

  list.forEach((element, index) => {
    const baseName = baseNames[index];
    const key = String(baseName || '').trim().toLowerCase();
    const duplicateCount = Number(totalsByKey.get(key) || 0);
    let uniqueName = baseName;
    if (duplicateCount > 1) {
      const ordinal = Number(seenByKey.get(key) || 0) + 1;
      seenByKey.set(key, ordinal);
      uniqueName = `${baseName} (${ordinal})`;
    }

    const id = String(element?.id || '').trim();
    if (id) uniqueById.set(id, uniqueName);
    if (element && typeof element === 'object') uniqueByRef.set(element, uniqueName);
  });

  return (element, fallbackLabel = defaultFallbackLabel) => {
    const id = String(element?.id || '').trim();
    if (id && uniqueById.has(id)) return uniqueById.get(id);
    if (element && typeof element === 'object' && uniqueByRef.has(element)) {
      return uniqueByRef.get(element);
    }
    return getElementDisplayName(element, fallbackLabel);
  };
}

function formatCountMap(countMap, emptyLabel = 'none') {
  const entries = Object.entries(countMap || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return emptyLabel;
  return entries.map(([name, count]) => `${name} (${Number(count)})`).join(', ');
}

function formatTypeChangeMap(typeCountMap, resolver, emptyLabel = 'none') {
  const entries = Object.entries(typeCountMap || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return emptyLabel;
  return entries
    .map(([typeId, count]) => `${String(resolver(typeId) || typeId)} (${Number(count)})`)
    .join(', ');
}

function formatThicknessMm(thicknessM) {
  const value = Number(thicknessM);
  if (!isFinite(value) || value <= 0) return '0 mm';
  return `${Math.round(value * 1000)} mm`;
}

function getFloorCompositeNonJoistMaterialIds(buildUp) {
  const layers = Array.isArray(buildUp) ? buildUp : [];
  const composite = layers.find(layer => {
    if (!layer || layer.type !== 'composite' || !Array.isArray(layer.paths)) return false;
    return layer.paths.some(path => String(path?.material_id || '') === 'joist_wood');
  });
  if (!composite || !Array.isArray(composite.paths)) return [];
  return [...new Set(
    composite.paths
      .map(path => String(path?.material_id || ''))
      .filter(materialId => materialId && materialId !== 'joist_wood')
  )];
}

function getInsulationMaterialCostPerM2(materialId, thicknessM, fallbackPerM2 = 0) {
  const material = getMaterialCatalogEntry(materialId);
  const perM3 = Number(material?.material_cost_per_m3_gbp);
  const thickness = Number(thicknessM);
  if (isFinite(perM3) && perM3 > 0 && isFinite(thickness) && thickness > 0) {
    return perM3 * thickness;
  }
  const fallback = Number(fallbackPerM2);
  return isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function getInsulationMaterialCostPerM3(materialId) {
  const material = getMaterialCatalogEntry(materialId);
  const perM3 = Number(material?.material_cost_per_m3_gbp);
  return isFinite(perM3) && perM3 > 0 ? perM3 : null;
}

function getStructuralLayerThickness(buildUp, structuralMaterialIds = []) {
  const layers = Array.isArray(buildUp) ? buildUp : [];
  const structuralIds = new Set((Array.isArray(structuralMaterialIds) ? structuralMaterialIds : []).map(String));
  for (const layer of layers) {
    const layerThickness = Number(layer?.thickness);
    if (!isFinite(layerThickness) || layerThickness <= 0) continue;
    if (layer?.type === 'composite' && Array.isArray(layer.paths)) {
      const hasStructuralPath = layer.paths.some(path => structuralIds.has(String(path?.material_id || '')));
      if (hasStructuralPath) return layerThickness;
      continue;
    }
    if (structuralIds.has(String(layer?.material_id || ''))) {
      return layerThickness;
    }
  }
  return null;
}

function getWallRetrofitThicknessFromBuildUp(buildUp, cfg) {
  const cavityThickness = getStructuralLayerThickness(buildUp, ['stud_wood']);
  const fallbackThickness = Number(cfg?.fallback_thickness_m || 0.06);
  const maxWithinStudThickness = Number(cfg?.max_within_stud_thickness_m || 0.1);
  const addServiceLayer = cfg?.add_internal_service_layer === true;
  const serviceLayerThickness = Number(cfg?.service_layer_thickness_m || 0.05);

  let withinStudThickness = isFinite(cavityThickness) && cavityThickness > 0
    ? cavityThickness
    : (isFinite(fallbackThickness) && fallbackThickness > 0 ? fallbackThickness : 0.06);
  if (isFinite(maxWithinStudThickness) && maxWithinStudThickness > 0) {
    withinStudThickness = Math.min(withinStudThickness, maxWithinStudThickness);
  }

  const serviceThickness = addServiceLayer && isFinite(serviceLayerThickness) && serviceLayerThickness > 0
    ? serviceLayerThickness
    : 0;

  return {
    withinStudThickness,
    serviceThickness,
    totalAddedThickness: withinStudThickness + serviceThickness,
    addServiceLayer
  };
}

function hasRetrofitLayer(buildUp, retrofitSourceId) {
  const layers = Array.isArray(buildUp) ? buildUp : [];
  return layers.some(layer => String(layer?._retrofit_source || '') === String(retrofitSourceId || ''));
}

function isWallInternalRetrofitAlreadyApplied(element, templates) {
  if (!element) return false;
  if (element._internal_retrofit_applied === true) return true;
  const buildUp = resolveElementBuildUpForEdit(element, templates);
  return hasRetrofitLayer(buildUp, 'wall_internal_insulation');
}

function getFloorInsulationThicknessFromBuildUp(buildUp, cfg) {
  const joistThickness = getStructuralLayerThickness(buildUp, ['joist_wood']);
  const fallbackThickness = Number(cfg?.fallback_thickness_m || 0.08);
  if (isFinite(joistThickness) && joistThickness > 0) {
    // Floor insulation should not exceed joist depth.
    return joistThickness;
  }
  return isFinite(fallbackThickness) && fallbackThickness > 0 ? fallbackThickness : 0.08;
}

function getLoftInsulationThicknessFromBuildUp(buildUp, cfg) {
  const joistThickness = getStructuralLayerThickness(buildUp, ['joist_wood']);
  const fallbackThickness = Number(cfg?.fallback_thickness_m || 0.15);
  const aboveJoistThickness = Number(cfg?.above_joist_thickness_m || 0);
  const maxAboveJoistThickness = Number(cfg?.max_above_joist_thickness_m || 0.5);

  const withinJoistThickness = isFinite(joistThickness) && joistThickness > 0
    ? joistThickness
    : (isFinite(fallbackThickness) && fallbackThickness > 0 ? fallbackThickness : 0.15);
  const clampedAboveJoist = isFinite(aboveJoistThickness) && aboveJoistThickness > 0
    ? Math.min(aboveJoistThickness, isFinite(maxAboveJoistThickness) && maxAboveJoistThickness > 0 ? maxAboveJoistThickness : 0.5)
    : 0;

  return {
    withinJoistThickness,
    aboveJoistThickness: clampedAboveJoist,
    totalAddedThickness: withinJoistThickness + clampedAboveJoist
  };
}

function applyFloorCavityInsulationRetrofit(element, templates, cfg, insulationMaterialId) {
  const buildUp = resolveElementBuildUpForEdit(element, templates);
  const compositeIndex = buildUp.findIndex(layer => {
    if (!layer || layer.type !== 'composite' || !Array.isArray(layer.paths)) return false;
    return layer.paths.some(path => String(path?.material_id || '') === 'joist_wood');
  });

  // Respect joist-only strategy: do not append below-joist insulation layers.
  if (compositeIndex < 0) {
    return { changed: false, thicknessM: 0 };
  }

  const composite = buildUp[compositeIndex];
  const thickness = Number(composite?.thickness);
  const effectiveThickness = isFinite(thickness) && thickness > 0
    ? thickness
    : getFloorInsulationThicknessFromBuildUp(buildUp, cfg);

  let changed = false;
  const joistPaths = composite.paths.filter(path => String(path?.material_id || '') === 'joist_wood');
  const nonJoistPaths = composite.paths.filter(path => String(path?.material_id || '') !== 'joist_wood');

  if (nonJoistPaths.length === 0) {
    const joistFrac = joistPaths.reduce((sum, path) => sum + Number(path?.fraction || 0), 0);
    const insulationFraction = Math.max(0.01, Math.min(0.99, 1 - (isFinite(joistFrac) ? joistFrac : 0.15)));
    composite.paths.push({ material_id: insulationMaterialId, fraction: Number(insulationFraction.toFixed(3)) });
    changed = true;
  } else {
    nonJoistPaths.forEach(path => {
      if (String(path?.material_id || '') !== insulationMaterialId) {
        path.material_id = insulationMaterialId;
        changed = true;
      }
    });
  }

  if (changed) {
    buildUp[compositeIndex] = composite;
    element.build_up = buildUp;
    delete element.build_up_template_id;
  }

  return {
    changed,
    thicknessM: isFinite(effectiveThickness) && effectiveThickness > 0 ? effectiveThickness : 0
  };
}

function refreshElementUFabricForDemo(demo) {
  const openingMaterials = getOpeningMaterials(currentOpenings);
  const baseMaterials = currentMaterials ? (currentMaterials.materials || currentMaterials) : [];
  const allMaterials = [...baseMaterials, ...openingMaterials];
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  const buildupTemplates = (demo?.meta && demo.meta.build_up_templates) || {};

  for (const el of elements) {
    try {
      computeElementU(el, allMaterials, buildupTemplates);
    } catch (_) {
      // Ignore per-element failures while building recommendations.
    }
  }
}

function getRadiatorSizingConfig() {
  const catalog = currentRadiators || {};
  const list = Array.isArray(catalog?.radiators) ? catalog.radiators : [];
  const coeffByType = new Map();
  list.forEach(item => {
    const id = String(item?.id || '');
    const coeff = Number(item?.heat_transfer_coefficient);
    if (!id || !isFinite(coeff) || coeff <= 0) return;
    coeffByType.set(id, coeff);
  });

  const typeOrder = ['type_1', 'type_11', 'type_22', 'type_33'].filter(id => coeffByType.has(id));
  if (typeOrder.length === 0) {
    coeffByType.set('type_11', 6.5);
    coeffByType.set('type_22', 8);
    coeffByType.set('type_33', 10);
    typeOrder.push('type_11', 'type_22', 'type_33');
  }

  const rawWidths = Array.isArray(catalog?.standard_widths_mm) ? catalog.standard_widths_mm : [400, 600, 800, 1000, 1200, 1400, 1600, 1800];
  const widths = [...new Set(rawWidths.map(w => Number(w)).filter(w => isFinite(w) && w >= 300 && w <= 1800))].sort((a, b) => a - b);
  const standardWidths = widths.length > 0 ? widths : [400, 600, 800, 1000, 1200, 1400, 1600, 1800];

  return {
    coeffByType,
    typeOrder,
    standardWidths,
    defaultHeightMm: 600,
    maxWidthMm: 1800,
    minWidthMm: 400
  };
}

function getHouseDominantRadiatorType(demo, sizing) {
  const counts = {};
  (Array.isArray(demo?.zones) ? demo.zones : []).forEach(zone => {
    (Array.isArray(zone?.radiators) ? zone.radiators : []).forEach(rad => {
      const typeId = String(rad?.radiator_id || '');
      if (!sizing.coeffByType.has(typeId)) return;
      counts[typeId] = Number(counts[typeId] || 0) + 1;
    });
  });

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) return ranked[0][0];
  return sizing.typeOrder.includes('type_22') ? 'type_22' : sizing.typeOrder[0];
}

function nearestStandardWidthMm(widthMm, standardWidths) {
  const target = Number(widthMm);
  if (!isFinite(target) || target <= 0) return Number(standardWidths[0] || 1000);
  return standardWidths.reduce((best, candidate) => {
    return Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best;
  }, Number(standardWidths[0] || 1000));
}

function inferRoomWindowWidthMm(demo, zoneId, standardWidths) {
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  let best = null;
  elements.forEach(element => {
    if (String(element?.type || '').toLowerCase() !== 'wall') return;
    const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
    if (!nodes.includes(zoneId)) return;
    const windows = Array.isArray(element?.windows) ? element.windows : [];
    windows.forEach(window => {
      const explicitWidth = Number(window?.width);
      if (isFinite(explicitWidth) && explicitWidth > 0) {
        best = Math.max(Number(best || 0), explicitWidth);
        return;
      }
      const area = Number(window?.area);
      if (!isFinite(area) || area <= 0) return;
      const heightMm = Number(window?.height);
      const heightM = isFinite(heightMm) && heightMm > 0 ? (heightMm / 1000) : 1.2;
      const inferredWidthMm = (area / Math.max(0.4, heightM)) * 1000;
      if (isFinite(inferredWidthMm) && inferredWidthMm > 0) {
        best = Math.max(Number(best || 0), inferredWidthMm);
      }
    });
  });
  if (!isFinite(Number(best)) || Number(best) <= 0) return null;
  return nearestStandardWidthMm(best, standardWidths);
}

function normalizeRadiatorSpec(spec, preferredTypeId, sizing, fallbackWidthMm = 1000) {
  const normalized = {
    id: spec?.id,
    radiator_id: String(spec?.radiator_id || preferredTypeId),
    trv_enabled: spec?.trv_enabled === true,
    wall_element_id: spec?.wall_element_id || null,
    position_ratio: Number.isFinite(Number(spec?.position_ratio))
      ? Number(Math.max(0, Math.min(1, Number(spec.position_ratio))).toFixed(3))
      : 0.5
  };
  if (!sizing.coeffByType.has(normalized.radiator_id)) {
    normalized.radiator_id = preferredTypeId;
  }
  const widthMmRaw = Number(spec?.width);
  const heightMmRaw = Number(spec?.height);
  const widthMm = isFinite(widthMmRaw) && widthMmRaw > 0 ? widthMmRaw : fallbackWidthMm;
  const heightMm = isFinite(heightMmRaw) && heightMmRaw > 0 ? heightMmRaw : sizing.defaultHeightMm;
  normalized.width = Math.max(sizing.minWidthMm, Math.min(sizing.maxWidthMm, nearestStandardWidthMm(widthMm, sizing.standardWidths)));
  normalized.height = Math.max(300, Math.min(1200, Math.round(heightMm)));
  normalized.surface_area = Number(((normalized.width / 1000) * (normalized.height / 1000)).toFixed(3));
  return normalized;
}

function radiatorCoefficient(spec, sizing) {
  const coeff = Number(sizing.coeffByType.get(String(spec?.radiator_id || '')) || 0);
  const area = Number(spec?.surface_area || 0);
  if (!isFinite(coeff) || coeff <= 0 || !isFinite(area) || area <= 0) return 0;
  return coeff * area;
}

function isValidZoneWallElement(demo, zoneId, wallId) {
  if (!wallId) return false;
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  return elements.some(element => {
    if (!element || String(element?.type || '').toLowerCase() !== 'wall') return false;
    if (String(element?.id || '') !== String(wallId)) return false;
    const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
    return nodes.includes(zoneId);
  });
}

function assignRadiatorPlacementsForZone(demo, zoneId, afterSpecs, beforeSpecs) {
  const zone = getZoneById(demo, zoneId);
  if (!zone) return Array.isArray(afterSpecs) ? deepClone(afterSpecs) : [];

  const before = Array.isArray(beforeSpecs) ? beforeSpecs : [];
  const beforeById = new Map(
    before
      .filter(rad => rad && rad.id)
      .map(rad => [String(rad.id), rad])
  );

  const result = [];
  const originalZoneRadiators = Array.isArray(zone.radiators) ? zone.radiators : [];

  try {
    zone.radiators = [];

    const specs = Array.isArray(afterSpecs) ? afterSpecs : [];
    for (let i = 0; i < specs.length; i += 1) {
      const spec = { ...specs[i] };
      const byId = spec?.id ? beforeById.get(String(spec.id)) : null;
      const byIndex = before[i] || null;
      const prior = byId || byIndex;

      const priorWallId = prior?.wall_element_id;
      if (!spec.wall_element_id && isValidZoneWallElement(demo, zoneId, priorWallId)) {
        spec.wall_element_id = priorWallId;
      }

      if (!isValidZoneWallElement(demo, zoneId, spec.wall_element_id)) {
        const wall = pickPreferredWallForZone(demo, zoneId, 'radiator');
        if (wall?.id) spec.wall_element_id = wall.id;
      }

      if (Number.isFinite(Number(spec?.position_ratio))) {
        spec.position_ratio = Number(Math.max(0, Math.min(1, Number(spec.position_ratio))).toFixed(3));
      } else if (Number.isFinite(Number(prior?.position_ratio))) {
        spec.position_ratio = Number(Math.max(0, Math.min(1, Number(prior.position_ratio))).toFixed(3));
      } else {
        spec.position_ratio = choosePreferredRadiatorPositionRatio(demo, zoneId, spec.wall_element_id, result);
      }

      result.push(spec);
      zone.radiators = result;
    }
  } finally {
    zone.radiators = originalZoneRadiators;
  }

  return result;
}

export function designRoomRadiators(requiredCoeff, existingRads, preferredTypeId, widthHintMm, sizing) {
  const initial = (Array.isArray(existingRads) ? existingRads : []).map(rad =>
    normalizeRadiatorSpec(rad, preferredTypeId, sizing, widthHintMm || 1000)
  );

  let specs = initial;
  if (specs.length === 0) {
    specs = [normalizeRadiatorSpec({
      radiator_id: preferredTypeId,
      width: widthHintMm || 1000,
      height: sizing.defaultHeightMm,
      trv_enabled: true
    }, preferredTypeId, sizing, widthHintMm || 1000)];
  }

  const maxTypeIndex = sizing.typeOrder.length - 1;
  const totalCoeff = () => specs.reduce((sum, rad) => sum + radiatorCoefficient(rad, sizing), 0);

  let guard = 0;
  while (totalCoeff() + 0.01 < requiredCoeff && guard < 200) {
    guard += 1;

    let progressed = false;
    for (let i = 0; i < specs.length; i += 1) {
      const currentType = String(specs[i].radiator_id || preferredTypeId);
      const idx = Math.max(0, sizing.typeOrder.indexOf(currentType));
      if (idx < maxTypeIndex) {
        specs[i].radiator_id = sizing.typeOrder[idx + 1];
        progressed = true;
        break;
      }
    }
    if (progressed) continue;

    for (let i = 0; i < specs.length; i += 1) {
      const currentWidth = Number(specs[i].width || sizing.minWidthMm);
      const nextWidth = sizing.standardWidths.find(w => w > currentWidth && w <= sizing.maxWidthMm);
      if (isFinite(nextWidth)) {
        specs[i].width = nextWidth;
        specs[i].surface_area = Number(((nextWidth / 1000) * (Number(specs[i].height || sizing.defaultHeightMm) / 1000)).toFixed(3));
        progressed = true;
        break;
      }
    }
    if (progressed) continue;

    if (specs.length < 200) {
      specs.push(normalizeRadiatorSpec({
        radiator_id: preferredTypeId,
        width: widthHintMm || 1000,
        height: sizing.defaultHeightMm,
        trv_enabled: true
      }, preferredTypeId, sizing, widthHintMm || 1000));
      continue;
    }

    break;
  }

  specs = specs.map(spec => ({
    ...spec,
    trv_enabled: true,
    surface_area: Number(((Number(spec.width) / 1000) * (Number(spec.height) / 1000)).toFixed(3))
  }));

  return {
    specs,
    achievedCoeff: totalCoeff(),
    maxSingleExceeded: specs.some(spec => String(spec.radiator_id) === 'type_33' && Number(spec.width) > 1800)
  };
}

function applyRadiatorComfortUpgrade(demo, options = {}) {
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  const radiatorCatalog = currentRadiators ? (currentRadiators.radiators || []) : [];
  const sizing = getRadiatorSizingConfig();
  const dominantTypeId = getHouseDominantRadiatorType(demo, sizing);

  const flowTempRaw = Number(demo?.meta?.flowTemp);
  const externalTempRaw = Number(demo?.meta?.systemMinExternalTemp);
  const flowTemp = isFinite(flowTempRaw) ? flowTempRaw : 55;
  const externalTemp = isFinite(externalTempRaw)
    ? externalTempRaw
    : getSystemMinOutsideTemp(demo?.meta);
  const targetFlowTempRaw = Number(options?.targetFlowTemp);
  const targetFlowTemp = isFinite(targetFlowTempRaw) ? targetFlowTempRaw : flowTemp;
  const maxComfortFlowTempRaw = Number(options?.maxComfortFlowTemp);
  const maxComfortFlowTemp = isFinite(maxComfortFlowTempRaw)
    ? Math.max(flowTemp, maxComfortFlowTempRaw)
    : Math.max(flowTemp, 75);
  const sizingOverheadFactorRaw = Number(options?.sizingOverheadFactor);
  const sizingOverheadFactor = isFinite(sizingOverheadFactorRaw) && sizingOverheadFactorRaw >= 1
    ? sizingOverheadFactorRaw
    : 1.15;

  const evaluateComfortAtFlow = (tempC) => {
    refreshElementUFabricForDemo(demo);
    const heat = computeRoomHeatRequirements(demo, radiatorCatalog, {
      indoorTemp: 21,
      externalTemp,
      flowTemp: tempC
    });
    const rooms = Array.isArray(heat?.rooms) ? heat.rooms : [];
    return {
      unmet: rooms.filter(room => room && room.is_unheated !== true && room.can_reach_setpoint === false).length,
      below18: rooms.filter(room => {
        if (!room || room.is_unheated === true) return false;
        const delivered = Number(room?.delivered_indoor_temperature);
        return isFinite(delivered) && delivered < 17.95;
      }).length,
      belowTarget: rooms.filter(room => {
        if (!room || room.is_unheated === true) return false;
        const delivered = Number(room?.delivered_indoor_temperature);
        const setpoint = Number(room?.setpoint_temperature);
        const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
        return isFinite(delivered) ? delivered < targetTemp - 0.1 : true;
      }).length
    };
  };

  let thermostatMoved = false;
  let thermostatTargetZoneName = '';

  refreshElementUFabricForDemo(demo);
  const heatBefore = computeRoomHeatRequirements(demo, radiatorCatalog, {
    indoorTemp: 21,
    externalTemp,
    flowTemp
  });

  const unmetRooms = Array.isArray(heatBefore?.rooms)
    ? heatBefore.rooms.filter(room => {
      if (!room || room.is_unheated === true) return false;
      const delivered = Number(room?.delivered_indoor_temperature);
      const setpoint = Number(room?.setpoint_temperature);
      const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
      return isFinite(delivered)
        ? delivered < targetTemp - 0.1
        : true;
    })
    : [];

  if (unmetRooms.length === 0) {
    return {
      changed: false,
      totalAddedSurfaceArea: 0,
      unmetBefore: 0,
      unmetAfter: 0,
      below18Before: 0,
      below18After: 0,
      belowTargetBefore: 0,
      belowTargetAfter: 0,
      trvEnabledCount: 0,
      flowTempBefore: flowTemp,
      flowTempAfter: flowTemp,
      flowTempAdjusted: false,
      upgradedRooms: []
    };
  }

  // ── Design-condition heat-loss pass ────────────────────────────────────
  // total_conductance tracks boundary conductance only (to Outside/Ground).
  // Rooms losing heat to adjacent unheated zones (e.g. loft above) are
  // drastically undersized when only boundary conductance drives the formula.
  // Fix: run heat-calc with oversized (TRV-clamped) radiators in every unmet
  // room, control-zone modulation stripped, so the solver places every unmet
  // room at its setpoint.  The resulting heat_loss values include ALL heat
  // transfer paths and give accurate sizing inputs.
  const unmetZoneIdSet = new Set(unmetRooms.map(r => String(r?.zoneId || '')));
  const designPassZones = zones.map(z => {
    const base = { ...z, is_boiler_control: false };
    if (!unmetZoneIdSet.has(String(z?.id || ''))) return base;
    return { ...base, radiators: [{ radiator_id: dominantTypeId, surface_area: 200, trv_enabled: true }] };
  });
  const heatDesign = computeRoomHeatRequirements(
    { ...demo, zones: designPassZones },
    radiatorCatalog,
    { indoorTemp: 21, externalTemp, flowTemp }
  );
  const designHeatByZoneId = new Map(
    (Array.isArray(heatDesign?.rooms) ? heatDesign.rooms : []).map(r => [String(r?.zoneId || ''), r])
  );

  const upgradeByZoneId = new Map();
  let totalAddedSurfaceArea = 0;
  for (const room of unmetRooms) {
    const zoneId = String(room?.zoneId || '');
    const zoneName = String(room?.zoneName || zoneId || 'Unnamed room');
    const setpoint = Number(room?.setpoint_temperature);
    const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
    const totalConductance = Number(room?.total_conductance);
    const currentCoeff = Number(room?.radiator_coefficient || 0);
    if (!zoneId) continue;

    let requiredCoeff = currentCoeff;
    const delivered = Number(room?.delivered_indoor_temperature);
    const shortfallC = isFinite(delivered) ? Math.max(0, targetTemp - delivered) : Math.max(0.5, targetTemp - externalTemp);
    const designDelta = Math.max(1, flowTemp - targetTemp);
    const designRoom = designHeatByZoneId.get(zoneId);
    const designHeatLoss = designRoom ? Number(designRoom.heat_loss) : NaN;
    if (isFinite(designHeatLoss) && designHeatLoss > 0) {
      requiredCoeff = Math.max(currentCoeff, (designHeatLoss * sizingOverheadFactor) / designDelta);
    } else if (isFinite(totalConductance) && totalConductance > 0) {
      const requiredOutput = Math.max(0, totalConductance * Math.max(0, targetTemp - externalTemp));
      requiredCoeff = Math.max(currentCoeff, (requiredOutput * sizingOverheadFactor) / designDelta);
    } else {
      requiredCoeff = currentCoeff + Math.max(2, shortfallC * 8 * sizingOverheadFactor);
    }

    const zone = zones.find(z => String(z?.id || '') === zoneId);
    if (!zone) continue;
    const existingRads = Array.isArray(zone?.radiators) ? zone.radiators : [];
    const widthHintMm = inferRoomWindowWidthMm(demo, zoneId, sizing.standardWidths)
      || nearestStandardWidthMm(1000, sizing.standardWidths);

    const design = designRoomRadiators(requiredCoeff, existingRads, dominantTypeId, widthHintMm, sizing);
    const placedSpecs = assignRadiatorPlacementsForZone(demo, zoneId, design.specs, existingRads);
    const beforeArea = existingRads.reduce((sum, rad) => sum + Number(rad?.surface_area || 0), 0);
    const afterArea = placedSpecs.reduce((sum, rad) => sum + Number(rad?.surface_area || 0), 0);
    const deltaArea = Math.max(0, afterArea - beforeArea);
    if (deltaArea <= 0.001 && placedSpecs.length === existingRads.length) {
      continue;
    }

    upgradeByZoneId.set(zoneId, {
      zoneId,
      zoneName,
      addArea: deltaArea,
      before: existingRads,
      after: placedSpecs
    });
    totalAddedSurfaceArea += deltaArea;
  }

  if (upgradeByZoneId.size === 0) {
    return {
      changed: thermostatMoved,
      totalAddedSurfaceArea: 0,
      unmetBefore: unmetRooms.length,
      unmetAfter: unmetRooms.length,
      below18Before: unmetRooms.filter(room => Number(room?.delivered_indoor_temperature) < 17.95).length,
      below18After: unmetRooms.filter(room => Number(room?.delivered_indoor_temperature) < 17.95).length,
      belowTargetBefore: unmetRooms.length,
      belowTargetAfter: unmetRooms.length,
      trvEnabledCount: 0,
      flowTempBefore: flowTemp,
      flowTempAfter: flowTemp,
      flowTempAdjusted: false,
      thermostatMoved,
      thermostatTargetZoneName,
      upgradedRooms: []
    };
  }

  let changed = false;
  let trvEnabledCount = 0;
  for (const entry of upgradeByZoneId.values()) {
    const zone = zones.find(z => String(z?.id || '') === entry.zoneId);
    if (!zone) continue;
    const before = Array.isArray(entry.before) ? entry.before : [];
    const after = Array.isArray(entry.after) ? entry.after : [];
    if (after.length === 0) continue;

    const beforeTrvTrue = before.filter(rad => rad?.trv_enabled === true).length;
    const afterTrvTrue = after.filter(rad => rad?.trv_enabled === true).length;
    trvEnabledCount += Math.max(0, afterTrvTrue - beforeTrvTrue);

    zone.radiators = deepClone(after);
    changed = true;
  }

  if (!changed) {
    return {
      changed: thermostatMoved,
      totalAddedSurfaceArea: 0,
      unmetBefore: unmetRooms.length,
      unmetAfter: unmetRooms.length,
      below18Before: unmetRooms.filter(room => Number(room?.delivered_indoor_temperature) < 17.95).length,
      below18After: unmetRooms.filter(room => Number(room?.delivered_indoor_temperature) < 17.95).length,
      belowTargetBefore: unmetRooms.length,
      belowTargetAfter: unmetRooms.length,
      trvEnabledCount: 0,
      flowTempBefore: flowTemp,
      flowTempAfter: flowTemp,
      flowTempAdjusted: false,
      thermostatMoved,
      thermostatTargetZoneName,
      upgradedRooms: []
    };
  }

  const thermostatTarget = pickBoilerControlZoneByHeatRatio(
    demo,
    radiatorCatalog,
    externalTemp,
    flowTemp
  );
  const thermostatTargetZoneId = String(thermostatTarget?.zoneId || '');
  thermostatTargetZoneName = String(thermostatTarget?.zoneName || thermostatTargetZoneId || '');
  thermostatMoved = thermostatTargetZoneId
    ? moveBoilerControlThermostatToZone(demo, thermostatTargetZoneId)
    : false;

  const baseComfortAfterUpgrade = evaluateComfortAtFlow(flowTemp);
  let workingFlowTemp = flowTemp;
  let workingComfort = baseComfortAfterUpgrade;

  // If comfort is still not met after radiator upgrades, allow a flow increase to recover comfort.
  if (workingComfort.belowTarget > 0 || workingComfort.unmet > 0) {
    let bestFlow = workingFlowTemp;
    let bestComfort = workingComfort;
    for (let candidate = Math.ceil(workingFlowTemp + 1); candidate <= Math.ceil(maxComfortFlowTemp); candidate += 1) {
      const comfortAtCandidate = evaluateComfortAtFlow(candidate);
      const improves =
        comfortAtCandidate.belowTarget < bestComfort.belowTarget
        || (comfortAtCandidate.belowTarget === bestComfort.belowTarget && comfortAtCandidate.unmet < bestComfort.unmet)
        || (
          comfortAtCandidate.belowTarget === bestComfort.belowTarget
          && comfortAtCandidate.unmet === bestComfort.unmet
          && comfortAtCandidate.below18 < bestComfort.below18
        );
      if (improves) {
        bestFlow = candidate;
        bestComfort = comfortAtCandidate;
      }
      if (bestComfort.belowTarget === 0 && bestComfort.unmet === 0) break;
    }
    workingFlowTemp = bestFlow;
    workingComfort = bestComfort;
  }

  // Then try reducing flow toward efficiency target while preserving achieved comfort.
  let finalFlowTemp = workingFlowTemp;
  if (targetFlowTemp < workingFlowTemp - 0.5) {
    for (let candidate = Math.floor(workingFlowTemp - 1); candidate >= Math.ceil(targetFlowTemp); candidate -= 1) {
      const comfortAtCandidate = evaluateComfortAtFlow(candidate);
      if (
        comfortAtCandidate.belowTarget <= workingComfort.belowTarget
        && comfortAtCandidate.below18 <= workingComfort.below18
        && comfortAtCandidate.unmet <= workingComfort.unmet
      ) {
        finalFlowTemp = candidate;
      } else {
        break;
      }
    }
  }
  const flowTempAdjusted = Math.abs(finalFlowTemp - flowTemp) > 0.1;
  demo.meta = demo.meta || {};
  demo.meta.flowTemp = Number(finalFlowTemp.toFixed(1));

  const finalComfort = evaluateComfortAtFlow(finalFlowTemp);
  const unmetAfter = finalComfort.unmet;
  const below18Before = unmetRooms.filter(room => {
    const delivered = Number(room?.delivered_indoor_temperature);
    return isFinite(delivered) && delivered < 17.95;
  }).length;
  const below18After = finalComfort.below18;
  const belowTargetBefore = unmetRooms.length;
  const belowTargetAfter = Number(finalComfort?.belowTarget || 0);

  const upgradedRooms = [...upgradeByZoneId.values()]
    .sort((a, b) => String(a.zoneName).localeCompare(String(b.zoneName)))
    .map(entry => ({
      zoneId: entry.zoneId,
      zoneName: entry.zoneName,
      addArea: Number(entry.addArea || 0),
      finalSpecs: (Array.isArray(entry.after) ? entry.after : []).map(rad => ({
        radiatorId: String(rad?.radiator_id || ''),
        width: Number(rad?.width || 0),
        height: Number(rad?.height || 0)
      }))
    }));

  return {
    changed,
    totalAddedSurfaceArea,
    unmetBefore: unmetRooms.length,
    unmetAfter,
    below18Before,
    below18After,
    belowTargetBefore,
    belowTargetAfter,
    trvEnabledCount,
    flowTempBefore: flowTemp,
    flowTempAfter: finalFlowTemp,
    flowTempAdjusted,
    thermostatMoved,
    thermostatTargetZoneName,
    upgradedRooms
  };
}

function getRecommendationHelpers() {
  return {
    deepClone,
    getComparisonMetricsForDemo,
    getComfortSnapshotForDemo,
    getNormalizedHeatingInputs,
    normalizeCostResult,
    formatCurrencyEstimate,
    applyRadiatorComfortUpgrade,
    createUniqueElementNameResolver,
    formatCountMap,
    formatTypeChangeMap,
    getWindowCatalogEntry,
    getDoorCatalogEntry,
    getBoundaryZoneId,
    isHeatedExternalWallElement,
    isWallInternalRetrofitAlreadyApplied,
    resolveElementBuildUpForEdit,
    getWallRetrofitThicknessFromBuildUp,
    getMaterialDisplayName,
    getElementNetInsulationAreaM2,
    getElementAreaM2,
    getInsulationMaterialCostPerM3,
    getInsulationMaterialCostPerM2,
    applyFloorCavityInsulationRetrofit,
    getFloorCompositeNonJoistMaterialIds,
    formatThicknessMm,
    getLoftInsulationThicknessFromBuildUp,
    getComfortDeficitRoomsForDemo,
    getEpcBandFromIntensity
  };
}

function getRecommendationContext() {
  return {
    currentCosts,
    currentOpenings,
    helpers: getRecommendationHelpers()
  };
}

function getRecommendationCostModel() {
  return resolveRecommendationCostModel(currentCosts);
}

function buildPerformanceRecommendations(demoRaw) {
  return buildPerformanceRecommendationsCore(demoRaw, getRecommendationContext());
}

function applyRecommendationById(demoRaw, recommendationId) {
  return applyRecommendationByIdCore(demoRaw, recommendationId, getRecommendationContext());
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

function getWallElementByIdForZone(demo, zoneId, wallId) {
  if (!wallId) return null;
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];
  return elements.find(element => {
    if (!element || String(element?.type || '').toLowerCase() !== 'wall') return false;
    if (String(element?.id || '') !== String(wallId)) return false;
    const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
    return nodes.includes(zoneId);
  }) || null;
}

function getOpeningPositionRatiosForZoneOnWall(wall, zoneId, kind) {
  const list = kind === 'door'
    ? (Array.isArray(wall?.doors) ? wall.doors : [])
    : (Array.isArray(wall?.windows) ? wall.windows : []);

  const ownerZoneId = Array.isArray(wall?.nodes) && wall.nodes.length > 0 ? wall.nodes[0] : null;
  return list
    .filter(opening => {
      const openingZone = opening?.zone_id || ownerZoneId;
      return openingZone === zoneId;
    })
    .map(opening => Number(opening?.position_ratio))
    .filter(value => Number.isFinite(value))
    .map(value => Number(Math.max(0, Math.min(1, value)).toFixed(3)));
}

function choosePreferredRadiatorPositionRatio(demo, zoneId, wallId, zoneRadiators = []) {
  const wall = getWallElementByIdForZone(demo, zoneId, wallId);
  if (!wall) return 0.5;

  const occupied = [];
  occupied.push(...getOpeningPositionRatiosForZoneOnWall(wall, zoneId, 'door'));
  occupied.push(...getOpeningPositionRatiosForZoneOnWall(wall, zoneId, 'window'));

  (Array.isArray(zoneRadiators) ? zoneRadiators : []).forEach(radiator => {
    if (String(radiator?.wall_element_id || '') !== String(wallId)) return;
    const ratio = Number(radiator?.position_ratio);
    if (Number.isFinite(ratio)) occupied.push(Number(Math.max(0, Math.min(1, ratio)).toFixed(3)));
  });

  const candidates = [0.2, 0.35, 0.5, 0.65, 0.8];
  if (occupied.length === 0) return 0.5;

  let best = candidates[0];
  let bestDistance = -1;
  candidates.forEach(candidate => {
    const minDistance = occupied.reduce((min, point) => Math.min(min, Math.abs(candidate - point)), 1);
    if (minDistance > bestDistance) {
      bestDistance = minDistance;
      best = candidate;
    }
  });

  return Number(best.toFixed(3));
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
    // Explicitly avoid walls with doors when at least one door-free wall is available.
    const noDoorCandidates = scored.filter(entry => entry.hasDoor !== true);
    const radiatorCandidates = noDoorCandidates.length > 0 ? noDoorCandidates : scored;

    radiatorCandidates.sort((a, b) => {
      const aHasRadiator = a.radiatorCount > 0;
      const bHasRadiator = b.radiatorCount > 0;
      if (aHasRadiator !== bHasRadiator) return aHasRadiator ? 1 : -1;
      if (a.hasWindow !== b.hasWindow) return a.hasWindow ? -1 : 1;
      if (a.hasDoor !== b.hasDoor) return a.hasDoor ? 1 : -1;
      if (a.radiatorCount !== b.radiatorCount) return a.radiatorCount - b.radiatorCount;
      if (a.isExternal !== b.isExternal) return a.isExternal ? -1 : 1;
      if (a.openingOccupancy !== b.openingOccupancy) return a.openingOccupancy - b.openingOccupancy;
      return 0;
    });

    return radiatorCandidates[0]?.wall || null;
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

  const windowOptions = Array.isArray(openingsData?.windows) ? openingsData.windows : [];
  const airBrickOptions = Array.isArray(openingsData?.air_bricks) ? openingsData.air_bricks : [];
  const allOptions = [...windowOptions, ...airBrickOptions];
  const fallbackOption = { id: 'window_double_modern', air_leakage_m3_h_m2: 1.2, has_trickle_vent: false, trickle_vent_flow_m3_h: 0 };
  const firstOption = allOptions.length > 0 ? allOptions[0] : fallbackOption;
  const selectedOption = allOptions.find(item => String(item?.id || '') === String(opts.glazingId || '')) || firstOption;

  const width = Number.isFinite(opts.width) ? opts.width : 1000;
  const height = Number.isFinite(opts.height) ? opts.height : 1200;

  wall.windows.push({
    id: generateId('id'),
    name: `Window ${wall.windows.length + 1}`,
    glazing_id: opts.glazingId || selectedOption.id,
    width,
    height,
    area: Number(((width / 1000) * (height / 1000)).toFixed(3)),
    length_m: Number((width / 1000).toFixed(3)),
    position_ratio: 0.5,
    air_leakage_m3_h_m2: Number((selectedOption.air_leakage_m3_h_m2 || 0).toFixed(3)),
    has_trickle_vent: selectedOption.has_trickle_vent === true,
    trickle_vent_flow_m3_h: Number((selectedOption.trickle_vent_flow_m3_h || 0).toFixed(2)),
    zone_id: zoneId
  });
  return true;
}

function addAirBrickToZoneWall(demo, openingsData, zoneId, opts = {}) {
  const airBrickOptions = Array.isArray(openingsData?.air_bricks) ? openingsData.air_bricks : [];
  const firstAirBrick = airBrickOptions[0] || null;
  return addWindowToZoneWall(demo, openingsData, zoneId, {
    width: Number.isFinite(opts.width) ? opts.width : 215,
    height: Number.isFinite(opts.height) ? opts.height : 65,
    glazingId: opts.glazingId || firstAirBrick?.id || 'window_air_brick'
  });
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
  let zone = getZoneById(demo, zoneId);
  if (!zone || zone.type === 'boundary') {
    zone = (Array.isArray(demo?.zones) ? demo.zones : []).find(z => z && z.type !== 'boundary') || null;
  }
  if (!zone) return false;
  if (!Array.isArray(zone.radiators)) zone.radiators = [];
  const effectiveZoneId = zone.id;
  const wall = pickPreferredWallForZone(demo, effectiveZoneId, 'radiator');

  const defaultType = Array.isArray(radiatorsData?.radiators) && radiatorsData.radiators.length > 0
    ? radiatorsData.radiators[0].id
    : 'type_11';

  const width = Number.isFinite(opts.width) ? opts.width : 800;
  const height = Number.isFinite(opts.height) ? opts.height : 600;

  zone.radiators.push({
    id: generateId('id'),
    radiator_id: opts.radiatorId || defaultType,
    wall_element_id: wall?.id || null,
    width,
    height,
    surface_area: Number(((width / 1000) * (height / 1000)).toFixed(3)),
    trv_enabled: !!trvEnabled,
    position_ratio: wall?.id
      ? choosePreferredRadiatorPositionRatio(demo, effectiveZoneId, wall.id, zone.radiators)
      : 0.5
  });
  console.info('[hvac.radiators.add] added radiator', {
    requestedZoneId: zoneId,
    targetZoneId: effectiveZoneId,
    radiatorCount: zone.radiators.length
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
  const defaultType = String(opts.type || preset?.type || '').toLowerCase();
  const trickleFlow = Number.isFinite(opts.trickle_flow_m3_h)
    ? Math.max(0, opts.trickle_flow_m3_h)
    : (Number.isFinite(preset?.default_trickle_flow_m3_h)
      ? Math.max(0, preset.default_trickle_flow_m3_h)
      : Math.max(0, flow * (defaultType.includes('heat_exchanger') ? 0.7 : 0.15)));
  const boostHoursPerDay = Number.isFinite(opts.boost_hours_per_day)
    ? Math.max(0, Math.min(24, opts.boost_hours_per_day))
    : (Number.isFinite(preset?.default_boost_hours_per_day)
      ? Math.max(0, Math.min(24, preset.default_boost_hours_per_day))
      : 1);

  const ventType = opts.type || preset?.type || 'extractor_bathroom';
  const baseName = preset?.name || (ventType === 'heat_exchanger' ? 'Heat Exchanger' : 'Extractor Fan');

  zone.ventilation_elements.push({
    id: generateId('id'),
    ventilation_id: preset?.id || opts.ventilationId || null,
    type: ventType,
    name: baseName,
    flow_m3_h: Number(flow.toFixed(2)),
    trickle_flow_m3_h: Number(trickleFlow.toFixed(2)),
    boost_hours_per_day: Number(boostHoursPerDay.toFixed(2)),
    heat_recovery_efficiency: Number(recovery.toFixed(3)),
    enabled: true
  });

  return true;
}

function getTargetZoneId(context = {}) {
  const selectedZoneId = context.selectedZoneId || null;
  if (selectedZoneId) return selectedZoneId;
  const contextDemo = context?.demo;
  const selectedLevel = Number.isFinite(context?.selectedLevel) ? Number(context.selectedLevel) : null;
  if (contextDemo && Array.isArray(contextDemo.zones)) {
    const roomZones = contextDemo.zones.filter(zone => zone && zone.type !== 'boundary');
    if (selectedLevel !== null) {
      const onLevel = roomZones.find(zone => (Number.isFinite(zone?.level) ? zone.level : 0) === selectedLevel);
      if (onLevel?.id) return onLevel.id;
    }
    if (roomZones[0]?.id) return roomZones[0].id;
  }
  return lastFocusedZoneId || null;
}

function getFallbackEditableZoneId(demo) {
  const zones = Array.isArray(demo?.zones) ? demo.zones : [];
  const firstRoom = zones.find(zone => zone && zone.type !== 'boundary');
  return firstRoom?.id || null;
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
  const heatingDefaults = getHeatingCostDefaults(getRecommendationCostModel());
  const blank = {
    meta: {
      name: 'Blank Project',
      global_target_temperature: 21,
      systemMinExternalTemp: 3,
      seasonalMinExternalTemp: 3,
      seasonalMaxExternalTemp: 16,
      externalTemp: 3,
      indoorTemp: 21,
      flowTemp: 55,
      heatSourceType: 'gas_boiler',
      gasUnitRate: heatingDefaults.gasRate,
      electricUnitRate: heatingDefaults.electricRate,
      gasBoilerEfficiency: heatingDefaults.gasBoilerEfficiency,
      heatPumpScopMode: 'auto',
      heatPumpFixedScop: heatingDefaults.heatPumpScop,
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

  try {
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
      currentDemo.meta.systemMinExternalTemp = value;
      currentDemo.meta.externalTemp = value;
      triggerSolve();
      return;
    }
    case 'environment.set.seasonal_min': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.seasonalMinExternalTemp = value;
      triggerSolve();
      return;
    }
    case 'environment.set.seasonal_max': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.seasonalMaxExternalTemp = value;
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
    case 'environment.set.heat_source': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const source = String(payload.value || '').trim().toLowerCase();
      if (!['gas_boiler', 'heat_pump', 'direct_electric'].includes(source)) return;
      if (String(currentDemo.meta.heatSourceType || '') === source) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.heatSourceType = source;
      triggerSolve();
      return;
    }
    case 'environment.set.gas_rate': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.gasUnitRate = clampNumber(value, 0.01, 2);
      triggerSolve();
      return;
    }
    case 'environment.set.electric_rate': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.electricUnitRate = clampNumber(value, 0.01, 2);
      triggerSolve();
      return;
    }
    case 'environment.set.gas_efficiency': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.gasBoilerEfficiency = clampNumber(value, 0.6, 0.99);
      triggerSolve();
      return;
    }
    case 'environment.set.hp_scop_mode': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const mode = String(payload.value || '').trim().toLowerCase() === 'fixed' ? 'fixed' : 'auto';
      if (String(currentDemo.meta.heatPumpScopMode || 'auto') === mode) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.heatPumpScopMode = mode;
      triggerSolve();
      return;
    }
    case 'environment.set.hp_scop_fixed': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.heatPumpFixedScop = clampNumber(value, 1.8, 6);
      triggerSolve();
      return;
    }
    case 'environment.set.cop_mode': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const mode = String(payload.value || '').trim().toLowerCase() === 'fixed' ? 'fixed' : 'auto';
      if (String(currentDemo.meta.copMode || 'auto') === mode) return;
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.copMode = mode;
      triggerSolve();
      return;
    }
    case 'environment.set.cop_fixed_value': {
      if (!currentDemo) return;
      currentDemo.meta = currentDemo.meta || {};
      const value = Number(payload.value);
      if (!Number.isFinite(value)) return;
      const sourceType = String(currentDemo.meta.heatSourceType || 'gas_boiler').trim().toLowerCase();
      const clamped = sourceType === 'heat_pump'
        ? clampNumber(value, 1.8, 6)
        : clampNumber(value, 0.6, 0.99);
      pushUndoSnapshot(deepClone(currentDemo));
      currentDemo.meta.copFixedValue = clamped;
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
    case 'project.rename': {
      if (!currentDemo) return;
      const nextName = String(payload.name || '').trim() || 'Unnamed Project';
      const currentName = String(currentDemo?.meta?.name || '').trim() || 'Unnamed Project';
      if (nextName === currentName) return;

      currentDemo.meta = currentDemo.meta || {};
      currentDemo.meta.name = nextName;
      syncActiveVariantSnapshot();

      if (latestRenderedVariantMenuState) {
        const renderDemo = latestRenderedVizDemo || currentDemo;
        renderDemo.meta = renderDemo.meta || {};
        renderDemo.meta.name = nextName;
        renderCurrentAlternativeViz(
          renderDemo,
          getVariantStateForMenu(),
          latestRenderedRecommendations,
          recommendationsEnabled && (recommendationApplyInProgress || recommendationsRefreshHandle !== null)
        );
      }
      return;
    }
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
    case 'recommendations.apply': {
      if (!currentDemo) return;
      if (!recommendationsEnabled) return;
      if (recommendationApplyInProgress) return;
      const recommendationId = String(payload.recommendationId || '');
      if (!recommendationId) return;
      const recommendationsBeforeApply = Array.isArray(latestRenderedRecommendations)
        ? latestRenderedRecommendations.slice()
        : [];
      recommendationApplyInProgress = true;
      recommendationApplyText = 'Applying recommendation and recalculating rooms...';
      recommendationApplyId = recommendationId;
      latestRenderedRecommendations = recommendationsBeforeApply.filter(item => String(item?.recommendationId || '') !== recommendationId);
      if (latestRenderedVizDemo && latestRenderedVariantMenuState) {
        renderCurrentAlternativeViz(
          latestRenderedVizDemo,
          latestRenderedVariantMenuState,
          latestRenderedRecommendations,
          true
        );
      }
      if (appUiApi?.setStatus) {
        appUiApi.setStatus('Applying recommendation and recalculating...');
      }
      const before = deepClone(currentDemo);
      if (applyRecommendationById(currentDemo, recommendationId)) {
        pushUndoSnapshot(before);
        triggerSolve();
      } else if (appUiApi?.setStatus) {
        recommendationApplyInProgress = false;
        recommendationApplyText = '';
        recommendationApplyId = '';
        latestRenderedRecommendations = recommendationsBeforeApply;
        if (latestRenderedVizDemo && latestRenderedVariantMenuState) {
          renderCurrentAlternativeViz(
            latestRenderedVizDemo,
            latestRenderedVariantMenuState,
            latestRenderedRecommendations,
            true
          );
        }
        scheduleRecommendationsRefresh(deepClone(currentDemo), latestSolveRevision);
        appUiApi.setStatus(`Could not apply recommendation: ${recommendationId}`);
      }
      return;
    }
    case 'recommendations.toggle': {
      const hasEnabledPayload = typeof payload.enabled === 'boolean';
      const nextEnabled = hasEnabledPayload ? payload.enabled : !recommendationsEnabled;
      if (nextEnabled === recommendationsEnabled) return;

      recommendationsEnabled = nextEnabled;
      recommendationApplyInProgress = false;
      recommendationApplyText = '';
      recommendationApplyId = '';

      if (!recommendationsEnabled) {
        cancelLowPriority(recommendationsRefreshHandle);
        recommendationsRefreshHandle = null;
        latestRenderedRecommendations = [];
        if (latestRenderedVizDemo && latestRenderedVariantMenuState) {
          renderCurrentAlternativeViz(
            latestRenderedVizDemo,
            latestRenderedVariantMenuState,
            [],
            false
          );
        }
        if (appUiApi?.setStatus) {
          appUiApi.setStatus('Recommendations disabled.');
        }
      } else {
        if (appUiApi?.setStatus) {
          appUiApi.setStatus('Recommendations enabled. Recalculating...');
        }
        triggerSolve();
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
    case 'openings.air_bricks.add':
    case 'openings.air_bricks.types.standard_sizes': {
      if (!currentDemo || !selectedZoneId) return;
      const before = deepClone(currentDemo);
      if (addAirBrickToZoneWall(currentDemo, currentOpenings, selectedZoneId, {
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
    case 'hvac.radiators.add':
    case 'hvac.radiators.standard_sizes.trv':
    case 'hvac.radiators.standard_sizes.no_trv': {
      if (!currentDemo) return;
      const targetZoneId = selectedZoneId || getFallbackEditableZoneId(currentDemo);
      if (!targetZoneId) {
        if (appUiApi?.setStatus) appUiApi.setStatus('Select a room before adding a radiator.');
        return;
      }
      const before = deepClone(currentDemo);
      const trv = typeof payload.trvEnabled === 'boolean' ? payload.trvEnabled : action.endsWith('.trv');
      if (addRadiatorToZone(currentDemo, currentRadiators, targetZoneId, trv, {
        width: Number(payload.width),
        height: Number(payload.height),
        radiatorId: payload.radiatorId
      })) {
        pushUndoSnapshot(before);
        lastFocusedZoneId = targetZoneId;
        if (appUiApi?.setStatus) appUiApi.setStatus('Radiator added.');
        triggerSolve();
        if (roomEditorApi?.focusZone) roomEditorApi.focusZone(targetZoneId);
      } else if (appUiApi?.setStatus) {
        appUiApi.setStatus('Could not add radiator to the selected room.');
      }
      return;
    }
    case 'hvac.boiler_thermostat': {
      if (!currentDemo || !selectedZoneId) return;
      const zone = getZoneById(currentDemo, selectedZoneId);
      if (!zone) return;
      pushUndoSnapshot(deepClone(currentDemo));
      moveBoilerControlThermostatToZone(currentDemo, selectedZoneId);
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
        trickle_flow_m3_h: Number(payload.trickle_flow_m3_h),
        boost_hours_per_day: Number(payload.boost_hours_per_day),
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
  } catch (error) {
    console.error(`[alt-viz menu] failed action: ${action}`, error);
    if (appUiApi?.setStatus) {
      appUiApi.setStatus(`Action failed (${action}): ${String(error?.message || error)}`);
    }
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

  let templateDemo = await tryFetchJson('./source/resources/demo_house_template.json');
  if (!templateDemo) {
    console.warn('Failed to load demo_house_template.json, falling back to demo_house.json for template mode');
    templateDemo = deepClone(demo);
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
          default_trickle_flow_m3_h: 8,
          default_boost_hours_per_day: 1,
          default_heat_recovery_efficiency: 0,
          enabled: true
        },
        {
          id: 'extractor_bathroom',
          name: 'Bathroom Vent',
          type: 'extractor_bathroom',
          default_flow_m3_h: 30,
          default_trickle_flow_m3_h: 5,
          default_boost_hours_per_day: 1,
          default_heat_recovery_efficiency: 0,
          enabled: true
        },
        {
          id: 'heat_exchanger_mvhr',
          name: 'Heat Exchanger (MVHR)',
          type: 'heat_exchanger',
          default_flow_m3_h: 55,
          default_trickle_flow_m3_h: 35,
          default_boost_hours_per_day: 1,
          default_heat_recovery_efficiency: 0.75,
          enabled: true
        }
      ]
    };
  }

  let costs = await tryFetchJson('./source/resources/costs.json');
  if (!costs) {
    console.warn('Failed to load costs.json, using fallback recommendation costs');
    costs = getRecommendationCostModel();
  }
  
  return [ins, demo, templateDemo, rads, openings, ventilation, costs];
}

function getOpeningMaterials(openings) {
  if (!openings) return [];
  const windows = Array.isArray(openings.windows) ? openings.windows : [];
  const airBricks = Array.isArray(openings.air_bricks) ? openings.air_bricks : [];
  const doors = Array.isArray(openings.doors) ? openings.doors : [];
  const asMaterial = (item) => ({
    id: item.id,
    name: item.name,
    u_value: item.u_value,
    air_leakage_m3_h_m2: item.air_leakage_m3_h_m2,
    trickle_vent_flow_m3_h: item.trickle_vent_flow_m3_h
  });
  return [...windows.map(asMaterial), ...airBricks.map(asMaterial), ...doors.map(asMaterial)];
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
  const listKey = (openingKind === 'window' || openingKind === 'air_brick') ? 'windows' : 'doors';
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
  const targetListKey = (openingKind === 'window' || openingKind === 'air_brick') ? 'windows' : 'doors';
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
      : getSystemMinOutsideTemp(demoRaw?.meta);
    const flowTemp = inputTemps && typeof inputTemps.flowTemp === 'number' && isFinite(inputTemps.flowTemp)
      ? inputTemps.flowTemp
      : (Number.isFinite(demoRaw?.meta?.flowTemp) ? Number(demoRaw.meta.flowTemp) : 55);

    const heatResults = computeRoomHeatRequirements(demoRaw, radiators, { indoorTemp, externalTemp, flowTemp });

    // Annotate demo JSON with results
    demoRaw.meta = demoRaw.meta || {};
    demoRaw.meta.indoorTemp = indoorTemp;
    demoRaw.meta.systemMinExternalTemp = externalTemp;
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
    const seasonalBounds = getSeasonalOutsideTempBounds(demoRaw.meta);
    demoRaw.meta.seasonalMinExternalTemp = seasonalBounds.seasonalMin;
    demoRaw.meta.seasonalMaxExternalTemp = seasonalBounds.seasonalMax;
    const annualModel = computeSeasonalAnnualEnergyModel(demoRaw, radiators, getRecommendationCostModel());
    const annualHeatDemandKwhYr = Number(annualModel.annualHeatDemandKwhYr || 0);
    // COP should be calculated at the modulated effective flow temp, not the user's max cap.
    const effectiveFlowTempForCop = Number.isFinite(heatResults.effectiveFlowTemp)
      ? heatResults.effectiveFlowTemp
      : flowTemp;
    const heatingInputs = getNormalizedHeatingInputs(demoRaw.meta, effectiveFlowTempForCop, getRecommendationCostModel());
    demoRaw.meta.heatSourceType = heatingInputs.heatSourceType;
    demoRaw.meta.gasUnitRate = heatingInputs.gasRate;
    demoRaw.meta.electricUnitRate = heatingInputs.electricRate;
    demoRaw.meta.gasBoilerEfficiency = heatingInputs.gasBoilerEfficiency;
    demoRaw.meta.gasBoilerAutoCop = heatingInputs.gasBoilerAutoCop;
    demoRaw.meta.heatPumpScopMode = heatingInputs.heatPumpScopMode;
    demoRaw.meta.heatPumpFixedScop = heatingInputs.heatPumpFixedScop;
    demoRaw.meta.heatPumpAutoScop = heatingInputs.heatPumpAutoScop;
    demoRaw.meta.effective_scop = heatingInputs.effectiveScop;
    demoRaw.meta.effective_system_cop = heatingInputs.effectiveSystemCop;
    demoRaw.meta.effective_boiler_cop = heatingInputs.effectiveBoilerCop;
    demoRaw.meta.annual_heat_demand_kwh_yr = annualHeatDemandKwhYr;
    demoRaw.meta.annual_input_energy_kwh_yr = annualModel.annualInputEnergyKwhYr;
    demoRaw.meta.annual_running_cost = annualModel.annualRunningCost;
    demoRaw.meta.annual_average_system_cop = annualModel.annualAverageCop;
    demoRaw.meta.effective_system_efficiency = annualModel.annualAverageCop;

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
    latestSolveRevision += 1;
    const solveRevision = latestSolveRevision;
    demoRaw.meta = demoRaw.meta || {};
    if (variantMenuState.activeVariantId) {
      demoRaw.meta.active_variant_id = variantMenuState.activeVariantId;
    }
    if (variantMenuState.activeVariantName) {
      demoRaw.meta.active_variant_name = variantMenuState.activeVariantName;
    }

    renderCurrentAlternativeViz(
      demoRaw,
      variantMenuState,
      recommendationsEnabled ? latestRenderedRecommendations : [],
      recommendationsEnabled
    );
    scheduleRecommendationsRefresh(deepClone(demoRaw), solveRevision);
    if (roomEditorApi && typeof roomEditorApi.refreshSelectedZone === 'function') {
      roomEditorApi.refreshSelectedZone();
    }

    // Output results
    const solved = JSON.stringify(demoRaw, null, 2);
    if (appUiApi) appUiApi.setSolvedOutput(solved);
  } catch (err) {
    recommendationApplyInProgress = false;
    recommendationApplyText = '';
    recommendationApplyId = '';
    if (appUiApi) appUiApi.setStatus('Solver error: ' + String(err));
    console.error(err);
  }
}

function triggerSolve() {
  if (!currentDemo) return;

  if (isSolveRunning) {
    solveRequestedWhileRunning = true;
    return;
  }

  if (scheduledSolveHandle !== null) return;

  scheduledSolveHandle = scheduleAnimationFrame(() => {
    scheduledSolveHandle = null;
    if (!currentDemo) return;

    isSolveRunning = true;
    solveRequestedWhileRunning = false;

    try {
      syncActiveVariantSnapshot();
      const polygonsByZoneId = collectLayoutPolygonsByZoneId(currentDemo);
      if (Object.keys(polygonsByZoneId).length > 0) {
        reconcileWallElementsFromPolygons(currentDemo, polygonsByZoneId);
        reconcileInterlevelElementsFromPolygons(currentDemo, polygonsByZoneId);
      }

      Promise.resolve(solveAndRender(JSON.parse(JSON.stringify(currentDemo))))
        .finally(() => {
          isSolveRunning = false;
          if (solveRequestedWhileRunning) {
            solveRequestedWhileRunning = false;
            triggerSolve();
          }
        });
    } catch (error) {
      isSolveRunning = false;
      if (appUiApi) appUiApi.setStatus('Solver error: ' + String(error));
      console.error(error);
      if (solveRequestedWhileRunning) {
        solveRequestedWhileRunning = false;
        triggerSolve();
      }
    }
  });
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

function getDefaultStudPirTemplateId(demo) {
  const templates = (demo?.meta && demo.meta.build_up_templates) || {};
  const entries = Object.entries(templates);
  if (entries.length === 0) return null;

  const exact = entries.find(([, tpl]) => {
    const name = String(tpl?.name || '').trim().toLowerCase();
    return name === 'external wall - insulated (stud + pir)';
  });
  if (exact) return exact[0];

  const contains = entries.find(([, tpl]) => {
    const name = String(tpl?.name || '').trim().toLowerCase();
    return name.includes('stud + pir') || (name.includes('external wall') && name.includes('insulated'));
  });
  if (contains) return contains[0];

  if (templates.buo_02) return 'buo_02';
  return null;
}

function getMostCommonExternalWallTemplateIdForLevel(demo, level, outsideId, zoneById) {
  if (!outsideId) return null;
  const counts = new Map();
  const elements = Array.isArray(demo?.elements) ? demo.elements : [];

  elements.forEach(element => {
    if (!element || String(element?.type || '').toLowerCase() !== 'wall') return;
    const templateId = String(element?.build_up_template_id || '');
    if (!templateId) return;
    const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
    if (!nodes.includes(outsideId)) return;

    const hasSameLevelHeatedNode = nodes.some(nodeId => {
      const zone = zoneById.get(nodeId);
      if (!zone || zone.type === 'boundary') return false;
      return getZoneLevel(zone) === level;
    });
    if (!hasSameLevelHeatedNode) return;

    counts.set(templateId, Number(counts.get(templateId) || 0) + 1);
  });

  let bestId = null;
  let bestCount = -1;
  for (const [templateId, count] of counts.entries()) {
    if (count > bestCount) {
      bestId = templateId;
      bestCount = count;
    }
  }
  return bestId;
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
  const wallEntries = [];
  const totalsByBaseName = new Map();

  for (const element of demo.elements) {
    if (!element || String(element.type || '').toLowerCase() !== 'wall') continue;
    if (!Array.isArray(element.nodes) || element.nodes.length < 2) continue;
    const baseName = buildDynamicWallName(element.nodes, zoneById, polygonByZoneId, boundaryIds);
    wallEntries.push({ element, baseName });
    totalsByBaseName.set(baseName, Number(totalsByBaseName.get(baseName) || 0) + 1);
  }

  const seenByBaseName = new Map();
  wallEntries.forEach(entry => {
    const duplicateTotal = Number(totalsByBaseName.get(entry.baseName) || 0);
    if (duplicateTotal <= 1) {
      entry.element.name = entry.baseName;
      return;
    }
    const ordinal = Number(seenByBaseName.get(entry.baseName) || 0) + 1;
    seenByBaseName.set(entry.baseName, ordinal);
    entry.element.name = `${entry.baseName} (${ordinal})`;
  });
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
      const zoneLevel = getZoneLevel(zoneById.get(zoneId));
      const commonExternalTemplateId = getMostCommonExternalWallTemplateIdForLevel(demo, zoneLevel, outsideId, zoneById);
      const defaultStudPirTemplateId = getDefaultStudPirTemplateId(demo);
      const fallbackTemplateId = commonExternalTemplateId || defaultStudPirTemplateId || null;
      const inheritSource = existingForSignature[0]
        || existingWalls.find(wall => {
          const canonical = canonicalizeWallRecord(wall.nodes, wall.orientation, boundaryIds);
          return canonical.nodes[0] === zoneId || canonical.nodes[1] === zoneId;
        })
        || (fallbackTemplateId ? { build_up_template_id: fallbackTemplateId } : null)
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
    const [ins, demo, templateDemo, rads, openings, ventilation, costs] = await loadDefaultInputs();
    console.log('Loaded data:', { ins: !!ins, demo: !!demo, templateDemo: !!templateDemo, rads: !!rads, openings: !!openings, ventilation: !!ventilation, costs: !!costs });
    currentMaterials = ins;
    currentRadiators = rads;
    currentDemo = demo;
    currentOpenings = openings;
    currentVentilation = ventilation;
    currentCosts = costs;
    defaultDemoTemplate = deepClone(templateDemo || demo);
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
