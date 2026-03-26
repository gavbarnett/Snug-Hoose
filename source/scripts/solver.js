// Client-side solver (ES module). Calculates U-values then room wattage; produces downloadable JSON with annotations.

const outEl = document.getElementById('out');
const runBtn = document.getElementById('run');
const dlEl = document.getElementById('download');
const indoorInput = document.getElementById('indoorTemp');
const externalInput = document.getElementById('externalTemp');

async function tryFetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Fetch failed');
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function loadInputs() {
  const ins = await tryFetchJson('./source/resources/insulation.json') || JSON.parse(document.getElementById('insulation-json').textContent);
  const demo = await tryFetchJson('./source/resources/demo_house.json') || JSON.parse(document.getElementById('demo-json').textContent);
  return [ins, demo];
}

function findMaterial(materials, id) {
  if (!id) return null;
  const req = String(id).trim();
  const norm = req.toLowerCase();
  let mat = materials.find(m => m.id === req || m.name === req || m.key === req);
  if (mat) return mat;
  mat = materials.find(m => (m.id && m.id.toLowerCase() === norm) || (m.name && m.name.toLowerCase() === norm));
  if (mat) return mat;
  const variants = [norm, norm.replace(/[\s\-]+/g,'_'), norm.replace(/[_\s]+/g,' '), norm.replace(/_?board$/,''), norm + '_board'];
  for (const v of variants) {
    mat = materials.find(m => (m.id && m.id.toLowerCase() === v) || (m.name && m.name.toLowerCase() === v));
    if (mat) return mat;
  }
  mat = materials.find(m => (m.id && m.id.toLowerCase().includes(norm)) || (m.name && m.name.toLowerCase().includes(norm)));
  if (mat) return mat;
  console.warn(`Material not found for id="${id}". Available ids:`, materials.map(m => m.id || m.name));
  return null;
}

function openingUfromMaterial(mat) {
  if (!mat) return null;
  if (typeof mat.u_value === 'number') return mat.u_value;
  if (typeof mat.typical_u_value_w_m2k === 'number') return mat.typical_u_value_w_m2k;
  if (typeof mat.thermal_conductivity === 'number') {
    const eff = mat.effective_thickness_m || (mat.effective_thickness_mm ? mat.effective_thickness_mm / 1000 : undefined);
    if (typeof eff === 'number' && eff > 0) return mat.thermal_conductivity / eff;
  }
  return null;
}

function layerR(layer, materials) {
  if (!layer) return 0;
  if (layer.type === 'composite') {
    const thickness = layer.thickness;
    if (typeof thickness !== 'number' || thickness <= 0) throw new Error('Composite layer missing thickness');
    const paths = layer.paths || [];
    let totalFrac = paths.reduce((s,p)=> s + (p.fraction||0), 0);
    if (totalFrac <= 0) totalFrac = paths.length || 1;
    let Ueq = 0;
    for (const p of paths) {
      const frac = (p.fraction||0)/totalFrac;
      const mat = findMaterial(materials, p.material_id);
      if (!mat) throw new Error('Material for composite path not found: ' + p.material_id);
      const k = mat.thermal_conductivity;
      if (typeof k !== 'number' || k <= 0) throw new Error('Material ' + p.material_id + ' missing thermal_conductivity');
      const Rpath = thickness / k;
      Ueq += frac * (1 / Rpath);
    }
    return Ueq > 0 ? 1 / Ueq : Infinity;
  } else {
    const matId = layer.material_id;
    const thickness = layer.thickness;
    if (!matId) throw new Error('Layer missing material_id');
    const mat = findMaterial(materials, matId);
    if (!mat) throw new Error('Material not found: ' + matId);
    if ((typeof mat.u_value === 'number' || typeof mat.typical_u_value_w_m2k === 'number') && !thickness) {
      const u = typeof mat.u_value === 'number' ? mat.u_value : mat.typical_u_value_w_m2k;
      return 1 / u;
    }
    const k = mat.thermal_conductivity;
    if (typeof k !== 'number' || k <= 0) throw new Error('Material ' + matId + ' missing numeric thermal_conductivity');
    if (typeof thickness !== 'number' || thickness <= 0) throw new Error('Layer for material ' + matId + ' missing thickness (m)');
    return thickness / k;
  }
}

function computeElementU(elem, materials) {
  const build_up = elem.build_up || [];
  let Rsum = 0;
  for (const layer of build_up) Rsum += layerR(layer, materials);
  const U_fabric = Rsum > 0 ? 1 / Rsum : 0;

  const totalArea = elem.area || 0;
  let openingsArea = 0;
  let openingsConductance = 0;
  if (Array.isArray(elem.windows)) {
    for (const w of elem.windows) {
      const mat = findMaterial(materials, w.glazing_id);
      let Uwin = openingUfromMaterial(mat);
      if (Uwin === null) throw new Error('Window glazing material ' + w.glazing_id + ' has no usable U-value');
      const area = w.area || w.total_area || 0;
      openingsArea += area;
      openingsConductance += Uwin * area;
      w.u = Number(Uwin.toFixed(3));
    }
  }
  if (Array.isArray(elem.doors)) {
    for (const d of elem.doors) {
      const mat = findMaterial(materials, d.material_id || d.glazing_id || 'door') || {};
      let Udoor = openingUfromMaterial(mat);
      if (Udoor === null) Udoor = 3.0;
      const area = d.area || 0;
      openingsArea += area;
      openingsConductance += Udoor * area;
      d.u = Number(Udoor.toFixed(3));
    }
  }

  const fabricArea = Math.max(0, totalArea - openingsArea);
  const fabricConductance = U_fabric * fabricArea;
  const totalConductance = fabricConductance + openingsConductance;
  const U_overall = totalArea > 0 ? totalConductance / totalArea : 0;

  elem.u_fabric = Number(U_fabric.toFixed(4));
  elem.u_overall = Number(U_overall.toFixed(4));
  elem.thermal_conductance = Number(totalConductance.toFixed(3));
  elem.openings_area = Number(openingsArea.toFixed(3));
  return elem;
}

/* Room wattage calculator adapted from TS -> JS */
function computeRoomHeatRequirements(demo, opts) {
  const indoorTemp = (opts && typeof opts.indoorTemp === 'number') ? opts.indoorTemp : 21;
  const externalTemp = (opts && typeof opts.externalTemp === 'number') ? opts.externalTemp : 3;
  const dT = Math.max(0, indoorTemp - externalTemp);

  const zones = (demo.zones || []).slice();
  const elements = (demo.elements || []).slice();

  const boundaryIds = new Set(zones.filter(z => z.type === 'boundary').map(z => z.id));
  if (boundaryIds.size === 0) { ['outside','ground','loft'].forEach(b => boundaryIds.add(b)); }

  const zoneMap = new Map();
  for (const z of zones) zoneMap.set(z.id, z);

  const roomAcc = new Map();

  for (const el of elements) {
    const nodes = el.nodes || [];
    let elConductance = (typeof el.thermal_conductance === 'number') ? el.thermal_conductance : NaN;
    if (!isFinite(elConductance) && typeof el.u_overall === 'number' && typeof el.area === 'number') {
      elConductance = el.u_overall * el.area;
    }
    if (!isFinite(elConductance) || elConductance <= 0) continue;

    const nonBoundaryNodes = nodes.filter(n => !boundaryIds.has(n));
    const boundaryNodes = nodes.filter(n => boundaryIds.has(n));

    if (boundaryNodes.length >= 1 && nonBoundaryNodes.length === 1) {
      const zoneId = nonBoundaryNodes[0];
      const acc = roomAcc.get(zoneId) || { conductance: 0, area: null, contributions: [] };
      acc.conductance += elConductance;
      if (typeof el.area === 'number') acc.area = (acc.area || 0) + el.area;
      acc.contributions.push({ id: el.id, c: elConductance });
      roomAcc.set(zoneId, acc);
    } else if (boundaryNodes.length >= 1 && nonBoundaryNodes.length > 1) {
      const parts = nonBoundaryNodes.length;
      nonBoundaryNodes.forEach(nz => {
        const acc = roomAcc.get(nz) || { conductance: 0, area: null, contributions: [] };
        acc.conductance += elConductance / parts;
        if (typeof el.area === 'number') acc.area = (acc.area || 0) + el.area / parts;
        acc.contributions.push({ id: el.id, c: elConductance / parts });
        roomAcc.set(nz, acc);
      });
    } else {
      continue;
    }
  }

  const results = [];
  let totalHeat = 0;
  for (const [zoneId, acc] of roomAcc.entries()) {
    const heatLossW = acc.conductance * dT;
    const area = acc.area || null;
    const perM2 = area ? heatLossW / area : null;
    totalHeat += heatLossW;
    results.push({
      zoneId,
      zoneName: zoneMap.get(zoneId) && zoneMap.get(zoneId).name,
      floorArea: area,
      total_conductance: Number(acc.conductance.toFixed(3)),
      heat_loss: Number(heatLossW.toFixed(1)),
      heat_loss_per_unit_area: perM2 ? Number(perM2.toFixed(1)) : null,
      contributing_elements: acc.contributions.map(c => ({ elementId: c.id, conductance: Number(c.c.toFixed(3)) }))
    });
  }

  for (const z of zones) {
    if (z.type === 'boundary') continue;
    if (!roomAcc.has(z.id)) {
      results.push({
        zoneId: z.id,
        zoneName: z.name,
        floorArea: null,
        total_conductance_W_per_K: 0,
        heat_loss_W: 0,
        heat_loss_W_per_m2: null,
        contributing_elements: []
      });
    }
  }

  return { rooms: results, total_heat_loss: Number(totalHeat.toFixed(1)), indoorTemp, externalTemp };
}

runBtn.addEventListener('click', async () => {
  outEl.textContent = 'Loading inputs...';
  try {
    const [insRaw, demoRaw] = await loadInputs();
    const materials = insRaw.materials || insRaw;
    const elements = demoRaw.elements || demoRaw.rooms || [];
    if (!Array.isArray(elements)) throw new Error('No elements array found in demo json');

    for (const el of elements) {
      try { computeElementU(el, materials); } catch (err) { el._calc_error = String(err); }
    }

    const indoorTemp = parseFloat(indoorInput.value) || 21;
    const externalTemp = parseFloat(externalInput.value) || 3;

    const heatResults = computeRoomHeatRequirements(demoRaw, { indoorTemp, externalTemp });

    // annotate demo JSON
    demoRaw.meta = demoRaw.meta || {};
    demoRaw.meta.indoorTemp = indoorTemp;
    demoRaw.meta.externalTemp = externalTemp;
    demoRaw.meta.total_heat_loss = heatResults.total_heat_loss;

    // merge room heat results into zones
    for (const zone of demoRaw.zones) {
      const room = heatResults.rooms.find(r => r.zoneId === zone.id);
      if (room) {
        zone.total_conductance = room.total_conductance;
        zone.heat_loss = room.heat_loss;
        zone.heat_loss_per_unit_area = room.heat_loss_per_unit_area;
        zone.contributing_elements = room.contributing_elements;
      }
    }

    const solved = JSON.stringify(demoRaw, null, 2);
    outEl.textContent = solved;

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
});
