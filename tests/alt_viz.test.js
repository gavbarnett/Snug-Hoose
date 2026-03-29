import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyWallLengthEditToPolygonMap, hasOnlyAxisAlignedEdges } from '../source/scripts/alt_viz.js';

const demoHouse = JSON.parse(
  readFileSync(new URL('../source/resources/demo_house.json', import.meta.url), 'utf8')
);

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

function applyChanges(baseMap, changedPolygons) {
  const merged = new Map();
  for (const [zoneId, polygon] of baseMap.entries()) {
    const next = changedPolygons[zoneId] || polygon;
    merged.set(zoneId, next.map(pt => ({ x: pt.x, y: pt.y })));
  }
  return merged;
}

function getZoneByName(demo, name) {
  return (demo.zones || []).find(zone => zone?.name === name);
}

function createRectangleMap(width = 4, height = 3) {
  return new Map([
    ['room_a', [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]]
  ]);
}

function createSideBySideMap() {
  return new Map([
    ['left', [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ]],
    ['right', [
      { x: 4, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4, y: 3 },
    ]],
  ]);
}

function createStackedMap() {
  return new Map([
    ['top', [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ]],
    ['bottom', [
      { x: 0, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 6 },
      { x: 0, y: 6 },
    ]],
  ]);
}

function getAxisAlignedEdgeLengths(polygon, predicate) {
  const lengths = [];
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const dx = Math.abs(p1.x - p0.x);
    const dy = Math.abs(p1.y - p0.y);
    const horizontal = dy < 1e-6 && dx > 1e-6;
    const vertical = dx < 1e-6 && dy > 1e-6;
    if (predicate({ p0, p1, horizontal, vertical })) {
      lengths.push(Math.hypot(p1.x - p0.x, p1.y - p0.y));
    }
  }
  return lengths;
}

function getIntervalsAtY(polygon, y) {
  const xs = [];
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    if (Math.abs(p0.y - p1.y) < 1e-9) continue;
    const minY = Math.min(p0.y, p1.y);
    const maxY = Math.max(p0.y, p1.y);
    if (y < minY || y >= maxY) continue;
    const t = (y - p0.y) / (p1.y - p0.y);
    xs.push(p0.x + t * (p1.x - p0.x));
  }
  xs.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const left = xs[i];
    const right = xs[i + 1];
    if (right - left > 1e-9) intervals.push([left, right]);
  }
  return intervals;
}

function intervalOverlapLength(aIntervals, bIntervals) {
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < aIntervals.length && j < bIntervals.length) {
    const [a0, a1] = aIntervals[i];
    const [b0, b1] = bIntervals[j];
    const left = Math.max(a0, b0);
    const right = Math.min(a1, b1);
    if (right > left) total += right - left;
    if (a1 < b1) i += 1;
    else j += 1;
  }
  return total;
}

function polygonOverlapArea(polyA, polyB) {
  const ys = [...new Set([
    ...polyA.map(pt => pt.y),
    ...polyB.map(pt => pt.y),
  ])].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    const height = y1 - y0;
    if (height <= 1e-9) continue;
    const yMid = (y0 + y1) / 2;
    const aIntervals = getIntervalsAtY(polyA, yMid);
    const bIntervals = getIntervalsAtY(polyB, yMid);
    const widthOverlap = intervalOverlapLength(aIntervals, bIntervals);
    area += widthOverlap * height;
  }
  return area;
}

function assertNoOverlaps(mapByZoneId, epsilon = 1e-6) {
  const entries = [...mapByZoneId.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [zoneA, polyA] = entries[i];
      const [zoneB, polyB] = entries[j];
      const overlapArea = polygonOverlapArea(polyA, polyB);
      expect(overlapArea, `Overlap between ${zoneA} and ${zoneB}`).toBeLessThanOrEqual(epsilon);
    }
  }
}

describe('wall length text input geometry', () => {
  it('resolves horizontal length edits by moving the right side only', () => {
    const polygonMap = createRectangleMap(4, 3);

    const changed = applyWallLengthEditToPolygonMap(polygonMap, 'room_a', 0, 1);
    const merged = applyChanges(polygonMap, changed);
    const polygon = merged.get('room_a');

    expect(changed.room_a).toBeDefined();
    expect(hasOnlyAxisAlignedEdges(polygon)).toBe(true);

    const minX = Math.min(...polygon.map(pt => pt.x));
    const maxX = Math.max(...polygon.map(pt => pt.x));

    expect(minX).toBeCloseTo(0, 6);
    expect(maxX).toBeCloseTo(1, 6);
  });

  it('uses the user typed length for the edited wall segment', () => {
    const polygonMap = createRectangleMap(4, 3);

    const changed = applyWallLengthEditToPolygonMap(polygonMap, 'room_a', 0, 1);
    const merged = applyChanges(polygonMap, changed);
    const livingPolygon = merged.get('room_a');

    expect(changed.room_a).toBeDefined();
    expect(hasOnlyAxisAlignedEdges(livingPolygon)).toBe(true);

    const topHorizontalEdges = getAxisAlignedEdgeLengths(
      livingPolygon,
      ({ p0, p1, horizontal }) => horizontal && Math.abs(p0.y) < 1e-6 && Math.abs(p1.y) < 1e-6
    );

    expect(topHorizontalEdges.some(length => Math.abs(length - 1) < 1e-6)).toBe(true);
  });

  it('resolves vertical length edits by moving the bottom side only', () => {
    const polygonMap = createRectangleMap(4, 3);

    const changed = applyWallLengthEditToPolygonMap(polygonMap, 'room_a', 1, 1.5);
    const merged = applyChanges(polygonMap, changed);
    const polygon = merged.get('room_a');

    expect(changed.room_a).toBeDefined();
    expect(hasOnlyAxisAlignedEdges(polygon)).toBe(true);

    const minY = Math.min(...polygon.map(pt => pt.y));
    const maxY = Math.max(...polygon.map(pt => pt.y));

    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(1.5, 6);
  });

  it('pulls rooms on the right when a left room width shrinks or grows', () => {
    const shrinkMap = createSideBySideMap();
    const shrunk = applyChanges(shrinkMap, applyWallLengthEditToPolygonMap(shrinkMap, 'left', 0, 3));
    const shrinkLeft = shrunk.get('left');
    const shrinkRight = shrunk.get('right');

    expect(Math.max(...shrinkLeft.map(pt => pt.x))).toBeCloseTo(3, 6);
    expect(Math.min(...shrinkRight.map(pt => pt.x))).toBeCloseTo(3, 6);
    expect(Math.max(...shrinkRight.map(pt => pt.x))).toBeCloseTo(6, 6);
    expect(hasOnlyAxisAlignedEdges(shrinkLeft)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(shrinkRight)).toBe(true);

    const growMap = createSideBySideMap();
    const grown = applyChanges(growMap, applyWallLengthEditToPolygonMap(growMap, 'left', 0, 5));
    const growLeft = grown.get('left');
    const growRight = grown.get('right');

    expect(Math.max(...growLeft.map(pt => pt.x))).toBeCloseTo(5, 6);
    expect(Math.min(...growRight.map(pt => pt.x))).toBeCloseTo(5, 6);
    expect(Math.max(...growRight.map(pt => pt.x))).toBeCloseTo(8, 6);
    expect(hasOnlyAxisAlignedEdges(growLeft)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(growRight)).toBe(true);
  });

  it('pulls rooms below when a top room height shrinks or grows', () => {
    const shrinkMap = createStackedMap();
    const shrunk = applyChanges(shrinkMap, applyWallLengthEditToPolygonMap(shrinkMap, 'top', 1, 2));
    const shrinkTop = shrunk.get('top');
    const shrinkBottom = shrunk.get('bottom');

    expect(Math.max(...shrinkTop.map(pt => pt.y))).toBeCloseTo(2, 6);
    expect(Math.min(...shrinkBottom.map(pt => pt.y))).toBeCloseTo(2, 6);
    expect(Math.max(...shrinkBottom.map(pt => pt.y))).toBeCloseTo(5, 6);
    expect(hasOnlyAxisAlignedEdges(shrinkTop)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(shrinkBottom)).toBe(true);

    const growMap = createStackedMap();
    const grown = applyChanges(growMap, applyWallLengthEditToPolygonMap(growMap, 'top', 1, 4));
    const growTop = grown.get('top');
    const growBottom = grown.get('bottom');

    expect(Math.max(...growTop.map(pt => pt.y))).toBeCloseTo(4, 6);
    expect(Math.min(...growBottom.map(pt => pt.y))).toBeCloseTo(4, 6);
    expect(Math.max(...growBottom.map(pt => pt.y))).toBeCloseTo(7, 6);
    expect(hasOnlyAxisAlignedEdges(growTop)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(growBottom)).toBe(true);
  });

  it('never creates diagonal walls when editing a shared wall length near a T-junction', () => {
    const polygonMap = buildPolygonMap(demoHouse, 1);
    const bathroom = getZoneByName(demoHouse, 'Bathroom');

    const changed = applyWallLengthEditToPolygonMap(polygonMap, bathroom.id, 3, 4.5);
    const merged = applyChanges(polygonMap, changed);

    expect(Object.keys(changed).length).toBeGreaterThan(0);
    for (const polygon of merged.values()) {
      expect(hasOnlyAxisAlignedEdges(polygon)).toBe(true);
    }
  });

  it('keeps level-0 rooms non-overlapping when shrinking Living Room top width to 2m', () => {
    const polygonMap = buildPolygonMap(demoHouse, 0);
    const living = getZoneByName(demoHouse, 'Living Room');
    const hall = getZoneByName(demoHouse, 'Hall Ground');

    const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 0, 2);
    const merged = applyChanges(polygonMap, changed);

    assertNoOverlaps(merged);

    const hallPoly = merged.get(hall.id);
    expect(hasOnlyAxisAlignedEdges(hallPoly)).toBe(true);
    expect(hallPoly.length).toBeGreaterThan(4);
  });

  it('keeps level-0 rooms non-overlapping when growing Living Room top width to 6.5m', () => {
    const polygonMap = buildPolygonMap(demoHouse, 0);
    const living = getZoneByName(demoHouse, 'Living Room');
    const hall = getZoneByName(demoHouse, 'Hall Ground');

    const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 0, 6.5);
    const merged = applyChanges(polygonMap, changed);

    assertNoOverlaps(merged);

    const livingPoly = merged.get(living.id);
    const hallPoly = merged.get(hall.id);
    expect(hasOnlyAxisAlignedEdges(livingPoly)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(hallPoly)).toBe(true);
    expect(Math.max(...livingPoly.map(pt => pt.x))).toBeCloseTo(6.5, 6);
    expect(hallPoly.length).toBeGreaterThan(4);
  });

  it('keeps level-0 rooms non-overlapping across multiple Living Room top-width edits', () => {
    const targetLengths = [2, 3.5, 5, 6.5];
    const living = getZoneByName(demoHouse, 'Living Room');

    for (const targetLength of targetLengths) {
      const polygonMap = buildPolygonMap(demoHouse, 0);
      const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 0, targetLength);
      const merged = applyChanges(polygonMap, changed);

      assertNoOverlaps(merged);
      for (const polygon of merged.values()) {
        expect(hasOnlyAxisAlignedEdges(polygon)).toBe(true);
      }
    }
  });

  it('keeps level-0 rooms non-overlapping when shrinking Living Room right height to 4m', () => {
    const polygonMap = buildPolygonMap(demoHouse, 0);
    const living = getZoneByName(demoHouse, 'Living Room');
    const kitchen = getZoneByName(demoHouse, 'Kitchen');

    const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 1, 4);
    const merged = applyChanges(polygonMap, changed);

    assertNoOverlaps(merged);

    const livingPoly = merged.get(living.id);
    const kitchenPoly = merged.get(kitchen.id);
    expect(hasOnlyAxisAlignedEdges(livingPoly)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(kitchenPoly)).toBe(true);
    expect(Math.max(...livingPoly.map(pt => pt.y))).toBeCloseTo(4, 6);
    expect(Math.min(...kitchenPoly.map(pt => pt.y))).toBeCloseTo(4, 6);
  });

  it('keeps level-0 rooms non-overlapping when growing Living Room right height to 6m', () => {
    const polygonMap = buildPolygonMap(demoHouse, 0);
    const living = getZoneByName(demoHouse, 'Living Room');
    const kitchen = getZoneByName(demoHouse, 'Kitchen');

    const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 1, 6);
    const merged = applyChanges(polygonMap, changed);

    assertNoOverlaps(merged);

    const livingPoly = merged.get(living.id);
    const kitchenPoly = merged.get(kitchen.id);
    expect(hasOnlyAxisAlignedEdges(livingPoly)).toBe(true);
    expect(hasOnlyAxisAlignedEdges(kitchenPoly)).toBe(true);
    expect(Math.max(...livingPoly.map(pt => pt.y))).toBeCloseTo(6, 6);
    expect(Math.min(...kitchenPoly.map(pt => pt.y))).toBeCloseTo(6, 6);
  });

  it('keeps level-0 rooms non-overlapping across multiple Living Room right-height edits', () => {
    const targetLengths = [4, 5, 6];
    const living = getZoneByName(demoHouse, 'Living Room');

    for (const targetLength of targetLengths) {
      const polygonMap = buildPolygonMap(demoHouse, 0);
      const changed = applyWallLengthEditToPolygonMap(polygonMap, living.id, 1, targetLength);
      const merged = applyChanges(polygonMap, changed);

      assertNoOverlaps(merged);
      for (const polygon of merged.values()) {
        expect(hasOnlyAxisAlignedEdges(polygon)).toBe(true);
      }
    }
  });
});
