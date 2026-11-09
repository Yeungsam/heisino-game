const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { HOME_SOURCE_SIZE, HOME_LAYERS, HOME_LABELS, createHomeLayout, centeredTextBaseline } = require('../client/js/ui/home-screen')
const { ROOM_BACKGROUNDS } = require('../client/js/ui/search-room')

const clientRoot = path.join(__dirname, '..', 'client')

function directorySize(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name)
    return total + (entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size)
  }, 0)
}

function primaryPackageSize(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.isDirectory() && entry.name === 'subpackages') return total
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

test('Figma 首页七个本地素材完整且小游戏主包低于4MiB', () => {
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
  assert.ok(primaryPackageSize(clientRoot) < 4 * 1024 * 1024)
})

test('房间搜索美术使用独立分包且低于4MiB', () => {
  const searchPackage = path.join(clientRoot, 'subpackages', 'search')
  assert.ok(fs.statSync(path.join(searchPackage, 'assets', 'room-background.png')).size > 0)
  assert.ok(fs.statSync(path.join(searchPackage, 'assets', 'search-panel.png')).size > 0)
  assert.ok(directorySize(searchPackage) < 4 * 1024 * 1024)
  const config = JSON.parse(fs.readFileSync(path.join(clientRoot, 'game.json'), 'utf8'))
  assert.ok(config.subpackages.some(item => item.name === 'search' && item.root === 'subpackages/search'))
})

test('五张 Figma 房间底图都以原始尺寸进入小游戏本地房间分包', () => {
  const root = 'subpackages/rooms'
  const config = JSON.parse(fs.readFileSync(path.join(clientRoot, 'game.json'), 'utf8'))
  assert.ok(config.subpackages.some(item => item.name === 'rooms' && item.root === root))
  assert.ok(fs.existsSync(path.join(clientRoot, root, 'game.js')))
  assert.ok(directorySize(path.join(clientRoot, root)) < 4 * 1024 * 1024)
  assert.equal(Object.keys(ROOM_BACKGROUNDS).length, 5)
  for (const { source, width, height } of Object.values(ROOM_BACKGROUNDS)) {
    assert.ok(source.startsWith(`${root}/assets/`))
    const image = fs.readFileSync(path.join(clientRoot, source))
    assert.equal(image.subarray(12, 16).toString(), 'IHDR')
    assert.equal(image.readUInt32BE(16), width)
    assert.equal(image.readUInt32BE(20), height)
  }
})

test('首页按钮文字按字形边界上下视觉居中', () => {
  const rect = HOME_LAYERS.shop
  const metrics = { actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 8 }
  const baseline = centeredTextBaseline(rect, metrics)
  const glyphTop = baseline - metrics.actualBoundingBoxAscent
  const glyphBottom = baseline + metrics.actualBoundingBoxDescent
  assert.equal((glyphTop + glyphBottom) / 2, rect.y + rect.height / 2)
})
