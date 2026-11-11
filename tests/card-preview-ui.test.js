const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation, center, transferLoadoutCard } = require('./helpers/account-ui-simulation')

test('仓库卡牌轻点打开居中黑色蒙层，长按、滑动和取消不会打开', async t => {
  const sim = await simulation(t, 1)
  const [app] = sim.client
  await app.tap('home_warehouse')
  const card = app.hits('warehouse_card')[0]
  const point = center(card.rect)
  const back = center(app.hits('warehouse_home')[0].rect)

  app.touch('start', ...point)
  sim.tick(600)
  app.touch('end', ...point)
  assert.equal(app.run('cardPreviewId'), null)
  app.touch('start', ...point)
  app.touch('move', point[0], point[1] + 25)
  app.touch('move', ...point)
  app.touch('end', ...point)
  assert.equal(app.run('cardPreviewId'), null)
  app.touch('start', ...point)
  app.touch('cancel', ...point)
  app.touch('end', ...point)
  assert.equal(app.run('cardPreviewId'), null)

  await app.tap('warehouse_card', hit => hit.data === card.data)
  assert.equal(app.run('cardPreviewId'), card.data)
  assert.ok(!app.draw().includes('点击屏幕任意位置返回仓库'))
  assert.deepEqual(app.read('ui.hotspots.map(hit => hit.id)'), ['card_preview_close'])
  const rendered = app.run(`(() => {
    const art = drawCardArt
    const fill = context.fillRect
    const result = { labels: [] }
    const writeText = text
    drawCardArt = (card, rect) => { result.card = card.cardId; result.rect = rect }
    context.fillRect = (...args) => { result.mask = [context.fillStyle, ...args] }
    text = value => result.labels.push(value)
    try { drawCardPreview(); return result }
    finally { drawCardArt = art; context.fillRect = fill; text = writeText }
  })()`)
  assert.equal(rendered.card, card.data)
  assert.deepEqual([...rendered.mask], ['rgba(0,0,0,.9)', 0, 0, 812, 375])
  assert.equal(rendered.rect.x + rendered.rect.width / 2, 406)
  assert.equal(rendered.rect.y + rendered.rect.height / 2, 187.5)
  assert.equal(rendered.labels.length, 0)

  app.touch('start', ...back)
  app.touch('end', ...back)
  assert.equal(app.run('scene'), 'WAREHOUSE')
  assert.equal(app.run('cardPreviewId'), null)
  await app.tap('warehouse_home')
  assert.equal(app.run('scene'), 'HOME')
})

test('战备卡可预览和用按钮转移，长按拖到背包或仓库仍能直接转移', async t => {
  const sim = await simulation(t, 1)
  const [app] = sim.client
  await app.tap('home_start')
  const findCard = source => app.hits(`loadout_${source}_card`).find(hit => hit.data === 'wp_006')
  const from = center(findCard('warehouse').rect)
  app.touch('start', ...from)
  sim.tick(600)
  app.touch('end', ...from)
  assert.equal(app.run('cardPreviewId'), null)
  assert.equal(findCard('backpack'), undefined)

  const dragCard = (source, destination) => {
    const start = center(findCard(source).rect)
    const end = center(app.read(destination))
    app.touch('start', ...start)
    sim.tick(600)
    app.touch('move', start[0] + Math.sign(end[0] - start[0]) * 25, start[1])
    app.touch('move', ...end)
    app.touch('end', ...end)
    assert.equal(app.run('cardPreviewId'), null)
  }
  dragCard('warehouse', 'ui.loadoutBackpackDropRect')
  assert.ok(findCard('backpack'))
  dragCard('backpack', 'ui.loadoutWarehouseDropRect')
  assert.equal(findCard('backpack'), undefined)

  await app.tap('loadout_warehouse_card', hit => hit.data === 'wp_006')
  assert.equal(app.run('cardPreviewId'), 'wp_006')
  await app.tap('card_preview_close')
  assert.equal(findCard('backpack'), undefined)
  await app.tap('loadout_transfer')
  assert.ok(findCard('backpack'))
  await transferLoadoutCard(app, 'wp_006', 'backpack')
  assert.equal(findCard('backpack'), undefined)
})
