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
  if (e.target.classList.contains('thermal-zone-cell')) {
    const zoneId = e.target.getAttribute('data-zone-id');
    if (zoneId) {
      selectZone(zoneId);
    }
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
  const zone = currentDemo.zones.find(z => z.id === zoneId);
  if (!zone) return;
  
  const elementsList = document.getElementById('elementsList');
  const radiatorsList = document.getElementById('radiatorsList');
  
  // Clear existing
  elementsList.innerHTML = '';
  radiatorsList.innerHTML = '';
  
  // Populate elements
  if (zone.elements) {
    zone.elements.forEach((elementId, index) => {
      const element = currentDemo.elements.find(e => e.id === elementId);
      if (element) {
        const item = document.createElement('div');
        item.className = 'element-item';
        item.innerHTML = `
          <span>${element.type || 'Unknown'} - ${element.id}</span>
          <button onclick="editElement('${element.id}')">Edit</button>
        `;
        elementsList.appendChild(item);
      }
    });
  }
  
  // Populate radiators
  if (zone.radiators) {
    zone.radiators.forEach((radSpec, index) => {
      const radiator = currentRadiators.radiators.find(r => r.id === radSpec.radiator_id);
      const item = document.createElement('div');
      item.className = 'radiator-item';
      item.innerHTML = `
        <span>${radiator ? radiator.name : radSpec.radiator_id} (${radSpec.surface_area}m²)</span>
        <button onclick="editRadiator(${index}, '${zoneId}')">Edit</button>
      `;
      radiatorsList.appendChild(item);
    });
  }
}

// Global functions for button clicks (since onclick attributes)
window.editElement = function(elementId) {
  // TODO: Implement element editing modal/form
  alert(`Edit element: ${elementId}`);
};

window.editRadiator = function(index, zoneId) {
  // TODO: Implement radiator editing modal/form
  alert(`Edit radiator ${index} in zone ${zoneId}`);
};

// Add element button
document.getElementById('addElementBtn').addEventListener('click', () => {
  if (selectedZoneId) {
    // TODO: Implement add element modal/form
    alert(`Add element to zone: ${selectedZoneId}`);
  }
});

// Add radiator button
document.getElementById('addRadiatorBtn').addEventListener('click', () => {
  if (selectedZoneId) {
    // TODO: Implement add radiator modal/form
    alert(`Add radiator to zone: ${selectedZoneId}`);
  }
});

// Save changes button
document.getElementById('saveRoomChanges').addEventListener('click', () => {
  // TODO: Save changes to currentDemo and re-solve
  alert('Save changes (not implemented yet)');
});

// Add room button
document.getElementById('addRoomBtn').addEventListener('click', () => {
  // TODO: Implement add room modal/form
  alert('Add room (not implemented yet)');
});

// Add level button
document.getElementById('addLevelBtn').addEventListener('click', () => {
  // TODO: Implement add level modal/form
  alert('Add level (not implemented yet)');
});

// Load and initialize on page load
window.addEventListener('load', async () => {
  outEl.textContent = 'Initializing...';
  try {
    const [ins, demo, rads] = await loadDefaultInputs();
    console.log('Loaded data:', { ins: !!ins, demo: !!demo, rads: !!rads });
    currentMaterials = ins;
    currentRadiators = rads;
    currentDemo = demo;
    triggerSolve();
  } catch (error) {
    outEl.textContent = 'Initialization error: ' + String(error);
    console.error('Initialization failed:', error);
  }
});
