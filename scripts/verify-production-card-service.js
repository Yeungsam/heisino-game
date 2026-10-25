const assert = require('node:assert/strict')
const { cardApiBaseUrl, cardAssetBaseUrl } = require('../client/js/config')

const REQUIRED_CATEGORIES = ['WEAPON', 'ARMOR', 'LOOT', 'SKILL']

async function verifyProductionCardService() {
  const response = await fetch(`${cardApiBaseUrl}/api/cards`, { signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200, `卡牌接口返回 HTTP ${response.status}`)
  assert.match(response.headers.get('content-type') || '', /application\/json/)
  const catalog = await response.json()
  assert.equal(catalog.total, 52)
  assert.equal(catalog.cards.length, 52)

  const ids = new Set()
  catalog.cards.forEach(card => {
    assert.ok(card.card_id)
    assert.ok(card.name)
    assert.ok(REQUIRED_CATEGORIES.includes(card.category), `未知卡牌类型 ${card.category}`)
    assert.ok(!ids.has(card.card_id), `重复 card_id ${card.card_id}`)
    ids.add(card.card_id)
    assert.ok(card.assets)
    assert.ok(card.assets.card_art_url.startsWith(`${cardAssetBaseUrl}/assets/cards/`))
  })

  for (const category of REQUIRED_CATEGORIES) {
    const card = catalog.cards.find(candidate => candidate.category === category)
    const artResponse = await fetch(card.assets.card_art_url, { signal: AbortSignal.timeout(10000) })
    assert.equal(artResponse.status, 200, `${category} 卡面返回 HTTP ${artResponse.status}`)
    assert.match(artResponse.headers.get('content-type') || '', /image\/jpeg/)
    assert.ok((await artResponse.arrayBuffer()).byteLength > 1000, `${category} 卡面内容为空`)
  }

  console.log(`生产卡牌服务联调通过：${catalog.cards.length} 张卡牌，四类卡面均可访问。`)
}

verifyProductionCardService().catch(error => {
  console.error(error)
  process.exitCode = 1
})
