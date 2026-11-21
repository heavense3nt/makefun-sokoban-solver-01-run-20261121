# makefun-sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/heavense3nt/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/heavense3nt/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty. It exploits the level structure — every level is a one-square-wide hallway with 1–4 rooms off it, each room holding 3–4 boxes and as many goals — and solves each room independently, push-optimally, then stitches the rooms together with hallway walks. A box pushed out of a room can never return, so a level's push-optimal count is the sum of its rooms' optima.

## How it works

- **Room detection.** The player starts in the hallway; each room is found by flood-filling from a door cell (a floor cell just off the hallway with a hallway neighbour). Each room's boxes, goals and door are recorded separately.
- **Push-optimal macro-push A\* per room.** The state is the sorted box cells plus the player's reachable region, canonicalised to its lowest cell (a flood fill with boxes as obstacles). Moves are pushes only; walks are reconstructed afterwards with BFS.
- **Admissible heuristic.** Minimum-cost assignment of boxes to goals over precomputed BFS distances (brute-force permutations, at most 4 boxes per room), so the A\* search is exact and returns the push-optimal plan.
- **Deadlock pruning.** Static dead squares from optimistic pull-reachability from the goals, plus 2×2 frozen-block detection.
- **Deterministic work budgets.** Each room is tried with A\* at a 150,000-expansion cap, then 1,500,000, then a greedy best-first fallback at 500,000 — budgets by node count, never by the clock, so two runs produce byte-identical output.
- **Room ordering.** Every room is solved twice — once requiring the player to be able to exit afterwards (door free and reachable) and once without — and the room whose exit costs the most extra pushes goes last, where no exit is needed.

## Practice results

Scored with the kit's scorer on the practice set (push-optimal counts 13 / 16 / 29 / 47 / 60):

| instance | pushes | points |
|----------|--------|--------|
| i001 | 13 | 1,000,000 |
| i002 | 16 | 1,000,000 |
| i003 | 29 | 1,000,000 |
| i004 | 47 | 1,000,000 |
| i005 | 60 | 1,000,000 |

**Practice score: 1,000,000** (the house baseline plain-astar 1.0.0 scores 200,000 — it solves only i001). The whole practice set runs in about 0.5 s, far inside the 60 s wall budget, and two runs are byte-identical.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Node 22, standard library only, no network, no native code. Reads `/input/<id>/level.txt` for `i001`–`i005` and writes `/output/<id>/solution.txt` for each.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s5yp534n&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
