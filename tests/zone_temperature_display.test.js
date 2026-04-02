import { describe, expect, it } from 'vitest';
import { getDisplayedZoneTemperature } from '../source/scripts/zone_text.js';
import { getThermalColorClass } from '../source/scripts/zone_thermal.js';

describe('rooms with no local heat source', () => {
  it('use delivered temperature for display and thermal class', () => {
    const zone = {
      id: 'z_kitchen',
      name: 'Kitchen',
      is_unheated: false,
      is_boiler_control: false,
      setpoint_temperature: 21,
      can_reach_setpoint: false,
      radiators: [],
      radiator_coefficient: 0,
      delivered_indoor_temperature: 17,
      max_achievable_temperature: 24
    };

    expect(getDisplayedZoneTemperature(zone, 8)).toBe(17);
    expect(getThermalColorClass(zone)).toBe('thermal-extreme-cold');
  });

  it('still uses max achievable temperature when local heat source exists without TRV', () => {
    const zone = {
      id: 'z_living',
      name: 'Living',
      is_unheated: false,
      is_boiler_control: false,
      setpoint_temperature: 21,
      can_reach_setpoint: false,
      radiators: [{ radiator_id: 'type_22', surface_area: 0.6, trv_enabled: false }],
      radiator_coefficient: 4.8,
      delivered_indoor_temperature: 20,
      max_achievable_temperature: 24
    };

    expect(getDisplayedZoneTemperature(zone, 8)).toBe(24);
    expect(getThermalColorClass(zone)).toBe('thermal-extreme-hot');
  });

  it('uses delivered temperature for TRV rooms below setpoint', () => {
    const zone = {
      id: 'z_study',
      name: 'Study',
      is_unheated: false,
      is_boiler_control: false,
      setpoint_temperature: 21,
      can_reach_setpoint: false,
      radiators: [{ radiator_id: 'type_22', surface_area: 0.6, trv_enabled: true }],
      radiator_coefficient: 4.8,
      delivered_indoor_temperature: 20,
      max_achievable_temperature: 24
    };

    expect(getDisplayedZoneTemperature(zone, 8)).toBe(20);
    expect(getThermalColorClass(zone)).toBe('thermal-cold');
  });
});
