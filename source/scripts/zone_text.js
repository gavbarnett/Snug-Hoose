// Shared zone text/label helpers used across visualizations.

export function zoneHasTrv(zone) {
  if (!zone || !Array.isArray(zone.radiators)) return false;
  return zone.radiators.some(rad => rad && rad.trv_enabled === true);
}

export function getDisplayedZoneTemperature(zone, externalTemp) {
  if (!zone) return null;

  const maxTemp = typeof zone.max_achievable_temperature === 'number' ? zone.max_achievable_temperature : null;
  const deliveredTemp = typeof zone.delivered_indoor_temperature === 'number' ? zone.delivered_indoor_temperature : null;
  const setpoint = typeof zone.setpoint_temperature === 'number' ? zone.setpoint_temperature : null;
  const canReachSetpoint = zone.can_reach_setpoint !== false;
  const isControlRoom = zone.is_boiler_control === true;
  const hasTrv = zoneHasTrv(zone);

  if (zone.is_unheated === true) {
    return deliveredTemp ?? maxTemp ?? externalTemp;
  }

  if (isControlRoom) {
    return canReachSetpoint ? setpoint : (deliveredTemp ?? maxTemp ?? setpoint);
  }

  if (hasTrv && canReachSetpoint) {
    return setpoint;
  }

  return maxTemp ?? deliveredTemp ?? setpoint;
}

export function formatZoneTemperatureText(zone, externalTemp) {
  const displayTemp = getDisplayedZoneTemperature(zone, externalTemp);
  if (displayTemp === null) return null;

  const setpoint = typeof zone?.setpoint_temperature === 'number' ? zone.setpoint_temperature : null;
  const setpointText = setpoint !== null ? ` [ ${setpoint.toFixed(1)}°C]` : '';
  return `🌡️ ${displayTemp.toFixed(1)}°C${setpointText}`;
}

export function getZoneCapacitySummary(zone, externalTemp) {
  if (!zone || zone.is_unheated === true) return null;

  const maxTemp = typeof zone.max_achievable_temperature === 'number' ? zone.max_achievable_temperature : null;
  const setpoint = typeof zone.setpoint_temperature === 'number' ? zone.setpoint_temperature : null;
  const canReachSetpoint = zone.can_reach_setpoint !== false;
  if (maxTemp === null || setpoint === null) return null;

  const requiredLift = Math.max(0, setpoint - externalTemp);
  const availableLift = Math.max(0, maxTemp - externalTemp);
  const capacityPctRaw = requiredLift > 0 ? (availableLift / requiredLift) * 100 : 100;
  const capacityPct = Number(capacityPctRaw.toFixed(0));

  let capacitySymbol = '✓';
  let capacityState = 'good';
  if (!canReachSetpoint || capacityPctRaw < 100) {
    capacitySymbol = '⚠️';
    capacityState = 'bad';
  } else if (capacityPctRaw > 130) {
    capacitySymbol = '⬆';
    capacityState = 'excessive';
  }

  const text = `Capacity: ${capacityPct}% ${capacitySymbol}`;
  const title = capacityState === 'bad'
    ? `Insufficient capacity: ${zone.radiator_output?.toFixed(0) || 0}W output vs ${zone.heat_loss?.toFixed(0) || 0}W needed at ${zone.setpoint_temperature}°C`
    : (capacityState === 'excessive'
      ? `Excess radiator capacity at current flow: ${capacityPct}% of temperature lift requirement`
      : `Capacity is in range: ${capacityPct}% of temperature lift requirement`);

  return { text, title };
}

export function getZoneSavingsText(zone) {
  if (!zone || zone.is_unheated === true) return null;
  if (typeof zone.heat_savings !== 'number' || zone.heat_savings <= 0) return null;

  const savingsW = typeof zone.delivered_heat_savings === 'number' ? zone.delivered_heat_savings : zone.heat_savings;
  const annualSavings = (savingsW * 24 * 365) / 1000;
  return `Savings: ${annualSavings.toFixed(0)} kWh/yr`;
}

export function getZoneAchText(zone) {
  if (!zone || zone.is_unheated === true) return null;
  if (typeof zone.air_changes_per_hour !== 'number' || !isFinite(zone.air_changes_per_hour)) return null;
  return `ACH: ${zone.air_changes_per_hour.toFixed(2)}`;
}
