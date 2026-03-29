import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { findMaterial, openingUfromMaterial, computeElementU } from '../source/scripts/u_value_calculator.js';

const materials = [
  { id: 'brick',          name: 'Brick',          thermal_conductivity: 0.9  },
  { id: 'rockwool',       name: 'Rockwool',        thermal_conductivity: 0.04 },
  { id: 'double_glazing', name: 'Double Glazing',  u_value: 1.4               },
];

const demoHouse = JSON.parse(
  readFileSync(new URL('../source/resources/demo_house.json', import.meta.url), 'utf8')
);
const demoMaterials = JSON.parse(
  readFileSync(new URL('../source/resources/insulation.json', import.meta.url), 'utf8')
).materials;

function totalRValueFromElement(elem) {
  if (!elem || typeof elem.u_fabric !== 'number' || elem.u_fabric <= 0) return null;
  return 1 / elem.u_fabric;
}

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

// ---------------------------------------------------------------------------
// Total R-value resolution for stack-ups
// ---------------------------------------------------------------------------
describe('Total R-value resolution for stack-ups', () => {
  it('resolves a multi-layer wall stack-up to expected total R-value', () => {
    // R_total = 0.0125/0.21 + 0.1/0.7 + 0.0125/0.21 = 0.2619...
    const elem = {
      type: 'wall',
      x: 1,
      y: 1,
      build_up: [
        { material_id: 'plasterboard', thickness: 0.0125 },
        { material_id: 'blockwork', thickness: 0.1 },
        { material_id: 'plasterboard', thickness: 0.0125 },
      ],
    };

    computeElementU(elem, demoMaterials);
    const rTotal = totalRValueFromElement(elem);

    expect(rTotal).not.toBeNull();
    expect(rTotal).toBeCloseTo(0.2619, 3);
  });

  it('resolves a composite wall cavity stack-up to expected total R-value', () => {
    // Composite layer equivalent R at 90mm using parallel heat-flow paths:
    // R_comp = 1 / (0.15/(0.09/0.13) + 0.85/(0.09/0.022))
    // R_total = R_plasterboard + R_comp + R_pir_50mm + R_blockwork
    const expectedRTotal =
      (0.0125 / 0.21) +
      (1 / ((0.15 / (0.09 / 0.13)) + (0.85 / (0.09 / 0.022)))) +
      (0.05 / 0.022) +
      (0.1 / 0.7);

    const elem = {
      type: 'wall',
      x: 1,
      y: 1,
      build_up: [
        { material_id: 'plasterboard', thickness: 0.0125 },
        {
          type: 'composite',
          thickness: 0.09,
          paths: [
            { material_id: 'stud_wood', fraction: 0.15 },
            { material_id: 'pir', fraction: 0.85 },
          ],
        },
        { material_id: 'pir', thickness: 0.05 },
        { material_id: 'blockwork', thickness: 0.1 },
      ],
    };

    computeElementU(elem, demoMaterials);
    const rTotal = totalRValueFromElement(elem);

    expect(rTotal).not.toBeNull();
    expect(rTotal).toBeCloseTo(expectedRTotal, 3);
  });

  it('resolves a floor stack-up with composite joist cavity', () => {
    // R_comp = 1 / (0.15/(0.15/0.13) + 0.85/(0.15/0.038))
    // R_total = R_plywood + R_comp + R_xps_100mm
    const expectedRTotal =
      (0.018 / 0.13) +
      (1 / ((0.15 / (0.15 / 0.13)) + (0.85 / (0.15 / 0.038)))) +
      (0.1 / 0.029);

    const elem = {
      type: 'floor',
      x: 1,
      y: 1,
      build_up: [
        { material_id: 'plywood', thickness: 0.018 },
        {
          type: 'composite',
          thickness: 0.15,
          paths: [
            { material_id: 'joist_wood', fraction: 0.15 },
            { material_id: 'rockwool', fraction: 0.85 },
          ],
        },
        { material_id: 'xps', thickness: 0.1 },
      ],
    };

    computeElementU(elem, demoMaterials);
    const rTotal = totalRValueFromElement(elem);

    expect(rTotal).not.toBeNull();
    expect(rTotal).toBeCloseTo(expectedRTotal, 2);
  });
});

// ---------------------------------------------------------------------------
// Demo Hoose validation
// ---------------------------------------------------------------------------
describe('Demo Hoose wall/floor/ceiling R-value coverage', () => {
  it('resolves total R-value for all walls, floors and ceilings in demo_house', () => {
    const templates = demoHouse.meta?.build_up_templates || {};
    const candidates = (demoHouse.elements || []).filter(e =>
      e && ['wall', 'floor', 'ceiling', 'floor_ceiling'].includes(e.type)
    );

    expect(candidates.length).toBeGreaterThan(0);

    for (const srcElem of candidates) {
      const elem = JSON.parse(JSON.stringify(srcElem));
      expect(() => computeElementU(elem, demoMaterials, templates)).not.toThrow();

      const rTotal = totalRValueFromElement(elem);
      expect(rTotal).not.toBeNull();
      expect(Number.isFinite(rTotal)).toBe(true);
      expect(rTotal).toBeGreaterThan(0);
    }
  });
});
