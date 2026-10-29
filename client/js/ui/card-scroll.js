const CARD_ART_WIDTH = 552
const CARD_ART_HEIGHT = 768
const CARD_ASPECT_RATIO = CARD_ART_WIDTH / CARD_ART_HEIGHT
const GESTURE_THRESHOLD = 7

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function createVerticalCardGrid(options) {
  const viewport = options.viewport
  const count = Math.max(0, options.count || 0)
  const columns = Math.max(1, options.columns || 1)
  const gap = Math.max(0, options.gap || 0)
  const padding = Math.max(0, options.padding || 0)
  const ratio = options.aspectRatio || CARD_ASPECT_RATIO
  const cardWidth = (viewport.width - padding * 2 - gap * (columns - 1)) / columns
  const cardHeight = cardWidth / ratio
  const rows = Math.ceil(count / columns)
  const contentHeight = padding * 2 + rows * cardHeight + Math.max(0, rows - 1) * gap
  const maxScroll = Math.max(0, contentHeight - viewport.height)
  const scrollY = clamp(options.scrollY || 0, 0, maxScroll)
  const rects = Array.from({ length: count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      x: viewport.x + padding + column * (cardWidth + gap),
      y: viewport.y + padding + row * (cardHeight + gap) - scrollY,
      width: cardWidth,
      height: cardHeight,
      index
    }
  })
  return { cardWidth, cardHeight, contentHeight, maxScroll, scrollY, rects }
}

function rectsIntersect(first, second) {
  return first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
}

function intersectionRect(first, second) {
  const x = Math.max(first.x, second.x)
  const y = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function classifyCardGesture(start, current, threshold = GESTURE_THRESHOLD) {
  const dx = current.x - start.x
  const dy = current.y - start.y
  if (Math.hypot(dx, dy) < threshold) return 'PENDING'
  return Math.abs(dy) >= Math.abs(dx) * 1.1 ? 'SCROLL' : 'DRAG'
}

module.exports = {
  CARD_ART_WIDTH,
  CARD_ART_HEIGHT,
  CARD_ASPECT_RATIO,
  GESTURE_THRESHOLD,
  clamp,
  createVerticalCardGrid,
  rectsIntersect,
  intersectionRect,
  classifyCardGesture
}
