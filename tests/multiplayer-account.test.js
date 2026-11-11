const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountService, RESUME_MS } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { constants: C, cards } = require('../functions/heisino-account/runtime')

async function fixture(size = 3) {
  const store = new MemoryAccountStore()
  let now = 2000000
  let sequence = 0
  const service = new AccountService({ store, now: () => now, identity: {
    exchange: async code => ({ appId: 'mode-tests', openid: code }), moderate: async () => {}
  } })
  const players = await Promise.all(Array.from({ length: size }, async (_, index) => {
    const login = await service.login(`player-${index}`)
    await service.execute(login.token, 'profile', { nickname: `玩家${index + 1}` })
    return { token: login.token, id: login.profile.accountId }
  }))
  const command = (index, action, input) => service.execute(players[index].token, action, input)
  const lobby = (index, op, data = {}) => command(index, 'lobby', { op, combatVersion: 1, requestId: `lobby-test-${++sequence}`, ...data })
  const game = (index, roomId, turn, action, data = {}) => command(index, 'game', { gameId: roomId, turn, action, requestId: `game-test-${++sequence}`, ...data })
  const create = (index = 0, cardIds = ['wp_006']) => lobby(index, 'create', { cardIds })
  const join = (index, roomId, cardIds = ['wp_006']) => lobby(index, 'join', { roomId, cardIds })
  async function startRoom(count = size, cardIds) {
    const { lobbyRoom: { roomId } } = await create(0, cardIds)
    for (let index = 1; index < count; index++) await join(index, roomId, cardIds)
    await lobby(0, 'start', { roomId })
    store.rooms.get(roomId).game.rngState = 344 // Keep unrelated movement tests on the search path.
    return roomId
  }
  return { store, players, command, lobby, game, create, join, startRoom, tick: ms => { now += ms } }
}

test('码头房间并发抢位、开局权限与等待期资产', async () => {
  const f = await fixture(4)
  const created = await f.create()
  const roomId = created.lobbyRoom.roomId
  assert.equal(created.lobbyRoom.name, '玩家1的房间')
  await assert.rejects(f.lobby(0, 'start', { roomId }), { code: 'NOT_ENOUGH_PLAYERS' })
  await f.join(1, roomId)
  const race = await Promise.allSettled([f.join(2, roomId), f.join(3, roomId)])
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(race.find(result => result.status === 'rejected').reason.code, 'ROOM_FULL')
  await assert.rejects(f.lobby(1, 'start', { roomId }), { code: 'HOST_REQUIRED' })
  const waiting = await f.lobby(1, 'list')
  assert.equal(waiting.rooms[0].playerCount, 3)
  assert.equal(waiting.profile.quantities.wp_006, 1)

  const start = () => f.lobby(0, 'start', { roomId, requestId: 'same-start-001' })
  const [host, retry] = await Promise.all([start(), start()])
  assert.equal(host.activeGame.gameId, roomId)
  assert.equal(retry.activeGame.gameId, roomId)
  assert.equal(host.activeGame.state.players.length, 3)
  assert.equal(host.profile.quantities.wp_006, 0)
  const guest = await f.command(1, 'resume')
  assert.equal(guest.activeGame.gameId, roomId)
  assert.equal(guest.activeGame.state.players.find(player => player.id === 'P1').name, '玩家2')
  assert.equal(guest.activeGame.state.players.find(player => player.id !== 'P1').inventory.length, 0)
  assert.equal([...f.store.ledger.values()].filter(entry => entry.type === 'DEPLOY').length, 3)
  const outsider = race[0].status === 'rejected' ? 2 : 3
  assert.equal((await f.lobby(outsider, 'list')).rooms[0].status, 'PLAYING')
  await assert.rejects(f.join(outsider, roomId), { code: 'ROOM_IN_GAME' })
  await assert.rejects(f.game(outsider, roomId, 1, 'move', { target: { x: 0, y: 0 } }), { code: 'NO_ACTIVE_GAME' })
})

test('退出房主转让、空房关闭、过期房间消失，均不扣仓', async () => {
  const f = await fixture(3)
  const { lobbyRoom: { roomId } } = await f.create()
  await f.join(1, roomId)
  f.tick(50)
  const other = await f.create(2)
  assert.deepEqual((await f.lobby(1, 'list')).rooms.map(room => room.roomId), [roomId, other.lobbyRoom.roomId])
  await f.lobby(0, 'leave', { roomId })
  assert.equal((await f.command(1, 'resume')).lobbyRoom.isHost, true)
  assert.equal((await f.lobby(1, 'list')).lobbyRoom.name, '玩家2的房间')
  await f.lobby(1, 'leave', { roomId })
  assert.equal((await f.lobby(0, 'list')).rooms.some(room => room.roomId === roomId), false)
  f.tick(RESUME_MS)
  assert.deepEqual((await f.lobby(0, 'list')).rooms, [])
  assert.equal((await f.command(2, 'resume')).lobbyRoom, null)
  assert.equal([...f.store.ledger.values()].some(entry => entry.type === 'DEPLOY'), false)
})

test('多人开局时一人的战备失效，整个开局事务回滚', async () => {
  const f = await fixture(2)
  const { lobbyRoom: { roomId } } = await f.create()
  await f.join(1, roomId)
  const guest = await f.store.get(f.players[1].id)
  guest.quantities.wp_006 = 0
  guest.version += 1
  await f.store.replace(guest, guest.version - 1)
  await assert.rejects(f.lobby(0, 'start', { roomId }), { code: 'NOT_OWNED' })
  const host = await f.lobby(0, 'list')
  assert.equal(host.lobbyRoom.playerCount, 2)
  assert.equal(host.activeGame, null)
  assert.equal(host.profile.quantities.wp_006, 1)
  assert.equal([...f.store.ledger.values()].some(entry => entry.type === 'DEPLOY'), false)
})

test('发布前已加入的多人房可开局，停用卡不带入也不扣除其他仓库资产', async () => {
  const f = await fixture(2)
  const { lobbyRoom: { roomId } } = await f.create()
  await assert.rejects(f.join(1, roomId, ['sk_003']), { code: 'LOADOUT_INVALID' })
  await f.join(1, roomId)
  await f.store.transactRoom(async tx => {
    const room = await tx.room(roomId)
    room.members[1].cardIds.push('sk_003')
    tx.saveRoom(room)
    const account = await tx.account(f.players[1].id)
    account.quantities.sk_003 = 2
    tx.saveAccount(account)
  })
  await f.lobby(0, 'start', { roomId })
  const guest = await f.command(1, 'resume')
  assert.equal(guest.activeGame.gameId, roomId)
  assert.deepEqual(guest.activeGame.state.items.map(item => item.cardId), ['wp_006'])
  assert.deepEqual(guest.profile.quantities, { wp_006: 0, ar_001: 1, sk_001: 1 })
  const deploy = [...f.store.ledger.values()].find(entry => entry.type === 'DEPLOY' && entry.accountId === f.players[1].id)
  assert.deepEqual(deploy.quantities, { wp_006: -1 })
})

test('共享回合按所有真人完成或超时推进，一人掉线不阻塞且可恢复', async () => {
  const f = await fixture(2)
  const roomId = await f.startRoom()
  const first = await f.game(0, roomId, 1, 'move', { target: { x: 1, y: 0 } })
  assert.equal(first.activeGame.waiting, 'MOVES')
  assert.equal((await f.command(1, 'heartbeat')).activeGame.waiting, null)
  await assert.rejects(f.game(0, roomId, 1, 'move', { target: { x: 0, y: 0 } }), { code: 'MOVE_ALREADY_SUBMITTED' })
  f.tick(C.MOVE_SELECTION_MS)
  const entered = await f.command(0, 'heartbeat')
  assert.equal(entered.activeGame.search.visit.roomNodeId, 'n_1_0')
  const done = await f.game(0, roomId, 1, 'leave')
  assert.equal(done.activeGame.waiting, 'ROUND')
  f.tick(C.SEARCH_DURATION_MS)
  const next = await f.command(0, 'heartbeat')
  assert.equal(next.activeGame.state.turn, 2)
  const recovered = await f.command(1, 'resume')
  assert.equal(recovered.activeGame.gameId, roomId)
  assert.equal(recovered.activeGame.state.turn, 2)
  assert.deepEqual(recovered.activeGame.state.players.find(player => player.id === 'P1').position, { x: 0, y: 4 })
})

test('多人移动区分真正的重复提交与截止后原地停留，已成功的请求可重试', async () => {
  const f = await fixture(2)
  const roomId = await f.startRoom()
  const accepted = { target: { x: 1, y: 0 }, requestId: 'move-before-deadline' }
  f.tick(C.MOVE_SELECTION_MS - 1)
  await f.game(0, roomId, 1, 'move', accepted)
  await assert.rejects(f.game(0, roomId, 1, 'move', { target: { x: 0, y: 0 } }), { code: 'MOVE_ALREADY_SUBMITTED' })
  f.tick(1)
  await assert.rejects(f.game(1, roomId, 1, 'move', { target: { x: 1, y: 4 } }), { code: 'MOVE_DEADLINE_EXCEEDED' })
  assert.equal((await f.game(0, roomId, 1, 'move', accepted)).activeGame.search.visit.roomNodeId, 'n_1_0')
  assert.equal((await f.command(1, 'resume')).activeGame.search.visit.roomNodeId, 'n_0_4')
})

test('多人回放共享时刻和权威轨迹，期间禁止搜索，缺少回放能力标记时可立即进房', async () => {
  for (const guestSupportsReplay of [true, false]) {
    const f = await fixture(2)
    const { lobbyRoom: { roomId } } = await f.lobby(0, 'create', { cardIds: [], movementReplay: true })
    await f.lobby(1, 'join', { roomId, cardIds: [], movementReplay: guestSupportsReplay })
    await f.lobby(0, 'start', { roomId })
    f.store.rooms.get(roomId).game.rngState = 344
    const first = await f.game(0, roomId, 1, 'move', { target: { x: 1, y: 0 } })
    assert.equal(first.activeGame.movementReplay, null)
    assert.ok(first.activeGame.state.players.slice(1).every(player => !player.position))
    const second = await f.game(1, roomId, 1, 'move', { target: { x: 0, y: 4 } })
    const replay = second.activeGame.movementReplay
    if (guestSupportsReplay) {
      assert.equal(replay.endsAt - replay.startedAt, C.MOVEMENT_REPLAY_MS)
      assert.equal(replay.startedAt - second.serverNow, C.MOVEMENT_REPLAY_LEAD_MS)
      assert.deepEqual(replay.tracks.map(({ from, to, isSelf }) => ({ from, to, isSelf })), [
        { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, isSelf: false },
        { from: { x: 0, y: 4 }, to: { x: 0, y: 4 }, isSelf: true }
      ])
      const hostReplay = (await f.command(0, 'resume')).activeGame.movementReplay
      assert.equal(hostReplay.endsAt, replay.endsAt)
      assert.equal(hostReplay.tracks[0].isSelf, true)
      assert.equal(second.activeGame.search.visit.startedAt, replay.endsAt)
      assert.equal(second.activeGame.search.visit.deadlineAt - replay.endsAt, C.SEARCH_DURATION_MS)
      f.tick(C.MOVEMENT_REPLAY_LEAD_MS + C.MOVEMENT_REPLAY_MS - 1)
      await assert.rejects(f.game(0, roomId, 1, 'leave'), { code: 'INVALID_PHASE' })
      await assert.rejects(f.game(0, roomId, 1, 'observe', { areaId: 'MAIN_TABLE' }), { code: 'INVALID_PHASE' })
      f.tick(1)
      assert.equal((await f.command(0, 'resume')).activeGame.movementReplay, null)
    } else assert.equal(replay, null)
    await f.game(0, roomId, 1, 'observe', { areaId: 'MAIN_TABLE' })
    await f.game(0, roomId, 1, 'leave')
    const next = await f.game(1, roomId, 1, 'leave')
    assert.equal(next.activeGame.movementReplay, null)
    assert.equal(next.activeGame.state.turn, 2)
  }
})

test('多人房间超过12回合后仍可移动，并按存活玩家活跃时间显示', async () => {
  const f = await fixture(3)
  const roomId = await f.startRoom(2)
  const room = f.store.rooms.get(roomId)
  room.game.state.turn = 12
  room.listUntil = 0
  assert.ok(!(await f.lobby(2, 'list')).rooms.some(entry => entry.roomId === roomId))
  await f.game(0, roomId, 12, 'move', { target: { x: 1, y: 0 } })
  await f.game(1, roomId, 12, 'move', { target: { x: 1, y: 4 } })
  await f.game(0, roomId, 12, 'leave')
  const { activeGame, lastSettlement, serverNow } = await f.game(1, roomId, 12, 'leave')
  assert.equal(lastSettlement, null)
  assert.equal(activeGame.state.turn, 13)
  assert.equal(activeGame.state.players.find(player => player.id === 'P1').hp, 25)
  assert.equal((await f.lobby(2, 'list')).rooms.find(entry => entry.roomId === roomId).status, 'PLAYING')
  assert.equal(f.store.rooms.get(roomId).listUntil, serverNow + RESUME_MS)
  assert.equal((await f.game(1, roomId, 13, 'move', { target: { x: 2, y: 4 } })).activeGame.waiting, 'MOVES')
})

test('多人守卫在30%边界判定，只对独自移动到合格房间的玩家生效', async () => {
  const below = 1079363809 // Next random value is the last possible value below 30%.
  const above = 1060512166
  const cases = [
    { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, seed: below, guard: true },
    { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, seed: above, guard: false },
    { from: { x: 1, y: 0 }, to: { x: 1, y: 0 }, seed: below, guard: false, skipRoll: true },
    { from: { x: 1, y: 0 }, to: { x: 0, y: 0 }, seed: below, guard: false, skipRoll: true },
    { from: { x: 4, y: 3 }, to: { x: 4, y: 4 }, seed: below, guard: false, skipRoll: true },
    { from: { x: 1, y: 2 }, to: { x: 2, y: 2 }, seed: below, guard: true, turn: 6 }
  ]
  for (const { from, to, seed, guard, skipRoll, turn = 1 } of cases) {
    const f = await fixture(2)
    const roomId = await f.startRoom()
    const { game } = f.store.rooms.get(roomId)
    game.rngState = seed
    game.state.turn = turn
    game.state.players[0].position = from
    await f.game(1, roomId, turn, 'move', { target: { x: 0, y: 4 } })
    const { activeGame } = await f.game(0, roomId, turn, 'move', { target: to })
    assert.equal(Boolean(activeGame.combat?.opponent.isBot), guard)
    assert.equal(Boolean(activeGame.search), !guard)
    if (skipRoll) assert.equal(f.store.rooms.get(roomId).game.rngState, seed)
  }
})

test('同轮的两场守卫战及另一人的搜索互不干扰，重连、放弃和守卫掉落独立结算', async () => {
  const f = await fixture()
  const roomId = await f.startRoom()
  f.store.rooms.get(roomId).game.rngState = 0 // The first two rolls hit, the third misses.
  const targets = [{ x: 1, y: 0 }, { x: 1, y: 4 }, { x: 3, y: 0 }]
  for (const [i, target] of targets.entries()) await f.game(i, roomId, 1, 'move', { target })
  const views = await Promise.all(targets.map((_, i) => f.command(i, 'resume')))
  const [first, second, searcher] = views.map(response => response.activeGame)
  for (const view of [first, second]) {
    assert.equal(view.combat.opponent.hp, 30)
    assert.equal(view.combat.opponent.isBot, true)
    assert.equal(view.combat.opponent.armorId, 'ar_013')
    assert.equal(view.search, null)
    assert.equal(view.state.players.length, 3)
  }
  assert.notEqual(first.combat.nodeId, second.combat.nodeId)
  assert.equal(searcher.combat, null)
  assert.equal(searcher.search.visit.roomNodeId, 'n_3_0')
  const room = f.store.rooms.get(roomId)
  assert.equal(room.playerCount, 3)
  assert.deepEqual(Object.keys(room.game.seen), ['P1', 'P2', 'P3'])
  assert.equal((await f.command(0, 'resume')).activeGame.combat.deadlineAt, first.combat.deadlineAt)
  assert.equal((await f.game(1, roomId, 1, 'abandon')).lastSettlement.status, 'ABANDONED')
  assert.equal((await f.command(0, 'heartbeat')).activeGame.combat.stage, 'PLAY')
  await f.game(2, roomId, 1, 'leave')

  const { game } = f.store.rooms.get(roomId)
  game.state.players.find(player => player.id === game.guardCombats.P1.playerIds[1]).hp = 1
  await f.game(0, roomId, 1, 'combat-roll', { subRound: 1 })
  const hit = await f.game(0, roomId, 1, 'combat-ready', { subRound: 1, zones: ['ATTACK', 'ATTACK', 'ATTACK'] })
  assert.deepEqual(hit.activeGame.combat.opponent.dice.map(die => die.zone).sort(), ['ATTACK', 'DEFENSE'])
  assert.equal(hit.activeGame.combat.opponent.hp, 0)
  f.tick(4000)
  const loot = (await f.game(0, roomId, 1, 'observe', { areaId: 'MAIN_TABLE' })).activeGame.search
  assert.equal(loot.visit.kind, 'LOOT')
  assert.equal(loot.visit.deadlineAt - loot.visit.startedAt, 20000)
  const shield = loot.room.activeArea.visibleItems.find(item => item.cardId === 'ar_013')
  assert.ok(shield)
  await f.game(0, roomId, 1, 'pickup', { instanceId: shield.instanceId })
  const next = (await f.game(0, roomId, 1, 'leave')).activeGame
  assert.equal(next.state.turn, 2)
  assert.equal(next.state.phase, 'MOVE_SELECTION')
  assert.equal(f.store.rooms.get(roomId).playerCount, 2)
  assert.ok(f.store.rooms.get(roomId).game.state.players.every(player => !player.isBot))
  assert.equal((await f.command(2, 'resume')).activeGame.state.turn, 2)
})

test('真人战斗可与守卫战并行，同房轮空者不会遇到守卫', async () => {
  for (const together of [false, true]) {
    const f = await fixture()
    const roomId = await f.startRoom()
    const { game } = f.store.rooms.get(roomId)
    game.rngState = 0
    const shared = { x: 1, y: 0 }
    game.state.players[1].position = { x: 2, y: 0 }
    if (together) game.state.players[2].position = { x: 1, y: 1 }
    const targets = [shared, shared, together ? shared : { x: 3, y: 0 }]
    for (const [i, target] of targets.entries()) await f.game(i, roomId, 1, 'move', { target })
    const persisted = f.store.rooms.get(roomId).game
    assert.equal(persisted.combat.playerIds.length, 2)
    if (together) {
      assert.deepEqual(persisted.guardCombats, {})
      const bystander = [0, 1, 2].find(i => !persisted.combat.playerIds.includes(`P${i + 1}`))
      assert.ok((await f.command(bystander, 'resume')).activeGame.search)
    } else {
      const pvp = (await f.command(0, 'resume')).activeGame.combat
      const guard = (await f.command(2, 'resume')).activeGame.combat
      assert.equal(pvp.opponent.isBot, false)
      assert.equal(guard.opponent.isBot, true)
      f.tick(15000)
      assert.deepEqual((await f.command(0, 'heartbeat')).activeGame.combat.opponent.dice, [])
      const impact = (await f.command(2, 'resume')).activeGame.combat
      assert.equal(impact.stage, 'IMPACT')
      assert.deepEqual(impact.opponent.dice.map(die => die.zone).sort(), ['ATTACK', 'DEFENSE'])
    }
  }
})

test('守卫战玩家掉线到期后只结算本人，其他玩家可继续换轮', async () => {
  const f = await fixture(2)
  const roomId = await f.startRoom()
  f.store.rooms.get(roomId).game.rngState = 0
  await f.game(0, roomId, 1, 'move', { target: { x: 1, y: 0 } })
  await f.game(1, roomId, 1, 'move', { target: { x: 0, y: 4 } })
  assert.equal((await f.game(1, roomId, 1, 'leave')).activeGame.waiting, 'ROUND')
  const { game } = f.store.rooms.get(roomId)
  const deadline = game.guardCombats.P1.deadlineAt
  game.seen.P1 = deadline - RESUME_MS
  f.tick(15000)
  assert.equal((await f.command(0, 'resume')).lastSettlement.status, 'DISCONNECTED')
  f.tick(2000)
  const next = await f.command(1, 'heartbeat')
  assert.equal(next.activeGame.state.turn, 2)
  assert.equal(next.activeGame.state.players.find(player => player.id === 'P1').hp, 30)
  assert.equal(f.store.rooms.get(roomId).playerCount, 1)
})

test('已开局的旧版三人对局可继续分流和拾取，同一张卡只能入一人的背包一次', async () => {
  const f = await fixture()
  const roomId = await f.startRoom()
  const room = f.store.rooms.get(roomId)
  delete room.game.combatVersion
  room.game.state.roomStock.seed = 6
  room.game.state.players.forEach((player, index) => { player.position = [{ x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }][index] })
  const move = index => f.game(index, roomId, 1, 'move', { target: { x: 1, y: 1 } })
  await Promise.all([move(0), move(1), move(2)])
  const synced = await Promise.all(f.players.map((_, index) => f.command(index, 'heartbeat')))
  const survivors = synced.map((state, index) => state.activeGame ? index : -1).filter(index => index >= 0)
  assert.equal(survivors.length, 2)
  assert.equal(synced.find(state => !state.activeGame).lastSettlement.status, 'DEFEATED')
  const engine = f.store.rooms.get(roomId).game.state
  assert.deepEqual(engine.roomStock.visited, ['n_1_1'])
  assert.equal(engine.items.filter(item => item.nodeId === 'n_1_1' && item.state === 'HIDDEN').length, 3)
  const [first, other] = survivors.map(index => engine.searchAccess[`P${index + 1}`])
  assert.ok(first.length > 0 && other.length > 0)
  assert.equal(first.some(id => other.includes(id)), false)
  const item = engine.items.find(unit => unit.instanceId === first[0])
  const [owner, guest] = survivors
  await Promise.all(survivors.map(index => f.game(index, roomId, 1, 'observe', { areaId: item.areaId })))
  f.tick(C.SEARCH_REVEAL_INTERVAL_MS * 5)
  const pickup = index => f.game(index, roomId, 1, 'pickup', { instanceId: item.instanceId })
  const race = await Promise.allSettled([pickup(owner), pickup(guest)])
  assert.equal(race[0].status, 'fulfilled')
  assert.equal(race[1].reason.code, 'ITEM_NOT_VISIBLE')
  await assert.rejects(pickup(owner), { code: 'ITEM_NOT_VISIBLE' })
  assert.equal(f.store.rooms.get(roomId).game.state.items.find(unit => unit.instanceId === item.instanceId).ownerId, `P${owner + 1}`)
})

test('一人独立撤离且返仓只发生一次，其他玩家继续对局', async () => {
  const f = await fixture(2)
  const roomId = await f.startRoom()
  f.store.rooms.get(roomId).game.state.players[0].position = { x: 4, y: 3 }
  await f.game(0, roomId, 1, 'move', { target: { x: 4, y: 4 } })
  await f.game(1, roomId, 1, 'move', { target: { x: 0, y: 4 } })
  const waiting = await f.game(0, roomId, 1, 'leave', { requestId: 'exit-leave-once' })
  assert.equal(waiting.activeGame.waiting, 'ROUND')
  const next = await f.game(1, roomId, 1, 'leave')
  assert.equal(next.activeGame.state.turn, 2)
  const extracted = await f.command(0, 'resume')
  assert.equal(extracted.activeGame, null)
  assert.equal(extracted.lastSettlement.status, 'EXTRACTED')
  assert.equal(extracted.lastSettlement.turn, 1)
  assert.equal(extracted.profile.quantities.wp_006, 1)
  await f.game(0, roomId, 1, 'leave', { requestId: 'exit-leave-once' })
  assert.equal((await f.command(0, 'me')).profile.quantities.wp_006, 1)
  assert.equal((await f.game(1, roomId, 2, 'abandon')).lastSettlement.status, 'ABANDONED')
  assert.equal([...f.store.ledger.values()].filter(entry => entry.gameId === roomId && entry.type === 'SETTLEMENT').length, 2)
})

test('多人中断超出十分钟按个人失败结算', async () => {
  const f = await fixture(2)
  const roomId = await f.startRoom()
  f.tick(RESUME_MS - 10)
  const online = await f.command(0, 'heartbeat')
  assert.equal(online.activeGame.gameId, roomId)
  f.tick(10)
  const timedOut = await f.command(1, 'resume')
  assert.equal(timedOut.lastSettlement.status, 'DISCONNECTED')
  assert.equal(timedOut.profile.quantities.wp_006, 0)
  assert.equal((await f.command(0, 'heartbeat')).activeGame.gameId, roomId)
})

test('单人守卫只判定一次，蓝色防具可拾取、撤离返仓并再次带入', async () => {
  const f = await fixture(1)
  const started = await f.command(0, 'start', { mode: 'SINGLE', cardIds: ['wp_006'], requestId: 'solo-start-01' })
  const { gameId } = started.activeGame
  assert.equal(started.activeGame.state.players.length, 1)
  assert.equal(started.profile.quantities.wp_006, 0)
  f.store.documents.get(f.players[0].id).activeGame.rngState = 0
  const room = await f.game(0, gameId, 1, 'move', { target: { x: 1, y: 0 } })
  const [battle] = room.activeGame.state.encounters.filter(event => event.type === 'BATTLE')
  assert.equal(battle.winnerId, 'P1')
  assert.equal(room.activeGame.state.players.find(player => player.isBot).diceMode, 'ATTACK')
  const drops = room.activeGame.state.items.filter(item => item.state === 'DROPPED')
  const gear = drops.map(item => cards.find(card => card.cardId === item.cardId))
  assert.deepEqual(gear.map(card => [card.category, card.rarity]), [['WEAPON', 'BLUE'], ['ARMOR', 'BLUE']])
  const shield = drops.find(item => item.cardId === 'ar_013')
  assert.ok(shield)
  const observed = await f.game(0, gameId, 1, 'observe', { areaId: shield.areaId })
  assert.ok(observed.activeGame.search.room.activeArea.visibleItems.some(item => item.instanceId === shield.instanceId))
  const picked = await f.game(0, gameId, 1, 'pickup', { instanceId: shield.instanceId })
  assert.ok(picked.activeGame.search.inventory.some(item => item.cardId === 'ar_013' && item.quantity === 1))
  await f.game(0, gameId, 1, 'leave')
  f.store.documents.get(f.players[0].id).activeGame.rngState = 0
  const stayed = await f.game(0, gameId, 2, 'move', { target: { x: 1, y: 0 } })
  assert.equal(stayed.activeGame.state.encounters.some(event => event.type === 'BATTLE'), false)
  await f.game(0, gameId, 2, 'leave')

  const exitRoute = [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 4, y: 2 }, { x: 4, y: 3 }, { x: 4, y: 4 }]
  for (const [step, target] of exitRoute.entries()) {
    const turn = step + 3
    await f.game(0, gameId, turn, 'move', { target })
    if (step < exitRoute.length - 1) await f.game(0, gameId, turn, 'leave')
  }
  const extracted = await f.game(0, gameId, 9, 'extract')
  assert.equal(extracted.lastSettlement.status, 'EXTRACTED')
  assert.equal(extracted.lastSettlement.returned.ar_013, 1)
  assert.equal(extracted.profile.quantities.ar_013, 1)
  assert.equal(extracted.profile.quantities.ar_005, undefined)
  const next = await f.command(0, 'start', { mode: 'SINGLE', cardIds: ['ar_013'], requestId: 'solo-start-02' })
  assert.equal(next.profile.quantities.ar_013, 0)
  assert.ok(next.activeGame.state.items.some(item => item.cardId === 'ar_013' && item.ownerId === 'P1'))
})
