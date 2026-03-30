// Room editor UI module: tabs, room selection, radiator editing, and fabric rendering.

function getAttachmentBoundaryRole(type) {
  const normalizedType = String(type || '').trim().toLowerCase();
  if (normalizedType === 'wall' || normalizedType === 'roof') return 'outside';
  if (normalizedType === 'floor') return 'ground';
  if (normalizedType === 'ceiling' || normalizedType === 'floor_ceiling') return 'loft';
  return null;
}

export function normalizeElementNodesForAttachment(demo, element, zoneId) {
  const uniqueNodes = [...new Set(Array.isArray(element?.nodes) ? element.nodes.filter(Boolean) : [])];
  if (!zoneId) return uniqueNodes;
  if (uniqueNodes.includes(zoneId)) return uniqueNodes;

  const boundaryRole = getAttachmentBoundaryRole(element?.type);
  if (!boundaryRole || !demo || !Array.isArray(demo.zones)) {
    return [...uniqueNodes, zoneId];
  }

  const boundaryZoneIds = new Set(
    demo.zones
      .filter(zone => zone?.type === 'boundary')
      .map(zone => zone.id)
  );
  const boundaryNameById = new Map(
    demo.zones
      .filter(zone => zone?.type === 'boundary' && zone?.id)
      .map(zone => [zone.id, String(zone.name || '').trim().toLowerCase()])
  );

  const matchingBoundaryNodes = uniqueNodes.filter(nodeId => {
    if (!boundaryZoneIds.has(nodeId) && String(nodeId).trim().toLowerCase() !== boundaryRole) {
      return false;
    }
    const boundaryName = boundaryNameById.get(nodeId);
    return !boundaryName || boundaryName === boundaryRole || String(nodeId).trim().toLowerCase() === boundaryRole;
  });

  if (matchingBoundaryNodes.length === 0) {
    return [...uniqueNodes, zoneId];
  }

  const nonMatchingBoundaryNodes = uniqueNodes.filter(nodeId => {
    return boundaryZoneIds.has(nodeId) && !matchingBoundaryNodes.includes(nodeId);
  });
  const roomNodes = uniqueNodes.filter(nodeId => !boundaryZoneIds.has(nodeId));
  const normalizedRoomNodes = [...new Set([...roomNodes, zoneId])];

  return [...normalizedRoomNodes, ...nonMatchingBoundaryNodes];
}

export function initRoomEditor(opts) {
  const getDemo = opts.getDemo;
  const getRadiatorsData = opts.getRadiatorsData;
  const getMaterialsData = opts.getMaterialsData;
  const getOpeningsData = opts.getOpeningsData;
  const getVentilationData = opts.getVentilationData;
  const onDataChanged = opts.onDataChanged;
  const onAddRoom = opts.onAddRoom;

  const editorTab = document.getElementById('editorTab');
  const roomEditorPanel = document.getElementById('roomEditorPanel');
  const contentLayout = document.querySelector('.content-layout');
  const editorShell = document.querySelector('.content-right');

  const roomSelector = document.getElementById('roomSelector');
  const roomEditor = document.getElementById('roomEditor');
  const selectedRoomName = document.getElementById('selectedRoomName');
  const ventilationList = document.getElementById('ventilationList');
  const addBathroomExtractorBtn = document.getElementById('addBathroomExtractorBtn');
  const addKitchenExtractorBtn = document.getElementById('addKitchenExtractorBtn');
  const addHeatExchangerBtn = document.getElementById('addHeatExchangerBtn');
  const radiatorsList = document.getElementById('radiatorsList');
  const fabricList = document.getElementById('fabricList');
  const addRadiatorBtn = document.getElementById('addRadiatorBtn');
  const fabricTypeSelect = document.getElementById('fabricTypeSelect');
  const fabricTargetSelect = document.getElementById('fabricTargetSelect');
  const addFabricBtn = document.getElementById('addFabricBtn');
  const addRoomBtn = document.getElementById('addRoomBtn');

  let selectedZoneId = null;
  let pendingFocusState = null;
  let suppressOutsideHideUntil = 0;

  function configureDecimalInput(input, placeholder) {
    input.type = 'text';
    input.inputMode = 'decimal';
    if (placeholder) input.placeholder = placeholder;
  }

  function parseDecimalValue(raw) {
    const normalized = String(raw ?? '').trim().replace(',', '.');
    if (!normalized || normalized === '.' || normalized === '-' || normalized === '-.') return null;
    const value = Number(normalized);
    return isFinite(value) ? value : null;
  }

  function formatEditableDecimal(value, digits = 3) {
    if (!isFinite(value)) return '';
    return String(Number(value.toFixed(digits)));
  }

  function formatEditablePercent(fraction) {
    if (!isFinite(fraction)) return '0';
    return formatEditableDecimal(fraction * 100, 2);
  }

  function ensureEditorVisible() {
    suppressOutsideHideUntil = Date.now() + 150;

    if (contentLayout) {
      contentLayout.classList.remove('sidebar-hidden');
    }

    if (editorTab && roomEditorPanel) {
      editorTab.classList.add('active');
      roomEditorPanel.classList.add('active');
    }
  }

  function countOpeningsForZoneOnWall(wall, zoneId, kind) {
    const list = kind === 'door'
      ? (Array.isArray(wall?.doors) ? wall.doors : [])
      : (Array.isArray(wall?.windows) ? wall.windows : []);
    const ownerZoneId = Array.isArray(wall?.nodes) && wall.nodes.length > 0 ? wall.nodes[0] : null;
    return list.filter(opening => (opening?.zone_id || ownerZoneId) === zoneId).length;
  }

  function findPreferredRadiatorWallForZone(demo, zoneId, zoneRadiators) {
    const elements = Array.isArray(demo?.elements) ? demo.elements : [];
    const zones = Array.isArray(demo?.zones) ? demo.zones : [];
    const boundaryIds = new Set(zones.filter(zone => zone?.type === 'boundary').map(zone => zone.id));

    const radiatorCountByWallId = new Map();
    (Array.isArray(zoneRadiators) ? zoneRadiators : []).forEach(radiator => {
      const wallId = radiator?.wall_element_id;
      if (!wallId) return;
      radiatorCountByWallId.set(wallId, (radiatorCountByWallId.get(wallId) || 0) + 1);
    });

    const walls = elements.filter(element => {
      if (!element || String(element.type || '').toLowerCase() !== 'wall') return false;
      const nodes = Array.isArray(element.nodes) ? element.nodes : [];
      return nodes.includes(zoneId);
    });
    if (walls.length === 0) return null;

    const scored = walls.map(wall => {
      const windowsCount = countOpeningsForZoneOnWall(wall, zoneId, 'window');
      const doorsCount = countOpeningsForZoneOnWall(wall, zoneId, 'door');
      const radiatorCount = radiatorCountByWallId.get(wall.id) || 0;
      const hasWindow = windowsCount > 0;
      const hasDoor = doorsCount > 0;
      const isExternal = Array.isArray(wall.nodes) && wall.nodes.some(nodeId => boundaryIds.has(nodeId));
      return {
        wall,
        radiatorCount,
        hasWindow,
        hasDoor,
        openingOccupancy: windowsCount + doorsCount,
        isExternal
      };
    });

    scored.sort((a, b) => {
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

    return scored[0]?.wall || null;
  }

  function chooseRadiatorPositionRatioOnWall(wall, zoneId, zoneRadiators) {
    const ownerZoneId = Array.isArray(wall?.nodes) && wall.nodes.length > 0 ? wall.nodes[0] : null;
    const occupied = [];

    const collectOpeningRatios = (list) => {
      (Array.isArray(list) ? list : []).forEach(opening => {
        if ((opening?.zone_id || ownerZoneId) !== zoneId) return;
        const ratio = Number(opening?.position_ratio);
        if (Number.isFinite(ratio)) occupied.push(Math.max(0, Math.min(1, ratio)));
      });
    };

    collectOpeningRatios(wall?.doors);
    collectOpeningRatios(wall?.windows);

    (Array.isArray(zoneRadiators) ? zoneRadiators : []).forEach(radiator => {
      if (String(radiator?.wall_element_id || '') !== String(wall?.id || '')) return;
      const ratio = Number(radiator?.position_ratio);
      if (Number.isFinite(ratio)) occupied.push(Math.max(0, Math.min(1, ratio)));
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

  if (editorTab && roomEditorPanel) {
    editorTab.addEventListener('click', () => {
      editorTab.classList.add('active');
      roomEditorPanel.classList.add('active');
    });
  }

  document.addEventListener('click', (e) => {
    if (!contentLayout || !editorShell) return;
    if (Date.now() < suppressOutsideHideUntil) return;

    const clickedInsideEditor = !!e.target.closest('.content-right');
    if (clickedInsideEditor) return;

    if (!contentLayout.classList.contains('sidebar-hidden')) {
      contentLayout.classList.add('sidebar-hidden');
    }
  });

  if (addRadiatorBtn) {
    addRadiatorBtn.addEventListener('click', () => {
      if (!selectedZoneId) return;
      const demo = getDemo();
      if (!demo || !Array.isArray(demo.zones)) return;

      const zone = demo.zones.find(z => z.id === selectedZoneId);
      if (!zone) return;
      if (!zone.radiators) zone.radiators = [];
      const wall = findPreferredRadiatorWallForZone(demo, selectedZoneId, zone.radiators);
      const positionRatio = wall
        ? chooseRadiatorPositionRatioOnWall(wall, selectedZoneId, zone.radiators)
        : 0.5;

      zone.radiators.push({
        id: generateUniqueId(),
        radiator_id: 'type_11',
        surface_area: 1.0,
        width: 800,
        height: 500,
        wall_element_id: wall?.id || null,
        position_ratio: positionRatio,
        trv_enabled: true
      });

      populateRoomEditor(selectedZoneId);
      onDataChanged();
    });
  }

  if (addBathroomExtractorBtn) {
    addBathroomExtractorBtn.addEventListener('click', () => {
      addVentilationElementFromPreset('extractor_bathroom');
    });
  }

  if (addKitchenExtractorBtn) {
    addKitchenExtractorBtn.addEventListener('click', () => {
      addVentilationElementFromPreset('extractor_oven_hood');
    });
  }

  if (addHeatExchangerBtn) {
    addHeatExchangerBtn.addEventListener('click', () => {
      addVentilationElementFromPreset('heat_exchanger_mvhr');
    });
  }

  if (addRoomBtn) {
    addRoomBtn.addEventListener('click', () => {
      createRoom();
    });
  }

  if (fabricTypeSelect) {
    fabricTypeSelect.addEventListener('change', () => {
      refreshFabricTargetOptions();
    });
  }

  if (addFabricBtn) {
    addFabricBtn.addEventListener('click', () => {
      if (!selectedZoneId) return;
      const fabricType = fabricTypeSelect ? fabricTypeSelect.value : 'wall';
      const fabricTarget = fabricTargetSelect ? fabricTargetSelect.value : '__new__';
      if (fabricTarget === '__new__') {
        createNewFabric(selectedZoneId, fabricType);
      } else {
        attachExistingFabric(selectedZoneId, fabricTarget);
      }
    });
  }

  function selectZone(zoneId) {
    selectedZoneId = zoneId;
    syncSelectedZoneVisualState();

    if (selectedRoomName) selectedRoomName.textContent = `Selected Room: ${zoneId}`;
    if (roomSelector) roomSelector.style.display = 'none';
    if (roomEditor) roomEditor.style.display = 'block';

    refreshFabricTargetOptions();
    populateRoomEditor(zoneId);
  }

  function focusZone(zoneId) {
    if (!zoneId) return;

    selectZone(zoneId);
    ensureEditorVisible();
  }

  function focusElement(zoneId, elementId) {
    if (!zoneId || !elementId) return;

    focusZone(zoneId);

    const card = fabricList ? fabricList.querySelector(`[data-element-id="${CSS.escape(elementId)}"]`) : null;
    if (!card) return;

    const parentSections = [];
    let node = card.parentElement;
    while (node) {
      if (node.tagName === 'DETAILS') parentSections.push(node);
      node = node.parentElement;
    }
    parentSections.forEach(section => {
      section.open = true;
    });

    const firstField = card.querySelector('[data-focus-key]');
    if (firstField) {
      firstField.focus();
    } else {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function focusOpening(zoneId, elementId, kind, openingId) {
    if (!zoneId || !elementId || !kind || !openingId) return;

    focusElement(zoneId, elementId);

    const openingCard = fabricList
      ? fabricList.querySelector(
          `[data-element-id="${CSS.escape(elementId)}"] [data-opening-kind="${CSS.escape(kind)}"][data-opening-id="${CSS.escape(openingId)}"]`
        )
      : null;
    if (!openingCard) return;

    const parentSections = [];
    let node = openingCard.parentElement;
    while (node) {
      if (node.tagName === 'DETAILS') parentSections.push(node);
      node = node.parentElement;
    }
    parentSections.forEach(section => {
      section.open = true;
    });

    const firstField = openingCard.querySelector('[data-focus-key]');
    if (firstField) {
      firstField.focus();
    } else {
      openingCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function focusRadiator(zoneId, radiatorId) {
    if (!zoneId || !radiatorId) return;

    focusZone(zoneId);

    const radiatorCard = radiatorsList
      ? radiatorsList.querySelector(`[data-radiator-id="${CSS.escape(radiatorId)}"]`)
      : null;
    if (!radiatorCard) return;

    const firstField = radiatorCard.querySelector('[data-focus-key]');
    if (firstField) {
      firstField.focus();
    } else {
      radiatorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function getVentilationPresets() {
    const data = getVentilationData ? getVentilationData() : null;
    return Array.isArray(data?.elements) ? data.elements : [];
  }

  function findVentilationPreset(presetId) {
    const presets = getVentilationPresets();
    return presets.find(item => item?.id === presetId) || null;
  }

  function findVentilationPresetForElement(vent) {
    if (!vent) return null;
    const presets = getVentilationPresets();
    if (vent.ventilation_id) {
      const byId = presets.find(item => item?.id === vent.ventilation_id);
      if (byId) return byId;
    }
    return presets.find(item => item?.type === vent.type) || null;
  }

  function addVentilationElementFromPreset(presetId) {
    const preset = findVentilationPreset(presetId);
    if (!preset) {
      if (presetId === 'extractor_oven_hood') addVentilationElement('extractor_oven_hood', 'extractor_kitchen', 60, 0, 'Oven Hood Extractor');
      else if (presetId === 'extractor_bathroom') addVentilationElement('extractor_bathroom', 'extractor_bathroom', 30, 0, 'Bathroom Vent');
      else addVentilationElement('heat_exchanger_mvhr', 'heat_exchanger', 35, 0.75, 'Heat Exchanger (MVHR)');
      return;
    }
    addVentilationElement(
      preset.id,
      preset.type,
      Number.isFinite(preset.default_flow_m3_h) ? preset.default_flow_m3_h : 30,
      Number.isFinite(preset.default_heat_recovery_efficiency) ? preset.default_heat_recovery_efficiency : 0,
      preset.name || 'Ventilation'
    );
  }

  function addVentilationElement(presetId, type, flowM3h, heatRecoveryEfficiency = 0, preferredName = '') {
    if (!selectedZoneId) return;
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.zones)) return;

    const zone = demo.zones.find(z => z.id === selectedZoneId);
    if (!zone) return;
    if (!Array.isArray(zone.ventilation_elements)) zone.ventilation_elements = [];

    const count = zone.ventilation_elements.filter(v => String(v?.type || '') === type).length + 1;
    const baseName = preferredName || (type === 'extractor_bathroom'
      ? 'Bathroom Extractor'
      : (type === 'extractor_kitchen' ? 'Oven Hood Extractor' : 'Heat Exchanger'));

    zone.ventilation_elements.push({
      id: generateUniqueId(),
      ventilation_id: presetId || null,
      type,
      name: `${baseName} ${count}`,
      flow_m3_h: flowM3h,
      heat_recovery_efficiency: heatRecoveryEfficiency,
      enabled: true
    });

    populateRoomEditor(selectedZoneId);
    onDataChanged();
  }

  function populateVentilationSection(zone, zoneKey) {
    if (!ventilationList) return;
    ventilationList.innerHTML = '';

    if (!Array.isArray(zone.ventilation_elements)) zone.ventilation_elements = [];
    const vents = zone.ventilation_elements;

    if (vents.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No ventilation elements';
      ventilationList.appendChild(empty);
      return;
    }

    vents.forEach((vent, index) => {
      const focusBase = `zone:${zoneKey}|vent:${vent.id || index}`;
      const presets = getVentilationPresets();
      const matchedPreset = findVentilationPresetForElement(vent);
      const card = document.createElement('div');
      card.className = 'radiator-item';

      const form = document.createElement('div');
      form.style.display = 'flex';
      form.style.flexDirection = 'column';
      form.style.gap = '0.5rem';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = vent.name || '';
      nameInput.placeholder = 'Ventilation element name';
      nameInput.dataset.focusKey = `${focusBase}:name`;
      nameInput.addEventListener('input', () => {
        const value = nameInput.value.trim();
        if (value) vent.name = value;
        else delete vent.name;
        queueFocusRestore();
        onDataChanged();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = 'x';
      removeBtn.title = 'Remove ventilation element';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.ventilation_elements.splice(index, 1);
        queueFocusRestore();
        onDataChanged();
        refreshSelectedZone();
      });

      header.appendChild(nameInput);
      header.appendChild(removeBtn);

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '0.5rem';
      row.style.alignItems = 'center';
      row.style.flexWrap = 'wrap';

      const presetSelect = document.createElement('select');
      presetSelect.dataset.focusKey = `${focusBase}:preset`;
      presets.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.name || opt.id;
        if ((matchedPreset && matchedPreset.id === opt.id) || String(vent.ventilation_id || '') === opt.id) option.selected = true;
        presetSelect.appendChild(option);
      });

      if (presets.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No ventilation presets loaded';
        presetSelect.appendChild(option);
        presetSelect.disabled = true;
      }

      const flowInput = document.createElement('input');
      configureDecimalInput(flowInput, 'Flow m3/h');
      flowInput.dataset.focusKey = `${focusBase}:flow`;
      flowInput.value = typeof vent.flow_m3_h === 'number' ? formatEditableDecimal(vent.flow_m3_h, 2) : '';

      const recoveryInput = document.createElement('input');
      configureDecimalInput(recoveryInput, 'Recovery %');
      recoveryInput.dataset.focusKey = `${focusBase}:recovery`;
      recoveryInput.value = typeof vent.heat_recovery_efficiency === 'number' ? formatEditablePercent(vent.heat_recovery_efficiency) : '0';

      const enabledCheckbox = document.createElement('input');
      enabledCheckbox.type = 'checkbox';
      enabledCheckbox.checked = vent.enabled !== false;
      enabledCheckbox.dataset.focusKey = `${focusBase}:enabled`;

      const syncVentTypeUI = () => {
        const selectedPreset = findVentilationPreset(presetSelect.value);
        const isHx = (selectedPreset?.type || vent.type) === 'heat_exchanger';
        recoveryInput.disabled = !isHx;
        if (!isHx) {
          vent.heat_recovery_efficiency = 0;
          recoveryInput.value = '0';
        }
      };

      presetSelect.addEventListener('change', () => {
        const selectedPreset = findVentilationPreset(presetSelect.value);
        if (!selectedPreset) return;
        vent.ventilation_id = selectedPreset.id;
        vent.type = selectedPreset.type;
        vent.flow_m3_h = Number((selectedPreset.default_flow_m3_h || 0).toFixed(2));
        vent.heat_recovery_efficiency = Number((selectedPreset.default_heat_recovery_efficiency || 0).toFixed(3));
        flowInput.value = formatEditableDecimal(vent.flow_m3_h, 2);
        recoveryInput.value = formatEditablePercent(vent.heat_recovery_efficiency);
        syncVentTypeUI();
        queueFocusRestore();
        onDataChanged();
      });

      flowInput.addEventListener('input', () => {
        const value = parseDecimalValue(flowInput.value);
        if (!isFinite(value) || value < 0) return;
        vent.flow_m3_h = Number(value.toFixed(2));
        queueFocusRestore();
        onDataChanged();
      });

      recoveryInput.addEventListener('input', () => {
        const value = parseDecimalValue(recoveryInput.value);
        if (!isFinite(value)) return;
        vent.heat_recovery_efficiency = Number((Math.max(0, Math.min(100, value)) / 100).toFixed(3));
        queueFocusRestore();
        onDataChanged();
      });

      enabledCheckbox.addEventListener('change', () => {
        vent.enabled = enabledCheckbox.checked;
        queueFocusRestore();
        onDataChanged();
      });

      const enabledLabel = document.createElement('label');
      enabledLabel.style.display = 'flex';
      enabledLabel.style.alignItems = 'center';
      enabledLabel.style.gap = '0.35rem';
      enabledLabel.appendChild(enabledCheckbox);
      enabledLabel.appendChild(document.createTextNode('Enabled'));

      row.appendChild(presetSelect);
      row.appendChild(flowInput);
      row.appendChild(recoveryInput);
      row.appendChild(enabledLabel);

      syncVentTypeUI();

      form.appendChild(header);
      form.appendChild(row);
      card.appendChild(form);
      ventilationList.appendChild(card);
    });
  }

  function populateRoomEditor(zoneId) {
    const demo = getDemo();
    const radiatorsData = getRadiatorsData();
    if (!demo || !Array.isArray(demo.zones) || !radiatorsList || !fabricList) return;

    const zoneKey = String(zoneId || '').trim();
    const zone = demo.zones.find(z => String(z.id || '').trim() === zoneKey);
    if (!zone) return;

    if (selectedRoomName) {
      selectedRoomName.textContent = `Selected Room: ${zone.name || zone.id}`;
    }

    populateVentilationSection(zone, zoneKey);

    radiatorsList.innerHTML = '';

    if (Array.isArray(zone.radiators)) {
      zone.radiators.forEach((radSpec, index) => {
        if (!radSpec.id) {
          radSpec.id = generateUniqueId();
        }

        const radFocusBaseKey = `zone:${zoneKey}|radiator:${index}`;
        const item = document.createElement('div');
        item.className = 'radiator-item';
        item.dataset.radiatorId = String(radSpec.id);

        const typeSelect = document.createElement('select');
        typeSelect.dataset.focusKey = `${radFocusBaseKey}:type`;
        const radOptions = (radiatorsData && Array.isArray(radiatorsData.radiators)) ? radiatorsData.radiators : [];
        radOptions.forEach(rad => {
          const option = document.createElement('option');
          option.value = rad.id;
          option.textContent = rad.name;
          if (rad.id === radSpec.radiator_id) option.selected = true;
          typeSelect.appendChild(option);
        });

        const widthSelect = document.createElement('select');
        widthSelect.dataset.focusKey = `${radFocusBaseKey}:width_select`;
        const widthInput = document.createElement('input');
        widthInput.dataset.focusKey = `${radFocusBaseKey}:width_input`;
        widthInput.type = 'number';
        widthInput.placeholder = 'Width (mm)';
        widthInput.value = radSpec.width || '';
        widthInput.step = '10';
        widthInput.min = '200';
        widthInput.max = '3000';

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
        heightSelect.dataset.focusKey = `${radFocusBaseKey}:height_select`;
        const heightInput = document.createElement('input');
        heightInput.dataset.focusKey = `${radFocusBaseKey}:height_input`;
        heightInput.type = 'number';
        heightInput.placeholder = 'Height (mm)';
        heightInput.value = radSpec.height || '';
        heightInput.step = '10';
        heightInput.min = '200';
        heightInput.max = '2000';

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

        const updateArea = () => {
          const width = parseFloat(widthInput.value || widthSelect.value) / 1000;
          const height = parseFloat(heightInput.value || heightSelect.value) / 1000;
          if (width > 0 && height > 0) {
            const area = (width * height).toFixed(2);
            areaDisplay.textContent = `Area: ${area}m²`;
            radSpec.surface_area = parseFloat(area);
            radSpec.width = parseInt(widthInput.value || widthSelect.value);
            radSpec.height = parseInt(heightInput.value || heightSelect.value);
            queueFocusRestore();
            onDataChanged();
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
          queueFocusRestore();
          onDataChanged();
        });

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
        removeBtn.innerHTML = 'x';
        removeBtn.title = 'Remove radiator';
        removeBtn.className = 'remove-btn';
        removeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          queueFocusRestore();
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

        const trvRow = document.createElement('div');
        trvRow.style.display = 'flex';
        trvRow.style.alignItems = 'center';
        trvRow.style.gap = '0.5rem';

        const trvCheckbox = document.createElement('input');
        trvCheckbox.type = 'checkbox';
        trvCheckbox.checked = radSpec.trv_enabled || false;
        trvCheckbox.addEventListener('change', () => {
          radSpec.trv_enabled = trvCheckbox.checked;
          queueFocusRestore();
          onDataChanged();
        });

        const trvLabel = document.createElement('label');
        trvLabel.style.display = 'flex';
        trvLabel.style.alignItems = 'center';
        trvLabel.style.gap = '0.3rem';
        trvLabel.style.cursor = 'pointer';
        trvLabel.appendChild(trvCheckbox);
        trvLabel.appendChild(document.createTextNode('TRV Enabled'));

        trvRow.appendChild(trvLabel);

        formDiv.appendChild(headerDiv);
        formDiv.appendChild(sizeRow);
        formDiv.appendChild(trvRow);

        item.appendChild(formDiv);
        radiatorsList.appendChild(item);
      });
    }

    const expandState = captureExpandState(fabricList);
    populateFabricSection(demo, zoneKey, fabricList, expandState);
    restoreFocusState();
  }

  function syncSelectedZoneVisualState() {
    document.querySelectorAll('.thermal-zone-cell').forEach(cell => {
      cell.classList.remove('selected');
    });

    if (!selectedZoneId) return;
    const selectedCell = document.querySelector(`.thermal-zone-cell[data-zone-id="${selectedZoneId}"]`);
    if (selectedCell) selectedCell.classList.add('selected');
  }

  function createRoom() {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.zones)) {
      if (typeof onAddRoom === 'function') onAddRoom();
      return;
    }

    const baseLevel = selectedZoneId
      ? (demo.zones.find(zone => zone.id === selectedZoneId)?.level ?? 0)
      : 0;
    const id = generateUniqueRoomId(demo);
    const newZone = {
      id,
      name: `New Room ${demo.zones.filter(zone => zone.type !== 'boundary').length + 1}`,
      level: baseLevel,
      radiators: [],
      ventilation_elements: []
    };

    demo.zones.push(newZone);
    selectedZoneId = newZone.id;
    if (roomSelector) roomSelector.style.display = 'none';
    if (roomEditor) roomEditor.style.display = 'block';
    onDataChanged();
    refreshFabricTargetOptions();
    populateRoomEditor(newZone.id);
  }

  function generateUniqueRoomId(demo) {
    const existingIds = new Set((demo.zones || []).map(zone => zone.id));
    let candidate;
    do {
      // Generate random hash: id_XXXXXXXXXX (12 hex chars after id_)
      candidate = 'id_' + Math.random().toString(16).substring(2, 14);
    } while (existingIds.has(candidate));
    return candidate;
  }

  function captureCurrentFocusState() {
    const active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.focusKey) return null;

    const state = {
      key: active.dataset.focusKey,
      tagName: active.tagName,
      inputType: active.type || null,
      value: null,
      selectionStart: null,
      selectionEnd: null
    };

    if (
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
      active.type !== 'checkbox' &&
      active.type !== 'radio'
    ) {
      state.value = active.value;
    }

    if (typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
      state.selectionStart = active.selectionStart;
      state.selectionEnd = active.selectionEnd;
    }

    return state;
  }

  function queueFocusRestore() {
    pendingFocusState = captureCurrentFocusState();
  }

  function restoreFocusState() {
    if (!pendingFocusState || !pendingFocusState.key) return;

    const target = Array.from(document.querySelectorAll('[data-focus-key]'))
      .find(node => node.dataset.focusKey === pendingFocusState.key);

    if (!target) {
      pendingFocusState = null;
      return;
    }

    if (
      pendingFocusState.value !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
      target.type !== 'checkbox' &&
      target.type !== 'radio'
    ) {
      target.value = pendingFocusState.value;
    }

    target.focus();
    if (
      pendingFocusState.tagName === 'INPUT' &&
      typeof target.setSelectionRange === 'function' &&
      typeof pendingFocusState.selectionStart === 'number' &&
      typeof pendingFocusState.selectionEnd === 'number'
    ) {
      target.setSelectionRange(pendingFocusState.selectionStart, pendingFocusState.selectionEnd);
    }

    pendingFocusState = null;
  }

  function captureExpandState(container) {
    const state = new Map();
    if (!container) return state;
    container.querySelectorAll('details[data-expand-key]').forEach(node => {
      state.set(node.dataset.expandKey, node.open);
    });
    return state;
  }

  function restoreOpenState(detailsNode, key, defaultOpen, expandState) {
    detailsNode.dataset.expandKey = key;
    if (expandState && expandState.has(key)) {
      detailsNode.open = expandState.get(key);
    } else {
      detailsNode.open = defaultOpen;
    }
  }

  function populateFabricSection(demo, zoneKey, container, expandState) {
    container.innerHTML = '';

    const allElements = Array.isArray(demo.elements) ? demo.elements : [];
    const connectedElements = allElements.filter(e => {
      return Array.isArray(e.nodes) && e.nodes.some(node => String(node || '').trim() === zoneKey);
    });

    if (allElements.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wall-empty';
      empty.textContent = 'No elements array found in loaded data.';
      container.appendChild(empty);
      return;
    }

    if (connectedElements.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wall-empty';
      empty.textContent = 'No fabric elements connected to this room.';
      container.appendChild(empty);
      return;
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
      const typeKey = `type:${type}`;
      restoreOpenState(typeSection, typeKey, type === 'wall', expandState);

      const typeSummary = document.createElement('summary');
      typeSummary.textContent = `${type} (${groupedByType.get(type).length})`;
      typeSection.appendChild(typeSummary);

      groupedByType.get(type).forEach(element => {
        typeSection.appendChild(createElementDetailCard(element, zoneKey, type, expandState));
      });

      container.appendChild(typeSection);
    });
  }

  function createElementDetailCard(element, zoneKey, elementType, expandState) {
    const elementName = element.name || element.id || 'Unnamed element';
    const elementId = element.id || elementName;
    const x = typeof element.x === 'number' ? element.x : null;
    const y = typeof element.y === 'number' ? element.y : null;
    const area = (x !== null && y !== null) ? x * y : null;
    const labels = getDimensionLabelsForType(elementType);
    const totalRDisplay = formatElementRDisplay(element);

    const otherNodes = (Array.isArray(element.nodes) ? element.nodes : [])
      .filter(node => String(node || '').trim() !== zoneKey);

    const details = document.createElement('details');
    details.className = 'wall-card';
    details.dataset.elementId = elementId;
    const cardKey = `type:${elementType}|element:${elementId}`;
    restoreOpenState(details, cardKey, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = `${elementName}${element.orientation ? ` (${element.orientation})` : ''}${totalRDisplay ? ` [R: ${totalRDisplay}]` : ''}`;
    details.appendChild(summary);

    const meta = document.createElement('div');
    meta.className = 'wall-meta';
    const nameRow = document.createElement('div');
    nameRow.style.display = 'flex';
    nameRow.style.alignItems = 'center';
    nameRow.style.gap = '0.5rem';
    const nameLabel = document.createElement('strong');
    nameLabel.textContent = 'Name:';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = element.name || '';
    nameInput.placeholder = element.id || 'Element name';
    nameInput.dataset.focusKey = `${cardKey}:name`;
    nameInput.addEventListener('input', () => {
      const newName = nameInput.value.trim();
      if (newName) {
        element.name = newName;
      } else {
        delete element.name;
      }
      queueFocusRestore();
      onDataChanged();
    });
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);

    const dimRow = document.createElement('div');
    dimRow.style.display = 'flex';
    dimRow.style.alignItems = 'center';
    dimRow.style.gap = '0.5rem';
    dimRow.style.flexWrap = 'wrap';

    const xLabel = document.createElement('strong');
    xLabel.textContent = `${labels.xLabel}:`;
    const xInput = document.createElement('input');
    configureDecimalInput(xInput, labels.xLabel);
    xInput.value = x !== null ? x : '';
    xInput.placeholder = labels.xLabel;
    xInput.dataset.focusKey = `${cardKey}:x`;

    const yLabel = document.createElement('strong');
    yLabel.textContent = `${labels.yLabel}:`;
    const yInput = document.createElement('input');
    configureDecimalInput(yInput, labels.yLabel);
    yInput.value = y !== null ? y : '';
    yInput.placeholder = labels.yLabel;
    yInput.dataset.focusKey = `${cardKey}:y`;

    const updateDimensions = () => {
      const xv = parseDecimalValue(xInput.value);
      const yv = parseDecimalValue(yInput.value);
      if (isFinite(xv) && xv > 0) {
        element.x = Number(xv.toFixed(3));
      }
      if (isFinite(yv) && yv > 0) {
        element.y = Number(yv.toFixed(3));
      }
      if (isFinite(xv) && xv > 0 && isFinite(yv) && yv > 0) {
        element.area = Number((xv * yv).toFixed(3));
      }
      queueFocusRestore();
      onDataChanged();
    };

    xInput.addEventListener('input', updateDimensions);
    yInput.addEventListener('input', updateDimensions);

    dimRow.appendChild(xLabel);
    dimRow.appendChild(xInput);
    dimRow.appendChild(yLabel);
    dimRow.appendChild(yInput);

    const areaRow = document.createElement('p');
    areaRow.innerHTML = `<strong>Area:</strong> ${area !== null ? `${area} m²` : 'Unknown'}`;
    const rRow = document.createElement('p');
    rRow.innerHTML = `<strong>Total R:</strong> ${totalRDisplay || 'Unknown'}`;
    
    const nodeRow = document.createElement('p');
    const demo = getDemo();
    const nodeNames = otherNodes.length 
      ? otherNodes.map(nodeId => {
          const zone = demo && Array.isArray(demo.zones) 
            ? demo.zones.find(z => z.id === nodeId)
            : null;
          return zone ? zone.name || zone.id : nodeId;
        }).join(', ')
      : 'None';
    nodeRow.innerHTML = `<strong>Other connected rooms/nodes:</strong> ${nodeNames}`;

    meta.appendChild(nameRow);
    meta.appendChild(dimRow);
    meta.appendChild(areaRow);
    meta.appendChild(rRow);
    meta.appendChild(nodeRow);
    details.appendChild(meta);

    details.appendChild(createBuildUpSection(element, cardKey, expandState));
    details.appendChild(createWindowsSection(element, cardKey, expandState));
    details.appendChild(createDoorsSection(element, cardKey, expandState));

    return details;
  }

  function getDimensionLabelsForType(elementType) {
    const type = String(elementType || '').toLowerCase();
    if (type === 'wall') {
      return { xLabel: 'Length', yLabel: 'Height' };
    }
    if (type === 'floor' || type === 'roof' || type === 'ceiling' || type === 'floor_ceiling') {
      return { xLabel: 'Length', yLabel: 'Width' };
    }
    return { xLabel: 'X', yLabel: 'Y' };
  }

  function updateTemplateUsageCounts(demo) {
    if (!demo || !demo.meta || !demo.meta.build_up_templates) return;
    const templates = demo.meta.build_up_templates;
    Object.keys(templates).forEach(id => {
      templates[id].usage_count = 0;
    });
    const elements = Array.isArray(demo.elements) ? demo.elements : [];
    elements.forEach(el => {
      const id = el && el.build_up_template_id;
      if (id && templates[id]) {
        templates[id].usage_count = (templates[id].usage_count || 0) + 1;
      }
    });
  }

  function createBuildUpSection(element, parentKey, expandState) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';
    restoreOpenState(section, `${parentKey}|sub:build_up`, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = 'Build-up';
    section.appendChild(summary);

    const demo = getDemo();
    const templates = (demo && demo.meta && demo.meta.build_up_templates) || {};
    const hasTemplate = !!element.build_up_template_id;
    const templateId = element.build_up_template_id;
    const templateBuildup = (hasTemplate && templates[templateId] && templates[templateId].build_up) 
      ? templates[templateId].build_up 
      : null;
    const isTemplateModifyMode = hasTemplate && element._templateEditMode === 'modify';

    // Template selector row
    const templateRow = document.createElement('div');
    templateRow.style.display = 'flex';
    templateRow.style.gap = '0.5rem';
    templateRow.style.flexWrap = 'wrap';
    templateRow.style.alignItems = 'center';
    templateRow.style.marginBottom = '0.5rem';
    templateRow.style.borderBottom = '1px solid #555';
    templateRow.style.paddingBottom = '0.5rem';

    const templateLabel = document.createElement('strong');
    templateLabel.textContent = 'Template:';
    templateRow.appendChild(templateLabel);

    const templateSelect = document.createElement('select');
    templateSelect.dataset.focusKey = `${parentKey}|template_select`;
    
    const noTemplateOption = document.createElement('option');
    noTemplateOption.value = '';
    noTemplateOption.textContent = '(None - use inline build-up)';
    if (!hasTemplate) noTemplateOption.selected = true;
    templateSelect.appendChild(noTemplateOption);

    Object.entries(templates).sort((a, b) => a[0].localeCompare(b[0])).forEach(([tplId, tpl]) => {
      const option = document.createElement('option');
      option.value = tplId;
      option.textContent = `${tpl.name || tplId} (${tpl.usage_count} uses)`;
      if (templateId === tplId) option.selected = true;
      templateSelect.appendChild(option);
    });

    templateSelect.addEventListener('change', () => {
      const selected = templateSelect.value;
      if (selected) {
        element.build_up_template_id = selected;
        delete element.build_up;
        element._templateEditMode = 'view';
      } else {
        delete element.build_up_template_id;
        delete element._templateEditMode;
        // Initialize with empty array if switching to inline
        if (!element.build_up) element.build_up = [];
      }
      updateTemplateUsageCounts(demo);
      queueFocusRestore();
      onDataChanged();
      refreshSelectedZone();
    });

    templateRow.appendChild(templateSelect);

    // Show current template info if using template
    if (hasTemplate && templateBuildup) {
      const infoSpan = document.createElement('span');
      infoSpan.style.fontSize = '0.9em';
      infoSpan.style.color = '#aaa';
      infoSpan.textContent = isTemplateModifyMode
        ? `(${templateBuildup.length} layers, editing template in place)`
        : `(${templateBuildup.length} layers, read-only)`;
      templateRow.appendChild(infoSpan);
    }

    section.appendChild(templateRow);

    // Build-up content
    const list = document.createElement('div');
    const materialOptions = getBuildUpMaterialOptions();
    const materialLookup = getBuildUpMaterialLookup();

    // If using template, show read-only layers or editable template mode
    if (hasTemplate && templateBuildup) {
      if (isTemplateModifyMode) {
        templateBuildup.forEach((layer, i) => {
          list.appendChild(createBuildUpLayerEditor({
            layer,
            layerIndex: i,
            buildUp: templateBuildup,
            parentKey: `${parentKey}|template:${templateId}`,
            materialOptions,
            materialLookup
          }));
        });
      } else {
        templateBuildup.forEach((layer, i) => {
          list.appendChild(createBuildUpLayerDisplay({
            layer,
            layerIndex: i,
            materialLookup,
            readOnly: true
          }));
        });
      }
    } else {
      // Show editable inline build-up
      const buildUp = Array.isArray(element.build_up) ? element.build_up : [];
      if (!Array.isArray(element.build_up)) element.build_up = [];

      if (buildUp.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No build-up data';
        list.appendChild(empty);
      } else {
        buildUp.forEach((layer, i) => {
          list.appendChild(createBuildUpLayerEditor({
            layer,
            layerIndex: i,
            buildUp,
            parentKey,
            materialOptions,
            materialLookup
          }));
        });
      }
    }

    section.appendChild(list);

    // Action buttons
    const actionRow = document.createElement('div');
    actionRow.style.display = 'flex';
    actionRow.style.gap = '0.5rem';
    actionRow.style.flexWrap = 'wrap';
    actionRow.style.borderTop = '1px solid #555';
    actionRow.style.paddingTop = '0.5rem';
    actionRow.style.marginTop = '0.5rem';

    if (hasTemplate) {
      const modifyBtn = document.createElement('button');
      modifyBtn.textContent = isTemplateModifyMode ? 'Done' : 'Modify';
      modifyBtn.title = isTemplateModifyMode
        ? 'Stop editing this template'
        : 'Edit this template in place (affects all elements using it)';
      modifyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        element._templateEditMode = isTemplateModifyMode ? 'view' : 'modify';
        refreshSelectedZone();
      });

      const cloneBtn = document.createElement('button');
      cloneBtn.textContent = 'Clone';
      cloneBtn.title = 'Create a copy of this template, rename it, and edit the copy';
      cloneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        if (!templateBuildup) return;
        if (!demo.meta) demo.meta = {};
        if (!demo.meta.build_up_templates) demo.meta.build_up_templates = {};

        const sourceName = (templates[templateId] && templates[templateId].name) || templateId;
        const proposedName = `${sourceName} (Copy)`;
        const enteredName = prompt('Name for cloned template:', proposedName);
        if (!enteredName || !enteredName.trim()) return;

        const newTemplateId = `buo_custom_${Date.now()}`;
        demo.meta.build_up_templates[newTemplateId] = {
          name: enteredName.trim(),
          usage_count: 0,
          build_up: JSON.parse(JSON.stringify(templateBuildup))
        };

        element.build_up_template_id = newTemplateId;
        element._templateEditMode = 'modify';
        delete element.build_up;

        updateTemplateUsageCounts(demo);
        onDataChanged();
        refreshSelectedZone();
      });

      actionRow.appendChild(modifyBtn);
      actionRow.appendChild(cloneBtn);

      if (isTemplateModifyMode) {
        const addLayerBtn = document.createElement('button');
        addLayerBtn.textContent = 'Add Layer';
        addLayerBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          queueFocusRestore();
          const firstMaterial = materialOptions[0] ? materialOptions[0].id : 'plasterboard';
          templateBuildup.push({ material_id: firstMaterial, thickness: 0.0125 });
          onDataChanged();
          refreshSelectedZone();
        });

        const addCompositeBtn = document.createElement('button');
        addCompositeBtn.textContent = 'Add Composite Layer';
        addCompositeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          queueFocusRestore();
          templateBuildup.push({
            type: 'composite',
            thickness: 0.09,
            paths: [
              { material_id: 'stud_wood', fraction: 0.063 },
              { material_id: 'pir', fraction: 0.937 }
            ]
          });
          onDataChanged();
          refreshSelectedZone();
        });

        actionRow.appendChild(addLayerBtn);
        actionRow.appendChild(addCompositeBtn);
      }
    } else {
      // Show add layer / add composite buttons
      const buildUp = Array.isArray(element.build_up) ? element.build_up : [];
      
      const addLayerBtn = document.createElement('button');
      addLayerBtn.textContent = 'Add Layer';
      addLayerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        const firstMaterial = materialOptions[0] ? materialOptions[0].id : 'plasterboard';
        element.build_up.push({ material_id: firstMaterial, thickness: 0.0125 });
        onDataChanged();
        refreshSelectedZone();
      });

      const addCompositeBtn = document.createElement('button');
      addCompositeBtn.textContent = 'Add Composite Layer';
      addCompositeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        element.build_up.push({
          type: 'composite',
          thickness: 0.09,
          paths: [
            { material_id: 'stud_wood', fraction: 0.063 },
            { material_id: 'pir', fraction: 0.937 }
          ]
        });
        onDataChanged();
        refreshSelectedZone();
      });

      const saveAsTemplateBtn = document.createElement('button');
      saveAsTemplateBtn.textContent = 'Save as template';
      saveAsTemplateBtn.title = 'Create a new build-up template from this configuration';
      saveAsTemplateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        const name = prompt('Enter template name:', `${element.name || 'custom'} build-up`);
        if (name && name.trim()) {
          const newTemplateId = `buo_custom_${Date.now()}`;
          if (!demo.meta) demo.meta = {};
          if (!demo.meta.build_up_templates) demo.meta.build_up_templates = {};
          demo.meta.build_up_templates[newTemplateId] = {
            name: name.trim(),
            usage_count: 0,
            build_up: JSON.parse(JSON.stringify(buildUp))
          };
          // Switch to using the new template
          element.build_up_template_id = newTemplateId;
          element._templateEditMode = 'modify';
          delete element.build_up;
          updateTemplateUsageCounts(demo);
          onDataChanged();
          refreshSelectedZone();
        }
      });

      actionRow.appendChild(addLayerBtn);
      actionRow.appendChild(addCompositeBtn);
      actionRow.appendChild(saveAsTemplateBtn);
    }

    section.appendChild(actionRow);
    return section;
  }

  function createBuildUpLayerDisplay(config) {
    const layer = config.layer;
    const layerIndex = config.layerIndex;
    const materialLookup = config.materialLookup;

    const wrap = document.createElement('div');
    wrap.className = 'radiator-item';
    wrap.style.opacity = '0.8';

    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '0.5rem';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const title = document.createElement('strong');
    const rDisplay = formatLayerRDisplay(layer, materialLookup);
    title.textContent = `Layer ${layerIndex + 1}${rDisplay ? ` [R: ${rDisplay}]` : ''}`;

    header.appendChild(title);
    form.appendChild(header);

    if (layer.type === 'composite') {
      const compInfo = document.createElement('div');
      compInfo.style.fontSize = '0.9em';
      compInfo.style.color = '#aaa';
      const pathNames = (layer.paths || []).map(p => {
        const mat = materialLookup[p.material_id];
        return `${mat ? mat.name : p.material_id} (${(p.fraction * 100).toFixed(0)}%)`;
      }).join(', ');
      compInfo.textContent = `Composite ${layer.thickness}m: ${pathNames}`;
      form.appendChild(compInfo);
    } else {
      const matInfo = document.createElement('div');
      matInfo.style.fontSize = '0.9em';
      matInfo.style.color = '#aaa';
      const matName = materialLookup[layer.material_id] ? materialLookup[layer.material_id].name : layer.material_id;
      matInfo.textContent = `${matName} ${layer.thickness}m`;
      form.appendChild(matInfo);
    }

    wrap.appendChild(form);
    return wrap;
  }

  function createBuildUpLayerEditor(config) {
    const layer = config.layer;
    const layerIndex = config.layerIndex;
    const buildUp = config.buildUp;
    const parentKey = config.parentKey;
    const materialOptions = config.materialOptions;
    const materialLookup = config.materialLookup;
    const focusBaseKey = `${parentKey}|layer:${layerIndex}`;

    const wrap = document.createElement('div');
    wrap.className = 'radiator-item';

    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '0.5rem';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const title = document.createElement('strong');
    const rDisplay = formatLayerRDisplay(layer, materialLookup);
    title.textContent = `Layer ${layerIndex + 1}${rDisplay ? ` [R: ${rDisplay}]` : ''}`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'x';
    removeBtn.title = 'Remove layer';
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queueFocusRestore();
      buildUp.splice(layerIndex, 1);
      onDataChanged();
      refreshSelectedZone();
    });

    header.appendChild(title);
    header.appendChild(removeBtn);
    form.appendChild(header);

    const thicknessRow = document.createElement('div');
    thicknessRow.style.display = 'flex';
    thicknessRow.style.alignItems = 'center';
    thicknessRow.style.gap = '0.5rem';
    thicknessRow.style.flexWrap = 'wrap';

    const thicknessLabel = document.createElement('span');
    thicknessLabel.textContent = 'Thickness (m):';
    const thicknessInput = document.createElement('input');
    configureDecimalInput(thicknessInput, 'Thickness (m)');
    thicknessInput.value = typeof layer.thickness === 'number' ? formatEditableDecimal(layer.thickness, 4) : '';
    thicknessInput.dataset.focusKey = `${focusBaseKey}:thickness`;
    thicknessInput.addEventListener('input', () => {
      const value = parseDecimalValue(thicknessInput.value);
      if (isFinite(value) && value > 0) {
        layer.thickness = Number(value.toFixed(4));
        queueFocusRestore();
        onDataChanged();
      }
    });

    thicknessRow.appendChild(thicknessLabel);
    thicknessRow.appendChild(thicknessInput);
    form.appendChild(thicknessRow);

    if (layer.type === 'composite') {
      form.appendChild(createCompositeLayerEditor(layer, focusBaseKey, materialOptions));
    } else {
      const materialRow = document.createElement('div');
      materialRow.style.display = 'flex';
      materialRow.style.alignItems = 'center';
      materialRow.style.gap = '0.5rem';
      materialRow.style.flexWrap = 'wrap';

      const materialLabel = document.createElement('span');
      materialLabel.textContent = 'Material:';
      const materialSelect = document.createElement('select');
      materialSelect.dataset.focusKey = `${focusBaseKey}:material`;

      const selectedMaterial = layer.material_id;
      if (selectedMaterial && !materialOptions.some(opt => opt.id === selectedMaterial)) {
        const fallbackOption = document.createElement('option');
        fallbackOption.value = selectedMaterial;
        fallbackOption.textContent = `${selectedMaterial} (current)`;
        fallbackOption.selected = true;
        materialSelect.appendChild(fallbackOption);
      }

      materialOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
          option.textContent = opt.label || opt.name;
        if (opt.id === selectedMaterial) option.selected = true;
        materialSelect.appendChild(option);
      });

      materialSelect.addEventListener('change', () => {
        layer.material_id = materialSelect.value;
        queueFocusRestore();
        onDataChanged();
      });

      const makeCompositeBtn = document.createElement('button');
      makeCompositeBtn.textContent = 'Make Composite';
      makeCompositeBtn.addEventListener('click', () => {
        layer.type = 'composite';
        if (typeof layer.thickness !== 'number' || layer.thickness <= 0) layer.thickness = 0.09;
        layer.paths = [
          { material_id: 'stud_wood', fraction: 0.063 },
          { material_id: 'pir', fraction: 0.937 }
        ];
        delete layer.material_id;
        onDataChanged();
        refreshSelectedZone();
      });

      materialRow.appendChild(materialLabel);
      materialRow.appendChild(materialSelect);
      materialRow.appendChild(makeCompositeBtn);
      form.appendChild(materialRow);
    }

    wrap.appendChild(form);
    return wrap;
  }

  function createCompositeLayerEditor(layer, focusBaseKey, materialOptions) {
    if (!Array.isArray(layer.paths)) layer.paths = [];

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '0.5rem';

    const presetRow = document.createElement('div');
    presetRow.style.display = 'flex';
    presetRow.style.gap = '0.5rem';
    presetRow.style.flexWrap = 'wrap';

    const presetButtons = [
      { label: '600mm c-c + PIR', center: 600, fill: 'pir' },
      { label: '600mm c-c + Rockwool', center: 600, fill: 'rockwool' },
      { label: '400mm c-c + PIR', center: 400, fill: 'pir' },
      { label: '400mm c-c + Rockwool', center: 400, fill: 'rockwool' }
    ];

    presetButtons.forEach(preset => {
      const btn = document.createElement('button');
      btn.textContent = preset.label;
      btn.addEventListener('click', () => {
        applyCompositeStudPreset(layer, preset.center, preset.fill);
      });
      presetRow.appendChild(btn);
    });

    const makeSingleBtn = document.createElement('button');
    makeSingleBtn.textContent = 'Make Single Layer';
    makeSingleBtn.addEventListener('click', () => {
      delete layer.type;
      layer.material_id = layer.paths[0]?.material_id || 'plasterboard';
      delete layer.paths;
      onDataChanged();
      refreshSelectedZone();
    });
    presetRow.appendChild(makeSingleBtn);

    container.appendChild(presetRow);

    const pathsWrap = document.createElement('div');
    pathsWrap.style.display = 'flex';
    pathsWrap.style.flexDirection = 'column';
    pathsWrap.style.gap = '0.4rem';

    layer.paths.forEach((path, pathIndex) => {
      const row = document.createElement('div');
      row.className = 'radiator-item';
      row.style.padding = '0.4rem';

      const matSelect = document.createElement('select');
      matSelect.dataset.focusKey = `${focusBaseKey}:path:${pathIndex}:material`;

      const selectedMat = path.material_id;
      if (selectedMat && !materialOptions.some(opt => opt.id === selectedMat)) {
        const fallbackOption = document.createElement('option');
        fallbackOption.value = selectedMat;
        fallbackOption.textContent = `${selectedMat} (current)`;
        fallbackOption.selected = true;
        matSelect.appendChild(fallbackOption);
      }

      materialOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.label || opt.name;
        if (opt.id === selectedMat) option.selected = true;
        matSelect.appendChild(option);
      });

      matSelect.addEventListener('change', () => {
        path.material_id = matSelect.value;
        queueFocusRestore();
        onDataChanged();
      });

      const fracInput = document.createElement('input');
      configureDecimalInput(fracInput, 'Fraction');
      fracInput.value = typeof path.fraction === 'number' ? formatEditableDecimal(path.fraction, 3) : '';
      fracInput.dataset.focusKey = `${focusBaseKey}:path:${pathIndex}:fraction`;
      fracInput.addEventListener('input', () => {
        const fv = parseDecimalValue(fracInput.value);
        if (isFinite(fv) && fv >= 0) {
          path.fraction = Number(fv.toFixed(3));
          queueFocusRestore();
          onDataChanged();
        }
      });

      const removePathBtn = document.createElement('button');
      removePathBtn.className = 'remove-btn';
      removePathBtn.textContent = 'x';
      removePathBtn.title = 'Remove path';
      removePathBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        queueFocusRestore();
        layer.paths.splice(pathIndex, 1);
        onDataChanged();
        refreshSelectedZone();
      });

      row.appendChild(document.createTextNode(`Path ${pathIndex + 1}: `));
      row.appendChild(matSelect);
      row.appendChild(document.createTextNode(' Fraction: '));
      row.appendChild(fracInput);
      row.appendChild(removePathBtn);
      pathsWrap.appendChild(row);
    });

    container.appendChild(pathsWrap);

    const addPathBtn = document.createElement('button');
    addPathBtn.textContent = 'Add Path';
    addPathBtn.addEventListener('click', () => {
      const defaultMaterial = materialOptions[0] ? materialOptions[0].id : 'stud_wood';
      layer.paths.push({ material_id: defaultMaterial, fraction: 0.5 });
      onDataChanged();
      refreshSelectedZone();
    });
    container.appendChild(addPathBtn);

    return container;
  }

  function applyCompositeStudPreset(layer, centerMm, fillMaterialId) {
    const studFraction = Number((38 / centerMm).toFixed(3));
    const fillFraction = Number((1 - studFraction).toFixed(3));
    layer.type = 'composite';
    if (typeof layer.thickness !== 'number' || layer.thickness <= 0) layer.thickness = 0.09;
    layer.paths = [
      { material_id: 'stud_wood', fraction: studFraction },
      { material_id: fillMaterialId, fraction: fillFraction }
    ];
    queueFocusRestore();
    onDataChanged();
  }

  function createWindowsSection(element, parentKey, expandState) {
    const redistributeWindowPositions = (windows) => {
      if (!Array.isArray(windows) || windows.length === 0) return;
      const count = windows.length;
      windows.forEach((win, idx) => {
        // Even spacing with edge margins: n=1 => 0.5, n=2 => 0.333/0.667, etc.
        win.position_ratio = Number(((idx + 1) / (count + 1)).toFixed(3));
      });
    };

    const section = document.createElement('details');
    section.className = 'wall-subsection';
    restoreOpenState(section, `${parentKey}|sub:windows`, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = 'Windows';
    section.appendChild(summary);

    const list = document.createElement('div');
    const windows = Array.isArray(element.windows) ? element.windows : [];
    const options = getWindowOptions();

    if (windows.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No windows';
      list.appendChild(empty);
    } else {
      windows.forEach((win, i) => {
        list.appendChild(createOpeningEditor({
          kind: 'window',
          opening: win,
          index: i,
          options,
          focusBaseKey: `${parentKey}|window:${win.id || i}`,
          onRemove: () => {
            element.windows.splice(i, 1);
            redistributeWindowPositions(element.windows);
            onDataChanged();
            refreshSelectedZone();
          }
        }));
      });
    }

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Window';
    addBtn.addEventListener('click', () => {
      if (!Array.isArray(element.windows)) element.windows = [];
      const firstOption = options[0] || { id: 'window_double_modern' };
      element.windows.push({
        id: generateUniqueId(),
        name: `Window ${element.windows.length + 1}`,
        glazing_id: firstOption.id,
        width: 1000,
        height: 1200,
        area: 1.2,
        length_m: 1.0,
        position_ratio: 0.5,
        has_trickle_vent: firstOption.has_trickle_vent === true,
        trickle_vent_flow_m3_h: Number((firstOption.trickle_vent_flow_m3_h || 0).toFixed(2)),
        air_leakage_m3_h_m2: Number((firstOption.air_leakage_m3_h_m2 || 0).toFixed(3))
      });
      redistributeWindowPositions(element.windows);
      onDataChanged();
      refreshSelectedZone();
    });

    section.appendChild(list);
    section.appendChild(addBtn);
    return section;
  }

  function createDoorsSection(element, parentKey, expandState) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';
    restoreOpenState(section, `${parentKey}|sub:doors`, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = 'Doors';
    section.appendChild(summary);

    const list = document.createElement('div');
    const doors = Array.isArray(element.doors) ? element.doors : [];
    const options = getDoorOptions();

    if (doors.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No doors';
      list.appendChild(empty);
    } else {
      doors.forEach((door, i) => {
        list.appendChild(createOpeningEditor({
          kind: 'door',
          opening: door,
          index: i,
          options,
          focusBaseKey: `${parentKey}|door:${door.id || i}`,
          onRemove: () => {
            element.doors.splice(i, 1);
            onDataChanged();
            refreshSelectedZone();
          }
        }));
      });
    }

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Door';
    addBtn.addEventListener('click', () => {
      if (!Array.isArray(element.doors)) element.doors = [];
      const firstOption = options[0] || { id: 'door_wood_solid' };
      element.doors.push({
        id: generateUniqueId(),
        name: `Door ${element.doors.length + 1}`,
        type: 'external_door',
        material_id: firstOption.id,
        width: 900,
        height: 2000,
        area: 1.8,
        length_m: 0.9,
        position_ratio: 0.5,
        hinge_side: 'left',
        air_leakage_m3_h_m2: Number((firstOption.air_leakage_m3_h_m2 || 0).toFixed(3))
      });
      onDataChanged();
      refreshSelectedZone();
    });

    section.appendChild(list);
    section.appendChild(addBtn);
    return section;
  }

  function createOpeningEditor(config) {
    const kind = config.kind;
    const opening = config.opening;
    const index = config.index;
    const options = config.options;
    const focusBaseKey = config.focusBaseKey || `${kind}:${opening.id || index}`;

    const wrap = document.createElement('div');
    wrap.className = 'radiator-item';
    wrap.dataset.openingKind = String(kind);
    wrap.dataset.openingId = String(opening.id || `opening_${index}`);

    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '0.5rem';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const left = document.createElement('div');
    const selectedValue = kind === 'window' ? opening.glazing_id : opening.material_id;
    const openingUDisplay = formatOpeningUDisplay(kind, selectedValue);
    left.textContent = `${opening.id || `${kind}_${index + 1}`}${openingUDisplay ? ` [U: ${openingUDisplay}]` : ''} - `;

    const materialSelect = document.createElement('select');
    materialSelect.dataset.focusKey = `${focusBaseKey}:material`;
    if (selectedValue && !options.some(opt => opt.id === selectedValue)) {
      const fallbackOption = document.createElement('option');
      fallbackOption.value = selectedValue;
      fallbackOption.textContent = `${selectedValue} (current)`;
      fallbackOption.selected = true;
      materialSelect.appendChild(fallbackOption);
    }
    options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.id;
      option.textContent = opt.name;
      if (selectedValue === opt.id) option.selected = true;
      materialSelect.appendChild(option);
    });
    left.appendChild(materialSelect);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'x';
    removeBtn.title = `Remove ${kind}`;
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queueFocusRestore();
      config.onRemove();
    });

    header.appendChild(left);
    header.appendChild(removeBtn);

    const sizeRow = document.createElement('div');
    sizeRow.style.display = 'flex';
    sizeRow.style.gap = '0.5rem';
    sizeRow.style.alignItems = 'center';
    sizeRow.style.flexWrap = 'wrap';

    const widthInput = document.createElement('input');
    widthInput.dataset.focusKey = `${focusBaseKey}:width`;
    widthInput.type = 'number';
    widthInput.placeholder = 'Width (mm)';
    widthInput.step = '10';
    widthInput.min = '100';
    widthInput.max = '4000';

    const heightInput = document.createElement('input');
    heightInput.dataset.focusKey = `${focusBaseKey}:height`;
    heightInput.type = 'number';
    heightInput.placeholder = 'Height (mm)';
    heightInput.step = '10';
    heightInput.min = '100';
    heightInput.max = '4000';

    const existingArea = typeof opening.area === 'number' ? opening.area : 1;
    const fallbackDim = Math.round(Math.sqrt(existingArea) * 1000);
    widthInput.value = opening.width || fallbackDim;
    heightInput.value = opening.height || fallbackDim;

    const areaDisplay = document.createElement('span');
    areaDisplay.className = 'area-display';

    const leakageInput = document.createElement('input');
    leakageInput.dataset.focusKey = `${focusBaseKey}:leakage`;
    configureDecimalInput(leakageInput, 'Leakage m3/h/m2');

    const positionInput = document.createElement('input');
    positionInput.dataset.focusKey = `${focusBaseKey}:position`;
    positionInput.type = 'number';
    positionInput.placeholder = 'Position %';
    positionInput.step = '1';
    positionInput.min = '0';
    positionInput.max = '100';

    const updateOpening = (notify = true) => {
      const wmm = parseFloat(widthInput.value);
      const hmm = parseFloat(heightInput.value);
      if (!isFinite(wmm) || !isFinite(hmm) || wmm <= 0 || hmm <= 0) return;

      const area = (wmm / 1000) * (hmm / 1000);
      opening.width = Math.round(wmm);
      opening.height = Math.round(hmm);
      opening.area = Number(area.toFixed(3));
      opening.length_m = Number((wmm / 1000).toFixed(3));
      const leakValue = parseDecimalValue(leakageInput.value);
      if (Number.isFinite(leakValue) && leakValue >= 0) {
        opening.air_leakage_m3_h_m2 = Number(leakValue.toFixed(3));
      }
      areaDisplay.textContent = `Area: ${opening.area}m²`;
      if (notify) {
        queueFocusRestore();
        onDataChanged();
      }
    };

    if (kind === 'window') {
      materialSelect.addEventListener('change', () => {
        opening.glazing_id = materialSelect.value;
        const selected = options.find(opt => opt.id === materialSelect.value);
        if (selected && typeof selected.air_leakage_m3_h_m2 === 'number') {
          opening.air_leakage_m3_h_m2 = Number(selected.air_leakage_m3_h_m2.toFixed(3));
          leakageInput.value = String(opening.air_leakage_m3_h_m2);
        }
        if (selected && typeof selected.trickle_vent_flow_m3_h === 'number' && !opening.has_trickle_vent) {
          opening.trickle_vent_flow_m3_h = Number(selected.trickle_vent_flow_m3_h.toFixed(2));
        }
        queueFocusRestore();
        onDataChanged();
      });
    } else {
      materialSelect.addEventListener('change', () => {
        opening.material_id = materialSelect.value;
        const selected = options.find(opt => opt.id === materialSelect.value);
        if (selected && typeof selected.air_leakage_m3_h_m2 === 'number') {
          opening.air_leakage_m3_h_m2 = Number(selected.air_leakage_m3_h_m2.toFixed(3));
          leakageInput.value = String(opening.air_leakage_m3_h_m2);
        }
        queueFocusRestore();
        onDataChanged();
      });
    }

    widthInput.addEventListener('input', updateOpening);
    heightInput.addEventListener('input', updateOpening);

    const lengthFromWidth = Number((parseFloat(widthInput.value || '0') / 1000).toFixed(3));
    const storedLength = typeof opening.length_m === 'number' && isFinite(opening.length_m) && opening.length_m > 0
      ? opening.length_m
      : (lengthFromWidth > 0 ? lengthFromWidth : 1);
    opening.length_m = Number(storedLength.toFixed(3));

    const storedPositionRatio = typeof opening.position_ratio === 'number' && isFinite(opening.position_ratio)
      ? Math.max(0, Math.min(1, opening.position_ratio))
      : 0.5;
    opening.position_ratio = storedPositionRatio;
    positionInput.value = String(Math.round(storedPositionRatio * 100));

    positionInput.addEventListener('input', () => {
      const pv = parseFloat(positionInput.value);
      if (!isFinite(pv)) return;
      opening.position_ratio = Number((Math.max(0, Math.min(100, pv)) / 100).toFixed(3));
      queueFocusRestore();
      onDataChanged();
    });

    updateOpening(false);

    const selectedOption = options.find(opt => opt.id === selectedValue) || null;
    const defaultLeakage = (selectedOption && typeof selectedOption.air_leakage_m3_h_m2 === 'number')
      ? selectedOption.air_leakage_m3_h_m2
      : 0;
    const openingLeakage = (typeof opening.air_leakage_m3_h_m2 === 'number' && opening.air_leakage_m3_h_m2 >= 0)
      ? opening.air_leakage_m3_h_m2
      : defaultLeakage;
    opening.air_leakage_m3_h_m2 = Number(openingLeakage.toFixed(3));
    leakageInput.value = formatEditableDecimal(opening.air_leakage_m3_h_m2, 3);

    leakageInput.addEventListener('input', () => {
      const leak = parseDecimalValue(leakageInput.value);
      if (!Number.isFinite(leak) || leak < 0) return;
      opening.air_leakage_m3_h_m2 = Number(leak.toFixed(3));
      queueFocusRestore();
      onDataChanged();
    });

    sizeRow.appendChild(document.createTextNode('W:'));
    sizeRow.appendChild(widthInput);
    sizeRow.appendChild(document.createTextNode('H:'));
    sizeRow.appendChild(heightInput);
    sizeRow.appendChild(areaDisplay);
    sizeRow.appendChild(document.createTextNode('Leakage:'));
    sizeRow.appendChild(leakageInput);

    if (kind === 'window') {
      const ventRow = document.createElement('div');
      ventRow.style.display = 'flex';
      ventRow.style.gap = '0.5rem';
      ventRow.style.alignItems = 'center';
      ventRow.style.flexWrap = 'wrap';

      const ventCheckbox = document.createElement('input');
      ventCheckbox.type = 'checkbox';
      ventCheckbox.dataset.focusKey = `${focusBaseKey}:trickleVentEnabled`;

      const defaultVentFlow = (selectedOption && typeof selectedOption.trickle_vent_flow_m3_h === 'number')
        ? selectedOption.trickle_vent_flow_m3_h
        : 0;
      const ventFlowInput = document.createElement('input');
      configureDecimalInput(ventFlowInput, 'Vent flow m3/h');
      ventFlowInput.dataset.focusKey = `${focusBaseKey}:trickleVentFlow`;

      opening.has_trickle_vent = opening.has_trickle_vent === true;
      opening.trickle_vent_flow_m3_h = Number(
        ((typeof opening.trickle_vent_flow_m3_h === 'number' && opening.trickle_vent_flow_m3_h >= 0)
          ? opening.trickle_vent_flow_m3_h
          : defaultVentFlow).toFixed(2)
      );
      ventCheckbox.checked = opening.has_trickle_vent;
      ventFlowInput.value = formatEditableDecimal(opening.trickle_vent_flow_m3_h, 2);
      ventFlowInput.disabled = !opening.has_trickle_vent;

      ventCheckbox.addEventListener('change', () => {
        opening.has_trickle_vent = ventCheckbox.checked;
        if (opening.has_trickle_vent && (!isFinite(Number(opening.trickle_vent_flow_m3_h)) || opening.trickle_vent_flow_m3_h < 0)) {
          opening.trickle_vent_flow_m3_h = Number(defaultVentFlow.toFixed(2));
          ventFlowInput.value = String(opening.trickle_vent_flow_m3_h);
        }
        ventFlowInput.disabled = !opening.has_trickle_vent;
        queueFocusRestore();
        onDataChanged();
      });

      ventFlowInput.addEventListener('input', () => {
        const value = parseDecimalValue(ventFlowInput.value);
        if (!isFinite(value) || value < 0) return;
        opening.trickle_vent_flow_m3_h = Number(value.toFixed(2));
        queueFocusRestore();
        onDataChanged();
      });

      const ventLabel = document.createElement('label');
      ventLabel.style.display = 'flex';
      ventLabel.style.gap = '0.35rem';
      ventLabel.style.alignItems = 'center';
      ventLabel.appendChild(ventCheckbox);
      ventLabel.appendChild(document.createTextNode('Has trickle vent'));

      ventRow.appendChild(ventLabel);
      ventRow.appendChild(ventFlowInput);
      form.appendChild(ventRow);
    }

    const placementRow = document.createElement('div');
    placementRow.style.display = 'flex';
    placementRow.style.gap = '0.5rem';
    placementRow.style.alignItems = 'center';
    placementRow.style.flexWrap = 'wrap';
    placementRow.appendChild(document.createTextNode('Position:'));
    placementRow.appendChild(positionInput);
    placementRow.appendChild(document.createTextNode('%'));

    if (kind === 'door') {
      const hingeSelect = document.createElement('select');
      hingeSelect.dataset.focusKey = `${focusBaseKey}:hingeSide`;
      const leftOpt = document.createElement('option');
      leftOpt.value = 'left';
      leftOpt.textContent = 'Left hinge';
      const rightOpt = document.createElement('option');
      rightOpt.value = 'right';
      rightOpt.textContent = 'Right hinge';
      hingeSelect.appendChild(leftOpt);
      hingeSelect.appendChild(rightOpt);

      const currentHinge = String(opening.hinge_side || '').toLowerCase() === 'right' ? 'right' : 'left';
      opening.hinge_side = currentHinge;
      hingeSelect.value = currentHinge;

      hingeSelect.addEventListener('change', () => {
        opening.hinge_side = hingeSelect.value === 'right' ? 'right' : 'left';
        queueFocusRestore();
        onDataChanged();
      });

      placementRow.appendChild(document.createTextNode('Hinge:'));
      placementRow.appendChild(hingeSelect);
    }

    form.appendChild(header);
    form.appendChild(sizeRow);
    form.appendChild(placementRow);
    wrap.appendChild(form);
    return wrap;
  }

  function getWindowOptions() {
    const openings = getOpeningsData ? getOpeningsData() : null;
    if (openings && Array.isArray(openings.windows) && openings.windows.length > 0) {
      return openings.windows.map(w => ({
        id: w.id,
        name: w.name || w.id,
        label: formatOpeningOptionLabel(w.name || w.id, w.u_value),
        air_leakage_m3_h_m2: w.air_leakage_m3_h_m2,
        has_trickle_vent: w.has_trickle_vent,
        trickle_vent_flow_m3_h: w.trickle_vent_flow_m3_h
      }));
    }

    const materialsData = getMaterialsData ? getMaterialsData() : null;
    const materials = materialsData && Array.isArray(materialsData.materials) ? materialsData.materials : [];
    return materials
      .filter(m => String(m.id || '').startsWith('window_'))
      .map(m => ({ id: m.id, name: m.name || m.id }));
  }

  function getDoorOptions() {
    const openings = getOpeningsData ? getOpeningsData() : null;
    if (openings && Array.isArray(openings.doors) && openings.doors.length > 0) {
      return openings.doors.map(d => ({
        id: d.id,
        name: d.name || d.id,
        label: formatOpeningOptionLabel(d.name || d.id, d.u_value),
        air_leakage_m3_h_m2: d.air_leakage_m3_h_m2
      }));
    }

    const materialsData = getMaterialsData ? getMaterialsData() : null;
    const materials = materialsData && Array.isArray(materialsData.materials) ? materialsData.materials : [];
    return materials
      .filter(m => !String(m.id || '').startsWith('window_'))
      .filter(m => typeof m.u_value === 'number' || typeof m.typical_u_value_w_m2k === 'number' || typeof m.thermal_conductivity === 'number')
      .slice(0, 20)
      .map(m => ({ id: m.id, name: m.name || m.id, label: m.name || m.id }));
  }

  function formatOpeningOptionLabel(name, uValue) {
    if (typeof uValue !== 'number' || !isFinite(uValue) || uValue <= 0) return name;
    return `${name} [${uValue} ${getOpeningUUnits()}]`;
  }

  function formatOpeningUDisplay(kind, openingId) {
    const openings = getOpeningsData ? getOpeningsData() : null;
    if (!openings || !openingId) return null;
    const list = kind === 'window' ? openings.windows : openings.doors;
    if (!Array.isArray(list)) return null;
    const match = list.find(item => item.id === openingId);
    if (!match || typeof match.u_value !== 'number' || !isFinite(match.u_value) || match.u_value <= 0) return null;
    return `${match.u_value} ${getOpeningUUnits()}`;
  }

  function getOpeningUUnits() {
    const openings = getOpeningsData ? getOpeningsData() : null;
    if (openings && openings.units && openings.units.u_value) return openings.units.u_value;
    return 'W/m²K';
  }

  function getBuildUpMaterialOptions() {
    const materialsData = getMaterialsData ? getMaterialsData() : null;
    const materials = materialsData && Array.isArray(materialsData.materials) ? materialsData.materials : [];
    const kUnits = materialsData && materialsData.units && materialsData.units.thermal_conductivity
      ? materialsData.units.thermal_conductivity
      : 'W/mK';
    return materials
      .filter(m => {
        const id = String(m.id || '');
        if (id.startsWith('window_') || id.startsWith('door_')) return false;
        return typeof m.thermal_conductivity === 'number' || typeof m.u_value === 'number' || typeof m.typical_u_value_w_m2k === 'number';
      })
      .map(m => {
        const name = m.name || m.id;
        const kLabel = typeof m.thermal_conductivity === 'number' ? `${m.thermal_conductivity} ${kUnits}` : null;
        return {
          id: m.id,
          name,
          label: kLabel ? `${name} [${kLabel}]` : name
        };
      });
  }

  function getBuildUpMaterialLookup() {
    const materialsData = getMaterialsData ? getMaterialsData() : null;
    const materials = materialsData && Array.isArray(materialsData.materials) ? materialsData.materials : [];
    return new Map(materials.map(m => [m.id, m]));
  }

  function formatLayerRDisplay(layer, materialLookup) {
    const r = computeLayerRValue(layer, materialLookup);
    if (typeof r !== 'number' || !isFinite(r) || r <= 0) return null;
    return r.toFixed(3);
  }

  function formatElementRDisplay(element) {
    const materialLookup = getBuildUpMaterialLookup();
    let buildUp = Array.isArray(element.build_up) ? element.build_up : [];

    if (buildUp.length === 0 && element && element.build_up_template_id) {
      const demo = getDemo ? getDemo() : null;
      const templates = demo && demo.meta && demo.meta.build_up_templates
        ? demo.meta.build_up_templates
        : null;
      const template = templates ? templates[element.build_up_template_id] : null;
      if (template && Array.isArray(template.build_up)) {
        buildUp = template.build_up;
      }
    }

    if (buildUp.length === 0) return null;

    let totalR = 0;
    for (const layer of buildUp) {
      const layerR = computeLayerRValue(layer, materialLookup);
      if (typeof layerR !== 'number' || !isFinite(layerR) || layerR <= 0) return null;
      totalR += layerR;
    }

    return totalR > 0 ? totalR.toFixed(3) : null;
  }

  function computeLayerRValue(layer, materialLookup) {
    if (!layer) return null;
    const thickness = typeof layer.thickness === 'number' ? layer.thickness : null;

    if (layer.type === 'composite') {
      if (!thickness || thickness <= 0 || !Array.isArray(layer.paths) || layer.paths.length === 0) return null;
      let totalFraction = 0;
      layer.paths.forEach(path => {
        if (typeof path.fraction === 'number' && path.fraction > 0) totalFraction += path.fraction;
      });
      if (totalFraction <= 0) totalFraction = layer.paths.length;

      let uEq = 0;
      for (const path of layer.paths) {
        const mat = materialLookup.get(path.material_id);
        if (!mat || typeof mat.thermal_conductivity !== 'number' || mat.thermal_conductivity <= 0) return null;
        const fracRaw = typeof path.fraction === 'number' && path.fraction > 0 ? path.fraction : 1;
        const frac = fracRaw / totalFraction;
        const rPath = thickness / mat.thermal_conductivity;
        if (!isFinite(rPath) || rPath <= 0) return null;
        uEq += frac * (1 / rPath);
      }
      return uEq > 0 ? 1 / uEq : null;
    }

    const mat = materialLookup.get(layer.material_id);
    if (!mat) return null;

    if (typeof mat.u_value === 'number' && (!thickness || thickness <= 0)) {
      return 1 / mat.u_value;
    }

    if (typeof mat.typical_u_value_w_m2k === 'number' && (!thickness || thickness <= 0)) {
      return 1 / mat.typical_u_value_w_m2k;
    }

    if (typeof mat.thermal_conductivity === 'number' && mat.thermal_conductivity > 0 && thickness && thickness > 0) {
      return thickness / mat.thermal_conductivity;
    }

    return null;
  }

  function removeRadiator(zoneId, radiatorIndex) {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.zones)) return;
    const zone = demo.zones.find(z => z.id === zoneId);
    if (!zone || !Array.isArray(zone.radiators) || !zone.radiators[radiatorIndex]) return;

    zone.radiators.splice(radiatorIndex, 1);
    populateRoomEditor(zoneId);
    onDataChanged();
  }

  function refreshFabricTargetOptions() {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.elements) || !fabricTargetSelect) return;

    const zoneId = selectedZoneId;
    const selectedType = fabricTypeSelect ? fabricTypeSelect.value : 'wall';
    fabricTargetSelect.innerHTML = '';

    const addNewOption = document.createElement('option');
    addNewOption.value = '__new__';
    addNewOption.textContent = `Add New ${selectedType}`;
    fabricTargetSelect.appendChild(addNewOption);

    if (!zoneId) return;

    const candidates = demo.elements.filter(element => {
      const typeMatches = String(element.type || '').toLowerCase() === String(selectedType || '').toLowerCase();
      const alreadyAttached = Array.isArray(element.nodes) && element.nodes.includes(zoneId);
      return typeMatches && !alreadyAttached;
    });

    candidates.forEach(element => {
      const option = document.createElement('option');
      option.value = element.id;
      option.textContent = `${element.name || element.id} (${element.id})`;
      fabricTargetSelect.appendChild(option);
    });
  }

  function attachExistingFabric(zoneId, elementId) {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.elements)) return;

    const element = demo.elements.find(item => item.id === elementId);
    if (!element) {
      alert('No matching fabric element found.');
      return;
    }

    element.nodes = normalizeElementNodesForAttachment(demo, element, zoneId);
    onDataChanged();
    refreshFabricTargetOptions();
    refreshSelectedZone();
  }

  function createNewFabric(zoneId, type) {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.elements) || !Array.isArray(demo.zones)) return;
    const normalizedType = String(type || 'wall').trim().toLowerCase();
    const id = generateUniqueFabricId(demo);
    const { x, y } = getDefaultDimensionsForType(normalizedType);
    const otherNode = getDefaultOtherNodeForType(normalizedType);
    const zone = demo.zones.find(z => z.id === zoneId);
    const zoneName = zone ? (zone.name || zone.id) : zoneId;
    const typeLabel = normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1);
    const newElement = {
      id,
      type: normalizedType,
      nodes: [zoneId, otherNode],
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
      name: `${zoneName} - ${typeLabel}`,
      build_up: getDefaultBuildUpForType(normalizedType)
    };

    demo.elements.push(newElement);
    onDataChanged();
    refreshFabricTargetOptions();
    refreshSelectedZone();
  }

  function generateUniqueFabricId(demo) {
    const existingIds = new Set((demo.elements || []).map(element => element.id));
    let candidate;
    do {
      // Generate random hash: id_XXXXXXXXXX (12 hex chars after id_)
      candidate = 'id_' + Math.random().toString(16).substring(2, 14);
    } while (existingIds.has(candidate));
    return candidate;
  }

  function generateUniqueId() {
    // Generate random hash: id_XXXXXXXXXX (12 hex chars after id_)
    return 'id_' + Math.random().toString(16).substring(2, 14);
  }

  function getDefaultDimensionsForType(type) {
    if (type === 'wall') return { x: 3, y: 2.4 };
    if (type === 'floor') return { x: 4, y: 3 };
    if (type === 'roof') return { x: 5, y: 4 };
    if (type === 'ceiling' || type === 'floor_ceiling') return { x: 4, y: 3 };
    return { x: 3, y: 2.4 };
  }

  function getDefaultOtherNodeForType(type) {
    if (type === 'wall' || type === 'roof') return 'outside';
    if (type === 'floor') return 'ground';
    if (type === 'ceiling') return 'loft';
    if (type === 'floor_ceiling') return 'loft';
    return 'outside';
  }

  function getDefaultBuildUpForType(type) {
    if (type === 'wall') {
      return [
        { material_id: 'plasterboard', thickness: 0.0125 },
        {
          type: 'composite',
          thickness: 0.09,
          paths: [
            { material_id: 'stud_wood', fraction: 0.063 },
            { material_id: 'pir', fraction: 0.937 }
          ]
        },
        { material_id: 'blockwork', thickness: 0.1 }
      ];
    }

    if (type === 'floor') {
      return [
        { material_id: 'plywood', thickness: 0.018 },
        {
          type: 'composite',
          thickness: 0.15,
          paths: [
            { material_id: 'joist_wood', fraction: 0.095 },
            { material_id: 'rockwool', fraction: 0.905 }
          ]
        }
      ];
    }

    if (type === 'roof' || type === 'ceiling' || type === 'floor_ceiling') {
      return [
        { material_id: 'plasterboard', thickness: 0.0125 },
        { material_id: 'glass_wool', thickness: 0.2 }
      ];
    }

    return [{ material_id: 'plasterboard', thickness: 0.0125 }];
  }

  function refreshSelectedZone() {
    if (selectedZoneId) {
      syncSelectedZoneVisualState();
      populateRoomEditor(selectedZoneId);
    }
  }

  function populateTemplatesPanel() {
    if (!templatesList) return;
    templatesList.innerHTML = '';

    const demo = getDemo();
    const templates = (demo && demo.meta && demo.meta.build_up_templates) || {};
    const templateIds = Object.keys(templates).sort();

    if (templateIds.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '1rem';
      empty.textContent = 'No build-up templates yet. Create one from the Fabric section when editing a room.';
      templatesList.appendChild(empty);
      return;
    }

    templateIds.forEach(tplId => {
      const tpl = templates[tplId];
      const card = document.createElement('details');
      card.className = 'wall-subsection';
      card.style.marginBottom = '0.5rem';

      const summary = document.createElement('summary');
      summary.textContent = `${tpl.name || tplId} (${tpl.usage_count || 0} uses)`;
      card.appendChild(summary);

      const content = document.createElement('div');
      content.style.padding = '0.5rem';

      // Show layers
      const layersDiv = document.createElement('div');
      layersDiv.style.marginBottom = '0.5rem';
      const materialLookup = getBuildUpMaterialLookup();

      if (Array.isArray(tpl.build_up) && tpl.build_up.length > 0) {
        tpl.build_up.forEach((layer, i) => {
          layersDiv.appendChild(createBuildUpLayerDisplay({
            layer,
            layerIndex: i,
            materialLookup,
            readOnly: true
          }));
        });
      }
      content.appendChild(layersDiv);

      // Action buttons
      const actionDiv = document.createElement('div');
      actionDiv.style.display = 'flex';
      actionDiv.style.gap = '0.5rem';
      actionDiv.style.flexWrap = 'wrap';
      actionDiv.style.borderTop = '1px solid #555';
      actionDiv.style.paddingTop = '0.5rem';

      const renameBtn = document.createElement('button');
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => {
        const newName = prompt('Enter new template name:', tpl.name);
        if (newName && newName.trim()) {
          tpl.name = newName.trim();
          onDataChanged();
          populateTemplatesPanel();
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.color = '#f44';
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Delete template "${tpl.name || tplId}"? This won't affect elements already using it.`)) {
          delete templates[tplId];
          onDataChanged();
          populateTemplatesPanel();
        }
      });

      actionDiv.appendChild(renameBtn);
      actionDiv.appendChild(deleteBtn);
      content.appendChild(actionDiv);

      card.appendChild(content);
      templatesList.appendChild(card);
    });
  }

  return {
    refreshSelectedZone,
    focusZone,
    focusElement,
    focusOpening,
    focusRadiator
  };
}
