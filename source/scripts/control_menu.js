import { estimateHeatPumpCopFromFlowTemp, estimateBoilerCopFromFlowTemp } from './heating_performance.js';

export function createEnvironmentControlStrip(demo, onMenuAction, getContext) {
  const strip = document.createElement('div');
  strip.className = 'alt-env-strip';

  const requestAction = (action, payload = {}) => {
    if (typeof onMenuAction !== 'function') return;
    onMenuAction(
      action,
      {
        action,
        payload
      },
      typeof getContext === 'function' ? getContext() : {}
    );
  };

  const addSection = (label) => {
    const sec = document.createElement('div');
    sec.className = 'alt-env-section-heading';
    sec.textContent = label;
    strip.appendChild(sec);
  };

  const addSliderCard = (control) => {
    const card = document.createElement('div');
    card.className = 'alt-env-card';
    const labelRow = document.createElement('div');
    labelRow.className = 'alt-env-label-row';
    const label = document.createElement('span');
    label.className = 'alt-env-label';
    label.textContent = control.label;
    const value = document.createElement('span');
    value.className = 'alt-env-value';
    value.textContent = `${control.value}${control.unit}`;
    labelRow.appendChild(label);
    labelRow.appendChild(value);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'alt-env-slider';
    slider.min = String(control.min);
    slider.max = String(control.max);
    slider.step = String(control.step);
    slider.value = String(control.value);
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}${control.unit}`;
    });
    slider.addEventListener('change', () => {
      requestAction(control.action, { value: Number(slider.value) });
    });
    card.appendChild(labelRow);
    card.appendChild(slider);
    if (typeof control.helpText === 'string' && control.helpText.length > 0) {
      const helpDiv = document.createElement('div');
      helpDiv.className = 'alt-env-help-text';
      helpDiv.textContent = control.helpText;
      card.appendChild(helpDiv);
    }
    strip.appendChild(card);
  };

  const heatSourceValue = String(demo?.meta?.heatSourceType || 'gas_boiler');
  const isGasSource = heatSourceValue === 'gas_boiler';
  const isHeatPumpSource = heatSourceValue === 'heat_pump';
  const isDirectElectric = heatSourceValue === 'direct_electric';

  // -- Seasonal --
  addSection('Seasonal');
  addSliderCard({
    label: 'Seasonal Max Outside',
    action: 'environment.set.seasonal_max',
    value: Number.isFinite(Number(demo?.meta?.seasonalMaxExternalTemp))
      ? Number(demo.meta.seasonalMaxExternalTemp) : 16,
    min: -5, max: 35, step: 0.5, unit: '°C',
    helpText: 'Used in monthly sinusoid for annual COP and bills.'
  });
  addSliderCard({
    label: 'Seasonal Min Outside',
    action: 'environment.set.seasonal_min',
    value: Number.isFinite(Number(demo?.meta?.seasonalMinExternalTemp))
      ? Number(demo.meta.seasonalMinExternalTemp)
      : (Number.isFinite(Number(demo?.meta?.systemMinExternalTemp))
        ? Number(demo.meta.systemMinExternalTemp)
        : (Number.isFinite(Number(demo?.meta?.externalTemp)) ? Number(demo.meta.externalTemp) : 3)),
    min: -20, max: 25, step: 0.5, unit: '°C',
    helpText: 'Used in monthly sinusoid for annual COP and bills.'
  });

  // -- System --
  addSection('System');
  addSliderCard({
    label: 'Indoor Target',
    action: 'environment.set.indoor',
    value: Number.isFinite(demo?.meta?.indoorTemp) ? demo.meta.indoorTemp : 21,
    min: 14, max: 26, step: 0.5, unit: '°C'
  });
  addSliderCard({
    label: 'Min Design Temp',
    action: 'environment.set.external',
    value: Number.isFinite(Number(demo?.meta?.systemMinExternalTemp))
      ? Number(demo.meta.systemMinExternalTemp)
      : (Number.isFinite(Number(demo?.meta?.externalTemp)) ? Number(demo.meta.externalTemp) : 3),
    min: -10, max: 20, step: 0.5, unit: '°C',
    helpText: 'Used for sizing and comfort checks at worst-case conditions.'
  });

  const heatSourceCard = document.createElement('div');
  heatSourceCard.className = 'alt-env-card';
  const heatSourceLabel = document.createElement('label');
  heatSourceLabel.className = 'alt-env-label';
  heatSourceLabel.textContent = 'Heat Source';
  heatSourceLabel.setAttribute('for', 'alt-env-heat-source');
  const heatSourceSelect = document.createElement('select');
  heatSourceSelect.className = 'alt-env-select';
  heatSourceSelect.id = 'alt-env-heat-source';
  [
    { value: 'gas_boiler', label: 'Gas Boiler' },
    { value: 'heat_pump', label: 'Heat Pump' },
    { value: 'direct_electric', label: 'Direct Electric' }
  ].forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === heatSourceValue) option.selected = true;
    heatSourceSelect.appendChild(option);
  });
  heatSourceSelect.addEventListener('change', () => {
    requestAction('environment.set.heat_source', { value: heatSourceSelect.value });
  });
  heatSourceCard.appendChild(heatSourceLabel);
  heatSourceCard.appendChild(heatSourceSelect);
  strip.appendChild(heatSourceCard);

  addSliderCard({
    label: 'Max Flow Temp',
    action: 'environment.set.flow',
    value: Number.isFinite(demo?.meta?.flowTemp) ? demo.meta.flowTemp : 55,
    min: 30, max: 75, step: 1, unit: '°C',
    helpText: (() => {
      const eft = Number(demo?.meta?.effective_flow_temp);
      const czn = demo?.meta?.control_zone_name;
      if (!Number.isFinite(eft)) return null;
      return czn
        ? `Thermostat (${czn}) modulates to ${eft.toFixed(1)}°C`
        : 'No thermostat zone set - effective = max.';
    })()
  });

  // Unified System COP card
  const currentFlowTemp = Number.isFinite(Number(demo?.meta?.flowTemp)) ? Number(demo.meta.flowTemp) : 55;
  const effectiveFlowForCop = Number.isFinite(Number(demo?.meta?.effective_flow_temp))
    ? Number(demo.meta.effective_flow_temp)
    : currentFlowTemp;
  const nominalBoilerCop55 = Number.isFinite(Number(demo?.meta?.gasBoilerEfficiency)) ? Number(demo.meta.gasBoilerEfficiency) : 0.9;
  const autoCopForSource = isHeatPumpSource
    ? estimateHeatPumpCopFromFlowTemp(effectiveFlowForCop)
    : (isGasSource ? estimateBoilerCopFromFlowTemp(effectiveFlowForCop, nominalBoilerCop55) : 1.0);
  const effectiveSystemCop = Number.isFinite(Number(demo?.meta?.effective_system_cop))
    ? Number(demo.meta.effective_system_cop)
    : (Number.isFinite(Number(demo?.meta?.effective_scop)) ? Number(demo.meta.effective_scop) : null);

  const legacyCopModeRaw = String(demo?.meta?.heatPumpScopMode || '').trim().toLowerCase();
  const unifiedCopModeRaw = String(demo?.meta?.copMode || '').trim().toLowerCase();
  const resolvedCopMode = (unifiedCopModeRaw === 'fixed' || unifiedCopModeRaw === 'auto')
    ? unifiedCopModeRaw
    : legacyCopModeRaw;
  const copMode = resolvedCopMode === 'fixed' ? 'fixed' : 'auto';

  const legacyHpFixed = Number.isFinite(Number(demo?.meta?.heatPumpFixedScop)) ? Number(demo.meta.heatPumpFixedScop) : 3.2;
  const unifiedFixed = Number.isFinite(Number(demo?.meta?.copFixedValue)) ? Number(demo.meta.copFixedValue) : null;
  const copFixedValue = unifiedFixed ?? (isHeatPumpSource ? legacyHpFixed : (isGasSource ? nominalBoilerCop55 : 1.0));

  const [copMin, copMax, copStep, copDec] = isHeatPumpSource
    ? [1.8, 6.0, 0.1, 2]
    : (isGasSource ? [0.60, 0.99, 0.01, 3] : [1.0, 1.0, 0.1, 2]);

  const systemCopCard = document.createElement('div');
  systemCopCard.className = 'alt-env-card';

  const systemCopHeader = document.createElement('div');
  systemCopHeader.className = 'alt-env-label-row';
  const systemCopLabel = document.createElement('div');
  systemCopLabel.className = 'alt-env-label';
  systemCopLabel.textContent = 'System COP';
  const systemCopHelp = document.createElement('span');
  systemCopHelp.className = 'alt-env-help-btn';
  systemCopHelp.setAttribute('role', 'img');
  systemCopHelp.setAttribute('aria-label', 'System COP help');
  const autoFormula = isHeatPumpSource
    ? 'HP auto: 4.2 - 0.06x(flow-35), clamped 1.8-5.5'
    : (isGasSource
      ? `Boiler auto: nominalCOP+(55-flow)x0.003, clamped 0.6-0.99. Nominal @55C: ${nominalBoilerCop55.toFixed(2)}`
      : 'Direct electric: always 1.0');
  systemCopHelp.title = `${autoFormula}. Auto COP at effective ${effectiveFlowForCop.toFixed(0)}C flow ~= ${autoCopForSource.toFixed(2)}.`;
  systemCopHelp.textContent = '?';
  systemCopHeader.appendChild(systemCopLabel);
  systemCopHeader.appendChild(systemCopHelp);

  const systemCopToggleRow = document.createElement('div');
  systemCopToggleRow.className = 'alt-env-toggle';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'alt-env-toggle-btn' + (copMode === 'auto' ? ' active' : '');
  autoBtn.textContent = 'Auto';
  autoBtn.disabled = isDirectElectric;
  const fixedBtn = document.createElement('button');
  fixedBtn.type = 'button';
  fixedBtn.className = 'alt-env-toggle-btn' + (copMode === 'fixed' ? ' active' : '');
  fixedBtn.textContent = 'Fixed';
  fixedBtn.disabled = isDirectElectric;
  systemCopToggleRow.appendChild(autoBtn);
  systemCopToggleRow.appendChild(fixedBtn);

  const systemCopInput = document.createElement('input');
  systemCopInput.type = 'number';
  systemCopInput.id = 'alt-env-system-cop-value';
  systemCopInput.className = 'alt-env-input';
  systemCopInput.min = String(copMin);
  systemCopInput.max = String(copMax);
  systemCopInput.step = String(copStep);
  const displayedCopValue = copMode === 'auto' ? autoCopForSource : copFixedValue;
  systemCopInput.value = displayedCopValue.toFixed(copDec);
  systemCopInput.disabled = isDirectElectric || copMode !== 'fixed';
  systemCopInput.setAttribute('aria-label', 'Fixed COP value');
  systemCopInput.addEventListener('change', () => {
    requestAction('environment.set.cop_fixed_value', { value: Number(systemCopInput.value) });
  });

  autoBtn.addEventListener('click', () => {
    if (copMode !== 'auto') requestAction('environment.set.cop_mode', { value: 'auto' });
  });
  fixedBtn.addEventListener('click', () => {
    if (copMode !== 'fixed') requestAction('environment.set.cop_mode', { value: 'fixed' });
  });

  const systemCopHelpText = document.createElement('div');
  systemCopHelpText.className = 'alt-env-help-text';
  const effectiveCopStr = Number.isFinite(effectiveSystemCop) ? effectiveSystemCop.toFixed(2) : 'n/a';
  const annualAverageCop = Number(demo?.meta?.annual_average_system_cop);
  const annualAverageCopStr = Number.isFinite(annualAverageCop) ? annualAverageCop.toFixed(2) : 'n/a';
  systemCopHelpText.textContent = isDirectElectric
    ? 'Direct electric: COP is always 1.0.'
    : `Auto ~= ${autoCopForSource.toFixed(2)} at ${effectiveFlowForCop.toFixed(0)}C effective flow. Effective (system-min solve): ${effectiveCopStr}. Annual avg COP: ${annualAverageCopStr}.`;

  systemCopCard.appendChild(systemCopHeader);
  systemCopCard.appendChild(systemCopToggleRow);
  systemCopCard.appendChild(systemCopInput);
  systemCopCard.appendChild(systemCopHelpText);
  strip.appendChild(systemCopCard);

  // -- Tariffs --
  addSection('Tariffs');

  const gasRateCard = document.createElement('div');
  gasRateCard.className = 'alt-env-card';
  const gasRateLabel = document.createElement('label');
  gasRateLabel.className = 'alt-env-label';
  gasRateLabel.textContent = 'Gas Tariff (GBP/kWh)';
  gasRateLabel.setAttribute('for', 'alt-env-gas-rate');
  const gasRateInput = document.createElement('input');
  gasRateInput.type = 'number';
  gasRateInput.id = 'alt-env-gas-rate';
  gasRateInput.className = 'alt-env-input';
  gasRateInput.min = '0.01';
  gasRateInput.max = '2';
  gasRateInput.step = '0.005';
  gasRateInput.value = Number.isFinite(Number(demo?.meta?.gasUnitRate))
    ? Number(demo.meta.gasUnitRate).toFixed(3)
    : '0.070';
  gasRateInput.addEventListener('change', () => {
    requestAction('environment.set.gas_rate', { value: Number(gasRateInput.value) });
  });
  gasRateCard.appendChild(gasRateLabel);
  gasRateCard.appendChild(gasRateInput);
  strip.appendChild(gasRateCard);

  const electricRateCard = document.createElement('div');
  electricRateCard.className = 'alt-env-card';
  const electricRateLabel = document.createElement('label');
  electricRateLabel.className = 'alt-env-label';
  electricRateLabel.textContent = 'Electric Tariff (GBP/kWh)';
  electricRateLabel.setAttribute('for', 'alt-env-electric-rate');
  const electricRateInput = document.createElement('input');
  electricRateInput.type = 'number';
  electricRateInput.id = 'alt-env-electric-rate';
  electricRateInput.className = 'alt-env-input';
  electricRateInput.min = '0.01';
  electricRateInput.max = '2';
  electricRateInput.step = '0.005';
  electricRateInput.value = Number.isFinite(Number(demo?.meta?.electricUnitRate))
    ? Number(demo.meta.electricUnitRate).toFixed(3)
    : '0.240';
  electricRateInput.addEventListener('change', () => {
    requestAction('environment.set.electric_rate', { value: Number(electricRateInput.value) });
  });
  electricRateCard.appendChild(electricRateLabel);
  electricRateCard.appendChild(electricRateInput);
  strip.appendChild(electricRateCard);

  return strip;
}
