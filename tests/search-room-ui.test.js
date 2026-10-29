const test = require('node:test')
const assert = require('node:assert/strict')
const { SEARCH_DURATION_MS, ROOM_AREA_TEMPLATE, searchTimerState, createSearchLayout, createRoomLayout } = require('../client/js/ui/search-room')

test('搜索轮倒计时从100%线性缩减到0%', () => {
  const deadlineAt = 1000 + SEARCH_DURATION_MS
  assert.deepEqual(searchTimerState(deadlineAt, 1000), { remainingMs: 50000, seconds: 50, progress: 1, expired: false })
  assert.equal(searchTimerState(deadlineAt, 26000).progress, 0.5)
  assert.deepEqual(searchTimerState(deadlineAt, deadlineAt), { remainingMs: 0, seconds: 0, progress: 0, expired: true })
})

test('搜索浮层左右分区不重叠且避开顶部HUD和底部按钮', () => {
  const layout = createSearchLayout(1280, 720)
  assert.ok(layout.inventory.y >= 78)
  assert.ok(layout.inventory.x + layout.inventory.width < layout.search.x)
  assert.ok(layout.search.x + layout.search.width <= 1280 - 18)
  assert.ok(layout.inventory.y + layout.inventory.height <= layout.finish.y)
  assert.ok(layout.timer.y >= 48)
})

test('房间点击模板包含三个不可见区域且随画布等比映射', () => {
  const layout = createRoomLayout(1280, 720)
  assert.equal(ROOM_AREA_TEMPLATE.length, 3)
  assert.deepEqual(layout.areas.map(area => area.areaId), ['LEFT_CABINET', 'MAIN_TABLE', 'RIGHT_TABLE'])
  layout.areas.forEach(area => {
    assert.ok(area.width > 0)
    assert.ok(area.height > 0)
    assert.ok(area.x + area.width > 0)
    assert.ok(area.x < 1280)
  })
})
