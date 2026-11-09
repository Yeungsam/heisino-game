const { SEARCH_DURATION_MS } = require('../core/constants')
const SEARCH_RIPPLE_PERIOD_MS = 1200
const SEARCH_DESIGN_WIDTH = 1920
const SEARCH_DESIGN_HEIGHT = 1080
const SEARCH_PANEL_NINE_SLICE = Object.freeze({ left: 80, right: 80, top: 110, bottom: 78 })
const SEARCH_ASSET_CROPS = Object.freeze({
  roomTimerFill: Object.freeze({ x: 198, y: 85, width: 304, height: 62 }),
  slot: Object.freeze({ x: 58, y: 64, width: 240, height: 290 }),
  slotPattern: Object.freeze({ x: 85, y: 31, width: 249, height: 354 }),
  bagIcon: Object.freeze({ x: 51, y: 22, width: 158, height: 170 }),
  briefcaseIcon: Object.freeze({ x: 31, y: 39, width: 198, height: 157 })
})
const ROOM_AREA_TEMPLATE = Object.freeze([
  { areaId: 'LEFT_CABINET', x: 43, y: 196, width: 306, height: 289 },
  { areaId: 'MAIN_TABLE', x: 267, y: 508, width: 807, height: 306 },
  { areaId: 'RIGHT_TABLE', x: 1223, y: 571, width: 573, height: 306 }
])

// Full scene exports from Figma heisino. Coordinates locate the three existing search areas on each scene.
function roomBackground(name, bounds) {
  return {
    source: `subpackages/rooms/assets/${name}.png`,
    width: 956,
    height: 440,
    areas: bounds.map(([x, y, width, height], index) => ({ areaId: ROOM_AREA_TEMPLATE[index].areaId, x, y, width, height }))
  }
}

const ROOM_BACKGROUNDS = Object.freeze({
  LOUNGE: roomBackground('lounge', [[87, 111, 170, 100], [200, 179, 307, 175], [585, 257, 257, 157]]),
  SECURITY: roomBackground('security', [[145, 75, 338, 114], [99, 190, 439, 125], [598, 277, 251, 157]]),
  STORAGE: roomBackground('storage', [[84, 60, 326, 167], [108, 231, 307, 123], [575, 210, 327, 195]]),
  MEDICAL: roomBackground('medical', [[376, 47, 122, 164], [50, 218, 277, 173], [586, 260, 174, 147]]),
  VAULT: roomBackground('vault', [[91, 67, 243, 278], [351, 38, 268, 225], [657, 175, 169, 218]])
})

function searchTimerState(deadlineAt, now = Date.now()) {
  const remainingMs = Math.max(0, deadlineAt - now)
  return {
    remainingMs,
    seconds: Math.ceil(remainingMs / 1000),
    progress: Math.max(0, Math.min(1, remainingMs / SEARCH_DURATION_MS)),
    expired: remainingMs === 0
  }
}

// Keep an unchanged server deadline on the same local timeline across polls.
// A resumed visit with a new server deadline is anchored again.
function syncSearchDeadline(previous, visit, serverNow, receivedAt) {
  if (previous && previous.visitId === visit.visitId && previous.deadlineAt === visit.deadlineAt) return previous
  return { visitId: visit.visitId, deadlineAt: visit.deadlineAt, localDeadlineAt: visit.deadlineAt + receivedAt - serverNow }
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

function createRoomLayout(viewWidth, viewHeight, background) {
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
  // Room art covers the screen; HUD stays inside the contained design safe area.
  const sourceWidth = background?.width || SEARCH_DESIGN_WIDTH
  const sourceHeight = background?.height || SEARCH_DESIGN_HEIGHT
  const artworkScale = Math.max(viewWidth / sourceWidth, viewHeight / sourceHeight)
  const artworkWidth = sourceWidth * artworkScale
  const artworkHeight = sourceHeight * artworkScale
  const artwork = { scale: artworkScale, offsetX: (viewWidth - artworkWidth) / 2, offsetY: (viewHeight - artworkHeight) / 2 }
  const areas = (background?.areas || ROOM_AREA_TEMPLATE).flatMap(area => {
    const left = Math.max(0, artwork.offsetX + area.x * artwork.scale)
    const top = Math.max(0, artwork.offsetY + area.y * artwork.scale)
    const right = Math.min(viewWidth, artwork.offsetX + (area.x + area.width) * artwork.scale)
    const bottom = Math.min(viewHeight, artwork.offsetY + (area.y + area.height) * artwork.scale)
    return right > left && bottom > top ? [{ areaId: area.areaId, x: left, y: top, width: right - left, height: bottom - top }] : []
  })
  return {
    scale,
    offsetX,
    offsetY,
    designWidth: SEARCH_DESIGN_WIDTH,
    designHeight: SEARCH_DESIGN_HEIGHT,
    artwork,
    contentRect: {
      x: artwork.offsetX,
      y: artwork.offsetY,
      width: artworkWidth,
      height: artworkHeight
    },
    areas,
    title: convert({ x: 133, y: 58, width: 515, height: 163 }),
    timer: convert({ x: 1297, y: 36, width: 459, height: 178 }),
    timerTrack: convert({ x: 1370, y: 36, width: 386, height: 178 }),
    timerFill: convert({ x: 1400, y: 113, width: 326, height: 18 }),
    timerIcon: convert({ x: 1314, y: 87, width: 75, height: 75 }),
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
  const defaultRight = Math.min(viewWidth - 18, viewWidth * 0.8)
  const menuLeft = menuButtonRect && Number(menuButtonRect.left)
  const resourceRight = Number.isFinite(menuLeft) && menuLeft > viewWidth * 0.5
    ? Math.min(defaultRight, menuLeft - Math.max(16, viewWidth * 0.055))
    : defaultRight
  const left = Math.min(16, viewWidth * 0.02)
  const gap = Math.min(12, viewWidth * 0.015)
  const available = Math.max(0, resourceRight - left - gap * 4)
  const fields = {}
  let x = left
  for (const [key, fraction] of [['title', 0.26], ['round', 0.19], ['hp', 0.15], ['alert', 0.19], ['resource', 0.21]]) {
    const width = available * fraction
    fields[key] = { x, width }
    x += width + gap
  }
  return { resourceRight, ...fields }
}

function createSearchPanelContentLayout(rect, scale) {
  return {
    headerBaselineY: rect.y + 66 * scale,
    iconTop: rect.y + 42 * scale,
    gridTop: rect.y + 118 * scale,
    gridBottom: rect.y + rect.height - 74 * scale
  }
}

function createNineSliceGeometry(sourceWidth, sourceHeight, rect, slices, destinationScale = 1) {
  const sourceLeft = Math.min(slices.left, sourceWidth / 2)
  const sourceRight = Math.min(slices.right, sourceWidth - sourceLeft)
  const sourceTop = Math.min(slices.top, sourceHeight / 2)
  const sourceBottom = Math.min(slices.bottom, sourceHeight - sourceTop)
  const destinationLeft = Math.min(sourceLeft * destinationScale, rect.width / 2)
  const destinationRight = Math.min(sourceRight * destinationScale, rect.width - destinationLeft)
  const destinationTop = Math.min(sourceTop * destinationScale, rect.height / 2)
  const destinationBottom = Math.min(sourceBottom * destinationScale, rect.height - destinationTop)
  const sourceXs = [0, sourceLeft, sourceWidth - sourceRight, sourceWidth]
  const sourceYs = [0, sourceTop, sourceHeight - sourceBottom, sourceHeight]
  const destinationXs = [rect.x, rect.x + destinationLeft, rect.x + rect.width - destinationRight, rect.x + rect.width]
  const destinationYs = [rect.y, rect.y + destinationTop, rect.y + rect.height - destinationBottom, rect.y + rect.height]
  const segments = []
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      segments.push({
        row,
        column,
        source: {
          x: sourceXs[column],
          y: sourceYs[row],
          width: sourceXs[column + 1] - sourceXs[column],
          height: sourceYs[row + 1] - sourceYs[row]
        },
        destination: {
          x: destinationXs[column],
          y: destinationYs[row],
          width: destinationXs[column + 1] - destinationXs[column],
          height: destinationYs[row + 1] - destinationYs[row]
        }
      })
    }
  }
  return segments
}

function nextSearchRippleIndex(visibleCount, itemCount, elapsedMs, revealIntervalMs = 2000) {
  const visible = Math.max(0, Number(visibleCount) || 0)
  const total = Math.max(0, Number(itemCount) || 0)
  if (total === 0) return elapsedMs < revealIntervalMs ? 0 : null
  return visible < total ? visible : null
}

function searchRippleState(slot, now, startedAt) {
  const elapsed = Math.max(0, now - startedAt)
  const size = Math.min(slot.width, slot.height)
  const rings = []
  for (const delay of [0, SEARCH_RIPPLE_PERIOD_MS / 2]) {
    if (elapsed < delay) continue
    const phase = ((elapsed - delay) % SEARCH_RIPPLE_PERIOD_MS) / SEARCH_RIPPLE_PERIOD_MS
    const fade = (1 - phase) ** 2
    rings.push({ radius: size * (0.09 + 0.34 * (1 - fade)), alpha: 0.68 * fade })
  }
  return {
    x: slot.x + slot.width / 2,
    y: slot.y + slot.height / 2,
    rings
  }
}

module.exports = {
  SEARCH_DURATION_MS,
  SEARCH_RIPPLE_PERIOD_MS,
  SEARCH_DESIGN_WIDTH,
  SEARCH_DESIGN_HEIGHT,
  SEARCH_PANEL_NINE_SLICE,
  SEARCH_ASSET_CROPS,
  ROOM_AREA_TEMPLATE,
  ROOM_BACKGROUNDS,
  searchTimerState,
  syncSearchDeadline,
  createSearchLayout,
  createRoomLayout,
  fitAspectRect,
  createHudSafeLayout,
  createSearchPanelContentLayout,
  createNineSliceGeometry,
  nextSearchRippleIndex,
  searchRippleState
}
