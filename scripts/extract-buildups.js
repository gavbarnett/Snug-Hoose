#!/usr/bin/env node
// Extract common build-ups from demo_house.json into reusable templates

import fs from 'fs';

const demoPath = './source/resources/demo_house.json';
const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

// Identify build-up patterns by comparing JSON structures
function buildupSignature(buildup) {
  return JSON.stringify(buildup);
}

// Map signature → {count, first_id, buildup}
const buildupMap = new Map();

for (const el of demo.elements || []) {
  if (!el.build_up) continue;
  const sig = buildupSignature(el.build_up);
  if (!buildupMap.has(sig)) {
    buildupMap.set(sig, { count: 0, example_id: el.id, buildup: el.build_up });
  }
  buildupMap.get(sig).count++;
}

// Sort by frequency
const sorted = Array.from(buildupMap.entries()).sort((a, b) => b[1].count - a[1].count);

console.log(`Found ${sorted.length} unique build-up patterns.\n`);

// Define templates for patterns that appear 2+ times
const templates = {};
let templateId = 1;

for (const [sig, info] of sorted) {
  if (info.count < 2) break; // Stop at patterns used only once

  const tplId = `buo_${templateId.toString().padStart(2, '0')}`;
  const templateName = templateNames[templateId - 1] || `Build-up template ${templateId}`;
  templates[tplId] = {
    name: templateName,
    usage_count: info.count,
    build_up: info.buildup
  };

  console.log(`${tplId}: used ${info.count}x (example: ${info.example_id})`);
  console.log(`  ${JSON.stringify(info.buildup).substring(0, 100)}...\n`);

  templateId++;
}
// Define descriptive names for templates based on their index
const templateNames = [
  'Internal Wall - Cavity (Plasterboard-Blockwork)',
  'External Wall - Insulated (Stud + PIR)',
  'Loft External Wall - Uninsulated',
  'Ground Floor - Insulated (Joist Cavity + XPS)',
  'Inter-floor Ceiling - Acoustic',
  'Loft Floor - Min Insulation'
];

// Add templates to the meta section
demo.meta = demo.meta || {};
demo.meta.build_up_templates = templates;

// Replace inline build_ups with references
const updates = [];
for (const el of demo.elements || []) {
  if (!el.build_up) continue;
  const sig = buildupSignature(el.build_up);
  for (const [tplId, tpl] of Object.entries(templates)) {
    if (JSON.stringify(tpl.build_up) === sig) {
      updates.push({ element_id: el.id, template_id: tplId });
      el.build_up_template_id = tplId;
      delete el.build_up;
      break;
    }
  }
}

console.log(`Updated ${updates.length} elements to use templates.`);
console.log(`\nWriting updated demo_house.json...`);

fs.writeFileSync(demoPath, JSON.stringify(demo, null, 2) + '\n');
console.log('Done!');
console.log(`Updated ${updates.length} elements to use templates.\n`);
console.log(`Writing updated demo_house.json...`);

fs.writeFileSync(demoPath, JSON.stringify(demo, null, 2) + '\n');
console.log('Done! Templates are now available in the editor.');
