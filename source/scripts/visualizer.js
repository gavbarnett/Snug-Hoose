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

function getRadiatorInfo(zone, radiators) {
  if (!zone || !Array.isArray(zone.radiators) || zone.radiators.length === 0) return 'No radiator';
  const rads = zone.radiators.map(spec => {
    const rad = radiators.find(r => r.id === spec.radiator_id);
    const name = rad ? rad.name : spec.radiator_id;
    return `${name} (${spec.surface_area}m²)`;
  });
  return rads.join(', ');
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
    levelCell.textContent = `Level ${level}`;
    levelCell.style.fontWeight = 'bold';
    levelCell.style.backgroundColor = '#e8e8e8';
    
    for (const zone of levels[level]) {
      const cell = row.insertCell();
      const balance = typeof zone.heating_balance === 'number' ? zone.heating_balance : 0;
      const colorClass = getThermalColorClass(balance);
      
      const zoneDiv = document.createElement('div');
      zoneDiv.className = `thermal-zone-cell ${colorClass}`;
      
      const zoneName = document.createElement('div');
      zoneName.className = 'zone-name';
      zoneName.textContent = zone.id || 'Unknown';
      zoneDiv.appendChild(zoneName);
      
      const balanceDiv = document.createElement('div');
      balanceDiv.className = 'zone-balance';
      balanceDiv.textContent = `Balance: ${balance > 0 ? '+' : ''}${balance}W`;
      zoneDiv.appendChild(balanceDiv);
      
      const radDiv = document.createElement('div');
      radDiv.className = 'zone-radiator';
      radDiv.textContent = getRadiatorInfo(zone, radiators);
      zoneDiv.appendChild(radDiv);
      
      cell.appendChild(zoneDiv);
    }
  }
  
  // Clear and add table
  container.innerHTML = '';
  container.appendChild(table);
}
