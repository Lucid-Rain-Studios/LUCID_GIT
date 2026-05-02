// HistoryPanel.jsx — Commit history with multi-lane branch graph

function HistoryPanel({ commits, selectedHash, onSelect, selectedFiles }) {
  const T = window.T
  const D = window.MockData

  // ── Graph constants ──────────────────────────────────────────────────
  const LANE_W    = 13
  const NODE_R    = 4
  const NODE_R_M  = 5
  const GRAPH_PAD = 7
  const ROW_H     = 40
  const LANE_COLORS = [T.blue, T.orange, T.green, T.purple]

  // ── Filter state ─────────────────────────────────────────────────────
  const [hiddenLanes,   setHiddenLanes]   = React.useState(new Set())
  const [dropdownOpen,  setDropdownOpen]  = React.useState(false)

  const allBranches   = D.branches || []
  const currentLane   = allBranches.find(b => b.isCurrent)?.lane ?? 1
  const coreLanes     = new Set([0, currentLane])
  const nonCoreLanes  = allBranches.map(b => b.lane).filter(l => !coreLanes.has(l))
  const isCollapsed   = nonCoreLanes.every(l => hiddenLanes.has(l))

  const toggleLane = lane => {
    if (lane === 0) return
    setHiddenLanes(prev => {
      const next = new Set(prev)
      next.has(lane) ? next.delete(lane) : next.add(lane)
      return next
    })
  }

  const toggleCollapse = () => {
    if (isCollapsed) {
      setHiddenLanes(new Set())
    } else {
      setHiddenLanes(new Set(nonCoreLanes))
    }
  }

  // ── Dynamic lane layout (remapped to consecutive positions) ──────────
  // Hidden lanes are removed; remaining lanes are packed left-to-right.
  const visibleLaneArr  = [0, 1, 2, 3].filter(l => !hiddenLanes.has(l))
  const laneDisplayPos  = Object.fromEntries(visibleLaneArr.map((l, i) => [l, i]))
  const laneX           = l => GRAPH_PAD + (laneDisplayPos[l] ?? 0) * LANE_W + LANE_W / 2
  const GRAPH_W         = GRAPH_PAD + visibleLaneArr.length * LANE_W + 6

  // Only show commits whose lane is visible (working tree always shown)
  const visibleCommits = commits.filter(c =>
    c.isWorkingTree || !hiddenLanes.has(c.lane)
  )

  // ── Branch tip labels (first non-WT commit per lane) ─────────────────
  const branchTipsByHash = React.useMemo(() => {
    const map = {}
    allBranches.forEach(br => {
      const tip = commits.find(c => !c.isWorkingTree && c.lane === br.lane)
      if (tip) map[tip.hash] = br
    })
    return map
  }, [commits])

  // ── Drag resize ──────────────────────────────────────────────────────
  const [listWidth, setListWidth] = React.useState(460)
  const dragging    = React.useRef(false)
  const dragStartX  = React.useRef(0)
  const dragStartW  = React.useRef(0)

  const onDragStart = React.useCallback(e => {
    dragging.current   = true
    dragStartX.current = e.clientX
    dragStartW.current = listWidth
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = ev => {
      if (!dragging.current) return
      setListWidth(Math.max(300, Math.min(720, dragStartW.current + (ev.clientX - dragStartX.current))))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [listWidth])

  const PaneDragHandle = () => {
    const [hov, setHov] = React.useState(false)
    return (
      <div onMouseDown={onDragStart}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ width: 4, flexShrink: 0, cursor: 'col-resize',
          background: hov ? T.orange : T.border, transition: 'background 0.15s', zIndex: 5 }} />
    )
  }

  // ── Graph SVG cell ───────────────────────────────────────────────────
  const GraphCell = React.memo(({ commit }) => {
    const cx  = laneX(commit.lane)
    const cy  = ROW_H / 2
    const col = LANE_COLORS[commit.lane]
    const isMainLane    = commit.lane === 0
    const isCurrentLane = commit.lane === currentLane

    // Skip rendering if this commit's lane is hidden
    if (hiddenLanes.has(commit.lane) && !commit.isWorkingTree) {
      return <div style={{ width: GRAPH_W, height: ROW_H, flexShrink: 0 }} />
    }

    const lw  = l => l === 0 ? 2.2 : 1.6
    const lop = l => hiddenLanes.has(l) ? 0 : l === 0 ? 0.88 : 0.52
    const lc  = l => LANE_COLORS[l]

    const lineEl = (lane, y1, y2, key) => {
      if (hiddenLanes.has(lane)) return null
      return (
        <line key={key}
          x1={laneX(lane)} y1={y1} x2={laneX(lane)} y2={y2}
          stroke={lc(lane)} strokeWidth={lw(lane)} strokeOpacity={lop(lane)}
        />
      )
    }

    const laneLines = () => {
      const els = []
      const mergeFromLane = commit.mergeArc ? commit.mergeArc.from : -1
      const allLanes = new Set([...commit.topLines, ...commit.bottomLines])
      if (mergeFromLane >= 0) allLanes.add(mergeFromLane)

      allLanes.forEach(lane => {
        if (hiddenLanes.has(lane)) return   // skip hidden lanes entirely
        const inTop    = commit.topLines.includes(lane)
        const inBottom = commit.bottomLines.includes(lane)
        const isMF     = lane === mergeFromLane
        const isOwn    = lane === commit.lane

        if (isOwn) {
          if (inTop)    els.push(lineEl(lane, 0, cy - NODE_R - 1, `ot${lane}`))
          if (inBottom) els.push(lineEl(lane, cy + NODE_R + 1, ROW_H, `ob${lane}`))
        } else if (isMF) {
          if (inTop) els.push(lineEl(lane, 0, cy, `mft${lane}`))
        } else if (inTop && inBottom) {
          els.push(lineEl(lane, 0, ROW_H, `pt${lane}`))
        } else if (inTop) {
          els.push(lineEl(lane, 0, cy, `t${lane}`))
        } else if (inBottom) {
          els.push(lineEl(lane, cy, ROW_H, `b${lane}`))
        }
      })
      return els
    }

    const mergeArcEl = () => {
      if (!commit.mergeArc) return null
      const { from } = commit.mergeArc
      if (hiddenLanes.has(from)) return null
      const fx   = laneX(from)
      const path = `M ${fx} ${ROW_H} C ${fx} ${cy + 5} ${cx} ${cy + 5} ${cx} ${cy}`
      return <path d={path} stroke={lc(from)} strokeWidth={1.6}
        fill="none" strokeOpacity={0.65} />
    }

    const branchCurveEls = () => {
      if (!commit.branchTo || !commit.branchTo.length) return null
      return commit.branchTo.map(toLane => {
        if (hiddenLanes.has(toLane)) return null
        const tx    = laneX(toLane)
        const slack = Math.abs(tx - cx) * 0.55 + 8
        const path  = `M ${cx} ${cy} C ${cx} ${cy + slack * 0.55} ${tx} ${cy + slack * 0.55} ${tx} ${ROW_H}`
        return <path key={toLane} d={path} stroke={lc(toLane)} strokeWidth={1.6}
          fill="none" strokeOpacity={0.55} />
      })
    }

    return (
      <svg width={GRAPH_W} height={ROW_H}
        style={{ flexShrink: 0, display: 'block', overflow: 'visible', transition: 'width 0.18s ease' }}>
        <defs>
          <filter id="glow-main" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-cur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {laneLines()}
        {mergeArcEl()}
        {branchCurveEls()}

        {/* Halo for main-branch commit */}
        {isMainLane && !commit.isWorkingTree && (
          <circle cx={cx} cy={cy} r={NODE_R + 5} fill={`${T.blue}12`} stroke="none" />
        )}

        {/* Node */}
        {commit.isWorkingTree ? (
          <g>
            <circle cx={cx} cy={cy} r={NODE_R + 3.5} fill="none"
              stroke={col} strokeWidth={1.2} strokeDasharray="2.8 2" strokeOpacity={0.45} />
            <circle cx={cx} cy={cy} r={NODE_R} fill={T.bg1} stroke={col} strokeWidth={2.2}
              filter="url(#glow-cur)" />
            <circle cx={cx} cy={cy} r={2.2} fill={col} />
          </g>
        ) : commit.isMerge ? (
          <g>
            <polygon
              points={`${cx},${cy - NODE_R_M} ${cx + NODE_R_M},${cy} ${cx},${cy + NODE_R_M} ${cx - NODE_R_M},${cy}`}
              fill={T.bg1} stroke={col} strokeWidth={2}
              filter={isMainLane ? 'url(#glow-main)' : undefined}
            />
            <circle cx={cx} cy={cy} r={2} fill={col} />
          </g>
        ) : (
          <circle cx={cx} cy={cy} r={NODE_R}
            fill={T.bg1} stroke={col}
            strokeWidth={isMainLane ? 2.5 : isCurrentLane ? 2.2 : 2}
            filter={isMainLane ? 'url(#glow-main)' : isCurrentLane ? 'url(#glow-cur)' : undefined}
          />
        )}
      </svg>
    )
  })

  // ── Branch dropdown ──────────────────────────────────────────────────
  const BranchDropdown = () => {
    const visibleCount = allBranches.filter(b => !hiddenLanes.has(b.lane)).length
    return (
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setDropdownOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            height: 24, paddingLeft: 9, paddingRight: 7,
            borderRadius: T.r1,
            background: dropdownOpen ? T.bg4 : T.bg3,
            border: `1px solid ${dropdownOpen ? T.border2 : T.border}`,
            color: T.text2, fontFamily: T.ui, fontSize: 11, fontWeight: 500,
            cursor: 'pointer', transition: 'all 0.12s',
          }}
        >
          {/* Mini lane swatches */}
          <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            {allBranches.map(br => (
              <span key={br.lane} style={{
                width: 5, height: 12, borderRadius: 2,
                background: hiddenLanes.has(br.lane) ? T.bg4 : LANE_COLORS[br.lane],
                opacity: hiddenLanes.has(br.lane) ? 0.35 : 0.85,
                transition: 'background 0.15s, opacity 0.15s',
              }} />
            ))}
          </span>
          <span>{visibleCount} branch{visibleCount !== 1 ? 'es' : ''}</span>
          {/* Chevron */}
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none"
            style={{ transition: 'transform 0.15s', transform: dropdownOpen ? 'rotate(180deg)' : 'none' }}>
            <path d="M1 1L4 4L7 1" stroke={T.text3} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {dropdownOpen && (
          <>
            {/* Backdrop */}
            <div
              onClick={() => setDropdownOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 90 }}
            />
            {/* Panel */}
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 91,
              background: T.bg3, border: `1px solid ${T.border2}`,
              borderRadius: T.r2, boxShadow: T.shadow,
              minWidth: 230, overflow: 'hidden',
            }}>
              {/* Header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px 6px',
                borderBottom: `1px solid ${T.border}`,
              }}>
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                  color: T.text3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Filter branches
                </span>
                <button
                  onClick={() => setHiddenLanes(new Set())}
                  style={{ fontFamily: T.ui, fontSize: 10, color: T.orange,
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  Show all
                </button>
              </div>

              {/* Branch rows */}
              {allBranches.map(br => {
                const col    = LANE_COLORS[br.lane]
                const hidden = hiddenLanes.has(br.lane)
                return (
                  <div
                    key={br.lane}
                    onClick={() => { if (!br.isMain) toggleLane(br.lane) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '7px 12px',
                      borderBottom: `1px solid ${T.border}`,
                      cursor: br.isMain ? 'default' : 'pointer',
                      opacity: br.isMain ? 1 : hidden ? 0.45 : 1,
                      transition: 'opacity 0.12s, background 0.1s',
                    }}
                    onMouseEnter={e => { if (!br.isMain) e.currentTarget.style.background = T.bgHover }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* Checkbox */}
                    <span style={{
                      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                      background: (!hidden || br.isMain) ? col : 'transparent',
                      border: `1.5px solid ${(!hidden || br.isMain) ? col : T.border2}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.12s',
                    }}>
                      {(!hidden || br.isMain) && (
                        <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                          <path d="M1 3L3 5L7 1" stroke="#fff" strokeWidth="1.5"
                            strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>

                    {/* Lane color bar */}
                    <span style={{
                      width: 3, height: 16, borderRadius: 2,
                      background: col, flexShrink: 0,
                    }} />

                    {/* Branch name */}
                    <span style={{
                      fontFamily: T.mono, fontSize: 11, color: hidden ? T.text3 : T.text1,
                      flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{br.name}</span>

                    {/* Badges */}
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {br.isMain && (
                        <span style={{
                          background: `${T.blue}18`, color: T.blue,
                          border: `1px solid ${T.blue}35`,
                          borderRadius: 3, padding: '0 5px',
                          fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                        }}>default</span>
                      )}
                      {br.isCurrent && (
                        <span style={{
                          background: `${col}22`, color: col,
                          border: `1px solid ${col}45`,
                          borderRadius: 3, padding: '0 5px',
                          fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                        }}>HEAD</span>
                      )}
                      {br.isMerged && (
                        <span style={{
                          background: T.bg4, color: T.text3,
                          borderRadius: 3, padding: '0 5px',
                          fontFamily: T.mono, fontSize: 9,
                        }}>merged</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Collapse toggle button ────────────────────────────────────────────
  const CollapseBtn = () => (
    <button
      onClick={toggleCollapse}
      title={isCollapsed ? 'Show all branches' : 'Collapse to main + HEAD'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 24, paddingLeft: 7, paddingRight: 7,
        borderRadius: T.r1,
        background: isCollapsed ? T.orangeDim : T.bg3,
        border: `1px solid ${isCollapsed ? T.orange + '60' : T.border}`,
        color: isCollapsed ? T.orange : T.text3,
        fontFamily: T.ui, fontSize: 11, cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {/* Two-branch SVG icon */}
      <svg width="12" height="13" viewBox="0 0 12 13" fill="none">
        <circle cx="2.5" cy="2.5" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="2.5" cy="10.5" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="9.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3"
          opacity={isCollapsed ? 0.35 : 1} />
        <line x1="2.5" y1="4.5" x2="2.5" y2="8.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.5 4.5 Q2.5 6.5 9.5 6.5" stroke="currentColor" strokeWidth="1.3"
          fill="none" opacity={isCollapsed ? 0.35 : 1} />
      </svg>
      {isCollapsed ? 'Core' : 'All'}
    </button>
  )

  // ── Working tree row ──────────────────────────────────────────────────
  const WorkingTreeRow = ({ commit }) => (
    <div style={{
      display: 'flex', alignItems: 'center', height: ROW_H,
      background: `${T.orange}0c`,
      borderLeft: `2px solid ${T.orange}`,
      borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    }}>
      <div style={{ paddingLeft: 8, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <GraphCell commit={commit} />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 6, paddingRight: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: `${T.orange}1a`, color: T.orange,
            border: `1px solid ${T.orange}45`,
            borderRadius: 4, padding: '1px 7px',
            fontFamily: T.mono, fontSize: 10, fontWeight: 600, flexShrink: 0,
          }}>⬡ feature/hero-rework</span>
          <span style={{
            background: `${T.orange}28`, color: T.orange,
            border: `1px solid ${T.orange}55`,
            borderRadius: 3, padding: '1px 5px',
            fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            letterSpacing: '0.06em', flexShrink: 0,
          }}>HEAD</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: T.ui, fontSize: 13, fontWeight: 500, color: T.text1 }}>
            Working Tree
          </span>
          <span style={{
            background: T.orangeDim, color: T.orange,
            border: `1px solid ${T.orange}35`,
            borderRadius: 4, padding: '1px 6px',
            fontFamily: T.mono, fontSize: 10, fontWeight: 600,
          }}>{commit.uncommittedCount} staged</span>
        </div>
      </div>
    </div>
  )

  // ── Commit row ────────────────────────────────────────────────────────
  const CommitRow = ({ commit }) => {
    const isSelected = selectedHash === commit.hash
    const [hover, setHover] = React.useState(false)
    const col       = LANE_COLORS[commit.lane]
    const branchTip = branchTipsByHash[commit.hash]

    return (
      <div
        onClick={() => onSelect(commit)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', height: ROW_H,
          background: isSelected ? T.bg4 : hover ? T.bgHover : 'transparent',
          borderLeft: `2px solid ${isSelected ? col : 'transparent'}`,
          borderBottom: `1px solid ${T.border}`,
          cursor: 'pointer', transition: 'background 0.1s', flexShrink: 0,
        }}
      >
        <div style={{ paddingLeft: 8, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <GraphCell commit={commit} />
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingLeft: 6, paddingRight: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, overflow: 'hidden' }}>
            {branchTip && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: branchTip.isMain ? `${T.blue}16` : `${col}14`,
                color: branchTip.isMain ? T.blue : branchTip.isMerged ? T.text3 : col,
                border: `1px solid ${branchTip.isMain ? T.blue + '45' : col + '45'}`,
                borderRadius: 4, padding: '1px 6px',
                fontFamily: T.mono, fontSize: 10, fontWeight: 500, flexShrink: 0,
              }}>
                {branchTip.isMain
                  ? <span style={{ fontSize: 9 }}>★</span>
                  : branchTip.isMerged
                    ? <span style={{ fontSize: 9 }}>✓</span>
                    : <span style={{ width: 5, height: 5, borderRadius: '50%',
                        background: 'currentColor', display: 'inline-block' }} />
                }
                {branchTip.shortName}
              </span>
            )}
            <span style={{
              fontFamily: T.ui, fontSize: 13,
              fontWeight: isSelected ? 600 : 400,
              color: T.text1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{commit.message}</span>
            {commit.isMerge && (
              <span style={{
                background: T.purpleDim, color: T.purple,
                border: `1px solid ${T.purple}40`,
                borderRadius: 4, padding: '1px 5px',
                fontFamily: T.mono, fontSize: 9, fontWeight: 700, flexShrink: 0,
              }}>MERGE</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{
              width: 17, height: 17, borderRadius: '50%', flexShrink: 0,
              background: `${commit.color}22`, border: `1px solid ${commit.color}44`,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: commit.color,
            }}>{commit.initials}</span>
            <span style={{ fontFamily: T.ui, fontSize: 11, color: T.text2 }}>{commit.author}</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.text3 }}>{commit.timeAgo}</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.text3 }}>{commit.filesChanged}f</span>
          </div>
        </div>
        <span
          onClick={e => { e.stopPropagation(); window.copyText && window.copyText(commit.hash) }}
          title="Copy hash"
          style={{
            fontFamily: T.mono, fontSize: 10, color: T.text3,
            paddingRight: 12, flexShrink: 0, cursor: 'copy',
          }}
        >{commit.hash}</span>
      </div>
    )
  }

  // ── Commit detail (right panel) ───────────────────────────────────────
  const selectedCommit  = commits.find(c => c.hash === selectedHash)
  const fileStatusColor = { M: T.yellow, A: T.green, D: T.red, R: T.blue }

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* ── LEFT: commit list ── */}
      <div style={{
        width: listWidth, flexShrink: 0,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* Header row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 38, paddingLeft: 14, paddingRight: 10,
          borderBottom: `1px solid ${T.border}`,
          background: T.bg2, flexShrink: 0,
        }}>
          <span style={{
            fontFamily: T.mono, fontSize: 11, fontWeight: 600,
            color: T.text2, letterSpacing: '0.05em', marginRight: 2,
          }}>
            {commits.filter(c => !c.isWorkingTree).length} COMMITS
          </span>

          <div style={{ flex: 1 }} />

          <CollapseBtn />
          <BranchDropdown />

          <button
            onClick={() => {}}
            style={{
              fontFamily: T.ui, fontSize: 11, color: T.text3,
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
            }}
          >↺</button>
        </div>

        {/* Commit rows */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visibleCommits.map(c =>
            c.isWorkingTree
              ? <WorkingTreeRow key="wt" commit={c} />
              : <CommitRow key={c.hash} commit={c} />
          )}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 12px' }}>
            <button style={{
              fontFamily: T.ui, fontSize: 11, color: T.text3,
              background: 'none', border: `1px solid ${T.border}`,
              borderRadius: T.r2, padding: '5px 16px', cursor: 'pointer',
            }}>Load more…</button>
          </div>
        </div>
      </div>

      <PaneDragHandle />

      {/* ── RIGHT: commit detail ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedCommit ? (
          <>
            <div style={{
              padding: '14px 18px', borderBottom: `1px solid ${T.border}`,
              background: T.bg2, flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span
                  onClick={() => window.copyText && window.copyText(selectedCommit.hash)}
                  title="Copy hash"
                  style={{
                    background: T.bg4, color: T.text3, borderRadius: 4,
                    padding: '2px 8px', fontFamily: T.mono, fontSize: 11,
                    letterSpacing: '0.05em', cursor: 'copy',
                  }}
                >{selectedCommit.hash}</span>
                {selectedCommit.isMerge && (
                  <span style={{
                    background: T.purpleDim, color: T.purple, borderRadius: 4, padding: '2px 7px',
                    fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                  }}>MERGE COMMIT</span>
                )}
                {branchTipsByHash[selectedCommit.hash] && (
                  <span style={{
                    background: `${LANE_COLORS[selectedCommit.lane]}16`,
                    color: LANE_COLORS[selectedCommit.lane],
                    border: `1px solid ${LANE_COLORS[selectedCommit.lane]}45`,
                    borderRadius: 4, padding: '2px 7px',
                    fontFamily: T.mono, fontSize: 10, fontWeight: 500,
                  }}>{branchTipsByHash[selectedCommit.hash].name}</span>
                )}
              </div>
              <p style={{
                fontFamily: T.ui, fontSize: 14, fontWeight: 600,
                color: T.text1, margin: '0 0 10px', lineHeight: 1.4,
              }}>{selectedCommit.message}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: `${selectedCommit.color}22`,
                  border: `1px solid ${selectedCommit.color}44`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: selectedCommit.color,
                }}>{selectedCommit.initials}</span>
                <span style={{ fontFamily: T.ui, fontSize: 13, color: T.text2, fontWeight: 500 }}>
                  {selectedCommit.author}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text3 }}>
                  {selectedCommit.timeAgo}
                </span>
              </div>
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', height: 34,
              paddingLeft: 16, paddingRight: 16,
              borderBottom: `1px solid ${T.border}`, background: T.bg1, flexShrink: 0,
            }}>
              <span style={{
                fontFamily: T.ui, fontSize: 10, fontWeight: 700,
                color: T.text3, letterSpacing: '0.07em', textTransform: 'uppercase',
              }}>
                Files Changed
                <span style={{
                  marginLeft: 8, fontFamily: T.mono, fontSize: 10,
                  background: T.bg4, color: T.text3, borderRadius: 8, padding: '1px 6px',
                }}>{selectedFiles.length}</span>
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {selectedFiles.map((f, i) => (
                <div key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    height: 36, paddingLeft: 16, paddingRight: 16,
                    borderBottom: `1px solid ${T.border}`, transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = T.bgHover}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{
                    width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                    background: `${fileStatusColor[f.status] || T.text2}22`,
                    color: fileStatusColor[f.status] || T.text2,
                    fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{f.status}</span>
                  <span style={{
                    fontFamily: T.mono, fontSize: 11, color: T.text1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>{f.path}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 10, color: T.text3,
          }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <circle cx="18" cy="18" r="7" stroke={T.border2} strokeWidth="1.5" />
              <line x1="18" y1="3" x2="18" y2="11" stroke={T.border2} strokeWidth="1.5" strokeLinecap="round" />
              <line x1="18" y1="25" x2="18" y2="33" stroke={T.border2} strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="18" cy="18" r="2.5" fill={T.border2} />
            </svg>
            <span style={{ fontFamily: T.ui, fontSize: 13 }}>Select a commit to view details</span>
          </div>
        )}
      </div>
    </div>
  )
}

Object.assign(window, { HistoryPanel })
