// Shared heating system COP estimators used by solver and UI.

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!isFinite(numeric)) return min;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

export function estimateHeatPumpCopFromFlowTemp(flowTemp) {
  const flow = clampNumber(flowTemp, 30, 75);
  const baseCop = 4.2 - ((flow - 35) * 0.06);
  return clampNumber(baseCop, 1.8, 5.5);
}

export function estimateBoilerCopFromFlowTemp(flowTemp, nominalCopAt55C = 0.9) {
  const flow = clampNumber(flowTemp, 30, 80);
  const nominal = clampNumber(nominalCopAt55C, 0.6, 0.99);

  // Approximate condensing-boiler behavior:
  // lower flow/return temperatures increase condensing time and seasonal COP.
  const cop = nominal + ((55 - flow) * 0.003);
  return clampNumber(cop, 0.6, 0.99);
}
