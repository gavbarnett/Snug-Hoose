import { describe, it, expect } from 'vitest';
import { computeRoomHeatRequirements } from '../source/scripts/heat_calculator.js';
import { designRoomRadiators } from '../source/scripts/solver.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const RADIATORS = [
  { id: 'type_11', heat_transfer_coefficient: 6.5 },
  { id: 'type_22', heat_transfer_coefficient: 8.0 },
  { id: 'type_33', heat_transfer_coefficient: 10.0 },
];

const SIZING = {
  coeffByType: new Map([['type_11', 6.5], ['type_22', 8.0], ['type_33', 10.0]]),
  typeOrder: ['type_11', 'type_22', 'type_33'],
  standardWidths: [400, 600, 800, 1000, 1200, 1400, 1600, 1800],
  defaultHeightMm: 600,
  maxWidthMm: 1800,
  minWidthMm: 400,
};

const FLOW = 55;
const EXT = 3;
const SETPOINT = 21;
const OVERHEAD = 1.15;

// ---------------------------------------------------------------------------
// Model: a single heated room connected to outside (C=8 W/K) and to an
// unheated loft (C_room↔loft=10 W/K, C_loft↔outside=20 W/K).
//
// Design heat demand at T_room=21°C:
//   T_loft = (20·3 + 10·21) / 30 = 9°C
//   Q = 8·(21−3) + 10·(21−9) = 144 + 120 = 264 W
//
// Boundary-only conductance (what total_conductance tracks): 8 W/K
//   → "required output" using boundary only = 8·18 = 144 W (underestimates by 45%)
// ---------------------------------------------------------------------------
function makeDemo(surfaceArea) {
  const rads = surfaceArea > 0
    ? [{ radiator_id: 'type_22', surface_area: surfaceArea, trv_enabled: true }]
    : [];
  return {
    zones: [
      {
        id: 'z_room', name: 'Room', is_unheated: false, setpoint_temperature: SETPOINT,
        radiators: rads,
      },
      { id: 'z_loft', name: 'Loft', is_unheated: true },
      { id: 'z_outside', name: 'Outside', type: 'boundary' },
    ],
    elements: [
      { id: 'el_wall',     type: 'wall',         nodes: ['z_room', 'z_outside'], thermal_conductance: 8 },
      { id: 'el_loft_ext', type: 'wall',         nodes: ['z_loft', 'z_outside'], thermal_conductance: 20 },
      { id: 'el_ceiling',  type: 'floor_ceiling', nodes: ['z_room', 'z_loft'],   thermal_conductance: 10 },
    ],
  };
}

const OPTS = { indoorTemp: SETPOINT, externalTemp: EXT, flowTemp: FLOW };

// ---------------------------------------------------------------------------
describe('Radiator sizing accuracy with adjacent unheated zones', () => {

  it('room fails to reach setpoint with insufficient radiator', () => {
    const demo = makeDemo(0.12); // type_22 × 0.12 m² → coeff = 0.96 W/K — far too small
    const result = computeRoomHeatRequirements(demo, RADIATORS, OPTS);
    const room = result.rooms.find(r => r.zoneId === 'z_room');
    expect(room.can_reach_setpoint).toBe(false);
  });

  it('total_conductance is only the boundary portion — loft ceiling is not included', () => {
    const demo = makeDemo(0.12);
    const result = computeRoomHeatRequirements(demo, RADIATORS, OPTS);
    const room = result.rooms.find(r => r.zoneId === 'z_room');
    // total_conductance = boundary conductance to z_outside = 8 W/K only
    expect(room.total_conductance).toBeCloseTo(8, 1);
  });

  it('boundary-only sizing undersizes the radiator — room still cold after "upgrade"', () => {
    // This test documents the OLD (buggy) behaviour: using total_conductance to size
    // radiators misses the 10 W/K loft-ceiling path, so the resulting radiator is
    // 45% too small and the room cannot reach setpoint.
    const demo = makeDemo(0.12);
    const before = computeRoomHeatRequirements(demo, RADIATORS, OPTS);
    const room = before.rooms.find(r => r.zoneId === 'z_room');

    const designDelta = FLOW - SETPOINT; // 34
    // Old formula: boundary conductance × ΔT_design × overhead / designDelta
    const requiredCoeff = (room.total_conductance * (SETPOINT - EXT) * OVERHEAD) / designDelta;
    // ≈ 8 × 18 × 1.15 / 34 ≈ 4.87 W/K
    expect(requiredCoeff).toBeCloseTo(4.87, 1);

    const design = designRoomRadiators(requiredCoeff, demo.zones[0].radiators, 'type_22', 1000, SIZING);

    // Apply those radiators and re-evaluate
    const upgraded = makeDemo(0);
    upgraded.zones[0].radiators = design.specs;
    const after = computeRoomHeatRequirements(upgraded, RADIATORS, OPTS);
    const roomAfter = after.rooms.find(r => r.zoneId === 'z_room');

    // Boundary-only sizing leaves the room well below setpoint (~18°C)
    expect(roomAfter.can_reach_setpoint).toBe(false);
    expect(roomAfter.delivered_indoor_temperature).toBeLessThan(SETPOINT);
  });

  it('design-condition heat_loss gives the correct total demand including loft loss', () => {
    // Get design heat loss by temporarily oversizing the radiator (TRV clamps at setpoint)
    // and suppressing control-zone modulation so the full flow temp is used.
    const designPassDemo = {
      ...makeDemo(0.12),
      zones: makeDemo(0.12).zones.map(z =>
        z.id === 'z_room'
          ? { ...z, is_boiler_control: false, radiators: [{ radiator_id: 'type_33', surface_area: 200, trv_enabled: true }] }
          : { ...z, is_boiler_control: false }
      ),
    };
    const designResult = computeRoomHeatRequirements(designPassDemo, RADIATORS, OPTS);
    const designRoom = designResult.rooms.find(r => r.zoneId === 'z_room');

    // TRV clamps room at 21°C → T_loft ≈ 9°C → Q = 8·18 + 10·12 = 264 W
    expect(designRoom.delivered_indoor_temperature).toBeCloseTo(SETPOINT, 0);
    expect(designRoom.heat_loss).toBeCloseTo(264, 0);
  });

  it('sizing from design-condition heat_loss produces a radiator that reaches setpoint', () => {
    // This is the FIXED behaviour: use design heat_loss (264 W) instead of
    // boundary-only estimate (144 W) to size the radiator.
    const demo = makeDemo(0.12);

    const designPassDemo = {
      ...demo,
      zones: demo.zones.map(z =>
        z.id === 'z_room'
          ? { ...z, is_boiler_control: false, radiators: [{ radiator_id: 'type_33', surface_area: 200, trv_enabled: true }] }
          : { ...z, is_boiler_control: false }
      ),
    };
    const designResult = computeRoomHeatRequirements(designPassDemo, RADIATORS, OPTS);
    const designRoom = designResult.rooms.find(r => r.zoneId === 'z_room');

    const designDelta = FLOW - SETPOINT; // 34
    const requiredCoeff = (designRoom.heat_loss * OVERHEAD) / designDelta;
    // ≈ 264 × 1.15 / 34 ≈ 8.93 W/K  (vs 4.87 with boundary-only)
    expect(requiredCoeff).toBeCloseTo(8.93, 1);

    const design = designRoomRadiators(requiredCoeff, demo.zones[0].radiators, 'type_22', 1000, SIZING);

    const upgraded = makeDemo(0);
    upgraded.zones[0].radiators = design.specs;
    const after = computeRoomHeatRequirements(upgraded, RADIATORS, OPTS);
    const roomAfter = after.rooms.find(r => r.zoneId === 'z_room');

    expect(roomAfter.can_reach_setpoint).toBe(true);
    expect(roomAfter.delivered_indoor_temperature).toBeGreaterThanOrEqual(SETPOINT);
  });

});

// ---------------------------------------------------------------------------
// designRoomRadiators — unit tests for the sizing helper
// ---------------------------------------------------------------------------
describe('designRoomRadiators', () => {

  it('upgrades radiator type before increasing width', () => {
    // requiredCoeff = 9 W/K; starting type_22 1000×600 = 4.8 W/K
    // expect type upgrade to type_33 before adding width
    const result = designRoomRadiators(9, [], 'type_22', 1000, SIZING);
    expect(result.specs.length).toBeGreaterThan(0);
    // type_33 at some width ≥ (9 / 10) = 0.9 m²
    const totalCoeff = result.specs.reduce((s, r) => {
      const htc = SIZING.coeffByType.get(r.radiator_id) || 0;
      return s + htc * r.surface_area;
    }, 0);
    expect(totalCoeff).toBeGreaterThanOrEqual(9);
  });

  it('splits into two radiators when a single type_33 at max width is insufficient', () => {
    // At max width 1800mm × 600mm, type_33 gives 10 × 1.08 = 10.8 W/K
    // requiredCoeff = 18 W/K — one rad (10.8 W/K) not enough, needs two
    const result = designRoomRadiators(18, [], 'type_33', 1800, SIZING);
    expect(result.specs.length).toBe(2);
    const totalCoeff = result.specs.reduce((s, r) => {
      const htc = SIZING.coeffByType.get(r.radiator_id) || 0;
      return s + htc * r.surface_area;
    }, 0);
    expect(totalCoeff).toBeGreaterThanOrEqual(18);
  });

  it('all output specs have trv_enabled = true', () => {
    const result = designRoomRadiators(6, [], 'type_22', 1000, SIZING);
    expect(result.specs.every(r => r.trv_enabled === true)).toBe(true);
  });

});
