# The Little Crossing review

Reviewed 4 October 2026 against BRIEF.md and API.md. Reviewer added only `tests/integration.mjs` and this report. Engine, renderer and preview implementation were not changed. No dependencies were installed, no external network was used, and nothing was committed or deployed.

## Result

No implementation defects were found in the exercised cases or source review. This is a bounded integration review, not a production-readiness or browser-visual pass.

Executed from the project folder on Windows with Node **v24.16.0**:

```text
node --test tests/integration.mjs
tests 14
pass 14
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 23932.2301
exit code 0
```

The existing `npm test` script is `node --test tests/*.mjs`, which includes this suite. The recorded execution used the direct Node command above. The elapsed test duration includes assertions and recording mocks; it is not a renderer performance measurement.

## Checked behavior

1. **World contract:** 18 nodes, 54 directed edges, reverse edges, road lengths, axis-aligned geometry, crossing endpoints, and exact bridge IDs/names/rows.
2. **Determinism and reset:** seeds 0, 20261005 and 4294967295 replay identically through demand/closure commands with 0.05, 0.1, 0.25 and 1/60-second frame chunks. Reset restores the initial snapshot and replay, including a pending fractional step. Instances remain independent; seeds 1 and 2 produce different trips.
3. **Input handling:** invalid seeds, step durations, bridge IDs/states and demand modes throw the documented error classes without visible state mutation. Fractional time accumulates, zero does not advance, and a 1000-second input matches one 0.25-second clamped step. Valid mutators return undefined.
4. **Snapshot isolation:** mutations to returned nodes, edges, bridges, cars, routes, counters and arrays do not alter the engine.
5. **Demand and routing:** busy demand admits more trips than calm in the default-seed 60-second comparison. New routes with central closed match an independent Bellman-Ford shortest-distance oracle and contain only open edges.
6. **Individual closures:** each bridge is closed while occupied. Subsequent ticks prevent new entry, preserve continuous road transitions, allow incumbents to leave, and produce actual reroute counter increases. Arrivals continue after reopening.
7. **All-closed recovery:** after 40 busy seconds, all crossings close. For 80 seconds there are no new admissions; remaining trips form a nonempty stationary queue, unchanged for another 10 seconds. Reopening only central allows every identified stranded trip to finish within the following 180 seconds. Starting with every crossing closed admits no cars; opening only south permits arrivals.
8. **Tick invariants:** three seeds each run 300 seconds with repeated closures and demand changes. Checks cover finite/in-world coordinates, progress bounds, at most 120 active cars, unique IDs, opposite-bank outer-node trips, exact five-unit right-hand offsets/headings, connected remaining routes, 18-unit lane gaps, forward motion at the documented speed, connected edge changes at endpoints, and no more than one admission per node per tick. The same invariants also run through closure/recovery cases.
9. **Counters:** active and waiting match observed cars; spawned equals arrived plus active; cumulative counters remain nonnegative integers and monotonic. Arrival increments match disappeared cars at their destinations. Per-tick reroute increments match surviving cars' reroute changes.
10. **Renderer integration:** a strict recording Canvas2D mock accepts real frozen snapshots. Repeated drawing is deterministic and finite at widths 320, 720 and 1440 and pixelRatio options 1 and 2. Context stack/properties/transforms restore; cars use projected engine positions without an extra lane offset and meet the 4.5 by 2.3 CSS-pixel body minimum.
11. **Roads and closures:** the main road layer draws all 27 distinct engine segments exactly once at their node coordinates. Closing all bridges produces six X-marker strokes; open bridges produce none.
12. **Hit targets:** bridge centres share the renderer projection, with tested offsets inside a 44-pixel minimum target at all three widths. Outside-map points and invalid dimensions return null; invalid draw dimensions produce no drawing operations.
13. **Source consistency:** checked local imports, package test command, absence of engine/view browser clock or random dependencies, labeled native bridge/demand controls, pressed state, focus styling and polite status markup. The renderer imports successfully in Node without a DOM. The documented geometry, snapshot fields, lane offset and closure model agree with their consumers on inspection.
14. **Preview wiring:** the actual inline host script runs with a mocked DOM/frame loop and real engine. Bridge buttons and projected map clicks alter engine state; demand, reset and displayed statistics synchronize. Reduced motion starts paused, pause freezes engine snapshots and drawing, and visibility resume avoids a large elapsed-time jump.

## Limits and remaining operator checks

- No real browser was used. Canvas raster output, font rendering, layout/overflow, visual car separation and legibility across 320–1440px still need inspection. Minimum-size cars can be larger than their world-space scale on narrow displays; this review checks the requested size floor, not perceived spacing.
- Recording-context tests check commands and saved state, not browser clipping/rasterization, visual occlusion, actual DPR output or contrast. Both pixelRatio options are exercised against a caller-supplied transform; this is not a pixel-level DPR comparison.
- The host harness mocks DOM elements, frame scheduling, media queries and ResizeObserver, and replaces drawing with a call counter. Real keyboard activation/focus order, touch behavior, screen-reader announcements, resize events, device-pixel-ratio changes and browser visibility timing remain unverified. Markup checks do not constitute an accessibility audit.
- No desktop frame-time or long-running browser performance benchmark was run. The approximate 10ms/frame aspiration remains unverified.
- Finite-seed/time tests support bounded behavior in those runs; they do not exhaust all seeds, frame partitions or command histories. They check one admission per node per tick, but do not independently exhaustively verify the complete 0.5-second fairness/oldest-arrival policy. The source implements a ten-tick junction cooldown and age/order sorting.
- Routing tests independently check new-trip shortest lengths. They check observed replanning and closure recovery but do not exhaust all equal-distance tie cases. Exact mathematical equivalence for arbitrarily tiny floating-point frame chunks is not claimed.
- Source checks are targeted assertions plus manual review, not a general JavaScript security or static-analysis audit. Drawing with malformed snapshots is outside the documented engine-produced-snapshot contract.

## Reviewed implementation fingerprints

SHA-256, recorded after the successful suite:

```text
city-engine.mjs  DA619EB321D4AFFD4663E63B9DD199490DD052FEDE62CDB0EAC09DA85B43698F
city-view.mjs    2A33E477559FDB59654729D865DAA19DEA361C44C196D48AD0374064470516B3
preview.html     5347D7F47484C4D6D5A6A0A35C35ADF28422E5BA6477105BFDE1A83BF2C04D29
```
