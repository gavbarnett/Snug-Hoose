import { describe, expect, it } from 'vitest';
import {
  estimateBoilerCopFromFlowTemp,
  estimateHeatPumpCopFromFlowTemp
} from '../source/scripts/heating_performance.js';

describe('heating performance COP curves', () => {
  it('reduces heat pump COP as flow temperature rises', () => {
    const lowFlowCop = estimateHeatPumpCopFromFlowTemp(35);
    const midFlowCop = estimateHeatPumpCopFromFlowTemp(55);
    const highFlowCop = estimateHeatPumpCopFromFlowTemp(70);

    expect(lowFlowCop).toBeGreaterThan(midFlowCop);
    expect(midFlowCop).toBeGreaterThan(highFlowCop);
    expect(lowFlowCop).toBeCloseTo(4.2, 3);
  });

  it('reduces boiler COP as flow temperature rises', () => {
    const lowFlowCop = estimateBoilerCopFromFlowTemp(45, 0.9);
    const nominalFlowCop = estimateBoilerCopFromFlowTemp(55, 0.9);
    const highFlowCop = estimateBoilerCopFromFlowTemp(75, 0.9);

    expect(lowFlowCop).toBeGreaterThan(nominalFlowCop);
    expect(nominalFlowCop).toBeGreaterThan(highFlowCop);
    expect(nominalFlowCop).toBeCloseTo(0.9, 3);
  });

  it('respects COP bounds for boiler and heat pump curves', () => {
    expect(estimateHeatPumpCopFromFlowTemp(120)).toBeLessThanOrEqual(5.5);
    expect(estimateHeatPumpCopFromFlowTemp(-10)).toBeGreaterThanOrEqual(1.8);
    expect(estimateBoilerCopFromFlowTemp(120, 0.95)).toBeLessThanOrEqual(0.99);
    expect(estimateBoilerCopFromFlowTemp(-10, 0.65)).toBeGreaterThanOrEqual(0.6);
  });
});
