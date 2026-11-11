const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountService, RESUME_MS } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { WechatIdentity, validateNickname, validateAvatar, fault } = require('../functions/heisino-account/wechat')
const { stackItems, quantitySlots } = require('../client/js/core/inventory')
const { LoadoutSession } = require('../client/js/core/loadout')
const cards = require('../client/data/cards')

async function fixture() {
  let now = 1000
  const store = new MemoryAccountStore()
  const identity = { exchange: async code => ({ appId: 'wx-test', openid: `openid-${code}` }), moderate: async nickname => {
    if (nickname === '拒绝昵称') throw fault('NICKNAME_REJECTED')
  } }
  const service = new AccountService({ store, identity, now: () => now })
  const login = await service.login('alice')
  const token = login.token
  const id = login.profile.accountId
  await service.execute(token, 'profile', { nickname: '测试玩家', avatarUrl: '' })
  const start = (extra = {}) => service.execute(token, 'start', { cardIds: ['wp_006', 'ar_001', 'sk_001'], requestId: 'start-0001', ...extra })
  const action = (game, name, extra = {}) => service.execute(token, 'game', {
    gameId: game.gameId, turn: game.state.turn, action: name, requestId: `${name}-${now}-${Math.random().toString(36).slice(2)}`, ...extra
  })
  const edit = async callback => {
    const document = await store.get(id)
    callback(document)
    await store.replace({ ...document, version: document.version + 1 }, document.version)
  }
  return { service, store, token, id, login, start, action, edit, advance(ms) { now += ms }, setTime(ms) { now = ms } }
}

test('微信建号只发放一次三件礼包，登录不返回身份密钥或 OpenID', async () => {
  const f = await fixture()
  const again = await f.service.login('alice')
  assert.deepEqual(again.profile.quantities, { wp_006: 1, ar_001: 1, sk_001: 1 })
  assert.equal(again.profile.gold, 0)
  assert.equal(again.profile.nickname, '测试玩家')
  assert.equal(again.profile.avatarUrl, '')
  assert.doesNotMatch(JSON.stringify(again), /openid|session_key|unionid|phone|手机号/)
  const stored = await f.store.get(f.id)
  assert.ok(stored.sessions.every(entry => !JSON.stringify(entry).includes(again.token)))
})

test('昵称格式、保留称谓和微信内容检查都在服务端执行', async () => {
  for (const bad of ['', 'a', 'abc\u200b', '<script>', 'abc\nxyz', '名'.repeat(17), '☎1234']) assert.throws(() => validateNickname(bad))
  assert.throws(() => validateNickname('管理员一号'))
  assert.equal(validateNickname(' 测试_123 '), '测试_123')
  assert.throws(() => validateAvatar('http://wx.qlogo.cn/a'))
  assert.throws(() => validateAvatar('https://wx.qlogo.cn.evil.test/a'))
  assert.throws(() => validateAvatar('https://user:pass@wx.qlogo.cn/a'))
  const f = await fixture()
  const before = await f.store.get(f.id)
  await assert.rejects(f.service.execute(f.token, 'profile', { nickname: '拒绝昵称' }), { code: 'NICKNAME_REJECTED' })
  assert.equal((await f.store.get(f.id)).nickname, before.nickname)
})

test('微信内容审核不可用时拒绝发布昵称，不降级为本地词表', async () => {
  const identity = new WechatIdentity({ secret: 'not-a-real-secret', fetch: async () => ({ ok: true, json: async () => ({ errcode: 0 }) }) })
  await assert.rejects(identity.moderate('测试玩家', 'openid-test'), { code: 'MODERATION_UNAVAILABLE' })
})

test('仅接受服务端登录态，其他玩家不能访问资产与对局', async () => {
  const f = await fixture()
  await assert.rejects(f.service.execute(`${f.id}.${'x'.repeat(43)}`, 'me'), { code: 'UNAUTHENTICATED' })
  const other = await f.service.login('bob')
  const started = await f.start()
  await assert.rejects(f.service.execute(other.token, 'game', { gameId: started.activeGame.gameId, turn: 1, action: 'move', target: { x: 1, y: 0 }, requestId: 'unauth-001' }), { code: 'NO_ACTIVE_GAME' })
})

test('战备校验数量与类别，失败请求不会扣除资产', async () => {
  const f = await fixture()
  await assert.rejects(f.start({ cardIds: ['wp_006', 'wp_006'] }), { code: 'NOT_OWNED' })
  await assert.rejects(f.start({ cardIds: ['loot_001'] }), { code: 'LOADOUT_INVALID' })
  await assert.rejects(f.start({ cardIds: ['wp_001'] }), { code: 'NOT_OWNED' })
  assert.equal((await f.service.execute(f.token, 'me')).profile.quantities.wp_006, 1)
})

test('旧账号仓库与对局恢复移除停用技能，保留其余物品和历史流水', async () => {
  const f = await fixture()
  const start = await f.start({ mode: 'SINGLE' })
  await f.edit(document => {
    document.quantities.sk_002 = 2
    document.quantities.sk_003 = 1
    document.ledger[0].quantities.sk_002 = 2
    const state = document.activeGame.state
    state.items.push({ cardId: 'sk_002', instanceId: 'retired-carried', ownerId: 'P1' },
      { cardId: 'sk_003', instanceId: 'retired-room', nodeId: 'n_0_0', state: 'DROPPED' })
    state.players[0].inventory.push('retired-carried')
    state.searchAccess.P1 = ['retired-room']
  })
  const resumed = await f.service.execute(f.token, 'resume')
  assert.equal(resumed.activeGame.gameId, start.activeGame.gameId)
  assert.deepEqual(resumed.activeGame.state.players[0].inventory, start.activeGame.state.players[0].inventory)
  assert.deepEqual(resumed.activeGame.state.items, start.activeGame.state.items)
  assert.deepEqual(resumed.profile.quantities, start.profile.quantities)
  const document = await f.store.get(f.id)
  assert.deepEqual(document.quantities, start.profile.quantities)
  assert.equal(document.ledger[0].quantities.sk_002, 2)
  assert.deepEqual(document.activeGame.state.searchAccess.P1, [])
  await assert.rejects(f.start({ cardIds: ['sk_002'], requestId: 'retired-start' }), { code: 'LOADOUT_INVALID' })
  await assert.rejects(f.start({ cardIds: ['sk_003'], requestId: 'retired-start' }), { code: 'LOADOUT_INVALID' })
})

test('重复和并发开局只扣除一次，取消前端匹配不会扣仓库', async () => {
  const f = await fixture()
  const results = await Promise.all([f.start(), f.start(), f.start()])
  assert.equal(new Set(results.map(r => r.activeGame.gameId)).size, 1)
  assert.deepEqual(results[0].profile.quantities, { wp_006: 0, ar_001: 0, sk_001: 0 })
  const document = await f.store.get(f.id)
  assert.equal(document.ledger.filter(entry => entry.type === 'DEPLOY').length, 1)
  assert.equal(f.store.ledger.size, 2)
  await assert.rejects(f.start({ cardIds: [], requestId: 'start-0001' }), { code: 'REQUEST_ID_REUSED' })
})

test('单人测试模式也扣除账号带入物，失败不损失未带入资产', async () => {
  const f = await fixture()
  const started = await f.start({ mode: 'SINGLE_TEST', cardIds: ['wp_006'] })
  const ended = await f.action(started.activeGame, 'abandon')
  assert.equal(ended.lastSettlement.success, false)
  assert.equal(ended.lastSettlement.mode, 'SINGLE_TEST')
  assert.deepEqual(ended.profile.quantities, { wp_006: 0, ar_001: 1, sk_001: 1 })
  assert.equal(ended.activeGame, null)
  const again = await f.action(started.activeGame, 'abandon')
  assert.deepEqual(again.profile.quantities, ended.profile.quantities)
  assert.equal(f.store.ledger.size, 3)
})

test('非法移动、伪造成功和客户端背包不能改变服务端结果', async () => {
  const f = await fixture()
  const started = await f.start()
  assert.equal(started.activeGame.state.items.length, 3)
  assert.equal(Object.hasOwn(started.activeGame, 'rngState'), false)
  await assert.rejects(f.action(started.activeGame, 'move', { target: { x: 4, y: 4 }, success: true, inventory: ['loot_001'] }), { code: 'NOT_ADJACENT' })
  await assert.rejects(f.action(started.activeGame, 'settle', { success: true }), { code: 'INVALID_PHASE' })
  assert.equal((await f.service.execute(f.token, 'me')).activeGame.state.phase, 'MOVE_SELECTION')
})

test('搜索曝光、拾取、丢弃和重复请求使用同一份权威物品', async () => {
  const f = await fixture()
  let response = await f.start()
  await f.edit(document => { document.activeGame.state.roomStock.seed = 0 })
  response = await f.action(response.activeGame, 'move', { target: { x: 1, y: 0 } })
  const area = response.activeGame.search.room.areas.find(entry => entry.itemCount > 0)
  response = await f.action(response.activeGame, 'observe', { areaId: area.areaId })
  assert.equal(response.activeGame.search.room.activeArea.visibleItems.length, 0)
  f.advance(499)
  response = await f.service.execute(f.token, 'heartbeat')
  assert.equal(response.activeGame.search.room.activeArea.visibleItems.length, 0)
  f.advance(1)
  response = await f.service.execute(f.token, 'heartbeat')
  const item = response.activeGame.search.room.activeArea.visibleItems[0]
  assert.ok(item)
  const game = response.activeGame
  const pickup = { instanceId: item.instanceId, requestId: 'pickup-repeat-01' }
  response = await f.action(game, 'pickup', pickup)
  response = await f.action(game, 'pickup', pickup)
  assert.equal(response.activeGame.state.players[0].inventory.length, 4)
  response = await f.action(response.activeGame, 'drop', { instanceId: item.instanceId })
  assert.equal(response.activeGame.state.players[0].inventory.length, 3)
  assert.ok(response.activeGame.search.room.activeArea.visibleItems.some(entry => entry.instanceId === item.instanceId))
})

test('单人首次进房按种子生成两件物资，重试、重连和再次进入均不补货', async () => {
  const f = await fixture()
  let { activeGame } = await f.start({ mode: 'SINGLE', cardIds: [] })
  assert.deepEqual((await f.store.get(f.id)).activeGame.state.items, [])
  assert.equal(Object.hasOwn(activeGame.state, 'roomStock'), false)

  const move = async (target, requestId) => (await f.action(activeGame, 'move', { target, requestId })).activeGame
  activeGame = await move({ x: 0, y: 0 }, 'spawn-loot')
  assert.equal(activeGame.search.room.unpickedCount, 0)
  activeGame = (await f.action(activeGame, 'leave')).activeGame
  await f.edit(document => {
    document.activeGame.state.roomStock.seed = 5
    document.activeGame.botCheckedRooms.push('n_1_0')
  })

  const firstMove = activeGame
  const target = { x: 1, y: 0 }
  activeGame = await move(target, 'room-loot-first')
  assert.equal(activeGame.search.room.unpickedCount, 2)
  assert.deepEqual(activeGame.state.items, [])
  const stored = (await f.store.get(f.id)).activeGame.state
  const original = stored.items.map(item => item.instanceId)
  assert.equal(new Set(original).size, 2)
  assert.ok(stored.items.every(item => item.nodeId === 'n_1_0'))
  await f.action(firstMove, 'move', { target, requestId: 'room-loot-first' })
  const areaId = activeGame.search.room.areas.find(area => area.itemCount > 0).areaId
  await f.action(activeGame, 'observe', { areaId })
  f.advance(2000)
  activeGame = (await f.service.execute(f.token, 'resume')).activeGame
  const { instanceId } = activeGame.search.room.activeArea.visibleItems[0]
  await f.action(activeGame, 'pickup', { instanceId })
  activeGame = (await f.action(activeGame, 'leave')).activeGame
  activeGame = await move(target, 'room-loot-return')
  assert.equal(activeGame.search.room.unpickedCount, 1)
  assert.deepEqual((await f.store.get(f.id)).activeGame.state.items.map(item => item.instanceId), original)
})

test('仓库和战备显示仍每格堆叠 99 张，超出后另开一格', () => {
  assert.deepEqual(quantitySlots({ a: 200, b: 1 }).map(slot => slot.quantity), [99, 99, 2, 1])
  const units = Array.from({ length: 100 }, (_, i) => ({ cardId: 'a', instanceId: `a${i}` }))
  assert.deepEqual(stackItems(units).map(slot => slot.quantity), [99, 1])
})

test('战备允许同卡多张，受拥有数量与四张总上限约束', () => {
  assert.equal(new LoadoutSession({ cards }).snapshot().ownedCardIds.length, 0)
  const loadout = new LoadoutSession({ cards, quantities: { wp_006: 3, ar_001: 1 } })
  assert.equal(loadout.add('wp_006').ok, true)
  assert.equal(loadout.add('wp_006').ok, true)
  assert.equal(loadout.add('wp_006').ok, true)
  assert.equal(loadout.add('wp_006').reason, 'NOT_OWNED')
  assert.equal(loadout.add('ar_001').ok, true)
  loadout.remove('wp_006')
  assert.equal(loadout.snapshot().selectedCardIds.filter(id => id === 'wp_006').length, 2)
})

test('中断不足十分钟恢复同一对局，超过十分钟失败且不返仓', async () => {
  const f = await fixture()
  const first = await f.start({ cardIds: ['wp_006'] })
  await f.service.execute(f.token, 'suspend')
  f.advance(RESUME_MS - 1)
  const resumed = await f.service.execute(f.token, 'resume')
  assert.equal(resumed.activeGame.gameId, first.activeGame.gameId)
  assert.equal(resumed.activeGame.state.turn, 1)
  assert.equal(resumed.activeGame.state.moveDeadlineAt - resumed.serverNow, 15000)
  f.advance(RESUME_MS)
  const expired = await f.service.execute(f.token, 'resume')
  assert.equal(expired.activeGame, null)
  assert.equal(expired.lastSettlement.status, 'DISCONNECTED')
  assert.deepEqual(expired.profile.quantities, { wp_006: 0, ar_001: 1, sk_001: 1 })
})

test('搜索中重启后恢复区域和已曝光物品，并暂停离线曝光进度', async () => {
  const f = await fixture()
  let response = await f.start()
  await f.edit(document => { document.activeGame.state.roomStock.seed = 0 })
  response = await f.action(response.activeGame, 'move', { target: { x: 1, y: 0 } })
  const area = response.activeGame.search.room.areas.find(entry => entry.itemCount > 0)
  response = await f.action(response.activeGame, 'observe', { areaId: area.areaId })
  f.advance(2000)
  response = await f.service.execute(f.token, 'heartbeat')
  const visible = response.activeGame.search.room.activeArea.visibleItems.length
  await f.service.execute(f.token, 'suspend')
  f.advance(120000)
  const login = await f.service.login('alice')
  assert.equal(login.activeGame.search.room.activeArea.areaId, area.areaId)
  assert.equal(login.activeGame.search.room.activeArea.visibleItems.length, visible)
})

test('撤离返仓来自服务端物品，展示价值不发金币，重复结算不重复发奖', async () => {
  const f = await fixture()
  let response = await f.start()
  // Arrange a server-owned endgame snapshot; no client API accepts these fields.
  await f.edit(document => {
    const game = document.activeGame
    const engine = f.service.restore(game)
    engine.getPlayer('P1').position = { x: 4, y: 4 }
    engine.phase = 'SEARCH'
    const loot = engine.createItem('loot_001', null, 'IN_INVENTORY', 'P1')
    engine.getPlayer('P1').inventory.push(loot.instanceId)
    game.state = engine.snapshot()
    game.visit = { visitId: 'exit', deadlineAt: 51000, roomNodeId: 'n_4_4', turn: 1, status: 'ACTIVE', observation: null }
  })
  response = await f.service.execute(f.token, 'resume')
  const game = response.activeGame
  response = await f.action(game, 'extract')
  assert.equal(response.lastSettlement.success, true)
  assert.deepEqual(response.profile.quantities, { wp_006: 1, ar_001: 1, sk_001: 1, loot_001: 1 })
  assert.equal(response.profile.gold, 0)
  const duplicate = await f.action(game, 'extract')
  assert.deepEqual(duplicate.profile.quantities, response.profile.quantities)
  assert.equal((await f.store.get(f.id)).ledger.filter(entry => entry.type === 'SETTLEMENT').length, 1)
})

test('重复离开不跨过两轮，回合超时由服务端推进', async () => {
  const f = await fixture()
  let response = await f.start()
  response = await f.action(response.activeGame, 'move', { target: { x: 0, y: 0 } })
  const game = response.activeGame
  const first = await f.action(game, 'leave', { requestId: 'leave-repeat-01' })
  const duplicate = await f.action(game, 'leave', { requestId: 'leave-repeat-01' })
  assert.equal(first.activeGame.state.turn, 2)
  assert.equal(duplicate.activeGame.state.turn, 2)
  f.advance(15000)
  const timeout = await f.service.execute(f.token, 'heartbeat')
  assert.equal(timeout.activeGame.state.phase, 'SEARCH')
})

test('微信审核凭证失效时拒绝本次提交，下次重试会获取新凭证', async () => {
  let refreshes = 0
  const checkedTokens = []
  const identity = new WechatIdentity({ secret: 'test-only', fetch: async url => {
    if (url.pathname === '/cgi-bin/stable_token') {
      refreshes += 1
      return { ok: true, json: async () => ({ access_token: `token-${refreshes}`, expires_in: 7200 }) }
    }
    const token = url.searchParams.get('access_token')
    checkedTokens.push(token)
    return { ok: true, json: async () => token === 'token-1' ? { errcode: 42001 } : { errcode: 0, result: { suggest: 'pass' } } }
  } })
  await assert.rejects(identity.moderate('测试玩家', 'fake-openid'), { code: 'MODERATION_UNAVAILABLE' })
  assert.equal(await identity.moderate('测试玩家', 'fake-openid'), true)
  assert.equal(await identity.moderate('测试玩家', 'fake-openid'), true)
  assert.equal(refreshes, 2)
  assert.deepEqual(checkedTokens, ['token-1', 'token-2', 'token-2'])
})
