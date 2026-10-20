const test = require('node:test')
const assert = require('node:assert/strict')
const { createSafeLayout } = require('../client/js/core/safe-layout')

test('安全画布整体位于微信胶囊按钮下方', () => {
  const layout = createSafeLayout({
    windowInfo: { windowWidth: 812, windowHeight: 375, safeArea: { left: 0, top: 0, right: 812, bottom: 375, width: 812, height: 375 } },
    menuButtonRect: { left: 700, top: 8, right: 792, bottom: 40, width: 92, height: 32 }
  })
  assert.ok(layout.offsetY >= 40 + layout.bleed)
  assert.ok(layout.offsetY + layout.renderedHeight <= layout.contentBounds.bottom)
})

test('横屏刘海和底部手势区不会进入有效内容范围', () => {
  const layout = createSafeLayout({
    windowInfo: { windowWidth: 844, windowHeight: 390, safeArea: { left: 47, top: 0, right: 797, bottom: 369, width: 750, height: 369 } },
    menuButtonRect: { left: 690, top: 7, right: 782, bottom: 39, width: 92, height: 32 }
  })
  assert.ok(layout.offsetX >= 47 + layout.bleed)
  assert.ok(layout.offsetX + layout.renderedWidth <= 797 - layout.bleed)
  assert.ok(layout.offsetY + layout.renderedHeight <= 369 - layout.bleed)
})

test('触摸坐标经过安全缩放后仍与逻辑热点一致', () => {
  const layout = createSafeLayout({
    windowInfo: { windowWidth: 812, windowHeight: 375 },
    menuButtonRect: { left: 700, top: 8, right: 792, bottom: 40, width: 92, height: 32 }
  })
  const logical = { x: 624, y: 188 }
  const screen = layout.toScreenPoint(logical)
  const restored = layout.toLogicalPoint(screen)
  assert.ok(Math.abs(restored.x - logical.x) < 0.001)
  assert.ok(Math.abs(restored.y - logical.y) < 0.001)
})

test('无效胶囊数据会安全降级为设备安全区与基础出血', () => {
  const layout = createSafeLayout({
    windowInfo: { windowWidth: 800, windowHeight: 360 },
    menuButtonRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  })
  assert.equal(layout.menuButtonRect, null)
  assert.ok(layout.offsetX >= layout.bleed)
  assert.ok(layout.offsetY >= 40 + layout.bleed)
})
