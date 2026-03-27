#!/usr/bin/env node
// Restore build-up templates with better descriptive names

import fs from 'fs';

const demoPath = './source/resources/demo_house.json';
const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

const betterTemplates = {
  "buo_01": {
    "name": "Internal Wall - Cavity (Plasterboard-Blockwork)",
    "usage_count": 9,
    "build_up": [
      { "material_id": "plasterboard", "thickness": 0.0125 },
      { "material_id": "blockwork", "thickness": 0.1 },
      { "material_id": "plasterboard", "thickness": 0.0125 }
    ]
  },
  "buo_02": {
    "name": "External Wall - Insulated (Stud + PIR)",
    "usage_count": 6,
    "build_up": [
      { "material_id": "plasterboard", "thickness": 0.0125 },
      {
        "type": "composite",
        "thickness": 0.09,
        "paths": [
          { "material_id": "stud_wood", "fraction": 0.15 },
          { "material_id": "pir", "fraction": 0.85 }
        ]
      },
      { "material_id": "pir", "thickness": 0.05 },
      { "material_id": "blockwork", "thickness": 0.1 }
    ]
  },
  "buo_03": {
    "name": "Loft External Wall - Uninsulated",
    "usage_count": 4,
    "build_up": [
      { "material_id": "plasterboard", "thickness": 0.0125 },
      { "material_id": "blockwork", "thickness": 0.1 }
    ]
  },
  "buo_04": {
    "name": "Ground Floor - Insulated (Joist Cavity + XPS)",
    "usage_count": 3,
    "build_up": [
      { "material_id": "plywood", "thickness": 0.018 },
      {
        "type": "composite",
        "thickness": 0.15,
        "paths": [
          { "material_id": "joist_wood", "fraction": 0.15 },
          { "material_id": "rockwool", "fraction": 0.85 }
        ]
      },
      { "material_id": "xps", "thickness": 0.1 }
    ]
  },
  "buo_05": {
    "name": "Inter-floor Ceiling - Acoustic",
    "usage_count": 3,
    "build_up": [
      { "material_id": "plasterboard", "thickness": 0.0125 },
      { "material_id": "glass_wool", "thickness": 0.15 },
      { "material_id": "plywood", "thickness": 0.02 }
    ]
  },
  "buo_06": {
    "name": "Loft Floor - Min Insulation",
    "usage_count": 3,
    "build_up": [
      { "material_id": "plasterboard", "thickness": 0.0125 },
      { "material_id": "rockwool", "thickness": 0.0001 }
    ]
  }
};

// Update templates in the demo
demo.meta = demo.meta || {};
demo.meta.build_up_templates = betterTemplates;

console.log('Restored templates with better names:\n');
Object.entries(betterTemplates).forEach(([id, tpl]) => {
  console.log(`  ${id}: ${tpl.name} (${tpl.usage_count} uses)`);
});

fs.writeFileSync(demoPath, JSON.stringify(demo, null, 2) + '\n');
console.log('\nDone! Templates updated in demo_house.json');
