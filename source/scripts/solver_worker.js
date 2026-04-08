// solver_worker.js
// Web Worker module for offloading thermal computation from the main thread.
// Handles 'solve' and 'recommendations' message types, allowing parallelised
// solves (especially beneficial when computing multiple recommendations).
//
// Exports processSolvePayload() and processRecommendationsPayload() as pure
// functions so they can be imported directly in unit tests.

import { computeElementU } from './u_value_calculator.js';
import { computeRoomHeatRequirements } from './heat_calculator.js';
import { estimateHeatPumpCopFromFlowTemp, estimateBoilerCopFromFlowTemp } from './heating_performance.js';
import {
  getRecommendationCostModel,
  buildPerformanceRecommendations,
  applyRecommendationById
} from './recommendations.js';

// ---------------------------------------------------------------------------
// Pure utility helpers (no catalog state)
// ---------------------------------------------------------------------------

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!isFinite(numeric)) return min;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

function getHeatingCostDefaults(costModel) {
  const heating = costModel?.heating || {};
  return {
    gasRate: Number(heating.gas_rate_per_kwh ?? 0.07),
    electricRate: Number(heating.electric_rate_per_kwh ?? 0.24),
    gasBoilerEfficiency: Number(heating.gas_boiler_efficiency ?? 0.9),
    heatPumpScop: Number(heating.heat_pump_scop ?? 3.2),
  };
}

function getSystemMinOutsideTemp(meta) {
  const raw = Number(meta?.systemMinExternalTemp);
  if (isFinite(raw)) return raw;
  const raw2 = Number(meta?.externalTemp);
  if (isFinite(raw2)) return raw2;
  return -3;
}

function getSeasonalOutsideTempBounds(meta) {
  const rawMin = Number(meta?.seasonalMinExternalTemp);
  const rawMax = Number(meta?.seasonalMaxExternalTemp);
  const seasonalMin = isFinite(rawMin) ? rawMin : getSystemMinOutsideTemp(meta);
  const seasonalMax = isFinite(rawMax) ? rawMax : 16;
  return { seasonalMin, seasonalMax };
}

function getSeasonalOutsideTempForMonth(monthIndex, seasonalMin, seasonalMax) {
  const offset = (seasonalMin + seasonalMax) / 2;
  const amplitude = (seasonalMax - seasonalMin);
  const monthNumber = monthIndex + 1;
  const phase = ((2 * Math.PI) / 12) * monthNumber;
  return offset + (amplitude * Math.sin(phase));
}

function computeAnnualRunningCostFromDemand(annualHeatDemandKwhYr, heatingInputs) {
  const demand = Number(annualHeatDemandKwhYr);
  if (!isFinite(demand) || demand <= 0) {
    return { annualInputEnergyKwhYr: 0, annualRunningCost: 0 };
  }
  const cop = Number(heatingInputs?.effectiveSystemCop);
  const effectiveCop = isFinite(cop) && cop > 0 ? cop : 1;
  const annualInputEnergyKwhYr = demand / effectiveCop;
  const sourceType = String(heatingInputs?.heatSourceType || 'gas_boiler');
  let rate = 0;
  if (sourceType === 'heat_pump') {
    rate = Number(heatingInputs?.electricRate ?? 0.24);
  } else if (sourceType === 'direct_electric') {
    rate = Number(heatingInputs?.electricRate ?? 0.24);
  } else {
    rate = Number(heatingInputs?.gasRate ?? 0.07);
  }
  const annualRunningCost = annualInputEnergyKwhYr * (isFinite(rate) && rate > 0 ? rate : 0);
  return { annualInputEnergyKwhYr, annualRunningCost };
}

export function computeSeasonalAnnualEnergyModel(demo, radiators, costModel) {
  const meta = demo?.meta || {};
  const seasonalBounds = getSeasonalOutsideTempBounds(meta);
  const { seasonalMin, seasonalMax } = seasonalBounds;
  const indoorTemp = Number.isFinite(meta.indoorTemp) ? Number(meta.indoorTemp) : 21;
  const flowTemp = Number.isFinite(meta.flowTemp) ? Number(meta.flowTemp) : 55;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  let annualHeatDemandKwhYr = 0;
  let annualInputEnergyKwhYr = 0;
  let annualRunningCost = 0;
  let weightedCopSum = 0;
  let weightedDemandSum = 0;

  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const externalTemp = getSeasonalOutsideTempForMonth(monthIndex, seasonalMin, seasonalMax);
    const heat = computeRoomHeatRequirements(demo, radiators, { indoorTemp, externalTemp, flowTemp });
    const monthHours = monthDays[monthIndex] * 24;
    const monthDemandKwh = (Number(heat.total_delivered_heat || 0) * monthHours) / 1000;
    if (monthDemandKwh <= 0) continue;

    const effectiveFlowTemp = Number.isFinite(heat.effectiveFlowTemp) ? heat.effectiveFlowTemp : flowTemp;
    const monthHeatingInputs = getNormalizedHeatingInputs(meta, effectiveFlowTemp, costModel);
    const { annualInputEnergyKwhYr: monthInput, annualRunningCost: monthCost } =
      computeAnnualRunningCostFromDemand(monthDemandKwh, monthHeatingInputs);

    annualHeatDemandKwhYr += monthDemandKwh;
    annualInputEnergyKwhYr += monthInput;
    annualRunningCost += monthCost;

    const monthCop = Number(monthHeatingInputs?.effectiveSystemCop);
    if (isFinite(monthCop) && monthCop > 0) {
      weightedCopSum += monthCop * monthDemandKwh;
      weightedDemandSum += monthDemandKwh;
    }
  }

  const annualAverageCop = weightedDemandSum > 0 ? weightedCopSum / weightedDemandSum : 1;
  return { annualHeatDemandKwhYr, annualInputEnergyKwhYr, annualRunningCost, annualAverageCop };
}

function getNormalizedHeatingInputs(meta, flowTemp, costModel) {
  const defaults = getHeatingCostDefaults(costModel);
  const heatSourceType = String(meta?.heatSourceType || 'gas_boiler');
  const gasRate = isFinite(Number(meta?.gasUnitRate)) ? Number(meta.gasUnitRate) : defaults.gasRate;
  const electricRate = isFinite(Number(meta?.electricUnitRate)) ? Number(meta.electricUnitRate) : defaults.electricRate;
  const gasBoilerEfficiency = clampNumber(
    isFinite(Number(meta?.gasBoilerEfficiency)) ? Number(meta.gasBoilerEfficiency) : defaults.gasBoilerEfficiency,
    0.6, 0.99
  );
  const nominalFlowTemp = isFinite(Number(flowTemp)) ? Number(flowTemp) : 55;

  let heatSourceLabel = '';
  let effectiveScop = 1;
  let effectiveSystemCop = 1;
  let effectiveBoilerCop = 1;

  if (heatSourceType === 'heat_pump') {
    heatSourceLabel = 'Heat Pump';
    const scopMode = String(meta?.heatPumpScopMode || 'auto');
    const fixedScop = Number(meta?.heatPumpFixedScop);
    let autoScop = estimateHeatPumpCopFromFlowTemp(nominalFlowTemp);
    if (scopMode === 'fixed' && isFinite(fixedScop) && fixedScop > 0) {
      effectiveScop = clampNumber(fixedScop, 1, 6);
    } else {
      effectiveScop = autoScop;
    }
    effectiveSystemCop = effectiveScop;
    effectiveBoilerCop = 1;
  } else if (heatSourceType === 'direct_electric') {
    heatSourceLabel = 'Direct Electric';
    effectiveScop = 1;
    effectiveSystemCop = 1;
    effectiveBoilerCop = 1;
  } else {
    heatSourceLabel = 'Gas Boiler';
    const autoCop = estimateBoilerCopFromFlowTemp(nominalFlowTemp, gasBoilerEfficiency);
    effectiveBoilerCop = autoCop;
    effectiveScop = 1;
    effectiveSystemCop = autoCop;
  }

  return {
    heatSourceType,
    heatSourceLabel,
    gasRate,
    electricRate,
    gasBoilerEfficiency,
    heatPumpScopMode: String(meta?.heatPumpScopMode || 'auto'),
    heatPumpFixedScop: isFinite(Number(meta?.heatPumpFixedScop)) ? Number(meta.heatPumpFixedScop) : null,
    heatPumpAutoScop: heatSourceType === 'heat_pump' ? estimateHeatPumpCopFromFlowTemp(nominalFlowTemp) : null,
    effectiveScop,
    effectiveSystemCop,
    effectiveBoilerCop
  };
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
  if (!opening) return 0;
  const explicit = Number(opening.area);
  if (isFinite(explicit) && explicit > 0) return explicit;
  const w = Number(opening.width);
  const h = Number(opening.height);
  if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
    const widthM = w > 10 ? w / 1000 : w;
    const heightM = h > 10 ? h / 1000 : h;
    return widthM * heightM;
  }
  return 0;
}

function getElementNetInsulationAreaM2(element) {
  if (!element) return 0;
  const gross = getElementAreaM2(element);
  if (gross <= 0) return 0;
  const windows = Array.isArray(element.windows) ? element.windows : [];
  const doors = Array.isArray(element.doors) ? element.doors : [];
  const openingsArea = [...windows, ...doors].reduce((sum, opening) => {
    return sum + getOpeningAreaFromSpecM2(opening);
  }, 0);
  return Math.max(0, gross - openingsArea);
}

function resolveElementBuildUpForEdit(element, templates) {
  if (!element) return [];
  if (Array.isArray(element.build_up)) return element.build_up;
  const templateId = String(element.build_up_template_id || '');
  if (templateId && templates && templates[templateId]) {
    return deepClone(templates[templateId]) || [];
  }
  return [];
}

function formatCurrencyEstimate(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return null;
  const sym = String(currency || 'GBP').toUpperCase() === 'GBP' ? '£' : String(currency || '');
  if (n < 10) return `${sym}${n.toFixed(2)}`;
  if (n < 100) return `${sym}${Math.round(n)}`;
  return `${sym}${Math.round(n / 10) * 10}`;
}

function formatCurrencyAmount(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return null;
  const sym = String(currency || 'GBP').toUpperCase() === 'GBP' ? '£' : String(currency || '');
  return `${sym}${Math.abs(n) < 1 ? n.toFixed(2) : Math.round(n)}`;
}

function normalizeCostResult(costResult, currency) {
  if (!costResult) return { total: 0, formattedTotal: null, formattedBreakdown: [] };
  const total = Number(costResult.total || 0);
  const sym = String(currency || 'GBP').toUpperCase() === 'GBP' ? '£' : String(currency || '');
  const formattedTotal = isFinite(total) && total > 0
    ? `${sym}${Math.round(total / 10) * 10}`
    : null;
  const breakdown = Array.isArray(costResult.breakdown) ? costResult.breakdown : [];
  const formattedBreakdown = breakdown
    .filter(item => item && isFinite(Number(item.amount)) && Number(item.amount) > 0)
    .map(item => ({
      label: String(item.label || ''),
      amount: formatCurrencyAmount(item.amount, currency)
    }));
  return { total, formattedTotal, formattedBreakdown };
}

function formatCountMap(countMap, emptyLabel = 'none') {
  if (!countMap || typeof countMap !== 'object') return emptyLabel;
  const entries = Object.entries(countMap).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return emptyLabel;
  return entries.map(([k, v]) => `${k} ×${v}`).join(', ');
}

function formatTypeChangeMap(typeCountMap, resolver, emptyLabel = 'none') {
  if (!typeCountMap || typeof typeCountMap !== 'object') return emptyLabel;
  const entries = Object.entries(typeCountMap).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return emptyLabel;
  return entries.map(([k, v]) => {
    const label = typeof resolver === 'function' ? (resolver(k) || k) : k;
    return `${label} ×${v}`;
  }).join(', ');
}

function formatThicknessMm(thicknessM) {
  const mm = Math.round(Number(thicknessM) * 1000);
  return isFinite(mm) ? `${mm}mm` : '?mm';
}

function getFloorCompositeNonJoistMaterialIds(buildUp) {
  const compositeLayer = Array.isArray(buildUp)
    ? buildUp.find(layer => layer && layer.type === 'composite' && Array.isArray(layer.paths))
    : null;
  if (!compositeLayer) return [];
  return compositeLayer.paths
    .map(path => String(path?.material_id || ''))
    .filter(id => id && id !== 'joist_wood');
}

function getStructuralLayerThickness(buildUp, structuralMaterialIds = []) {
  if (!Array.isArray(buildUp) || buildUp.length === 0) return NaN;
  const ids = structuralMaterialIds.map(String);
  for (const layer of buildUp) {
    if (!layer) continue;
    if (layer.type === 'composite' && Array.isArray(layer.paths)) {
      const hasStructural = layer.paths.some(path => ids.includes(String(path?.material_id || '')));
      if (hasStructural) {
        const thickness = Number(layer.thickness);
        return isFinite(thickness) && thickness > 0 ? thickness : NaN;
      }
    } else if (ids.includes(String(layer?.material_id || ''))) {
      const thickness = Number(layer.thickness);
      return isFinite(thickness) && thickness > 0 ? thickness : NaN;
    }
  }
  return NaN;
}

function getWallRetrofitThicknessFromBuildUp(buildUp, cfg) {
  const fallbackWithinStud = Number(cfg?.fallback_thickness_m || 0.06);
  const maxWithinStud = Number(cfg?.max_within_stud_thickness_m || 0.1);
  const addServiceLayer = cfg?.add_internal_service_layer === true;
  const serviceLayerThickness = Number(cfg?.service_layer_thickness_m || 0.05);

  const joistThickness = getStructuralLayerThickness(buildUp, ['stud_wood', 'timber_frame']);
  const rawWithin = isFinite(joistThickness) && joistThickness > 0 ? joistThickness : fallbackWithinStud;
  const withinStudThickness = Math.min(rawWithin, isFinite(maxWithinStud) && maxWithinStud > 0 ? maxWithinStud : 0.1);
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

function getElementDisplayName(element, fallbackLabel) {
  if (!element) return String(fallbackLabel || 'Element');
  return String(element.name || element.id || fallbackLabel || 'Element');
}

function createUniqueElementNameResolver(elements, defaultFallbackLabel = 'Element') {
  const nameByType = {};
  return (element) => {
    if (!element) return defaultFallbackLabel;
    if (element.name) return element.name;
    const type = String(element.type || 'element').toLowerCase();
    nameByType[type] = (nameByType[type] || 0) + 1;
    return `${String(type).charAt(0).toUpperCase() + type.slice(1)} ${nameByType[type]}`;
  };
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

function getZoneById(demo, zoneId) {
  return Array.isArray(demo?.zones) ? demo.zones.find(zone => zone?.id === zoneId) : null;
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

// ---------------------------------------------------------------------------
// Catalog-aware helper factory
// ---------------------------------------------------------------------------

function createSolverHelpers(materials, openings, radiatorCatalog) {
  // materials is the merged list (base + opening materials)
  const matList = Array.isArray(materials) ? materials : [];
  const radList = Array.isArray(radiatorCatalog) ? radiatorCatalog : [];

  function getMaterialCatalogEntry(materialId) {
    const target = String(materialId || '');
    return matList.find(item => String(item?.id || '') === target) || null;
  }

  function getMaterialDisplayName(materialId) {
    const entry = getMaterialCatalogEntry(materialId);
    return entry?.name || String(materialId || '');
  }

  function getWindowCatalogEntry(windowId) {
    const wins = Array.isArray(openings?.windows) ? openings.windows : [];
    const air = Array.isArray(openings?.air_bricks) ? openings.air_bricks : [];
    return [...wins, ...air].find(item => String(item?.id || '') === String(windowId || '')) || null;
  }

  function getDoorCatalogEntry(doorId) {
    const doors = Array.isArray(openings?.doors) ? openings.doors : [];
    return doors.find(item => String(item?.id || '') === String(doorId || '')) || null;
  }

  function getInsulationMaterialCostPerM3(materialId) {
    const entry = getMaterialCatalogEntry(materialId);
    return Number(entry?.cost_per_m3 || 0);
  }

  function getInsulationMaterialCostPerM2(materialId, thicknessM, fallbackPerM2 = 0) {
    const costPerM3 = getInsulationMaterialCostPerM3(materialId);
    if (isFinite(costPerM3) && costPerM3 > 0 && isFinite(Number(thicknessM)) && Number(thicknessM) > 0) {
      return costPerM3 * Number(thicknessM);
    }
    const entry = getMaterialCatalogEntry(materialId);
    const perM2 = Number(entry?.cost_per_m2 || fallbackPerM2 || 0);
    return isFinite(perM2) ? perM2 : 0;
  }

  function refreshElementUFabricForDemo(demo) {
    const elements = Array.isArray(demo?.elements) ? demo.elements : [];
    const buildupTemplates = (demo?.meta && demo.meta.build_up_templates) || {};
    for (const el of elements) {
      try {
        computeElementU(el, matList, buildupTemplates);
      } catch (_) {
        // Ignore per-element failures while building recommendations.
      }
    }
  }

  function getRadiatorSizingConfig() {
    const list = Array.isArray(radList) ? radList : [];
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

    const rawWidths = [400, 600, 800, 1000, 1200, 1400, 1600, 1800];
    const widths = [...new Set(rawWidths.map(w => Number(w)).filter(w => isFinite(w) && w >= 300 && w <= 1800))].sort((a, b) => a - b);
    const standardWidths = widths.length > 0 ? widths : [400, 600, 800, 1000, 1200, 1400, 1600, 1800];

    return { coeffByType, typeOrder, standardWidths, defaultHeightMm: 600, maxWidthMm: 1800, minWidthMm: 400 };
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

  function pickBoilerControlZoneByHeatRatio(demo, externalTemp, nominalFlowTemp) {
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
      radList,
      { indoorTemp: 21, externalTemp, flowTemp: nominalFlowTemp }
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
        best = { zoneId, zoneName: String(room?.zoneName || zoneId), ratio, heatLoss };
      }
    });
    return best;
  }

  function getComfortSnapshotForDemo(demoRaw) {
    if (!demoRaw) return null;
    const working = deepClone(demoRaw);
    ensureBoundaryZones(working);

    const elements = Array.isArray(working.elements) ? working.elements : [];
    const buildupTemplates = (working.meta && working.meta.build_up_templates) || {};
    for (const el of elements) {
      try { computeElementU(el, matList, buildupTemplates); } catch (_) { /* ignore */ }
    }

    const indoorTemp = Number.isFinite(working?.meta?.indoorTemp) ? Number(working.meta.indoorTemp) : 21;
    const externalTemp = getSystemMinOutsideTemp(working?.meta);
    const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
    const heat = computeRoomHeatRequirements(working, radList, { indoorTemp, externalTemp, flowTemp });
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
      if (zoneId && isFinite(delivered)) zoneTempById[zoneId] = delivered;
      if (isFinite(delivered)) {
        if (delivered < 17.95) below18Count += 1;
        const setpoint = Number(room?.setpoint_temperature);
        const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
        if (delivered < targetTemp - 0.1) belowTargetCount += 1;
        minDeliveredTemp = Math.min(minDeliveredTemp, delivered);
      }
      if (room?.can_reach_setpoint === false) unmetSetpointRoomCount += 1;
    });

    return {
      below18Count, belowTargetCount, unmetSetpointRoomCount,
      minDeliveredTemp: isFinite(minDeliveredTemp) ? minDeliveredTemp : null,
      zoneTempById
    };
  }

  function getComfortDeficitRoomsForDemo(demoRaw) {
    if (!demoRaw) return { count: 0, below18Count: 0, rooms: [] };
    const working = deepClone(demoRaw);
    ensureBoundaryZones(working);
    refreshElementUFabricForDemo(working);

    const indoorTemp = Number.isFinite(working?.meta?.indoorTemp) ? Number(working.meta.indoorTemp) : 21;
    const externalTemp = getSystemMinOutsideTemp(working?.meta);
    const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
    const heat = computeRoomHeatRequirements(working, radList, { indoorTemp, externalTemp, flowTemp });
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
          currentTemp, targetTemp, shortfallC,
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

  function getComparisonMetricsForDemo(demoRaw, costModel) {
    if (!demoRaw) return null;
    const working = deepClone(demoRaw);
    ensureBoundaryZones(working);
    const elements = Array.isArray(working.elements) ? working.elements : [];
    const buildupTemplates = (working.meta && working.meta.build_up_templates) || {};
    for (const el of elements) {
      try { computeElementU(el, matList, buildupTemplates); } catch (_) { /* ignore */ }
    }

    const indoorTemp = Number.isFinite(working?.meta?.indoorTemp) ? Number(working.meta.indoorTemp) : 21;
    const externalTemp = getSystemMinOutsideTemp(working?.meta);
    const flowTemp = Number.isFinite(working?.meta?.flowTemp) ? Number(working.meta.flowTemp) : 55;
    const heat = computeRoomHeatRequirements(working, radList, { indoorTemp, externalTemp, flowTemp });
    const resolvedCostModel = costModel || getRecommendationCostModel(null);
    const annualModel = computeSeasonalAnnualEnergyModel(working, radList, resolvedCostModel);
    const annualDemand = Number(annualModel.annualHeatDemandKwhYr || 0);
    const effectiveFlowTempForCop = Number.isFinite(heat.effectiveFlowTemp) ? heat.effectiveFlowTemp : flowTemp;
    const heatingInputs = getNormalizedHeatingInputs(working?.meta, effectiveFlowTempForCop, resolvedCostModel);
    const runningCost = {
      annualInputEnergyKwh: annualModel.annualInputEnergyKwhYr,
      annualCost: annualModel.annualRunningCost,
      effectiveSystemEfficiency: annualModel.annualAverageCop,
      effectiveScop: annualModel.annualAverageCop
    };
    const roomCount = Array.isArray(heat.rooms) ? heat.rooms.length : 0;
    const unmetSetpointRoomCount = (Array.isArray(heat.rooms) ? heat.rooms : [])
      .filter(room => room && room.can_reach_setpoint === false).length;
    const totalFloorArea = (Array.isArray(heat.rooms) ? heat.rooms : [])
      .filter(r => !r.is_unheated)
      .reduce((sum, r) => {
        const area = Number(r.floorArea);
        return sum + (isFinite(area) && area > 0 ? area : 0);
      }, 0);
    const annualInputEnergy = Number(runningCost.annualInputEnergyKwh || 0);
    const intensityKwhM2Yr = totalFloorArea > 0 ? (annualInputEnergy / totalFloorArea) : null;
    const epcLetter = intensityKwhM2Yr !== null && isFinite(intensityKwhM2Yr)
      ? getEpcBandFromIntensity(intensityKwhM2Yr)
      : 'N/A';

    return {
      roomCount, epcLetter,
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

  function applyRadiatorComfortUpgrade(demo, options = {}) {
    const zones = Array.isArray(demo?.zones) ? demo.zones : [];
    const sizing = getRadiatorSizingConfig();
    const dominantTypeId = getHouseDominantRadiatorType(demo, sizing);

    const flowTempRaw = Number(demo?.meta?.flowTemp);
    const externalTempRaw = Number(demo?.meta?.systemMinExternalTemp);
    const flowTemp = isFinite(flowTempRaw) ? flowTempRaw : 55;
    const externalTemp = isFinite(externalTempRaw) ? externalTempRaw : getSystemMinOutsideTemp(demo?.meta);
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
      const heat = computeRoomHeatRequirements(demo, radList, {
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
    const heatBefore = computeRoomHeatRequirements(demo, radList, {
      indoorTemp: 21, externalTemp, flowTemp
    });

    const unmetRooms = Array.isArray(heatBefore?.rooms)
      ? heatBefore.rooms.filter(room => {
        if (!room || room.is_unheated === true) return false;
        const delivered = Number(room?.delivered_indoor_temperature);
        const setpoint = Number(room?.setpoint_temperature);
        const targetTemp = Math.max(18, isFinite(setpoint) ? setpoint : 18);
        return isFinite(delivered) ? delivered < targetTemp - 0.1 : true;
      })
      : [];

    if (unmetRooms.length === 0) {
      return {
        changed: false, totalAddedSurfaceArea: 0,
        unmetBefore: 0, unmetAfter: 0, below18Before: 0, below18After: 0,
        belowTargetBefore: 0, belowTargetAfter: 0, trvEnabledCount: 0,
        flowTempBefore: flowTemp, flowTempAfter: flowTemp, flowTempAdjusted: false,
        upgradedRooms: []
      };
    }

    const unmetZoneIdSet = new Set(unmetRooms.map(r => String(r?.zoneId || '')));
    const designPassZones = zones.map(z => {
      const base = { ...z, is_boiler_control: false };
      if (!unmetZoneIdSet.has(String(z?.id || ''))) return base;
      return { ...base, radiators: [{ radiator_id: dominantTypeId, surface_area: 200, trv_enabled: true }] };
    });
    const heatDesign = computeRoomHeatRequirements(
      { ...demo, zones: designPassZones },
      radList,
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
      if (deltaArea <= 0.001 && placedSpecs.length === existingRads.length) continue;

      upgradeByZoneId.set(zoneId, { zoneId, zoneName, addArea: deltaArea, before: existingRads, after: placedSpecs });
      totalAddedSurfaceArea += deltaArea;
    }

    if (upgradeByZoneId.size === 0) {
      return {
        changed: thermostatMoved, totalAddedSurfaceArea: 0,
        unmetBefore: unmetRooms.length, unmetAfter: unmetRooms.length,
        below18Before: unmetRooms.filter(r => Number(r?.delivered_indoor_temperature) < 17.95).length,
        below18After: unmetRooms.filter(r => Number(r?.delivered_indoor_temperature) < 17.95).length,
        belowTargetBefore: unmetRooms.length, belowTargetAfter: unmetRooms.length,
        trvEnabledCount: 0, flowTempBefore: flowTemp, flowTempAfter: flowTemp,
        flowTempAdjusted: false, thermostatMoved, thermostatTargetZoneName, upgradedRooms: []
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
        changed: thermostatMoved, totalAddedSurfaceArea: 0,
        unmetBefore: unmetRooms.length, unmetAfter: unmetRooms.length,
        below18Before: unmetRooms.filter(r => Number(r?.delivered_indoor_temperature) < 17.95).length,
        below18After: unmetRooms.filter(r => Number(r?.delivered_indoor_temperature) < 17.95).length,
        belowTargetBefore: unmetRooms.length, belowTargetAfter: unmetRooms.length,
        trvEnabledCount: 0, flowTempBefore: flowTemp, flowTempAfter: flowTemp,
        flowTempAdjusted: false, thermostatMoved, thermostatTargetZoneName, upgradedRooms: []
      };
    }

    const thermostatTarget = pickBoilerControlZoneByHeatRatio(demo, externalTemp, flowTemp);
    const thermostatTargetZoneId = String(thermostatTarget?.zoneId || '');
    thermostatTargetZoneName = String(thermostatTarget?.zoneName || thermostatTargetZoneId || '');
    thermostatMoved = thermostatTargetZoneId
      ? moveBoilerControlThermostatToZone(demo, thermostatTargetZoneId)
      : false;

    const baseComfortAfterUpgrade = evaluateComfortAtFlow(flowTemp);
    let workingFlowTemp = flowTemp;
    let workingComfort = baseComfortAfterUpgrade;

    if (workingComfort.belowTarget > 0 || workingComfort.unmet > 0) {
      let bestFlow = workingFlowTemp;
      let bestComfort = workingComfort;
      for (let candidate = Math.ceil(workingFlowTemp + 1); candidate <= Math.ceil(maxComfortFlowTemp); candidate += 1) {
        const comfortAtCandidate = evaluateComfortAtFlow(candidate);
        const improves =
          comfortAtCandidate.belowTarget < bestComfort.belowTarget
          || (comfortAtCandidate.belowTarget === bestComfort.belowTarget && comfortAtCandidate.unmet < bestComfort.unmet)
          || (comfortAtCandidate.belowTarget === bestComfort.belowTarget && comfortAtCandidate.unmet === bestComfort.unmet && comfortAtCandidate.below18 < bestComfort.below18);
        if (improves) { bestFlow = candidate; bestComfort = comfortAtCandidate; }
        if (bestComfort.belowTarget === 0 && bestComfort.unmet === 0) break;
      }
      workingFlowTemp = bestFlow;
      workingComfort = bestComfort;
    }

    let finalFlowTemp = workingFlowTemp;
    if (targetFlowTemp < workingFlowTemp - 0.5) {
      for (let candidate = Math.floor(workingFlowTemp - 1); candidate >= Math.ceil(targetFlowTemp); candidate -= 1) {
        const comfortAtCandidate = evaluateComfortAtFlow(candidate);
        if (comfortAtCandidate.belowTarget <= workingComfort.belowTarget
          && comfortAtCandidate.below18 <= workingComfort.below18
          && comfortAtCandidate.unmet <= workingComfort.unmet) {
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
    const upgradedRooms = [...upgradeByZoneId.values()]
      .sort((a, b) => String(a.zoneName).localeCompare(String(b.zoneName)))
      .map(entry => ({
        zoneId: entry.zoneId, zoneName: entry.zoneName,
        addArea: Number(entry.addArea || 0),
        finalSpecs: (Array.isArray(entry.after) ? entry.after : []).map(rad => ({
          radiatorId: String(rad?.radiator_id || ''),
          width: Number(rad?.width || 0),
          height: Number(rad?.height || 0)
        }))
      }));

    return {
      changed, totalAddedSurfaceArea,
      unmetBefore: unmetRooms.length, unmetAfter: finalComfort.unmet,
      below18Before: unmetRooms.filter(r => Number(r?.delivered_indoor_temperature) < 17.95).length,
      below18After: finalComfort.below18,
      belowTargetBefore: unmetRooms.length, belowTargetAfter: Number(finalComfort?.belowTarget || 0),
      trvEnabledCount, flowTempBefore: flowTemp, flowTempAfter: finalFlowTemp, flowTempAdjusted,
      thermostatMoved, thermostatTargetZoneName, upgradedRooms
    };
  }

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
    getEpcBandFromIntensity,
  };
}

// ---------------------------------------------------------------------------
// Exported computation functions (used by worker message handler + tests)
// ---------------------------------------------------------------------------

/**
 * Run the full thermal solve on the given payload.
 * @param {{ demoRaw: object, materials: object, openings: object,
 *           radiators: object, costs: object, inputTemps: object }} payload
 * @returns {{ annotatedDemo: object, heatResults: object,
 *             annualModel: object, heatingInputs: object,
 *             resolvedTemps: object }}
 */
export function processSolvePayload(payload) {
  const {
    demoRaw,
    materials: materialsRaw,
    openings,
    radiators: radiatorsRaw,
    costs,
    inputTemps = {}
  } = payload || {};

  if (!demoRaw) throw new Error('processSolvePayload: demoRaw is required');

  const baseMaterials = materialsRaw
    ? (Array.isArray(materialsRaw.materials) ? materialsRaw.materials : (Array.isArray(materialsRaw) ? materialsRaw : []))
    : [];
  const openingMaterials = getOpeningMaterials(openings);
  const materials = [...baseMaterials, ...openingMaterials];

  const radiatorCatalog = radiatorsRaw
    ? (Array.isArray(radiatorsRaw.radiators) ? radiatorsRaw.radiators : (Array.isArray(radiatorsRaw) ? radiatorsRaw : []))
    : [];

  const costModel = getRecommendationCostModel(costs);

  // Compute U-values
  const buildupTemplates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
  for (const el of (Array.isArray(demoRaw.elements) ? demoRaw.elements : [])) {
    try { computeElementU(el, materials, buildupTemplates); } catch (err) { el._calc_error = String(err); }
  }

  // Resolve temperatures
  const indoorTemp = (typeof inputTemps.indoorTemp === 'number' && isFinite(inputTemps.indoorTemp))
    ? inputTemps.indoorTemp
    : (Number.isFinite(demoRaw?.meta?.indoorTemp) ? Number(demoRaw.meta.indoorTemp) : 21);
  const externalTemp = (typeof inputTemps.externalTemp === 'number' && isFinite(inputTemps.externalTemp))
    ? inputTemps.externalTemp
    : getSystemMinOutsideTemp(demoRaw?.meta);
  const flowTemp = (typeof inputTemps.flowTemp === 'number' && isFinite(inputTemps.flowTemp))
    ? inputTemps.flowTemp
    : (Number.isFinite(demoRaw?.meta?.flowTemp) ? Number(demoRaw.meta.flowTemp) : 55);

  const heatResults = computeRoomHeatRequirements(demoRaw, radiatorCatalog, { indoorTemp, externalTemp, flowTemp });

  const seasonalBounds = getSeasonalOutsideTempBounds(demoRaw.meta);
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
  demoRaw.meta.seasonalMinExternalTemp = seasonalBounds.seasonalMin;
  demoRaw.meta.seasonalMaxExternalTemp = seasonalBounds.seasonalMax;

  const annualModel = computeSeasonalAnnualEnergyModel(demoRaw, radiatorCatalog, costModel);
  const effectiveFlowTempForCop = Number.isFinite(heatResults.effectiveFlowTemp)
    ? heatResults.effectiveFlowTemp
    : flowTemp;
  const heatingInputs = getNormalizedHeatingInputs(demoRaw.meta, effectiveFlowTempForCop, costModel);

  demoRaw.meta.heatSourceType = heatingInputs.heatSourceType;
  demoRaw.meta.gasUnitRate = heatingInputs.gasRate;
  demoRaw.meta.electricUnitRate = heatingInputs.electricRate;
  demoRaw.meta.gasBoilerEfficiency = heatingInputs.gasBoilerEfficiency;
  demoRaw.meta.gasBoilerAutoCop = heatingInputs.effectiveBoilerCop;
  demoRaw.meta.heatPumpScopMode = heatingInputs.heatPumpScopMode;
  demoRaw.meta.heatPumpFixedScop = heatingInputs.heatPumpFixedScop;
  demoRaw.meta.heatPumpAutoScop = heatingInputs.heatPumpAutoScop;
  demoRaw.meta.effective_scop = heatingInputs.effectiveScop;
  demoRaw.meta.effective_system_cop = heatingInputs.effectiveSystemCop;
  demoRaw.meta.effective_boiler_cop = heatingInputs.effectiveBoilerCop;
  demoRaw.meta.annual_heat_demand_kwh_yr = Number(annualModel.annualHeatDemandKwhYr || 0);
  demoRaw.meta.annual_input_energy_kwh_yr = annualModel.annualInputEnergyKwhYr;
  demoRaw.meta.annual_running_cost = annualModel.annualRunningCost;
  demoRaw.meta.annual_average_system_cop = annualModel.annualAverageCop;
  demoRaw.meta.effective_system_efficiency = annualModel.annualAverageCop;

  // Merge zone-level results
  for (const zone of (Array.isArray(demoRaw.zones) ? demoRaw.zones : [])) {
    const room = (Array.isArray(heatResults.rooms) ? heatResults.rooms : []).find(r => r.zoneId === zone.id);
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

  return {
    annotatedDemo: demoRaw,
    heatResults,
    annualModel,
    heatingInputs,
    resolvedTemps: { indoorTemp, externalTemp, flowTemp }
  };
}

/**
 * Build and filter performance recommendations for the given demo.
 * Runs entirely off the main thread when called from the worker.
 * @param {{ demoRaw: object, materials: object, openings: object,
 *           radiators: object, costs: object }} payload
 * @returns {{ applicableRecommendations: Array }}
 */
export function processRecommendationsPayload(payload) {
  const {
    demoRaw,
    materials: materialsRaw,
    openings,
    radiators: radiatorsRaw,
    costs
  } = payload || {};

  if (!demoRaw) return { applicableRecommendations: [] };

  const baseMaterials = materialsRaw
    ? (Array.isArray(materialsRaw.materials) ? materialsRaw.materials : (Array.isArray(materialsRaw) ? materialsRaw : []))
    : [];
  const openingMaterials = getOpeningMaterials(openings);
  const materials = [...baseMaterials, ...openingMaterials];

  const radiatorCatalog = radiatorsRaw
    ? (Array.isArray(radiatorsRaw.radiators) ? radiatorsRaw.radiators : (Array.isArray(radiatorsRaw) ? radiatorsRaw : []))
    : [];

  const helpers = createSolverHelpers(materials, openings, radiatorCatalog);
  const context = { currentCosts: costs, currentOpenings: openings, helpers };

  const recommendations = buildPerformanceRecommendations(demoRaw, context);
  const applicableRecommendations = (Array.isArray(recommendations) ? recommendations : [])
    .filter(item => {
      const recommendationId = String(item?.recommendationId || '');
      if (!recommendationId) return false;
      const demoClone = deepClone(demoRaw);
      return applyRecommendationById(demoClone, recommendationId, context) === true;
    });

  return { applicableRecommendations };
}

// ---------------------------------------------------------------------------
// Worker message handler (only active when running as a Web Worker)
// ---------------------------------------------------------------------------

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.addEventListener('message', ({ data }) => {
    const { type, id, payload } = data || {};
    try {
      let result;
      if (type === 'solve') {
        result = processSolvePayload(payload);
      } else if (type === 'recommendations') {
        result = processRecommendationsPayload(payload);
      } else {
        throw new Error(`Unknown worker message type: ${type}`);
      }
      self.postMessage({ type: `${type}_result`, id, result });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: String(err) });
    }
  });
}
