const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SOURCE_SIZE,
  ROOM_MASK_ALPHA,
  createMovementLayout,
  roomRect,
  roomTypeAt
} = require('../client/js/ui/movement-map')

test('移动地图按设计稿映射为完整5×5房间网格', () => {
  const layout = createMovementLayout(SOURCE_SIZE.width, SOURCE_SIZE.height)
  const first = roomRect(layout, 0, 0)
  const last = roomRect(layout, 4, 4)

  assert.equal(layout.cellWidth * 5, layout.grid.width)
  assert.equal(layout.cellHeight * 5, layout.grid.height)
  assert.equal(first.x, layout.grid.x)
  assert.equal(first.y, layout.grid.y)
  assert.equal(last.x + last.width, layout.grid.x + layout.grid.width)
  assert.equal(last.y + last.height, layout.grid.y + layout.grid.height)
})

test('不可移动房间使用50%黑色蒙层', () => {
  assert.equal(ROOM_MASK_ALPHA, 0.5)
})

test('房间网格不会侵入顶部HUD或右侧房间图例', () => {
  const layout = createMovementLayout(1280, 722)

  assert.ok(layout.grid.y >= layout.vault.y + layout.vault.height)
  assert.ok(layout.grid.x + layout.grid.width <= layout.legend.x)
})

test('特殊房间类型与规则坐标保持一致', () => {
  assert.equal(roomTypeAt(2, 2), '地下金库')
  assert.equal(roomTypeAt(4, 4), '白鸽撤离点')
  assert.equal(roomTypeAt(0, 0), '复活点')
})
