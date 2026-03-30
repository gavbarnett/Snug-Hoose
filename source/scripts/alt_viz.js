// Alternative floor-plan view scaffold: level selector + thermal-colored polygons.
import { formatZoneTemperatureText, getZoneAchText, getZoneCapacitySummary, getZoneSavingsText } from './zone_text.js';
import { getThermalColorClass, THERMAL_COLOR_BY_CLASS } from './zone_thermal.js';

let selectedLevel = null;
let selectedZoneId = null;
let dragState = null;
let roomDragState = null;
let objectDragState = null;
let suppressWallSelectionUntil = 0;
const DRAG_START_THRESHOLD_PX = 6;
const DRAG_SNAP_STEP_M = 0.1;
const DRAG_NEAR_SNAP_THRESHOLD_M = 0.6;
const DOOR_SWING_DEGREES = 20;
const OBJECT_HANDLE_RADIUS_PX = 6;
const OPENING_HANDLE_OFFSET_ALONG_PX = 14;
const OPENING_HANDLE_OFFSET_NORMAL_PX = 12;
const RADIATOR_HANDLE_OFFSET_NORMAL_PX = 14;
const WALL_LABEL_OFFSET_PX = 16;

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

  let closestTargetCoord = null;
  let closestTargetDist = Infinity;

  if (Array.isArray(targetCoords)) {
    for (const target of targetCoords) {
      if (!isFinite(target)) continue;
      const dist = Math.abs(target - absoluteCoord);
      if (dist <= nearThreshold && dist < closestTargetDist) {
        closestTargetDist = dist;
        closestTargetCoord = target;
      }
    }
  }

  // Prefer nearby wall alignment over grid snap when available.
  if (closestTargetCoord !== null) {
    return closestTargetCoord - baseCoord;
  }

  let snappedCoord = absoluteCoord;
  if (isFinite(step) && step > 0) {
    snappedCoord = Math.round(absoluteCoord / step) * step;
  }

  return snappedCoord - baseCoord;
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

function ensureSelectedZone(rooms) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    selectedZoneId = null;
    return;
  }
  const hasSelection = rooms.some(zone => zone && zone.id === selectedZoneId);
  if (!hasSelection) {
    selectedZoneId = rooms[0].id;
  }
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

function getGhostLevel(levels, activeLevel) {
  if (!Array.isArray(levels) || levels.length < 2 || !isFinite(activeLevel)) return null;
  const sorted = levels.slice().sort((a, b) => a - b);
  const minLevel = sorted[0];
  if (activeLevel === minLevel) {
    return sorted[1] ?? null;
  }

  const below = sorted.filter(level => level < activeLevel);
  if (below.length > 0) return below[below.length - 1];
  const above = sorted.filter(level => level > activeLevel);
  return above[0] ?? null;
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

function getEpcBand(intensityKwhM2Yr) {
  if (typeof intensityKwhM2Yr !== 'number' || !isFinite(intensityKwhM2Yr)) return 'N/A';
  if (intensityKwhM2Yr <= 50) return 'A';
  if (intensityKwhM2Yr <= 90) return 'B';
  if (intensityKwhM2Yr <= 150) return 'C';
  if (intensityKwhM2Yr <= 230) return 'D';
  if (intensityKwhM2Yr <= 330) return 'E';
  if (intensityKwhM2Yr <= 450) return 'F';
  return 'G';
}

function computeZoneEpcEstimate(zone) {
  const deliveredPerM2 = typeof zone?.delivered_heat_per_unit_area === 'number'
    ? zone.delivered_heat_per_unit_area
    : (typeof zone?.heat_loss_per_unit_area === 'number' ? zone.heat_loss_per_unit_area : null);

  if (deliveredPerM2 === null || !isFinite(deliveredPerM2)) {
    return { letter: 'N/A', intensityKwhM2Yr: null };
  }

  const intensityKwhM2Yr = Math.max(0, (deliveredPerM2 * 24 * 365) / 1000);
  return {
    letter: getEpcBand(intensityKwhM2Yr),
    intensityKwhM2Yr
  };
}

function computeWholeHouseEpcEstimate(rooms) {
  const conditioned = (Array.isArray(rooms) ? rooms : []).filter(zone => zone && zone.is_unheated !== true);
  if (conditioned.length === 0) {
    return {
      letter: 'N/A',
      intensityKwhM2Yr: null,
      annualHeatingDemandKwhYr: null
    };
  }

  const totalDeliveredHeatW = conditioned.reduce((sum, zone) => {
    const deliveredHeat = typeof zone.delivered_heat === 'number'
      ? zone.delivered_heat
      : (typeof zone.heat_loss === 'number' ? zone.heat_loss : 0);
    return sum + deliveredHeat;
  }, 0);

  const totalFloorArea = conditioned.reduce((sum, zone) => {
    const area = typeof zone.floor_area === 'number' && zone.floor_area > 0 ? zone.floor_area : 0;
    return sum + area;
  }, 0);

  const annualHeatingDemand = Math.max(0, (totalDeliveredHeatW * 24 * 365) / 1000);
  const intensityKwhM2Yr = totalFloorArea > 0 ? (annualHeatingDemand / totalFloorArea) : null;

  return {
    letter: getEpcBand(intensityKwhM2Yr),
    intensityKwhM2Yr,
    annualHeatingDemandKwhYr: annualHeatingDemand
  };
}

function createProjectSummaryStrip(demo, rooms, opts = {}) {
  const summary = document.createElement('div');
  summary.className = 'alt-viz-project-summary';

  const onMenuAction = typeof opts.onMenuAction === 'function' ? opts.onMenuAction : null;
  const getContext = typeof opts.getContext === 'function' ? opts.getContext : (() => ({}));
  const requestAction = (action, payload = {}) => {
    if (typeof onMenuAction !== 'function') return;
    onMenuAction(action, { action, payload }, getContext());
  };

  const name = document.createElement('div');
  name.className = 'alt-viz-project-name';
  const projectName = (demo?.meta?.name && String(demo.meta.name).trim())
    ? String(demo.meta.name)
    : 'Unnamed Project';
  name.textContent = projectName;

  const epc = computeWholeHouseEpcEstimate(rooms);
  const epcWrap = document.createElement('div');
  epcWrap.className = 'alt-viz-project-epc';

  const epcSummary = document.createElement('div');
  epcSummary.className = 'alt-viz-project-epc-summary';
  const epcValue = epc.intensityKwhM2Yr === null ? 'n/a' : `${epc.intensityKwhM2Yr.toFixed(0)}`;
  const annualDemand = epc.annualHeatingDemandKwhYr === null
    ? 'n/a'
    : `${epc.annualHeatingDemandKwhYr.toFixed(0)} kWh/yr`;
  const overallAch = typeof demo?.meta?.total_air_changes_per_hour === 'number' && isFinite(demo.meta.total_air_changes_per_hour)
    ? demo.meta.total_air_changes_per_hour.toFixed(2)
    : 'n/a';
  epcSummary.textContent = `Overall EPC ${epc.letter} (${epcValue}) · Annual demand ${annualDemand} · ACH ${overallAch}`;

  const epcScale = document.createElement('div');
  epcScale.className = 'alt-viz-project-epc-scale';
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(letter => {
    const chip = document.createElement('span');
    chip.className = `epc-chip epc-${letter}${letter === epc.letter ? ' active' : ''}`;
    chip.textContent = letter;
    epcScale.appendChild(chip);
  });

  const variantWrap = document.createElement('div');
  variantWrap.className = 'alt-viz-variants';

  const variantState = demo?.variant_state || {};
  const variants = Array.isArray(variantState.variants) ? variantState.variants : [];
  const activeVariantId = variantState.activeVariantId || null;
  const canDelete = variants.length > 1;

  variants.forEach(variant => {
    const row = document.createElement('div');
    row.className = 'alt-viz-variant-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    if (variant.id === activeVariantId) row.classList.add('is-active');

    const activeIcon = document.createElement('span');
    activeIcon.className = 'alt-viz-variant-icon';
    activeIcon.textContent = variant.id === activeVariantId ? '●' : '○';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'alt-viz-variant-name-input';
    nameInput.value = String(variant.name || 'Variant');

    nameInput.addEventListener('click', (event) => event.stopPropagation());
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur();
      }
    });

    nameInput.addEventListener('blur', () => {
      const next = String(nameInput.value || '').trim();
      if (!next || next === String(variant.name || '').trim()) {
        nameInput.value = String(variant.name || 'Variant');
        return;
      }
      requestAction('file.variants.rename', {
        variantId: variant.id,
        name: next
      });
    });

    const metrics = variant.metrics || {};
    const variantEpc = typeof metrics.epcLetter === 'string' && metrics.epcLetter
      ? metrics.epcLetter
      : 'N/A';
    const demandText = Number.isFinite(metrics.annualDemandKwhYr)
      ? `${Number(metrics.annualDemandKwhYr).toFixed(0)} kWh/yr`
      : 'n/a';
    const achText = Number.isFinite(metrics.totalAch)
      ? Number(metrics.totalAch).toFixed(2)
      : 'n/a';

    const metricsText = document.createElement('span');
    metricsText.className = 'alt-viz-variant-metrics';
    metricsText.textContent = `${variantEpc} · Demand ${demandText} · ACH ${achText}`;

    row.appendChild(activeIcon);
    row.appendChild(nameInput);
    row.appendChild(metricsText);

    if (canDelete && variant.id !== activeVariantId) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'alt-viz-variant-delete-btn';
      deleteBtn.title = 'Delete variant';
      deleteBtn.textContent = '×';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        requestAction('file.variants.delete', { variantId: variant.id });
      });
      row.appendChild(deleteBtn);
    }

    const activate = () => {
      if (variant.id === activeVariantId) return;
      requestAction('file.variants.switch', { variantId: variant.id });
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    variantWrap.appendChild(row);
  });

  const addVariantBtn = document.createElement('button');
  addVariantBtn.type = 'button';
  addVariantBtn.className = 'alt-viz-variant-add-btn';
  addVariantBtn.textContent = 'Create New Variant';
  addVariantBtn.addEventListener('click', () => {
    requestAction('file.variants.create', {});
  });
  variantWrap.appendChild(addVariantBtn);

  const recommendationsWrap = document.createElement('div');
  recommendationsWrap.className = 'alt-viz-recommendations';

  const recommendationsTitle = document.createElement('div');
  recommendationsTitle.className = 'alt-viz-recommendations-title';
  recommendationsTitle.textContent = 'Recommendations';
  recommendationsWrap.appendChild(recommendationsTitle);

  const recommendations = Array.isArray(demo?.recommendations) ? demo.recommendations : [];
  if (recommendations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'alt-viz-recommendations-empty';
    empty.textContent = 'No cost-effective measures identified yet.';
    recommendationsWrap.appendChild(empty);
  } else {
    const tableWrap = document.createElement('div');
    tableWrap.className = 'alt-viz-recommendations-table-wrap';

    const table = document.createElement('table');
    table.className = 'alt-viz-recommendations-table';

    const head = table.createTHead();
    const headRow = head.insertRow();
    ['Recommendation', 'kWhr/year savings', 'Expected EPC', 'Cost Est.'].forEach(title => {
      const th = document.createElement('th');
      th.textContent = title;
      headRow.appendChild(th);
    });

    const body = table.createTBody();
    recommendations.forEach(item => {
      const row = body.insertRow();
      const recommendation = document.createElement('td');
      recommendation.textContent = String(item?.recommendation || 'Recommendation');
      row.appendChild(recommendation);

      const savings = document.createElement('td');
      savings.textContent = Number.isFinite(Number(item?.annualSavingsKwhYr))
        ? `${Number(item.annualSavingsKwhYr).toFixed(0)} kWh/yr`
        : 'n/a';
      row.appendChild(savings);

      const epc = document.createElement('td');
      epc.textContent = String(item?.expectedEpc || 'N/A');
      row.appendChild(epc);

      const cost = document.createElement('td');
      cost.textContent = String(item?.costEstimate || 'n/a');
      row.appendChild(cost);
    });

    tableWrap.appendChild(table);
    recommendationsWrap.appendChild(tableWrap);
  }

  epcWrap.appendChild(epcSummary);
  epcWrap.appendChild(epcScale);
  epcWrap.appendChild(variantWrap);
  epcWrap.appendChild(recommendationsWrap);
  summary.appendChild(name);
  summary.appendChild(epcWrap);
  return summary;
}

function computeLevelEpcEstimate(levelRooms) {
  const conditioned = (Array.isArray(levelRooms) ? levelRooms : []).filter(zone => zone && zone.is_unheated !== true);
  if (conditioned.length === 0) return { letter: 'N/A', intensityKwhM2Yr: null };

  let weightedAnnual = 0;
  let weightedArea = 0;
  let fallbackAnnualTotal = 0;
  let fallbackCount = 0;

  conditioned.forEach(zone => {
    const deliveredPerM2 = typeof zone.delivered_heat_per_unit_area === 'number'
      ? zone.delivered_heat_per_unit_area
      : (typeof zone.heat_loss_per_unit_area === 'number' ? zone.heat_loss_per_unit_area : null);

    if (deliveredPerM2 === null || !isFinite(deliveredPerM2)) return;

    const annualIntensity = Math.max(0, (deliveredPerM2 * 24 * 365) / 1000);
    const area = typeof zone.floor_area === 'number' && zone.floor_area > 0 ? zone.floor_area : null;

    if (area !== null) {
      weightedAnnual += annualIntensity * area;
      weightedArea += area;
    } else {
      fallbackAnnualTotal += annualIntensity;
      fallbackCount += 1;
    }
  });

  const intensityKwhM2Yr = weightedArea > 0
    ? (weightedAnnual / weightedArea)
    : (fallbackCount > 0 ? (fallbackAnnualTotal / fallbackCount) : null);

  return {
    letter: getEpcBand(intensityKwhM2Yr),
    intensityKwhM2Yr
  };
}

function createLevelMiniViews(rooms, levels, activeLevel, onSelectLevel, extraOpts = {}) {
  const { globalTargetTemp = 21, onSetpointChanged, onRoomHeatingChanged } = extraOpts;
  const wrap = document.createElement('div');
  wrap.className = 'alt-viz-level-miniviews';

  const ns = 'http://www.w3.org/2000/svg';

  levels.forEach(level => {
    const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === level);

    const card = document.createElement('div');
    card.className = 'alt-viz-level-mini';
    if (level === activeLevel) card.classList.add('is-active');

    // Clickable zone: header + preview + room count
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

    // Per-room controls
    if (levelRooms.length > 0 && typeof onSetpointChanged === 'function') {
      const roomsSection = document.createElement('div');
      roomsSection.className = 'alt-viz-level-mini-rooms';

      levelRooms.forEach(zone => {
        const row = document.createElement('div');
        row.className = 'alt-viz-level-mini-room-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'alt-viz-level-mini-room-name';
        nameSpan.textContent = zone.name || zone.id;

        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'alt-viz-level-mini-room-slider-wrap';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'alt-env-slider';
        slider.min = '16';
        slider.max = '25';
        slider.step = '1';
        slider.value = String(typeof zone.setpoint_temperature === 'number' ? zone.setpoint_temperature : globalTargetTemp);
        slider.disabled = zone.is_unheated === true;

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'alt-env-value';
        valueDisplay.textContent = zone.is_unheated === true
          ? 'Unheated'
          : (typeof zone.setpoint_temperature === 'number'
              ? `${zone.setpoint_temperature}°C`
              : `${globalTargetTemp}°C`);

        const unheatedToggle = document.createElement('label');
        unheatedToggle.className = 'alt-viz-level-mini-room-toggle';

        const unheatedCheckbox = document.createElement('input');
        unheatedCheckbox.type = 'checkbox';
        unheatedCheckbox.checked = zone.is_unheated === true;

        const unheatedText = document.createElement('span');
        unheatedText.textContent = 'Unheated';
        unheatedToggle.appendChild(unheatedCheckbox);
        unheatedToggle.appendChild(unheatedText);

        slider.addEventListener('input', () => {
          valueDisplay.textContent = `${slider.value}°C`;
        });

        slider.addEventListener('change', () => {
          onSetpointChanged(zone, Number(slider.value));
        });

        unheatedCheckbox.addEventListener('change', () => {
          const isUnheated = unheatedCheckbox.checked;
          slider.disabled = isUnheated;
          valueDisplay.textContent = isUnheated
            ? 'Unheated'
            : `${slider.value}°C`;
          if (typeof onRoomHeatingChanged === 'function') {
            onRoomHeatingChanged(zone, isUnheated);
          }
        });

        sliderWrap.appendChild(slider);
        sliderWrap.appendChild(valueDisplay);
        row.appendChild(nameSpan);
        row.appendChild(sliderWrap);
        row.appendChild(unheatedToggle);
        roomsSection.appendChild(row);
      });

      card.appendChild(roomsSection);
    }

    wrap.appendChild(card);
  });

  return wrap;
}

function buildAltVizMenuSpec(context = {}) {
  const demo = context.demo;
  const canUndo = !!context.canUndo;
  const canRedo = !!context.canRedo;
  const selectedZoneId = context.selectedZoneId || null;
  const canDeleteRoom = !!selectedZoneId;
  const defaultWindowSizes = [
    { width: 600, height: 600 },
    { width: 900, height: 900 },
    { width: 1200, height: 1200 },
    { width: 1500, height: 1200 },
    { width: 1800, height: 1200 }
  ];
  const defaultDoorSizes = [
    { width: 762, height: 1981 },
    { width: 838, height: 1981 },
    { width: 915, height: 1981 },
    { width: 926, height: 2040 }
  ];
  const defaultRadiatorWidths = [400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000];

  const openingsLibrary = demo?.openings || {};
  const standardSizes = openingsLibrary?.standard_sizes || {};

  const toSizeOption = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
    return {
      label: entry.label || `${Math.round(width)} x ${Math.round(height)} mm`,
      width: Math.round(width),
      height: Math.round(height)
    };
  };

  const windowSizes = (Array.isArray(standardSizes.windows) && standardSizes.windows.length > 0
    ? standardSizes.windows
    : defaultWindowSizes
  ).map(toSizeOption).filter(Boolean);

  const doorSizes = (Array.isArray(standardSizes.doors) && standardSizes.doors.length > 0
    ? standardSizes.doors
    : defaultDoorSizes
  ).map(toSizeOption).filter(Boolean);

  const radiatorWidths = (Array.isArray(demo?.radiators?.standard_widths_mm) && demo.radiators.standard_widths_mm.length > 0
    ? demo.radiators.standard_widths_mm
    : defaultRadiatorWidths
  )
    .map(value => Math.round(Number(value)))
    .filter(value => isFinite(value) && value > 0);

  const mapWindowSizeItems = (glazingId) => windowSizes.map(size => ({
    label: size.label,
    action: 'openings.windows.add',
    payload: { width: size.width, height: size.height, glazingId }
  }));

  const mapDoorSizeItems = (materialId) => doorSizes.map(size => ({
    label: size.label,
    action: 'openings.doors.add',
    payload: { width: size.width, height: size.height, materialId }
  }));

  const mapRadiatorSizeItems = (trvEnabled, radiatorId) => radiatorWidths.map(width => ({
    label: `${width} mm`,
    action: 'hvac.radiators.add',
    payload: { width, trvEnabled, radiatorId }
  }));

  const windowLibrary = Array.isArray(openingsLibrary.windows)
    ? openingsLibrary.windows
    : [];
  const doorLibrary = Array.isArray(openingsLibrary.doors)
    ? openingsLibrary.doors
    : [];

  const radiatorLibrary = Array.isArray(demo?.radiators?.radiators)
    ? demo.radiators.radiators
    : [];
  const ventilationLibrary = Array.isArray(demo?.ventilation?.elements)
    ? demo.ventilation.elements
    : [];

  const mapTypesToMenu = (types, itemMapper, emptyLabel) => {
    if (!Array.isArray(types) || types.length === 0) {
      return [{
        label: emptyLabel,
        disabled: true
      }];
    }
    return types.map(type => ({
      label: type.name || type.id,
      items: itemMapper(type.id)
    }));
  };

  const radiatorTypeMenus = mapTypesToMenu(
    radiatorLibrary,
    (radiatorId) => mapRadiatorSizeItems(false, radiatorId),
    'No radiator types loaded'
  );

  const radiatorTypeMenusWithTrv = mapTypesToMenu(
    radiatorLibrary,
    (radiatorId) => mapRadiatorSizeItems(true, radiatorId),
    'No radiator types loaded'
  );

  const windowGlazingMenus = mapTypesToMenu(
    windowLibrary,
    (glazingId) => mapWindowSizeItems(glazingId),
    'No window types loaded'
  );

  const doorMaterialMenus = mapTypesToMenu(
    doorLibrary,
    (materialId) => mapDoorSizeItems(materialId),
    'No door types loaded'
  );

  const ventilationMenus = mapTypesToMenu(
    ventilationLibrary,
    (_id) => [],
    'No ventilation types loaded'
  ).map((group, index) => {
    const src = ventilationLibrary[index];
    if (!src) return group;
    return {
      label: src.name || src.id,
      action: 'hvac.ventilation.add',
      payload: {
        ventilationId: src.id,
        type: src.type,
        flow_m3_h: src.default_flow_m3_h,
        heat_recovery_efficiency: src.default_heat_recovery_efficiency
      }
    };
  });

  return [
    {
      label: 'File',
      items: [
        {
          label: 'New Project',
          items: [
            { label: 'From Template', action: 'file.new.from_template', shortcut: 'Ctrl+Shift+N' },
            { label: 'Blank', action: 'file.new.blank', shortcut: 'Ctrl+N' }
          ]
        },
        { label: 'Save Project', action: 'file.save_project', shortcut: 'Ctrl+S' },
        { label: 'Load Project', action: 'file.load_project', shortcut: 'Ctrl+O' }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', action: 'edit.undo', disabled: !canUndo, shortcut: 'Ctrl+Z' },
        { label: 'Redo', action: 'edit.redo', disabled: !canRedo, shortcut: 'Ctrl+Y' },
        { label: 'Delete Selected Room', action: 'structure.delete.room', disabled: !canDeleteRoom, shortcut: 'Del' }
      ]
    },
    {
      label: 'Add Structure',
      items: [
        { label: 'Floor', action: 'structure.add.floor' },
        { label: 'Room', action: 'structure.add.room' }
      ]
    },
    {
      label: 'Openings',
      items: [
        {
          label: 'Windows',
          items: windowGlazingMenus
        },
        {
          label: 'Doors',
          items: doorMaterialMenus
        }
      ]
    },
    {
      label: 'HVAC',
      items: [
        {
          label: 'Radiators',
          items: [
            {
              label: 'TRV',
              items: radiatorTypeMenusWithTrv
            },
            {
              label: 'No TRV',
              items: radiatorTypeMenus
            }
          ]
        },
        {
          label: 'Ventilation',
          items: ventilationMenus
        },
        { label: 'Boiler Thermostat', action: 'hvac.boiler_thermostat' }
      ]
    }
  ];
}

function createAltVizMenuBar(onMenuAction, getContext) {
  const bar = document.createElement('div');
  bar.className = 'alt-viz-menubar';

  const context = typeof getContext === 'function' ? getContext() : {};
  const menuSpec = buildAltVizMenuSpec(context);

  const renderMenuItems = (items, level = 0, pathPrefix = []) => {
    const list = document.createElement('ul');
    list.className = level === 0 ? 'alt-viz-menu-list' : 'alt-viz-submenu-list';

    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'alt-viz-menu-item';
      if (item.disabled) li.classList.add('is-disabled');
      const currentPath = [...pathPrefix, item.label];
      li.dataset.menuPath = currentPath.join('>');

      if (item.control === 'slider' && level > 0) {
        li.classList.add('alt-viz-slider-item');

        const labelRow = document.createElement('div');
        labelRow.className = 'alt-viz-slider-label-row';

        const label = document.createElement('span');
        label.className = 'alt-viz-slider-label';
        label.textContent = item.label;

        const valueText = document.createElement('span');
        valueText.className = 'alt-viz-slider-value';
        valueText.textContent = `${item.value}${item.unit || ''}`;

        labelRow.appendChild(label);
        labelRow.appendChild(valueText);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'alt-viz-slider-control';
        slider.min = String(item.min ?? 0);
        slider.max = String(item.max ?? 100);
        slider.step = String(item.step ?? 1);
        slider.value = String(item.value ?? slider.min);

        slider.addEventListener('click', (e) => e.stopPropagation());
        slider.addEventListener('mousedown', (e) => e.stopPropagation());

        slider.addEventListener('input', (e) => {
          e.stopPropagation();
          valueText.textContent = `${slider.value}${item.unit || ''}`;
          if (typeof onMenuAction === 'function' && item.action) {
            onMenuAction(item.action, {
              ...item,
              payload: {
                ...(item.payload || {}),
                value: Number(slider.value)
              }
            }, typeof getContext === 'function' ? getContext() : {});
          }
        });

        li.appendChild(labelRow);
        li.appendChild(slider);
        list.appendChild(li);
        return;
      }

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = level === 0 ? 'alt-viz-menu-trigger' : 'alt-viz-submenu-trigger';
      trigger.textContent = item.label;
      if (item.shortcut) {
        trigger.classList.add('has-shortcut');
        const shortcut = document.createElement('span');
        shortcut.className = 'alt-viz-menu-shortcut';
        shortcut.textContent = item.shortcut;
        trigger.appendChild(shortcut);
      }
      trigger.setAttribute('aria-haspopup', item.items ? 'menu' : 'false');
      trigger.disabled = !!item.disabled;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        if (!item.items && item.action && typeof onMenuAction === 'function') {
          onMenuAction(item.action, item, typeof getContext === 'function' ? getContext() : {});
        }
      });

      li.appendChild(trigger);

      if (Array.isArray(item.items) && item.items.length > 0) {
        li.classList.add('has-submenu');
        li.appendChild(renderMenuItems(item.items, level + 1, currentPath));
      }

      list.appendChild(li);
    });

    return list;
  };

  bar.appendChild(renderMenuItems(menuSpec, 0, []));

  return bar;
}

function createEnvironmentControlStrip(demo, onMenuAction, getContext) {
  const strip = document.createElement('div');
  strip.className = 'alt-env-strip';

  const controls = [
    {
      label: 'Indoor Target',
      action: 'environment.set.indoor',
      value: Number.isFinite(demo?.meta?.indoorTemp) ? demo.meta.indoorTemp : 21,
      min: 14,
      max: 26,
      step: 0.5,
      unit: '°C'
    },
    {
      label: 'External Temp',
      action: 'environment.set.external',
      value: Number.isFinite(demo?.meta?.externalTemp) ? demo.meta.externalTemp : 3,
      min: -10,
      max: 20,
      step: 0.5,
      unit: '°C'
    },
    {
      label: 'Flow Temp',
      action: 'environment.set.flow',
      value: Number.isFinite(demo?.meta?.flowTemp) ? demo.meta.flowTemp : 55,
      min: 30,
      max: 75,
      step: 1,
      unit: '°C'
    }
  ];

  controls.forEach(control => {
    const card = document.createElement('div');
    card.className = 'alt-env-card';

    const labelRow = document.createElement('div');
    labelRow.className = 'alt-env-label-row';

    const label = document.createElement('span');
    label.className = 'alt-env-label';
    label.textContent = control.label;

    const value = document.createElement('span');
    value.className = 'alt-env-value';
    value.textContent = `${control.value}${control.unit}`;

    labelRow.appendChild(label);
    labelRow.appendChild(value);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'alt-env-slider';
    slider.min = String(control.min);
    slider.max = String(control.max);
    slider.step = String(control.step);
    slider.value = String(control.value);

    // Keep dragging smooth by updating text live and only committing on release.
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}${control.unit}`;
    });

    slider.addEventListener('change', () => {
      if (typeof onMenuAction === 'function') {
        onMenuAction(
          control.action,
          {
            action: control.action,
            payload: { value: Number(slider.value) }
          },
          typeof getContext === 'function' ? getContext() : {}
        );
      }
    });

    card.appendChild(labelRow);
    card.appendChild(slider);
    strip.appendChild(card);
  });

  return strip;
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

function translatePolygonByDelta(polygon, deltaX, deltaY) {
  return polygon.map(pt => ({ x: pt.x + deltaX, y: pt.y + deltaY }));
}

function getPolygonAxisBounds(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const pt of polygon || []) {
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  return { minX, maxX, minY, maxY };
}

function collectRoomDragSnapTargets(polygonMap, excludeZoneId, ghostPolygons = []) {
  const xTargets = [];
  const yTargets = [];

  const addBoundsTargets = (polygon) => {
    if (!isValidPolygon(polygon)) return;
    const b = getPolygonAxisBounds(polygon);
    xTargets.push(b.minX, b.maxX);
    yTargets.push(b.minY, b.maxY);
  };

  for (const [zoneId, polygon] of polygonMap.entries()) {
    if (zoneId === excludeZoneId) continue;
    addBoundsTargets(polygon);
  }

  for (const polygon of ghostPolygons) {
    addBoundsTargets(polygon);
  }

  return { xTargets, yTargets };
}

function snapRoomAxisDelta(rawDelta, baseMin, baseMax, targets, step, nearThreshold) {
  if (!isFinite(rawDelta)) return 0;

  let bestDelta = null;
  let bestDist = Infinity;

  for (const target of targets || []) {
    if (!isFinite(target)) continue;
    const deltaToMin = target - baseMin;
    const distToMin = Math.abs(deltaToMin - rawDelta);
    if (distToMin < bestDist) {
      bestDist = distToMin;
      bestDelta = deltaToMin;
    }

    const deltaToMax = target - baseMax;
    const distToMax = Math.abs(deltaToMax - rawDelta);
    if (distToMax < bestDist) {
      bestDist = distToMax;
      bestDelta = deltaToMax;
    }
  }

  if (bestDelta !== null && bestDist <= nearThreshold) {
    return bestDelta;
  }

  return snapOffsetMeters(rawDelta, step);
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

function collectParallelSnapTargetsFromPolygons(polygons, dragP0, dragP1, normal) {
  const targets = [];
  if (!Array.isArray(polygons)) return targets;

  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      if (!areVectorsParallel(dragP0, dragP1, p0, p1)) continue;
      targets.push(dotPointNormal(p0, normal));
    }
  }

  return targets;
}

function formatLengthLabel(length) {
  if (!isFinite(length) || length <= 0) return '-';
  return `${length.toFixed(2)}m`;
}

function getEdgeCursor(p0, p1) {
  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);
  if (dx >= dy * 2) return 'ns-resize';
  if (dy >= dx * 2) return 'ew-resize';
  return 'move';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const denom = yj - yi;
    if (Math.abs(denom) < 1e-12) continue;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / denom + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function distancePointToSegment(point, p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    const ddx = point.x - p0.x;
    const ddy = point.y - p0.y;
    return {
      distance: Math.hypot(ddx, ddy),
      ratio: 0,
      closestPoint: { x: p0.x, y: p0.y }
    };
  }
  const rawRatio = ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / lenSq;
  const ratio = clamp(rawRatio, 0, 1);
  const closestPoint = {
    x: p0.x + dx * ratio,
    y: p0.y + dy * ratio
  };
  return {
    distance: Math.hypot(point.x - closestPoint.x, point.y - closestPoint.y),
    ratio,
    closestPoint
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColorHex(hexA, hexB, t) {
  const parse = (hex) => {
    const normalized = String(hex || '#000000').replace('#', '');
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
    };
  };

  const a = parse(hexA);
  const b = parse(hexB);
  const tt = clamp(t, 0, 1);
  const toHex = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${toHex(lerp(a.r, b.r, tt))}${toHex(lerp(a.g, b.g, tt))}${toHex(lerp(a.b, b.b, tt))}`;
}

function getSegmentFrame(segment, centroidPoint = null) {
  if (!segment) return null;
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const len = Math.hypot(dx, dy);
  if (!isFinite(len) || len <= 1e-6) {
    return {
      midX: (segment.x1 + segment.x2) / 2,
      midY: (segment.y1 + segment.y2) / 2,
      tangentX: 1,
      tangentY: 0,
      normalX: 0,
      normalY: -1
    };
  }

  const tangentX = dx / len;
  const tangentY = dy / len;
  const midX = (segment.x1 + segment.x2) / 2;
  const midY = (segment.y1 + segment.y2) / 2;
  let normalX = -tangentY;
  let normalY = tangentX;

  if (centroidPoint) {
    const toCentroidX = centroidPoint.x - midX;
    const toCentroidY = centroidPoint.y - midY;
    if ((toCentroidX * normalX) + (toCentroidY * normalY) < 0) {
      normalX *= -1;
      normalY *= -1;
    }
  }

  return { midX, midY, tangentX, tangentY, normalX, normalY };
}

function getOffsetHandlePositionFromSegment(segment, alongPx = 0, normalPx = 0, centroidPoint = null) {
  const frame = getSegmentFrame(segment, centroidPoint);
  if (!frame) return null;

  return {
    x: frame.midX + frame.tangentX * alongPx + frame.normalX * normalPx,
    y: frame.midY + frame.tangentY * alongPx + frame.normalY * normalPx
  };
}

function updateOpeningRenderState(openingState, segment, centroidPoint) {
  if (!openingState || !segment) return;
  openingState.line.setAttribute('x1', String(segment.x1));
  openingState.line.setAttribute('y1', String(segment.y1));
  openingState.line.setAttribute('x2', String(segment.x2));
  openingState.line.setAttribute('y2', String(segment.y2));

  if (openingState.arc) {
    const swing = computeDoorSwingGeometry(segment, openingState.opening);
    if (swing) openingState.arc.setAttribute('d', swing.arcPath);
  }
  if (openingState.leaf) {
    const swing = computeDoorSwingGeometry(segment, openingState.opening);
    if (swing) {
      openingState.leaf.setAttribute('x1', String(swing.hinge.x));
      openingState.leaf.setAttribute('y1', String(swing.hinge.y));
      openingState.leaf.setAttribute('x2', String(swing.openLeafEnd.x));
      openingState.leaf.setAttribute('y2', String(swing.openLeafEnd.y));
    }
  }

  if (openingState.handle) {
    const handlePos = getOffsetHandlePositionFromSegment(
      segment,
      OPENING_HANDLE_OFFSET_ALONG_PX,
      OPENING_HANDLE_OFFSET_NORMAL_PX,
      centroidPoint
    );
    openingState.handle.setAttribute('cx', String(handlePos.x));
    openingState.handle.setAttribute('cy', String(handlePos.y));
  }
}

function updateRadiatorRenderState(renderState, segment, labelText, centroidPoint) {
  if (!renderState || !segment) return;
  renderState.line.setAttribute('x1', String(segment.x1));
  renderState.line.setAttribute('y1', String(segment.y1));
  renderState.line.setAttribute('x2', String(segment.x2));
  renderState.line.setAttribute('y2', String(segment.y2));
  renderState.line.setAttribute('stroke-width', String(segment.thickness));
  renderState.line.setAttribute('title', segment.title);

  const midX = (segment.x1 + segment.x2) / 2;
  const midY = (segment.y1 + segment.y2) / 2;
  renderState.label.setAttribute('x', String(midX));
  renderState.label.setAttribute('y', String(midY - 8));
  renderState.label.textContent = labelText;

  if (renderState.handle) {
    const handlePos = getOffsetHandlePositionFromSegment(segment, 0, RADIATOR_HANDLE_OFFSET_NORMAL_PX, centroidPoint);
    renderState.handle.setAttribute('cx', String(handlePos.x));
    renderState.handle.setAttribute('cy', String(handlePos.y));
  }
}

export function getWallStackRValue(element) {
  if (!element) return null;
  const uFabric = Number(element.u_fabric);
  if (isFinite(uFabric) && uFabric > 0) return 1 / uFabric;
  return null;
}

export function mapRValueToWallVisual(rValue, isExternal = false) {
  if (!isFinite(rValue) || rValue <= 0) {
    return {
      color: isExternal ? '#7ab2e6' : '#8b9aa8',
      width: isExternal ? 3.1 : 2.0,
    };
  }

  const minR = 0.5;
  const maxR = 6.0;
  const t = clamp((rValue - minR) / (maxR - minR), 0, 1);
  const color = lerpColorHex('#c46b6b', '#63c0ef', t);
  const width = lerp(1.6, 5.6, t) + (isExternal ? 0.5 : 0);
  return { color, width };
}

function scoreBoundaryEdge(edgeGroups, polygon, edgeIndex) {
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const refs = edgeGroups.get(createEdgeKey(p0, p1)) || [];
  const sharedCount = refs.length;
  return sharedCount <= 1 ? 0 : sharedCount;
}

function chooseBoundaryForLengthEdit(edgeGroups, polygon, edgeIndex) {
  const n = polygon.length;
  const startBoundaryIndex = (edgeIndex - 1 + n) % n;
  const endBoundaryIndex = (edgeIndex + 1) % n;
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % n];
  const horizontalEdit = Math.abs(p1.x - p0.x) >= Math.abs(p1.y - p0.y);

  if (horizontalEdit) {
    const startBoundary = polygon[startBoundaryIndex];
    const endBoundary = polygon[endBoundaryIndex];
    return startBoundary.x > endBoundary.x
      ? { boundaryEdgeIndex: startBoundaryIndex, moveSign: 1 }
      : { boundaryEdgeIndex: endBoundaryIndex, moveSign: 1 };
  }

  const startBoundary = polygon[startBoundaryIndex];
  const endBoundary = polygon[endBoundaryIndex];
  return startBoundary.y > endBoundary.y
    ? { boundaryEdgeIndex: startBoundaryIndex, moveSign: 1 }
    : { boundaryEdgeIndex: endBoundaryIndex, moveSign: 1 };
}

function isPolygonOnMovedBoundarySide(polygon, axis, boundaryCoord, epsilon = 1e-6) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const values = polygon.map(pt => axis === 'x' ? pt.x : pt.y);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  // Polygons crossing the movement plane need dedicated edge handling, not rigid translation.
  if (minValue < boundaryCoord - epsilon && maxValue > boundaryCoord + epsilon) {
    return false;
  }

  return minValue >= boundaryCoord - epsilon;
}

function translatePolygon(polygon, axis, delta) {
  return polygon.map(pt => axis === 'x'
    ? { x: pt.x + delta, y: pt.y }
    : { x: pt.x, y: pt.y + delta });
}

function edgeLiesOnBoundaryPlane(p0, p1, axis, boundaryCoord, epsilon = 1e-6) {
  if (axis === 'x') {
    return Math.abs(p0.x - boundaryCoord) < epsilon && Math.abs(p1.x - boundaryCoord) < epsilon;
  }
  return Math.abs(p0.y - boundaryCoord) < epsilon && Math.abs(p1.y - boundaryCoord) < epsilon;
}

export function hasOnlyAxisAlignedEdges(polygon, epsilon = 1e-6) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const dx = Math.abs(p1.x - p0.x);
    const dy = Math.abs(p1.y - p0.y);
    if (dx > epsilon && dy > epsilon) return false;
  }
  return true;
}

export function applyWallLengthEditToPolygonMap(rawPolygonMap, zoneId, edgeIndex, nextLengthRaw) {
  const nextLength = Number(nextLengthRaw);
  if (!isFinite(nextLength) || nextLength <= 0.05) return {};

  const sourceMap = rawPolygonMap instanceof Map
    ? rawPolygonMap
    : new Map(Object.entries(rawPolygonMap || {}));
  const polygonMap = normalizePolygonMapForSharedWalls(clonePolygonMap(sourceMap));
  const polygon = polygonMap.get(zoneId);
  if (!polygon || polygon.length < 2) return {};

  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const edgeKey = createEdgeKey(p0, p1);
  const edgeGroups = buildSharedEdgeGroups(polygonMap);
  const affectedEdges = edgeGroups.get(edgeKey) || [{ zoneId, edgeIndex }];
  const changedMap = new Map();
  const eps = 1e-6;

  let propagation = null;
  const targetDx = p1.x - p0.x;
  const targetDy = p1.y - p0.y;
  const targetLen = Math.hypot(targetDx, targetDy);
  if (isFinite(targetLen) && targetLen >= 1e-6) {
    const targetDeltaLen = nextLength - targetLen;
    if (Math.abs(targetDeltaLen) >= 1e-6) {
      const targetBoundary = chooseBoundaryForLengthEdit(edgeGroups, polygon, edgeIndex);
      const targetB0 = polygon[targetBoundary.boundaryEdgeIndex];
      const targetB1 = polygon[(targetBoundary.boundaryEdgeIndex + 1) % polygon.length];
      const targetBoundaryIsVertical = Math.abs(targetB0.x - targetB1.x) < eps;
      const targetBoundaryIsHorizontal = Math.abs(targetB0.y - targetB1.y) < eps;

      if (Math.abs(targetDx) >= Math.abs(targetDy) && targetBoundaryIsVertical) {
        propagation = {
          axis: 'x',
          boundaryCoord: targetB0.x,
          delta: targetBoundary.moveSign * targetDeltaLen,
          movedBoundaryKey: createEdgeKey(targetB0, targetB1),
          normal: { x: 1, y: 0 },
        };
      } else if (Math.abs(targetDy) > Math.abs(targetDx) && targetBoundaryIsHorizontal) {
        propagation = {
          axis: 'y',
          boundaryCoord: targetB0.y,
          delta: targetBoundary.moveSign * targetDeltaLen,
          movedBoundaryKey: createEdgeKey(targetB0, targetB1),
          normal: { x: 0, y: 1 },
        };
      }
    }
  }

  affectedEdges.forEach(ref => {
    const basePoly = polygonMap.get(ref.zoneId);
    if (!basePoly || basePoly.length < 2) return;

    const i = ref.edgeIndex;
    const j = (i + 1) % basePoly.length;
    const a = basePoly[i];
    const b = basePoly[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const currLen = Math.hypot(dx, dy);
    if (!isFinite(currLen) || currLen < 1e-6) return;

    const deltaLen = nextLength - currLen;
    if (Math.abs(deltaLen) < 1e-6) return;

    const { boundaryEdgeIndex, moveSign } = chooseBoundaryForLengthEdit(edgeGroups, basePoly, i);
    const b0 = basePoly[boundaryEdgeIndex];
    const b1 = basePoly[(boundaryEdgeIndex + 1) % basePoly.length];
    const nextPoly = clonePolygon(basePoly);

    const boundaryIsVertical = Math.abs(b0.x - b1.x) < eps;
    const boundaryIsHorizontal = Math.abs(b0.y - b1.y) < eps;

    if (Math.abs(dx) >= Math.abs(dy) && boundaryIsVertical) {
      const oldX = b0.x;
      const newX = oldX + moveSign * deltaLen;
      for (let vi = 0; vi < basePoly.length; vi++) {
        if (Math.abs(basePoly[vi].x - oldX) < eps) {
          nextPoly[vi] = { x: newX, y: basePoly[vi].y };
        }
      }
    } else if (Math.abs(dy) > Math.abs(dx) && boundaryIsHorizontal) {
      const oldY = b0.y;
      const newY = oldY + moveSign * deltaLen;
      for (let vi = 0; vi < basePoly.length; vi++) {
        if (Math.abs(basePoly[vi].y - oldY) < eps) {
          nextPoly[vi] = { x: basePoly[vi].x, y: newY };
        }
      }
    } else {
      return;
    }

    const cleaned = cleanupDisconnectedAreas(nextPoly);
    changedMap.set(ref.zoneId, cleaned);
  });

  if (propagation && Math.abs(propagation.delta) >= 1e-6) {
    for (const [otherZoneId, otherPoly] of polygonMap.entries()) {
      if (otherZoneId === zoneId || changedMap.has(otherZoneId)) continue;
      if (!isPolygonOnMovedBoundarySide(otherPoly, propagation.axis, propagation.boundaryCoord, eps)) continue;

      const boundaryEdgeIndices = [];
      const movedBoundaryEdgeIndices = [];
      for (let i = 0; i < otherPoly.length; i++) {
        const pA = otherPoly[i];
        const pB = otherPoly[(i + 1) % otherPoly.length];
        if (!edgeLiesOnBoundaryPlane(pA, pB, propagation.axis, propagation.boundaryCoord, eps)) continue;
        boundaryEdgeIndices.push(i);
        if (createEdgeKey(pA, pB) === propagation.movedBoundaryKey) {
          movedBoundaryEdgeIndices.push(i);
        }
      }

      const hasAnchoredBoundaryEdges = boundaryEdgeIndices.some(i => !movedBoundaryEdgeIndices.includes(i));
      if (hasAnchoredBoundaryEdges && movedBoundaryEdgeIndices.length > 0) {
        const movedSet = new Set(movedBoundaryEdgeIndices);
        const reshaped = buildOrthogonalPolygonFromMovedEdges(otherPoly, movedSet, propagation.normal, propagation.delta);
        changedMap.set(otherZoneId, reshaped);
      } else {
        changedMap.set(otherZoneId, translatePolygon(otherPoly, propagation.axis, propagation.delta));
      }
    }
  }

  const changedPolygons = {};
  for (const [zid, cleaned] of changedMap.entries()) {
    const basePoly = polygonMap.get(zid) || [];
    if (JSON.stringify(cleaned) !== JSON.stringify(basePoly)) {
      changedPolygons[zid] = cleaned;
    }
  }

  return changedPolygons;
}

function updateRenderedZoneGeometry(zoneRenderState, polygon, bounds, scale, pad) {
  if (!zoneRenderState || !isValidPolygon(polygon)) return;

  const projected = polygon.map(pt => projectPoint(pt, bounds, scale, pad));
  zoneRenderState.polygonElement.setAttribute('points', projected.map(p => `${p.x},${p.y}`).join(' '));

  const centroidWorld = polygonCentroid(polygon);
  const centroid = projectPoint(centroidWorld, bounds, scale, pad);
  zoneRenderState.textElement.setAttribute('x', String(centroid.x));
  zoneRenderState.textElement.setAttribute('y', String(centroid.y - ((zoneRenderState.lineCount - 1) * 10)));
  if (zoneRenderState.infoTextElement) {
    zoneRenderState.infoTextElement.setAttribute('x', String(centroid.x));
    zoneRenderState.infoTextElement.setAttribute('y', String(centroid.y - ((zoneRenderState.lineCount - 1) * 10)));
  }
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

  zoneRenderState.edgeVisualElements?.forEach((line, idx) => {
    const p0 = projected[idx];
    const p1 = projected[(idx + 1) % projected.length];
    line.setAttribute('x1', String(p0.x));
    line.setAttribute('y1', String(p0.y));
    line.setAttribute('x2', String(p1.x));
    line.setAttribute('y2', String(p1.y));
  });

  zoneRenderState.edgeLabelElements?.forEach((label, idx) => {
    const p0 = projected[idx];
    const p1 = projected[(idx + 1) % projected.length];
    const worldP0 = polygon[idx];
    const worldP1 = polygon[(idx + 1) % polygon.length];
    const len = Math.hypot(worldP1.x - worldP0.x, worldP1.y - worldP0.y);
    const frame = getSegmentFrame({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y }, centroid);
    label.setAttribute('x', String(frame.midX - frame.normalX * WALL_LABEL_OFFSET_PX));
    label.setAttribute('y', String(frame.midY - frame.normalY * WALL_LABEL_OFFSET_PX));
    label.textContent = formatLengthLabel(len);
  });

  zoneRenderState.edgeOpeningElements?.forEach((openingsOnEdge, idx) => {
    if (!Array.isArray(openingsOnEdge) || openingsOnEdge.length === 0) return;

    const worldP0 = polygon[idx];
    const worldP1 = polygon[(idx + 1) % polygon.length];
    const screenP0 = projected[idx];
    const screenP1 = projected[(idx + 1) % projected.length];

    openingsOnEdge.forEach(openingState => {
      const segment = computeOpeningSegmentOnEdge(openingState.opening, worldP0, worldP1, screenP0, screenP1);
      if (!segment) return;
      updateOpeningRenderState(openingState, segment, centroid);
    });
  });

  const radiatorSegments = computeRadiatorSegments(
    zoneRenderState.demo,
    zoneRenderState.edgeGroups,
    zoneRenderState.polygonMap,
    zoneRenderState.zone,
    polygon,
    projected
  );

  zoneRenderState.radiatorElements?.forEach((line, idx) => {
    if (!line) return;
    const seg = radiatorSegments[idx];
    if (!seg) return;
    line.setAttribute('x1', String(seg.x1));
    line.setAttribute('y1', String(seg.y1));
    line.setAttribute('x2', String(seg.x2));
    line.setAttribute('y2', String(seg.y2));
    line.setAttribute('stroke-width', String(seg.thickness));
    line.setAttribute('title', seg.title);
  });

  zoneRenderState.radiatorLabelElements?.forEach((label, idx) => {
    if (!label) return;
    const seg = radiatorSegments[idx];
    if (!seg) return;
    const midX = (seg.x1 + seg.x2) / 2;
    const midY = (seg.y1 + seg.y2) / 2;
    label.setAttribute('x', String(midX));
    label.setAttribute('y', String(midY - 8));
    label.textContent = seg.radiatorType.replace(/^type_/i, '');
  });

  zoneRenderState.radiatorHandleElements?.forEach((handle, idx) => {
    if (!handle) return;
    const seg = radiatorSegments[idx];
    if (!seg) return;
    const handlePos = getOffsetHandlePositionFromSegment(seg, 0, RADIATOR_HANDLE_OFFSET_NORMAL_PX, centroid);
    handle.setAttribute('cx', String(handlePos.x));
    handle.setAttribute('cy', String(handlePos.y));
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
  const boundaryIds = new Set((Array.isArray(demo?.zones) ? demo.zones : [])
    .filter(zone => zone && zone.type === 'boundary')
    .map(zone => zone.id));
  const polygon = polygonMap.get(zoneId);
  if (!polygon) return null;

  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const sharedRefs = edgeGroups.get(createEdgeKey(p0, p1)) || [];
  const adjacentZoneId = sharedRefs.find(ref => ref.zoneId !== zoneId)?.zoneId || null;
  const orientation = getEdgeOrientation(polygon, edgeIndex);
  const edgeLength = Math.hypot(p1.x - p0.x, p1.y - p0.y);

  let candidates = elements.filter(element => {
    if (!element || String(element.type || '').toLowerCase() !== 'wall') return false;
    if (!Array.isArray(element.nodes) || element.nodes.length < 2 || !element.nodes.includes(zoneId)) return false;

    const otherNodeIds = element.nodes.filter(nodeId => nodeId !== zoneId);
    if (adjacentZoneId) {
      return otherNodeIds.includes(adjacentZoneId);
    }

    // External edges should only bind to wall elements connected to a boundary node.
    return otherNodeIds.some(nodeId => boundaryIds.has(nodeId));
  });

  if (candidates.length > 1) {
    const orientationMatches = candidates.filter(element => String(element.orientation || '').toLowerCase() === orientation);
    if (orientationMatches.length > 0) candidates = orientationMatches;
  }

  if (candidates.length > 1 && isFinite(edgeLength) && edgeLength > 0) {
    candidates = candidates
      .slice()
      .sort((a, b) => {
        const lenA = Math.abs((Number(a?.x) || 0) - edgeLength);
        const lenB = Math.abs((Number(b?.x) || 0) - edgeLength);
        return lenA - lenB;
      });
  }

  return candidates[0] || null;
}

function getOpeningLengthMeters(opening) {
  if (typeof opening?.length_m === 'number' && isFinite(opening.length_m) && opening.length_m > 0) {
    return opening.length_m;
  }
  if (typeof opening?.width === 'number' && isFinite(opening.width) && opening.width > 0) {
    return opening.width / 1000;
  }
  if (typeof opening?.area === 'number' && isFinite(opening.area) && opening.area > 0) {
    return Math.sqrt(opening.area);
  }
  return 1;
}

function getOpeningPositionRatio(opening) {
  if (typeof opening?.position_ratio !== 'number' || !isFinite(opening.position_ratio)) {
    return 0.5;
  }
  return clamp(opening.position_ratio, 0, 1);
}

function getOpeningId(opening, fallbackIndex) {
  if (opening?.id) return String(opening.id);
  return `opening_${fallbackIndex}`;
}

function getRadiatorId(radiator, fallbackIndex) {
  if (radiator?.id) return String(radiator.id);
  return `radiator_${fallbackIndex}`;
}

function getWallOpeningsForRender(demo, wall) {
  if (!wall) return [];
  const defaultOwnerZoneId = Array.isArray(wall.nodes) && wall.nodes.length > 0 ? wall.nodes[0] : null;
  const windows = Array.isArray(wall.windows) ? wall.windows : [];
  const doors = Array.isArray(wall.doors) ? wall.doors : [];

  const getOpeningLibrary = (kind) => kind === 'window'
    ? (Array.isArray(demo?.openings?.windows) ? demo.openings.windows : [])
    : (Array.isArray(demo?.openings?.doors) ? demo.openings.doors : []);

  const findOpeningUValue = (kind, opening) => {
    const openingId = kind === 'window' ? opening?.glazing_id : opening?.material_id;
    const library = getOpeningLibrary(kind);
    const match = library.find(item => item?.id === openingId);
    const uValue = Number(match?.u_value);
    return isFinite(uValue) && uValue > 0 ? uValue : null;
  };

  const getOpeningThickness = (kind, opening) => {
    const library = getOpeningLibrary(kind);
    const rValues = library
      .map(item => Number(item?.u_value))
      .filter(uValue => isFinite(uValue) && uValue > 0)
      .map(uValue => 1 / uValue)
      .sort((a, b) => a - b);

    const uValue = findOpeningUValue(kind, opening);
    const rValue = isFinite(uValue) && uValue > 0 ? (1 / uValue) : null;
    if (!isFinite(rValue) || rValue <= 0) {
      return kind === 'door' ? 8 : 7;
    }

    const minR = rValues[0] ?? rValue;
    const maxR = rValues[rValues.length - 1] ?? rValue;
    const range = Math.max(maxR - minR, 1e-6);
    const t = clamp((rValue - minR) / range, 0, 1);
    const minWidth = kind === 'door' ? 7 : 4;
    const maxWidth = kind === 'door' ? 13 : 15;
    return Number(lerp(minWidth, maxWidth, t).toFixed(2));
  };

  return [
    ...windows.map(opening => ({
      kind: 'window',
      opening,
      ownerZoneId: opening?.zone_id || defaultOwnerZoneId,
      thickness: getOpeningThickness('window', opening)
    })),
    ...doors.map(opening => ({
      kind: 'door',
      opening,
      ownerZoneId: opening?.zone_id || defaultOwnerZoneId,
      thickness: getOpeningThickness('door', opening)
    }))
  ];
}

function shouldRenderOpeningsForWallEdge(wall, zoneId) {
  if (!wall || !Array.isArray(wall.nodes) || wall.nodes.length < 2) return false;
  return wall.nodes.includes(zoneId);
}

function computeOpeningSegmentOnEdge(opening, worldP0, worldP1, screenP0, screenP1) {
  const worldLen = Math.hypot(worldP1.x - worldP0.x, worldP1.y - worldP0.y);
  if (!isFinite(worldLen) || worldLen <= 1e-6) return null;

  const openingLength = Math.max(0.1, getOpeningLengthMeters(opening));
  const lengthRatio = clamp(openingLength / worldLen, 0.05, 0.95);
  const centerRatio = getOpeningPositionRatio(opening);
  const half = lengthRatio / 2;
  const startRatio = clamp(centerRatio - half, 0, 1 - lengthRatio);
  const endRatio = startRatio + lengthRatio;

  return {
    x1: lerp(screenP0.x, screenP1.x, startRatio),
    y1: lerp(screenP0.y, screenP1.y, startRatio),
    x2: lerp(screenP0.x, screenP1.x, endRatio),
    y2: lerp(screenP0.y, screenP1.y, endRatio)
  };
}

function computeDoorSwingGeometry(segment, opening, swingDegrees = DOOR_SWING_DEGREES) {
  if (!segment) return null;

  const hingeSide = String(opening?.hinge_side || '').toLowerCase() === 'right' ? 'right' : 'left';
  const hingePoint = hingeSide === 'right'
    ? { x: segment.x2, y: segment.y2 }
    : { x: segment.x1, y: segment.y1 };
  const closedLeafEnd = hingeSide === 'right'
    ? { x: segment.x1, y: segment.y1 }
    : { x: segment.x2, y: segment.y2 };

  const hx = hingePoint.x;
  const hy = hingePoint.y;
  const vx = closedLeafEnd.x - hingePoint.x;
  const vy = closedLeafEnd.y - hingePoint.y;
  const r = Math.hypot(vx, vy);
  if (!isFinite(r) || r <= 1e-6) return null;

  const rotationSign = hingeSide === 'right' ? -1 : 1;
  const rad = rotationSign * (Math.PI / 180) * swingDegrees;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ox = hx + (vx * cos - vy * sin);
  const oy = hy + (vx * sin + vy * cos);

  return {
    hinge: hingePoint,
    closedLeafEnd,
    openLeafEnd: { x: ox, y: oy },
    arcPath: `M ${closedLeafEnd.x} ${closedLeafEnd.y} A ${r} ${r} 0 0 1 ${ox} ${oy}`
  };
}

function findContainingZoneIdForPoint(point, polygonMap) {
  for (const [zoneId, polygon] of polygonMap.entries()) {
    if (pointInPolygon(point, polygon)) return zoneId;
  }
  return null;
}

function findNearestWallDropTarget(demo, polygonMap, edgeGroups, zoneId, worldPoint, bounds, scale, pad) {
  const polygon = polygonMap.get(zoneId);
  if (!isValidPolygon(polygon)) return null;

  let best = null;
  let bestDistance = Infinity;

  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
    const wall = findWallElementForEdge(demo, edgeGroups, polygonMap, zoneId, edgeIndex);
    if (!wall || !wall.id) continue;
    if (!Array.isArray(wall.nodes) || !wall.nodes.includes(zoneId)) continue;

    const p0 = polygon[edgeIndex];
    const p1 = polygon[(edgeIndex + 1) % polygon.length];
    const seg = distancePointToSegment(worldPoint, p0, p1);
    if (seg.distance < bestDistance) {
      bestDistance = seg.distance;
      const screenP0 = projectPoint(p0, bounds, scale, pad);
      const screenP1 = projectPoint(p1, bounds, scale, pad);
      best = {
        targetWallElementId: wall.id,
        targetPositionRatio: Number(seg.ratio.toFixed(3)),
        edgeIndex,
        worldP0: p0,
        worldP1: p1,
        screenP0,
        screenP1,
        polygon
      };
    }
  }

  return best;
}

function getRadiatorThicknessForId(demo, radiatorId) {
  const radiators = Array.isArray(demo?.radiators?.radiators) ? demo.radiators.radiators : [];
  const match = radiators.find(item => item?.id === radiatorId);
  const coeff = Number(match?.heat_transfer_coefficient);
  if (!isFinite(coeff) || coeff <= 0) return 5;

  const minCoeff = 5;
  const maxCoeff = 10;
  const t = clamp((coeff - minCoeff) / (maxCoeff - minCoeff), 0, 1);
  return Number(lerp(4, 11, t).toFixed(2));
}

function getRadiatorNominalLengthMeters(radiator) {
  const widthMm = Number(radiator?.width);
  if (isFinite(widthMm) && widthMm > 0) {
    return Math.max(0.3, widthMm / 1000);
  }

  const area = Number(radiator?.surface_area);
  if (isFinite(area) && area > 0) {
    // Heuristic: typical panel height around 0.6m.
    return Math.max(0.3, area / 0.6);
  }

  return 0.8;
}

function chooseRadiatorEdge(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 2) return null;

  let bestHorizontal = null;
  let bestHorizontalMidY = -Infinity;
  let fallbackLongest = null;
  let fallbackLen = -Infinity;

  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (!isFinite(len) || len <= 1e-6) continue;

    if (len > fallbackLen) {
      fallbackLen = len;
      fallbackLongest = i;
    }

    if (Math.abs(dx) < Math.abs(dy) || len < 0.35) continue;
    const midY = (p0.y + p1.y) / 2;
    if (midY > bestHorizontalMidY) {
      bestHorizontalMidY = midY;
      bestHorizontal = i;
    }
  }

  return bestHorizontal !== null ? bestHorizontal : fallbackLongest;
}

function findEdgeIndexForWallElementId(demo, edgeGroups, polygonMap, zoneId, wallElementId) {
  if (!wallElementId) return null;
  const polygon = polygonMap.get(zoneId);
  if (!isValidPolygon(polygon)) return null;

  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
    const wall = findWallElementForEdge(demo, edgeGroups, polygonMap, zoneId, edgeIndex);
    if (wall?.id === wallElementId) return edgeIndex;
  }
  return null;
}

function getRadiatorPositionRatio(radiator) {
  if (typeof radiator?.position_ratio === 'number' && isFinite(radiator.position_ratio)) {
    return clamp(radiator.position_ratio, 0, 1);
  }
  return null;
}

function computeRadiatorSegmentForPlacement(demo, radiator, worldP0, worldP1, screenP0, screenP1, positionRatio) {
  const worldLen = Math.hypot(worldP1.x - worldP0.x, worldP1.y - worldP0.y);
  const screenLen = Math.hypot(screenP1.x - screenP0.x, screenP1.y - screenP0.y);
  if (!isFinite(worldLen) || worldLen <= 1e-6 || !isFinite(screenLen) || screenLen <= 1e-6) return null;

  const segmentLength = clamp(getRadiatorNominalLengthMeters(radiator), 0.35, Math.max(0.35, worldLen * 0.88));
  const halfRatio = clamp((segmentLength / worldLen) / 2, 0.02, 0.49);
  const centerRatio = clamp(positionRatio ?? 0.5, halfRatio, 1 - halfRatio);
  const startT = clamp(centerRatio - halfRatio, 0, 1);
  const endT = clamp(centerRatio + halfRatio, 0, 1);

  const edgeUx = (screenP1.x - screenP0.x) / screenLen;
  const edgeUy = (screenP1.y - screenP0.y) / screenLen;
  const insetPx = 10;
  const normalX = -edgeUy;
  const normalY = edgeUx;

  return {
    x1: lerp(screenP0.x, screenP1.x, startT) + normalX * insetPx,
    y1: lerp(screenP0.y, screenP1.y, startT) + normalY * insetPx,
    x2: lerp(screenP0.x, screenP1.x, endT) + normalX * insetPx,
    y2: lerp(screenP0.y, screenP1.y, endT) + normalY * insetPx,
    thickness: getRadiatorThicknessForId(demo, radiator?.radiator_id),
    radiatorType: String(radiator?.radiator_id || 'rad'),
    title: `${radiator?.radiator_id || 'radiator'} (${segmentLength.toFixed(2)}m)`,
    positionRatio: centerRatio
  };
}

function computeRadiatorSegments(demo, edgeGroups, polygonMap, zone, polygon, projected) {
  const radiators = Array.isArray(zone?.radiators) ? zone.radiators : [];
  if (!Array.isArray(polygon) || !Array.isArray(projected) || radiators.length === 0) return [];

  const defaultEdgeIndex = chooseRadiatorEdge(polygon);
  if (defaultEdgeIndex === null || defaultEdgeIndex < 0) return [];

  const grouped = new Map();
  radiators.forEach((rad, radiatorIndex) => {
    const preferredEdgeIndex = findEdgeIndexForWallElementId(demo, edgeGroups, polygonMap, zone?.id, rad?.wall_element_id);
    const edgeIndex = preferredEdgeIndex ?? defaultEdgeIndex;
    if (!grouped.has(edgeIndex)) grouped.set(edgeIndex, []);
    grouped.get(edgeIndex).push({ rad, radiatorIndex });
  });

  const segments = new Array(radiators.length).fill(null);
  for (const [edgeIndex, group] of grouped.entries()) {
    const worldP0 = polygon[edgeIndex];
    const worldP1 = polygon[(edgeIndex + 1) % polygon.length];
    const screenP0 = projected[edgeIndex];
    const screenP1 = projected[(edgeIndex + 1) % projected.length];
    if (!worldP0 || !worldP1 || !screenP0 || !screenP1) continue;

    const explicit = [];
    const implicit = [];
    group.forEach(entry => {
      const ratio = getRadiatorPositionRatio(entry.rad);
      if (ratio === null) {
        implicit.push(entry);
      } else {
        explicit.push({ ...entry, ratio });
      }
    });

    implicit.forEach((entry, idx) => {
      const ratio = Number(((idx + 1) / (implicit.length + 1)).toFixed(3));
      explicit.push({ ...entry, ratio });
    });

    explicit.forEach(entry => {
      const segment = computeRadiatorSegmentForPlacement(demo, entry.rad, worldP0, worldP1, screenP0, screenP1, entry.ratio);
      if (segment) {
        segment.edgeIndex = edgeIndex;
        segments[entry.radiatorIndex] = segment;
      }
    });
  }

  return segments;
}

function getEdgeWallVisualStyle(demo, edgeGroups, polygonMap, zoneId, edgeIndex) {
  const wall = findWallElementForEdge(demo, edgeGroups, polygonMap, zoneId, edgeIndex);
  if (!wall) return mapRValueToWallVisual(null, false);

  const boundaryIds = new Set((Array.isArray(demo?.zones) ? demo.zones : [])
    .filter(zone => zone && zone.type === 'boundary')
    .map(zone => zone.id));
  const isExternal = Array.isArray(wall.nodes) && wall.nodes.some(nodeId => boundaryIds.has(nodeId));
  const rValue = getWallStackRValue(wall);
  return mapRValueToWallVisual(rValue, isExternal);
}

export function renderAlternativeViz(demo, opts = {}) {
  const root = document.getElementById('alt-viz-container');
  if (!root) return;

  const onZoneSelected = typeof opts.onZoneSelected === 'function' ? opts.onZoneSelected : null;
  const onWallSelected = typeof opts.onWallSelected === 'function' ? opts.onWallSelected : null;
  const onOpeningSelected = typeof opts.onOpeningSelected === 'function' ? opts.onOpeningSelected : null;
  const onRadiatorSelected = typeof opts.onRadiatorSelected === 'function' ? opts.onRadiatorSelected : null;
  const onObjectMoved = typeof opts.onObjectMoved === 'function' ? opts.onObjectMoved : null;
  const onDataChanged = typeof opts.onDataChanged === 'function' ? opts.onDataChanged : null;
  const onMenuAction = typeof opts.onMenuAction === 'function' ? opts.onMenuAction : null;
  const canUndo = !!opts.canUndo;
  const canRedo = !!opts.canRedo;

  const requestAddRoomAt = (x, y, level) => {
    if (typeof onMenuAction !== 'function') return;
    onMenuAction(
      'structure.add.room.at',
      {
        action: 'structure.add.room.at',
        payload: { x, y, level }
      },
      {
        demo,
        selectedZoneId,
        selectedLevel
      }
    );
  };

  root.innerHTML = '';

  const rooms = getRoomZones(demo);
  ensureSelectedZone(rooms);

  root.appendChild(createProjectSummaryStrip(demo, rooms, {
    onMenuAction,
    getContext: () => ({
      demo,
      selectedZoneId,
      selectedLevel
    })
  }));

  const menuBar = createAltVizMenuBar(onMenuAction, () => ({
    demo,
    canUndo,
    canRedo,
    selectedZoneId,
    selectedLevel
  }));
  root.appendChild(menuBar);

  const mainViewHost = document.createElement('div');
  mainViewHost.className = 'alt-viz-main-view';
  root.appendChild(mainViewHost);

  const envStrip = createEnvironmentControlStrip(demo, onMenuAction, () => ({
    demo,
    selectedZoneId,
    selectedLevel
  }));
  root.appendChild(envStrip);

  const levels = rooms.length > 0
    ? [...new Set(rooms.map(z => (typeof z.level === 'number' ? z.level : 0)))].sort((a, b) => a - b)
    : [0];
  ensureSelectedLevel(levels);

  const toolbar = document.createElement('div');
  toolbar.className = 'alt-viz-toolbar';

  const globalTargetTemp = typeof demo?.meta?.global_target_temperature === 'number'
    ? demo.meta.global_target_temperature : 21;
  const levelMiniViews = createLevelMiniViews(rooms, levels, selectedLevel, (level) => {
    selectedLevel = level;
    renderAlternativeViz(demo, opts);
  }, {
    globalTargetTemp,
    onSetpointChanged: (zone, value) => {
      if (typeof onMenuAction === 'function') {
        onMenuAction('zones.setpoint', {
          action: 'zones.setpoint',
          payload: { zoneId: zone.id, value }
        }, {
          demo,
          selectedZoneId,
          selectedLevel
        });
        return;
      }
      zone.setpoint_temperature = value;
      if (onDataChanged) onDataChanged({});
      renderAlternativeViz(demo, opts);
    },
    onRoomHeatingChanged: (zone, isUnheated) => {
      if (typeof onMenuAction === 'function') {
        onMenuAction('zones.heating', {
          action: 'zones.heating',
          payload: { zoneId: zone.id, isUnheated }
        }, {
          demo,
          selectedZoneId,
          selectedLevel
        });
        return;
      }
      if (isUnheated) {
        zone.is_unheated = true;
        delete zone.setpoint_temperature;
        zone.is_boiler_control = false;
      } else {
        delete zone.is_unheated;
      }
      if (onDataChanged) onDataChanged({});
      renderAlternativeViz(demo, opts);
    }
  });
  toolbar.appendChild(levelMiniViews);

  root.appendChild(toolbar);

  const hint = document.createElement('div');
  hint.className = 'alt-viz-message';
  hint.textContent = 'Drag walls to reshape rooms, drag room bodies to move zones, and drag object handles to move windows, doors, and radiators. Clicking a handle opens that object in the editor.';
  root.appendChild(hint);

  renderLegend(root);

  const levelRooms = rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === selectedLevel);
  if (levelRooms.length === 0) {
    const emptyWrap = document.createElement('div');
    emptyWrap.className = 'alt-viz-svg-wrap';

    const emptySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    emptySvg.setAttribute('class', 'alt-viz-svg');
    emptySvg.setAttribute('viewBox', '0 0 1000 700');
    emptySvg.setAttribute('role', 'img');
    emptySvg.setAttribute('aria-label', `Empty level ${selectedLevel} floor map`);

    const emptyBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    emptyBg.setAttribute('x', '0');
    emptyBg.setAttribute('y', '0');
    emptyBg.setAttribute('width', '1000');
    emptyBg.setAttribute('height', '700');
    emptyBg.setAttribute('fill', 'rgba(18, 24, 34, 0.35)');
    emptySvg.appendChild(emptyBg);

    emptySvg.addEventListener('dblclick', (e) => {
      if (e.target !== emptySvg && e.target !== emptyBg) return;
      e.preventDefault();
      e.stopPropagation();
      const svgPt = getSVGPoint(emptySvg, e);
      // Map empty canvas coordinates into the same rough world scale used by default polygons.
      const worldX = Number((svgPt.x / 100).toFixed(3));
      const worldY = Number((svgPt.y / 100).toFixed(3));
      requestAddRoomAt(worldX, worldY, selectedLevel);
    });

    emptyWrap.appendChild(emptySvg);
    mainViewHost.appendChild(emptyWrap);
    renderEmptyMessage(mainViewHost, 'No rooms on selected level.');
    return;
  }

  const previewPolygons = buildSeedPolygons(levelRooms);
  const polygonEntries = levelRooms
    .map(zone => ({ zone, polygon: getPolygonForZone(zone, previewPolygons) }))
    .filter(entry => isValidPolygon(entry.polygon));

  const ghostLevel = getGhostLevel(levels, selectedLevel);
  const ghostRooms = ghostLevel === null
    ? []
    : rooms.filter(z => (typeof z.level === 'number' ? z.level : 0) === ghostLevel);
  const ghostPreviewPolygons = buildSeedPolygons(ghostRooms);
  const ghostEntries = ghostRooms
    .map(zone => ({ zone, polygon: getPolygonForZone(zone, ghostPreviewPolygons) }))
    .filter(entry => isValidPolygon(entry.polygon));

  if (polygonEntries.length === 0) {
    renderEmptyMessage(root, 'No valid polygons to render on selected level.');
    return;
  }

  const bounds = polygonBounds([...polygonEntries.map(e => e.polygon), ...ghostEntries.map(e => e.polygon)]);

  const svgWrap = document.createElement('div');
  svgWrap.className = 'alt-viz-svg-wrap';

  const canvasW = 1000;
  const canvasH = 700;
  const pad = 48;
  const ns = 'http://www.w3.org/2000/svg';
  const scale = computeRenderScale(bounds, canvasW, canvasH, pad);
  const rawPolygonMap = new Map(polygonEntries.map(({ zone, polygon }) => [zone.id, clonePolygon(polygon)]));
  const polygonMap = normalizePolygonMapForSharedWalls(rawPolygonMap);
  const ghostRawPolygonMap = new Map(ghostEntries.map(({ zone, polygon }) => [zone.id, clonePolygon(polygon)]));
  const ghostPolygonMap = normalizePolygonMapForSharedWalls(ghostRawPolygonMap);
  const ghostPolygonsForSnap = Array.from(ghostPolygonMap.values());
  const edgeGroups = buildSharedEdgeGroups(polygonMap);
  const zoneRenderStateById = new Map();
  let activeLengthEditor = null;
  let activeNameEditor = null;
  const closeNameEditor = () => {
    if (activeNameEditor && activeNameEditor.parentNode) {
      activeNameEditor.parentNode.removeChild(activeNameEditor);
    }
    activeNameEditor = null;
  };

  const openNameEditor = (zone, cx, cy) => {
    closeLengthEditor();
    closeNameEditor();
    suppressWallSelectionUntil = Date.now() + 250;

    const editor = document.createElementNS(ns, 'foreignObject');
    editor.setAttribute('class', 'alt-wall-length-editor');
    editor.setAttribute('x', String(cx - 60));
    editor.setAttribute('y', String(cy - 14));
    editor.setAttribute('width', '120');
    editor.setAttribute('height', '28');

    const input = document.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    input.setAttribute('type', 'text');
    input.setAttribute('class', 'alt-wall-length-input');
    input.value = zone.name || '';
    input.placeholder = zone.id || '';

    let committed = false;
    const commitNameEdit = () => {
      if (committed) return;
      committed = true;
      const nextName = input.value.trim();
      if (nextName) zone.name = nextName; else delete zone.name;
      suppressWallSelectionUntil = Date.now() + 250;
      closeNameEditor();

      if (typeof onMenuAction === 'function') {
        onMenuAction(
          'zones.rename',
          {
            action: 'zones.rename',
            payload: { zoneId: zone.id, name: nextName }
          },
          {
            demo,
            selectedZoneId: zone.id,
            selectedLevel
          }
        );
        return;
      }

      if (onDataChanged) {
        onDataChanged({});
      } else {
        renderAlternativeViz(demo, opts);
      }
    };

    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitNameEdit();
      } else if (e.key === 'Escape') {
        committed = true;
        closeNameEditor();
      }
    });
    input.addEventListener('blur', commitNameEdit);

    editor.appendChild(input);
    svg.appendChild(editor);
    activeNameEditor = editor;

    setTimeout(() => {
      try { input.focus(); input.select(); } catch (_) {}
    }, 0);
  };


  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'alt-viz-svg');
  svg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Alternative polygon room view for level ${selectedLevel}`);
  svg.addEventListener('dblclick', (e) => {
    if (e.target !== svg) return;
    if (dragState || roomDragState || objectDragState) return;
    e.preventDefault();
    e.stopPropagation();
    const svgPt = getSVGPoint(svg, e);
    const worldPt = svgPointToWorld(svgPt, bounds, scale, pad);
    requestAddRoomAt(worldPt.x, worldPt.y, selectedLevel);
  });

  let ghostGroup = null;
  if (ghostEntries.length > 0) {
    ghostGroup = document.createElementNS(ns, 'g');
    ghostGroup.setAttribute('class', 'alt-ghost-layer');
    ghostEntries.forEach(({ zone }) => {
      const polygon = ghostPolygonMap.get(zone.id);
      if (!isValidPolygon(polygon)) return;
      const projected = polygon.map(pt => projectPoint(pt, bounds, scale, pad));

      const ghostPoly = document.createElementNS(ns, 'polygon');
      ghostPoly.setAttribute('points', projected.map(p => `${p.x},${p.y}`).join(' '));
      ghostPoly.setAttribute('class', 'alt-ghost-room');
      ghostGroup.appendChild(ghostPoly);

      for (let idx = 0; idx < projected.length; idx++) {
        const p0 = projected[idx];
        const p1 = projected[(idx + 1) % projected.length];
        const ghostWall = document.createElementNS(ns, 'line');
        ghostWall.setAttribute('x1', String(p0.x));
        ghostWall.setAttribute('y1', String(p0.y));
        ghostWall.setAttribute('x2', String(p1.x));
        ghostWall.setAttribute('y2', String(p1.y));
        ghostWall.setAttribute('class', 'alt-ghost-wall');
        ghostGroup.appendChild(ghostWall);
      }
    });
  }

  const closeLengthEditor = () => {
    if (activeLengthEditor && activeLengthEditor.parentNode) {
      activeLengthEditor.parentNode.removeChild(activeLengthEditor);
    }
    activeLengthEditor = null;
  };

  const applyEdgeLength = (zoneId, edgeIndex, nextLengthRaw) => {
    const changedPolygons = applyWallLengthEditToPolygonMap(polygonMap, zoneId, edgeIndex, nextLengthRaw);

    suppressWallSelectionUntil = Date.now() + 250;
    closeLengthEditor();
    if (Object.keys(changedPolygons).length > 0 && onDataChanged) onDataChanged(changedPolygons);
  };

  const openLengthEditor = (zoneId, edgeIndex) => {
    closeLengthEditor();
    const polygon = polygonMap.get(zoneId);
    if (!polygon || polygon.length < 2) return;

    const p0 = polygon[edgeIndex];
    const p1 = polygon[(edgeIndex + 1) % polygon.length];
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const proj0 = projectPoint(p0, bounds, scale, pad);
    const proj1 = projectPoint(p1, bounds, scale, pad);
    const mx = (proj0.x + proj1.x) / 2;
    const my = (proj0.y + proj1.y) / 2;

    const editor = document.createElementNS(ns, 'foreignObject');
    editor.setAttribute('class', 'alt-wall-length-editor');
    editor.setAttribute('x', String(mx - 42));
    editor.setAttribute('y', String(my - 14));
    editor.setAttribute('width', '84');
    editor.setAttribute('height', '28');

    const input = document.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    input.setAttribute('type', 'number');
    input.setAttribute('step', '0.05');
    input.setAttribute('min', '0.05');
    input.setAttribute('class', 'alt-wall-length-input');
    input.value = len.toFixed(2);

    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applyEdgeLength(zoneId, edgeIndex, input.value);
      } else if (e.key === 'Escape') {
        closeLengthEditor();
      }
    });
    input.addEventListener('blur', () => {
      applyEdgeLength(zoneId, edgeIndex, input.value);
    });

    editor.appendChild(input);
    svg.appendChild(editor);
    activeLengthEditor = editor;

    setTimeout(() => {
      try {
        input.focus();
        input.select();
      } catch (_) {
        // no-op
      }
    }, 0);
  };

  svg.addEventListener('mousemove', (e) => {
    if (objectDragState) {
      const svgPt = getSVGPoint(svg, e);
      const worldPt = svgPointToWorld(svgPt, objectDragState.bounds, objectDragState.scale, objectDragState.pad);
      objectDragState.currentWorldPoint = worldPt;
      objectDragState.currentSvgPoint = svgPt;

      const deltaWorld = {
        x: worldPt.x - objectDragState.startWorldPoint.x,
        y: worldPt.y - objectDragState.startWorldPoint.y
      };
      const thresholdWorld = DRAG_START_THRESHOLD_PX / objectDragState.scale;
      if (!objectDragState.didMove && Math.hypot(deltaWorld.x, deltaWorld.y) >= thresholdWorld) {
        objectDragState.didMove = true;
      }

      if (objectDragState.didMove) {
        const targetZoneId = findContainingZoneIdForPoint(worldPt, polygonMap);
        if (targetZoneId) {
          const nearest = findNearestWallDropTarget(demo, polygonMap, edgeGroups, targetZoneId, worldPt, bounds, scale, pad);
          const targetPolygon = nearest?.polygon || polygonMap.get(targetZoneId);
          const targetCentroid = targetPolygon ? projectPoint(polygonCentroid(targetPolygon), bounds, scale, pad) : null;

          if (objectDragState.kind === 'opening' && nearest && objectDragState.openingState && objectDragState.opening) {
            const previewOpening = {
              ...objectDragState.opening,
              position_ratio: nearest.targetPositionRatio
            };
            const previewSegment = computeOpeningSegmentOnEdge(
              previewOpening,
              nearest.worldP0,
              nearest.worldP1,
              nearest.screenP0,
              nearest.screenP1
            );
            if (previewSegment) {
              updateOpeningRenderState(objectDragState.openingState, previewSegment, targetCentroid);
              return;
            }
          }

          if (objectDragState.kind === 'radiator' && nearest && objectDragState.radiatorRenderState && objectDragState.radiator) {
            const previewRadiator = {
              ...objectDragState.radiator,
              wall_element_id: nearest.targetWallElementId,
              position_ratio: nearest.targetPositionRatio
            };
            const previewSegment = computeRadiatorSegmentForPlacement(
              demo,
              previewRadiator,
              nearest.worldP0,
              nearest.worldP1,
              nearest.screenP0,
              nearest.screenP1,
              nearest.targetPositionRatio
            );
            if (previewSegment) {
              updateRadiatorRenderState(
                objectDragState.radiatorRenderState,
                previewSegment,
                previewSegment.radiatorType.replace(/^type_/i, ''),
                targetCentroid
              );
              return;
            }
          }
        }

        const deltaSvgX = svgPt.x - objectDragState.startSvgPoint.x;
        const deltaSvgY = svgPt.y - objectDragState.startSvgPoint.y;

        if (objectDragState.kind === 'opening' && objectDragState.openingState && objectDragState.originalSegment) {
          const base = objectDragState.originalSegment;
          const translatedSegment = {
            x1: base.x1 + deltaSvgX,
            y1: base.y1 + deltaSvgY,
            x2: base.x2 + deltaSvgX,
            y2: base.y2 + deltaSvgY
          };
          updateOpeningRenderState(objectDragState.openingState, translatedSegment, null);
          return;
        }

        if (objectDragState.kind === 'radiator' && objectDragState.radiatorRenderState && objectDragState.originalSegment) {
          const base = objectDragState.originalSegment;
          const translatedSegment = {
            x1: base.x1 + deltaSvgX,
            y1: base.y1 + deltaSvgY,
            x2: base.x2 + deltaSvgX,
            y2: base.y2 + deltaSvgY,
            thickness: base.thickness || getRadiatorThicknessForId(objectDragState.radiator?.radiator_id),
            title: base.title || '',
            radiatorType: String(objectDragState.radiator?.radiator_id || 'rad')
          };
          updateRadiatorRenderState(
            objectDragState.radiatorRenderState,
            translatedSegment,
            translatedSegment.radiatorType.replace(/^type_/i, ''),
            null
          );
          return;
        }

        objectDragState.handleElement.setAttribute('cx', String(svgPt.x));
        objectDragState.handleElement.setAttribute('cy', String(svgPt.y));
      }
      return;
    }

    if (roomDragState) {
      const svgPt = getSVGPoint(svg, e);
      const worldPt = svgPointToWorld(svgPt, roomDragState.bounds, roomDragState.scale, roomDragState.pad);
      const rawDeltaX = worldPt.x - roomDragState.startWorldPoint.x;
      const rawDeltaY = worldPt.y - roomDragState.startWorldPoint.y;

      const deltaX = snapRoomAxisDelta(
        rawDeltaX,
        roomDragState.baseBounds.minX,
        roomDragState.baseBounds.maxX,
        roomDragState.snapTargets.xTargets,
        DRAG_SNAP_STEP_M,
        DRAG_NEAR_SNAP_THRESHOLD_M
      );
      const deltaY = snapRoomAxisDelta(
        rawDeltaY,
        roomDragState.baseBounds.minY,
        roomDragState.baseBounds.maxY,
        roomDragState.snapTargets.yTargets,
        DRAG_SNAP_STEP_M,
        DRAG_NEAR_SNAP_THRESHOLD_M
      );

      roomDragState.currentDeltaX = deltaX;
      roomDragState.currentDeltaY = deltaY;

      const thresholdWorld = DRAG_START_THRESHOLD_PX / roomDragState.scale;
      if (!roomDragState.didMove && Math.hypot(deltaX, deltaY) < thresholdWorld) {
        return;
      }
      roomDragState.didMove = true;

      const movedPolygon = translatePolygonByDelta(roomDragState.basePolygon, deltaX, deltaY);
      polygonMap.set(roomDragState.zoneId, movedPolygon);
      updateRenderedZoneGeometry(
        zoneRenderStateById.get(roomDragState.zoneId),
        movedPolygon,
        roomDragState.bounds,
        roomDragState.scale,
        roomDragState.pad
      );
      return;
    }

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
    if (objectDragState) {
      const {
        didMove,
        kind,
        openingKind,
        openingId,
        radiatorId,
        sourceZoneId,
        sourceWallElementId,
        currentWorldPoint,
        handleElement
      } = objectDragState;

      const fallbackCenter = objectDragState.objectCenterWorld;
      const dropWorldPoint = currentWorldPoint || fallbackCenter;
      const targetZoneId = dropWorldPoint ? findContainingZoneIdForPoint(dropWorldPoint, polygonMap) : null;

      objectDragState = null;

      if (!didMove) {
        if (kind === 'opening' && onOpeningSelected) {
          onOpeningSelected(sourceZoneId, sourceWallElementId, openingKind, openingId);
        } else if (kind === 'radiator' && onRadiatorSelected) {
          onRadiatorSelected(sourceZoneId, radiatorId);
        }
        return;
      }

      suppressWallSelectionUntil = Date.now() + 250;

      if (!targetZoneId || !dropWorldPoint || !onObjectMoved) {
        renderAlternativeViz(demo, opts);
        return;
      }

      if (kind === 'opening') {
        const nearest = findNearestWallDropTarget(demo, polygonMap, edgeGroups, targetZoneId, dropWorldPoint, bounds, scale, pad);
        if (nearest) {
          onObjectMoved({
            kind: 'opening',
            openingKind,
            openingId,
            sourceZoneId,
            sourceWallElementId,
            targetZoneId,
            targetWallElementId: nearest.targetWallElementId,
            targetPositionRatio: nearest.targetPositionRatio
          });
          return;
        }
      }

      if (kind === 'radiator') {
        const nearest = findNearestWallDropTarget(demo, polygonMap, edgeGroups, targetZoneId, dropWorldPoint, bounds, scale, pad);
        onObjectMoved({
          kind: 'radiator',
          radiatorId,
          sourceZoneId,
          targetZoneId,
          targetWallElementId: nearest?.targetWallElementId || null,
          targetPositionRatio: nearest?.targetPositionRatio ?? null
        });
        return;
      }

      if (handleElement) {
        renderAlternativeViz(demo, opts);
      }
      return;
    }

    if (roomDragState) {
      const { onDataChanged: onDC, zoneId, didMove, currentDeltaX = 0, currentDeltaY = 0, basePolygon } = roomDragState;
      if (didMove) {
        suppressWallSelectionUntil = Date.now() + 250;
      }
      roomDragState = null;
      if (didMove && onDC) {
        onDC({
          [zoneId]: translatePolygonByDelta(basePolygon, currentDeltaX, currentDeltaY)
        });
      }
      return;
    }

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
  svg.addEventListener('mousedown', () => {
    if (!dragState && !roomDragState && !objectDragState) closeLengthEditor();
  });

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
    roomPoly.style.cursor = onDataChanged ? 'grab' : 'pointer';
    roomPoly.addEventListener('mousedown', (e) => {
      if (!onDataChanged || dragState || roomDragState) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const basePolygon = polygonMap.get(zone.id);
      if (!isValidPolygon(basePolygon)) return;
      const startWorldPoint = svgPointToWorld(getSVGPoint(svg, e), bounds, scale, pad);
      const baseBounds = getPolygonAxisBounds(basePolygon);
      const snapTargets = collectRoomDragSnapTargets(polygonMap, zone.id, ghostPolygonsForSnap);
      roomDragState = {
        zoneId: zone.id,
        bounds,
        scale,
        pad,
        startWorldPoint,
        basePolygon: clonePolygon(basePolygon),
        baseBounds,
        snapTargets,
        onDataChanged,
        didMove: false,
        currentDeltaX: 0,
        currentDeltaY: 0
      };
      roomPoly.style.cursor = 'grabbing';
    });
    roomPoly.addEventListener('mouseup', () => {
      roomPoly.style.cursor = onDataChanged ? 'grab' : 'pointer';
    });
    roomPoly.addEventListener('click', () => {
      if (dragState || roomDragState || Date.now() < suppressWallSelectionUntil) return;
      selectedZoneId = zone.id;
      if (onZoneSelected) onZoneSelected(zone.id);
      renderAlternativeViz(demo, opts);
    });
    svg.appendChild(roomPoly);

    const externalTemp = Number(demo?.meta?.externalTemp) || 3;
    const tempText = formatZoneTemperatureText(zone, externalTemp);
    const achText = getZoneAchText(zone);
    const capacity = getZoneCapacitySummary(zone, externalTemp);
    const savingsText = getZoneSavingsText(zone);

    const infoLines = [];
    if (tempText) infoLines.push(tempText);
    if (achText) infoLines.push(achText);
    if (capacity) infoLines.push(capacity.text);
    if (savingsText) infoLines.push(savingsText);
    if (zone.is_unheated !== true) {
      const epc = computeZoneEpcEstimate(zone);
      const epcValue = epc.intensityKwhM2Yr === null ? 'n/a' : epc.intensityKwhM2Yr.toFixed(0);
      infoLines.push(`EPC ${epc.letter} (${epcValue})`);
    }

    const nameY = centroid.y - (infoLines.length * 10);

    const nameText = document.createElementNS(ns, 'text');
    nameText.setAttribute('x', String(centroid.x));
    nameText.setAttribute('y', String(nameY));
    nameText.setAttribute('fill', '#ffffff');
    nameText.setAttribute('font-size', '15');
    nameText.setAttribute('font-weight', '700');
    nameText.setAttribute('text-anchor', 'middle');
    nameText.setAttribute('paint-order', 'stroke');
    nameText.setAttribute('stroke', 'rgba(0, 0, 0, 0.65)');
    nameText.setAttribute('stroke-width', '3');
    nameText.setAttribute('class', 'alt-room-name-label');
    nameText.textContent = `${zone.name || zone.id || 'Unnamed room'}${zone.is_boiler_control ? ' 🔥' : ''}`;
    if (onDataChanged) {
      nameText.style.cursor = 'text';
      nameText.addEventListener('click', (e) => {
        if (dragState || roomDragState || Date.now() < suppressWallSelectionUntil) return;
        e.stopPropagation();
        openNameEditor(zone, centroid.x, nameY);
      });
    }
    svg.appendChild(nameText);

    let infoText = null;
    if (infoLines.length > 0) {
      infoText = document.createElementNS(ns, 'text');
      infoText.setAttribute('x', String(centroid.x));
      infoText.setAttribute('y', String(nameY));
      infoText.setAttribute('fill', '#ffffff');
      infoText.setAttribute('text-anchor', 'middle');
      infoText.style.pointerEvents = 'none';
      infoLines.forEach(line => {
        const tspan = document.createElementNS(ns, 'tspan');
        tspan.setAttribute('x', String(centroid.x));
        tspan.setAttribute('dy', '18');
        tspan.textContent = line;
        tspan.setAttribute('font-size', '12');
        tspan.setAttribute('font-weight', '500');
        infoText.appendChild(tspan);
      });
      svg.appendChild(infoText);
    }
    const radiatorElements = [];
    const radiatorLabelElements = [];
    const radiatorHandleElements = [];
    const radiatorRenderStates = [];
    const radiatorSegments = computeRadiatorSegments(demo, edgeGroups, polygonMap, zone, polygon, projected);
    radiatorSegments.forEach((seg, radiatorIndex) => {
      if (!seg) {
        radiatorElements[radiatorIndex] = null;
        radiatorLabelElements[radiatorIndex] = null;
        radiatorHandleElements[radiatorIndex] = null;
        radiatorRenderStates[radiatorIndex] = null;
        return;
      }

      const radiatorLine = document.createElementNS(ns, 'line');
      radiatorLine.setAttribute('class', 'alt-radiator-line');
      radiatorElements[radiatorIndex] = radiatorLine;
      svg.appendChild(radiatorLine);

      const radiatorLabel = document.createElementNS(ns, 'text');
      radiatorLabel.setAttribute('class', 'alt-radiator-label');
      radiatorLabelElements[radiatorIndex] = radiatorLabel;
      svg.appendChild(radiatorLabel);

      let radiatorHandle = null;
      if (onObjectMoved || onRadiatorSelected) {
        radiatorHandle = document.createElementNS(ns, 'circle');
        radiatorHandle.setAttribute('r', String(OBJECT_HANDLE_RADIUS_PX));
        radiatorHandle.setAttribute('class', 'alt-object-handle alt-radiator-handle');
        radiatorHandle.style.cursor = 'grab';

        const radiatorId = getRadiatorId(zone.radiators?.[radiatorIndex], radiatorIndex);
        radiatorHandle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();

          const startSvgPoint = getSVGPoint(svg, e);
          const startWorldPoint = svgPointToWorld(startSvgPoint, bounds, scale, pad);
          objectDragState = {
            kind: 'radiator',
            sourceZoneId: zone.id,
            radiatorId,
            radiator: zone.radiators?.[radiatorIndex] || null,
            radiatorRenderState: radiatorRenderStates[radiatorIndex],
            bounds,
            scale,
            pad,
            startWorldPoint,
            currentWorldPoint: startWorldPoint,
            currentSvgPoint: startSvgPoint,
            objectCenterWorld: startWorldPoint,
            handleElement: radiatorHandle,
            startSvgPoint,
            originalSegment: { ...seg },
            didMove: false
          };
          radiatorHandle.style.cursor = 'grabbing';
          if (radiatorRenderStates[radiatorIndex]) {
            svg.appendChild(radiatorRenderStates[radiatorIndex].line);
            svg.appendChild(radiatorRenderStates[radiatorIndex].label);
            if (radiatorRenderStates[radiatorIndex].handle) svg.appendChild(radiatorRenderStates[radiatorIndex].handle);
          }
        });

        radiatorHandle.addEventListener('mouseup', () => {
          radiatorHandle.style.cursor = 'grab';
        });

        radiatorHandleElements[radiatorIndex] = radiatorHandle;
        svg.appendChild(radiatorHandle);
      } else {
        radiatorHandleElements[radiatorIndex] = null;
      }

      radiatorRenderStates[radiatorIndex] = {
        line: radiatorLine,
        label: radiatorLabel,
        handle: radiatorHandle
      };
      updateRadiatorRenderState(radiatorRenderStates[radiatorIndex], seg, seg.radiatorType.replace(/^type_/i, ''), centroid);
    });

    const edgeElements = [];
    const edgeVisualElements = [];
    const edgeLabelElements = [];
    const edgeOpeningElements = [];
    for (let idx = 0; idx < projected.length; idx++) {
      const p0 = projected[idx];
      const p1 = projected[(idx + 1) % projected.length];
      const worldP0 = polygonMap.get(zone.id)[idx];
      const worldP1 = polygonMap.get(zone.id)[(idx + 1) % polygonMap.get(zone.id).length];
      const wallElement = findWallElementForEdge(demo, edgeGroups, polygonMap, zone.id, idx);
      const wallVisual = getEdgeWallVisualStyle(demo, edgeGroups, polygonMap, zone.id, idx);

      const visibleWall = document.createElementNS(ns, 'line');
      visibleWall.setAttribute('x1', String(p0.x));
      visibleWall.setAttribute('y1', String(p0.y));
      visibleWall.setAttribute('x2', String(p1.x));
      visibleWall.setAttribute('y2', String(p1.y));
      visibleWall.setAttribute('class', 'alt-wall-active-line');
      visibleWall.setAttribute('stroke', wallVisual.color);
      visibleWall.setAttribute('stroke-width', String(wallVisual.width));
      edgeVisualElements.push(visibleWall);
      svg.appendChild(visibleWall);

      const openingsOnEdge = [];
      if (shouldRenderOpeningsForWallEdge(wallElement, zone.id)) {
        getWallOpeningsForRender(demo, wallElement).forEach(({ kind, opening, ownerZoneId, thickness }, openingIndex) => {
          if (ownerZoneId && ownerZoneId !== zone.id) return;
          const segment = computeOpeningSegmentOnEdge(opening, worldP0, worldP1, p0, p1);
          if (!segment) return;
          const openingLine = document.createElementNS(ns, 'line');
          openingLine.setAttribute('x1', String(segment.x1));
          openingLine.setAttribute('y1', String(segment.y1));
          openingLine.setAttribute('x2', String(segment.x2));
          openingLine.setAttribute('y2', String(segment.y2));
          openingLine.setAttribute('class', kind === 'door' ? 'alt-opening-line alt-opening-door' : 'alt-opening-line alt-opening-window');
          openingLine.setAttribute('stroke-width', String(thickness));
          let openingArc = null;
          let openingLeaf = null;
          if (kind === 'door') {
            const swing = computeDoorSwingGeometry(segment, opening);
            if (swing) {
              openingArc = document.createElementNS(ns, 'path');
              openingArc.setAttribute('d', swing.arcPath);
              openingArc.setAttribute('class', 'alt-opening-door-arc');
              svg.appendChild(openingArc);

              openingLeaf = document.createElementNS(ns, 'line');
              openingLeaf.setAttribute('x1', String(swing.hinge.x));
              openingLeaf.setAttribute('y1', String(swing.hinge.y));
              openingLeaf.setAttribute('x2', String(swing.openLeafEnd.x));
              openingLeaf.setAttribute('y2', String(swing.openLeafEnd.y));
              openingLeaf.setAttribute('class', 'alt-opening-door-leaf');
              svg.appendChild(openingLeaf);
            }
          }

          let openingHandle = null;
          if (onObjectMoved || onOpeningSelected) {
            const handlePos = getOffsetHandlePositionFromSegment(
              segment,
              OPENING_HANDLE_OFFSET_ALONG_PX,
              OPENING_HANDLE_OFFSET_NORMAL_PX,
              centroid
            );
            openingHandle = document.createElementNS(ns, 'circle');
            openingHandle.setAttribute('cx', String(handlePos.x));
            openingHandle.setAttribute('cy', String(handlePos.y));
            openingHandle.setAttribute('r', String(OBJECT_HANDLE_RADIUS_PX));
            openingHandle.setAttribute('class', kind === 'door' ? 'alt-object-handle alt-door-handle' : 'alt-object-handle alt-window-handle');
            openingHandle.style.cursor = 'grab';

            const openingId = getOpeningId(opening, openingIndex);
            openingHandle.addEventListener('mousedown', (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();

              const startSvgPoint = getSVGPoint(svg, e);
              const startWorldPoint = svgPointToWorld(startSvgPoint, bounds, scale, pad);
              const centerRatio = getOpeningPositionRatio(opening);
              const centerWorld = {
                x: lerp(worldP0.x, worldP1.x, centerRatio),
                y: lerp(worldP0.y, worldP1.y, centerRatio)
              };
              objectDragState = {
                kind: 'opening',
                openingKind: kind,
                openingId,
                sourceZoneId: zone.id,
                sourceWallElementId: wallElement?.id || null,
                opening,
                openingState: null,
                bounds,
                scale,
                pad,
                startWorldPoint,
                currentWorldPoint: startWorldPoint,
                currentSvgPoint: startSvgPoint,
                objectCenterWorld: centerWorld,
                handleElement: openingHandle,
                startSvgPoint,
                originalSegment: { ...segment },
                didMove: false
              };
              openingHandle.style.cursor = 'grabbing';
            });

            openingHandle.addEventListener('mouseup', () => {
              openingHandle.style.cursor = 'grab';
            });

            svg.appendChild(openingHandle);
          }

          const openingState = { line: openingLine, arc: openingArc, leaf: openingLeaf, opening, kind, handle: openingHandle };
          openingsOnEdge.push(openingState);
          if (openingHandle) {
            openingHandle.addEventListener('mousedown', () => {
              if (objectDragState) {
                objectDragState.openingState = openingState;
              }
              svg.appendChild(openingLine);
              if (openingArc) svg.appendChild(openingArc);
              if (openingLeaf) svg.appendChild(openingLeaf);
              svg.appendChild(openingHandle);
            });
          }
          svg.appendChild(openingLine);
        });
      }
      edgeOpeningElements.push(openingsOnEdge);

      if (onDataChanged) {
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
          const ghostSnapTargets = collectParallelSnapTargetsFromPolygons(ghostPolygonsForSnap, baseP0, baseP1, normal);
          snapTargets.push(...ghostSnapTargets);
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

        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const wallLen = Math.hypot(worldP1.x - worldP0.x, worldP1.y - worldP0.y);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', String(midX));
        label.setAttribute('y', String(midY));
        label.setAttribute('class', 'alt-wall-length-label');
        label.textContent = formatLengthLabel(wallLen);
        label.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        label.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragState) return;
          openLengthEditor(zone.id, idx);
        });
        edgeLabelElements.push(label);
        svg.appendChild(label);
      }
    }

    zoneRenderStateById.set(zone.id, {
      polygonElement: roomPoly,
      textElement: nameText,
      infoTextElement: infoText,
      tspans: infoText ? Array.from(infoText.querySelectorAll('tspan')) : [],
      edgeElements,
      edgeVisualElements,
      edgeLabelElements,
      edgeOpeningElements,
      radiatorElements,
      radiatorLabelElements,
      radiatorHandleElements,
      demo,
      edgeGroups,
      polygonMap,
      zone,
      lineCount: infoLines.length + 1
    });
  });

  if (ghostGroup) {
    svg.appendChild(ghostGroup);
  }

  svgWrap.appendChild(svg);
  mainViewHost.appendChild(svgWrap);
}
