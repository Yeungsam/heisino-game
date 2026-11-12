const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation } = require('./helpers/account-ui-simulation')

test('横屏商店可取消交易、出售卡牌，再选数量购买且仓库同步显示金币和总资产', async t => {
  const sim = await simulation(t, 1)
  let confirm = false
  let confirmation
  const player = await sim.mount(0, { width: 568, height: 320, showModal: args => {
    confirmation = args.content
    args.success({ confirm })
  } })
  await player.tap('home_shop')
  assert.equal(player.run('scene'), 'SHOP')
  await player.tap('shop_card', hit => hit.data === 'wp_006')
  assert.ok(player.draw().includes('金币不足'))
  assert.equal(player.hits('shop_confirm').length, 0)
  await player.tap('shop_mode', hit => hit.data === 'sell')
  await player.tap('shop_card', hit => hit.data === 'ar_001')
  await player.tap('shop_preview')
  await player.tap('card_preview_close')
  await player.tap('shop_confirm')
  assert.match(confirmation, /急救腰包 ×1\n获得 50000 金币/)
  assert.equal(player.run('accountProfile.gold'), 0)
  confirm = true
  await player.tap('shop_confirm')
  assert.equal(player.run('accountProfile.gold'), 50000)
  assert.equal(player.hits('shop_card').some(hit => hit.data === 'ar_001'), false)

  await player.tap('shop_mode', hit => hit.data === 'buy')
  await player.tap('shop_card', hit => hit.data === 'wp_006')
  await player.tap('shop_quantity', hit => hit.data === 1)
  assert.ok(player.draw().includes('合计 1920 金币'))
  const hit = player.hits('shop_confirm')[0].rect
  const x = hit.x + hit.width / 2
  const y = hit.y + hit.height / 2
  player.touch('start', x, y)
  player.touch('cancel', x, y)
  player.touch('end', x, y)
  assert.equal(player.run('accountProfile.gold'), 50000)
  await player.tap('shop_confirm')
  assert.match(confirmation, /礼宾伞 ×2\n支付 1920 金币/)
  assert.equal(player.run('accountProfile.quantities.wp_006'), 3)
  assert.equal(player.run('accountProfile.gold'), 48080)
  await player.tap('shop_home')
  await player.tap('home_warehouse')
  assert.ok(player.draw().includes('当前资产 100.48k  ·  金币 48.08k'))
})

test('商城成交回包连续超时，冷重启后只用原订单重试确认，库存金币不重复变更', async t => {
  const sim = await simulation(t, 2)
  const storage = new Map()
  const original = await sim.mount(0, { storage, blockResponse: request => {
    if (request.route === '/api/account/shop' && request.input.op === 'sell') throw new Error('request timeout')
  } })
  await original.tap('home_shop')
  await original.tap('shop_mode', hit => hit.data === 'sell')
  await original.tap('shop_card', hit => hit.data === 'wp_006')
  await original.tap('shop_confirm')
  const requests = original.requests.filter(req => req.input?.op === 'sell')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0].input, requests[1].input)
  assert.equal(original.run('accountProfile.gold'), 0)
  assert.ok(original.draw().includes('交易结果待确认'))
  assert.equal(original.hits('shop_confirm').length, 0)

  const other = await sim.mount(1, { storage })
  await other.tap('home_shop')
  assert.equal(other.hits('shop_retry_trade').length, 0)
  const recovered = await sim.mount(0, { storage })
  await recovered.tap('home_shop')
  assert.equal(recovered.run('accountProfile.gold'), 800)
  await recovered.tap('shop_retry_trade')
  assert.equal(JSON.stringify(recovered.requests.find(req => req.input?.op === 'sell').input), JSON.stringify(requests[0].input))
  assert.equal(recovered.hits('shop_retry_trade').length, 0)
  assert.equal(recovered.run('accountProfile.gold'), 800)
  assert.equal(recovered.run('accountProfile.quantities.wp_006'), 0)
  assert.equal([...sim.store.ledger.values()].filter(entry => entry.type === 'SHOP_SELL').length, 1)
})
