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

function zoneHasTrv(zone) {
  if (!zone || !Array.isArray(zone.radiators)) return false;
  return zone.radiators.some(rad => rad && rad.trv_enabled === true);
}

function elementArea(el) {
  if (typeof el.x === 'number' && el.x > 0 && typeof el.y === 'number' && el.y > 0) return el.x * el.y;
  return null;
}

function polygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  let area2 = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const x0 = Number(p0?.x);
    const y0 = Number(p0?.y);
    const x1 = Number(p1?.x);
    const y1 = Number(p1?.y);
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return null;
    area2 += (x0 * y1) - (x1 * y0);
  }
  return Math.abs(area2) / 2;
}

function solveLinearSystem(a, b) {
  const n = a.length;
  if (n === 0) return [];

  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }

    if (Math.abs(m[pivot][col]) < 1e-10) {
      m[pivot][col] = 1e-10;
    }

    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }

    const div = m[col][col];
    for (let c = col; c <= n; c++) {
      m[col][c] /= div;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let c = col; c <= n; c++) {
        m[r][c] -= factor * m[col][c];
      }
    }
  }

  return m.map(row => row[n]);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

export function computeRoomHeatRequirements(demo, radiators, opts) {
  const globalIndoorTemp = (opts && typeof opts.indoorTemp === 'number') ? opts.indoorTemp : 21;
  const externalTemp = (opts && typeof opts.externalTemp === 'number') ? opts.externalTemp : 3;
  const maxFlowTemp = (opts && typeof opts.flowTemp === 'number') ? opts.flowTemp : 55;

  const zones = (demo.zones || []).slice();
  const elements = (demo.elements || []).slice();

  const zoneMap = new Map();
  const boundaryIds = new Set(zones.filter(z => z.type === 'boundary').map(z => z.id));
  if (boundaryIds.size === 0) { ['outside', 'ground', 'loft'].forEach(b => boundaryIds.add(b)); }

  const zoneIds = [];
  for (const z of zones) {
    zoneMap.set(z.id, z);
    if (z.type !== 'boundary') zoneIds.push(z.id);
  }

  const boundaryCondByZone = new Map();
  const boundaryAirflowByZone = new Map();
  const adjByZone = new Map();
  const roomAcc = new Map();

  for (const id of zoneIds) {
    boundaryCondByZone.set(id, 0);
    boundaryAirflowByZone.set(id, 0);
    adjByZone.set(id, new Map());
    roomAcc.set(id, { conductance: 0, area: null, contributions: [] });
  }

  function addAdj(a, b, c) {
    const mapA = adjByZone.get(a);
    const mapB = adjByZone.get(b);
    if (!mapA || !mapB) return;
    mapA.set(b, (mapA.get(b) || 0) + c);
    mapB.set(a, (mapB.get(a) || 0) + c);
  }

  function addBoundary(zoneId, c, elId, elArea, airflowM3h) {
    if (!boundaryCondByZone.has(zoneId)) return;
    boundaryCondByZone.set(zoneId, (boundaryCondByZone.get(zoneId) || 0) + c);
    boundaryAirflowByZone.set(zoneId, (boundaryAirflowByZone.get(zoneId) || 0) + (airflowM3h || 0));
    const acc = roomAcc.get(zoneId);
    if (acc) {
      acc.conductance += c;
      if (typeof elArea === 'number') acc.area = (acc.area || 0) + elArea;
      acc.contributions.push({ id: elId, c });
    }
  }

  for (const el of elements) {
    const nodes = Array.isArray(el.nodes) ? el.nodes : [];
    if (nodes.length < 2) continue;

    const elArea = elementArea(el);
    let elConductance = (typeof el.thermal_conductance === 'number') ? el.thermal_conductance : NaN;
    if (!isFinite(elConductance) && typeof el.u_overall === 'number' && typeof elArea === 'number') {
      elConductance = el.u_overall * elArea;
    }
    let elAirflowM3h = (typeof el.air_leakage_flow_m3_h === 'number' && el.air_leakage_flow_m3_h > 0)
      ? el.air_leakage_flow_m3_h
      : 0;
    if (elAirflowM3h <= 0 && typeof el.fabric_air_leakage_m3_h_m2 === 'number' && typeof elArea === 'number' && elArea > 0) {
      elAirflowM3h = el.fabric_air_leakage_m3_h_m2 * elArea;
    }
    if (!isFinite(elConductance) || elConductance <= 0) continue;

    const nonBoundaryNodes = nodes.filter(n => zoneMap.has(n) && !boundaryIds.has(n));
    const localBoundaryNodes = nodes.filter(n => boundaryIds.has(n));

    if (nonBoundaryNodes.length === 1 && localBoundaryNodes.length >= 1) {
      const share = elConductance / localBoundaryNodes.length;
      const airflowShare = elAirflowM3h / localBoundaryNodes.length;
      addBoundary(nonBoundaryNodes[0], share * localBoundaryNodes.length, el.id, elArea, airflowShare * localBoundaryNodes.length);
      continue;
    }

    if (nonBoundaryNodes.length === 2 && localBoundaryNodes.length === 0) {
      addAdj(nonBoundaryNodes[0], nonBoundaryNodes[1], elConductance);
      continue;
    }

    if (nonBoundaryNodes.length > 1 && localBoundaryNodes.length >= 1) {
      const share = elConductance / nonBoundaryNodes.length;
      const airflowShare = elAirflowM3h / nonBoundaryNodes.length;
      for (const nz of nonBoundaryNodes) {
        addBoundary(nz, share, el.id, typeof elArea === 'number' ? elArea / nonBoundaryNodes.length : null, airflowShare);
      }
    }
  }

  const radiatorCoeffByZone = new Map();
  const radiatorSurfaceByZone = new Map();
  const zoneFloorAreaById = new Map();
  const zoneVolumeById = new Map();
  const infiltrationAirflowByZone = new Map();
  const mechanicalAirflowByZone = new Map();
  const ventilationConductanceByZone = new Map();
  const heatRecoveredAirflowByZone = new Map();
  const infiltrationAchByZone = new Map();
  const totalAchByZone = new Map();
  const zoneSetpointById = new Map();
  const zoneIsHeatedById = new Map();

  for (const id of zoneIds) {
    const z = zoneMap.get(id);
    const isHeated = z ? z.is_unheated !== true : true;
    zoneIsHeatedById.set(id, isHeated);
    zoneSetpointById.set(id, isHeated ? ((typeof z.setpoint_temperature === 'number') ? z.setpoint_temperature : globalIndoorTemp) : null);

    let coeff = 0;
    let area = 0;
    if (z && Array.isArray(z.radiators)) {
      for (const radSpec of z.radiators) {
        const rad = findRadiator(radiators, radSpec.radiator_id);
        const k = calculateRadiatorCoefficient(rad, radSpec.surface_area);
        coeff += k;
        area += (typeof radSpec.surface_area === 'number' && radSpec.surface_area > 0) ? radSpec.surface_area : 0;
      }
    }
    radiatorCoeffByZone.set(id, coeff);
    radiatorSurfaceByZone.set(id, area);

    const zoneFloorArea = (() => {
      if (typeof z?.floor_area_m2 === 'number' && z.floor_area_m2 > 0) return z.floor_area_m2;
      if (typeof z?.floor_area === 'number' && z.floor_area > 0) return z.floor_area;
      const layoutArea = polygonArea(z?.layout?.polygon);
      if (typeof layoutArea === 'number' && layoutArea > 0) return layoutArea;
      const fallbackArea = roomAcc.get(id)?.area;
      if (typeof fallbackArea === 'number' && fallbackArea > 0) return fallbackArea;
      return null;
    })();
    zoneFloorAreaById.set(id, zoneFloorArea);

    const roomHeightM = (typeof z?.room_height_m === 'number' && z.room_height_m > 0)
      ? z.room_height_m
      : ((typeof z?.ceiling_height_m === 'number' && z.ceiling_height_m > 0) ? z.ceiling_height_m : 2.4);
    const zoneVolume = (typeof zoneFloorArea === 'number' && zoneFloorArea > 0)
      ? zoneFloorArea * roomHeightM
      : null;
    zoneVolumeById.set(id, zoneVolume);

    const infiltrationAirflow = Math.max(0, boundaryAirflowByZone.get(id) || 0);
    infiltrationAirflowByZone.set(id, infiltrationAirflow);

    let mechanicalAirflow = 0;
    let mechanicalConductance = 0;
    let recoveredAirflow = 0;
    if (Array.isArray(z?.ventilation_elements)) {
      for (const vent of z.ventilation_elements) {
        if (!vent || vent.enabled === false) continue;
        const boostFlow = Number(vent.flow_m3_h);
        if (!isFinite(boostFlow) || boostFlow <= 0) continue;
        const type = String(vent.type || '').toLowerCase();
        const isHeatExchanger = type.includes('heat_exchanger') || type.includes('hrv') || type.includes('mvhr');
        let trickleFlow = Number(vent.trickle_flow_m3_h);
        if (!isFinite(trickleFlow) || trickleFlow < 0) {
          trickleFlow = isHeatExchanger
            ? (boostFlow * 0.7)
            : (boostFlow * 0.15);
        }
        trickleFlow = Math.max(0, Math.min(boostFlow, trickleFlow));

        let boostHoursPerDay = Number(vent.boost_hours_per_day);
        if (!isFinite(boostHoursPerDay) || boostHoursPerDay < 0) boostHoursPerDay = 1;
        boostHoursPerDay = Math.max(0, Math.min(24, boostHoursPerDay));
        const duty = boostHoursPerDay / 24;
        const effectiveFlow = trickleFlow + Math.max(0, boostFlow - trickleFlow) * duty;

        let recovery = Number(vent.heat_recovery_efficiency);
        if (!isFinite(recovery) || recovery < 0) recovery = 0;
        if (recovery > 1) recovery = 1;
        if (!isHeatExchanger) {
          recovery = 0;
        }

        mechanicalAirflow += effectiveFlow;
        recoveredAirflow += effectiveFlow * recovery;
        mechanicalConductance += 0.33 * effectiveFlow * (1 - recovery);
      }
    }

    const infiltrationConductance = 0.33 * infiltrationAirflow;
    mechanicalAirflowByZone.set(id, mechanicalAirflow);
    heatRecoveredAirflowByZone.set(id, recoveredAirflow);
    ventilationConductanceByZone.set(id, infiltrationConductance + mechanicalConductance);

    if (typeof zoneVolume === 'number' && zoneVolume > 0) {
      infiltrationAchByZone.set(id, infiltrationAirflow / zoneVolume);
      totalAchByZone.set(id, (infiltrationAirflow + mechanicalAirflow) / zoneVolume);
    } else {
      infiltrationAchByZone.set(id, null);
      totalAchByZone.set(id, null);
    }
  }

  function solveNetwork(flowTemp, options = {}) {
    const enableTrvClamp = options.enableTrvClamp !== false;
    let clampedTrv = new Set();
    let temps = new Map();

    for (let iter = 0; iter < 10; iter++) {
      const unknownIds = zoneIds.filter(id => !clampedTrv.has(id));
      const indexById = new Map();
      unknownIds.forEach((id, idx) => indexById.set(id, idx));

      const n = unknownIds.length;
      const a = Array.from({ length: n }, () => Array(n).fill(0));
      const b = Array(n).fill(0);

      for (let r = 0; r < n; r++) {
        const zoneId = unknownIds[r];
        const zone = zoneMap.get(zoneId);

        let diag = 0;
        let rhs = 0;

        const cBoundary = boundaryCondByZone.get(zoneId) || 0;
        diag += cBoundary;
        rhs += cBoundary * externalTemp;

        const cVent = ventilationConductanceByZone.get(zoneId) || 0;
        diag += cVent;
        rhs += cVent * externalTemp;

        const neighbors = adjByZone.get(zoneId) || new Map();
        for (const [otherId, c] of neighbors.entries()) {
          if (clampedTrv.has(otherId)) {
            const fixed = zoneSetpointById.get(otherId);
            diag += c;
            rhs += c * (typeof fixed === 'number' ? fixed : externalTemp);
          } else {
            const cIdx = indexById.get(otherId);
            if (typeof cIdx === 'number') {
              diag += c;
              a[r][cIdx] -= c;
            }
          }
        }

        const heated = zoneIsHeatedById.get(zoneId) === true;
        const k = heated ? (radiatorCoeffByZone.get(zoneId) || 0) : 0;
        diag += k;
        rhs += k * flowTemp;

        if (diag <= 0) {
          diag = 1;
          rhs = externalTemp;
        }

        a[r][r] += diag;
        b[r] += rhs;
      }

      const x = solveLinearSystem(a, b);
      const nextTemps = new Map();

      for (let i = 0; i < unknownIds.length; i++) {
        nextTemps.set(unknownIds[i], x[i]);
      }
      for (const id of clampedTrv) {
        const sp = zoneSetpointById.get(id);
        nextTemps.set(id, typeof sp === 'number' ? sp : externalTemp);
      }

      temps = nextTemps;

      if (!enableTrvClamp) break;

      const nextClamp = new Set();
      for (const id of zoneIds) {
        const z = zoneMap.get(id);
        const sp = zoneSetpointById.get(id);
        if (!z || !zoneHasTrv(z) || typeof sp !== 'number') continue;
        const t = temps.get(id);
        if (typeof t === 'number' && t > sp + 0.05) {
          nextClamp.add(id);
        }
      }

      if (setsEqual(nextClamp, clampedTrv)) break;
      clampedTrv = nextClamp;
    }

    const heatLossByZone = new Map();
    const radiatorOutputByZone = new Map();
    const heatingBalanceByZone = new Map();

    for (const id of zoneIds) {
      const t = temps.get(id);
      const ti = (typeof t === 'number' && isFinite(t)) ? t : externalTemp;

      let qOut = ((boundaryCondByZone.get(id) || 0) + (ventilationConductanceByZone.get(id) || 0)) * (ti - externalTemp);
      const neighbors = adjByZone.get(id) || new Map();
      for (const [otherId, c] of neighbors.entries()) {
        const tj = temps.get(otherId);
        const tOther = (typeof tj === 'number' && isFinite(tj)) ? tj : externalTemp;
        qOut += c * (ti - tOther);
      }

      const demand = Math.max(0, qOut);
      const k = zoneIsHeatedById.get(id) ? (radiatorCoeffByZone.get(id) || 0) : 0;
      const maxRadOut = k * Math.max(0, flowTemp - ti);

      let radOut = maxRadOut;
      if (clampedTrv.has(id)) {
        radOut = Math.min(maxRadOut, demand);
      }

      heatLossByZone.set(id, demand);
      radiatorOutputByZone.set(id, Math.max(0, radOut));
      heatingBalanceByZone.set(id, Math.max(0, radOut) - demand);
    }

    return {
      temps,
      clampedTrv,
      heatLossByZone,
      radiatorOutputByZone,
      heatingBalanceByZone
    };
  }

  let controlZoneId = null;
  let controlZoneName = null;
  let controlSetpoint = null;

  for (const id of zoneIds) {
    const z = zoneMap.get(id);
    if (!z || z.is_unheated === true || z.is_boiler_control !== true) continue;
    const sp = zoneSetpointById.get(id);
    if (typeof sp === 'number') {
      controlZoneId = id;
      controlZoneName = z.name || z.id || null;
      controlSetpoint = sp;
      break;
    }
  }

  let effectiveFlowTemp = maxFlowTemp;
  if (controlZoneId && typeof controlSetpoint === 'number') {
    const lower = Math.min(maxFlowTemp, Math.max(controlSetpoint, externalTemp));
    const atLower = solveNetwork(lower, { enableTrvClamp: true });
    const tLower = atLower.temps.get(controlZoneId);
    const atMax = solveNetwork(maxFlowTemp, { enableTrvClamp: true });
    const tMax = atMax.temps.get(controlZoneId);

    if (typeof tLower === 'number' && tLower >= controlSetpoint) {
      effectiveFlowTemp = lower;
    } else if (!(typeof tMax === 'number' && tMax >= controlSetpoint)) {
      effectiveFlowTemp = maxFlowTemp;
    } else {
      let lo = lower;
      let hi = maxFlowTemp;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const midSolve = solveNetwork(mid, { enableTrvClamp: true });
        const tMid = midSolve.temps.get(controlZoneId);
        if (typeof tMid === 'number' && tMid >= controlSetpoint) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      effectiveFlowTemp = hi;
    }
  }

  const operational = solveNetwork(effectiveFlowTemp, { enableTrvClamp: true });
  const maxPotential = solveNetwork(maxFlowTemp, { enableTrvClamp: false });

  const baselineTempByZone = new Map();
  for (const id of zoneIds) {
    const heated = zoneIsHeatedById.get(id) === true;
    baselineTempByZone.set(id, heated ? globalIndoorTemp : externalTemp);
  }

  const heatLossBaselineByZone = new Map();
  const radiatorOutputBaselineByZone = new Map();
  for (const id of zoneIds) {
    const ti = baselineTempByZone.get(id);
    let qOut = ((boundaryCondByZone.get(id) || 0) + (ventilationConductanceByZone.get(id) || 0)) * (ti - externalTemp);
    const neighbors = adjByZone.get(id) || new Map();
    for (const [otherId, c] of neighbors.entries()) {
      const tj = baselineTempByZone.get(otherId);
      qOut += c * (ti - tj);
    }
    heatLossBaselineByZone.set(id, Math.max(0, qOut));

    const k = zoneIsHeatedById.get(id) ? (radiatorCoeffByZone.get(id) || 0) : 0;
    radiatorOutputBaselineByZone.set(id, k * Math.max(0, maxFlowTemp - ti));
  }

  const results = [];
  let totalHeatWithTrv = 0;
  let totalRadiatorOutputWithTrv = 0;
  let totalHeatBaseline = 0;
  let totalRadiatorOutputBaseline = 0;
  let totalDeliveredHeatWithModulation = 0;
  let totalHeatSavingsEligible = 0;
  let totalDeliveredHeatSavingsEligible = 0;
  let totalInfiltrationAirflow = 0;
  let totalMechanicalAirflow = 0;
  let totalRecoveredAirflow = 0;
  let totalVentilationConductance = 0;
  let totalVolume = 0;

  for (const id of zoneIds) {
    const z = zoneMap.get(id);
    const acc = roomAcc.get(id) || { conductance: 0, area: null, contributions: [] };
    const area = acc.area || null;
    const floorArea = zoneFloorAreaById.get(id) || area;
    const zoneVolume = zoneVolumeById.get(id);

    const setpoint = zoneSetpointById.get(id);
    const temp = operational.temps.get(id);
    const maxTemp = maxPotential.temps.get(id);

    const heatLoss = operational.heatLossByZone.get(id) || 0;
    const heatLossBaseline = heatLossBaselineByZone.get(id) || 0;
    const radiatorOutput = operational.radiatorOutputByZone.get(id) || 0;
    const radiatorOutputBaseline = radiatorOutputBaselineByZone.get(id) || 0;
    const heatingBalance = operational.heatingBalanceByZone.get(id) || 0;
    const radiatorCoeff = radiatorCoeffByZone.get(id) || 0;
    const canClaimTrvSavings = zoneIsHeatedById.get(id) === true && radiatorCoeff > 0;

    const heatSavings = canClaimTrvSavings ? Math.max(0, heatLossBaseline - heatLoss) : 0;
    const deliveredHeat = radiatorOutput;
    const deliveredHeatSavings = canClaimTrvSavings ? Math.max(0, heatLossBaseline - deliveredHeat) : 0;

    const canReachSetpoint = typeof setpoint === 'number'
      ? ((typeof temp === 'number') && temp >= setpoint - 0.1)
      : true;

    const maxAchievableTemp = typeof setpoint === 'number' && typeof maxTemp === 'number'
      ? Math.max(externalTemp, Math.min(maxFlowTemp, maxTemp))
      : null;
    const setpointShortfall = typeof setpoint === 'number' && maxAchievableTemp !== null
      ? Math.max(0, setpoint - maxAchievableTemp)
      : 0;

    const perM2 = floorArea ? heatLoss / floorArea : null;
    const deliveredPerM2 = floorArea ? deliveredHeat / floorArea : null;

    const infiltrationAirflow = infiltrationAirflowByZone.get(id) || 0;
    const mechanicalAirflow = mechanicalAirflowByZone.get(id) || 0;
    const recoveredAirflow = heatRecoveredAirflowByZone.get(id) || 0;
    const ventilationConductance = ventilationConductanceByZone.get(id) || 0;
    const infiltrationAch = infiltrationAchByZone.get(id);
    const totalAch = totalAchByZone.get(id);

    results.push({
      zoneId: id,
      zoneName: z && z.name,
      setpoint_temperature: setpoint,
      is_unheated: z ? z.is_unheated === true : false,
      is_boiler_control: setpoint === null ? false : ((z && z.is_boiler_control) || false),
      floorArea,
      room_volume_m3: zoneVolume ? Number(zoneVolume.toFixed(3)) : null,
      infiltration_airflow_m3_h: Number(infiltrationAirflow.toFixed(3)),
      mechanical_ventilation_airflow_m3_h: Number(mechanicalAirflow.toFixed(3)),
      heat_recovered_airflow_m3_h: Number(recoveredAirflow.toFixed(3)),
      ventilation_conductance: Number(ventilationConductance.toFixed(3)),
      infiltration_ach: typeof infiltrationAch === 'number' ? Number(infiltrationAch.toFixed(3)) : null,
      air_changes_per_hour: typeof totalAch === 'number' ? Number(totalAch.toFixed(3)) : null,
      total_conductance: Number((acc.conductance || 0).toFixed(3)),
      heat_loss: Number(heatLoss.toFixed(1)),
      heat_loss_baseline: Number(heatLossBaseline.toFixed(1)),
      heat_savings: Number(heatSavings.toFixed(1)),
      heat_loss_per_unit_area: perM2 ? Number(perM2.toFixed(1)) : null,
      delivered_indoor_temperature: (typeof temp === 'number') ? Number(temp.toFixed(2)) : null,
      delivered_heat: Number(deliveredHeat.toFixed(1)),
      delivered_heat_per_unit_area: deliveredPerM2 ? Number(deliveredPerM2.toFixed(1)) : null,
      delivered_heat_savings: Number(deliveredHeatSavings.toFixed(1)),
      radiator_surface_area: Number((radiatorSurfaceByZone.get(id) || 0).toFixed(3)),
      radiator_coefficient: Number((radiatorCoeffByZone.get(id) || 0).toFixed(3)),
      radiator_output: Number(radiatorOutput.toFixed(1)),
      heating_balance: Number(heatingBalance.toFixed(1)),
      can_reach_setpoint: canReachSetpoint,
      max_achievable_temperature: maxAchievableTemp === null ? null : Number(maxAchievableTemp.toFixed(2)),
      setpoint_shortfall: Number(setpointShortfall.toFixed(2)),
      balance_status: heatingBalance >= 0 ? 'sufficient' : 'insufficient',
      contributing_elements: acc.contributions.map(c => ({ elementId: c.id, conductance: Number(c.c.toFixed(3)) }))
    });

    totalHeatWithTrv += heatLoss;
    totalRadiatorOutputWithTrv += radiatorOutput;
    totalHeatBaseline += heatLossBaseline;
    totalRadiatorOutputBaseline += radiatorOutputBaseline;
    totalDeliveredHeatWithModulation += deliveredHeat;
    totalHeatSavingsEligible += heatSavings;
    totalDeliveredHeatSavingsEligible += deliveredHeatSavings;
    totalInfiltrationAirflow += infiltrationAirflow;
    totalMechanicalAirflow += mechanicalAirflow;
    totalRecoveredAirflow += recoveredAirflow;
    totalVentilationConductance += ventilationConductance;
    if (typeof zoneVolume === 'number' && zoneVolume > 0) totalVolume += zoneVolume;
  }

  const totalAch = totalVolume > 0
    ? (totalInfiltrationAirflow + totalMechanicalAirflow) / totalVolume
    : null;

  return {
    rooms: results,
    total_heat_loss: Number(totalHeatWithTrv.toFixed(1)),
    total_heat_loss_baseline: Number(totalHeatBaseline.toFixed(1)),
    total_heat_savings: Number(Math.max(0, totalHeatSavingsEligible).toFixed(1)),
    total_delivered_heat: Number(totalDeliveredHeatWithModulation.toFixed(1)),
    total_delivered_heat_savings: Number(Math.max(0, totalDeliveredHeatSavingsEligible).toFixed(1)),
    total_infiltration_airflow_m3_h: Number(totalInfiltrationAirflow.toFixed(3)),
    total_mechanical_ventilation_airflow_m3_h: Number(totalMechanicalAirflow.toFixed(3)),
    total_heat_recovered_airflow_m3_h: Number(totalRecoveredAirflow.toFixed(3)),
    total_ventilation_conductance: Number(totalVentilationConductance.toFixed(3)),
    total_air_changes_per_hour: typeof totalAch === 'number' ? Number(totalAch.toFixed(3)) : null,
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
