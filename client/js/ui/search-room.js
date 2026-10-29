const SEARCH_DURATION_MS = 50000
const SEARCH_DESIGN_WIDTH = 1920
const SEARCH_DESIGN_HEIGHT = 1080
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
  const scale = Math.max(viewWidth / SEARCH_DESIGN_WIDTH, viewHeight / SEARCH_DESIGN_HEIGHT)
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
    areas: ROOM_AREA_TEMPLATE.map(convert),
    title: convert({ x: 133, y: 58, width: 515, height: 163 }),
    timer: convert({ x: 1297, y: 36, width: 459, height: 178 }),
    leave: convert({ x: 1371, y: 889, width: 292, height: 104 })
  }
}

module.exports = {
  SEARCH_DURATION_MS,
  SEARCH_DESIGN_WIDTH,
  SEARCH_DESIGN_HEIGHT,
  ROOM_AREA_TEMPLATE,
  searchTimerState,
  createSearchLayout,
  createRoomLayout
}
