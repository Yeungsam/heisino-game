const SOURCE_SIZE = Object.freeze({ width: 1280, height: 722 })
const ROOM_MASK_ALPHA = 0.5

const SOURCE_RECTS = Object.freeze({
  grid: Object.freeze({ x: 52, y: 106, width: 1027, height: 590 }),
  location: Object.freeze({ x: 16, y: 8, width: 300, height: 98 }),
  round: Object.freeze({ x: 434, y: 13, width: 301, height: 45 }),
  vault: Object.freeze({ x: 460, y: 61, width: 300, height: 44 }),
  alert: Object.freeze({ x: 757, y: 10, width: 258, height: 51 }),
  gold: Object.freeze({ x: 1025, y: 10, width: 208, height: 52 }),
  legend: Object.freeze({ x: 1082, y: 90, width: 181, height: 501 }),
  action: Object.freeze({ x: 1084, y: 608, width: 176, height: 50 })
})

const ROOM_TYPES = Object.freeze([
  Object.freeze(['复活点', '赌博区域', '仓库', '赌博区域', '复活点']),
  Object.freeze(['赌博区域', '表演后台', '赌博区域', '表演后台', '仓库']),
  Object.freeze(['赌博区域', '复活点', '地下金库', '赌博区域', '仓库']),
  Object.freeze(['赌博区域', '仓库', '赌博区域', '表演后台', '赌博区域']),
  Object.freeze(['复活点', '赌博区域', '赌博区域', '仓库', '白鸽撤离点'])
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

function createMovementLayout(viewWidth, viewHeight, imageWidth = SOURCE_SIZE.width, imageHeight = SOURCE_SIZE.height) {
  const transform = containedTransform(viewWidth, viewHeight, imageWidth, imageHeight)
  const grid = projectRect(SOURCE_RECTS.grid, transform)
  return {
    transform,
    grid,
    cellWidth: grid.width / 5,
    cellHeight: grid.height / 5,
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
    x: layout.grid.x + x * layout.cellWidth + inset,
    y: layout.grid.y + y * layout.cellHeight + inset,
    width: layout.cellWidth - inset * 2,
    height: layout.cellHeight - inset * 2
  }
}

function roomTypeAt(x, y) {
  return ROOM_TYPES[y] && ROOM_TYPES[y][x] ? ROOM_TYPES[y][x] : '未知房间'
}

module.exports = {
  SOURCE_SIZE,
  ROOM_MASK_ALPHA,
  SOURCE_RECTS,
  ROOM_TYPES,
  containedTransform,
  projectRect,
  createMovementLayout,
  roomRect,
  roomTypeAt
}
