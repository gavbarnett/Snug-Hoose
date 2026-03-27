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

function calculateRadiatorCoefficient(radiator, surfaceArea) {
  if (!radiator || typeof radiator.heat_transfer_coefficient !== 'number') return 0;
  if (typeof surfaceArea !== 'number' || surfaceArea <= 0) return 0;
  return radiator.heat_transfer_coefficient * surfaceArea;
}

function elementArea(el) {
  if (typeof el.x === 'number' && el.x > 0 && typeof el.y === 'number' && el.y > 0) return el.x * el.y;
  return null;
}

export function computeRoomHeatRequirements(demo, radiators, opts) {
  const globalIndoorTemp = (opts && typeof opts.indoorTemp === 'number') ? opts.indoorTemp : 21;
  const externalTemp = (opts && typeof opts.externalTemp === 'number') ? opts.externalTemp : 3;
  const maxFlowTemp = (opts && typeof opts.flowTemp === 'number') ? opts.flowTemp : 55;

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

  let effectiveFlowTemp = maxFlowTemp;
  let controlZoneId = null;
  let controlZoneName = null;

  // Boiler modulation model: pick the first boiler-control zone and derive required flow temp
  // to just satisfy that zone at setpoint. If no control zone is valid, keep user max flow temp.
  for (const [zoneId, acc] of roomAcc.entries()) {
    const zone = zoneMap.get(zoneId);
    if (!zone || !zone.is_boiler_control || zone.is_unheated === true) continue;

    let radiatorCoefficient = 0;
    if (Array.isArray(zone.radiators)) {
      for (const radSpec of zone.radiators) {
        const rad = findRadiator(radiators, radSpec.radiator_id);
        radiatorCoefficient += calculateRadiatorCoefficient(rad, radSpec.surface_area);
      }
    }

    if (radiatorCoefficient > 0 && acc.conductance > 0) {
      const controlSetpoint = (typeof zone.setpoint_temperature === 'number') ? zone.setpoint_temperature : globalIndoorTemp;
      const controlHeatLoss = acc.conductance * Math.max(0, controlSetpoint - externalTemp);
      const requiredFlowTemp = controlSetpoint + (controlHeatLoss / radiatorCoefficient);
      effectiveFlowTemp = Math.min(maxFlowTemp, Math.max(controlSetpoint, requiredFlowTemp));
      controlZoneId = zoneId;
      controlZoneName = zone.name || zone.id || null;
      break;
    }
  }

  const results = [];
  let totalHeatWithTrv = 0;
  let totalRadiatorOutputWithTrv = 0;
  let totalHeatBaseline = 0;
  let totalRadiatorOutputBaseline = 0;

  for (const [zoneId, acc] of roomAcc.entries()) {
    const zone = zoneMap.get(zoneId);
    const zoneIsHeated = zone ? zone.is_unheated !== true : true;
    const zoneSetpoint = zoneIsHeated
      ? ((zone && typeof zone.setpoint_temperature === 'number') ? zone.setpoint_temperature : globalIndoorTemp)
      : null;
    
    // TRV calculation: use zone's setpoint
    const dTWithTrv = zoneSetpoint === null ? 0 : Math.max(0, zoneSetpoint - externalTemp);
    const heatLossWithTrvW = acc.conductance * dTWithTrv;
    const area = acc.area || null;
    const perM2WithTrv = (zoneSetpoint !== null && area) ? heatLossWithTrvW / area : null;
    totalHeatWithTrv += heatLossWithTrvW;

    // Baseline calculation: all zones at global temp
    const dTBaseline = Math.max(0, globalIndoorTemp - externalTemp);
    const heatLossBaselineW = acc.conductance * dTBaseline;
    const perM2Baseline = area ? heatLossBaselineW / area : null;
    totalHeatBaseline += heatLossBaselineW;

    // Calculate radiator output using modulated boiler flow
    let radiatorOutputWithTrv = 0;
    let radiatorCoefficient = 0;
    let totalRadSurfaceArea = 0;
    if (zone && Array.isArray(zone.radiators)) {
      for (const radSpec of zone.radiators) {
        const rad = findRadiator(radiators, radSpec.radiator_id);
        if (rad) {
          const output = zoneSetpoint === null
            ? 0
            : calculateRadiatorOutput(rad, radSpec.surface_area, zoneSetpoint, effectiveFlowTemp);
          radiatorOutputWithTrv += output;
          radiatorCoefficient += calculateRadiatorCoefficient(rad, radSpec.surface_area);
          totalRadSurfaceArea += radSpec.surface_area;
        }
      }
    }
    totalRadiatorOutputWithTrv += radiatorOutputWithTrv;

    // Calculate radiator output baseline (at global temp)
    let radiatorOutputBaseline = 0;
    if (zone && Array.isArray(zone.radiators)) {
      for (const radSpec of zone.radiators) {
        const rad = findRadiator(radiators, radSpec.radiator_id);
        if (rad) {
          const output = calculateRadiatorOutput(rad, radSpec.surface_area, globalIndoorTemp, maxFlowTemp);
          radiatorOutputBaseline += output;
        }
      }
    }
    totalRadiatorOutputBaseline += radiatorOutputBaseline;

    const heatingBalanceWithTrv = radiatorOutputWithTrv - heatLossWithTrvW;
    const heatingBalanceBaseline = radiatorOutputBaseline - heatLossBaselineW;
    const heatSavingsW = Math.max(0, heatLossBaselineW - heatLossWithTrvW);
    const canReachSetpoint = zoneSetpoint === null ? true : (radiatorOutputWithTrv >= heatLossWithTrvW);
    const achievableTempRaw = (radiatorCoefficient + acc.conductance) > 0
      ? ((radiatorCoefficient * effectiveFlowTemp) + (acc.conductance * externalTemp)) / (radiatorCoefficient + acc.conductance)
      : externalTemp;
    const maxAchievableTemp = zoneSetpoint === null
      ? null
      : Math.max(externalTemp, Math.min(effectiveFlowTemp, achievableTempRaw));
    const setpointShortfall = zoneSetpoint === null ? 0 : Math.max(0, zoneSetpoint - maxAchievableTemp);

    results.push({
      zoneId,
      zoneName: zone && zone.name,
      setpoint_temperature: zoneSetpoint,
      is_unheated: zone ? zone.is_unheated === true : false,
      is_boiler_control: zoneSetpoint === null ? false : ((zone && zone.is_boiler_control) || false),
      floorArea: area,
      total_conductance: Number(acc.conductance.toFixed(3)),
      heat_loss: Number(heatLossWithTrvW.toFixed(1)),
      heat_loss_baseline: Number(heatLossBaselineW.toFixed(1)),
      heat_savings: Number(heatSavingsW.toFixed(1)),
      heat_loss_per_unit_area: perM2WithTrv ? Number(perM2WithTrv.toFixed(1)) : null,
      radiator_surface_area: Number(totalRadSurfaceArea.toFixed(3)),
      radiator_coefficient: Number(radiatorCoefficient.toFixed(3)),
      radiator_output: Number(radiatorOutputWithTrv.toFixed(1)),
      heating_balance: Number(heatingBalanceWithTrv.toFixed(1)),
      can_reach_setpoint: canReachSetpoint,
      max_achievable_temperature: maxAchievableTemp === null ? null : Number(maxAchievableTemp.toFixed(2)),
      setpoint_shortfall: Number(setpointShortfall.toFixed(2)),
      balance_status: heatingBalanceWithTrv >= 0 ? 'sufficient' : 'insufficient',
      contributing_elements: acc.contributions.map(c => ({ elementId: c.id, conductance: Number(c.c.toFixed(3)) }))
    });
  }

  for (const z of zones) {
    if (z.type === 'boundary') continue;
    if (!roomAcc.has(z.id)) {
      const zoneIsHeated = z.is_unheated !== true;
      const zoneSetpoint = zoneIsHeated
        ? ((typeof z.setpoint_temperature === 'number') ? z.setpoint_temperature : globalIndoorTemp)
        : null;
      
      let radiatorOutputWithTrv = 0;
      let radiatorOutputBaseline = 0;
      let radiatorCoefficient = 0;
      let totalRadSurfaceArea = 0;
      if (Array.isArray(z.radiators)) {
        for (const radSpec of z.radiators) {
          const rad = findRadiator(radiators, radSpec.radiator_id);
          if (rad) {
            const outputTrv = zoneSetpoint === null
              ? 0
              : calculateRadiatorOutput(rad, radSpec.surface_area, zoneSetpoint, effectiveFlowTemp);
            const outputBaseline = calculateRadiatorOutput(rad, radSpec.surface_area, globalIndoorTemp, maxFlowTemp);
            radiatorOutputWithTrv += outputTrv;
            radiatorOutputBaseline += outputBaseline;
            radiatorCoefficient += calculateRadiatorCoefficient(rad, radSpec.surface_area);
            totalRadSurfaceArea += radSpec.surface_area;
          }
        }
      }

      results.push({
        zoneId: z.id,
        zoneName: z.name,
        setpoint_temperature: zoneSetpoint,
        is_unheated: z.is_unheated === true,
        is_boiler_control: zoneSetpoint === null ? false : (z.is_boiler_control || false),
        floorArea: null,
        total_conductance: 0,
        heat_loss: 0,
        heat_loss_baseline: 0,
        heat_savings: 0,
        heat_loss_per_unit_area: null,
        radiator_surface_area: Number(totalRadSurfaceArea.toFixed(3)),
        radiator_coefficient: Number(radiatorCoefficient.toFixed(3)),
        radiator_output: Number(radiatorOutputWithTrv.toFixed(1)),
        heating_balance: Number(radiatorOutputWithTrv.toFixed(1)),
        can_reach_setpoint: true,
        max_achievable_temperature: zoneSetpoint === null ? null : Number(zoneSetpoint.toFixed(2)),
        setpoint_shortfall: 0,
        balance_status: radiatorOutputWithTrv >= 0 ? 'sufficient' : 'insufficient',
        contributing_elements: []
      });
      totalRadiatorOutputWithTrv += radiatorOutputWithTrv;
      totalRadiatorOutputBaseline += radiatorOutputBaseline;
    }
  }

  return { 
    rooms: results, 
    total_heat_loss: Number(totalHeatWithTrv.toFixed(1)), 
    total_heat_loss_baseline: Number(totalHeatBaseline.toFixed(1)),
    total_heat_savings: Number(Math.max(0, totalHeatBaseline - totalHeatWithTrv).toFixed(1)),
    total_radiator_output: Number(totalRadiatorOutputWithTrv.toFixed(1)),
    total_radiator_output_baseline: Number(totalRadiatorOutputBaseline.toFixed(1)),
    total_balance: Number((totalRadiatorOutputWithTrv - totalHeatWithTrv).toFixed(1)),
    total_balance_baseline: Number((totalRadiatorOutputBaseline - totalHeatBaseline).toFixed(1)),
    effectiveFlowTemp: Number(effectiveFlowTemp.toFixed(2)),
    maxFlowTemp,
    controlZoneId,
    controlZoneName,
    globalIndoorTemp, 
    externalTemp,
    flowTemp: maxFlowTemp
  };
}
