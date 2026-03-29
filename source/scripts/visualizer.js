// Thermal visualizer: generates thermal color-coded table display for heating balance
import { formatZoneTemperatureText, getZoneCapacitySummary, getZoneSavingsText } from './zone_text.js';
import { getThermalColorClass } from './zone_thermal.js';

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

function computeEpcEstimate(zone) {
  const deliveredPerM2 = typeof zone.delivered_heat_per_unit_area === 'number'
    ? zone.delivered_heat_per_unit_area
    : (typeof zone.heat_loss_per_unit_area === 'number' ? zone.heat_loss_per_unit_area : null);
  if (deliveredPerM2 === null) {
    return { letter: 'N/A', intensityKwhM2Yr: null };
  }

  // Approximate annualized delivered heating intensity under current modulation/TRV behavior.
  const intensityKwhM2Yr = Math.max(0, (deliveredPerM2 * 24 * 365) / 1000);
  return { letter: getEpcBand(intensityKwhM2Yr), intensityKwhM2Yr };
}

function computeWholeHouseStats(demo) {
  const zones = Array.isArray(demo.zones) ? demo.zones : [];
  const conditionedZones = zones.filter(zone => zone.type !== 'boundary' && zone.is_unheated !== true);

  const totalDeliveredHeatW = conditionedZones.reduce((sum, zone) => {
    const deliveredHeat = typeof zone.delivered_heat === 'number'
      ? zone.delivered_heat
      : (typeof zone.heat_loss === 'number' ? zone.heat_loss : 0);
    return sum + deliveredHeat;
  }, 0);

  const totalHeatLossBaselineW = conditionedZones.reduce((sum, zone) => {
    const heatLoss = typeof zone.heat_loss_baseline === 'number' ? zone.heat_loss_baseline : 0;
    return sum + heatLoss;
  }, 0);

  const totalHeatSavingsW = conditionedZones.reduce((sum, zone) => {
    const savings = typeof zone.delivered_heat_savings === 'number'
      ? zone.delivered_heat_savings
      : (typeof zone.heat_savings === 'number' ? zone.heat_savings : 0);
    return sum + savings;
  }, 0);

  const totalFloorArea = conditionedZones.reduce((sum, zone) => {
    const area = typeof zone.floor_area === 'number' && zone.floor_area > 0 ? zone.floor_area : 0;
    return sum + area;
  }, 0);

  const annualHeatingDemand = Math.max(0, (totalDeliveredHeatW * 24 * 365) / 1000);
  const annualHeatingDemandBaseline = Math.max(0, (totalHeatLossBaselineW * 24 * 365) / 1000);
  const annualHeatingDemandSavings = Math.max(0, (totalHeatSavingsW * 24 * 365) / 1000);
  const epcIntensity = totalFloorArea > 0 ? annualHeatingDemand / totalFloorArea : null;
  const epcIntensityBaseline = totalFloorArea > 0 ? annualHeatingDemandBaseline / totalFloorArea : null;
  const epcLetter = getEpcBand(epcIntensity);
  const epcLetterBaseline = getEpcBand(epcIntensityBaseline);

  return {
    epcLetter,
    epcIntensity,
    annualHeatingDemand,
    epcLetterBaseline,
    epcIntensityBaseline,
    annualHeatingDemandBaseline,
    annualHeatingDemandSavings
  };
}

function createHouseStatsSection(demo) {
  const stats = computeWholeHouseStats(demo);
  const effectiveFlowTemp = (demo.meta && typeof demo.meta.effective_flow_temp === 'number') ? demo.meta.effective_flow_temp : null;
  const maxFlowTemp = (demo.meta && typeof demo.meta.max_flow_temp === 'number') ? demo.meta.max_flow_temp : null;
  const controlZoneName = demo.meta && demo.meta.control_zone_name ? demo.meta.control_zone_name : null;

  const section = document.createElement('div');
  section.className = 'house-stats';

  const heading = document.createElement('h5');
  heading.textContent = 'Overall House Stats';

  const epcLine = document.createElement('div');
  epcLine.className = 'house-stat-line';
  const epcValue = stats.epcIntensity === null ? 'n/a' : stats.epcIntensity.toFixed(0);
  const epcValueBaseline = stats.epcIntensityBaseline === null ? 'n/a' : stats.epcIntensityBaseline.toFixed(0);
  epcLine.textContent = `EPC: ${stats.epcLetter} (${epcValue})${stats.epcLetterBaseline && stats.epcLetterBaseline !== stats.epcLetter ? ` [baseline: ${stats.epcLetterBaseline}]` : ''}`;

  const annualLine = document.createElement('div');
  annualLine.className = 'house-stat-line';
  annualLine.textContent = `Annual heating demand (delivered): ${stats.annualHeatingDemand.toFixed(0)} kWh/yr`;

  const modulationLine = document.createElement('div');
  modulationLine.className = 'house-stat-line';
  if (effectiveFlowTemp !== null && maxFlowTemp !== null && controlZoneName) {
    modulationLine.textContent = `Boiler modulation: ${effectiveFlowTemp.toFixed(1)}°C (max ${maxFlowTemp.toFixed(1)}°C), controlled by ${controlZoneName}`;
  } else if (effectiveFlowTemp !== null && maxFlowTemp !== null) {
    modulationLine.textContent = `Boiler modulation: ${effectiveFlowTemp.toFixed(1)}°C (max ${maxFlowTemp.toFixed(1)}°C)`;
  } else {
    modulationLine.textContent = 'Boiler modulation: n/a';
  }

  const savingsLine = document.createElement('div');
  savingsLine.className = 'house-stat-line';
  savingsLine.style.color = stats.annualHeatingDemandSavings > 0 ? '#00aa00' : '#999';
  savingsLine.textContent = `TRV savings: ${stats.annualHeatingDemandSavings.toFixed(0)} kWh/yr`;

  const epcScale = document.createElement('div');
  epcScale.className = 'house-epc-scale';
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(letter => {
    const chip = document.createElement('span');
    chip.className = `epc-chip epc-${letter}${letter === stats.epcLetter ? ' active' : ''}`;
    chip.textContent = letter;
    epcScale.appendChild(chip);
  });

  section.appendChild(heading);
  section.appendChild(epcLine);
  section.appendChild(epcScale);
  section.appendChild(annualLine);
  section.appendChild(modulationLine);
  if (stats.annualHeatingDemandSavings > 0) section.appendChild(savingsLine);
  return section;
}

function createEpcScale(zone) {
  const epc = computeEpcEstimate(zone);

  const wrap = document.createElement('div');
  wrap.className = 'zone-epc';

  const summary = document.createElement('div');
  summary.className = 'zone-epc-summary';
  const valueText = epc.intensityKwhM2Yr === null ? 'n/a' : `${epc.intensityKwhM2Yr.toFixed(0)}`;
  summary.textContent = `EPC ${epc.letter} (${valueText})`;

  const scale = document.createElement('div');
  scale.className = 'zone-epc-scale';
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(letter => {
    const chip = document.createElement('span');
    chip.className = `epc-chip epc-${letter}${letter === epc.letter ? ' active' : ''}`;
    chip.textContent = letter;
    scale.appendChild(chip);
  });

  wrap.appendChild(summary);
  wrap.appendChild(scale);
  return wrap;
}

export function renderThermalViz(demo, radiators) {
  const container = document.getElementById('thermal-container');
  if (!container) return;
  
  const zones = demo.zones || [];
  const externalTemp = (demo.meta && typeof demo.meta.externalTemp === 'number') ? demo.meta.externalTemp : 3;
  const levels = {};
  
  // Group zones by level, excluding boundary zones
  for (const zone of zones) {
    if (zone.type === 'boundary') continue;
    const level = typeof zone.level === 'number' ? zone.level : 0;
    if (!levels[level]) levels[level] = [];
    levels[level].push(zone);
  }
  
  const table = document.createElement('table');
  table.className = 'thermal-table';
  
  // Sort levels in descending order so ground floor (0) is at bottom
  const sortedLevels = Object.keys(levels).map(Number).sort((a, b) => b - a);
  
  // Add header
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  const th = document.createElement('th');
  th.textContent = 'Floor';
  headerRow.appendChild(th);
  
  // Find max zones per floor to determine col span
  const maxZones = Math.max(...sortedLevels.map(l => levels[l].length), 1);
  for (let i = 1; i <= maxZones; i++) {
    const th2 = document.createElement('th');
    th2.textContent = '';
    headerRow.appendChild(th2);
  }
  
  // Add rows for each floor
  const tbody = table.createTBody();
  for (const level of sortedLevels) {
    const row = tbody.insertRow();
    
    const levelCell = row.insertCell();
    levelCell.textContent = `${level}`;
    levelCell.classList.add('level-cell');
    
    for (const zone of levels[level]) {
      const cell = row.insertCell();
      const colorClass = getThermalColorClass(zone);
      
      const zoneDiv = document.createElement('div');
      zoneDiv.className = `thermal-zone-cell ${colorClass}`;
      if (!zone.can_reach_setpoint) {
        zoneDiv.classList.add('zone-undersized');
      }
      zoneDiv.setAttribute('data-zone-id', zone.id);
      zoneDiv.style.cursor = 'pointer';
      zoneDiv.title = 'Click to edit this room';
      
      const zoneName = document.createElement('div');
      zoneName.className = 'zone-name';
      zoneName.textContent = zone.name || zone.id || 'Unknown';
      if (zone.is_boiler_control) {
        zoneName.textContent += ' 🔥';
        zoneName.title = 'Boiler control zone';
      }
      zoneDiv.appendChild(zoneName);

      if (zone.is_unheated === true) {
        const unheatedDiv = document.createElement('div');
        unheatedDiv.className = 'zone-unheated-label';
        unheatedDiv.style.fontSize = '0.9em';
        unheatedDiv.style.color = '#7a8b9d';
        unheatedDiv.textContent = 'Unheated zone';
        zoneDiv.appendChild(unheatedDiv);
      }

      const tempText = formatZoneTemperatureText(zone, externalTemp);
      if (tempText !== null) {
        const temperatureDiv = document.createElement('div');
        temperatureDiv.className = 'zone-temperature';
        temperatureDiv.style.fontSize = '0.9em';
        temperatureDiv.style.color = '#fff';
        temperatureDiv.textContent = tempText;
        zoneDiv.appendChild(temperatureDiv);
      }

      const capacity = getZoneCapacitySummary(zone, externalTemp);
      if (capacity) {
        const capacityDiv = document.createElement('div');
        capacityDiv.className = 'zone-capacity';
        capacityDiv.style.fontSize = '0.86em';
        capacityDiv.style.color = '#fff';
        capacityDiv.textContent = capacity.text;
        capacityDiv.title = capacity.title;
        zoneDiv.appendChild(capacityDiv);
      }

      const savingsText = getZoneSavingsText(zone);
      if (savingsText) {
        const savingsDiv = document.createElement('div');
        savingsDiv.className = 'zone-savings';
        savingsDiv.style.fontSize = '0.9em';
        savingsDiv.style.color = '#00aa00';
        savingsDiv.textContent = savingsText;
        zoneDiv.appendChild(savingsDiv);
      }

      if (zone.is_unheated !== true) {
        zoneDiv.appendChild(createEpcScale(zone));
      }
      
      cell.appendChild(zoneDiv);
    }
  }
  
  // Clear and add metadata + table
  container.innerHTML = '';
  
  // Add house metadata if available
  if (demo.meta && demo.meta.name) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'house-metadata';
    metaDiv.textContent = demo.meta.name;
    container.appendChild(metaDiv);
  }

  container.appendChild(createHouseStatsSection(demo));
  
  container.appendChild(table);
}
