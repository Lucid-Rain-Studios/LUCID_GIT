import type { CommitEntry } from '@/ipc'

// ── Visual constants (exported so the component can use them) ─────────────────
export const LANE_W    = 16   // px per lane
export const ROW_H     = 48   // px per commit row
export const DOT_R     = 4.5  // commit dot radius
export const GRAPH_PAD = 8    // left/right padding inside the graph SVG

// Colour palette for lanes — indexed by a hash of the branch key, never by
// allocation order, so a branch keeps its colour across reloads and re-filters.
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

/**
 * Map a branch key to a colour. Pure function of the key, so the same branch
 * always renders in the same colour — in the graph, in its tip pill, and in the
 * branch filter. With more branches than palette entries two branches can still
 * land on one colour, but the pairing is stable rather than shuffling per load.
 */
export function branchColor(branchKey: string): string {
  let h = 2166136261
  for (let i = 0; i < branchKey.length; i++) {
    h ^= branchKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return LANE_COLORS[(h >>> 0) % LANE_COLORS.length]
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LaneCell = { hash: string; color: string; branchKey: string } | null

export interface LineSegment {
  from:  number
  to:    number
  color: string
  /** Stable identity of the branch this segment belongs to (never the colour). */
  branchKey?: string
  isMain?: boolean
}

export interface GraphNode {
  commit:      CommitEntry
  lane:        number
  color:       string
  /** Stable identity of the branch this commit sits on (never the colour). */
  branchKey:   string
  isMain?:     boolean
  maxLane:     number
  /** Lines drawn in the top half of this row (incoming). */
  topLines:    LineSegment[]
  /** Lines drawn in the bottom half of this row (outgoing). */
  bottomLines: LineSegment[]
}

export interface ComputeGraphOptions {
  /**
   * Commit hash → branch name, for hashes that are a known branch tip. A lane
   * opening at a known tip is keyed by the branch *name*, so its identity (and
   * therefore its colour) survives new commits landing on that branch. Lanes
   * with no known tip fall back to the hash that opened them.
   */
  branchNameByHash?: Map<string, string>
}

// ── Algorithm ─────────────────────────────────────────────────────────────────

/**
 * Compute a lane-based graph layout for a list of commits.
 *
 * Assumptions:
 *  - commits are in reverse-chronological / topological order (newest first)
 *  - commit.parentHashes[0] is the "primary" parent (first-parent rule)
 */
export function computeGraph(commits: CommitEntry[], opts: ComputeGraphOptions = {}): GraphNode[] {
  const lanes: LaneCell[] = []
  const nodes: GraphNode[] = []
  const { branchNameByHash } = opts

  // Identity of a lane opened at `hash`: the branch name when that hash is a
  // known tip, else the hash itself. Never depends on allocation order.
  const keyForHash = (hash: string) => branchNameByHash?.get(hash) ?? `commit:${hash}`

  for (const commit of commits) {
    // ── 1. Snapshot lanes before this commit (for top-half rendering) ──────
    const prevLanes = lanes.map(l => l ? { ...l } : null)

    // ── 2. Find which lane this commit occupies ─────────────────────────────
    let commitLane = lanes.findIndex(l => l?.hash === commit.hash)
    let commitColor: string
    let commitBranchKey: string

    if (commitLane === -1) {
      // Branch tip not yet tracked — reuse first empty slot or extend
      const emptyIdx = lanes.findIndex(l => l === null)
      commitLane      = emptyIdx !== -1 ? emptyIdx : lanes.length
      commitBranchKey = keyForHash(commit.hash)
      commitColor     = branchColor(commitBranchKey)
      const cell = { hash: commit.hash, color: commitColor, branchKey: commitBranchKey }
      if (emptyIdx !== -1) lanes[emptyIdx] = cell
      else                 lanes.push(cell)
    } else {
      commitColor     = lanes[commitLane]!.color
      commitBranchKey = lanes[commitLane]!.branchKey
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
        topLines.push({ from: i, to: commitLane, color: l.color, branchKey: l.branchKey })
      } else {
        // Unrelated lane → straight vertical pass-through
        topLines.push({ from: i, to: i, color: l.color, branchKey: l.branchKey })
      }
    }

    // ── 5. Advance lanes to parents ─────────────────────────────────────────
    const [firstParent, ...mergeParents] = commit.parentHashes

    if (firstParent) {
      // First-parent continues the same branch → carry identity and colour over.
      lanes[commitLane] = { hash: firstParent, color: commitColor, branchKey: commitBranchKey }
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
        const emptyIdx  = lanes.findIndex(l => l === null)
        const newLane   = emptyIdx !== -1 ? emptyIdx : lanes.length
        const newKey    = keyForHash(pHash)
        const newColor  = branchColor(newKey)
        const cell = { hash: pHash, color: newColor, branchKey: newKey }
        if (emptyIdx !== -1) lanes[emptyIdx] = cell
        else                 lanes.push(cell)
        mergeTargetLanes.push(newLane)
      }
    }

    // ── 6. Build bottom-half lines: this commit → lanesAfter ───────────────
    const bottomLines: LineSegment[] = []
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      bottomLines.push({ from: i, to: i, color: l.color, branchKey: l.branchKey })
    }
    // Extra lines from commitLane down to each merge parent's lane. The segment
    // belongs to the parent's branch — that is the branch being merged in, and
    // the line the user follows when tracing it.
    for (const targetLane of mergeTargetLanes) {
      const target = lanes[targetLane]
      bottomLines.push({
        from: commitLane, to: targetLane,
        color: target?.color ?? commitColor,
        branchKey: target?.branchKey ?? commitBranchKey,
      })
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

    nodes.push({ commit, lane: commitLane, color: commitColor, branchKey: commitBranchKey, maxLane, topLines, bottomLines })
  }

  return nodes
}
