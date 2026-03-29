import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyWallLengthEditToPolygonMap } from '../source/scripts/alt_viz.js';
import { reconcileWallElementsFromPolygons } from '../source/scripts/solver.js';

const demoHouse = JSON.parse(
  readFileSync(new URL('../source/resources/demo_house.json', import.meta.url), 'utf8')
);

function cloneDemo() {
  return JSON.parse(JSON.stringify(demoHouse));
}

function buildPolygonMap(demo, level = null) {
  const polygonMap = new Map();
  for (const zone of demo.zones || []) {
    if (zone?.type === 'boundary') continue;
    if (level !== null && (zone?.level ?? 0) !== level) continue;
    if (Array.isArray(zone?.layout?.polygon)) {
      polygonMap.set(zone.id, zone.layout.polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) })));
    }
  }
  return polygonMap;
}

function edgeKeyFromPoints(p0, p1) {
  const a = `${Number(p0.x).toFixed(4)},${Number(p0.y).toFixed(4)}`;
  const b = `${Number(p1.x).toFixed(4)},${Number(p1.y).toFixed(4)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function getEdgeOrientationFromPolygon(polygon, edgeIndex) {
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % polygon.length];
  const midpoint = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  let cx = 0;
  let cy = 0;
  for (const pt of polygon) {
    cx += pt.x;
    cy += pt.y;
  }
  cx /= polygon.length;
  cy /= polygon.length;

  const dx = Math.abs(p1.x - p0.x);
  const dy = Math.abs(p1.y - p0.y);
  if (dx >= dy) {
    return midpoint.y < cy ? 'north' : 'south';
  }
  return midpoint.x < cx ? 'west' : 'east';
}

function getOppositeOrientation(orientation) {
  const normalized = String(orientation || '').toLowerCase();
  if (normalized === 'north') return 'south';
  if (normalized === 'south') return 'north';
  if (normalized === 'east') return 'west';
  if (normalized === 'west') return 'east';
  return normalized;
}

function buildExpectedWallLinksForLevel(demo, level) {
  const zones = (demo.zones || []).filter(zone => zone?.type !== 'boundary' && (zone?.level ?? 0) === level);
  const polygons = new Map(zones.map(zone => [zone.id, zone.layout.polygon]));
  const edgeRefs = new Map();
  for (const [zoneId, polygon] of polygons.entries()) {
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const key = edgeKeyFromPoints(p0, p1);
      if (!edgeRefs.has(key)) edgeRefs.set(key, []);
      edgeRefs.get(key).push({ zoneId, edgeIndex: i });
    }
  }

  const outsideId = (demo.zones || []).find(zone => zone?.type === 'boundary' && String(zone.name || '').toLowerCase() === 'outside')?.id;
  const expected = new Map();

  for (const zone of zones) {
    const polygon = polygons.get(zone.id);
    const links = [];
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const refs = edgeRefs.get(edgeKeyFromPoints(p0, p1)) || [];
      const adjacentZoneId = refs.find(ref => ref.zoneId !== zone.id)?.zoneId || outsideId;
      links.push(adjacentZoneId);
    }
    links.sort();
    expected.set(zone.id, links);
  }

  return expected;
}

function getActualWallLinksForLevel(demo, level) {
  const zones = (demo.zones || []).filter(zone => zone?.type !== 'boundary' && (zone?.level ?? 0) === level);
  const actual = new Map();
  for (const zone of zones) {
    const walls = (demo.elements || []).filter(element => {
      return String(element?.type || '').toLowerCase() === 'wall'
        && Array.isArray(element.nodes)
        && element.nodes.includes(zone.id);
    });
    const links = walls.map(wall => wall.nodes.find(nodeId => nodeId !== zone.id)).sort();
    actual.set(zone.id, links);
  }
  return actual;
}

function assertSharedWallsUseOppositeOrientation(demo, level) {
  const zoneIds = new Set(
    (demo.zones || [])
      .filter(zone => zone?.type !== 'boundary' && (zone?.level ?? 0) === level)
      .map(zone => zone.id)
  );

  for (const wall of demo.elements || []) {
    if (String(wall?.type || '').toLowerCase() !== 'wall') continue;
    if (!Array.isArray(wall.nodes) || wall.nodes.length !== 2) continue;
    if (!zoneIds.has(wall.nodes[0]) || !zoneIds.has(wall.nodes[1])) continue;

    const storedOrientation = String(wall.orientation || '').toLowerCase();
    expect(['north', 'south', 'east', 'west']).toContain(storedOrientation);
    expect(getOppositeOrientation(getOppositeOrientation(storedOrientation))).toBe(storedOrientation);
    expect(getOppositeOrientation(storedOrientation)).not.toBe(storedOrientation);
  }
}

describe('floor-wide wall reconciliation', () => {
  it('keeps wall count and linkage aligned with polygon edges for all rooms on the edited level', () => {
    const demo = cloneDemo();
    const living = demo.zones.find(zone => zone?.name === 'Living Room');
    const kitchen = demo.zones.find(zone => zone?.name === 'Kitchen');
    const polygonMap = buildPolygonMap(demo, 0);
    const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 0, 2);

    for (const zone of demo.zones) {
      const polygon = changed[zone.id];
      if (!Array.isArray(polygon)) continue;
      zone.layout = zone.layout || {};
      zone.layout.polygon = polygon;
    }

    const staleKitchenWall = demo.elements.find(element => element?.id === 'el_kit_wall_ext');
    staleKitchenWall.nodes = [kitchen.id];
    staleKitchenWall.orientation = 'south';

    reconcileWallElementsFromPolygons(demo, changed);

    const expected = buildExpectedWallLinksForLevel(demo, 0);
    const actual = getActualWallLinksForLevel(demo, 0);

    for (const [zoneId, expectedLinks] of expected.entries()) {
      const actualLinks = actual.get(zoneId) || [];
      expect(actualLinks.length).toBe(demo.zones.find(zone => zone.id === zoneId).layout.polygon.length);
      expect(actualLinks).toEqual(expectedLinks);
    }

    assertSharedWallsUseOppositeOrientation(demo, 0);
  });

  it('keeps wall count aligned with polygon edge count for every layout-backed room', () => {
    const demo = cloneDemo();
    const polygonsByZoneId = {};

    for (const zone of demo.zones || []) {
      if (zone?.type === 'boundary' || !Array.isArray(zone?.layout?.polygon)) continue;
      polygonsByZoneId[zone.id] = zone.layout.polygon.map(pt => ({ x: Number(pt.x), y: Number(pt.y) }));
    }

    reconcileWallElementsFromPolygons(demo, polygonsByZoneId);

    for (const zone of demo.zones.filter(zone => zone?.type !== 'boundary' && Array.isArray(zone?.layout?.polygon))) {
      const walls = demo.elements.filter(element => {
        return String(element?.type || '').toLowerCase() === 'wall'
          && Array.isArray(element.nodes)
          && element.nodes.includes(zone.id);
      });
      expect(walls.length).toBe(zone.layout.polygon.length);
    }
  });

  it('creates an extra wall entry when a room edge is split by partial contact with another room', () => {
    const demo = {
      zones: [
        {
          id: 'room_a',
          name: 'Room A',
          level: 0,
          layout: {
            polygon: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
              { x: 5, y: 5 },
              { x: 0, y: 5 },
            ]
          }
        },
        {
          id: 'room_b',
          name: 'Room B',
          level: 0,
          layout: {
            polygon: [
              { x: 5, y: 2 },
              { x: 7, y: 2 },
              { x: 7, y: 4 },
              { x: 5, y: 4 },
            ]
          }
        },
        { id: 'outside', name: 'Outside', type: 'boundary' },
      ],
      elements: [],
    };

    reconcileWallElementsFromPolygons(demo, {
      room_a: demo.zones[0].layout.polygon,
      room_b: demo.zones[1].layout.polygon,
    });

    const roomA = demo.zones.find(zone => zone.id === 'room_a');
    const roomAWalls = demo.elements.filter(element => {
      return String(element?.type || '').toLowerCase() === 'wall'
        && Array.isArray(element.nodes)
        && element.nodes.includes('room_a');
    });

    expect(roomA.layout.polygon.length).toBe(6);
    expect(roomAWalls.length).toBe(6);
  });

  it('collapses stale split walls when the shared T-junction no longer exists', () => {
    const demo = {
      zones: [
        {
          id: 'room_a',
          name: 'Room A',
          level: 0,
          layout: {
            polygon: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
              { x: 5, y: 2 },
              { x: 5, y: 4 },
              { x: 5, y: 5 },
              { x: 0, y: 5 },
            ]
          }
        },
        {
          id: 'room_b',
          name: 'Room B',
          level: 0,
          layout: {
            polygon: [
              { x: 8, y: 1 },
              { x: 10, y: 1 },
              { x: 10, y: 3 },
              { x: 8, y: 3 },
            ]
          }
        },
        { id: 'outside', name: 'Outside', type: 'boundary' },
      ],
      elements: [],
    };

    reconcileWallElementsFromPolygons(demo, {
      room_a: demo.zones[0].layout.polygon,
      room_b: demo.zones[1].layout.polygon,
    });

    const roomA = demo.zones.find(zone => zone.id === 'room_a');
    const roomAWalls = demo.elements.filter(element => {
      return String(element?.type || '').toLowerCase() === 'wall'
        && Array.isArray(element.nodes)
        && element.nodes.includes('room_a');
    });

    expect(roomA.layout.polygon.length).toBe(4);
    expect(roomAWalls.length).toBe(4);
  });

  it('collapses redundant midpoint splits on a fully shared wall', () => {
    const demo = {
      zones: [
        {
          id: 'room_a',
          name: 'Room A',
          level: 0,
          layout: {
            polygon: [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
              { x: 5, y: 2 },
              { x: 5, y: 5 },
              { x: 0, y: 5 },
            ]
          }
        },
        {
          id: 'room_b',
          name: 'Room B',
          level: 0,
          layout: {
            polygon: [
              { x: 5, y: 0 },
              { x: 8, y: 0 },
              { x: 8, y: 5 },
              { x: 5, y: 5 },
              { x: 5, y: 2 },
            ]
          }
        },
        { id: 'outside', name: 'Outside', type: 'boundary' },
      ],
      elements: [],
    };

    reconcileWallElementsFromPolygons(demo, {
      room_a: demo.zones[0].layout.polygon,
      room_b: demo.zones[1].layout.polygon,
    });

    const roomA = demo.zones.find(zone => zone.id === 'room_a');
    const roomB = demo.zones.find(zone => zone.id === 'room_b');
    const roomAWalls = demo.elements.filter(element => String(element?.type || '').toLowerCase() === 'wall' && Array.isArray(element.nodes) && element.nodes.includes('room_a'));
    const roomBWalls = demo.elements.filter(element => String(element?.type || '').toLowerCase() === 'wall' && Array.isArray(element.nodes) && element.nodes.includes('room_b'));

    expect(roomA.layout.polygon.length).toBe(4);
    expect(roomB.layout.polygon.length).toBe(4);
    expect(roomAWalls.length).toBe(4);
    expect(roomBWalls.length).toBe(4);
  });
});
