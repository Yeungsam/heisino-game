const SEARCH_DURATION_MS = 50000
const MAGNIFIER_ORBIT_PERIOD_MS = 1600
const SEARCH_DESIGN_WIDTH = 1920
const SEARCH_DESIGN_HEIGHT = 1080
const SEARCH_ASSET_CROPS = Object.freeze({
  slot: Object.freeze({ x: 58, y: 64, width: 240, height: 290 }),
  slotPattern: Object.freeze({ x: 85, y: 31, width: 249, height: 354 }),
  bagIcon: Object.freeze({ x: 51, y: 22, width: 158, height: 170 }),
  briefcaseIcon: Object.freeze({ x: 31, y: 39, width: 198, height: 157 }),
  magnifier: Object.freeze({ x: 118, y: 73, width: 212, height: 212 })
})
const ROOM_AREA_TEMPLATE = Object.freeze([
  { areaId: 'LEFT_CABINET', x: 43, y: 196, width: 306, height: 289 },
  { areaId: 'MAIN_TABLE', x: 267, y: 508, width: 807, height: 306 },
  { areaId: 'RIGHT_TABLE', x: 1223, y: 571, width: 573, height: 306 }
])

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
  const scale = Math.min(viewWidth / SEARCH_DESIGN_WIDTH, viewHeight / SEARCH_DESIGN_HEIGHT)
  const offsetX = (viewWidth - SEARCH_DESIGN_WIDTH * scale) / 2
  const offsetY = (viewHeight - SEARCH_DESIGN_HEIGHT * scale) / 2
  const rect = (x, y, width, height) => ({
    x: offsetX + x * scale,
    y: offsetY + y * scale,
    width: width * scale,
    height: height * scale
  })
  return {
    scale,
    offsetX,
    offsetY,
    timer: rect(551, 174, 817, 48),
    inventory: rect(56, 247, 924, 690),
    search: rect(990, 247, 884, 690),
    finish: rect(1513, 941, 341, 99)
  }
}

function createRoomLayout(viewWidth, viewHeight) {
  const scale = Math.min(viewWidth / SEARCH_DESIGN_WIDTH, viewHeight / SEARCH_DESIGN_HEIGHT)
  const offsetX = (viewWidth - SEARCH_DESIGN_WIDTH * scale) / 2
  const offsetY = (viewHeight - SEARCH_DESIGN_HEIGHT * scale) / 2
  const convert = source => ({
    ...source,
    x: offsetX + source.x * scale,
    y: offsetY + source.y * scale,
    width: source.width * scale,
    height: source.height * scale
  })
  return {
    scale,
    offsetX,
    offsetY,
    designWidth: SEARCH_DESIGN_WIDTH,
    designHeight: SEARCH_DESIGN_HEIGHT,
    contentRect: {
      x: offsetX,
      y: offsetY,
      width: SEARCH_DESIGN_WIDTH * scale,
      height: SEARCH_DESIGN_HEIGHT * scale
    },
    areas: ROOM_AREA_TEMPLATE.map(convert),
    title: convert({ x: 133, y: 58, width: 515, height: 163 }),
    timer: convert({ x: 1297, y: 36, width: 459, height: 178 }),
    leave: convert({ x: 1371, y: 889, width: 292, height: 104 })
  }
}

function fitAspectRect(rect, aspectRatio, horizontalInsetRatio = 0.055, verticalInsetRatio = 0.04) {
  const availableWidth = Math.max(0, rect.width * (1 - horizontalInsetRatio * 2))
  const availableHeight = Math.max(0, rect.height * (1 - verticalInsetRatio * 2))
  const width = Math.min(availableWidth, availableHeight * aspectRatio)
  const height = aspectRatio > 0 ? width / aspectRatio : 0
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height
  }
}

function createHudSafeLayout(viewWidth, menuButtonRect) {
  const defaultRight = viewWidth - 18
  const menuLeft = menuButtonRect && Number(menuButtonRect.left)
  const resourceRight = Number.isFinite(menuLeft) && menuLeft > viewWidth * 0.5
    ? Math.min(defaultRight, menuLeft - 16)
    : defaultRight
  return { resourceRight }
}

function nextSearchMagnifierIndex(visibleCount, itemCount, elapsedMs, revealIntervalMs = 2000) {
  const visible = Math.max(0, Number(visibleCount) || 0)
  const total = Math.max(0, Number(itemCount) || 0)
  if (total === 0) return elapsedMs < revealIntervalMs ? 0 : null
  return visible < total ? visible : null
}

function magnifierOrbitState(slot, now, startedAt, periodMs = MAGNIFIER_ORBIT_PERIOD_MS) {
  const elapsed = Math.max(0, now - startedAt)
  const phase = periodMs > 0 ? (elapsed % periodMs) / periodMs : 0
  const angle = phase * Math.PI * 2 - Math.PI / 2
  const centerX = slot.x + slot.width / 2
  const centerY = slot.y + slot.height / 2
  const radius = Math.min(slot.width, slot.height) * 0.24
  const entrance = Math.min(1, elapsed / 220)
  const easedEntrance = 1 - Math.pow(1 - entrance, 3)
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
    centerX,
    centerY,
    radius,
    angle,
    rotation: angle + Math.PI / 2 + Math.sin(angle * 2) * 0.08,
    scale: (0.92 + Math.sin(angle + Math.PI / 3) * 0.05) * easedEntrance,
    alpha: easedEntrance
  }
}

module.exports = {
  SEARCH_DURATION_MS,
  MAGNIFIER_ORBIT_PERIOD_MS,
  SEARCH_DESIGN_WIDTH,
  SEARCH_DESIGN_HEIGHT,
  SEARCH_ASSET_CROPS,
  ROOM_AREA_TEMPLATE,
  searchTimerState,
  createSearchLayout,
  createRoomLayout,
  fitAspectRect,
  createHudSafeLayout,
  nextSearchMagnifierIndex,
  magnifierOrbitState
}
