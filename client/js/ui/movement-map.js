const SOURCE_SIZE = Object.freeze({ width: 1280, height: 722 })
const ROOM_MASK_ALPHA = 0.5
const PIN_TRANSITION_MS = 460
const ROOM_HIGHLIGHTS = Object.freeze({
  CURRENT: Object.freeze({ fillAlpha: 0.24, strokeAlpha: 1, lineWidth: 4, glow: 24 }),
  SELECTED: Object.freeze({ fillAlpha: 0.12, strokeAlpha: 0.9, lineWidth: 3, glow: 13 }),
  REACHABLE: Object.freeze({ fillAlpha: 0.065, strokeAlpha: 0.62, lineWidth: 2.2, glow: 7 })
})

const LANDMARK_ROOMS = Object.freeze({
  VAULT: Object.freeze({ x: 2, y: 2 }),
  EXIT: Object.freeze({ x: 4, y: 4 })
})

// The illustrated rooms vary slightly in size. Use the artwork's seams for both rendering and hit testing.
const ROOM_COLUMNS = Object.freeze([240, 395, 562, 730, 902, 1066])
const ROOM_ROWS = Object.freeze([106, 217, 326, 442, 550, 661])

const SOURCE_RECTS = Object.freeze({
  location: Object.freeze({ x: 1, y: 0, width: 345, height: 105 }),
  round: Object.freeze({ x: 434, y: 13, width: 301, height: 45 }),
  vault: Object.freeze({ x: 460, y: 61, width: 300, height: 44 }),
  alert: Object.freeze({ x: 757, y: 10, width: 258, height: 51 }),
  gold: Object.freeze({ x: 1025, y: 10, width: 208, height: 52 }),
  legend: Object.freeze({ x: 1082, y: 90, width: 181, height: 501 }),
  action: Object.freeze({ x: 1084, y: 608, width: 176, height: 50 })
})

const ROOM_TYPE_INFO = Object.freeze({
  SPAWN: Object.freeze({ name: '出生点', color: '#ffd07a' }),
  LOUNGE: Object.freeze({ name: '会客厅', color: '#efa4bb' }),
  SECURITY: Object.freeze({ name: '监控室', color: '#9ccef9' }),
  STORAGE: Object.freeze({ name: '仓库', color: '#f2ac7c' }),
  MEDICAL: Object.freeze({ name: '医疗室', color: '#9fe1d0' }),
  EXIT: Object.freeze({ name: '撤离点', color: '#c5d7ff' }),
  VAULT: Object.freeze({ name: '中央金库', color: '#ffe192' })
})

// 飞书《房间地图说明》：从左到右、从上到下，按 [y][x] 取房间。
const ROOM_TYPES = Object.freeze([
  Object.freeze(['SPAWN', 'LOUNGE', 'SECURITY', 'STORAGE', 'SPAWN']),
  Object.freeze(['LOUNGE', 'MEDICAL', 'LOUNGE', 'SECURITY', 'MEDICAL']),
  Object.freeze(['SECURITY', 'LOUNGE', 'VAULT', 'STORAGE', 'LOUNGE']),
  Object.freeze(['MEDICAL', 'SECURITY', 'STORAGE', 'MEDICAL', 'SECURITY']),
  Object.freeze(['SPAWN', 'STORAGE', 'MEDICAL', 'LOUNGE', 'EXIT'])
])

function containedTransform(viewWidth, viewHeight, imageWidth = SOURCE_SIZE.width, imageHeight = SOURCE_SIZE.height) {
  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight)
  return {
    scale,
    offsetX: (viewWidth - imageWidth * scale) / 2,
    offsetY: (viewHeight - imageHeight * scale) / 2
  }
}

function projectRect(rect, transform) {
  return {
    x: transform.offsetX + rect.x * transform.scale,
    y: transform.offsetY + rect.y * transform.scale,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale
  }
}

function createMovementLayout(viewWidth, viewHeight) {
  const transform = containedTransform(viewWidth, viewHeight)
  const columns = ROOM_COLUMNS.map(x => transform.offsetX + x * transform.scale)
  const rows = ROOM_ROWS.map(y => transform.offsetY + y * transform.scale)
  return {
    transform,
    columns,
    rows,
    grid: { x: columns[0], y: rows[0], width: columns[5] - columns[0], height: rows[5] - rows[0] },
    location: projectRect(SOURCE_RECTS.location, transform),
    round: projectRect(SOURCE_RECTS.round, transform),
    vault: projectRect(SOURCE_RECTS.vault, transform),
    alert: projectRect(SOURCE_RECTS.alert, transform),
    gold: projectRect(SOURCE_RECTS.gold, transform),
    legend: projectRect(SOURCE_RECTS.legend, transform),
    action: projectRect(SOURCE_RECTS.action, transform)
  }
}

function roomRect(layout, x, y, inset = 0) {
  return {
    x: layout.columns[x] + inset,
    y: layout.rows[y] + inset,
    width: layout.columns[x + 1] - layout.columns[x] - inset * 2,
    height: layout.rows[y + 1] - layout.rows[y] - inset * 2
  }
}

function roomKeyAt(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= 5 || y < 0 || y >= 5) return null
  return ROOM_TYPES[y][x]
}

function roomInfoAt(x, y) {
  return ROOM_TYPE_INFO[roomKeyAt(x, y)] || null
}

function roomTypeAt(x, y) {
  const room = roomInfoAt(x, y)
  return room ? room.name : '未知房间'
}

function roomKeyForNode(nodeId) {
  const coordinates = /^n_(\d+)_(\d+)$/.exec(nodeId)
  return coordinates ? roomKeyAt(Number(coordinates[1]), Number(coordinates[2])) : null
}

function roomTypeForNode(nodeId) {
  return ROOM_TYPE_INFO[roomKeyForNode(nodeId)]?.name || '未知房间'
}

function roomHighlightStyle(state) {
  return ROOM_HIGHLIGHTS[state] || null
}

function landmarkIconRect(layout, x, y) {
  const room = roomRect(layout, x, y)
  const size = Math.min(room.width, room.height) * 0.32
  const inset = Math.max(3, size * 0.16)
  return {
    x: room.x + room.width - size - inset,
    y: room.y + inset,
    width: size,
    height: size
  }
}

function pinTransitionOpacity(elapsedMs, durationMs = PIN_TRANSITION_MS) {
  const duration = Math.max(1, durationMs)
  const progress = Math.max(0, Math.min(1, elapsedMs / duration))

  if (progress < 0.5) {
    return { from: 1 - progress * 2, to: 0, done: false }
  }

  return {
    from: 0,
    to: (progress - 0.5) * 2,
    done: progress >= 1
  }
}

const TRACK_COLORS = ['#ffd376', '#75d9ff', '#f3a8e5']

function movementTrackFrame(layout, tracks, progress) {
  const ratio = Math.max(0, Math.min(1, progress))
  const eased = ratio * ratio * (3 - 2 * ratio)
  return tracks.map((track, index) => {
    const offset = (index - (tracks.length - 1) / 2) * 22 * layout.transform.scale
    const start = roomRect(layout, track.from.x, track.from.y)
    const finish = roomRect(layout, track.to.x, track.to.y)
    const fromX = start.x + start.width / 2 + offset
    const fromY = start.y + start.height * 0.4 + offset
    const toX = finish.x + finish.width / 2 + offset
    const toY = finish.y + finish.height * 0.4 + offset
    return { ...track, number: index + 1, color: TRACK_COLORS[index], fromX, fromY, toX, toY,
      x: fromX + (toX - fromX) * eased, y: fromY + (toY - fromY) * eased }
  })
}

module.exports = {
  SOURCE_SIZE,
  ROOM_MASK_ALPHA,
  PIN_TRANSITION_MS,
  ROOM_HIGHLIGHTS,
  LANDMARK_ROOMS,
  SOURCE_RECTS,
  ROOM_TYPES,
  ROOM_TYPE_INFO,
  containedTransform,
  projectRect,
  createMovementLayout,
  roomRect,
  roomInfoAt,
  roomTypeAt,
  roomKeyForNode,
  roomTypeForNode,
  roomHighlightStyle,
  landmarkIconRect,
  pinTransitionOpacity,
  movementTrackFrame
}
