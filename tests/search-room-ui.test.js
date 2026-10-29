const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SEARCH_DURATION_MS,
  ROOM_AREA_TEMPLATE,
  searchTimerState,
  createSearchLayout,
  createRoomLayout,
  fitAspectRect,
  createHudSafeLayout,
  nextSearchMagnifierIndex,
  magnifierOrbitState,
  MAGNIFIER_ORBIT_PERIOD_MS
} = require('../client/js/ui/search-room')
const { CARD_ASPECT_RATIO } = require('../client/js/ui/card-scroll')

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

test('超宽屏下房间完整安全区、标题、倒计时和离开按钮均不裁切', () => {
  const viewWidth = 2622
  const viewHeight = 1206
  const layout = createRoomLayout(viewWidth, viewHeight)
  assert.equal(layout.contentRect.height, viewHeight)
  assert.ok(layout.contentRect.x > 0)
  ;[layout.title, layout.timer, layout.leave, ...layout.areas].forEach(rect => {
    assert.ok(rect.x >= 0)
    assert.ok(rect.y >= 0)
    assert.ok(rect.x + rect.width <= viewWidth)
    assert.ok(rect.y + rect.height <= viewHeight)
  })
})

test('搜索卡面保持真实比例并完整收入卡槽可见边界', () => {
  const slot = { x: 20, y: 30, width: 144, height: 200 }
  const card = fitAspectRect(slot, CARD_ASPECT_RATIO)
  assert.ok(Math.abs(card.width / card.height - CARD_ASPECT_RATIO) < 1e-9)
  assert.ok(card.x > slot.x)
  assert.ok(card.y > slot.y)
  assert.ok(card.x + card.width < slot.x + slot.width)
  assert.ok(card.y + card.height < slot.y + slot.height)
})

test('顶部物资文字会避让微信系统胶囊', () => {
  const layout = createHudSafeLayout(2622, { left: 2310, right: 2580, top: 8, bottom: 42 })
  assert.ok(layout.resourceRight < 2310)
  assert.equal(createHudSafeLayout(1280, null).resourceRight, 1262)
})

test('放大镜按下一张未揭示卡牌的卡槽逐格移动', () => {
  assert.equal(nextSearchMagnifierIndex(0, 4, 0), 0)
  assert.equal(nextSearchMagnifierIndex(1, 4, 2100), 1)
  assert.equal(nextSearchMagnifierIndex(3, 4, 6100), 3)
  assert.equal(nextSearchMagnifierIndex(4, 4, 8100), null)
  assert.equal(nextSearchMagnifierIndex(0, 0, 1999), 0)
  assert.equal(nextSearchMagnifierIndex(0, 0, 2000), null)
})

test('放大镜围绕目标卡槽做连续圆周运动', () => {
  const slot = { x: 100, y: 200, width: 120, height: 180 }
  const start = magnifierOrbitState(slot, 1000, 1000)
  const quarter = magnifierOrbitState(slot, 1000 + MAGNIFIER_ORBIT_PERIOD_MS / 4, 1000)
  const complete = magnifierOrbitState(slot, 1000 + MAGNIFIER_ORBIT_PERIOD_MS, 1000)
  assert.equal(start.centerX, 160)
  assert.equal(start.centerY, 290)
  assert.ok(Math.abs(Math.hypot(start.x - start.centerX, start.y - start.centerY) - start.radius) < 1e-9)
  assert.ok(quarter.x > start.x)
  assert.ok(Math.abs(complete.x - start.x) < 1e-9)
  assert.ok(Math.abs(complete.y - start.y) < 1e-9)
  assert.equal(complete.alpha, 1)
})
