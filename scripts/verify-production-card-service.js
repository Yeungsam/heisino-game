const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { cardApiBaseUrl, cardAssetBaseUrl } = require('../client/js/config')
const { cards: expectedCards } = require('../data/cards.json')
const { RETIRED_CARD_IDS } = require('../client/js/core/retired-cards')

const REQUIRED_CATEGORIES = ['WEAPON', 'ARMOR', 'LOOT', 'SKILL']

async function verifyProductionCardService() {
  const response = await fetch(`${cardApiBaseUrl}/api/cards`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200, `卡牌接口返回 HTTP ${response.status}`)
  assert.match(response.headers.get('content-type') || '', /application\/json/)
  const catalog = await response.json()
  assert.equal(catalog.total, expectedCards.length)
  assert.equal(catalog.cards.length, expectedCards.length)

  const ids = new Set()
  const expectedById = new Map(expectedCards.map(card => [card.card_id, card]))
  catalog.cards.forEach(card => {
    assert.ok(card.card_id)
    assert.ok(card.name)
    assert.ok(REQUIRED_CATEGORIES.includes(card.category), `未知卡牌类型 ${card.category}`)
    assert.ok(!ids.has(card.card_id), `重复 card_id ${card.card_id}`)
    ids.add(card.card_id)
    const expected = expectedById.get(card.card_id)
    assert.ok(expected, `未知卡牌编号：${card.card_id}`)
    assert.deepEqual(card, {
      ...expected,
      assets: { ...expected.assets, card_art_url: `${cardAssetBaseUrl}${expected.assets.card_art_path}` }
    }, `线上卡牌与发布目录不符：${card.card_id}`)
  })
  assert.deepEqual([...ids].sort(), expectedCards.map(card => card.card_id).sort())
  for (const id of RETIRED_CARD_IDS) {
    const detail = await fetch(`${cardApiBaseUrl}/api/cards/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    assert.equal(detail.status, 404)
    assert.deepEqual(await detail.json(), { error: 'CARD_NOT_FOUND' })
  }
  const validDetail = await fetch(`${cardApiBaseUrl}/api/cards/wp_006`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  assert.equal(validDetail.status, 200)
  assert.equal((await validDetail.json()).card_id, 'wp_006')
  const smokeDetail = await fetch(`${cardApiBaseUrl}/api/cards/loot_024`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  assert.equal(smokeDetail.status, 200)
  assert.deepEqual(await smokeDetail.json(), catalog.cards.find(card => card.card_id === 'loot_024'))

  const shield = catalog.cards.find(card => card.card_id === 'ar_013')
  const original = catalog.cards.find(card => card.card_id === 'ar_005')
  assert.equal(shield?.rarity, 'BLUE')
  assert.equal(shield.assets.card_art_url, original?.assets.card_art_url)

  const artwork = [...new Map(catalog.cards.map(card => [card.assets.card_art_url, card])).values()]
  async function verifyArtwork(card) {
    const artResponse = await fetch(card.assets.card_art_url, { signal: AbortSignal.timeout(10000) })
    assert.equal(artResponse.status, 200, `${card.card_id} 卡面返回 HTTP ${artResponse.status}`)
    assert.match(artResponse.headers.get('content-type') || '', /image\/jpeg/)
    const local = await fs.readFile(path.join(__dirname, '../server/public', card.assets.card_art_path))
    assert.ok(local.equals(Buffer.from(await artResponse.arrayBuffer())), `${card.card_id} 公网卡面与发布文件不同`)
  }
  for (let index = 0; index < artwork.length; index += 8) {
    await Promise.all(artwork.slice(index, index + 8).map(verifyArtwork))
  }

  console.log(`生产卡牌服务联调通过：${catalog.cards.length} 张卡牌、${artwork.length} 张公网卡面与发布文件逐一相符。`)
}

verifyProductionCardService().catch(error => {
  console.error(error)
  process.exitCode = 1
})
