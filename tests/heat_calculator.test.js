import { describe, it, expect } from 'vitest';
import { computeRoomHeatRequirements } from '../source/scripts/heat_calculator.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const radiators = [
  // heat_transfer_coefficient = 50 W/(K·m²), so radiatorCoeff = htc × surface_area
  { id: 'rad_std', heat_transfer_coefficient: 50 },
];

const outside = { id: 'z_outside', type: 'boundary', name: 'Outside' };

const OPTS = { indoorTemp: 21, externalTemp: 3, flowTemp: 55 };

// ---------------------------------------------------------------------------
// Unheated zone — equilibrates to external temperature
// ---------------------------------------------------------------------------
describe('Unheated zone with no heat source', () => {
  it('reaches external temperature at steady state', () => {
    const demo = {
      zones: [
        { id: 'z_a', name: 'Loft', is_unheated: true },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_a', 'z_outside'],
        x: 4, y: 2.5,
        thermal_conductance: 10,  // 10 W/K to outside
      }],
    };

    const result = computeRoomHeatRequirements(demo, [], OPTS);
    const zone = result.rooms.find(r => r.zoneId === 'z_a');

    expect(zone.delivered_indoor_temperature).toBeCloseTo(3, 1);
    expect(zone.delivered_heat).toBe(0);
    expect(zone.is_unheated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TRV clamping — oversized radiator must not overheat the room
// ---------------------------------------------------------------------------
describe('Heated zone with TRV and oversized radiator', () => {
  it('clamps temperature at the zone setpoint', () => {
    // rad coeff = 50 × 1.0 = 50 W/K — far more than the 180 W heat loss
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Living', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
        },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_a', 'z_outside'],
        x: 4, y: 2.5,
        thermal_conductance: 10,
      }],
    };

    const result = computeRoomHeatRequirements(demo, radiators, OPTS);
    const zone = result.rooms.find(r => r.zoneId === 'z_a');

    expect(zone.delivered_indoor_temperature).toBeCloseTo(21, 0);
    // Heat loss = C × ΔT = 10 × (21 − 3) = 180 W
    expect(zone.heat_loss).toBeCloseTo(180, 0);
    expect(zone.can_reach_setpoint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inter-zone heat transfer — unheated zone warms from adjacency to heated zone
// ---------------------------------------------------------------------------
describe('Heated zone adjacent to unheated zone', () => {
  it('raises the unheated zone temperature above external', () => {
    // Zone A (heated, TRV, setpoint 21°C) shares a wall with Zone B (unheated)
    // Both connect to outside as well.
    //
    // After TRV clamps A at 21°C, the nodal equation for B becomes:
    //   (C_b_out + C_ab) × T_B = C_b_out × T_ext + C_ab × T_A
    //   (8 + 5) × T_B = 8 × 3 + 5 × 21 = 24 + 105 = 129
    //   T_B = 129 / 13 ≈ 9.92°C
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Heated', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
        },
        { id: 'z_b', name: 'Unheated', is_unheated: true },
        outside,
      ],
      elements: [
        {
          id: 'el_a_out', type: 'wall',
          nodes: ['z_a', 'z_outside'],
          thermal_conductance: 10,
        },
        {
          id: 'el_b_out', type: 'wall',
          nodes: ['z_b', 'z_outside'],
          thermal_conductance: 8,
        },
        {
          id: 'el_ab', type: 'wall',
          nodes: ['z_a', 'z_b'],
          thermal_conductance: 5,
        },
      ],
    };

    const result = computeRoomHeatRequirements(demo, radiators, OPTS);
    const zoneA = result.rooms.find(r => r.zoneId === 'z_a');
    const zoneB = result.rooms.find(r => r.zoneId === 'z_b');

    expect(zoneA.delivered_indoor_temperature).toBeCloseTo(21, 0);
    expect(zoneB.delivered_indoor_temperature).toBeCloseTo(9.92, 1);
  });
});

// ---------------------------------------------------------------------------
// Boiler modulation — control zone drives flow temperature down
// ---------------------------------------------------------------------------
describe('Boiler modulation via control zone', () => {
  it('finds the exact flow temperature that satisfies the control zone setpoint', () => {
    // rad coeff = 50 × 0.1 = 5 W/K;  boundary conductance = 10 W/K
    // Steady-state: (10 + 5) × T = 10 × 3 + 5 × F  →  T = (30 + 5F) / 15
    // For T = 21:  F = (21 × 15 − 30) / 5 = 57°C
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Living', is_unheated: false,
          setpoint_temperature: 21, is_boiler_control: true,
          radiators: [{ radiator_id: 'rad_std', surface_area: 0.1, trv_enabled: false }],
        },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_a', 'z_outside'],
        thermal_conductance: 10,
      }],
    };

    // maxFlowTemp = 80°C so modulation will need to reduce it to ~57°C
    const result = computeRoomHeatRequirements(demo, radiators, { indoorTemp: 21, externalTemp: 3, flowTemp: 80 });
    const zone = result.rooms.find(r => r.zoneId === 'z_a');

    expect(zone.delivered_indoor_temperature).toBeCloseTo(21, 1);
    expect(result.effectiveFlowTemp).toBeCloseTo(57, 0);
    // Heat loss at setpoint = 10 × (21 − 3) = 180 W
    expect(zone.heat_loss).toBeCloseTo(180, 0);
  });
});

// ---------------------------------------------------------------------------
// Undersized radiator — can't reach setpoint
// ---------------------------------------------------------------------------
describe('Heated zone with undersized radiator', () => {
  it('reports can_reach_setpoint=false and delivers below setpoint', () => {
    // rad coeff = 50 × 0.05 = 2.5 W/K
    // At F=55°C: T_A = (10×3 + 2.5×55) / (10 + 2.5) = (30 + 137.5) / 12.5 = 13.4°C < 21°C
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Bedroom', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 0.05, trv_enabled: false }],
        },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_a', 'z_outside'],
        thermal_conductance: 10,
      }],
    };

    const result = computeRoomHeatRequirements(demo, radiators, OPTS);
    const zone = result.rooms.find(r => r.zoneId === 'z_a');

    expect(zone.delivered_indoor_temperature).toBeCloseTo(13.4, 0);
    expect(zone.can_reach_setpoint).toBe(false);
  });
});
