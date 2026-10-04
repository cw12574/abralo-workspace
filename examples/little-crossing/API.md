# Traffic engine API

```js
import { createCity } from './city-engine.mjs';
const city = createCity({ seed: 20261005 });
city.step(1 / 60);
city.setBridgeOpen('central', false);
const frame = city.snapshot();
```

Each instance owns its state. No dependencies, DOM, wall clock, network or global random source are used. The seed must be an unsigned 32-bit integer, including zero. A seeded Mulberry32 generator selects trip origins and destinations.

## Methods

- `step(seconds)` advances by fixed 0.05-second ticks, retaining fractional time. Finite nonnegative numeric input is required; invalid input throws `TypeError` without changing state. Each call is clamped to 0.25 seconds. Equal elapsed time split into calls at or below that clamp gives equivalent results, with the same commands applied at the same simulation ticks. Calling with zero does not advance time.
- `setBridgeOpen(id, open)` accepts `north`, `central`, or `south` and a boolean. Unknown IDs throw `RangeError`; nonboolean states throw `TypeError`. Changes immediately update bridge and directed-edge flags. Cars already on the bridge finish it; no new car enters a closed crossing.
- `setDemand(mode)` accepts `calm` or `busy`; other values throw `RangeError`. Calm offers a trip every 0.9 seconds, busy every 0.25 seconds. Changes preserve the elapsed spawn timer.
- `reset()` restores the original seed, calm demand, all bridges open, time zero, empty traffic and zero counters. Replaying the same steps and commands reproduces the same result.
- `snapshot()` returns a defensive plain object, including fresh nested arrays and objects. Editing it cannot affect the engine. Mutator methods return `undefined`.

## World and snapshot

World coordinates are 1100 by 640, with positive y downward. The six columns are `[80,260,440,660,840,1020]`; the rows are `[130,320,510]`. The river is centered at x550, width140. All adjacent horizontal and vertical grid nodes connect in both directions. River crossings run from x440 to x660 at each row.

`snapshot()` contains:

- `time`: elapsed simulated seconds, quantized to the internal tick; `seed`: original seed; `demand`: current mode.
- `nodes`: `{id,x,y}`. IDs are `n<row>-<column>`, with zero-based indices.
- `edges`: `{id,from,to,bridge,closed,length}`. IDs are `<from>><to>`. `bridge` is a bridge ID or null; `length` is the centerline distance in world units. The 54 directed edges represent 27 two-way road segments. The renderer should deduplicate reverse pairs when painting roads.
- `bridges`: `{id,name,y,open}`. North is Willow bridge at y130, central is Market bridge at y320, south is Foundry bridge at y510.
- `cars`: `{id,x,y,angle,waiting,reroutes,origin,target,edgeId,progress,route}`. IDs are stable for a trip. `progress` is distance along the current directed edge; `route` contains planned edge IDs after that edge. The plan can be stale until the car reaches a node. `angle` is the heading in radians; zero points right, positive angles rotate clockwise in canvas coordinates. Positions include a five-unit right-hand lane offset. Draw cars centered at these positions; do not add another lane offset.
- `stats`: `{arrived,active,waiting,rerouted,spawned}`. `spawned` counts admitted cars, `arrived` completed trips, `active` current cars, and `waiting` cars that did not move during the latest simulation tick. `rerouted` is the cumulative number of changed remaining plans, not the number of unique cars. Each car also exposes its own reroute count. Always `spawned === arrived + active`.

## Routing, following and junctions

Trips start at a randomly chosen outer node (x80 or x1020) and end at a randomly chosen outer node on the opposite bank. Dijkstra chooses the shortest open path by road length; stable graph traversal resolves ties. At every node a car replans. A changed remaining plan increments reroute counters once, even if the car must then wait for space. If no route exists, its last plan is retained and it waits at the node until a route becomes available. Cars never jump to a different road partway along an edge.

Free movement is 48 world units per second. Cars on a directed edge move front to back with at least 18 units of center-to-center separation. Opposite directions use separate lanes. At nodes, arrivals wait at least until the next tick. Oldest arrivals get first opportunity to enter an available outgoing lane, with creation order breaking ties. A node admits at most one car per 0.5 seconds, regardless of direction; an outgoing lane must have 18 units of room at its entrance. A blocked movement does not prevent another eligible movement from using the junction. Cars reaching their final node exit on the next tick. New trips also respect entrance spacing and their origin's junction timer.

The hard active-car cap is 120. Spawn attempts without a path, entrance space or junction capacity are discarded, not stored in an invisible growing queue. Thus closing all bridges stops new trips; existing cars finish their current edges and queue at nodes (or complete trips already across the river). Reopening permits those queued trips to continue. Attempt rates differ from admitted throughput when roads are busy.

This is a small playable traffic illustration. The junction rule abstracts turning and intersection occupancy; it is not a road-capacity or collision-physics model. Lane offsets can shift around a corner as a car changes to its next edge at the shared node.

## Renderer and host integration

The companion view exports `drawCity(context, snapshot, {width,height,pixelRatio=1}={})` and `bridgeHitTest(x,y,width,height)`. Width and height are CSS pixels. The host owns canvas backing-store size, pixel-ratio transform, controls, accessibility and the frame loop; the view restores canvas state after drawing. Bridge hit tests use CSS-local coordinates and return a bridge ID or null. The view uses the same world projection as the hit test.

Use animation-frame elapsed seconds with `step`; pause by skipping `step` entirely. The snapshot's time drives any decoration that moves. After a bridge or demand command, obtain a fresh snapshot. An accessible host should provide labeled keyboard-operable bridge controls, pressed/open state, pause, demand and reset controls, plus textual statistics. The canvas is a visual companion to those controls.

## Engine verification at handoff

Local inline Node assertions passed for fixed-step frame chunking (600 calls of 0.1 seconds versus 3600 calls of 1/60), reset, input validation, step clamp, snapshot isolation, demand increase, closed-edge entry prevention, rerouting, lane gaps, finite positions, car conservation, bounds and all-closed recovery. During the closure run, every tick was checked for 80 simulated seconds. With the default seed, 60 seconds admitted 65 calm trips versus 181 busy trips. An all-closed run left 26 active cars waiting; after reopening, arrivals increased from 294 to 484 over 80 seconds. These are engine checks, not visual or performance verification. The separate integration test suite is added in the later testing stage.
