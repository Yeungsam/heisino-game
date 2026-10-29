const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { HOME_SOURCE_SIZE, HOME_LAYERS, HOME_LABELS, createHomeLayout, centeredTextBaseline } = require('../client/js/ui/home-screen')

const clientRoot = path.join(__dirname, '..', 'client')

function directorySize(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name)
    return total + (entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size)
  }, 0)
}

test('Figma 首页在 1920×1080 下保持原始图层坐标', () => {
  const layout = createHomeLayout(1920, 1080)
  assert.equal(layout.scale, 1)
  assert.deepEqual(layout.logo, HOME_LAYERS.logo)
  assert.deepEqual(layout.character, HOME_LAYERS.character)
  assert.deepEqual(layout.cat, HOME_LAYERS.cat)
  assert.deepEqual(layout.buttons.shop, HOME_LAYERS.shop)
  assert.deepEqual(layout.buttons.warehouse, HOME_LAYERS.warehouse)
  assert.deepEqual(layout.buttons.start, HOME_LAYERS.start)
  assert.deepEqual(layout.labels.shop, HOME_LABELS.shop)
})

test('超宽屏下首页前景安全区完整且三个按钮不重叠', () => {
  const layout = createHomeLayout(2340, 1080)
  assert.equal(layout.safeRect.height, 1080)
  assert.equal(layout.safeRect.width, HOME_SOURCE_SIZE.width)
  assert.ok(layout.safeRect.x > 0)
  const buttons = [layout.buttons.shop, layout.buttons.warehouse, layout.buttons.start]
  buttons.forEach(rect => {
    assert.ok(rect.x >= 0 && rect.y >= 0)
    assert.ok(rect.x + rect.width <= 2340)
    assert.ok(rect.y + rect.height <= 1080)
  })
  assert.ok(layout.buttons.shop.x + layout.buttons.shop.width <= layout.buttons.warehouse.x)
  assert.ok(layout.buttons.warehouse.x + layout.buttons.warehouse.width <= layout.buttons.start.x)
})

test('窄比例横屏下前景安全区完整保留', () => {
  const layout = createHomeLayout(1280, 800)
  assert.equal(layout.safeRect.width, 1280)
  assert.ok(layout.safeRect.y > 0)
  assert.ok(layout.buttons.start.y + layout.buttons.start.height <= 800)
})

test('Figma 首页七个本地素材完整且小游戏目录低于4MiB', () => {
  const assetDirectory = path.join(clientRoot, 'assets', 'ui', 'home')
  const assets = [
    'background.jpg',
    'logo.png',
    'character.png',
    'cat.png',
    'shop-button.png',
    'warehouse-button.png',
    'start-button.png'
  ]
  assets.forEach(filename => assert.ok(fs.statSync(path.join(assetDirectory, filename)).size > 0))
  assert.ok(directorySize(clientRoot) < 4 * 1024 * 1024)
})

test('首页按钮文字按字形边界上下视觉居中', () => {
  const rect = HOME_LAYERS.shop
  const metrics = { actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 8 }
  const baseline = centeredTextBaseline(rect, metrics)
  const glyphTop = baseline - metrics.actualBoundingBoxAscent
  const glyphBottom = baseline + metrics.actualBoundingBoxDescent
  assert.equal((glyphTop + glyphBottom) / 2, rect.y + rect.height / 2)
})
