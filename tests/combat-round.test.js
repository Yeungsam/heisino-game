const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { GameEngine, cards } = require('../functions/heisino-account/runtime')
const Battle = require('../functions/heisino-account/combat-round')

async function fixture(size) {
  let now = 1_000_000
  let serial = 0
  const store = new MemoryAccountStore()
  const service = new AccountService({ store, now: () => now, identity: {
    exchange: async openid => ({ appId: 'combat-round-test', openid }), moderate: async () => {}
  } })
  const accounts = await Promise.all(Array.from({ length: size }, async (_, i) => {
    const { token, profile } = await service.login(`player-${i}`)
    await service.execute(token, 'profile', { nickname: `玩家${i + 1}` })
    return { token, id: profile.accountId }
  }))
  const requestId = () => `combat-request-${++serial}`
  const command = (i, action, data = {}) => service.execute(accounts[i].token, action, { requestId: requestId(), ...data })
  const act = (i, gameId, turn, action, data = {}) => command(i, 'game', { gameId, turn, action, ...data })
  const soloEdit = async update => {
    const doc = await store.get(accounts[0].id)
    update(doc.activeGame, doc)
    assert.ok(await store.replace({ ...doc, version: doc.version + 1 }, doc.version))
  }
  const roomEdit = (id, update) => store.transactRoom(async tx => {
    const room = await tx.room(id)
    update(room.game)
    tx.saveRoom(room)
  })
  async function startRoom({ mixed = false, replay = false, hp = 30, withItems = true } = {}) {
    const options = { cardIds: ['wp_006', 'sk_001'], movementReplay: replay, combatVersion: 1 }
    const { lobbyRoom: { roomId } } = await command(0, 'lobby', { op: 'create', ...options })
    for (let i = 1; i < size; i++) {
      await command(i, 'lobby', { op: 'join', roomId, ...options, combatVersion: mixed && i === size - 1 ? undefined : 1 })
    }
    await command(0, 'lobby', { op: 'start', roomId })
    await roomEdit(roomId, game => {
      const engine = service.restore(game)
      for (const p of engine.players) { p.position = { x: 1, y: 0 }; p.hp = hp }
      engine.roomStock.visited.push('n_1_0')
      if (withItems) for (const id of ['loot_001', 'loot_002', 'loot_003', 'loot_004', 'loot_005']) engine.createItem(id, 'n_1_0', 'HIDDEN', null, 'MAIN_TABLE')
      game.state = engine.snapshot()
    })
    for (let i = 0; i < size; i++) await act(i, roomId, 1, 'move', { target: { x: 1, y: 0 } })
    return roomId
  }
  return { store, service, accounts, command, act, soloEdit, roomEdit, startRoom, requestId, time: () => now, advance: ms => { now += ms } }
}

test('多人手动掷骰、摆放、技能消耗及就绪由服务端校验，断线重连保留状态', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom({ replay: true })
  assert.equal((await f.command(0, 'resume')).activeGame.combat.stage, 'PENDING')
  await assert.rejects(f.act(0, gameId, 1, 'combat-roll', { subRound: 1 }), { code: 'COMBAT_CLOSED' })
  f.advance(1800)
  const ready = i => f.act(i, gameId, 1, 'combat-ready', { subRound: 1 })
  await assert.rejects(ready(0), { code: 'DICE_UNPLACED' })
  const rollInput = { subRound: 1, requestId: 'same-roll-request' }
  const roll = (await f.act(0, gameId, 1, 'combat-roll', rollInput)).activeGame.combat
  assert.equal(roll.self.dice.length, 3)
  assert.ok(roll.self.dice.every(die => die.value >= 1 && die.value <= 6 && die.zone === 'TRAY'))
  assert.deepEqual((await f.act(0, gameId, 1, 'combat-roll', rollInput)).activeGame.combat.self.dice, roll.self.dice)
  await assert.rejects(f.act(0, gameId, 1, 'combat-roll', { subRound: 1 }), { code: 'DICE_ALREADY_ROLLED' })
  await assert.rejects(f.act(0, gameId, 1, 'combat-place', { subRound: 1, dieIndex: 3, zone: 'ATTACK' }), { code: 'DICE_PLACEMENT_INVALID' })
  assert.deepEqual((await f.command(1, 'resume')).activeGame.combat.opponent.dice, [])
  const skillInput = { subRound: 1, instanceId: roll.self.skills[0].instanceId, requestId: 'same-skill-request' }
  await f.act(0, gameId, 1, 'combat-skill', skillInput)
  const retried = (await f.act(0, gameId, 1, 'combat-skill', skillInput)).activeGame.combat
  assert.deepEqual(retried.self.dice, roll.self.dice)
  assert.equal(retried.self.skills.length, 0)
  assert.equal(retried.self.skillUsed, true)
  await assert.rejects(f.act(0, gameId, 1, 'combat-skill', { ...skillInput, requestId: 'another-skill-request' }), { code: 'SKILL_ALREADY_USED' })
  await f.act(1, gameId, 1, 'combat-roll', { subRound: 1 })
  for (let i = 0; i < 2; i++) for (let dieIndex = 0; dieIndex < 3; dieIndex++) {
    await f.act(i, gameId, 1, 'combat-place', { subRound: 1, dieIndex, zone: i ? 'ATTACK' : 'DEFENSE' })
  }
  await ready(0)
  const recovered = (await f.command(0, 'resume')).activeGame.combat
  assert.equal(recovered.self.ready, true)
  assert.ok(recovered.self.dice.every(die => die.zone === 'DEFENSE'))
  await assert.rejects(f.act(0, gameId, 1, 'combat-place', { subRound: 1, dieIndex: 0, zone: 'ATTACK' }), { code: 'COMBAT_ALREADY_READY' })
  const impact = (await ready(1)).activeGame.combat
  assert.equal(impact.stage, 'IMPACT')
  assert.equal(impact.deadlineAt, f.time() + 1000)
  assert.equal(impact.opponent.dice.length, 3)
  assert.equal(impact.self.impact.defense, 0)
  assert.equal(impact.opponent.impact.attack, 0)
  f.advance(1000)
  assert.equal((await f.command(0, 'resume')).activeGame.combat.subRound, 2)
  await assert.rejects(f.act(0, gameId, 1, 'combat-roll', { subRound: 1 }), { code: 'STALE_SUB_ROUND' })
})

test('提前击倒后两秒结算再立即拾取，轮空搜索与战利品窗口权限互斥', async () => {
  const f = await fixture(3)
  const gameId = await f.startRoom({ hp: 2 })
  const combat = f.store.rooms.get(gameId).game.combat
  const winner = Number(combat.playerIds[0].slice(1)) - 1
  const loser = Number(combat.playerIds[1].slice(1)) - 1
  const bye = [0, 1, 2].find(index => ![winner, loser].includes(index))
  const start = combat.startedAt
  await f.roomEdit(gameId, game => {
    const engine = f.service.restore(game)
    const victim = engine.getPlayer(combat.playerIds[1])
    for (const id of ['loot_002', 'loot_001', 'loot_010']) victim.inventory.push(engine.createItem(id, null, 'IN_INVENTORY', victim.id).instanceId)
    game.state = engine.snapshot()
    const [attack, defend] = game.combat.playerIds.map(id => game.combat.sides[id])
    attack.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'ATTACK' }))
    defend.dice = Array.from({ length: 3 }, () => ({ value: 1, zone: 'DEFENSE' }))
  })
  await f.act(winner, gameId, 1, 'combat-ready', { subRound: 1 })
  const hit = await f.act(loser, gameId, 1, 'combat-ready', { subRound: 1 })
  assert.equal(hit.activeGame.combat.self.hp, 0)
  f.advance(1000)
  assert.equal((await f.command(winner, 'resume')).activeGame.combat.outcome, 'WIN')
  f.advance(2000)
  const observed = await f.act(winner, gameId, 1, 'observe', { areaId: 'MAIN_TABLE' })
  const loot = observed.activeGame.search
  assert.equal(loot.visit.kind, 'LOOT')
  assert.equal(loot.visit.startedAt, start + 3000)
  assert.equal(loot.visit.deadlineAt, start + 23000)
  const ids = loot.room.activeArea.visibleItems.map(item => item.instanceId)
  assert.ok(loot.room.activeArea.visibleItems.some(item => item.cardId === 'loot_002' && item.state === 'DROPPED'))
  assert.ok(loot.room.activeArea.visibleItems.some(item => item.cardId === 'loot_001' && item.state === 'DROPPED'))
  assert.equal((await f.command(loser, 'resume')).lastSettlement.status, 'DEFEATED')
  const byeView = await f.act(bye, gameId, 1, 'observe', { areaId: 'MAIN_TABLE' })
  assert.equal(byeView.activeGame.search.visit.deadlineAt, start + 50000)
  assert.deepEqual(byeView.activeGame.search.room.activeArea.visibleItems, [])
  await assert.rejects(f.act(bye, gameId, 1, 'pickup', { instanceId: ids[0] }), { code: 'ITEM_NOT_VISIBLE' })
  const waiting = (await f.act(winner, gameId, 1, 'leave')).activeGame
  assert.equal(waiting.waiting, 'ROUND')
  f.advance(4000)
  const next = (await f.act(bye, gameId, 1, 'leave')).activeGame
  assert.equal(next.state.turn, 2)
  assert.equal(next.state.moveDeadlineAt, f.time() + 15000)
  const persisted = f.store.rooms.get(gameId).game.state.items
  assert.equal(persisted.filter(item => item.state === 'DROPPED').length, 2)
  assert.equal(persisted.find(item => item.cardId === 'loot_010').state, 'DESTROYED')
})

test('真人超时不补掷不补摆，50 秒后开放拾取，70 秒时准时结束窗口', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom()
  const start = f.time()
  await f.roomEdit(gameId, game => { game.combat.sides.P1.defensePercent = 100 })
  const roll = await f.act(0, gameId, 1, 'combat-roll', { subRound: 1 })
  const lastDie = roll.activeGame.combat.self.dice[2].value
  await f.act(0, gameId, 1, 'combat-place', { subRound: 1, dieIndex: 2, zone: 'DEFENSE' })
  f.advance(15000)
  const impact = (await f.command(0, 'resume')).activeGame.combat
  assert.equal(impact.stage, 'IMPACT')
  assert.deepEqual(impact.self.dice.map(d => d.zone), ['TRAY', 'TRAY', 'DEFENSE'])
  assert.equal(impact.self.dice[2].value, lastDie)
  assert.deepEqual(impact.opponent.dice, [])
  assert.deepEqual(impact.opponent.impact, { attack: 0, defense: 0, loss: 0 })
  assert.deepEqual(impact.self.impact, { attack: 0, defense: lastDie, loss: 0 })
  f.advance(35000)
  const snapshots = await Promise.all([0, 1].map(i => f.command(i, 'resume')))
  const qualified = snapshots.findIndex(result => result.activeGame?.search?.visit.kind === 'LOOT')
  assert.ok(qualified >= 0)
  const visit = snapshots[qualified].activeGame.search.visit
  assert.equal(visit.startedAt, start + 50000)
  assert.equal(visit.deadlineAt, start + 70000)
  f.advance(20000)
  await assert.rejects(f.act(qualified, gameId, 1, 'observe', { areaId: 'MAIN_TABLE' }), { code: 'STALE_TURN' })
  const next = (await f.command(qualified, 'resume')).activeGame
  assert.equal(next.state.turn, 2)
  assert.equal(next.state.moveDeadlineAt, start + 85000)
})

test('整组摆放可独立生效，迟到旧位置不回滚，未就绪也按已摆骰子攻击', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom()
  await f.act(0, gameId, 1, 'combat-roll', { subRound: 1 })
  await f.roomEdit(gameId, game => {
    game.combat.sides.P1.attackPercent = 100
    game.combat.sides.P1.dice[0].value = 5
  })
  const latest = ['ATTACK', 'TRAY', 'TRAY']
  const place = (placementRevision, zones, requestId) => f.act(0, gameId, 1, 'combat-place', {
    subRound: 1, placementRevision, zones, ...(requestId ? { requestId } : {})
  })
  await assert.rejects(place(0, latest), { code: 'DICE_PLACEMENT_INVALID' })
  await assert.rejects(place(2, ['ATTACK', 5, 'TRAY']), { code: 'DICE_PLACEMENT_INVALID' })
  const id = 'placement-retry-test'
  await place(2, latest, id)
  await place(1, ['DEFENSE', 'TRAY', 'TRAY'])
  await place(2, latest, id)
  await assert.rejects(place(2, ['TRAY', 'TRAY', 'TRAY'], id), { code: 'REQUEST_ID_REUSED' })
  const current = (await f.command(0, 'resume')).activeGame.combat
  assert.equal(current.stage, 'PLAY')
  assert.equal(current.self.ready, false)
  assert.equal(current.self.placementRevision, 2)
  assert.deepEqual(current.self.dice.map(die => die.zone), latest)
  f.advance(15000)
  await assert.rejects(place(3, ['TRAY', 'TRAY', 'TRAY']), { code: 'COMBAT_CLOSED' })
  const impact = (await f.command(0, 'resume')).activeGame.combat
  assert.equal(impact.stage, 'IMPACT')
  assert.equal(impact.self.impact.attack, 5)
  assert.equal(impact.opponent.impact.loss, 5)
  assert.deepEqual(impact.opponent.dice, [])
})

test('就绪一次提交三颗分配：先掷骰、整组校验、不能改点数、同请求可重试', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom()
  const zones = ['ATTACK', 'DEFENSE', 'DEFENSE']
  const ready = (input = {}) => f.act(0, gameId, 1, 'combat-ready', { subRound: 1, zones, ...input })
  await assert.rejects(ready(), { code: 'DICE_UNPLACED' })
  const roll = (await f.act(0, gameId, 1, 'combat-roll', { subRound: 1 })).activeGame.combat.self.dice
  for (const invalid of [null, ['ATTACK'], ['ATTACK', 'TRAY', 'DEFENSE'], ['ATTACK', { value: 6, zone: 'ATTACK' }, 'DEFENSE']]) {
    await assert.rejects(ready({ zones: invalid }), { code: 'DICE_PLACEMENT_INVALID' })
  }
  assert.deepEqual((await f.command(0, 'resume')).activeGame.combat.self.dice, roll)
  const requestId = 'ready-all-zones'
  const self = (await ready({ requestId })).activeGame.combat.self
  assert.deepEqual(self.dice, roll.map((die, i) => ({ ...die, zone: zones[i] })))
  assert.equal(self.ready, true)
  assert.deepEqual((await ready({ requestId })).activeGame.combat.self.dice, self.dice)
  await assert.rejects(ready({ requestId, zones: zones.toReversed() }), { code: 'REQUEST_ID_REUSED' })
})

test('断线正好达到十分钟且撞上攻防截止，离线者不会再打出已摆骰子', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom({ hp: 5 })
  const start = f.time()
  await f.roomEdit(gameId, game => {
    game.seen.P2 = start - 585000
    game.combat.sides.P2.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'ATTACK' }))
    game.combat.sides.P2.readyAt = start
  })
  f.advance(14999)
  assert.equal((await f.command(0, 'heartbeat')).activeGame.combat.stage, 'PLAY')
  f.advance(1)
  const survivor = (await f.command(0, 'heartbeat')).activeGame.combat
  assert.equal(survivor.outcome, 'WIN')
  assert.equal(survivor.self.hp, 5)
  assert.equal(survivor.self.impact, null)
  const departed = (await f.command(1, 'resume')).lastSettlement
  assert.equal(departed.status, 'DISCONNECTED')
  assert.equal(departed.endedAt, start + 15000)
  f.advance(2000)
  assert.equal((await f.command(0, 'resume')).activeGame.search.visit.kind, 'LOOT')
})

test('两名参战者同时断线到期不会拖住第三名搜索者', async () => {
  const f = await fixture(3)
  const gameId = await f.startRoom()
  const { playerIds } = f.store.rooms.get(gameId).game.combat
  const bye = [0, 1, 2].find(index => !playerIds.includes(`P${index + 1}`))
  await f.roomEdit(gameId, game => { for (const id of playerIds) game.seen[id] = f.time() - 599000 })
  f.advance(1000)
  const survivor = (await f.command(bye, 'resume')).activeGame
  assert.equal(survivor.search.visit.turn, 1)
  assert.notEqual(survivor.search.visit.kind, 'LOOT')
  for (const id of playerIds) {
    assert.equal((await f.command(Number(id.slice(1)) - 1, 'resume')).lastSettlement.status, 'DISCONNECTED')
  }
  assert.equal((await f.act(bye, gameId, 1, 'leave')).activeGame.state.turn, 2)
})

test('同时归零不发战利品，主动弃权只结算一次且胜者可拾取', async () => {
  const engine = new GameEngine({ cards, rng: () => 0.99 })
  engine.start([{ id: 'P1', name: '甲', x: 1, y: 0, cardIds: ['wp_006'] }, { id: 'P2', name: '乙', x: 1, y: 0, cardIds: ['wp_006'] }])
  for (const player of engine.players) player.hp = 2
  const direct = Battle.createCombat(engine, { playerIds: ['P1', 'P2'], nodeId: 'n_1_0', itemIds: [] }, 1000)
  Battle.advanceCombat(direct, engine, 1000)
  for (const side of Object.values(direct.sides)) {
    side.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'ATTACK' }))
    side.readyAt = 16000
  }
  Battle.advanceCombat(direct, engine, 19000)
  assert.equal(direct.result.bothDown, true)
  assert.deepEqual(direct.lootPlayers, [])
  assert.deepEqual(engine.players.map(p => p.status), ['DEFEATED', 'DEFEATED'])
  assert.ok(engine.items.every(item => item.state === 'DESTROYED'))

  const f = await fixture(2)
  const gameId = await f.startRoom()
  const quit = await f.act(0, gameId, 1, 'abandon', { requestId: 'retry-forfeit' })
  assert.equal(quit.lastSettlement.status, 'ABANDONED')
  assert.equal((await f.act(0, gameId, 1, 'abandon', { requestId: 'retry-forfeit' })).lastSettlement.settlementId, quit.lastSettlement.settlementId)
  f.advance(2000)
  const search = (await f.act(1, gameId, 1, 'observe', { areaId: 'MAIN_TABLE' })).activeGame.search
  assert.equal(search.room.activeArea.visibleItems.filter(item => item.state === 'DROPPED').length, 2)
})

test('单人战斗断线跨过战利品和移动截止时自动原地，不能补交超时移动', async () => {
  const f = await fixture(1)
  const gameId = (await f.command(0, 'start', { mode: 'SINGLE', combatVersion: 1, cardIds: ['wp_006'] })).activeGame.gameId
  await f.soloEdit(game => { game.rngState = 0 })
  await f.act(0, gameId, 1, 'move', { target: { x: 1, y: 0 } })
  await f.soloEdit(game => {
    game.state.players[1].hp = 1
    game.combat.sides.P1.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'ATTACK' }))
    game.combat.sides.P1.readyAt = f.time() + 15000
    game.combat.sides.P2.dice = [{ value: 1, zone: 'ATTACK' }, { value: 1, zone: 'DEFENSE' }, { value: 1, zone: 'DEFENSE' }]
  })
  await f.command(0, 'suspend')
  f.advance(100000)
  await assert.rejects(f.act(0, gameId, 2, 'move', { target: { x: 0, y: 0 } }), { code: 'MOVE_DEADLINE_EXCEEDED' })
  const { activeGame, serverNow } = await f.command(0, 'resume')
  assert.equal(activeGame.state.turn, 2)
  assert.equal(activeGame.state.phase, 'SEARCH')
  assert.deepEqual(activeGame.state.players[0].position, { x: 1, y: 0 })
  assert.ok((activeGame.combat?.deadlineAt ?? activeGame.search.visit.deadlineAt) > serverNow)
})

test('存活败者只损失最高两件且同价按背包顺序，平局对奇数原生物资只分配一次', () => {
  const engine = new GameEngine({ cards, rng: () => 0.99 })
  const participants = [
    { id: 'P1', name: '甲', x: 1, y: 0, cardIds: ['wp_006'] },
    { id: 'P2', name: '乙', x: 1, y: 0, cardIds: ['ar_002', 'ar_005', 'sk_001'] }
  ]
  engine.start(participants)
  engine.getPlayer('P2').hp = 10
  const won = Battle.createCombat(engine, { playerIds: ['P1', 'P2'], nodeId: 'n_1_0', itemIds: [] }, 1000)
  assert.equal(won.sides.P1.defensePercent, 15)
  assert.equal(won.sides.P2.attackPercent, 20)
  assert.equal(won.sides.P2.defensePercent, 80)
  const firstLoot = engine.createItem('loot_019', null, 'IN_INVENTORY', 'P2')
  engine.getPlayer('P2').inventory.push(firstLoot.instanceId)
  for (let round = 1; round <= 3; round++) {
    const at = 1000 + (round - 1) * 1000
    Battle.advanceCombat(won, engine, at)
    for (const side of Object.values(won.sides)) {
      side.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'DEFENSE' }))
      side.readyAt = at
    }
    Battle.advanceCombat(won, engine, at)
  }
  Battle.advanceCombat(won, engine, 6000)
  assert.equal(won.result.winnerId, 'P1')
  assert.equal(engine.getPlayer('P2').hp, 10)
  assert.equal(engine.getPlayer('P2').status, 'ACTIVE')
  assert.deepEqual(engine.searchItemsFor('P1').map(item => item.cardId), ['loot_019', 'ar_002'])
  assert.deepEqual(engine.getPlayer('P2').inventory.map(id => engine.items.find(item => item.instanceId === id).cardId), ['ar_005', 'sk_001'])

  engine.start(participants.map(player => ({ ...player, cardIds: [] })))
  const items = Array.from({ length: 5 }, () => engine.createItem('loot_015', 'n_1_0', 'HIDDEN'))
  const draw = Battle.createCombat(engine, { playerIds: ['P1', 'P2'], nodeId: 'n_1_0', itemIds: items.map(item => item.instanceId) }, 1000)
  Battle.advanceCombat(draw, engine, 51000)
  assert.equal(draw.result.winnerId, null)
  assert.equal(draw.result.bothDown, false)
  assert.deepEqual(draw.lootPlayers, ['P1', 'P2'])
  const shares = Object.values(engine.searchAccess)
  assert.deepEqual(shares.map(share => share.length).sort(), [2, 3])
  assert.equal(new Set(shares.flat()).size, 5)
})

test('守卫获胜没收最高两件，存活玩家保留其余资产并继续', () => {
  const engine = new GameEngine({ cards, rng: () => 0.99 })
  engine.start([
    { id: 'P1', name: '玩家', x: 1, y: 0, cardIds: ['wp_006', 'sk_001'] },
    { id: 'P2', name: '赌场守卫', x: 1, y: 0, cardIds: ['wp_004', 'ar_013'] }
  ])
  const player = engine.getPlayer('P1')
  const guard = engine.getPlayer('P2')
  guard.isBot = true
  player.inventory.push(engine.createItem('loot_023', null, 'IN_INVENTORY', player.id).instanceId)
  const roomItem = engine.createItem('loot_015', 'n_1_0', 'HIDDEN')
  const combat = Battle.createCombat(engine, { playerIds: [player.id, guard.id], nodeId: 'n_1_0', itemIds: [roomItem.instanceId] }, 1000)
  for (let round = 0; round < 3; round++) {
    const at = 1000 + round * 1000
    Battle.advanceCombat(combat, engine, at)
    combat.sides.P1.dice = Array.from({ length: 3 }, () => ({ value: 1, zone: 'DEFENSE' }))
    combat.sides.P1.readyAt = at
    Battle.advanceCombat(combat, engine, at)
  }
  Battle.advanceCombat(combat, engine, 6000)
  assert.equal(combat.result.winnerId, guard.id)
  assert.equal(player.status, 'ACTIVE')
  assert.ok(player.hp > 0 && player.hp < 30)
  assert.equal(guard.status, 'DEPARTED')
  assert.deepEqual(combat.lootPlayers, [])
  assert.deepEqual(player.inventory.map(id => engine.items.find(item => item.instanceId === id).cardId), ['sk_001'])
  assert.equal(roomItem.state, 'HIDDEN')
  assert.equal(engine.droppedItemsAt('n_1_0').length, 0)
})

test('单人原地停留重新判定满血守卫，守卫固定一攻两防，拾取同类装备前须先丢旧装备', async () => {
  const f = await fixture(1)
  await assert.rejects(f.command(0, 'start', { mode: 'SINGLE', combatVersion: 1, cardIds: ['wp_006', 'wp_005'] }), { code: 'WEAPON_LIMIT' })
  const gameId = (await f.command(0, 'start', { mode: 'SINGLE', combatVersion: 1, cardIds: ['wp_006'] })).activeGame.gameId
  await f.soloEdit(game => { game.rngState = 0 })
  const first = (await f.act(0, gameId, 1, 'move', { target: { x: 1, y: 0 } })).activeGame
  assert.equal(first.combat.opponent.hp, 30)
  assert.equal(first.combat.opponent.isBot, true)
  assert.equal(first.combat.opponent.ready, true)
  const persistedGuard = (await f.store.get(f.accounts[0].id)).activeGame.combat.sides.P2
  assert.equal(persistedGuard.dice.filter(d => d.zone === 'ATTACK').length, 1)
  assert.equal(persistedGuard.dice.filter(d => d.zone === 'DEFENSE').length, 2)
  await f.soloEdit(game => {
    game.state.players[1].hp = 1
    game.combat.sides.P1.dice = Array.from({ length: 3 }, () => ({ value: 6, zone: 'ATTACK' }))
    game.combat.sides.P2.dice = [{ value: 1, zone: 'ATTACK' }, { value: 1, zone: 'DEFENSE' }, { value: 1, zone: 'DEFENSE' }]
  })
  await f.act(0, gameId, 1, 'combat-ready', { subRound: 1 })
  await f.command(0, 'suspend')
  f.advance(3000)
  const loot = (await f.act(0, gameId, 1, 'observe', { areaId: 'MAIN_TABLE' })).activeGame.search
  const blueWeapon = loot.room.activeArea.visibleItems.find(item => item.cardId === 'wp_004')
  assert.ok(blueWeapon)
  await assert.rejects(f.act(0, gameId, 1, 'pickup', { instanceId: blueWeapon.instanceId }), { code: 'WEAPON_LIMIT' })
  const oldWeapon = loot.inventory.find(item => item.cardId === 'wp_006')
  await f.act(0, gameId, 1, 'drop', { instanceId: oldWeapon.instanceId })
  const picked = await f.act(0, gameId, 1, 'pickup', { instanceId: blueWeapon.instanceId })
  assert.equal(picked.activeGame.search.inventory[0].cardId, 'wp_004')
  await f.act(0, gameId, 1, 'leave')
  await f.soloEdit(game => { game.rngState = 0 })
  const again = (await f.act(0, gameId, 2, 'move', { target: { x: 1, y: 0 } })).activeGame
  assert.equal(again.combat.opponent.hp, 30)
  assert.equal(again.combat.nodeId, first.combat.nodeId)
  const state = (await f.store.get(f.accounts[0].id)).activeGame.state
  assert.equal(state.roomStock.visited.filter(id => id === again.combat.nodeId).length, 1)
  assert.equal(state.players.filter(p => p.isBot).length, 1)
})

test('混合新旧客户端的房间保留旧战斗协议', async () => {
  const f = await fixture(2)
  const gameId = await f.startRoom({ mixed: true })
  const game = f.store.rooms.get(gameId).game
  assert.equal(game.combatVersion, undefined)
  assert.equal(game.state.encounters[0].type, 'BATTLE')
  assert.equal(game.state.players.filter(player => player.status === 'ACTIVE').length, 1)
})
