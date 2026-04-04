// Recommendation engine extracted from solver to keep orchestration code focused.

export function getRecommendationCostModel(currentCosts) {
  return currentCosts && typeof currentCosts === 'object'
    ? currentCosts
    : {
      currency: 'GBP',
      heating: {
        gas_rate_per_kwh: 0.07,
        electric_rate_per_kwh: 0.24,
        gas_boiler_efficiency: 0.9,
        heat_pump_scop: 3.2
      },
      measures: {
        trv: {
          callout: 120,
          valve_material_each: 22,
          install_each: 45
        },
        flow_temp_optimization: {
          target_c: 45,
          commissioning_cost: 180
        },
        radiator_upgrade: {
          cost_per_m2_surface_area: 45,
          callout: 200,
          sizing_overhead_factor: 1.15
        },
        setpoint_optimization: {
          min_setpoint_c: 18,
          step_c: 1,
          commissioning_cost: 120
        },
        window_upgrade: {
          install_per_m2: 260,
          callout: 350
        },
        door_upgrade: {
          install_each: 180,
          callout: 180
        },
        wall_insulation_internal_retrofit: {
          insulation_material_id: 'pir',
          thickness_basis: 'structural_cavity',
          fallback_thickness_m: 0.06,
          max_within_stud_thickness_m: 0.1,
          add_internal_service_layer: false,
          service_layer_thickness_m: 0.05,
          service_layer_install_multiplier: 1.35,
          install_per_m2: 95,
          callout: 450
        },
        floor_insulation: {
          insulation_material_id: 'rockwool',
          thickness_basis: 'structural_cavity',
          fallback_thickness_m: 0.08,
          install_per_m2: 75,
          callout: 400
        },
        loft_insulation: {
          insulation_material_id: 'rockwool',
          thickness_basis: 'structural_cavity',
          fallback_thickness_m: 0.15,
          above_joist_thickness_m: 0,
          max_above_joist_thickness_m: 0.5,
          install_per_m2: 22,
          callout: 220
        },
        heating_system_switch: {
          heat_pump_install_base: 4200,
          heat_pump_install_per_kw: 650,
          heat_pump_min_kw: 4,
          heat_pump_sizing_factor: 1.15,
          gas_boiler_install_base: 1800,
          gas_boiler_install_per_kw: 220,
          gas_boiler_min_kw: 12,
          gas_boiler_sizing_factor: 1.1,
          heat_pump_install: 9500,
          gas_boiler_install: 3200,
          wet_system_conversion: 6500,
          electric_radiator_conversion: 2800,
          wet_emitter_each: 420,
          electric_emitter_each: 320,
          decommission_allowance: 600,
          contingency_factor: 1.1
        }
      }
    };
}

export function buildPerformanceRecommendations(demoRaw, context = {}) {
  const { currentCosts = null, currentOpenings = null, helpers = {} } = context || {};
  const { deepClone, getComparisonMetricsForDemo, getComfortSnapshotForDemo, getNormalizedHeatingInputs, normalizeCostResult, formatCurrencyEstimate, applyRadiatorComfortUpgrade, createUniqueElementNameResolver, formatCountMap, formatTypeChangeMap, getWindowCatalogEntry, getDoorCatalogEntry, getBoundaryZoneId, isHeatedExternalWallElement, isWallInternalRetrofitAlreadyApplied, resolveElementBuildUpForEdit, getWallRetrofitThicknessFromBuildUp, getMaterialDisplayName, getElementNetInsulationAreaM2, getElementAreaM2, getInsulationMaterialCostPerM3, getInsulationMaterialCostPerM2, applyFloorCavityInsulationRetrofit, getFloorCompositeNonJoistMaterialIds, formatThicknessMm, getLoftInsulationThicknessFromBuildUp, getComfortDeficitRoomsForDemo, getEpcBandFromIntensity } = helpers;
  const baseline = getComparisonMetricsForDemo(demoRaw);
  if (!baseline || !isFinite(baseline.annualDemandKwhYr)) return [];
  const baselineComfort = getComfortSnapshotForDemo(demoRaw);
  if (!baselineComfort) return [];

  const costModel = getRecommendationCostModel(currentCosts);
  const measures = costModel.measures || {};
  const currency = String(costModel.currency || 'GBP').toUpperCase();
  const openings = currentOpenings || {};
  const results = [];
  const baselineFlowTemp = Number.isFinite(demoRaw?.meta?.flowTemp) ? Number(demoRaw.meta.flowTemp) : 55;
  const baselineHeatingInputs = getNormalizedHeatingInputs(demoRaw?.meta, baselineFlowTemp, costModel);
  const baselineRunningCost = {
    annualCost: Number(baseline.annualRunningCost || 0)
  };
  const systemSwitchCfg = measures.heating_system_switch || {};
  const heatedRooms = (Array.isArray(demoRaw?.zones) ? demoRaw.zones : [])
    .filter(zone => zone && zone.type !== 'boundary' && zone.is_unheated !== true);
  const emitterCount = Math.max(1, heatedRooms.length);
  const designHeatLossW = Math.max(0, Number(baseline?.totalHeatLoss || 0));
  const resolvePlantInstallCost = (sourceKey) => {
    const isHeatPump = sourceKey === 'heat_pump';
    const legacyFlat = Number(isHeatPump ? systemSwitchCfg.heat_pump_install : systemSwitchCfg.gas_boiler_install);
    const base = Number(isHeatPump ? systemSwitchCfg.heat_pump_install_base : systemSwitchCfg.gas_boiler_install_base);
    const perKw = Number(isHeatPump ? systemSwitchCfg.heat_pump_install_per_kw : systemSwitchCfg.gas_boiler_install_per_kw);
    const minKwRaw = Number(isHeatPump ? systemSwitchCfg.heat_pump_min_kw : systemSwitchCfg.gas_boiler_min_kw);
    const sizingFactorRaw = Number(isHeatPump ? systemSwitchCfg.heat_pump_sizing_factor : systemSwitchCfg.gas_boiler_sizing_factor);

    if (!isFinite(base) || !isFinite(perKw) || base < 0 || perKw < 0) {
      return {
        amount: Math.max(0, isFinite(legacyFlat) ? legacyFlat : 0),
        requiredKw: null,
        note: 'flat'
      };
    }

    const sizingFactor = isFinite(sizingFactorRaw) && sizingFactorRaw > 0 ? sizingFactorRaw : 1;
    const minKw = isFinite(minKwRaw) && minKwRaw > 0 ? minKwRaw : 0;
    const requiredKw = Math.max(minKw, (designHeatLossW * sizingFactor) / 1000);
    const roundedKw = Math.ceil(requiredKw * 2) / 2;
    const amount = base + (roundedKw * perKw);
    return {
      amount: Math.max(0, amount),
      requiredKw: roundedKw,
      note: 'sized'
    };
  };
  const getSystemSwitchCost = (targetSource) => {
    const currentSource = String(baselineHeatingInputs?.heatSourceType || 'gas_boiler');
    if (targetSource === currentSource) {
      return { total: 0, breakdown: [] };
    }
    const contingencyFactor = Number(systemSwitchCfg.contingency_factor || 1.1);
    const decommission = Number(systemSwitchCfg.decommission_allowance || 0);
    let baseInstall = 0;
    let conversion = 0;
    let emitterConversion = 0;
    const breakdown = [];

    if (targetSource === 'heat_pump') {
      const plantInstall = resolvePlantInstallCost('heat_pump');
      baseInstall = plantInstall.amount;
      if (plantInstall.note === 'sized' && isFinite(plantInstall.requiredKw)) {
        breakdown.push({ label: `Heat pump installation (${plantInstall.requiredKw.toFixed(1)} kW)` , amount: baseInstall });
      } else {
        breakdown.push({ label: 'Heat pump installation', amount: baseInstall });
      }
      if (currentSource === 'direct_electric') {
        conversion = Number(systemSwitchCfg.wet_system_conversion || 0);
        emitterConversion = emitterCount * Number(systemSwitchCfg.wet_emitter_each || 0);
        breakdown.push({ label: 'Wet system conversion (pipework/manifold)', amount: conversion });
        breakdown.push({ label: `Wet emitters (${emitterCount})`, amount: emitterConversion });
      }
      if (currentSource === 'gas_boiler' && decommission > 0) {
        breakdown.push({ label: 'Boiler decommission allowance', amount: decommission });
      }
    } else if (targetSource === 'gas_boiler') {
      const plantInstall = resolvePlantInstallCost('gas_boiler');
      baseInstall = plantInstall.amount;
      if (plantInstall.note === 'sized' && isFinite(plantInstall.requiredKw)) {
        breakdown.push({ label: `Gas boiler installation (${plantInstall.requiredKw.toFixed(1)} kW)`, amount: baseInstall });
      } else {
        breakdown.push({ label: 'Gas boiler installation', amount: baseInstall });
      }
      if (currentSource === 'direct_electric') {
        conversion = Number(systemSwitchCfg.wet_system_conversion || 0);
        emitterConversion = emitterCount * Number(systemSwitchCfg.wet_emitter_each || 0);
        breakdown.push({ label: 'Wet system conversion (pipework/manifold)', amount: conversion });
        breakdown.push({ label: `Wet emitters (${emitterCount})`, amount: emitterConversion });
      }
      if (currentSource === 'heat_pump' && decommission > 0) {
        breakdown.push({ label: 'Heat pump decommission allowance', amount: decommission });
      }
    } else if (targetSource === 'direct_electric') {
      baseInstall = Number(systemSwitchCfg.electric_radiator_conversion || 0);
      breakdown.push({ label: 'Direct-electric radiator conversion', amount: baseInstall });
      if (currentSource !== 'direct_electric') {
        emitterConversion = emitterCount * Number(systemSwitchCfg.electric_emitter_each || 0);
        breakdown.push({ label: `Electric emitters (${emitterCount})`, amount: emitterConversion });
      }
    }

    const subtotal = Math.max(0, baseInstall + conversion + emitterConversion + Math.max(0, decommission));
    const contingency = subtotal * Math.max(0, contingencyFactor - 1);
    if (contingency > 0) {
      breakdown.push({ label: `Contingency (${Math.round((contingencyFactor - 1) * 100)}%)`, amount: contingency });
    }
    return {
      total: subtotal + contingency,
      breakdown
    };
  };

  const addCandidate = (label, mutateFn, costFn, options = {}) => {
    const working = deepClone(demoRaw);
    const change = mutateFn(working);
    if (!change || !change.changed) return;
    const metrics = getComparisonMetricsForDemo(working);
    if (!metrics || !isFinite(metrics.annualDemandKwhYr)) return;
    const candidateComfort = getComfortSnapshotForDemo(working);
    if (!candidateComfort) return;

    const roomTempDropsWhenCold = baselineComfort.below18Count > 0
      && Object.entries(baselineComfort.zoneTempById || {}).some(([zoneId, baselineTemp]) => {
        const nextTemp = Number((candidateComfort.zoneTempById || {})[zoneId]);
        const baseTemp = Number(baselineTemp);
        return isFinite(baseTemp) && isFinite(nextTemp) && (nextTemp < baseTemp - 0.05);
      });
    if (roomTempDropsWhenCold && options.allowTempDropWhenCold !== true) return;

    if (typeof options.accept === 'function' && options.accept({
      metrics,
      baseline,
      change,
      baselineComfort,
      candidateComfort
    }) !== true) return;
    const annualSavings = Math.max(0, baseline.annualDemandKwhYr - metrics.annualDemandKwhYr);
    const annualCostSavings = Math.max(0, Number(baselineRunningCost.annualCost || 0) - Number(metrics.annualRunningCost || 0));
    const below18Reduction = Math.max(0, Number(baselineComfort?.below18Count || 0) - Number(candidateComfort?.below18Count || 0));
    const belowTargetReduction = Math.max(0, Number(baselineComfort?.belowTargetCount || 0) - Number(candidateComfort?.belowTargetCount || 0));
    const unmetReduction = Math.max(0, Number(baselineComfort?.unmetSetpointRoomCount || 0) - Number(candidateComfort?.unmetSetpointRoomCount || 0));
    const baselineMinTemp = Number(baselineComfort?.minDeliveredTemp);
    const candidateMinTemp = Number(candidateComfort?.minDeliveredTemp);
    const minTempLift = isFinite(baselineMinTemp) && isFinite(candidateMinTemp)
      ? Math.max(0, candidateMinTemp - baselineMinTemp)
      : 0;
    const comfortImprovement = (belowTargetReduction * 200) + (below18Reduction * 100) + (unmetReduction * 10) + minTempLift;
    if (!isFinite(annualSavings) || (annualSavings < 1 && annualCostSavings < 0.5 && comfortImprovement <= 0)) return;

    const normalizedCost = normalizeCostResult(costFn(change), currency);
    const totalCost = Number(normalizedCost.total || 0);
    const paybackYears = annualCostSavings > 0.01 && totalCost > 0
      ? totalCost / annualCostSavings
      : null;
    results.push({
      recommendationId: String(options.id || label).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      recommendation: label,
      annualSavingsKwhYr: Number(annualSavings.toFixed(0)),
      annualCostSavings: Number(annualCostSavings.toFixed(0)),
      annualCostSavingsText: formatCurrencyEstimate(annualCostSavings, currency),
      simplePaybackYears: paybackYears,
      simplePaybackText: Number.isFinite(paybackYears) ? `${paybackYears.toFixed(1)} years` : 'n/a',
      expectedEpc: metrics.epcLetter || 'N/A',
      costEstimate: formatCurrencyEstimate(totalCost, currency),
      proposal: String(change.proposal || `Apply measure: ${label}`),
      costBreakdown: Array.isArray(normalizedCost.formattedBreakdown)
        ? normalizedCost.formattedBreakdown
        : [],
      _comfortImprovement: comfortImprovement,
      _annualCostSavings: annualCostSavings,
      _annualInputSavings: Math.max(0, Number(baseline.annualInputEnergyKwhYr || 0) - Number(metrics.annualInputEnergyKwhYr || 0)),
      _sortCost: isFinite(totalCost) ? totalCost : Infinity
    });
  };

  addCandidate(
    'Add TRVs to radiators',
    (working) => {
      const zones = Array.isArray(working?.zones) ? working.zones : [];
      let changedCount = 0;
      zones.forEach(zone => {
        const radiators = Array.isArray(zone?.radiators) ? zone.radiators : [];
        radiators.forEach(r => {
          if (r?.trv_enabled === true) return;
          r.trv_enabled = true;
          changedCount += 1;
        });
      });
      return {
        changed: changedCount > 0,
        count: changedCount,
        proposal: `Enable TRVs on ${changedCount} radiator(s) that do not currently have thermostatic valves.`
      };
    },
    (change) => {
      const cfg = measures.trv || {};
      const callout = Number(cfg.callout || 0);
      const valveMaterial = change.count * Number(cfg.valve_material_each || 0);
      const install = change.count * Number(cfg.install_each || 0);
      return {
        total: callout + valveMaterial + install,
        breakdown: [
          { label: 'Plumber callout', amount: callout },
          { label: `TRV valves (${change.count})`, amount: valveMaterial },
          { label: `TRV installation labour (${change.count})`, amount: install }
        ]
      };
    },
    { id: 'trv_add' }
  );

  addCandidate(
    'Add/upgrade radiators for comfort',
    (working) => {
      const flowCfg = measures.flow_temp_optimization || {};
      const radCfg = measures.radiator_upgrade || {};
      const plan = applyRadiatorComfortUpgrade(working, {
        targetFlowTemp: Number(flowCfg.target_c || 45),
        maxComfortFlowTemp: Number(flowCfg.max_comfort_c || 75),
        sizingOverheadFactor: Number(radCfg.sizing_overhead_factor || 1.15)
      });
      if (!plan.changed) return { changed: false };

      const roomNames = plan.upgradedRooms.map(item => item.zoneName).join(', ');
      const areaByRoom = plan.upgradedRooms
        .map(item => {
          const specSummary = (Array.isArray(item.finalSpecs) ? item.finalSpecs : [])
            .map(rad => `${rad.radiatorId} ${rad.width}x${rad.height}`)
            .join(' + ');
          return `${item.zoneName}: +${item.addArea.toFixed(2)} m2 (${specSummary || 'configured radiator'})`;
        })
        .join('; ');
      const flowAdjustmentText = plan.flowTempAdjusted
        ? `Flow temperature adjusted from ${plan.flowTempBefore.toFixed(0)}C to ${plan.flowTempAfter.toFixed(0)}C while preserving comfort.`
        : `Flow temperature held at ${plan.flowTempBefore.toFixed(0)}C (no safe reduction available yet).`;
      const thermostatMoveText = plan.thermostatMoved
        ? `Boiler control thermostat moved to ${plan.thermostatTargetZoneName || 'the highest-deficit room'} to avoid warm-room throttling.`
        : 'Boiler control thermostat location unchanged.';
      const sizingOverheadPct = Math.max(0, (Number(radCfg.sizing_overhead_factor || 1.15) - 1) * 100);

      return {
        changed: plan.changed,
        totalAddedSurfaceArea: plan.totalAddedSurfaceArea,
        trvEnabledCount: plan.trvEnabledCount,
        flowTempAdjusted: plan.flowTempAdjusted,
        roomCount: plan.upgradedRooms.length,
        proposal: [
          `Rooms upgraded for comfort: ${roomNames || 'none'}.`,
          `Radiator changes by room: ${areaByRoom || 'none'}.`,
          `Radiator sizing overhead target: ${sizingOverheadPct.toFixed(0)}% above calculated minimum output.`,
          thermostatMoveText,
          `TRVs included by default on upgraded emitters: ${plan.trvEnabledCount}.`,
          flowAdjustmentText,
          `Comfort impact: rooms below target (target = max(18C, room setpoint)): ${plan.belowTargetBefore} -> ${plan.belowTargetAfter}; rooms below 18C: ${plan.below18Before} -> ${plan.below18After}; unmet rooms: ${plan.unmetBefore} -> ${plan.unmetAfter}.`,
          `This allows all rooms to reach their target temperatures, or enables reduced flow temperature while maintaining comfort.`
        ].join('\n')
      };
    },
    (change) => {
      const cfg = measures.radiator_upgrade || {};
      const trvCfg = measures.trv || {};
      const flowCfg = measures.flow_temp_optimization || {};
      const costPerM2 = Number(cfg.cost_per_m2_surface_area || 45);
      const callout = Number(cfg.callout || 0);
      const material = change.totalAddedSurfaceArea * costPerM2;
      const install = change.totalAddedSurfaceArea * 85; // Labour per m² (roughly £85)
      const trvCount = Number(change.trvEnabledCount || 0);
      const trvMaterial = trvCount * Number(trvCfg.valve_material_each || 0);
      const trvInstall = trvCount * Number(trvCfg.install_each || 0);
      const flowCommissioning = change.flowTempAdjusted ? Number(flowCfg.commissioning_cost || 0) : 0;
      return {
        total: callout + material + install + trvMaterial + trvInstall + flowCommissioning,
        breakdown: [
          { label: 'Plumber callout', amount: callout },
          { label: `Radiator material (${change.totalAddedSurfaceArea.toFixed(1)} m²)`, amount: material },
          { label: `Radiator installation labour (${change.totalAddedSurfaceArea.toFixed(1)} m²)`, amount: install },
          { label: `TRV valves (${trvCount})`, amount: trvMaterial },
          { label: `TRV installation labour (${trvCount})`, amount: trvInstall },
          { label: 'Flow temperature commissioning', amount: flowCommissioning }
        ]
      };
    },
    { id: 'radiator_upgrade_unmet' }
  );

  addCandidate(
    'Lower heating flow temperature',
    (working) => {
      const cfg = measures.flow_temp_optimization || {};
      const target = Number(cfg.target_c || 45);
      const current = Number(working?.meta?.flowTemp);
      const currentSafe = isFinite(current) ? current : 55;
      if (currentSafe <= target + 0.5) return { changed: false };
      working.meta = working.meta || {};
      working.meta.flowTemp = target;
      return {
        changed: true,
        from: currentSafe,
        to: target,
        proposal: `Reduce boiler flow temperature from ${currentSafe.toFixed(0)}C to ${target.toFixed(0)}C and rebalance emitters.`
      };
    },
    () => {
      const commissioning = Number((measures.flow_temp_optimization || {}).commissioning_cost || 0);
      return {
        total: commissioning,
        breakdown: [
          { label: 'Heating system commissioning/tuning', amount: commissioning }
        ]
      };
    },
    {
      id: 'flow_temp_reduce',
      accept: ({ metrics, baseline: base }) => {
        const baselineFailures = Number(base?.unmetSetpointRoomCount || 0);
        const candidateFailures = Number(metrics?.unmetSetpointRoomCount || 0);
        return candidateFailures <= baselineFailures;
      }
    }
  );

  addCandidate(
    'Reduce room target temperatures (minimum 18C)',
    (working) => {
      const cfg = measures.setpoint_optimization || {};
      const minSetpoint = Number(cfg.min_setpoint_c || 18);
      const step = Number(cfg.step_c || 1);
      const zones = Array.isArray(working?.zones) ? working.zones : [];
      let changedCount = 0;
      zones.forEach(zone => {
        if (!zone || zone.type === 'boundary' || zone.is_unheated === true) return;
        const currentSetpoint = Number(zone.setpoint_temperature);
        if (!isFinite(currentSetpoint) || currentSetpoint <= minSetpoint) return;
        const nextSetpoint = Math.max(minSetpoint, currentSetpoint - step);
        if (nextSetpoint < currentSetpoint) {
          zone.setpoint_temperature = Number(nextSetpoint.toFixed(2));
          changedCount += 1;
        }
      });
      return {
        changed: changedCount > 0,
        count: changedCount,
        proposal: `Reduce setpoint temperatures by ${step.toFixed(0)}C in ${changedCount} heated room(s), never below ${minSetpoint.toFixed(0)}C.`
      };
    },
    () => {
      const commissioning = Number((measures.setpoint_optimization || {}).commissioning_cost || 0);
      return {
        total: commissioning,
        breakdown: [
          { label: 'Heating controls setup and scheduling', amount: commissioning }
        ]
      };
    },
    {
      id: 'setpoint_reduce_min18',
      accept: ({ baselineComfort: baseComfort, candidateComfort: nextComfort }) => {
        const baselineBelowTarget = Number(baseComfort?.belowTargetCount || 0);
        const candidateBelowTarget = Number(nextComfort?.belowTargetCount || 0);
        // Only propose setpoint reduction once comfort targets are already met.
        if (baselineBelowTarget > 0) return false;
        // Never allow this measure to worsen target-comfort status.
        return candidateBelowTarget <= baselineBelowTarget;
      }
    }
  );

  addCandidate(
    'Upgrade windows to high-performance glazing',
    (working) => {
      const options = Array.isArray(openings.windows) ? openings.windows : [];
      if (options.length === 0) return { changed: false };
      const best = options
        .filter(opt => isFinite(Number(opt?.u_value)))
        .sort((a, b) => Number(a.u_value) - Number(b.u_value))[0];
      if (!best) return { changed: false };
      let changedArea = 0;
      let changedCount = 0;
      const changedPerWall = {};
      const fromTypeCounts = {};
      const elements = Array.isArray(working?.elements) ? working.elements : [];
      const resolveElementName = createUniqueElementNameResolver(elements, 'Wall');
      elements.forEach(element => {
        const windowsList = Array.isArray(element?.windows) ? element.windows : [];
        const wallName = resolveElementName(element, 'Unknown wall');
        windowsList.forEach(window => {
          const previousType = String(window?.glazing_id || '');
          if (previousType === String(best.id || '')) return;
          const area = Number(window?.area || 0);
          if (previousType) {
            fromTypeCounts[previousType] = Number(fromTypeCounts[previousType] || 0) + 1;
          }
          changedPerWall[wallName] = Number(changedPerWall[wallName] || 0) + 1;
          window.glazing_id = best.id;
          if (isFinite(Number(best.air_leakage_m3_h_m2))) {
            window.air_leakage_m3_h_m2 = Number(best.air_leakage_m3_h_m2);
          }
          if (typeof best.has_trickle_vent === 'boolean') {
            window.has_trickle_vent = best.has_trickle_vent;
          }
          if (isFinite(Number(best.trickle_vent_flow_m3_h))) {
            window.trickle_vent_flow_m3_h = Number(best.trickle_vent_flow_m3_h);
          }
          changedArea += isFinite(area) && area > 0 ? area : 1;
          changedCount += 1;
        });
      });
      const wallSummary = formatCountMap(changedPerWall);
      const fromSummary = formatTypeChangeMap(
        fromTypeCounts,
        typeId => String(getWindowCatalogEntry(typeId)?.name || typeId)
      );
      const targetName = String(best.name || best.id || 'high-performance glazing');
      return {
        changed: changedArea > 0,
        areaM2: changedArea,
        count: changedCount,
        windowOption: best,
        proposal: [
          `Walls impacted (window changes per wall): ${wallSummary}.`,
          `Window type change: ${fromSummary} -> ${targetName}.`,
          `Total windows changed: ${changedCount}; area affected: ${changedArea.toFixed(1)} m2.`
        ].join('\n')
      };
    },
    (change) => {
      const cfg = measures.window_upgrade || {};
      const optionMaterialPerM2 = Number(change.windowOption?.material_cost_per_m2_gbp);
      const materialPerM2 = isFinite(optionMaterialPerM2) && optionMaterialPerM2 > 0
        ? optionMaterialPerM2
        : Number(cfg.material_per_m2 || 0);
      const callout = Number(cfg.callout || 0);
      const material = change.areaM2 * materialPerM2;
      const install = change.areaM2 * Number(cfg.install_per_m2 || 0);
      return {
        total: callout + material + install,
        breakdown: [
          { label: 'Window contractor callout', amount: callout },
          { label: `Window units/material (${change.areaM2.toFixed(1)} m2)`, amount: material },
          { label: `Window installation (${change.areaM2.toFixed(1)} m2)`, amount: install }
        ]
      };
    },
    { id: 'window_upgrade_best' }
  );

  addCandidate(
    'Upgrade external doors to insulated doors',
    (working) => {
      const options = Array.isArray(openings.doors) ? openings.doors : [];
      if (options.length === 0) return { changed: false };
      const best = options
        .filter(opt => isFinite(Number(opt?.u_value)))
        .sort((a, b) => Number(a.u_value) - Number(b.u_value))[0];
      if (!best) return { changed: false };
      let changedCount = 0;
      const changedPerWall = {};
      const fromTypeCounts = {};
      const elements = Array.isArray(working?.elements) ? working.elements : [];
      const resolveElementName = createUniqueElementNameResolver(elements, 'Wall');
      elements.forEach(element => {
        const doorsList = Array.isArray(element?.doors) ? element.doors : [];
        const wallName = resolveElementName(element, 'Unknown wall');
        doorsList.forEach(door => {
          const previousType = String(door?.material_id || door?.glazing_id || '');
          if (previousType === String(best.id || '')) return;
          if (previousType) {
            fromTypeCounts[previousType] = Number(fromTypeCounts[previousType] || 0) + 1;
          }
          changedPerWall[wallName] = Number(changedPerWall[wallName] || 0) + 1;
          door.material_id = best.id;
          if (isFinite(Number(best.air_leakage_m3_h_m2))) {
            door.air_leakage_m3_h_m2 = Number(best.air_leakage_m3_h_m2);
          }
          changedCount += 1;
        });
      });
      const wallSummary = formatCountMap(changedPerWall);
      const fromSummary = formatTypeChangeMap(
        fromTypeCounts,
        typeId => String(getDoorCatalogEntry(typeId)?.name || typeId)
      );
      const targetName = String(best.name || best.id || 'insulated door units');
      return {
        changed: changedCount > 0,
        count: changedCount,
        doorOption: best,
        proposal: [
          `Walls impacted (door changes per wall): ${wallSummary}.`,
          `Door type change: ${fromSummary} -> ${targetName}.`,
          `Total doors changed: ${changedCount}.`
        ].join('\n')
      };
    },
    (change) => {
      const cfg = measures.door_upgrade || {};
      const optionMaterialEach = Number(change.doorOption?.material_cost_each_gbp);
      const materialEach = isFinite(optionMaterialEach) && optionMaterialEach > 0
        ? optionMaterialEach
        : Number(cfg.material_each || 0);
      const callout = Number(cfg.callout || 0);
      const material = change.count * materialEach;
      const install = change.count * Number(cfg.install_each || 0);
      return {
        total: callout + material + install,
        breakdown: [
          { label: 'Door installer callout', amount: callout },
          { label: `Door units (${change.count})`, amount: material },
          { label: `Door installation labour (${change.count})`, amount: install }
        ]
      };
    },
    { id: 'door_upgrade_best' }
  );

  addCandidate(
    'Insulate worst external wall',
    (working) => {
      const cfg = measures.wall_insulation_internal_retrofit || measures.external_wall_insulation || {};
      const layerMaterialId = String(cfg.insulation_material_id || 'pir');
      const elements = Array.isArray(working?.elements) ? working.elements : [];
      const resolveElementName = createUniqueElementNameResolver(elements, 'Wall');
      const templates = (working.meta && working.meta.build_up_templates) || {};
      const outsideBoundaryId = getBoundaryZoneId(working, 'outside');
      const externalWalls = elements
        .filter(element => isHeatedExternalWallElement(element, working, outsideBoundaryId))
        .filter(element => !isWallInternalRetrofitAlreadyApplied(element, templates));
      if (externalWalls.length === 0) return { changed: false };
      externalWalls.sort((a, b) => Number(b?.u_fabric || 0) - Number(a?.u_fabric || 0));
      const worst = externalWalls[0];
      const buildUp = resolveElementBuildUpForEdit(worst, templates);
      const thicknessPlan = getWallRetrofitThicknessFromBuildUp(buildUp, cfg);
      const addedThickness = thicknessPlan.totalAddedThickness;
      buildUp.push({
        material_id: layerMaterialId,
        thickness: Number(addedThickness.toFixed(3)),
        _retrofit_source: 'wall_internal_insulation'
      });
      worst.build_up = buildUp;
      delete worst.build_up_template_id;
      worst._internal_retrofit_applied = true;
      const wallName = resolveElementName(worst, 'Worst external wall');
      const layerMaterialName = getMaterialDisplayName(layerMaterialId);
      const areaM2 = getElementNetInsulationAreaM2(worst) || getElementAreaM2(worst) || 1;
      const studCapMm = Math.round(Number(cfg.max_within_stud_thickness_m || 0.1) * 1000);
      const withinStudMm = Math.round(thicknessPlan.withinStudThickness * 1000);
      const serviceLayerMm = Math.round(thicknessPlan.serviceThickness * 1000);
      const totalIncreaseMm = Math.round(addedThickness * 1000);
      return {
        changed: true,
        areaM2,
        materialVolumeM3: areaM2 * addedThickness,
        installMultiplier: thicknessPlan.addServiceLayer
          ? Number(cfg.service_layer_install_multiplier || 1.35)
          : 1,
        proposal: thicknessPlan.addServiceLayer
          ? [
            `Wall impacted: ${wallName}.`,
            `Material change: add ${layerMaterialName} (total ${totalIncreaseMm} mm) as internal retrofit layer.`,
            `Thickness split: within-stud ${withinStudMm} mm (cap ${studCapMm} mm) + service layer ${serviceLayerMm} mm.`
          ].join('\n')
          : [
            `Wall impacted: ${wallName}.`,
            `Material change: add ${layerMaterialName} (within-stud ${withinStudMm} mm, cap ${studCapMm} mm).`
          ].join('\n'),
        warning: `Warning: internal wall thickness will increase by ${totalIncreaseMm} mm if this recommendation is applied.`
      };
    },
    (change) => {
      const cfg = measures.wall_insulation_internal_retrofit || measures.external_wall_insulation || {};
      const materialPerM3 = getInsulationMaterialCostPerM3(cfg.insulation_material_id);
      const materialCost = materialPerM3 !== null
        ? (Number(change.materialVolumeM3 || 0) * materialPerM3)
        : (change.areaM2 * getInsulationMaterialCostPerM2(cfg.insulation_material_id, cfg.fallback_thickness_m, cfg.material_per_m2));
      const installMultiplier = Number(change.installMultiplier || 1);
      const callout = Number(cfg.callout || 0);
      const install = change.areaM2 * (Number(cfg.install_per_m2 || 0) * installMultiplier);
      return {
        total: callout + materialCost + install,
        breakdown: [
          { label: 'Internal wall retrofit callout', amount: callout },
          { label: 'Insulation material (no blockwork replacement)', amount: materialCost },
          { label: `Internal lining/insulation labour (${change.areaM2.toFixed(1)} m2)`, amount: install }
        ]
      };
    },
    { id: 'wall_internal_insulation_worst' }
  );

  addCandidate(
    'Insulate ground floors',
    (working) => {
      const cfg = measures.floor_insulation || {};
      const layerMaterialId = String(cfg.insulation_material_id || 'rockwool');
      const groundId = getBoundaryZoneId(working, 'ground');
      if (!groundId) return { changed: false };
      const elements = Array.isArray(working?.elements) ? working.elements : [];
      const resolveElementName = createUniqueElementNameResolver(elements, 'Floor');
      const templates = (working.meta && working.meta.build_up_templates) || {};
      let areaTotal = 0;
      let volumeTotal = 0;
      const impactedFloors = [];
      elements.forEach(element => {
        if (String(element?.type || '').toLowerCase() !== 'floor') return;
        const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
        if (!nodes.includes(groundId)) return;
        const beforeBuildUp = resolveElementBuildUpForEdit(element, templates);
        const previousIds = getFloorCompositeNonJoistMaterialIds(beforeBuildUp);
        const result = applyFloorCavityInsulationRetrofit(element, templates, cfg, layerMaterialId);
        if (!result.changed) return;
        const areaM2 = getElementAreaM2(element);
        areaTotal += areaM2;
        volumeTotal += areaM2 * result.thicknessM;
        impactedFloors.push({
          name: resolveElementName(element, 'Ground floor element'),
          fromMaterialNames: previousIds.map(getMaterialDisplayName),
          thicknessM: result.thicknessM
        });
      });
      const targetMaterialName = getMaterialDisplayName(layerMaterialId);
      const impactedList = impactedFloors.map(item => item.name).join(', ') || 'none';
      const materialChangeLines = impactedFloors.length > 0
        ? impactedFloors
            .map(item => {
              const fromLabel = item.fromMaterialNames.length > 0
                ? item.fromMaterialNames.join(' + ')
                : 'existing non-joist cavity material';
              return `${item.name}: ${fromLabel} -> ${targetMaterialName} (${formatThicknessMm(item.thicknessM)} within joist cavity)`;
            })
            .join('; ')
        : 'none';
      return {
        changed: areaTotal > 0,
        areaM2: areaTotal,
        materialVolumeM3: volumeTotal,
        proposal: [
          `Floors impacted: ${impactedList}.`,
          `Material changes: ${materialChangeLines}.`,
          `Scope: joist-cavity insulation only (no below-joist insulation build-up).`
        ].join('\n')
      };
    },
    (change) => {
      const cfg = measures.floor_insulation || {};
      const materialPerM3 = getInsulationMaterialCostPerM3(cfg.insulation_material_id);
      const materialCost = materialPerM3 !== null
        ? (Number(change.materialVolumeM3 || 0) * materialPerM3)
        : (change.areaM2 * getInsulationMaterialCostPerM2(cfg.insulation_material_id, cfg.fallback_thickness_m, cfg.material_per_m2));
      const callout = Number(cfg.callout || 0);
      const install = change.areaM2 * Number(cfg.install_per_m2 || 0);
      return {
        total: callout + materialCost + install,
        breakdown: [
          { label: 'Floor retrofit callout', amount: callout },
          { label: 'Insulation material', amount: materialCost },
          { label: `Floor insulation labour (${change.areaM2.toFixed(1)} m2)`, amount: install }
        ]
      };
    },
    { id: 'floor_insulation_topup' }
  );

  addCandidate(
    'Top up loft insulation',
    (working) => {
      const cfg = measures.loft_insulation || {};
      const layerMaterialId = String(cfg.insulation_material_id || 'rockwool');
      const loftId = getBoundaryZoneId(working, 'loft');
      if (!loftId) return { changed: false };
      const elements = Array.isArray(working?.elements) ? working.elements : [];
      const resolveElementName = createUniqueElementNameResolver(elements, 'Loft-facing element');
      const templates = (working.meta && working.meta.build_up_templates) || {};
      let areaTotal = 0;
      let volumeTotal = 0;
      const impactedElements = [];
      elements.forEach(element => {
        const type = String(element?.type || '').toLowerCase();
        if (type !== 'ceiling' && type !== 'floor_ceiling') return;
        const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
        if (!nodes.includes(loftId)) return;
        const buildUp = resolveElementBuildUpForEdit(element, templates);
        const loftPlan = getLoftInsulationThicknessFromBuildUp(buildUp, cfg);
        const addedThickness = loftPlan.totalAddedThickness;
        buildUp.push({ material_id: layerMaterialId, thickness: Number(addedThickness.toFixed(3)) });
        element.build_up = buildUp;
        delete element.build_up_template_id;
        const areaM2 = getElementAreaM2(element);
        areaTotal += areaM2;
        volumeTotal += areaM2 * addedThickness;
        impactedElements.push({
          name: resolveElementName(element, 'Loft-facing element'),
          thicknessM: addedThickness
        });
      });
      const materialName = getMaterialDisplayName(layerMaterialId);
      const impactedList = impactedElements.map(item => item.name).join(', ') || 'none';
      const materialChanges = impactedElements.length > 0
        ? impactedElements
            .map(item => `${item.name}: add ${materialName} ${formatThicknessMm(item.thicknessM)}`)
            .join('; ')
        : 'none';
      return {
        changed: areaTotal > 0,
        areaM2: areaTotal,
        materialVolumeM3: volumeTotal,
        proposal: [
          `Loft-facing fabric impacted: ${impactedList}.`,
          `Material changes: ${materialChanges}.`,
          `Top-up rule: within-joist depth plus optional above-joist layer capped at ${Math.round(Number(cfg.max_above_joist_thickness_m || 0.5) * 1000)} mm.`
        ].join('\n')
      };
    },
    (change) => {
      const cfg = measures.loft_insulation || {};
      const materialPerM3 = getInsulationMaterialCostPerM3(cfg.insulation_material_id);
      const materialCost = materialPerM3 !== null
        ? (Number(change.materialVolumeM3 || 0) * materialPerM3)
        : (change.areaM2 * getInsulationMaterialCostPerM2(cfg.insulation_material_id, cfg.fallback_thickness_m, cfg.material_per_m2));
      const callout = Number(cfg.callout || 0);
      const install = change.areaM2 * Number(cfg.install_per_m2 || 0);
      return {
        total: callout + materialCost + install,
        breakdown: [
          { label: 'Loft insulation callout', amount: callout },
          { label: 'Insulation material', amount: materialCost },
          { label: `Loft insulation labour (${change.areaM2.toFixed(1)} m2)`, amount: install }
        ]
      };
    },
    { id: 'loft_insulation_topup' }
  );

  addCandidate(
    'Switch heating source to heat pump',
    (working) => {
      working.meta = working.meta || {};
      const currentSource = String(working.meta.heatSourceType || baselineHeatingInputs.heatSourceType || 'gas_boiler');
      if (currentSource === 'heat_pump') return { changed: false };
      working.meta.heatSourceType = 'heat_pump';
      return {
        changed: true,
        from: currentSource,
        to: 'heat_pump',
        proposal: `Switch primary heat source from ${currentSource.replace('_', ' ')} to heat pump while keeping current fabric and control assumptions.`
      };
    },
    () => getSystemSwitchCost('heat_pump'),
    { id: 'heat_source_swap_heat_pump' }
  );

  addCandidate(
    'Switch heating source to gas boiler',
    (working) => {
      working.meta = working.meta || {};
      const currentSource = String(working.meta.heatSourceType || baselineHeatingInputs.heatSourceType || 'gas_boiler');
      if (currentSource === 'gas_boiler') return { changed: false };
      working.meta.heatSourceType = 'gas_boiler';
      return {
        changed: true,
        from: currentSource,
        to: 'gas_boiler',
        proposal: `Switch primary heat source from ${currentSource.replace('_', ' ')} to gas boiler while keeping current fabric and control assumptions.`
      };
    },
    () => getSystemSwitchCost('gas_boiler'),
    { id: 'heat_source_swap_gas_boiler' }
  );

  addCandidate(
    'Switch heating source to direct electric radiators',
    (working) => {
      working.meta = working.meta || {};
      const currentSource = String(working.meta.heatSourceType || baselineHeatingInputs.heatSourceType || 'gas_boiler');
      if (currentSource === 'direct_electric') return { changed: false };
      working.meta.heatSourceType = 'direct_electric';
      return {
        changed: true,
        from: currentSource,
        to: 'direct_electric',
        proposal: [
          `Switch primary heat source from ${currentSource.replace('_', ' ')} to direct electric emitters.`,
          'Only recommended where tariffs and installation constraints make this unusually cost-effective.'
        ].join('\n')
      };
    },
    () => getSystemSwitchCost('direct_electric'),
    {
      id: 'heat_source_swap_direct_electric',
      accept: ({ baseline, metrics, change }) => {
        if (String(change?.from || '') !== 'gas_boiler') return false;
        const annualCostSavings = Math.max(0, Number(baseline?.annualRunningCost || 0) - Number(metrics?.annualRunningCost || 0));
        return annualCostSavings >= 150;
      }
    }
  );

  const deficits = getComfortDeficitRoomsForDemo(demoRaw);
  const hasRadiatorComfortRecommendation = results.some(item => item.recommendationId === 'radiator_upgrade_unmet');
  if (!hasRadiatorComfortRecommendation && Number(deficits.count || 0) > 0) {
    const flowCfg = measures.flow_temp_optimization || {};
    const trvCfg = measures.trv || {};
    const radCfg = measures.radiator_upgrade || {};

    const fallbackArea = (Array.isArray(deficits.rooms) ? deficits.rooms : [])
      .reduce((sum, room) => sum + Math.max(0.8, Math.min(4.5, Number(room?.shortfallC || 0) * 0.9)), 0);
    const trvCount = Math.max(0, Number(deficits.count || 0));
    const callout = Number(radCfg.callout || 0);
    const material = fallbackArea * Number(radCfg.cost_per_m2_surface_area || 45);
    const install = fallbackArea * 85;
    const trvMaterial = trvCount * Number(trvCfg.valve_material_each || 0);
    const trvInstall = trvCount * Number(trvCfg.install_each || 0);
    const flowCommissioning = Number(flowCfg.commissioning_cost || 0);
    const costModel = {
      total: callout + material + install + trvMaterial + trvInstall + flowCommissioning,
      breakdown: [
        { label: 'Plumber callout', amount: callout },
        { label: `Radiator material (${fallbackArea.toFixed(1)} m2)`, amount: material },
        { label: `Radiator installation labour (${fallbackArea.toFixed(1)} m2)`, amount: install },
        { label: `TRV valves (${trvCount})`, amount: trvMaterial },
        { label: `TRV installation labour (${trvCount})`, amount: trvInstall },
        { label: 'Flow temperature commissioning', amount: flowCommissioning }
      ]
    };
    const normalizedCost = normalizeCostResult(costModel, currency);
    const sampleRooms = (Array.isArray(deficits.rooms) ? deficits.rooms : [])
      .slice(0, 8)
      .map(room => `${room.zoneName}: ${Number(room.currentTemp || 0).toFixed(1)}C -> ${Number(room.targetTemp || 18).toFixed(1)}C`)
      .join('; ');

    results.push({
      recommendationId: 'radiator_upgrade_unmet',
      recommendation: 'Add/upgrade radiators for comfort',
      annualSavingsKwhYr: 0,
      annualCostSavings: 0,
      annualCostSavingsText: formatCurrencyEstimate(0, currency),
      simplePaybackYears: null,
      simplePaybackText: 'n/a',
      expectedEpc: baseline.epcLetter || 'N/A',
      costEstimate: formatCurrencyEstimate(normalizedCost.total, currency),
      proposal: [
        `Final comfort pass found ${deficits.count} room(s) below target (including ${deficits.below18Count} below 18C).`,
        `Rooms: ${sampleRooms || 'See room heat report for full list.'}.`,
        `Recommend emitter upgrades with TRVs and flow temperature optimization to lift all rooms to at least 18C, ideally to setpoint.`
      ].join('\n'),
      costBreakdown: Array.isArray(normalizedCost.formattedBreakdown) ? normalizedCost.formattedBreakdown : [],
      _comfortImprovement: 100000 + (Number(deficits.below18Count || 0) * 1000) + (Number(deficits.count || 0) * 100),
      _annualCostSavings: 0,
      _annualInputSavings: 0,
      _sortCost: isFinite(Number(normalizedCost.total)) ? Number(normalizedCost.total) : Infinity
    });
  }

  // Add room-based worst-wall insulation recommendations
  const zones = Array.isArray(demoRaw?.zones) ? demoRaw.zones : [];
  const elements = Array.isArray(demoRaw?.elements) ? demoRaw.elements : [];
  const templates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
  const outsideBoundaryId = getBoundaryZoneId(demoRaw, 'outside');
  const groundId = getBoundaryZoneId(demoRaw, 'ground');
  const loftId = getBoundaryZoneId(demoRaw, 'loft');
  const zoneById = new Map(zones.map(zone => [String(zone?.id || ''), zone]));
  const resolveElementName = createUniqueElementNameResolver(elements, 'Wall');
  const wallCfg = measures.wall_insulation_internal_retrofit || measures.external_wall_insulation || {};
  const floorCfg = measures.floor_insulation || {};
  const loftCfg = measures.loft_insulation || {};

  const roomsForWallUpgrade = zones.filter(z => z && z.type !== 'boundary' && z.is_unheated !== true);
  
  roomsForWallUpgrade.forEach(room => {
    const roomId = String(room?.id || '');
    const roomName = String(room?.name || room?.id || 'Unknown room');
    
    // Find external walls connected to this room
    const externalWallsInRoom = elements
      .filter(el => {
        if (String(el?.type || '').toLowerCase() !== 'wall') return false;
        if (!outsideBoundaryId) return false;
        const nodes = Array.isArray(el?.nodes) ? el.nodes : [];
        // Must have outside boundary and this room's zone
        if (!nodes.includes(outsideBoundaryId)) return false;
        if (!nodes.includes(roomId)) return false;
        return !isWallInternalRetrofitAlreadyApplied(el, templates);
      });
    
    if (externalWallsInRoom.length === 0) return; // No walls to upgrade in this room
    
    // Create room-specific recommendation (for all external walls in room)
    const recommendationIdBase = `wall_insulation_room_${String(roomId).slice(-8).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const alreadyExists = results.some(r => r.recommendationId === recommendationIdBase);
    if (alreadyExists) return;
    
    const candidateDemo = deepClone(demoRaw);
    const candidateElements = Array.isArray(candidateDemo?.elements) ? candidateDemo.elements : [];
    const layerMaterialId = String(wallCfg.insulation_material_id || 'pir');
    
    // Upgrade ALL external walls in this room
    let totalWallArea = 0;
    let wallUpgradeCount = 0;
    const wallUpgradeSummary = [];
    
    externalWallsInRoom.forEach(sourceWall => {
      const candidateWall = candidateElements.find(el => String(el?.id || '') === String(sourceWall?.id || ''));
      if (!candidateWall) return;
      
      const buildUp = resolveElementBuildUpForEdit(candidateWall, templates);
      const thicknessPlan = getWallRetrofitThicknessFromBuildUp(buildUp, wallCfg);
      const addedThickness = thicknessPlan.totalAddedThickness;
      
      buildUp.push({
        material_id: layerMaterialId,
        thickness: Number(addedThickness.toFixed(3)),
        _retrofit_source: 'wall_internal_insulation_room'
      });
      candidateWall.build_up = buildUp;
      delete candidateWall.build_up_template_id;
      candidateWall._internal_retrofit_applied = true;
      
      const wallArea = getElementNetInsulationAreaM2(sourceWall) || getElementAreaM2(sourceWall) || 1;
      totalWallArea += wallArea;
      wallUpgradeCount += 1;
      
      const wallName = resolveElementName(sourceWall, 'External wall');
      wallUpgradeSummary.push(`${wallName} (${wallArea.toFixed(1)} m²)`);
    });
    
    if (wallUpgradeCount === 0) return;
    
    // Evaluate the change
    const metrics = getComparisonMetricsForDemo(candidateDemo);
    if (!metrics || !isFinite(metrics.annualDemandKwhYr)) return;
    
    const candidateComfort = getComfortSnapshotForDemo(candidateDemo);
    if (!candidateComfort) return;
    
    const roomTempDropsWhenCold = baselineComfort.below18Count > 0
      && Object.entries(baselineComfort.zoneTempById || {}).some(([zoneId, baselineTemp]) => {
        const nextTemp = Number((candidateComfort.zoneTempById || {})[zoneId]);
        const baseTemp = Number(baselineTemp);
        return isFinite(baseTemp) && isFinite(nextTemp) && (nextTemp < baseTemp - 0.05);
      });
    if (roomTempDropsWhenCold) return;
    
    const annualSavings = Math.max(0, baseline.annualDemandKwhYr - metrics.annualDemandKwhYr);
    const annualCostSavings = Math.max(0, Number(baselineRunningCost.annualCost || 0) - Number(metrics.annualRunningCost || 0));
    const below18Reduction = Math.max(0, Number(baselineComfort?.below18Count || 0) - Number(candidateComfort?.below18Count || 0));
    const belowTargetReduction = Math.max(0, Number(baselineComfort?.belowTargetCount || 0) - Number(candidateComfort?.belowTargetCount || 0));
    const unmetReduction = Math.max(0, Number(baselineComfort?.unmetSetpointRoomCount || 0) - Number(candidateComfort?.unmetSetpointRoomCount || 0));
    const baselineMinTemp = Number(baselineComfort?.minDeliveredTemp);
    const candidateMinTemp = Number(candidateComfort?.minDeliveredTemp);
    const minTempLift = isFinite(baselineMinTemp) && isFinite(candidateMinTemp)
      ? Math.max(0, candidateMinTemp - baselineMinTemp)
      : 0;
    const comfortImprovement = (belowTargetReduction * 200) + (below18Reduction * 100) + (unmetReduction * 10) + minTempLift;
    
    if (!isFinite(annualSavings) || (annualSavings < 1 && annualCostSavings < 0.5 && comfortImprovement <= 0)) return;
    
    // Calculate cost for all walls
    const wallMaterialPerM3 = getInsulationMaterialCostPerM3(wallCfg.insulation_material_id);
    let wallMaterialCost = 0;
    let wallInstallValue = 0;
    let totalWallVolume = 0;
    
    externalWallsInRoom.forEach(sourceWall => {
      const buildUp = resolveElementBuildUpForEdit(sourceWall, templates);
      const thicknessPlan = getWallRetrofitThicknessFromBuildUp(buildUp, wallCfg);
      const addedThickness = thicknessPlan.totalAddedThickness;
      const wArea = getElementNetInsulationAreaM2(sourceWall) || getElementAreaM2(sourceWall) || 1;
      
      totalWallVolume += wArea * addedThickness;
      
      const perM3Cost = wallMaterialPerM3 !== null
        ? (wArea * addedThickness * wallMaterialPerM3)
        : (wArea * getInsulationMaterialCostPerM2(wallCfg.insulation_material_id, wallCfg.fallback_thickness_m, wallCfg.material_per_m2));
      wallMaterialCost += perM3Cost;
      
      const installMult = thicknessPlan.addServiceLayer ? Number(wallCfg.service_layer_install_multiplier || 1.35) : 1;
      wallInstallValue += wArea * (Number(wallCfg.install_per_m2 || 0) * installMult);
    });
    
    const totalCost = Number(wallCfg.callout || 0) + wallMaterialCost + wallInstallValue;
    
    const paybackYears = annualCostSavings > 0 && totalCost > 0
      ? totalCost / annualCostSavings
      : null;
    
    // Build proposal text
    const wallListText = wallUpgradeSummary.join('; ');
    const layerMaterialName = getMaterialDisplayName(layerMaterialId);
    const proposalParts = [
      `Insulate all external walls in ${roomName}: ${wallListText}.`,
      `Wall improvement: add ${layerMaterialName} as internal retrofit (${wallUpgradeCount} walls, net insulatable area ${totalWallArea.toFixed(1)} m²).`,
      'Cost scope excludes external blockwork rebuild and includes internal insulation plus lining works only.'
    ];
    
    const costBreakdown = [
      { label: `All external walls (${wallUpgradeCount} walls, ${totalWallArea.toFixed(1)} m²)`, amount: Number(wallCfg.callout || 0) + wallMaterialCost + wallInstallValue }
    ];
    
    const normalizedCost = normalizeCostResult({ total: totalCost, breakdown: costBreakdown }, currency);
    
    results.push({
      recommendationId: recommendationIdBase,
      recommendation: `Insulate all external walls in ${roomName}`,
      annualSavingsKwhYr: Number(annualSavings.toFixed(0)),
      annualCostSavings: Number(annualCostSavings.toFixed(0)),
      annualCostSavingsText: formatCurrencyEstimate(annualCostSavings, currency),
      simplePaybackYears: paybackYears,
      simplePaybackText: Number.isFinite(paybackYears) ? `${paybackYears.toFixed(1)} years` : 'n/a',
      expectedEpc: metrics.epcLetter || 'N/A',
      costEstimate: formatCurrencyEstimate(totalCost, currency),
      proposal: proposalParts.join('\n'),
      costBreakdown: Array.isArray(normalizedCost.formattedBreakdown)
        ? normalizedCost.formattedBreakdown
        : [],
      _comfortImprovement: comfortImprovement,
      _annualCostSavings: annualCostSavings,
      _annualInputSavings: Math.max(0, Number(baseline.annualInputEnergyKwhYr || 0) - Number(metrics.annualInputEnergyKwhYr || 0)),
      _sortCost: isFinite(totalCost) ? totalCost : Infinity
    });
  });

  // Filter out recommendations with payback > 100 years (too marginal to recommend)
  const recommendationsWithReasonablePayback = results.filter(rec => {
    const payback = rec.simplePaybackYears;
    if (payback === null) return true; // Keep if no payback calculation (comfort-only)
    return payback <= 100;
  });

  recommendationsWithReasonablePayback.sort((a, b) => {
    // Priority 1: Comfort improvements (rooms reaching setpoint/18C) — higher is better
    if (b._comfortImprovement !== a._comfortImprovement) {
      return b._comfortImprovement - a._comfortImprovement;
    }
    // Priority 2: Annual bill savings — higher is better
    if (b._annualCostSavings !== a._annualCostSavings) {
      return b._annualCostSavings - a._annualCostSavings;
    }
    // Priority 3: Annual input-energy savings — higher is better
    if (b._annualInputSavings !== a._annualInputSavings) {
      return b._annualInputSavings - a._annualInputSavings;
    }
    // Priority 4: Annual delivered-energy savings — higher is better
    if (b.annualSavingsKwhYr !== a.annualSavingsKwhYr) {
      return b.annualSavingsKwhYr - a.annualSavingsKwhYr;
    }
    // Priority 5: Capex — lower is better
    return a._sortCost - b._sortCost;
  });

  return recommendationsWithReasonablePayback.slice(0, 8).map(item => ({
    recommendationId: item.recommendationId,
    recommendation: item.recommendation,
    annualSavingsKwhYr: item.annualSavingsKwhYr,
    annualCostSavings: item.annualCostSavings,
    annualCostSavingsText: item.annualCostSavingsText,
    simplePaybackYears: item.simplePaybackYears,
    simplePaybackText: item.simplePaybackText,
    expectedEpc: item.expectedEpc || getEpcBandFromIntensity(null),
    costEstimate: item.costEstimate,
    proposal: item.proposal,
    warning: item.warning || null,
    costBreakdown: Array.isArray(item.costBreakdown) ? item.costBreakdown : []
  }));
}

export function applyRecommendationById(demoRaw, recommendationId, context = {}) {
  const { currentCosts = null, currentOpenings = null, helpers = {} } = context || {};
  const { applyRadiatorComfortUpgrade, getBoundaryZoneId, isHeatedExternalWallElement, isWallInternalRetrofitAlreadyApplied, resolveElementBuildUpForEdit, getWallRetrofitThicknessFromBuildUp, applyFloorCavityInsulationRetrofit, getLoftInsulationThicknessFromBuildUp } = helpers;

  if (!demoRaw || !recommendationId) return false;
  const recId = String(recommendationId);
  const measures = (getRecommendationCostModel(currentCosts).measures || {});

  if (recId === 'trv_add') {
    let changed = false;
    (Array.isArray(demoRaw.zones) ? demoRaw.zones : []).forEach(zone => {
      (Array.isArray(zone?.radiators) ? zone.radiators : []).forEach(rad => {
        if (rad?.trv_enabled === true) return;
        rad.trv_enabled = true;
        changed = true;
      });
    });
    return changed;
  }

  if (recId === 'radiator_upgrade_unmet') {
    const flowCfg = measures.flow_temp_optimization || {};
    const radCfg = measures.radiator_upgrade || {};
    const plan = applyRadiatorComfortUpgrade(demoRaw, {
      targetFlowTemp: Number(flowCfg.target_c || 45),
      maxComfortFlowTemp: Number(flowCfg.max_comfort_c || 75),
      sizingOverheadFactor: Number(radCfg.sizing_overhead_factor || 1.15)
    });
    return plan.changed === true;
  }

  if (recId === 'flow_temp_reduce') {
    const cfg = measures.flow_temp_optimization || {};
    const target = Number(cfg.target_c || 45);
    demoRaw.meta = demoRaw.meta || {};
    const current = Number(demoRaw.meta.flowTemp);
    const currentSafe = isFinite(current) ? current : 55;
    if (currentSafe <= target + 0.5) return false;
    demoRaw.meta.flowTemp = target;
    return true;
  }

  if (recId === 'setpoint_reduce_min18') {
    const cfg = measures.setpoint_optimization || {};
    const minSetpoint = Number(cfg.min_setpoint_c || 18);
    const step = Number(cfg.step_c || 1);
    let changed = false;
    (Array.isArray(demoRaw.zones) ? demoRaw.zones : []).forEach(zone => {
      if (!zone || zone.type === 'boundary' || zone.is_unheated === true) return;
      const currentSetpoint = Number(zone.setpoint_temperature);
      if (!isFinite(currentSetpoint) || currentSetpoint <= minSetpoint) return;
      const nextSetpoint = Math.max(minSetpoint, currentSetpoint - step);
      if (nextSetpoint < currentSetpoint) {
        zone.setpoint_temperature = Number(nextSetpoint.toFixed(2));
        changed = true;
      }
    });
    return changed;
  }

  if (recId === 'heat_source_swap_heat_pump') {
    demoRaw.meta = demoRaw.meta || {};
    const currentSource = String(demoRaw.meta.heatSourceType || 'gas_boiler');
    if (currentSource === 'heat_pump') return false;
    demoRaw.meta.heatSourceType = 'heat_pump';
    return true;
  }

  if (recId === 'heat_source_swap_gas_boiler') {
    demoRaw.meta = demoRaw.meta || {};
    const currentSource = String(demoRaw.meta.heatSourceType || 'gas_boiler');
    if (currentSource === 'gas_boiler') return false;
    demoRaw.meta.heatSourceType = 'gas_boiler';
    return true;
  }

  if (recId === 'heat_source_swap_direct_electric') {
    demoRaw.meta = demoRaw.meta || {};
    const currentSource = String(demoRaw.meta.heatSourceType || 'gas_boiler');
    if (currentSource === 'direct_electric') return false;
    demoRaw.meta.heatSourceType = 'direct_electric';
    return true;
  }

  if (recId === 'window_upgrade_best') {
    const options = Array.isArray(currentOpenings?.windows) ? currentOpenings.windows : [];
    if (options.length === 0) return false;
    const best = options.filter(opt => isFinite(Number(opt?.u_value))).sort((a, b) => Number(a.u_value) - Number(b.u_value))[0];
    if (!best) return false;
    let changed = false;
    (Array.isArray(demoRaw.elements) ? demoRaw.elements : []).forEach(element => {
      (Array.isArray(element?.windows) ? element.windows : []).forEach(window => {
        if (String(window?.glazing_id || '') === String(best.id || '')) return;
        window.glazing_id = best.id;
        if (isFinite(Number(best.air_leakage_m3_h_m2))) window.air_leakage_m3_h_m2 = Number(best.air_leakage_m3_h_m2);
        if (typeof best.has_trickle_vent === 'boolean') window.has_trickle_vent = best.has_trickle_vent;
        if (isFinite(Number(best.trickle_vent_flow_m3_h))) window.trickle_vent_flow_m3_h = Number(best.trickle_vent_flow_m3_h);
        changed = true;
      });
    });
    return changed;
  }

  if (recId === 'door_upgrade_best') {
    const options = Array.isArray(currentOpenings?.doors) ? currentOpenings.doors : [];
    if (options.length === 0) return false;
    const best = options.filter(opt => isFinite(Number(opt?.u_value))).sort((a, b) => Number(a.u_value) - Number(b.u_value))[0];
    if (!best) return false;
    let changed = false;
    (Array.isArray(demoRaw.elements) ? demoRaw.elements : []).forEach(element => {
      (Array.isArray(element?.doors) ? element.doors : []).forEach(door => {
        if (String(door?.material_id || door?.glazing_id || '') === String(best.id || '')) return;
        door.material_id = best.id;
        if (isFinite(Number(best.air_leakage_m3_h_m2))) door.air_leakage_m3_h_m2 = Number(best.air_leakage_m3_h_m2);
        changed = true;
      });
    });
    return changed;
  }

  if (recId === 'wall_internal_insulation_worst') {
    const cfg = measures.wall_insulation_internal_retrofit || measures.external_wall_insulation || {};
    const layerMaterialId = String(cfg.insulation_material_id || 'pir');
    const outsideBoundaryId = getBoundaryZoneId(demoRaw, 'outside');
    const templates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
    const externalWalls = (Array.isArray(demoRaw.elements) ? demoRaw.elements : [])
      .filter(element => isHeatedExternalWallElement(element, demoRaw, outsideBoundaryId))
      .filter(element => !isWallInternalRetrofitAlreadyApplied(element, templates));
    if (externalWalls.length === 0) return false;
    externalWalls.sort((a, b) => Number(b?.u_fabric || 0) - Number(a?.u_fabric || 0));
    const worst = externalWalls[0];
    const buildUp = resolveElementBuildUpForEdit(worst, templates);
    const thicknessPlan = getWallRetrofitThicknessFromBuildUp(buildUp, cfg);
    const addedThickness = thicknessPlan.totalAddedThickness;
    buildUp.push({
      material_id: layerMaterialId,
      thickness: Number(addedThickness.toFixed(3)),
      _retrofit_source: 'wall_internal_insulation'
    });
    worst.build_up = buildUp;
    delete worst.build_up_template_id;
    worst._internal_retrofit_applied = true;
    return true;
  }

  if (recId === 'floor_insulation_topup') {
    const cfg = measures.floor_insulation || {};
    const layerMaterialId = String(cfg.insulation_material_id || 'rockwool');
    const groundId = getBoundaryZoneId(demoRaw, 'ground');
    if (!groundId) return false;
    const templates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
    let changed = false;
    (Array.isArray(demoRaw.elements) ? demoRaw.elements : []).forEach(element => {
      if (String(element?.type || '').toLowerCase() !== 'floor') return;
      const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
      if (!nodes.includes(groundId)) return;
      const result = applyFloorCavityInsulationRetrofit(element, templates, cfg, layerMaterialId);
      if (result.changed) changed = true;
    });
    return changed;
  }

  if (recId === 'loft_insulation_topup') {
    const cfg = measures.loft_insulation || {};
    const layerMaterialId = String(cfg.insulation_material_id || 'rockwool');
    const loftId = getBoundaryZoneId(demoRaw, 'loft');
    if (!loftId) return false;
    const templates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
    let changed = false;
    (Array.isArray(demoRaw.elements) ? demoRaw.elements : []).forEach(element => {
      const type = String(element?.type || '').toLowerCase();
      if (type !== 'ceiling' && type !== 'floor_ceiling') return;
      const nodes = Array.isArray(element?.nodes) ? element.nodes : [];
      if (!nodes.includes(loftId)) return;
      const buildUp = resolveElementBuildUpForEdit(element, templates);
      const loftPlan = getLoftInsulationThicknessFromBuildUp(buildUp, cfg);
      const addedThickness = loftPlan.totalAddedThickness;
      buildUp.push({ material_id: layerMaterialId, thickness: Number(addedThickness.toFixed(3)) });
      element.build_up = buildUp;
      delete element.build_up_template_id;
      changed = true;
    });
    return changed;
  }

  // Handle room-based wall insulation recommendations
  if (recId.startsWith('wall_insulation_room_')) {
    const cfg = measures.wall_insulation_internal_retrofit || measures.external_wall_insulation || {};
    const layerMaterialId = String(cfg.insulation_material_id || 'pir');
    
    const zones = Array.isArray(demoRaw?.zones) ? demoRaw.zones : [];
    const elements = Array.isArray(demoRaw?.elements) ? demoRaw.elements : [];
    const templates = (demoRaw.meta && demoRaw.meta.build_up_templates) || {};
    const outsideBoundaryId = getBoundaryZoneId(demoRaw, 'outside');
    
    
    // Try to find matching room (rec ID contains room ID hash last 8 chars)
    let targetRoom = null;
    const zoneById = new Map(zones.map(zone => [String(zone?.id || ''), zone]));
    
    // Match room by checking which room's wall insulation recommendation ID matches
    for (const zone of zones) {
      if (!zone || zone.type === 'boundary' || zone.is_unheated === true) continue;
      const testId = `wall_insulation_room_${String(zone?.id || '').slice(-8).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (testId === recId) {
        targetRoom = zone;
        break;
      }
    }
    
    if (!targetRoom) return false;
    
    const roomId = String(targetRoom?.id || '');
    let changed = false;
    
    // Find and upgrade ALL external walls in this room
    const externalWallsInRoom = elements
      .filter(el => {
        if (String(el?.type || '').toLowerCase() !== 'wall') return false;
        if (!outsideBoundaryId) return false;
        const nodes = Array.isArray(el?.nodes) ? el.nodes : [];
        if (!nodes.includes(outsideBoundaryId)) return false;
        if (!nodes.includes(roomId)) return false;
        return !isWallInternalRetrofitAlreadyApplied(el, templates);
      });
    
    if (externalWallsInRoom.length > 0) {
      // Upgrade all walls (not just worst)
      externalWallsInRoom.forEach(wall => {
        const buildUp = resolveElementBuildUpForEdit(wall, templates);
        const thicknessPlan = getWallRetrofitThicknessFromBuildUp(buildUp, cfg);
        const addedThickness = thicknessPlan.totalAddedThickness;
        
        buildUp.push({
          material_id: layerMaterialId,
          thickness: Number(addedThickness.toFixed(3)),
          _retrofit_source: 'wall_internal_insulation_room'
        });
        wall.build_up = buildUp;
        delete wall.build_up_template_id;
        wall._internal_retrofit_applied = true;
        changed = true;
      });
    }
    
    return changed;
  }

  return false;

}
