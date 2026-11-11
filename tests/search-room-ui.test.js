const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SEARCH_DURATION_MS,
  ROOM_AREA_TEMPLATE,
  searchTimerState,
  syncSearchDeadline,
  createSearchLayout,
  createRoomLayout,
  fitAspectRect,
  createHudSafeLayout,
  createSearchPanelContentLayout,
  createNineSliceGeometry,
  SEARCH_PANEL_NINE_SLICE,
  nextSearchRippleIndex,
  searchRippleState,
  SEARCH_RIPPLE_PERIOD_MS
} = require('../client/js/ui/search-room')
const { CARD_ASPECT_RATIO } = require('../client/js/ui/card-scroll')

test('搜索轮倒计时从100%线性缩减到0%', () => {
  const deadlineAt = 1000 + SEARCH_DURATION_MS
  assert.deepEqual(searchTimerState(deadlineAt, 1000), { remainingMs: 50000, seconds: 50, progress: 1, expired: false })
  assert.equal(searchTimerState(deadlineAt, 26000).progress, 0.5)
  assert.equal(searchTimerState(deadlineAt, 13500).progress, 0.75)
  assert.equal(searchTimerState(deadlineAt, 38500).progress, 0.25)
  assert.equal(searchTimerState(deadlineAt, 0).progress, 1)
  assert.equal(searchTimerState(deadlineAt, deadlineAt + 2000).progress, 0)
  assert.deepEqual(searchTimerState(deadlineAt, deadlineAt), { remainingMs: 0, seconds: 0, progress: 0, expired: true })
})

test('同一房间心跳不改变计时时基，恢复延时或进入新房间时才更新', () => {
  const visit = { visitId: 'round-1', deadlineAt: 51000 }
  const first = syncSearchDeadline(null, visit, 1000, 3000)
  assert.equal(first.localDeadlineAt, 53000)
  assert.equal(syncSearchDeadline(first, visit, 3500, 5900), first)
  assert.equal(searchTimerState(first.localDeadlineAt, 28000).progress, 0.5)
  const resumed = syncSearchDeadline(first, { ...visit, deadlineAt: 61000 }, 21000, 23000)
  assert.equal(resumed.localDeadlineAt, 63000)
  assert.notEqual(syncSearchDeadline(resumed, { visitId: 'round-2', deadlineAt: 61000 }, 22000, 24100), resumed)
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
  assert.equal(layout.contentRect.width, viewWidth)
  assert.ok(layout.contentRect.y < 0)
  ;[layout.title, layout.timer, layout.leave, ...layout.areas].forEach(rect => {
    assert.ok(rect.x >= 0)
    assert.ok(rect.y >= 0)
    assert.ok(rect.x + rect.width <= viewWidth)
    assert.ok(rect.y + rect.height <= viewHeight)
  })
})

test('房间底图等比铺满，不用边缘补条，搜索区域跟随家具的变换', () => {
  for (const [width, height] of [[1280, 720], [2622, 1206], [800, 600]]) {
    const { artwork, contentRect, areas } = createRoomLayout(width, height)
    assert.ok(contentRect.x <= 0 && contentRect.y <= 0)
    assert.ok(contentRect.x + contentRect.width >= width - 1e-8)
    assert.ok(contentRect.y + contentRect.height >= height - 1e-8)
    assert.ok(Math.abs(contentRect.width / contentRect.height - 16 / 9) < 1e-8)
    assert.equal(areas.length, 3)
    for (const area of areas) {
      const source = ROOM_AREA_TEMPLATE.find(item => item.areaId === area.areaId)
      assert.equal(area.x, Math.max(0, artwork.offsetX + source.x * artwork.scale))
      assert.equal(area.y, Math.max(0, artwork.offsetY + source.y * artwork.scale))
      assert.ok(area.x + area.width <= width && area.y + area.height <= height)
    }
  }
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
  assert.equal(createHudSafeLayout(1280, null).resourceRight, 1024)
})

test('搜索页顶部五栏各自有宽度和间距，适配窄横屏及微信胶囊', () => {
  for (const width of [568, 667, 812, 1280, 2622]) {
    const menuLeft = width * 0.78
    const layout = createHudSafeLayout(width, { left: menuLeft })
    const fields = [layout.title, layout.round, layout.hp, layout.alert, layout.resource]
    fields.forEach((field, index) => {
      assert.ok(field.width > 0)
      if (index) assert.ok(fields[index - 1].x + fields[index - 1].width < field.x)
    })
    assert.ok(Math.abs(layout.resource.x + layout.resource.width - layout.resourceRight) < 1e-8)
    assert.ok(layout.resourceRight <= menuLeft - width * 0.055)
  }
})

test('搜索面板标题和卡牌网格位于边框安全区内', () => {
  const rect = { x: 56, y: 247, width: 924, height: 690 }
  const layout = createSearchPanelContentLayout(rect, 1)
  assert.ok(layout.iconTop > rect.y + 30)
  assert.ok(layout.headerBaselineY > layout.iconTop)
  assert.ok(layout.headerBaselineY < layout.gridTop)
  assert.ok(layout.gridBottom < rect.y + rect.height)
  assert.ok(layout.gridBottom > layout.gridTop)
})

test('搜索面板九宫格缩放保持四角比例不变', () => {
  const scale = 1206 / 1080
  const segments = createNineSliceGeometry(900, 553, { x: 100, y: 200, width: 924 * scale, height: 690 * scale }, SEARCH_PANEL_NINE_SLICE, scale)
  const corners = [segments[0], segments[2], segments[6], segments[8]]
  corners.forEach(segment => {
    assert.ok(Math.abs(segment.destination.width / segment.source.width - scale) < 1e-9)
    assert.ok(Math.abs(segment.destination.height / segment.source.height - scale) < 1e-9)
  })
  assert.ok(segments[4].destination.height > segments[4].source.height * scale)
})

test('水波纹跟随下一个待揭示卡槽，全部揭示或空区域确认后停止', () => {
  assert.equal(nextSearchRippleIndex(0, 4, 0), 0)
  assert.equal(nextSearchRippleIndex(1, 4, 500), 1)
  assert.equal(nextSearchRippleIndex(3, 4, 1500), 3)
  assert.equal(nextSearchRippleIndex(4, 4, 2000), null)
  assert.equal(nextSearchRippleIndex(0, 0, 499), 0)
  assert.equal(nextSearchRippleIndex(0, 0, 500), null)
})

test('两道同心波纹交错扩散、淡出且不越过卡槽', () => {
  const slot = { x: 100, y: 200, width: 120, height: 180 }
  const start = searchRippleState(slot, 1000, 1000)
  const staggered = searchRippleState(slot, 1000 + SEARCH_RIPPLE_PERIOD_MS / 2, 1000)
  const nearEnd = searchRippleState(slot, 1000 + SEARCH_RIPPLE_PERIOD_MS - 1, 1000)
  const nextCycle = searchRippleState(slot, 1000 + SEARCH_RIPPLE_PERIOD_MS, 1000)
  assert.deepEqual([start.x, start.y], [160, 290])
  assert.deepEqual([staggered.x, staggered.y], [160, 290])
  assert.equal(start.rings.length, 1)
  assert.equal(staggered.rings.length, 2)
  assert.deepEqual(staggered.rings[1], start.rings[0])
  assert.ok(staggered.rings[0].radius > start.rings[0].radius)
  assert.ok(nearEnd.rings[0].radius < slot.width / 2)
  assert.ok(nearEnd.rings[0].alpha < 0.01)
  assert.deepEqual(nextCycle.rings[0], start.rings[0])
})
