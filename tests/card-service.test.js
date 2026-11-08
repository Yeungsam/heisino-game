const test = require('node:test')
const assert = require('node:assert/strict')
const { server } = require('../server')

test('卡牌服务返回完整卡库和可访问卡面', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`

  const response = await fetch(`${origin}/api/cards`)
  assert.equal(response.status, 200)
  const catalog = await response.json()
  assert.equal(catalog.schema_version, '0.2.0')
  assert.equal(catalog.total, 53)
  assert.equal(catalog.cards.length, 53)
  const shield = catalog.cards.find(card => card.card_id === 'ar_013')
  const original = catalog.cards.find(card => card.card_id === 'ar_005')
  assert.equal(shield.rarity, 'BLUE')
  assert.equal(original.rarity, 'GREEN')
  assert.equal(shield.assets.card_art_url, original.assets.card_art_url)
  assert.ok(shield.assets.card_art_url.startsWith(origin))

  const artResponse = await fetch(shield.assets.card_art_url)
  assert.equal(artResponse.status, 200)
  assert.equal(artResponse.headers.get('content-type'), 'image/jpeg')
  assert.ok((await artResponse.arrayBuffer()).byteLength > 1000)
})

test('卡牌服务支持按分类过滤', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/cards?category=skill`)
  const catalog = await response.json()

  assert.equal(catalog.total, 10)
  assert.ok(catalog.cards.every(card => card.category === 'SKILL'))
})
