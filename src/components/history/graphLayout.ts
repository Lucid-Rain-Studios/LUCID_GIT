import type { CommitEntry } from '@/ipc'

// ── Visual constants (exported so the component can use them) ─────────────────
export const LANE_W    = 16   // px per lane
export const ROW_H     = 48   // px per commit row
export const DOT_R     = 4.5  // commit dot radius
export const GRAPH_PAD = 8    // left/right padding inside the graph SVG

// Colour palette for lanes — cycles when exhausted
const LANE_COLORS = [
  '#4d9dff',
  '#e8622f',
  '#2ec573',
  '#a27ef0',
  '#f5a832',
  '#1abc9c',
  '#e91e63',
  '#00bcd4',
  '#8bc34a',
  '#ff5722',
]

// ── Types ─────────────────────────────────────────────────────────────────────

type LaneCell = { hash: string; color: string } | null

export interface LineSegment {
  from:  number
  to:    number
  color: string
}

export interface GraphNode {
  commit:      CommitEntry
  lane:        number
  color:       string
  maxLane:     number
  /** Lines drawn in the top half of this row (incoming). */
  topLines:    LineSegment[]
  /** Lines drawn in the bottom half of this row (outgoing). */
  bottomLines: LineSegment[]
}

// ── Algorithm ─────────────────────────────────────────────────────────────────

/**
 * Compute a lane-based graph layout for a list of commits.
 *
 * Assumptions:
 *  - commits are in reverse-chronological / topological order (newest first)
 *  - commit.parentHashes[0] is the "primary" parent (first-parent rule)
 */
export function computeGraph(commits: CommitEntry[]): GraphNode[] {
  const lanes: LaneCell[] = []
  let   colorIdx = 0
  const nodes: GraphNode[] = []

  for (const commit of commits) {
    // ── 1. Snapshot lanes before this commit (for top-half rendering) ──────
    const prevLanes = lanes.map(l => l ? { ...l } : null)

    // ── 2. Find which lane this commit occupies ─────────────────────────────
    let commitLane = lanes.findIndex(l => l?.hash === commit.hash)
    let commitColor: string

    if (commitLane === -1) {
      // Branch tip not yet tracked — reuse first empty slot or extend
      const emptyIdx = lanes.findIndex(l => l === null)
      commitLane  = emptyIdx !== -1 ? emptyIdx : lanes.length
      commitColor = LANE_COLORS[colorIdx++ % LANE_COLORS.length]
      if (emptyIdx !== -1) {
        lanes[emptyIdx] = { hash: commit.hash, color: commitColor }
      } else {
        lanes.push({ hash: commit.hash, color: commitColor })
      }
    } else {
      commitColor = lanes[commitLane]!.color
    }

    // ── 3. Clear sibling lanes that also track this commit (convergence) ───
    //     This happens when two branches share the same root commit.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== commitLane && lanes[i]?.hash === commit.hash) {
        lanes[i] = null
      }
    }

    // ── 4. Build top-half lines: prevLanes → this commit ───────────────────
    const topLines: LineSegment[] = []
    for (let i = 0; i < prevLanes.length; i++) {
      const l = prevLanes[i]
      if (!l) continue
      if (l.hash === commit.hash) {
        // This lane was tracking the current commit → converge to commitLane
        topLines.push({ from: i, to: commitLane, color: l.color })
      } else {
        // Unrelated lane → straight vertical pass-through
        topLines.push({ from: i, to: i, color: l.color })
      }
    }

    // ── 5. Advance lanes to parents ─────────────────────────────────────────
    const [firstParent, ...mergeParents] = commit.parentHashes

    if (firstParent) {
      lanes[commitLane] = { hash: firstParent, color: commitColor }
    } else {
      lanes[commitLane] = null  // root commit
    }

    // Allocate lanes for merge parents
    const mergeTargetLanes: number[] = []
    for (const pHash of mergeParents) {
      const existing = lanes.findIndex(l => l?.hash === pHash)
      if (existing !== -1) {
        mergeTargetLanes.push(existing)
      } else {
        const emptyIdx = lanes.findIndex(l => l === null)
        const newLane  = emptyIdx !== -1 ? emptyIdx : lanes.length
        const newColor = LANE_COLORS[colorIdx++ % LANE_COLORS.length]
        if (emptyIdx !== -1) {
          lanes[emptyIdx] = { hash: pHash, color: newColor }
        } else {
          lanes.push({ hash: pHash, color: newColor })
        }
        mergeTargetLanes.push(newLane)
      }
    }

    // ── 6. Build bottom-half lines: this commit → lanesAfter ───────────────
    const bottomLines: LineSegment[] = []
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      bottomLines.push({ from: i, to: i, color: l.color })
    }
    // Extra lines from commitLane to each merge parent lane
    for (const targetLane of mergeTargetLanes) {
      bottomLines.push({ from: commitLane, to: targetLane, color: commitColor })
    }

    // ── 7. Trim trailing nulls ───────────────────────────────────────────────
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
    }

    // ── 8. Record the widest lane index this row needs ──────────────────────
    const maxLane = Math.max(
      commitLane,
      ...topLines.flatMap(l    => [l.from, l.to]),
      ...bottomLines.flatMap(l => [l.from, l.to]),
      0,
    )

    nodes.push({ commit, lane: commitLane, color: commitColor, maxLane, topLines, bottomLines })
  }

  return nodes
}
