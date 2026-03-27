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
  const fabricTypeSelect = document.getElementById('fabricTypeSelect');
  const fabricTargetSelect = document.getElementById('fabricTargetSelect');
  const addFabricBtn = document.getElementById('addFabricBtn');
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

    document.querySelectorAll('.thermal-zone-cell').forEach(cell => {
      cell.classList.remove('selected');
    });

    const selectedCell = document.querySelector(`.thermal-zone-cell[data-zone-id="${zoneId}"]`);
    if (selectedCell) selectedCell.classList.add('selected');

    if (selectedRoomName) selectedRoomName.textContent = `Selected Room: ${zoneId}`;
    if (roomSelector) roomSelector.style.display = 'none';
    if (roomEditor) roomEditor.style.display = 'block';

    refreshFabricTargetOptions();
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
    const totalRDisplay = formatElementRDisplay(element);

    const otherNodes = (Array.isArray(element.nodes) ? element.nodes : [])
      .filter(node => String(node || '').trim() !== zoneKey);

    const details = document.createElement('details');
    details.className = 'wall-card';
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
    xInput.type = 'number';
    xInput.step = '0.01';
    xInput.min = '0';
    xInput.value = x !== null ? x : '';
    xInput.placeholder = labels.xLabel;
    xInput.dataset.focusKey = `${cardKey}:x`;

    const yLabel = document.createElement('strong');
    yLabel.textContent = `${labels.yLabel}:`;
    const yInput = document.createElement('input');
    yInput.type = 'number';
    yInput.step = '0.01';
    yInput.min = '0';
    yInput.value = y !== null ? y : '';
    yInput.placeholder = labels.yLabel;
    yInput.dataset.focusKey = `${cardKey}:y`;

    const updateDimensions = () => {
      const xv = parseFloat(xInput.value);
      const yv = parseFloat(yInput.value);
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
    nodeRow.innerHTML = `<strong>Other connected rooms/nodes:</strong> ${otherNodes.length ? otherNodes.join(', ') : 'None'}`;

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

  function createBuildUpSection(element, parentKey, expandState) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';
    restoreOpenState(section, `${parentKey}|sub:build_up`, false, expandState);

    const summary = document.createElement('summary');
    summary.textContent = 'Build-up';
    section.appendChild(summary);

    const list = document.createElement('div');
    const buildUp = Array.isArray(element.build_up) ? element.build_up : [];
    const materialOptions = getBuildUpMaterialOptions();
    const materialLookup = getBuildUpMaterialLookup();

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

    const addRow = document.createElement('div');
    addRow.style.display = 'flex';
    addRow.style.gap = '0.5rem';
    addRow.style.flexWrap = 'wrap';

    const addLayerBtn = document.createElement('button');
    addLayerBtn.textContent = 'Add Layer';
    addLayerBtn.addEventListener('click', () => {
      const firstMaterial = materialOptions[0] ? materialOptions[0].id : 'plasterboard';
      element.build_up.push({ material_id: firstMaterial, thickness: 0.0125 });
      onDataChanged();
      refreshSelectedZone();
    });

    const addCompositeBtn = document.createElement('button');
    addCompositeBtn.textContent = 'Add Composite Layer';
    addCompositeBtn.addEventListener('click', () => {
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

    addRow.appendChild(addLayerBtn);
    addRow.appendChild(addCompositeBtn);

    section.appendChild(list);
    section.appendChild(addRow);
    return section;
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
    removeBtn.addEventListener('click', () => {
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
    thicknessInput.type = 'number';
    thicknessInput.step = '0.001';
    thicknessInput.min = '0';
    thicknessInput.value = typeof layer.thickness === 'number' ? layer.thickness : '';
    thicknessInput.dataset.focusKey = `${focusBaseKey}:thickness`;
    thicknessInput.addEventListener('input', () => {
      const value = parseFloat(thicknessInput.value);
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
      fracInput.type = 'number';
      fracInput.step = '0.001';
      fracInput.min = '0';
      fracInput.max = '1';
      fracInput.value = typeof path.fraction === 'number' ? path.fraction : '';
      fracInput.dataset.focusKey = `${focusBaseKey}:path:${pathIndex}:fraction`;
      fracInput.addEventListener('input', () => {
        const fv = parseFloat(fracInput.value);
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
      removePathBtn.addEventListener('click', () => {
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
      return openings.windows.map(w => ({
        id: w.id,
        name: w.name || w.id,
        label: formatOpeningOptionLabel(w.name || w.id, w.u_value)
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
        label: formatOpeningOptionLabel(d.name || d.id, d.u_value)
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
    const buildUp = Array.isArray(element.build_up) ? element.build_up : [];
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

    if (!Array.isArray(element.nodes)) element.nodes = [];
    if (!element.nodes.includes(zoneId)) element.nodes.push(zoneId);
    onDataChanged();
    refreshFabricTargetOptions();
    refreshSelectedZone();
  }

  function createNewFabric(zoneId, type) {
    const demo = getDemo();
    if (!demo || !Array.isArray(demo.elements) || !Array.isArray(demo.zones)) return;
    const normalizedType = String(type || 'wall').trim().toLowerCase();
    const id = generateUniqueFabricId(demo, `${zoneId}_${normalizedType}`);
    const { x, y } = getDefaultDimensionsForType(normalizedType);
    const otherNode = getDefaultOtherNodeForType(normalizedType);
    const newElement = {
      id,
      type: normalizedType,
      nodes: [zoneId, otherNode],
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
      name: `${zoneId} ${normalizedType}`,
      build_up: getDefaultBuildUpForType(normalizedType)
    };

    demo.elements.push(newElement);
    onDataChanged();
    refreshFabricTargetOptions();
    refreshSelectedZone();
  }

  function generateUniqueFabricId(demo, baseId) {
    const existingIds = new Set((demo.elements || []).map(element => element.id));
    let candidate = `${baseId}_1`;
    let index = 1;
    while (existingIds.has(candidate)) {
      index += 1;
      candidate = `${baseId}_${index}`;
    }
    return candidate;
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
      populateRoomEditor(selectedZoneId);
    }
  }

  return {
    refreshSelectedZone
  };
}
