# EdgeFleet Twin

Live digital twins of warehouse layouts: in each one, **3 autonomous mobile robots** move objects
between **16 pick/drop stations** and coordinate with each other directly, with no central
traffic controller, to avoid collisions.

Open `index.html` in a browser (no build step, no dependencies). It opens on the **Instances**
page; click an instance to open its console (`index.html#instance-1`, `index.html#instance-2`),
and use the **Instances** breadcrumb or the EdgeFleet logo to go back. The **Create instance**
tile is a UI placeholder for the demo and does nothing when clicked.

To share a single file, run `node tools/build-single.js` and send `dist/edgefleet-twin.html`.

## Instances

**Instance 1 · Bay 01 (cross-aisle grid).** Four storage aisles crossed by three cross-aisles.
`S01–S04` inbound docks on the north wall, `S05–S12` pick faces cut into the racking, `S13–S16`
outbound docks on the south wall. Intersections are `A1…C4`; `J05…J12` are the junctions in front
of the pick-face bays.

**Instance 2 · Bay 02 (mixed-use hall).** Arranged after the reference hall: two banks of
high-bay racking on the west side with narrow pick aisles, bulk floor storage in the centre,
packing cells fed by an overhead conveyor along the north wall, dock doors on the east wall, and
staging, cube storage, cart parking and pallet floor storage in the south-east. The robots run
on a perimeter loop around the racking, a main aisle through it, and a grid of aisles across the
open floor.

| Stations | Where |
| --- | --- |
| `S01–S06` | Rack-end P&D points on the main aisle (three above, three below) |
| `S07` | Bulk floor storage |
| `S08–S10` | Packing cells PC-1 to PC-3 |
| `S11–S14` | Dock doors D1–D4 on the east wall |
| `S15–S16` | Cube storage ports |

Each layout is plain data in `js/world.js` (path network, stations, racks, areas, doors, labels,
robot start positions and task flows), so the same simulation and console run both.

## What you are looking at

The map is drawn as a facility plan: building column grid, racks with their slots, storage and
process areas, the path network the robots drive on, and the 16 stations with their transfer
conveyors.

| On the map | Meaning |
| --- | --- |
| Status light around the robot's deck | Green driving, amber waiting, blue loading or unloading, grey idle |
| Coloured rear band and ID tag | Robot identity: AMR-01 cyan, AMR-02 violet, AMR-03 magenta |
| Solid line in the robot's colour | Path segments it has reserved with the other robots |
| Dashed line | The rest of its planned route, broadcast to the other robots |
| Tinted segment, outlined intersection | Space currently reserved by that robot |
| Dashed line between robots + message box | V2V negotiation, one line per robot |
| Amber zone and bar | Conflict at a node and the hold line where the robot waits |
| Grey dashed trail | A route the robot abandoned when it re-planned |
| Red hatched segment | Blocked path segment, with its countdown |

## Controls

- **Select tool:** click a robot (or its row) to inspect it, click a station to jump to the
  robot serving it. Drag to pan, scroll or double-click to zoom.
- **Block segment tool:** click a path segment to block it for 25 s, click again to reopen.
  Blocks that would trap a robot or cut off a station are refused.
- **Random obstruction** blocks a segment on a route that is in use, so rerouting is easy to show.
- **Layers** toggles paths, reservations, V2V messages, scanner safety fields and labels.
- Keys: `Space` pause · `1–4` speed (0.5×, 1×, 2×, 4×) · `V` select · `B` block · `O` random
  obstruction · `+`/`−` zoom · `0` fit · `F` full screen · `Esc` clear selection.

## How the coordination works

Every robot plans its own route (Dijkstra over the aisle graph, with turn costs) and broadcasts
it as an intent: directed corridor segments with estimated time windows. Peers treat each
other's intents as costs when they plan, so most head-on encounters are avoided before they
happen.

Shared space is claimed peer to peer:

1. Before crossing an intersection a robot must hold **both** the intersection and the corridor
   segment after it, so it never stops inside a junction.
2. Corridors are single-track. Two robots may share one only in the same direction, with a
   minimum gap. A robot won't enter a chain of segments through a junction or corner while
   another robot is coming the other way.
3. When several robots want the same intersection, priority decides the order: a robot carrying
   a payload first, then the earlier arrival, then whoever has waited longest (aging prevents
   starvation).
4. A robot held at a busy corridor re-plans if a free detour is cheaper than waiting.
   Obstructions trigger immediate re-planning.
5. Wait-for cycles (gridlock) are detected. The lowest-priority robot in the cycle takes a
   genuinely free corridor or backs off.

A continuous safety envelope sits beneath all of this: each robot brakes for anything within
its path look-ahead, and every contact is checked with an oriented-box test.

## Verification

`node tools/stress-test.js [hours] [seeds] [layout]` runs the simulation headless for `bay-01`
(instance 1) or `bay-02` (instance 2). It covers calm traffic and a "chaos" mode that randomly
closes and reopens corridors, and fails on any collision or on any robot stalled for more than
45 s. Both layouts record **0 collisions**.

## Files

- `js/world.js`: the layouts (path graph, stations, scenery, fleet, task flows), path geometry
  and hash routing
- `js/sim.js`: robots, tasks, reservations, negotiation, re-planning, gridlock handling (DOM-free)
- `js/render.js`: Canvas 2D floor-map renderer with zoom and pan
- `js/ui.js`, `js/main.js`: console inspector, map tools, routing and the fixed-step loop
- `js/home.js`: Instances page with floor-plan previews
- `tools/`: stress test and single-file bundler
