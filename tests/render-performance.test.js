const test = require('node:test')
const assert = require('node:assert/strict')
const { TAP_DURATION_MS, createTapFeedback, createRenderScheduler, createMemo, createLayerCanvas } = require('../client/js/ui/render-performance')

test('全局点击反馈准确持续500ms，半径扩散、低透明度且按时清除', () => {
  const effects = createTapFeedback()
  assert.equal(TAP_DURATION_MS, 500)
  effects.add({ x: 25, y: 60 }, 100)
  const first = effects.sample(100)[0], middle = effects.sample(350)[0]
  assert.equal(first.x, 25)
  assert.equal(first.y, 60)
  assert.equal(first.alpha, 0.54)
  assert.ok(middle.radius > first.radius && middle.alpha < first.alpha)
  assert.equal(effects.sample(599).length, 1)
  assert.equal(effects.sample(600).length, 0)
})

test('点击反馈有数量上限，触控后合成鼠标事件不会重复触发', () => {
  const effects = createTapFeedback(8)
  assert.equal(effects.add({ x: NaN, y: 4 }, 0), false)
  for (let i = 0; i < 20; i += 1) effects.add({ x: i, y: 0 }, i)
  assert.equal(effects.sample(20).length, 8)
  assert.equal(effects.add({ x: 19, y: 0 }, 21, 'mouse'), false)
  effects.clear()
  assert.equal(effects.sample(21).length, 0)
})

test('静止页面十秒仅重画一次，点击动效只需重用缓存，结束后擦除', () => {
  const scheduler = createRenderScheduler()
  assert.deepEqual(scheduler.frame(0, 'HOME', false), { sceneChanged: true })
  for (let time = 34; time < 10000; time += 34) assert.equal(scheduler.frame(time, 'HOME', false), null)
  assert.deepEqual(scheduler.frame(10000, 'HOME', true), { sceneChanged: false })
  assert.deepEqual(scheduler.frame(10500, 'HOME', false), { sceneChanged: false })
  assert.equal(scheduler.frame(10534, 'HOME', false), null)
  scheduler.invalidate()
  assert.deepEqual(scheduler.frame(10535, 'HOME', false), { sceneChanged: true })
})

test('动画重绘遵守30fps上限，限帧期间的状态变更不会丢失', () => {
  const scheduler = createRenderScheduler(30)
  scheduler.frame(0, 0, false)
  scheduler.invalidate()
  assert.equal(scheduler.frame(16, 1, false), null)
  assert.deepEqual(scheduler.frame(34, 1, false), { sceneChanged: true })
})

test('文本排版缓存有上限，命中时不再测量', () => {
  const memo = createMemo(2)
  let count = 0
  const build = () => ++count
  assert.equal(memo('a', build), 1)
  assert.equal(memo('a', build), 1)
  memo('b', build)
  memo('c', build)
  assert.equal(memo('a', build), 4)
})

test('支持小游戏createCanvas离屏路径，不能调整或复用主画布', () => {
  const screen = { width: 1200, height: 600 }, layer = { getContext: () => ({}) }
  assert.equal(createLayerCanvas({ createCanvas: () => layer }, screen), layer)
  assert.equal(layer.width, 1200)
  assert.equal(layer.height, 600)
  assert.equal(createLayerCanvas({ createCanvas: () => screen }, screen), null)
  assert.equal(createLayerCanvas({ createOffscreenCanvas() { throw new Error('unsupported') }, createCanvas: () => layer }, screen), layer)
})
