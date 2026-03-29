import { describe, it, expect } from 'vitest';
import { reconcileInterlevelElementsFromPolygons } from '../source/scripts/solver.js';
import { computeRoomHeatRequirements } from '../source/scripts/heat_calculator.js';

const outside = { id: 'z_outside', type: 'boundary', name: 'Outside' };

function makeTwoFloorDemo(upperX0, upperX1) {
  return {
    zones: [
      {
        id: 'z_lower',
        name: 'Lower',
        level: 0,
        is_unheated: false,
        setpoint_temperature: 21,
        radiators: [{ radiator_id: 'rad_std', surface_area: 1.0, trv_enabled: true }],
        layout: {
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
            { x: 0, y: 4 },
          ]
        }
      },
      {
        id: 'z_upper',
        name: 'Upper',
        level: 1,
        is_unheated: true,
        layout: {
          polygon: [
            { x: upperX0, y: 0 },
            { x: upperX1, y: 0 },
            { x: upperX1, y: 4 },
            { x: upperX0, y: 4 },
          ]
        }
      },
      outside,
    ],
    elements: [
      {
        id: 'el_lower_out',
        type: 'wall',
        nodes: ['z_lower', 'z_outside'],
        thermal_conductance: 8,
      },
      {
        id: 'el_upper_out',
        type: 'wall',
        nodes: ['z_upper', 'z_outside'],
        thermal_conductance: 8,
      },
      {
        id: 'el_floor_link',
        type: 'floor_ceiling',
        nodes: ['z_lower', 'z_upper'],
        x: 1,
        y: 1,
        u_overall: 1,
        _autoLayoutLink: true,
      },
    ],
  };
}

describe('inter-floor overlap reconciliation', () => {
  it('updates floor/ceiling area from polygon overlap', () => {
    const demo = makeTwoFloorDemo(1, 3); // overlap area = 8

    reconcileInterlevelElementsFromPolygons(demo, {
      z_lower: demo.zones[0].layout.polygon,
      z_upper: demo.zones[1].layout.polygon,
    });

    const link = demo.elements.find(el => el.id === 'el_floor_link');
    expect(link).toBeDefined();
    expect(link.nodes).toEqual(['z_lower', 'z_upper']);
    expect(link.x).toBeCloseTo(8, 6);
    expect(link.y).toBeCloseTo(1, 6);
  });

  it('creates an auto floor/ceiling link when overlap exists', () => {
    const demo = {
      zones: [
        {
          id: 'z_a',
          name: 'A',
          level: 0,
          layout: { polygon: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }] }
        },
        {
          id: 'z_b',
          name: 'B',
          level: 1,
          layout: { polygon: [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 1, y: 3 }] }
        },
        outside,
      ],
      elements: [],
    };

    reconcileInterlevelElementsFromPolygons(demo, {
      z_a: demo.zones[0].layout.polygon,
      z_b: demo.zones[1].layout.polygon,
    });

    const links = demo.elements.filter(el => String(el.type || '').toLowerCase() === 'floor_ceiling');
    expect(links.length).toBe(1);
    expect(links[0].nodes).toEqual(['z_a', 'z_b']);
    expect(links[0].x).toBeCloseTo(6, 6);
    expect(links[0].y).toBeCloseTo(1, 6);
  });

  it('increases inter-room thermal coupling when floor overlap increases', () => {
    const radiators = [{ id: 'rad_std', heat_transfer_coefficient: 50 }];
    const opts = { indoorTemp: 21, externalTemp: 3, flowTemp: 55 };

    const smallOverlapDemo = makeTwoFloorDemo(0, 1); // area 4
    const largeOverlapDemo = makeTwoFloorDemo(0, 3); // area 12

    reconcileInterlevelElementsFromPolygons(smallOverlapDemo, {
      z_lower: smallOverlapDemo.zones[0].layout.polygon,
      z_upper: smallOverlapDemo.zones[1].layout.polygon,
    });
    reconcileInterlevelElementsFromPolygons(largeOverlapDemo, {
      z_lower: largeOverlapDemo.zones[0].layout.polygon,
      z_upper: largeOverlapDemo.zones[1].layout.polygon,
    });

    const smallResult = computeRoomHeatRequirements(smallOverlapDemo, radiators, opts);
    const largeResult = computeRoomHeatRequirements(largeOverlapDemo, radiators, opts);

    const upperSmall = smallResult.rooms.find(r => r.zoneId === 'z_upper');
    const upperLarge = largeResult.rooms.find(r => r.zoneId === 'z_upper');

    expect(upperLarge.delivered_indoor_temperature).toBeGreaterThan(upperSmall.delivered_indoor_temperature);
  });
});
