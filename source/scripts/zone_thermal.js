// Shared thermal color classification and mapping for zone visualizations.

import { zoneHasTrv } from './zone_text.js';

export const THERMAL_COLOR_BY_CLASS = {
  'thermal-unheated': '#4c4c4c',
  'thermal-extreme-cold': '#1840a8',
  'thermal-cold': '#2f78df',
  'thermal-cool': '#2f78df',
  'thermal-neutral': '#1ea85a',
  'thermal-warm': '#dd5a33',
  'thermal-hot': '#dd5a33',
  'thermal-extreme-hot': '#bb2525'
};

export function getThermalColorClass(zone) {
  if (!zone || zone.is_unheated === true) return 'thermal-unheated';

  const setpoint = typeof zone.setpoint_temperature === 'number' ? zone.setpoint_temperature : null;
  const actual = typeof zone.max_achievable_temperature === 'number' ? zone.max_achievable_temperature : null;
  if (setpoint === null || actual === null) return 'thermal-neutral';

  const hasTrv = zoneHasTrv(zone);
  const isControlRoom = zone.is_boiler_control === true;
  const canReachSetpoint = zone.can_reach_setpoint !== false;

  let delta;
  if (isControlRoom && canReachSetpoint) {
    delta = 0;
  } else if (hasTrv && canReachSetpoint) {
    delta = 0;
  } else {
    delta = actual - setpoint;
  }

  if (delta <= -2.0) return 'thermal-extreme-cold';
  if (delta <= -0.4) return 'thermal-cold';
  if (delta < 0.4) return 'thermal-neutral';
  if (delta < 2.0) return 'thermal-hot';
  return 'thermal-extreme-hot';
}
