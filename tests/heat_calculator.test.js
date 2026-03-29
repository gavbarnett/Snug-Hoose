import { describe, it, expect } from 'vitest';
import { computeRoomHeatRequirements } from '../source/scripts/heat_calculator.js';
import { normalizeElementNodesForAttachment } from '../source/scripts/room_editor.js';

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

describe('Savings eligibility for rooms without radiators', () => {
  it('does not attribute TRV savings to heated rooms with no radiators', () => {
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Heated TRV', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
        },
        {
          id: 'z_b', name: 'Heated No Rad', is_unheated: false,
          setpoint_temperature: 21,
        },
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
    const noRadZone = result.rooms.find(r => r.zoneId === 'z_b');

    expect(noRadZone.radiator_surface_area).toBe(0);
    expect(noRadZone.heat_savings).toBe(0);
    expect(noRadZone.delivered_heat_savings).toBe(0);
  });
});

describe('Attaching a new room to existing external fabric', () => {
  it('normalizes reused external wall nodes into an internal partition', () => {
    const demo = {
      zones: [
        { id: 'z_a', name: 'Existing Room' },
        { id: 'z_b', name: 'New Room' },
        outside,
      ],
    };
    const element = {
      id: 'el_reused_wall',
      type: 'wall',
      nodes: ['z_a', 'z_outside'],
    };

    expect(normalizeElementNodesForAttachment(demo, element, 'z_b')).toEqual(['z_a', 'z_b']);
  });

  it('stops treating a reused external wall as outside-connected after attachment', () => {
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Existing Room', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
        },
        { id: 'z_b', name: 'New Room', is_unheated: true },
        outside,
      ],
      elements: [
        {
          id: 'el_a_out', type: 'wall',
          nodes: ['z_a', 'z_outside'],
          thermal_conductance: 10,
        },
        {
          id: 'el_reused_wall', type: 'wall',
          nodes: ['z_a', 'z_outside'],
          thermal_conductance: 5,
        },
      ],
    };

    demo.elements[1].nodes = normalizeElementNodesForAttachment(demo, demo.elements[1], 'z_b');
    const result = computeRoomHeatRequirements(demo, radiators, OPTS);
    const newRoom = result.rooms.find(r => r.zoneId === 'z_b');

    expect(demo.elements[1].nodes).toEqual(['z_a', 'z_b']);
    expect(newRoom.delivered_indoor_temperature).toBeCloseTo(21, 0);
    expect(newRoom.heat_loss).toBeCloseTo(0, 6);
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

// ---------------------------------------------------------------------------
// Control room capacity consistency — max_achievable_temp should be ≥ setpoint
// ---------------------------------------------------------------------------
describe('Control room consistency check', () => {
  it('computes max_achievable_temperature >= setpoint for control zone', () => {
    // A control room with fixed radiator surface area and boundary conductance.
    // We should always be able to reach the setpoint at some intermediate flow temp,
    // and max flow should give us at least as much capacity.
    const demo = {
      zones: [
        {
          id: 'z_control', name: 'Control', is_unheated: false,
          setpoint_temperature: 21, is_boiler_control: true,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.5, trv_enabled: false }],
        },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_control', 'z_outside'],
        thermal_conductance: 15,  // 15 W/K heat loss at ΔT=18K → 270W
      }],
    };

    const result = computeRoomHeatRequirements(demo, radiators, { indoorTemp: 21, externalTemp: 3, flowTemp: 55 });
    const zone = result.rooms.find(r => r.zoneId === 'z_control');

    // Control room must reach its setpoint operationally
    expect(zone.delivered_indoor_temperature).toBeCloseTo(21, 0);
    expect(zone.can_reach_setpoint).toBe(true);
    
    // max_achievable_temperature must be >= setpoint for a control room
    expect(zone.max_achievable_temperature).toBeGreaterThanOrEqual(20.5);
    
    // Capacity should be >= 100% (room can reach setpoint at max flow)
    const requiredLift = zone.setpoint_temperature - 3;  // external temp = 3
    const availableLift = zone.max_achievable_temperature - 3;
    const capacityPct = availableLift / requiredLift * 100;
    expect(capacityPct).toBeGreaterThanOrEqual(95); // Allow small rounding margin
  });
});

// ---------------------------------------------------------------------------
// ACH ventilation heat loss — zone with volume and ach
// ---------------------------------------------------------------------------
describe('Ventilation heat loss via ACH', () => {
  it('adds ventilation conductance to boundary and increases total heat loss', () => {
    // Wall conductance: 10 W/K
    // ACH = 1.0, volume = 100 m³
    // C_vent = 1.0 × 100 × 0.33 = 33 W/K
    // Total boundary conductance = 10 + 33 = 43 W/K
    // Heat loss at ΔT=18K: 43 × 18 = 774 W
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Ventilated Room', is_unheated: false,
          setpoint_temperature: 21,
          volume_m3: 100,
          ach: 1.0,
          radiators: [{ radiator_id: 'rad_std', surface_area: 2.0, trv_enabled: true }],
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

    // Temperature held at setpoint (TRV clamped)
    expect(zone.delivered_indoor_temperature).toBeCloseTo(21, 0);
    // Total conductance = C_wall + C_vent = 10 + 33 = 43 W/K
    expect(zone.total_conductance).toBeCloseTo(43, 0);
    // Heat loss = 43 × 18 = 774 W
    expect(zone.heat_loss).toBeCloseTo(774, 0);
    // Ventilation conductance is reported
    expect(zone.ventilation_conductance).toBeCloseTo(33, 0);
    // Ventilation heat loss = 33 × 18 = 594 W
    expect(zone.ventilation_heat_loss).toBeCloseTo(594, 0);
  });

  it('zone with no ach or volume has zero ventilation heat loss', () => {
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'No ACH Room', is_unheated: false,
          setpoint_temperature: 21,
          radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
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

    expect(zone.ventilation_conductance).toBe(0);
    expect(zone.ventilation_heat_loss).toBe(0);
    // Heat loss unchanged from wall-only: 10 × 18 = 180 W
    expect(zone.heat_loss).toBeCloseTo(180, 0);
  });

  it('zone with volume derived from floor_area_m2 and ceiling_height_m computes correctly', () => {
    // floor 50 m² × 2.5 m ceiling = 125 m³
    // C_vent = 0.5 × 125 × 0.33 = 20.625 W/K
    // Total = 10 + 20.625 = 30.625 W/K
    const demo = {
      zones: [
        {
          id: 'z_a', name: 'Derived Volume Room', is_unheated: false,
          setpoint_temperature: 21,
          floor_area_m2: 50,
          ceiling_height_m: 2.5,
          ach: 0.5,
          radiators: [{ radiator_id: 'rad_std', surface_area: 2.0, trv_enabled: true }],
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

    expect(zone.ventilation_conductance).toBeCloseTo(20.625, 1);
    expect(zone.total_conductance).toBeCloseTo(30.625, 1);
  });

  it('MVHR heat recovery reduces ventilation heat loss proportionally', () => {
    // ACH=1.0, volume=100 m³, η=0.80 MVHR
    // C_vent = 1.0 × 100 × 0.33 × (1 − 0.8) = 6.6 W/K
    // Compare with no-recovery: 33 W/K — 80% reduction
    const demoMvhr = {
      zones: [
        {
          id: 'z_a', name: 'MVHR Room', is_unheated: false,
          setpoint_temperature: 21,
          volume_m3: 100,
          ach: 1.0,
          heat_recovery_efficiency: 0.80,
          radiators: [{ radiator_id: 'rad_std', surface_area: 2.0, trv_enabled: true }],
        },
        outside,
      ],
      elements: [{
        id: 'el_wall', type: 'wall',
        nodes: ['z_a', 'z_outside'],
        thermal_conductance: 10,
      }],
    };

    const result = computeRoomHeatRequirements(demoMvhr, radiators, OPTS);
    const zone = result.rooms.find(r => r.zoneId === 'z_a');

    // C_vent = 33 × (1 − 0.8) = 6.6 W/K
    expect(zone.ventilation_conductance).toBeCloseTo(6.6, 1);
    // Total = 10 + 6.6 = 16.6 W/K → heat loss = 16.6 × 18 = 298.8 W
    expect(zone.heat_loss).toBeCloseTo(298.8, 0);
  });
});
