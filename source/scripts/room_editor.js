// Room editor UI module: tabs, room selection, radiator editing, and fabric rendering.

export function initRoomEditor(opts) {
  const getDemo = opts.getDemo;
  const getRadiatorsData = opts.getRadiatorsData;
  const getMaterialsData = opts.getMaterialsData;
  const getOpeningsData = opts.getOpeningsData;
  const onDataChanged = opts.onDataChanged;
  const onAddRoom = opts.onAddRoom;

  const jsonTab = document.getElementById('jsonTab');
  const editorTab = document.getElementById('editorTab');
  const jsonPanel = document.getElementById('jsonPanel');
  const roomEditorPanel = document.getElementById('roomEditorPanel');
  const toggleSidebar = document.getElementById('toggleSidebar');
  const contentLayout = document.querySelector('.content-layout');

  const roomSelector = document.getElementById('roomSelector');
  const roomEditor = document.getElementById('roomEditor');
  const selectedRoomName = document.getElementById('selectedRoomName');
  const radiatorsList = document.getElementById('radiatorsList');
  const fabricList = document.getElementById('fabricList');
  const addRadiatorBtn = document.getElementById('addRadiatorBtn');
  const addRoomBtn = document.getElementById('addRoomBtn');

  let selectedZoneId = null;
  let pendingFocusState = null;

  if (jsonTab && editorTab && jsonPanel && roomEditorPanel) {
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
  }

  if (toggleSidebar && contentLayout) {
    toggleSidebar.addEventListener('click', () => {
      contentLayout.classList.toggle('sidebar-hidden');
      toggleSidebar.setAttribute(
        'title',
        contentLayout.classList.contains('sidebar-hidden') ? 'Show panel' : 'Hide panel'
      );
    });
  }

  document.addEventListener('click', (e) => {
    const zoneCell = e.target.closest('.thermal-zone-cell');
    if (!zoneCell) return;
    const zoneId = zoneCell.getAttribute('data-zone-id');
    if (zoneId) {
      selectZone(zoneId);
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

      zone.radiators.push({
        radiator_id: 'type_11',
        surface_area: 1.0,
        width: 800,
        height: 500
      });

      populateRoomEditor(selectedZoneId);
      onDataChanged();
    });
  }

  if (addRoomBtn) {
    addRoomBtn.addEventListener('click', () => {
      if (typeof onAddRoom === 'function') onAddRoom();
    });
  }

  function selectZone(zoneId) {
    selectedZoneId = zoneId;

    document.querySelectorAll('.thermal-zone-cell').forEach(cell => {
      cell.classList.remove('selected');
    });

    const selectedCell = document.querySelector(`.thermal-zone-cell[data-zone-id="${zoneId}"]`);
    if (selectedCell) selectedCell.classList.add('selected');

    if (selectedRoomName) selectedRoomName.textContent = `Selected Room: ${zoneId}`;
    if (roomSelector) roomSelector.style.display = 'none';
    if (roomEditor) roomEditor.style.display = 'block';

    populateRoomEditor(zoneId);
  }

  function populateRoomEditor(zoneId) {
    const demo = getDemo();
    const radiatorsData = getRadiatorsData();
    if (!demo || !Array.isArray(demo.zones) || !radiatorsList || !fabricList) return;

    const zoneKey = String(zoneId || '').trim();
    const zone = demo.zones.find(z => String(z.id || '').trim() === zoneKey);
    if (!zone) return;

    radiatorsList.innerHTML = '';

    if (Array.isArray(zone.radiators)) {
      zone.radiators.forEach((radSpec, index) => {
        const radFocusBaseKey = `zone:${zoneKey}|radiator:${index}`;
        const item = document.createElement('div');
        item.className = 'radiator-item';

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

    const expandState = captureExpandState(fabricList);
    populateFabricSection(demo, zoneKey, fabricList, expandState);
    restoreFocusState();
  }

  function captureCurrentFocusState() {
    const active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.focusKey) return null;

    const state = {
      key: active.dataset.focusKey,
      tagName: active.tagName,
      selectionStart: null,
      selectionEnd: null
    };

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
    const xText = x !== null ? `${x} m` : 'Unknown';
    const yText = y !== null ? `${y} m` : 'Unknown';

    const otherNodes = (Array.isArray(element.nodes) ? element.nodes : [])
      .filter(node => String(node || '').trim() !== zoneKey);

    const details = document.createElement('details');
    details.className = 'wall-card';
    const cardKey = `type:${elementType}|element:${elementId}`;
    restoreOpenState(details, cardKey, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = `${elementName}${element.orientation ? ` (${element.orientation})` : ''}`;
    details.appendChild(summary);

    const meta = document.createElement('div');
    meta.className = 'wall-meta';
    meta.innerHTML = `
      <p><strong>Name:</strong> ${elementName}</p>
      <p><strong>${labels.xLabel}:</strong> ${xText}</p>
      <p><strong>${labels.yLabel}:</strong> ${yText}</p>
      <p><strong>Area:</strong> ${area !== null ? `${area} m²` : 'Unknown'}</p>
      <p><strong>Other connected rooms/nodes:</strong> ${otherNodes.length ? otherNodes.join(', ') : 'None'}</p>
    `;
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

  function createBuildUpSection(element, parentKey, expandState) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';
    restoreOpenState(section, `${parentKey}|sub:build_up`, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = 'Build-up';
    section.appendChild(summary);

    const list = document.createElement('ul');
    const buildUp = Array.isArray(element.build_up) ? element.build_up : [];

    if (buildUp.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No build-up data';
      list.appendChild(li);
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
        list.appendChild(li);
      });
    }

    section.appendChild(list);
    return section;
  }

  function createWindowsSection(element, parentKey, expandState) {
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
      const firstOption = options[0] ? options[0].id : 'window_double_modern';
      element.windows.push({
        id: `window_${element.windows.length + 1}`,
        glazing_id: firstOption,
        width: 1000,
        height: 1200,
        area: 1.2
      });
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
      const firstOption = options[0] ? options[0].id : 'door_wood_solid';
      element.doors.push({
        id: `door_${element.doors.length + 1}`,
        type: 'external_door',
        material_id: firstOption,
        width: 900,
        height: 2000,
        area: 1.8
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

    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '0.5rem';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const left = document.createElement('div');
    left.textContent = `${opening.id || `${kind}_${index + 1}`} - `;

    const materialSelect = document.createElement('select');
    materialSelect.dataset.focusKey = `${focusBaseKey}:material`;
    const selectedValue = kind === 'window' ? opening.glazing_id : opening.material_id;
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
    removeBtn.addEventListener('click', config.onRemove);

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

    const updateOpening = (notify = true) => {
      const wmm = parseFloat(widthInput.value);
      const hmm = parseFloat(heightInput.value);
      if (!isFinite(wmm) || !isFinite(hmm) || wmm <= 0 || hmm <= 0) return;

      const area = (wmm / 1000) * (hmm / 1000);
      opening.width = Math.round(wmm);
      opening.height = Math.round(hmm);
      opening.area = Number(area.toFixed(3));
      areaDisplay.textContent = `Area: ${opening.area}m²`;
      if (notify) {
        queueFocusRestore();
        onDataChanged();
      }
    };

    if (kind === 'window') {
      materialSelect.addEventListener('change', () => {
        opening.glazing_id = materialSelect.value;
        queueFocusRestore();
        onDataChanged();
      });
    } else {
      materialSelect.addEventListener('change', () => {
        opening.material_id = materialSelect.value;
        queueFocusRestore();
        onDataChanged();
      });
    }

    widthInput.addEventListener('input', updateOpening);
    heightInput.addEventListener('input', updateOpening);

    updateOpening(false);

    sizeRow.appendChild(document.createTextNode('W:'));
    sizeRow.appendChild(widthInput);
    sizeRow.appendChild(document.createTextNode('H:'));
    sizeRow.appendChild(heightInput);
    sizeRow.appendChild(areaDisplay);

    form.appendChild(header);
    form.appendChild(sizeRow);
    wrap.appendChild(form);
    return wrap;
  }

  function getWindowOptions() {
    const openings = getOpeningsData ? getOpeningsData() : null;
    if (openings && Array.isArray(openings.windows) && openings.windows.length > 0) {
      return openings.windows.map(w => ({ id: w.id, name: w.name || w.id }));
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
      return openings.doors.map(d => ({ id: d.id, name: d.name || d.id }));
    }

    const materialsData = getMaterialsData ? getMaterialsData() : null;
    const materials = materialsData && Array.isArray(materialsData.materials) ? materialsData.materials : [];
    return materials
      .filter(m => !String(m.id || '').startsWith('window_'))
      .filter(m => typeof m.u_value === 'number' || typeof m.typical_u_value_w_m2k === 'number' || typeof m.thermal_conductivity === 'number')
      .slice(0, 20)
      .map(m => ({ id: m.id, name: m.name || m.id }));
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

  function refreshSelectedZone() {
    if (selectedZoneId) {
      populateRoomEditor(selectedZoneId);
    }
  }

  return {
    refreshSelectedZone
  };
}
