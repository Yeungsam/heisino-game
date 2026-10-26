const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SOURCE_SIZE,
  ROOM_MASK_ALPHA,
  PIN_TRANSITION_MS,
  LANDMARK_ROOMS,
  createMovementLayout,
  landmarkIconRect,
  roomRect,
  roomHighlightStyle,
  roomTypeAt,
  pinTransitionOpacity
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

test('当前房间亮度高于目标与其他可移动房间', () => {
  const current = roomHighlightStyle('CURRENT')
  const selected = roomHighlightStyle('SELECTED')
  const reachable = roomHighlightStyle('REACHABLE')

  assert.ok(current.fillAlpha > selected.fillAlpha)
  assert.ok(selected.fillAlpha > reachable.fillAlpha)
  assert.ok(current.glow > selected.glow)
  assert.ok(selected.glow > reachable.glow)
  assert.ok(current.lineWidth > selected.lineWidth)
  assert.ok(selected.lineWidth > reachable.lineWidth)
})

test('地图图针先在当前房间渐隐，再在目标房间渐现', () => {
  assert.deepEqual(pinTransitionOpacity(0), { from: 1, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS / 4), { from: 0.5, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS / 2), { from: 0, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS * 0.75), { from: 0, to: 0.5, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS), { from: 0, to: 1, done: true })
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

test('中央金库宝箱与撤离出口图标位于对应房间内部', () => {
  const layout = createMovementLayout(SOURCE_SIZE.width, SOURCE_SIZE.height)
  const vaultRoom = roomRect(layout, LANDMARK_ROOMS.VAULT.x, LANDMARK_ROOMS.VAULT.y)
  const exitRoom = roomRect(layout, LANDMARK_ROOMS.EXIT.x, LANDMARK_ROOMS.EXIT.y)
  const vaultIcon = landmarkIconRect(layout, LANDMARK_ROOMS.VAULT.x, LANDMARK_ROOMS.VAULT.y)
  const exitIcon = landmarkIconRect(layout, LANDMARK_ROOMS.EXIT.x, LANDMARK_ROOMS.EXIT.y)

  ;[[vaultRoom, vaultIcon], [exitRoom, exitIcon]].forEach(([room, icon]) => {
    assert.ok(icon.x >= room.x)
    assert.ok(icon.y >= room.y)
    assert.ok(icon.x + icon.width <= room.x + room.width)
    assert.ok(icon.y + icon.height <= room.y + room.height)
  })
})
