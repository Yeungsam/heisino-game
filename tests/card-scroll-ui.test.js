const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CARD_ART_WIDTH,
  CARD_ART_HEIGHT,
  CARD_ASPECT_RATIO,
  clamp,
  createVerticalCardGrid,
  classifyCardGesture
} = require('../client/js/ui/card-scroll')

test('仓库纵向网格使用真实卡面宽高比并覆盖全部卡牌', () => {
  assert.deepEqual([CARD_ART_WIDTH, CARD_ART_HEIGHT], [552, 768])
  const viewport = { x: 20, y: 80, width: 1000, height: 480 }
  const grid = createVerticalCardGrid({ viewport, count: 52, columns: 7, gap: 10, padding: 10, scrollY: 0 })
  assert.equal(grid.rects.length, 52)
  assert.ok(Math.abs(grid.cardWidth / grid.cardHeight - CARD_ASPECT_RATIO) < 0.000001)
  assert.ok(grid.maxScroll > 0)
})

test('滚动偏移始终限制在内容范围内', () => {
  assert.equal(clamp(-20, 0, 100), 0)
  assert.equal(clamp(120, 0, 100), 100)
  const grid = createVerticalCardGrid({ viewport: { x: 0, y: 0, width: 500, height: 200 }, count: 20, columns: 5, gap: 5, scrollY: 9999 })
  assert.equal(grid.scrollY, grid.maxScroll)
})

test('战备手势可区分纵向滚动与横向拖动', () => {
  const start = { x: 100, y: 100 }
  assert.equal(classifyCardGesture(start, { x: 103, y: 103 }), 'PENDING')
  assert.equal(classifyCardGesture(start, { x: 102, y: 130 }), 'SCROLL')
  assert.equal(classifyCardGesture(start, { x: 140, y: 106 }), 'DRAG')
})
