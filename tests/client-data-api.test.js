const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const catalog = require('../data/cards.json')

function client(moduleName, perform) {
  const filename = path.resolve(__dirname, `../client/js/api/${moduleName}.js`)
  const calls = []
  const module = { exports: {} }
  const config = { cardApiBaseUrl: 'https://catalog.example', gameApiBaseUrl: 'https://game.example' }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: () => config,
    wx: { request(options) { calls.push(options); perform(options) } }
  }, { filename })
  return { api: module.exports, calls }
}

test('客户端卡库区分有效投影、空响应、接口错误和断网', async () => {
  const art = catalog.cards.find(card => card.card_id === 'ar_013')
  const offline = new Error('offline')
  const replies = [
    options => options.success({ statusCode: 200, data: { ...catalog, cards: [art] } }),
    options => options.success({ statusCode: 200, data: {} }),
    options => options.success({ statusCode: 503 }),
    options => options.fail(offline)
  ]
  const { api, calls } = client('cards', options => replies.shift()(options))
  const { cards } = await api.fetchCardCatalog()
  assert.equal(cards[0].cardId, 'ar_013')
  assert.equal(cards[0].rarity, 'BLUE')
  assert.equal(cards[0].assetPath, '/assets/cards/ar_005.jpg')
  await assert.rejects(api.fetchCardCatalog(), /CARD_API_200/)
  await assert.rejects(api.fetchCardCatalog({ baseUrl: 'https://override.example' }), /CARD_API_503/)
  await assert.rejects(api.fetchCardCatalog(), error => error === offline)
  assert.equal(calls[0].url, 'https://catalog.example/api/cards')
  assert.equal(calls[2].url, 'https://override.example/api/cards')
})

test('兼容搜索客户端正确编码路径、保留重试请求ID并区分错误响应', async () => {
  const replies = [
    options => options.success({ statusCode: 200, data: { ok: true, data: { ready: true } } }),
    options => options.success({ statusCode: 409, data: { ok: false, error: 'ITEM_NOT_VISIBLE' } }),
    options => options.success({ statusCode: 200, data: {} }),
    options => options.fail({ errMsg: 'offline' })
  ]
  const { api, calls } = client('search', options => replies.shift()(options))
  const input = { gameId: 'g/1', visitId: 'v 2', playerId: 'p&3', requestId: 'retry-1234' }
  assert.equal((await api.getSearchVisit(input)).ready, true)
  assert.equal(calls[0].url, 'https://game.example/api/search/games/g%2F1/visits/v%202?playerId=p%263')
  await assert.rejects(api.pickupSearchItem(input), { code: 'ITEM_NOT_VISIBLE', statusCode: 409 })
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].header['X-Request-Id'], input.requestId)
  await assert.rejects(api.startSearchVisit(input), { code: 'SEARCH_API_ERROR' })
  await assert.rejects(api.leaveSearchRoom(input), { code: 'SEARCH_API_UNAVAILABLE' })
})
