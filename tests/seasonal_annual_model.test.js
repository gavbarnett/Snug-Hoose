import { describe, it, expect } from 'vitest';
import { computeRoomHeatRequirements } from '../source/scripts/heat_calculator.js';
import { computeSeasonalAnnualEnergyModel } from '../source/scripts/solver.js';

const RADIATORS = [
  { id: 'rad_std', heat_transfer_coefficient: 50 }
];

function makeSimpleDemo(metaOverrides = {}) {
  return {
    meta: {
      indoorTemp: 21,
      flowTemp: 55,
      heatSourceType: 'direct_electric',
      electricUnitRate: 0.2,
      systemMinExternalTemp: 3,
      seasonalMinExternalTemp: 3,
      seasonalMaxExternalTemp: 16,
      ...metaOverrides
    },
    zones: [
      {
        id: 'z_living',
        name: 'Living',
        is_unheated: false,
        setpoint_temperature: 21,
        is_boiler_control: true,
        radiators: [{ radiator_id: 'rad_std', surface_area: 1.2, trv_enabled: true }]
      },
      { id: 'z_outside', type: 'boundary', name: 'Outside' }
    ],
    elements: [
      {
        id: 'el_wall',
        type: 'wall',
        nodes: ['z_living', 'z_outside'],
        thermal_conductance: 10
      }
    ]
  };
}

function expectedMonthlyOutsideTemp(monthIndex, seasonalMin, seasonalMax) {
  const offset = (seasonalMin + seasonalMax) / 2;
  const amplitude = (seasonalMax - seasonalMin);
  const monthNumber = monthIndex + 1;
  const phase = ((2 * Math.PI) / 12) * monthNumber;
  return offset + (amplitude * Math.sin(phase));
}

describe('computeSeasonalAnnualEnergyModel', () => {
  it('matches single-point annual demand when seasonal min=max and direct electric input', () => {
    const demo = makeSimpleDemo({
      seasonalMinExternalTemp: 5,
      seasonalMaxExternalTemp: 5
    });

    const annual = computeSeasonalAnnualEnergyModel(demo, RADIATORS, { heating: {} });

    const onePoint = computeRoomHeatRequirements(demo, RADIATORS, {
      indoorTemp: 21,
      externalTemp: 5,
      flowTemp: 55
    });
    const expectedAnnualDemand = (Number(onePoint.total_delivered_heat) * 24 * 365) / 1000;

    expect(annual.annualHeatDemandKwhYr).toBeCloseTo(expectedAnnualDemand, 6);
    expect(annual.annualInputEnergyKwhYr).toBeCloseTo(expectedAnnualDemand, 6);
    expect(annual.annualAverageCop).toBeCloseTo(1, 9);
    expect(annual.annualRunningCost).toBeCloseTo(expectedAnnualDemand * 0.2, 6);
  });

  it('uses monthly sinusoid temperatures with month-day weighting (one solve point per month)', () => {
    const demo = makeSimpleDemo({
      seasonalMinExternalTemp: 2,
      seasonalMaxExternalTemp: 14
    });

    const annual = computeSeasonalAnnualEnergyModel(demo, RADIATORS, { heating: {} });

    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let expectedDemand = 0;

    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const temp = expectedMonthlyOutsideTemp(monthIndex, 2, 14);
      const monthHours = monthDays[monthIndex] * 24;
      const point = computeRoomHeatRequirements(demo, RADIATORS, {
        indoorTemp: 21,
        externalTemp: temp,
        flowTemp: 55
      });
      expectedDemand += (Number(point.total_delivered_heat) * monthHours) / 1000;
    }

    expect(annual.annualHeatDemandKwhYr).toBeCloseTo(expectedDemand, 6);
    expect(annual.annualInputEnergyKwhYr).toBeCloseTo(expectedDemand, 6);
  });

  it('reduces annual demand and cost when seasonal temperatures are warmer', () => {
    const coldDemo = makeSimpleDemo({
      seasonalMinExternalTemp: -2,
      seasonalMaxExternalTemp: 8
    });
    const warmDemo = makeSimpleDemo({
      seasonalMinExternalTemp: 6,
      seasonalMaxExternalTemp: 18
    });

    const cold = computeSeasonalAnnualEnergyModel(coldDemo, RADIATORS, { heating: {} });
    const warm = computeSeasonalAnnualEnergyModel(warmDemo, RADIATORS, { heating: {} });

    expect(warm.annualHeatDemandKwhYr).toBeLessThan(cold.annualHeatDemandKwhYr);
    expect(warm.annualRunningCost).toBeLessThan(cold.annualRunningCost);
  });
});
