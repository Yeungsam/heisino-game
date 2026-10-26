const SEARCH_DURATION_MS = 50000

function searchTimerState(deadlineAt, now = Date.now()) {
  const remainingMs = Math.max(0, deadlineAt - now)
  return {
    remainingMs,
    seconds: Math.ceil(remainingMs / 1000),
    progress: Math.max(0, Math.min(1, remainingMs / SEARCH_DURATION_MS)),
    expired: remainingMs === 0
  }
}

function createSearchLayout(viewWidth, viewHeight) {
  const top = 78
  const bottom = 54
  const outer = 18
  const gap = 14
  const leftWidth = viewWidth * 0.47
  const contentHeight = viewHeight - top - bottom
  return {
    timer: { x: viewWidth * 0.28, y: 51, width: viewWidth * 0.44, height: 18 },
    inventory: { x: outer, y: top, width: leftWidth, height: contentHeight },
    search: { x: outer + leftWidth + gap, y: top, width: viewWidth - outer * 2 - leftWidth - gap, height: contentHeight },
    finish: { x: viewWidth - 146, y: viewHeight - 44, width: 128, height: 34 }
  }
}

module.exports = { SEARCH_DURATION_MS, searchTimerState, createSearchLayout }
