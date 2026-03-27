import { describe, it, expect } from 'vitest';
import { findMaterial, openingUfromMaterial, computeElementU } from '../source/scripts/u_value_calculator.js';

const materials = [
  { id: 'brick',          name: 'Brick',          thermal_conductivity: 0.9  },
  { id: 'rockwool',       name: 'Rockwool',        thermal_conductivity: 0.04 },
  { id: 'double_glazing', name: 'Double Glazing',  u_value: 1.4               },
];

// ---------------------------------------------------------------------------
// findMaterial
// ---------------------------------------------------------------------------
describe('findMaterial', () => {
  it('finds by exact id', () => {
    expect(findMaterial(materials, 'brick')).toBe(materials[0]);
  });

  it('finds by name', () => {
    expect(findMaterial(materials, 'Rockwool')).toBe(materials[1]);
  });

  it('finds case-insensitively', () => {
    expect(findMaterial(materials, 'BRICK')).toBe(materials[0]);
  });

  it('returns null for unknown material', () => {
    expect(findMaterial(materials, 'unobtainium')).toBeNull();
  });

  it('returns null for empty id', () => {
    expect(findMaterial(materials, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openingUfromMaterial
// ---------------------------------------------------------------------------
describe('openingUfromMaterial', () => {
  it('returns u_value when present', () => {
    expect(openingUfromMaterial({ u_value: 1.4 })).toBe(1.4);
  });

  it('returns typical_u_value_w_m2k as fallback', () => {
    expect(openingUfromMaterial({ typical_u_value_w_m2k: 2.0 })).toBe(2.0);
  });

  it('derives U from thermal_conductivity and effective_thickness_m', () => {
    // k=0.04, d=0.1m → U = 0.04/0.1 = 0.4 W/m²K
    expect(openingUfromMaterial({ thermal_conductivity: 0.04, effective_thickness_m: 0.1 })).toBeCloseTo(0.4, 5);
  });

  it('returns null for null input', () => {
    expect(openingUfromMaterial(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeElementU
// ---------------------------------------------------------------------------
describe('computeElementU', () => {
  it('computes U-value for a single-layer wall', () => {
    // rockwool k=0.04, t=0.1 m → R=2.5 m²K/W → U=0.4 W/m²K
    // area = 2×2.5 = 5 m² → thermal_conductance = 2.0 W/K
    const elem = {
      x: 2, y: 2.5,
      build_up: [{ material_id: 'rockwool', thickness: 0.1 }],
    };
    computeElementU(elem, materials);
    expect(elem.u_fabric).toBeCloseTo(0.4, 3);
    expect(elem.u_overall).toBeCloseTo(0.4, 3);
    expect(elem.thermal_conductance).toBeCloseTo(2.0, 2);
    expect(elem.area).toBe(5);
  });

  it('resolves build-up templates', () => {
    const templates = {
      'tpl_external': {
        name: 'External wall',
        build_up: [{ material_id: 'rockwool', thickness: 0.1 }],
      },
    };
    const elem = {
      x: 3, y: 2,
      build_up_template_id: 'tpl_external',
    };
    computeElementU(elem, materials, templates);
    // area = 3×2 = 6 m², rockwool U=0.4 → conductance = 2.4 W/K
    expect(elem.u_fabric).toBeCloseTo(0.4, 3);
    expect(elem.thermal_conductance).toBeCloseTo(2.4, 2);
    expect(elem.area).toBe(6);
  });

  it('incorporates window conductance into the overall U-value', () => {
    // wall 3×2.5 = 7.5 m², rockwool U_fabric=0.4
    // window area=1.5 m², double_glazing u_value=1.4
    // fabric conductance = 0.4 × (7.5 - 1.5) = 2.4 W/K
    // window conductance = 1.4 × 1.5 = 2.1 W/K
    // total conductance = 4.5 W/K  →  U_overall = 4.5/7.5 = 0.6 W/m²K
    const elem = {
      x: 3, y: 2.5,
      build_up: [{ material_id: 'rockwool', thickness: 0.1 }],
      windows: [{ glazing_id: 'double_glazing', area: 1.5 }],
    };
    computeElementU(elem, materials);
    expect(elem.u_fabric).toBeCloseTo(0.4, 3);
    expect(elem.thermal_conductance).toBeCloseTo(4.5, 2);
    expect(elem.u_overall).toBeCloseTo(0.6, 3);
    expect(elem.openings_area).toBeCloseTo(1.5, 3);
  });

  it('annotates the window with its U-value', () => {
    const win = { glazing_id: 'double_glazing', area: 1.0 };
    const elem = {
      x: 2, y: 2.5,
      build_up: [{ material_id: 'rockwool', thickness: 0.1 }],
      windows: [win],
    };
    computeElementU(elem, materials);
    expect(win.u).toBeCloseTo(1.4, 3);
  });

  it('returns zero U for element with no area', () => {
    const elem = {
      build_up: [{ material_id: 'rockwool', thickness: 0.1 }],
    };
    computeElementU(elem, materials);
    expect(elem.u_overall).toBe(0);
    expect(elem.thermal_conductance).toBe(0);
  });
});
