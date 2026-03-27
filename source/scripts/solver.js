// Client-side solver orchestrator (ES module). Imports modular calculators and manages UI.

import { computeElementU } from './u_value_calculator.js';
import { computeRoomHeatRequirements } from './heat_calculator.js';
import { renderThermalViz } from './visualizer.js';

const outEl = document.getElementById('out');
const dlEl = document.getElementById('download');
const indoorInput = document.getElementById('indoorTemp');
const externalInput = document.getElementById('externalTemp');
const flowTempInput = document.getElementById('flowTemp');
const fileUpload = document.getElementById('fileUpload');
const uploadBtn = document.getElementById('uploadBtn');
const toggleSidebar = document.getElementById('toggleSidebar');
const contentLayout = document.querySelector('.content-layout');

let currentMaterials = null;
let currentRadiators = null;
let currentDemo = null;

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
  
  return [ins, demo, rads];
}

async function solveAndRender(demoRaw) {
  try {
    if (!currentMaterials) {
      throw new Error('Materials data not loaded. Please check that insulation.json is available.');
    }
    const materials = currentMaterials.materials || currentMaterials;
    const radiators = currentRadiators ? (currentRadiators.radiators || []) : [];
    const elements = demoRaw.elements || demoRaw.rooms || [];
    if (!Array.isArray(elements)) throw new Error('No elements array found in demo json');

    // Calculate U-values for all elements
    for (const el of elements) {
      try { computeElementU(el, materials); } catch (err) { el._calc_error = String(err); }
    }

    // Get input values and calculate room heat requirements
    const indoorTemp = parseFloat(indoorInput.value) || 21;
    const externalTemp = parseFloat(externalInput.value) || 3;
    const flowTemp = parseFloat(flowTempInput.value) || 55;

    const heatResults = computeRoomHeatRequirements(demoRaw, radiators, { indoorTemp, externalTemp, flowTemp });

    // Annotate demo JSON with results
    demoRaw.meta = demoRaw.meta || {};
    demoRaw.meta.indoorTemp = indoorTemp;
    demoRaw.meta.externalTemp = externalTemp;
    demoRaw.meta.flowTemp = flowTemp;
    demoRaw.meta.total_heat_loss = heatResults.total_heat_loss;
    demoRaw.meta.total_radiator_output = heatResults.total_radiator_output;
    demoRaw.meta.total_balance = heatResults.total_balance;

    // Merge room heat results into zones
    for (const zone of demoRaw.zones) {
      const room = heatResults.rooms.find(r => r.zoneId === zone.id);
      if (room) {
        zone.total_conductance = room.total_conductance;
        zone.heat_loss = room.heat_loss;
        zone.heat_loss_per_unit_area = room.heat_loss_per_unit_area;
        zone.radiator_surface_area = room.radiator_surface_area;
        zone.radiator_output = room.radiator_output;
        zone.heating_balance = room.heating_balance;
        zone.balance_status = room.balance_status;
        zone.contributing_elements = room.contributing_elements;
      }
    }

    // Generate thermal visualization
    renderThermalViz(demoRaw, radiators);

    // Output results
    const solved = JSON.stringify(demoRaw, null, 2);
    outEl.textContent = solved;

    // Enable download
    const blob = new Blob([solved], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    dlEl.href = url;
    dlEl.style.pointerEvents = 'auto';
    dlEl.style.opacity = '1';
    dlEl.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (err) {
    outEl.textContent = 'Solver error: ' + String(err);
    console.error(err);
  }
}

function triggerSolve() {
  if (currentDemo) {
    solveAndRender(JSON.parse(JSON.stringify(currentDemo)));
  }
}

// Upload button opens file picker
uploadBtn.addEventListener('click', () => {
  fileUpload.click();
});

// File upload handler
fileUpload.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const uploadedDemo = JSON.parse(text);
    currentDemo = uploadedDemo;
    outEl.textContent = 'Processing uploaded file...';
    triggerSolve();
  } catch (err) {
    outEl.textContent = 'Error parsing JSON file: ' + String(err);
    console.error(err);
  }
});

// Sidebar toggle handler
toggleSidebar.addEventListener('click', () => {
  contentLayout.classList.toggle('sidebar-hidden');
  toggleSidebar.setAttribute('title', 
    contentLayout.classList.contains('sidebar-hidden') ? 'Show panel' : 'Hide panel'
  );
});

// Temperature inputs trigger recalculation
indoorInput.addEventListener('change', triggerSolve);
externalInput.addEventListener('change', triggerSolve);
flowTempInput.addEventListener('change', triggerSolve);

// Tab switching for editor panels
const jsonTab = document.getElementById('jsonTab');
const editorTab = document.getElementById('editorTab');
const jsonPanel = document.getElementById('jsonPanel');
const roomEditorPanel = document.getElementById('roomEditorPanel');

jsonTab.addEventListener('click', () => {
  jsonTab.classList.add('active');
  editorTab.classList.remove('active');
  jsonPanel.classList.add('active');
  roomEditorPanel.classList.remove('active');
});

editorTab.addEventListener('click', () => {
  editorTab.classList.add('active');
  jsonTab.classList.remove('active');
  roomEditorPanel.classList.add('active');
  jsonPanel.classList.remove('active');
});

// Zone selection from visualizer
let selectedZoneId = null;

document.addEventListener('click', (e) => {
  const zoneCell = e.target.closest('.thermal-zone-cell');
  if (!zoneCell) return;
  const zoneId = zoneCell.getAttribute('data-zone-id');
  if (zoneId) {
    selectZone(zoneId);
  }
});

function selectZone(zoneId) {
  selectedZoneId = zoneId;
  
  // Remove selected class from all zones
  document.querySelectorAll('.thermal-zone-cell').forEach(cell => {
    cell.classList.remove('selected');
  });
  
  // Add selected class to clicked zone
  const selectedCell = document.querySelector(`.thermal-zone-cell[data-zone-id="${zoneId}"]`);
  if (selectedCell) {
    selectedCell.classList.add('selected');
  }
  
  const selectedRoomName = document.getElementById('selectedRoomName');
  selectedRoomName.textContent = `Selected Room: ${zoneId}`;
  
  const roomSelector = document.getElementById('roomSelector');
  const roomEditor = document.getElementById('roomEditor');
  roomSelector.style.display = 'none';
  roomEditor.style.display = 'block';
  
  // Populate editor with zone data
  populateRoomEditor(zoneId);
}

function populateRoomEditor(zoneId) {
  const zoneKey = String(zoneId || '').trim();
  const zone = (currentDemo.zones || []).find(z => String(z.id || '').trim() === zoneKey);
  if (!zone) return;
  
  const radiatorsList = document.getElementById('radiatorsList');
  
  // Clear existing
  radiatorsList.innerHTML = '';
  
  // Populate radiators
  if (zone.radiators) {
    zone.radiators.forEach((radSpec, index) => {
      const radiator = currentRadiators.radiators.find(r => r.id === radSpec.radiator_id);
      const item = document.createElement('div');
      item.className = 'radiator-item';
      
      // Create form elements
      const typeSelect = document.createElement('select');
      currentRadiators.radiators.forEach(rad => {
        const option = document.createElement('option');
        option.value = rad.id;
        option.textContent = rad.name;
        if (rad.id === radSpec.radiator_id) option.selected = true;
        typeSelect.appendChild(option);
      });
      
      const widthSelect = document.createElement('select');
      const widthInput = document.createElement('input');
      widthInput.type = 'number';
      widthInput.placeholder = 'Width (mm)';
      widthInput.value = radSpec.width || '';
      widthInput.step = '10';
      widthInput.min = '200';
      widthInput.max = '3000';
      
      // Standard widths
      const standardWidths = [400, 500, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000];
      const widthOption = document.createElement('option');
      widthOption.value = '';
      widthOption.textContent = 'Custom width...';
      widthSelect.appendChild(widthOption);
      standardWidths.forEach(w => {
        const option = document.createElement('option');
        option.value = w;
        option.textContent = `${w}mm`;
        if (radSpec.width == w) option.selected = true;
        widthSelect.appendChild(option);
      });
      
      const heightSelect = document.createElement('select');
      const heightInput = document.createElement('input');
      heightInput.type = 'number';
      heightInput.placeholder = 'Height (mm)';
      heightInput.value = radSpec.height || '';
      heightInput.step = '10';
      heightInput.min = '200';
      heightInput.max = '2000';
      
      // Standard heights
      const standardHeights = [300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];
      const heightOption = document.createElement('option');
      heightOption.value = '';
      heightOption.textContent = 'Custom height...';
      heightSelect.appendChild(heightOption);
      standardHeights.forEach(h => {
        const option = document.createElement('option');
        option.value = h;
        option.textContent = `${h}mm`;
        if (radSpec.height == h) option.selected = true;
        heightSelect.appendChild(option);
      });
      
      const areaDisplay = document.createElement('span');
      areaDisplay.className = 'area-display';
      areaDisplay.textContent = `Area: ${radSpec.surface_area}m²`;
      
      // Update area when dimensions change
      const updateArea = () => {
        const width = parseFloat(widthInput.value || widthSelect.value) / 1000; // convert mm to m
        const height = parseFloat(heightInput.value || heightSelect.value) / 1000;
        if (width > 0 && height > 0) {
          const area = (width * height).toFixed(2);
          areaDisplay.textContent = `Area: ${area}m²`;
          radSpec.surface_area = parseFloat(area);
          radSpec.width = parseInt(widthInput.value || widthSelect.value);
          radSpec.height = parseInt(heightInput.value || heightSelect.value);
          triggerSolve(); // Auto-update on dimension change
        }
      };
      
      widthInput.addEventListener('input', updateArea);
      heightInput.addEventListener('input', updateArea);
      widthSelect.addEventListener('change', () => {
        if (widthSelect.value) {
          widthInput.value = widthSelect.value;
          updateArea();
        }
      });
      heightSelect.addEventListener('change', () => {
        if (heightSelect.value) {
          heightInput.value = heightSelect.value;
          updateArea();
        }
      });
      typeSelect.addEventListener('change', () => {
        radSpec.radiator_id = typeSelect.value;
        triggerSolve(); // Auto-update on type change
      });
      
      // Layout the form
      const formDiv = document.createElement('div');
      formDiv.style.display = 'flex';
      formDiv.style.flexDirection = 'column';
      formDiv.style.gap = '0.5rem';
      
      const headerDiv = document.createElement('div');
      headerDiv.style.display = 'flex';
      headerDiv.style.justifyContent = 'space-between';
      headerDiv.style.alignItems = 'center';
      
      const typeRow = document.createElement('div');
      typeRow.textContent = 'Type: ';
      typeRow.appendChild(typeSelect);
      
      const removeBtn = document.createElement('button');
      removeBtn.innerHTML = '🗑️';
      removeBtn.title = 'Remove radiator';
      removeBtn.className = 'remove-btn';
      removeBtn.addEventListener('click', () => {
        removeRadiator(selectedZoneId, index);
      });
      
      headerDiv.appendChild(typeRow);
      headerDiv.appendChild(removeBtn);
      
      const sizeRow = document.createElement('div');
      sizeRow.style.display = 'flex';
      sizeRow.style.gap = '0.5rem';
      sizeRow.style.alignItems = 'center';
      sizeRow.style.flexWrap = 'wrap';
      
      const widthGroup = document.createElement('div');
      widthGroup.style.display = 'flex';
      widthGroup.style.alignItems = 'center';
      widthGroup.style.gap = '0.25rem';
      widthGroup.appendChild(document.createTextNode('W:'));
      widthGroup.appendChild(widthSelect);
      widthGroup.appendChild(widthInput);
      
      const heightGroup = document.createElement('div');
      heightGroup.style.display = 'flex';
      heightGroup.style.alignItems = 'center';
      heightGroup.style.gap = '0.25rem';
      heightGroup.appendChild(document.createTextNode('H:'));
      heightGroup.appendChild(heightSelect);
      heightGroup.appendChild(heightInput);
      
      sizeRow.appendChild(widthGroup);
      sizeRow.appendChild(heightGroup);
      sizeRow.appendChild(areaDisplay);
      
      formDiv.appendChild(headerDiv);
      formDiv.appendChild(sizeRow);
      
      item.appendChild(formDiv);
      radiatorsList.appendChild(item);
    });
  }
  
  // Populate fabric elements grouped by type (wall, floor, roof, etc.)
  const fabricList = document.getElementById('fabricList');
  if (!fabricList) {
    console.warn('fabricList container not found in DOM');
    return;
  }
  fabricList.innerHTML = '';
  const allElements = Array.isArray(currentDemo.elements) ? currentDemo.elements : [];
  const connectedElements = allElements.filter(e => {
    return Array.isArray(e.nodes) && e.nodes.some(node => String(node || '').trim() === zoneKey);
  });

  if (allElements.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wall-empty';
    empty.textContent = 'No elements array found in loaded data.';
    fabricList.appendChild(empty);
    return;
  }

  if (connectedElements.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wall-empty';
    empty.textContent = 'No fabric elements connected to this room.';
    fabricList.appendChild(empty);
  }

  const groupedByType = new Map();
  connectedElements.forEach(elem => {
    const type = String(elem.type || 'unknown').toLowerCase();
    if (!groupedByType.has(type)) groupedByType.set(type, []);
    groupedByType.get(type).push(elem);
  });

  const sortedTypes = Array.from(groupedByType.keys()).sort();

  sortedTypes.forEach(type => {
    const typeSection = document.createElement('details');
    typeSection.className = 'wall-subsection';
    typeSection.open = type === 'wall';
    const typeSummary = document.createElement('summary');
    typeSummary.textContent = `${type} (${groupedByType.get(type).length})`;
    typeSection.appendChild(typeSummary);

    groupedByType.get(type).forEach(element => {
      const elementName = element.name || element.id || 'Unnamed element';
      const area = typeof element.area === 'number' ? element.area : null;
      const width = typeof element.width === 'number' ? element.width : null;
      const height = typeof element.height === 'number' ? element.height : null;

      let widthText = width !== null ? `${width} m` : 'Unknown';
      let heightText = height !== null ? `${height} m` : 'Unknown';

      if (width === null && height !== null && area !== null && height > 0) {
        widthText = `${(area / height).toFixed(2)} m (derived from area/height)`;
      }
      if (height === null && width !== null && area !== null && width > 0) {
        heightText = `${(area / width).toFixed(2)} m (derived from area/width)`;
      }

      const otherNodes = (Array.isArray(element.nodes) ? element.nodes : []).filter(node => String(node || '').trim() !== zoneKey);
      const details = document.createElement('details');
      details.className = 'wall-card';

      const summary = document.createElement('summary');
      summary.textContent = `${elementName}${element.orientation ? ` (${element.orientation})` : ''}`;
      details.appendChild(summary);

      const meta = document.createElement('div');
      meta.className = 'wall-meta';
      meta.innerHTML = `
        <p><strong>Name:</strong> ${elementName}</p>
        <p><strong>Height:</strong> ${heightText}</p>
        <p><strong>Width:</strong> ${widthText}</p>
        <p><strong>Area:</strong> ${area !== null ? `${area} m²` : 'Unknown'}</p>
        <p><strong>Other connected rooms/nodes:</strong> ${otherNodes.length ? otherNodes.join(', ') : 'None'}</p>
      `;
      details.appendChild(meta);

      const buildUpSection = document.createElement('details');
      buildUpSection.className = 'wall-subsection';
      const buildUpSummary = document.createElement('summary');
      buildUpSummary.textContent = 'Build-up';
      buildUpSection.appendChild(buildUpSummary);

      const buildUpList = document.createElement('ul');
      const buildUp = Array.isArray(element.build_up) ? element.build_up : [];
      if (buildUp.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No build-up data';
        buildUpList.appendChild(li);
      } else {
        buildUp.forEach((layer, i) => {
          const li = document.createElement('li');
          if (layer.type === 'composite' && Array.isArray(layer.paths)) {
            const pathText = layer.paths
              .map(path => `${path.material_id || 'unknown'} (${typeof path.fraction === 'number' ? path.fraction : 'n/a'})`)
              .join(', ');
            li.textContent = `Layer ${i + 1}: composite, thickness=${layer.thickness ?? 'n/a'} m, paths=${pathText}`;
          } else {
            li.textContent = `Layer ${i + 1}: ${layer.material_id || layer.type || 'unknown'}, thickness=${layer.thickness ?? 'n/a'} m`;
          }
          buildUpList.appendChild(li);
        });
      }
      buildUpSection.appendChild(buildUpList);
      details.appendChild(buildUpSection);

      const windowsSection = document.createElement('details');
      windowsSection.className = 'wall-subsection';
      const windowsSummary = document.createElement('summary');
      windowsSummary.textContent = 'Windows';
      windowsSection.appendChild(windowsSummary);

      const windowsList = document.createElement('ul');
      const windows = Array.isArray(element.windows) ? element.windows : [];
      if (windows.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No windows';
        windowsList.appendChild(li);
      } else {
        windows.forEach((win, i) => {
          const li = document.createElement('li');
          li.textContent = `${win.id || `window_${i + 1}`}: area=${win.area ?? 'n/a'} m², glazing=${win.glazing_id || 'n/a'}`;
          windowsList.appendChild(li);
        });
      }
      windowsSection.appendChild(windowsList);
      details.appendChild(windowsSection);

      const doorsSection = document.createElement('details');
      doorsSection.className = 'wall-subsection';
      const doorsSummary = document.createElement('summary');
      doorsSummary.textContent = 'Doors';
      doorsSection.appendChild(doorsSummary);

      const doorsList = document.createElement('ul');
      const doors = Array.isArray(element.doors) ? element.doors : [];
      if (doors.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No doors';
        doorsList.appendChild(li);
      } else {
        doors.forEach((door, i) => {
          const li = document.createElement('li');
          li.textContent = `${door.id || `door_${i + 1}`}: area=${door.area ?? 'n/a'} m², type=${door.type || 'n/a'}, material=${door.material_id || 'n/a'}`;
          doorsList.appendChild(li);
        });
      }
      doorsSection.appendChild(doorsList);
      details.appendChild(doorsSection);

      typeSection.appendChild(details);
    });

    fabricList.appendChild(typeSection);
  });
}

function removeRadiator(zoneId, radiatorIndex) {
  const zone = currentDemo.zones.find(z => z.id === zoneId);
  if (zone && zone.radiators && zone.radiators[radiatorIndex]) {
    zone.radiators.splice(radiatorIndex, 1);
    // Re-populate the editor
    populateRoomEditor(zoneId);
    // Trigger solve to update calculations
    triggerSolve();
  }
}

window.editRadiator = function(index, zoneId) {
  // TODO: Implement radiator editing modal/form
  alert(`Edit radiator ${index} in zone ${zoneId}`);
};

// Load and initialize on page load
window.addEventListener('load', async () => {
  outEl.textContent = 'Initializing...';
  try {
    const [ins, demo, rads] = await loadDefaultInputs();
    console.log('Loaded data:', { ins: !!ins, demo: !!demo, rads: !!rads });
    currentMaterials = ins;
    currentRadiators = rads;
    currentDemo = demo;
    
    // Add event listeners after DOM is loaded
    // Add radiator button
    document.getElementById('addRadiatorBtn').addEventListener('click', () => {
      if (selectedZoneId) {
        const zone = currentDemo.zones.find(z => z.id === selectedZoneId);
        if (zone) {
          if (!zone.radiators) zone.radiators = [];
          // Add a default radiator
          zone.radiators.push({
            radiator_id: "type_11",
            surface_area: 1.0,
            width: 800,
            height: 500
          });
          // Re-populate the editor
          populateRoomEditor(selectedZoneId);
          // Trigger solve to update calculations
          triggerSolve();
        }
      }
    });

    // Add room button
    document.getElementById('addRoomBtn').addEventListener('click', () => {
      // TODO: Implement add room modal/form
      alert('Add room (not implemented yet)');
    });
    
    triggerSolve();
  } catch (error) {
    outEl.textContent = 'Initialization error: ' + String(error);
    console.error('Initialization failed:', error);
  }
});
