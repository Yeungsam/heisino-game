const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { formatAmount, formatChange } = require('../client/js/ui/asset-amount')

async function fixture() {
  const store = new MemoryAccountStore()
  const service = new AccountService({ store, identity: {
    exchange: async code => ({ appId: 'shop-test', openid: code }), moderate: async () => {}
  } })
  const { token, profile } = await service.login('shop-owner')
  const document = store.documents.get(profile.accountId)
  await service.execute(token, 'profile', { nickname: '商店测试' })
  const edit = callback => callback(store.documents.get(profile.accountId))
  const shop = input => service.execute(token, 'shop', input)
  return { store, service, token, document, edit, shop, accountId: profile.accountId }
}

test('货架仅含指定 A/B 战斗卡，四类库存均可卖，守卫盾只卖给商店且价值为 1', async () => {
  const { shop, edit, store } = await fixture()
  edit(doc => Object.assign(doc.quantities, { loot_002: 2, ar_013: 1 }))
  const list = await shop({ op: 'list' })
  assert.equal(list.catalog.length, 51)
  assert.deepEqual(list.catalog.filter(card => card.buyPrice !== null).map(card => card.cardId).sort(), [
    'ar_002', 'ar_005', 'ar_006', 'ar_007', 'ar_008', 'ar_009', 'ar_010', 'ar_011',
    'sk_006', 'sk_007', 'sk_008', 'sk_009', 'wp_004', 'wp_005', 'wp_006', 'wp_007'
  ])
  assert.equal(list.profile.assetValue, 160801)
  const cards = [['ar_013', 1, 1], ['loot_002', 30000, 2], ['wp_006', 800, 1], ['sk_001', 50000, 1], ['ar_001', 50000, 1]]
  let expectedGold = 0
  for (const [cardId, unitPrice, quantity] of cards) {
    const { profile, trade } = await shop({ op: 'sell', cardId, unitPrice, quantity, requestId: `sell-${cardId}` })
    expectedGold += unitPrice * quantity
    assert.equal(trade.total, unitPrice * quantity)
    assert.equal(profile.gold, expectedGold)
    assert.equal(profile.quantities[cardId], 0)
    assert.equal(profile.assetValue, 160801)
  }
  const bought = await shop({ op: 'buy', cardId: 'sk_008', unitPrice: 960, quantity: 2, requestId: 'buy-skill-1' })
  assert.equal(bought.profile.quantities.sk_008, 2)
  assert.equal(bought.profile.gold, expectedGold - 1920)
  assert.equal(bought.profile.assetValue, 160481)
  assert.equal([...store.ledger.values()].filter(entry => entry.type === 'SHOP_SELL').length, 5)
  assert.equal([...store.ledger.values()].find(entry => entry.type === 'SHOP_BUY').goldDelta, -1920)
})

test('非法数量、过期报价、余额不足、超卖、非上架卡和局内交易均不落流水', async () => {
  const { shop, edit, store, service, token, accountId } = await fixture()
  const bad = { op: 'buy', cardId: 'wp_006', quantity: 1, unitPrice: 960, requestId: 'invalid-buy-1' }
  for (const quantity of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(shop({ ...bad, quantity }), { code: 'TRADE_INVALID' })
  }
  await assert.rejects(shop({ ...bad, unitPrice: 800, gold: 100000 }), { code: 'SHOP_PRICE_CHANGED' })
  await assert.rejects(shop(bad), { code: 'INSUFFICIENT_GOLD' })
  await assert.rejects(shop({ ...bad, op: 'sell', unitPrice: 800, quantity: 2 }), { code: 'NOT_OWNED' })
  for (const cardId of ['loot_010', 'ar_013', 'wp_001', 'sk_004']) {
    await assert.rejects(shop({ ...bad, cardId }), { code: 'CARD_NOT_FOR_SALE' })
  }
  for (const cardId of ['constructor', 'sk_002']) await assert.rejects(shop({ ...bad, cardId }), { code: 'SHOP_CARD_INVALID' })
  await assert.rejects(service.execute(`${accountId}.${'x'.repeat(43)}`, 'shop', { op: 'list' }), { code: 'UNAUTHENTICATED' })
  edit(doc => { doc.lobbyRoomId = 'test-room' })
  await assert.rejects(shop({ op: 'list' }), { code: 'ALREADY_IN_ROOM' })
  edit(doc => { doc.lobbyRoomId = null })
  await service.execute(token, 'start', { requestId: 'shop-locked', mode: 'SINGLE', cardIds: [] })
  await assert.rejects(shop({ ...bad, op: 'sell', unitPrice: 800 }), { code: 'ACTIVE_GAME_EXISTS' })
  assert.equal([...store.ledger.values()].filter(entry => entry.type.startsWith('SHOP')).length, 0)
})

test('同单并发与流水摘要滚动后重试只成交一次，复用请求号和并发超卖被拒绝', async () => {
  const { shop, edit, store } = await fixture()
  const sale = { op: 'sell', cardId: 'wp_006', quantity: 1, unitPrice: 800, requestId: 'duplicate-sale-01' }
  const results = await Promise.all([shop(sale), shop(sale), shop(sale)])
  assert.ok(results.every(result => result.profile.gold === 800 && result.trade.total === 800))
  edit(doc => { doc.ledger = doc.ledger.filter(entry => entry.type !== 'SHOP_SELL') })
  assert.deepEqual((await shop(sale)).trade, results[0].trade)
  await assert.rejects(shop({ ...sale, quantity: 2 }), { code: 'REQUEST_ID_REUSED' })
  const two = await Promise.allSettled(['independent-1', 'independent-2'].map(requestId =>
    shop({ ...sale, requestId, cardId: 'ar_001', unitPrice: 50000 })))
  assert.equal(two.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(two.find(result => result.status === 'rejected').reason.code, 'NOT_OWNED')
  assert.equal((await shop({ op: 'list' })).profile.gold, 50800)
  assert.equal([...store.ledger.values()].filter(entry => entry.type === 'SHOP_SELL').length, 2)
})

test('旧局从扣仓流水恢复带入基准，装备只算一次，拾取和损失可跨登录恢复', async () => {
  const { service, token, edit } = await fixture()
  edit(doc => { doc.gold = 12345 })
  const start = await service.execute(token, 'start', { requestId: 'assets-legacy', mode: 'SINGLE', cardIds: ['wp_006', 'ar_001'] })
  assert.equal(start.profile.assetValue, 62345)
  assert.deepEqual(start.activeGame.backpackAssets, { initial: 50800, current: 50800, change: 0 })
  assert.ok(start.activeGame.state.items.some(item => item.cardId === 'wp_006' && item.state === 'EQUIPPED'))
  edit(doc => {
    delete doc.activeGame.initialAssets
    const game = service.restore(doc.activeGame)
    const player = game.getPlayer('P1')
    player.inventory.push(game.createItem('loot_011', null, 'IN_INVENTORY', 'P1').instanceId)
    doc.activeGame.state = game.snapshot()
  })
  const resumed = await service.login('shop-owner')
  assert.deepEqual(resumed.activeGame.backpackAssets, { initial: 50800, current: 51100, change: 300 })
  edit(doc => {
    const game = service.restore(doc.activeGame)
    const player = game.getPlayer('P1')
    game.dropItem('P1', player.equippedWeaponId)
    doc.activeGame.state = game.snapshot()
  })
  assert.deepEqual((await service.execute(resumed.token, 'resume')).activeGame.backpackAssets,
    { initial: 50800, current: 50300, change: -500 })
})

test('资产缩写支持小额和 k/m/b，变化保留正负符号及零', () => {
  assert.deepEqual([1, 999, 1000, 1100, 1000000, 1000000000].map(formatAmount), ['1', '999', '1k', '1.1k', '1m', '1b'])
  assert.deepEqual([1, 1100, -1100, 0, null].map(formatChange), ['+1', '+1.1k', '-1.1k', '0', '—'])
})
