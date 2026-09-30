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

## People on the floor

A few workers walk the floor in each instance: dock operators and a shipping clerk on the dock
aprons in Bay 01; a picker in the narrow pick aisles, a packer at the packing cells, a staging
operator and a stock checker in Bay 02. They walk on painted green walkways between work spots,
pause there to work, and cross robot lanes only on zebra crosswalks.

The aisles are shared as well. In both instances a shift supervisor and an inventory auditor walk
the robot lanes themselves, between rack-face work spots (the yellow standing boxes at the lane
edge):

- They walk a little right of the lane centre, in the robots' path. When a robot heads their way
  they step aside to the lane edge, face it and wait until it has passed. The log records it.
- They pass a standing robot at the lane edge, and walk around a blocked segment the same way.
- They cross a robot intersection only when no robot is in it or about to enter it. While they
  cross, the intersection is outlined amber and robots stop short of it. Otherwise they wait at
  the lane edge (outlined green).
- A person never stands still inside a lane's swept path, so a robot is never held up by
  someone who is waiting for it, and the two never deadlock.

On the robot side:

- A person waits at the kerb while a robot is on the crosswalk or about to reach it, and never
  stops once crossing.
- Robots slow down near a person along a braking curve: to about 1 m/s beside a walkway, and to
  a creep (0.6 m/s) passing someone standing aside in a shared aisle. They stop for anyone in
  their path and before a crosswalk or intersection someone is crossing. The log records each
  stop.
- A robot holds an in-place turn while a person is within reach of its corners.
- Robot–person contacts count as collisions; the stress test verifies there are none, and fails
  if a person ever stands still inside a lane for more than 3 s.

Hover a person to see their role and what they are doing. The scanner safety field layer also
shows the protective radius around each person.

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
| Green walkway, zebra crossing | Pedestrian walkway and crosswalk; the crosswalk is outlined while someone uses it |
| Yellow dashed box at a lane edge | Rack-face work spot in a shared aisle, where a person stands aside |
| Amber / green square on an intersection | A person is crossing it / waiting at the lane edge to cross |
| Figure with a coloured ring | A worker (hard hat and hi-vis vest seen from above) |

## Controls

- **Select tool:** click a robot (or its row) to inspect it, click a station to jump to the
  robot serving it. Drag to pan, scroll or double-click to zoom.
- **Block segment tool:** click a path segment to block it for 25 s, click again to reopen.
  Blocks that would trap a robot or cut off a station are refused.
- **Random obstruction** blocks a segment on a route that is in use, so rerouting is easy to show.
- **Layers** toggles paths, reservations, V2V messages, scanner safety fields and labels.
- **Floor plan style** (moon and sun buttons in the map toolbar, or `L`) switches the warehouse
  map between the default light, daylight style (pale concrete, white walls, white cartons on
  wooden pallets, dock leveller plates and soft shadows) and a dark style. Only the map changes;
  the console around it stays dark. The choice is remembered in the browser and also applies to
  the previews on the Instances page.
- Keys: `Space` pause · `1–4` speed (0.5×, 1×, 2×, 4×) · `V` select · `B` block · `O` random
  obstruction · `+`/`−` zoom · `0` fit · `L` floor plan style · `F` full screen · `Esc` clear selection.

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
closes and reopens corridors. It fails on any collision (robot–robot or robot–person), on any
robot stalled for more than 45 s, or on a person standing still inside a lane for more than 3 s.
Over 3 × 3 h per mode, both layouts record **0 collisions**. The longest robot stall is 18 s, the
longest wait by a person at a kerb or intersection is 11 s, and throughput is 266–295
deliveries/h with the shared-aisle walkers on the floor.

## Files

- `js/world.js`: the layouts (path graph, stations, scenery, fleet, task flows), path geometry
  and hash routing
- `js/sim.js`: robots, tasks, reservations, negotiation, re-planning, gridlock handling (DOM-free)
- `js/render.js`: Canvas 2D floor-map renderer with zoom and pan
- `js/ui.js`, `js/main.js`: console inspector, map tools, routing and the fixed-step loop
- `js/home.js`: Instances page with floor-plan previews
- `tools/`: stress test and single-file bundler
