// Thermal visualizer: generates thermal color-coded table display for heating balance

function getThermalColorClass(balance) {
  // balance can be negative (cold) or positive (hot)
  // Map to thermal colors: -500+ = blue, ..., 0 = neutral (yellow), ..., +500+ = red
  if (balance <= -500) return 'thermal-extreme-cold';
  if (balance <= -200) return 'thermal-cold';
  if (balance <= -50) return 'thermal-cool';
  if (balance <= 50) return 'thermal-neutral';
  if (balance <= 200) return 'thermal-warm';
  if (balance <= 500) return 'thermal-hot';
  return 'thermal-extreme-hot';
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

function computeEpcEstimate(zone) {
  const heatLossPerM2 = typeof zone.heat_loss_per_unit_area === 'number' ? zone.heat_loss_per_unit_area : null;
  if (heatLossPerM2 === null) {
    return { letter: 'N/A', intensityKwhM2Yr: null };
  }

  // Approximate annualized demand intensity from steady-state heat loss per m2
  const intensityKwhM2Yr = Math.max(0, (heatLossPerM2 * 24 * 365) / 1000);
  return { letter: getEpcBand(intensityKwhM2Yr), intensityKwhM2Yr };
}

function computeWholeHouseStats(demo) {
  const zones = Array.isArray(demo.zones) ? demo.zones : [];
  const conditionedZones = zones.filter(zone => zone.type !== 'boundary');

  const totalHeatLossW = conditionedZones.reduce((sum, zone) => {
    const heatLoss = typeof zone.heat_loss === 'number' ? zone.heat_loss : 0;
    return sum + heatLoss;
  }, 0);

  const totalFloorArea = conditionedZones.reduce((sum, zone) => {
    const area = typeof zone.floor_area === 'number' && zone.floor_area > 0 ? zone.floor_area : 0;
    return sum + area;
  }, 0);

  const annualHeatingDemand = Math.max(0, (totalHeatLossW * 24 * 365) / 1000);
  const epcIntensity = totalFloorArea > 0 ? annualHeatingDemand / totalFloorArea : null;
  const epcLetter = getEpcBand(epcIntensity);

  return {
    epcLetter,
    epcIntensity,
    annualHeatingDemand
  };
}

function createHouseStatsSection(demo) {
  const stats = computeWholeHouseStats(demo);

  const section = document.createElement('div');
  section.className = 'house-stats';

  const heading = document.createElement('h5');
  heading.textContent = 'Overall House Stats';

  const epcLine = document.createElement('div');
  epcLine.className = 'house-stat-line';
  const epcValue = stats.epcIntensity === null ? 'n/a' : stats.epcIntensity.toFixed(0);
  epcLine.textContent = `EPC: ${stats.epcLetter} (${epcValue})`;

  const annualLine = document.createElement('div');
  annualLine.className = 'house-stat-line';
  annualLine.textContent = `Annual heating demand: ${stats.annualHeatingDemand.toFixed(0)} kWh/yr`;

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
      const balance = typeof zone.heating_balance === 'number' ? zone.heating_balance : 0;
      const colorClass = getThermalColorClass(balance);
      
      const zoneDiv = document.createElement('div');
      zoneDiv.className = `thermal-zone-cell ${colorClass}`;
      zoneDiv.setAttribute('data-zone-id', zone.id);
      zoneDiv.style.cursor = 'pointer';
      zoneDiv.title = 'Click to edit this room';
      
      const zoneName = document.createElement('div');
      zoneName.className = 'zone-name';
      zoneName.textContent = zone.name || zone.id || 'Unknown';
      zoneDiv.appendChild(zoneName);
      
      const balanceDiv = document.createElement('div');
      balanceDiv.className = 'zone-balance';
      balanceDiv.textContent = `Balance: ${balance > 0 ? '+' : ''}${balance}W`;
      zoneDiv.appendChild(balanceDiv);

      zoneDiv.appendChild(createEpcScale(zone));
      
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
