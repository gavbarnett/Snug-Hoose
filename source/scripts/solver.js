// Client-side solver (ES module). Runs in browser; reads embedded JSON or fetches files when served.
const outEl = document.getElementById('out');
const runBtn = document.getElementById('run');
const dlEl = document.getElementById('download');

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
  return materials.find(m => m.id === id || m.name === id || m.key === id) || null;
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
    const solved = JSON.stringify(demoRaw, null, 2);
    outEl.textContent = solved;

    const blob = new Blob([solved], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    dlEl.href = url;
    dlEl.style.pointerEvents = 'auto';
    dlEl.style.opacity = '1';
    // revoke after click
    dlEl.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (err) {
    outEl.textContent = 'Solver error: ' + String(err);
    console.error(err);
  }
});
