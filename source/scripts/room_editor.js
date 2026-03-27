// Room editor UI module: tabs, room selection, radiator editing, and fabric rendering.

export function initRoomEditor(opts) {
  const getDemo = opts.getDemo;
  const getRadiatorsData = opts.getRadiatorsData;
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
        const item = document.createElement('div');
        item.className = 'radiator-item';

        const typeSelect = document.createElement('select');
        const radOptions = (radiatorsData && Array.isArray(radiatorsData.radiators)) ? radiatorsData.radiators : [];
        radOptions.forEach(rad => {
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

    populateFabricSection(demo, zoneKey, fabricList);
  }

  function populateFabricSection(demo, zoneKey, container) {
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
      typeSection.open = type === 'wall';

      const typeSummary = document.createElement('summary');
      typeSummary.textContent = `${type} (${groupedByType.get(type).length})`;
      typeSection.appendChild(typeSummary);

      groupedByType.get(type).forEach(element => {
        typeSection.appendChild(createElementDetailCard(element, zoneKey));
      });

      container.appendChild(typeSection);
    });
  }

  function createElementDetailCard(element, zoneKey) {
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

    const otherNodes = (Array.isArray(element.nodes) ? element.nodes : [])
      .filter(node => String(node || '').trim() !== zoneKey);

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

    details.appendChild(createBuildUpSection(element));
    details.appendChild(createWindowsSection(element));
    details.appendChild(createDoorsSection(element));

    return details;
  }

  function createBuildUpSection(element) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';

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

  function createWindowsSection(element) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';

    const summary = document.createElement('summary');
    summary.textContent = 'Windows';
    section.appendChild(summary);

    const list = document.createElement('ul');
    const windows = Array.isArray(element.windows) ? element.windows : [];

    if (windows.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No windows';
      list.appendChild(li);
    } else {
      windows.forEach((win, i) => {
        const li = document.createElement('li');
        li.textContent = `${win.id || `window_${i + 1}`}: area=${win.area ?? 'n/a'} m², glazing=${win.glazing_id || 'n/a'}`;
        list.appendChild(li);
      });
    }

    section.appendChild(list);
    return section;
  }

  function createDoorsSection(element) {
    const section = document.createElement('details');
    section.className = 'wall-subsection';

    const summary = document.createElement('summary');
    summary.textContent = 'Doors';
    section.appendChild(summary);

    const list = document.createElement('ul');
    const doors = Array.isArray(element.doors) ? element.doors : [];

    if (doors.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No doors';
      list.appendChild(li);
    } else {
      doors.forEach((door, i) => {
        const li = document.createElement('li');
        li.textContent = `${door.id || `door_${i + 1}`}: area=${door.area ?? 'n/a'} m², type=${door.type || 'n/a'}, material=${door.material_id || 'n/a'}`;
        list.appendChild(li);
      });
    }

    section.appendChild(list);
    return section;
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
