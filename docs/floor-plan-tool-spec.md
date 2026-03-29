# Floor Plan Tool Specification (Planning Draft)

## Purpose
Build a more intuitive house-layout workflow where users can draw a floor plan and directly edit rooms, walls, windows, doors, and radiators via click/selection. Reuse the existing editor panel for details editing.

## Goals
- Allow users to draw room geometry directly in the visualization side.
- Support non-rectangular rooms (polygonal outlines).
- Let users click rooms/walls/openings/radiators to edit details in the existing editor panel.
- Represent floors (levels) clearly and model how floor/ceiling elements connect between levels.
- Color rooms by target temperature using the same semantics as the current visualization.
- Keep compatibility with current solver pipeline and data model where possible.

## Non-Goals (MVP)
- Full BIM-grade constraints and CAD operations.
- Arbitrary curved walls.
- Simultaneous multi-user editing.

## User Experience Overview
- Left side: interactive floor plan canvas with tools.
- Right side: existing editor tabs and details panel.
- User flow:
  1. Choose active level (ground/first/etc).
  2. Draw or edit room outlines (polygons).
  3. See immediate room color feedback based on room target/setpoint temperature.
  4. Add openings and radiators by clicking walls/rooms.
  5. Click any entity to inspect and edit details in the right panel.
  6. Solver updates remain available with the same underlying calculations.

## Core Interaction Model
### Tools
- Select
- Draw Room (polygon)
- Split Wall (optional post-MVP)
- Add Window
- Add Door
- Add Radiator
- Pan

### Selection Contract
Single source of truth selection object:
- `entityType`: `zone | element | opening | radiator | vertex | edge`
- `entityId`: id in data model
- `level`: numeric floor index
- `context`: optional metadata (`zoneId`, `elementId`, `index`)

Selection behavior:
- Canvas click sets selection.
- Editor panel listens and focuses corresponding section.
- Editor changes update model and trigger canvas re-render.

### Non-Rectangular Rooms
Room geometry representation (new layout metadata):
- `zone.layout.polygon`: array of vertices in meters, clockwise, no self-intersection.
- Example vertex: `{ "x": 3.2, "y": 5.8 }`

Rules:
- Minimum 3 vertices.
- Auto-close polygon on finish.
- Snap options: grid snap and endpoint snap.
- Room area from polygon shoelace formula.

Validation:
- Reject self-intersections.
- Warn on tiny edges under threshold (for accidental clicks).
- Prevent room outlines that fully overlap existing rooms on same level.

## Multi-Floor and Ceiling/Floor Connections
### Level Model
Use zone `level` as the canonical floor index.

View controls:
- Active-level selector for editing one level at a time.
- Optional "ghost" rendering of adjacent levels for context.

### Vertical Connections
For each room on level `L`, support explicit links:
- `floor_to`: boundary/zone at `L-1` (often ground or zone below)
- `ceiling_to`: boundary/zone at `L+1` (often loft or zone above)

Element mapping guidance:
- If room has zone directly above: create/use `floor_ceiling` between current zone and upper zone.
- If topmost room below loft boundary: create/use `ceiling` element to loft boundary.
- If ground floor over ground boundary: create/use `floor` element to ground boundary.

MVP simplification:
- One horizontal floor polygon per room; derive floor and ceiling areas from room polygon area.
- Manual override remains editable in right panel.

## Data Architecture
## Keep existing solver-facing schema
Do not break `zones`, `elements`, and material/template references.

Add optional layout metadata for authoring UX:
- `meta.layout`:
  - `version`
  - `gridSize`
  - `levels` configuration
- Per zone:
  - `layout.polygon`
  - `layout.label_anchor` (optional)

Derived-element generation layer:
- Convert `layout.polygon` into wall elements with lengths and orientation.
- Keep generated element ids stable when possible.
- Preserve user-edited build-up template links and opening assignments.

Sync strategy:
- `layout -> elements` generation should be deterministic.
- Manual edits to generated elements should be preserved unless geometric conflict occurs.
- Flag conflicts for user resolution.

## Rendering Strategy
Recommended implementation: SVG scene graph.

Color mapping requirement:
- Room fill color should be based on `setpoint_temperature` (target temp) using the current viz thermal palette semantics.
- If no setpoint is present, use a neutral fallback color.
- On setpoint edit, color updates immediately.

Why SVG first:
- Easier hit-testing and per-entity DOM references.
- Better accessibility and inspection during development.
- Good enough performance at MVP scale.

Canvas layers:
- Grid layer
- Room fills and outlines (temperature-colored)
- Wall/opening glyphs
- Radiator glyphs
- Selection/hover overlays

## Editor Integration (Reuse Existing Panel)
Reuse current editor tabs and section components.

Enhancements needed:
- Add API methods in editor module:
  - `focusZone(zoneId)`
  - `focusElement(elementId)`
  - `focusOpening(elementId, openingId)`
  - `focusRadiator(zoneId, radiatorIndex)`
- Auto-expand relevant section and scroll to focused control.

Behavior examples:
- Click wall in canvas -> switch to Room Editor tab -> show owning zone -> expand Fabric -> highlight that wall card.
- Click radiator -> show Radiators section and focus item controls.

## Phased Delivery Plan
### Phase 0: Spec and data contract
- Finalize selection contract, geometry schema, and id strategy.

### Phase 1: Floor plan shell
- Add active level selector and blank SVG canvas in Alternative View tab.
- Implement select, pan, zoom, and hover states.
- Implement target-temperature room fill coloring for existing zones.

### Phase 2: Polygon rooms
- Draw/edit polygonal rooms on active level.
- Validate geometry and compute room area.
- Persist geometry in zone layout metadata.

### Phase 3: Derived walls/elements
- Generate wall elements from polygons.
- Maintain mapping between edges and element ids.
- Keep template links editable.

### Phase 4: Openings and radiators
- Place windows/doors on edges; place radiators in room interior.
- Add drag/reposition and delete interactions.

### Phase 5: Editor focus sync
- Wire canvas selection to editor focus APIs.
- Ensure right panel edits reflect immediately in canvas and model.

### Phase 6: Vertical connectivity UX
- Add controls for floor/ceiling linkage per room.
- Visualize and edit connections between levels.

### Phase 7: Robustness and polish
- Undo/redo stack.
- Keyboard shortcuts.
- Better snapping and conflict prompts.

## Acceptance Criteria (MVP)
- User can draw at least one non-rectangular room on a selected level.
- Room polygon persists in data and survives solve/render cycles.
- Rooms are color-filled by target/setpoint temperature using current viz semantics.
- Wall elements are generated for each room edge with valid dimensions.
- User can place a window and door on a selected wall edge.
- User can place a radiator in a room.
- Clicking room/wall/opening/radiator focuses relevant controls in existing editor panel.
- Floor/ceiling links can be assigned for rooms and represented as valid solver elements.
- Existing heat and U-value tests continue passing.

## Technical Risks and Mitigations
- Geometry-edge id churn: use stable edge hashing from normalized vertex pairs.
- Polygon validity complexity: centralize geometry utilities with unit tests.
- Data sync drift: enforce one-way derivation checkpoints and conflict markers.
- Multi-floor ambiguity: explicit linkage UI and defaults (ground/loft/below zone).

## Suggested New Tests
- Geometry unit tests:
  - polygon area
  - self-intersection detection
  - edge extraction
- Derivation tests:
  - polygon room -> expected wall elements count/lengths
  - multi-level room -> expected floor/ceiling/floor_ceiling elements
- Selection integration tests:
  - click entity -> correct editor focus target
- Visual mapping tests:
  - setpoint update -> room color updates correctly
  - room without setpoint -> neutral fallback color
- Regression:
  - demo model still solves and renders

## Open Questions
- Should room polygons on the same level be allowed to share full walls (same edge) with one canonical element, or duplicated per room then merged?
- For stairs/voids, should we allow floor area holes in polygons in MVP or defer to post-MVP?
- Should level heights be global or per-room for future volume-based calculations?

## Immediate Next Step
Create a short implementation skeleton for Phase 1 in the Alternative View tab:
- Level selector UI
- SVG viewport
- Selection store and event wiring
- No editing yet, but structure ready for polygon tool
