// U-value calculator: computes thermal resistance and U-values for building elements

export function findMaterial(materials, id) {
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

export function openingUfromMaterial(mat) {
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

function getElementArea(elem) {
  if (typeof elem.x === 'number' && elem.x > 0 && typeof elem.y === 'number' && elem.y > 0) return elem.x * elem.y;
  return 0;
}

function getMaterialAirLeakagePerM2(mat) {
  if (!mat) return null;
  if (typeof mat.air_leakage_m3_h_m2 === 'number' && mat.air_leakage_m3_h_m2 >= 0) {
    return mat.air_leakage_m3_h_m2;
  }
  return null;
}

export function computeElementU(elem, materials, buildupTemplates) {
  let build_up = elem.build_up || [];

  // Resolve template reference if present
  if (elem.build_up_template_id && buildupTemplates) {
    const template = buildupTemplates[elem.build_up_template_id];
    if (!template || !template.build_up) {
      throw new Error(`Build-up template not found: ${elem.build_up_template_id}`);
    }
    build_up = template.build_up;
  }

  let Rsum = 0;
  const buildUpLeakageRates = [];
  for (const layer of build_up) Rsum += layerR(layer, materials);
  for (const layer of build_up) {
    if (layer && layer.type === 'composite' && Array.isArray(layer.paths)) {
      for (const path of layer.paths) {
        const mat = findMaterial(materials, path.material_id);
        const leakage = getMaterialAirLeakagePerM2(mat);
        if (typeof leakage === 'number') buildUpLeakageRates.push(leakage);
      }
    } else if (layer && layer.material_id) {
      const mat = findMaterial(materials, layer.material_id);
      const leakage = getMaterialAirLeakagePerM2(mat);
      if (typeof leakage === 'number') buildUpLeakageRates.push(leakage);
    }
  }
  const U_fabric = Rsum > 0 ? 1 / Rsum : 0;

  const totalArea = getElementArea(elem);
  if ((!elem.area || elem.area <= 0) && totalArea > 0) {
    elem.area = Number(totalArea.toFixed(3));
  }
  let openingsArea = 0;
  let openingsConductance = 0;
  let openingsAirLeakageFlow = 0;
  if (Array.isArray(elem.windows)) {
    for (const w of elem.windows) {
      const mat = findMaterial(materials, w.glazing_id);
      let Uwin = openingUfromMaterial(mat);
      if (Uwin === null) throw new Error('Window glazing material ' + w.glazing_id + ' has no usable U-value');
      const area = w.area || w.total_area || 0;
      const optionLeakage = getMaterialAirLeakagePerM2(mat);
      const leakagePerM2 = (typeof w.air_leakage_m3_h_m2 === 'number' && w.air_leakage_m3_h_m2 >= 0)
        ? w.air_leakage_m3_h_m2
        : (typeof optionLeakage === 'number' ? optionLeakage : 0);
      const ventFlow = w.has_trickle_vent === true
        ? ((typeof w.trickle_vent_flow_m3_h === 'number' && w.trickle_vent_flow_m3_h >= 0) ? w.trickle_vent_flow_m3_h : 0)
        : 0;
      openingsArea += area;
      openingsConductance += Uwin * area;
      openingsAirLeakageFlow += (leakagePerM2 * area) + ventFlow;
      w.u = Number(Uwin.toFixed(3));
      w.air_leakage_m3_h_m2 = Number(leakagePerM2.toFixed(3));
      if (w.has_trickle_vent === true) {
        w.trickle_vent_flow_m3_h = Number(ventFlow.toFixed(2));
      }
    }
  }
  if (Array.isArray(elem.doors)) {
    for (const d of elem.doors) {
      const mat = findMaterial(materials, d.material_id || d.glazing_id || 'door') || {};
      let Udoor = openingUfromMaterial(mat);
      if (Udoor === null) Udoor = 3.0;
      const area = d.area || 0;
      const optionLeakage = getMaterialAirLeakagePerM2(mat);
      const leakagePerM2 = (typeof d.air_leakage_m3_h_m2 === 'number' && d.air_leakage_m3_h_m2 >= 0)
        ? d.air_leakage_m3_h_m2
        : (typeof optionLeakage === 'number' ? optionLeakage : 0);
      openingsArea += area;
      openingsConductance += Udoor * area;
      openingsAirLeakageFlow += leakagePerM2 * area;
      d.u = Number(Udoor.toFixed(3));
      d.air_leakage_m3_h_m2 = Number(leakagePerM2.toFixed(3));
    }
  }

  const fabricArea = Math.max(0, totalArea - openingsArea);
  const fabricLeakagePerM2 = buildUpLeakageRates.length > 0
    ? Math.min(...buildUpLeakageRates)
    : 0;
  const fabricAirLeakageFlow = fabricLeakagePerM2 * fabricArea;
  const fabricConductance = U_fabric * fabricArea;
  const totalConductance = fabricConductance + openingsConductance;
  const U_overall = totalArea > 0 ? totalConductance / totalArea : 0;

  elem.u_fabric = Number(U_fabric.toFixed(4));
  elem.u_overall = Number(U_overall.toFixed(4));
  elem.thermal_conductance = Number(totalConductance.toFixed(3));
  elem.openings_area = Number(openingsArea.toFixed(3));
  elem.fabric_air_leakage_m3_h_m2 = Number(fabricLeakagePerM2.toFixed(3));
  elem.fabric_air_leakage_flow_m3_h = Number(fabricAirLeakageFlow.toFixed(3));
  elem.openings_air_leakage_flow_m3_h = Number(openingsAirLeakageFlow.toFixed(3));
  elem.air_leakage_flow_m3_h = Number((fabricAirLeakageFlow + openingsAirLeakageFlow).toFixed(3));
  return elem;
}
