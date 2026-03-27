// Heat and radiator calculator: computes room heat loss, radiator output, and heating balance

function findRadiator(radiators, id) {
  if (!id || !Array.isArray(radiators)) return null;
  return radiators.find(r => r.id === id) || null;
}

function calculateRadiatorOutput(radiator, surfaceArea, indoorTemp, flowTemp) {
  if (!radiator || typeof radiator.heat_transfer_coefficient !== 'number') return 0;
  if (typeof surfaceArea !== 'number' || surfaceArea <= 0) return 0;
  const h = radiator.heat_transfer_coefficient;
  const dT = Math.max(0, flowTemp - indoorTemp);
  return h * surfaceArea * dT;
}

function elementArea(el) {
  if (typeof el.x === 'number' && el.x > 0 && typeof el.y === 'number' && el.y > 0) return el.x * el.y;
  return null;
}

export function computeRoomHeatRequirements(demo, radiators, opts) {
  const indoorTemp = (opts && typeof opts.indoorTemp === 'number') ? opts.indoorTemp : 21;
  const externalTemp = (opts && typeof opts.externalTemp === 'number') ? opts.externalTemp : 3;
  const flowTemp = (opts && typeof opts.flowTemp === 'number') ? opts.flowTemp : 55;
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
    const elArea = elementArea(el);
    let elConductance = (typeof el.thermal_conductance === 'number') ? el.thermal_conductance : NaN;
    if (!isFinite(elConductance) && typeof el.u_overall === 'number' && typeof elArea === 'number') {
      elConductance = el.u_overall * elArea;
    }
    if (!isFinite(elConductance) || elConductance <= 0) continue;

    const nonBoundaryNodes = nodes.filter(n => !boundaryIds.has(n));
    const boundaryNodes = nodes.filter(n => boundaryIds.has(n));

    if (boundaryNodes.length >= 1 && nonBoundaryNodes.length === 1) {
      const zoneId = nonBoundaryNodes[0];
      const acc = roomAcc.get(zoneId) || { conductance: 0, area: null, contributions: [] };
      acc.conductance += elConductance;
      if (typeof elArea === 'number') acc.area = (acc.area || 0) + elArea;
      acc.contributions.push({ id: el.id, c: elConductance });
      roomAcc.set(zoneId, acc);
    } else if (boundaryNodes.length >= 1 && nonBoundaryNodes.length > 1) {
      const parts = nonBoundaryNodes.length;
      nonBoundaryNodes.forEach(nz => {
        const acc = roomAcc.get(nz) || { conductance: 0, area: null, contributions: [] };
        acc.conductance += elConductance / parts;
        if (typeof elArea === 'number') acc.area = (acc.area || 0) + elArea / parts;
        acc.contributions.push({ id: el.id, c: elConductance / parts });
        roomAcc.set(nz, acc);
      });
    } else {
      continue;
    }
  }

  const results = [];
  let totalHeat = 0;
  let totalRadiatorOutput = 0;
  for (const [zoneId, acc] of roomAcc.entries()) {
    const heatLossW = acc.conductance * dT;
    const area = acc.area || null;
    const perM2 = area ? heatLossW / area : null;
    totalHeat += heatLossW;

    // Calculate radiator output for this zone
    const zone = zoneMap.get(zoneId);
    let radiatorOutput = 0;
    let totalRadSurfaceArea = 0;
    if (zone && Array.isArray(zone.radiators)) {
      for (const radSpec of zone.radiators) {
        const rad = findRadiator(radiators, radSpec.radiator_id);
        if (rad) {
          const output = calculateRadiatorOutput(rad, radSpec.surface_area, indoorTemp, flowTemp);
          radiatorOutput += output;
          totalRadSurfaceArea += radSpec.surface_area;
        }
      }
    }
    totalRadiatorOutput += radiatorOutput;
    const heatingBalance = radiatorOutput - heatLossW;

    results.push({
      zoneId,
      zoneName: zone && zone.name,
      floorArea: area,
      total_conductance: Number(acc.conductance.toFixed(3)),
      heat_loss: Number(heatLossW.toFixed(1)),
      heat_loss_per_unit_area: perM2 ? Number(perM2.toFixed(1)) : null,
      radiator_surface_area: Number(totalRadSurfaceArea.toFixed(3)),
      radiator_output: Number(radiatorOutput.toFixed(1)),
      heating_balance: Number(heatingBalance.toFixed(1)),
      balance_status: heatingBalance >= 0 ? 'sufficient' : 'insufficient',
      contributing_elements: acc.contributions.map(c => ({ elementId: c.id, conductance: Number(c.c.toFixed(3)) }))
    });
  }

  for (const z of zones) {
    if (z.type === 'boundary') continue;
    if (!roomAcc.has(z.id)) {
      let radiatorOutput = 0;
      let totalRadSurfaceArea = 0;
      if (Array.isArray(z.radiators)) {
        for (const radSpec of z.radiators) {
          const rad = findRadiator(radiators, radSpec.radiator_id);
          if (rad) {
            const output = calculateRadiatorOutput(rad, radSpec.surface_area, indoorTemp, flowTemp);
            radiatorOutput += output;
            totalRadSurfaceArea += radSpec.surface_area;
          }
        }
      }

      results.push({
        zoneId: z.id,
        zoneName: z.name,
        floorArea: null,
        total_conductance: 0,
        heat_loss: 0,
        heat_loss_per_unit_area: null,
        radiator_surface_area: Number(totalRadSurfaceArea.toFixed(3)),
        radiator_output: Number(radiatorOutput.toFixed(1)),
        heating_balance: Number(radiatorOutput.toFixed(1)),
        balance_status: radiatorOutput >= 0 ? 'sufficient' : 'insufficient',
        contributing_elements: []
      });
    }
  }

  return { 
    rooms: results, 
    total_heat_loss: Number(totalHeat.toFixed(1)), 
    total_radiator_output: Number(totalRadiatorOutput.toFixed(1)),
    total_balance: Number((totalRadiatorOutput - totalHeat).toFixed(1)),
    indoorTemp, 
    externalTemp,
    flowTemp
  };
}
