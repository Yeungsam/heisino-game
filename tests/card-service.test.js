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
  assert.equal(catalog.total, 51)
  assert.equal(catalog.cards.length, 51)
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

  assert.equal(catalog.total, 8)
  assert.ok(catalog.cards.every(card => card.category === 'SKILL'))
})

test('卡牌详情区分缺失和非法编码，错误请求后服务仍可用', async t => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = route => fetch(origin + route, { signal: AbortSignal.timeout(1000) })
  const card = await request('/api/cards/ar_013')
  assert.equal(card.status, 200)
  assert.equal((await card.json()).card_id, 'ar_013')
  const missing = await request('/api/cards/does_not_exist')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'CARD_NOT_FOUND' })
  for (const id of ['sk_002', 'sk_003']) {
    const retired = await request(`/api/cards/${id}`)
    assert.equal(retired.status, 404)
    assert.deepEqual(await retired.json(), { error: 'CARD_NOT_FOUND' })
  }
  const asset = await request('/assets/cards/does_not_exist.jpg')
  assert.equal(asset.status, 404)
  assert.deepEqual(await asset.json(), { error: 'ASSET_NOT_FOUND' })
  const malformed = await request('/api/cards/%E0%A4%A')
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'INVALID_CARD_ID' })
  assert.equal((await request('/health')).status, 200)
})
