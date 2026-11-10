const test = require('node:test')
const assert = require('node:assert/strict')
const cards = require('../client/data/cards')
const C = require('../client/js/core/constants')
const { GameEngine } = require('../client/js/core/game-engine')
const { createSeededRng } = require('../client/js/core/rng')

function createGame(seed = 7) {
  let time = 1000
  const game = new GameEngine({ cards, rng: createSeededRng(seed), now: () => time })
  game.start()
  return { game, setTime(value) { time = value } }
}

test('玩家只能移动到相邻节点或停留', () => {
  const { game } = createGame()
  assert.deepEqual(game.legalMoves('P1'), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])
  assert.equal(game.submitMove('P1', { x: 1, y: 1 }).reason, 'NOT_ADJACENT')
  assert.equal(game.submitMove('P1', { x: 1, y: 0 }).ok, true)
})

test('战备卡牌成为玩家本局初始背包，第一张武器自动装备', () => {
  const game = new GameEngine({
    cards,
    rng: createSeededRng(7),
    now: () => 1000,
    localLoadoutCardIds: ['loot_001', 'wp_001', 'wp_002', 'loot_002']
  })
  game.start()
  const player = game.getPlayer('P1')
  const inventoryCards = player.inventory.map(instanceId => game.items.find(item => item.instanceId === instanceId).cardId)
  assert.deepEqual(inventoryCards, ['loot_001', 'wp_001', 'wp_002', 'loot_002'])
  assert.equal(game.items.find(item => item.instanceId === player.equippedWeaponId).cardId, 'wp_001')
})

test('中央金库第6回合才开放', () => {
  const { game } = createGame()
  const player = game.getPlayer('P1')
  player.position = { x: 2, y: 1 }
  assert.equal(game.submitMove('P1', { x: 2, y: 2 }).reason, 'NODE_LOCKED')
  game.turn = 6
  assert.equal(game.submitMove('P1', { x: 2, y: 2 }).ok, true)
})

test('倒计时未选择的玩家默认停留原地', () => {
  const { game } = createGame()
  const before = { ...game.getPlayer('P1').position }
  game.submitBotMoves()
  game.resolveMoves()
  assert.deepEqual(game.getPlayer('P1').position, before)
})

test('房间物资第一次点击显示，第二次点击拾取', () => {
  const { game } = createGame()
  game.submitMove('P1', { x: 1, y: 0 })
  game.submitMove('P2', { x: 0, y: 4 })
  game.submitMove('P3', { x: 4, y: 0 })
  game.resolveMoves()
  const item = game.searchItemsFor('P1').find(candidate => candidate.state === 'HIDDEN')
  assert.ok(item)
  assert.equal(game.interactWithItem('P1', item.instanceId).action, 'REVEALED')
  assert.equal(game.interactWithItem('P1', item.instanceId).action, 'PICKED_UP')
  assert.ok(game.getPlayer('P1').inventory.includes(item.instanceId))
})

test('十件同款也会填满对局背包，丢弃指定实例后可拾取', () => {
  const { game } = createGame()
  game.submitMove('P1', { x: 1, y: 0 })
  game.submitMove('P2', { x: 0, y: 4 })
  game.submitMove('P3', { x: 4, y: 0 })
  game.resolveMoves()
  const player = game.getPlayer('P1')
  const target = game.searchItemsFor('P1').find(candidate => candidate.state === 'HIDDEN')
  target.cardId = game.items.find(item => item.instanceId === player.inventory[0]).cardId
  while (player.inventory.length < C.BACKPACK_SLOTS) {
    const filler = game.createItem(target.cardId, null, 'IN_INVENTORY', 'P1')
    player.inventory.push(filler.instanceId)
  }
  game.interactWithItem('P1', target.instanceId)
  const result = game.interactWithItem('P1', target.instanceId)
  assert.equal(result.reason, 'BACKPACK_FULL')
  assert.equal(game.items.find(item => item.instanceId === target.instanceId).state, 'REVEALED')
  const removedId = player.inventory[1]
  assert.equal(game.dropItem('P1', removedId).ok, true)
  assert.equal(game.interactWithItem('P1', target.instanceId).action, 'PICKED_UP')
  assert.equal(player.inventory.length, C.BACKPACK_SLOTS)
  assert.ok(!player.inventory.includes(removedId) && player.inventory.includes(target.instanceId))
})

test('毒圈从第10回合开始，每回合立即扣除5点生命', () => {
  const { game } = createGame()
  for (const [turn, hp] of [[9, 30], [10, 25], [11, 20]]) {
    game.turn = turn
    game.beginTurn()
    game.players.forEach(player => assert.equal(player.hp, hp))
  }
})

test('三人同节点时随机两人战斗，另一人搜索，原房间物资只分配一次', () => {
  const { game } = createGame(99)
  game.players.forEach(player => {
    player.position = { x: 2, y: 2 }
    player.previousPosition = { x: 2, y: 2 }
    game.submitMove(player.id, { x: 2, y: 2 })
  })
  game.resolveMoves()
  const originalItemIds = game.items.filter(item => item.nodeId === 'n_2_2' && item.state === 'HIDDEN').map(item => item.instanceId).sort()
  assert.equal(originalItemIds.length, 6)
  const split = game.encounters.find(encounter => encounter.type === 'THREE_PLAYER_SPLIT')
  assert.ok(split)
  assert.equal(split.fighterIds.length, 2)
  assert.ok(!split.fighterIds.includes(split.searcherId))
  assert.deepEqual(split.battleItemIds.concat(split.searchItemIds).sort(), originalItemIds)
})

test('上线前的物资快照继续使用已生成或已拿空的房间', () => {
  const { game } = createGame()
  const legacy = game.snapshot()
  delete legacy.roomStock
  const existing = { instanceId: 'item_99', cardId: 'loot_001', nodeId: 'n_1_0', areaId: 'MAIN_TABLE', state: 'HIDDEN' }
  legacy.items.push(existing)
  const resumed = Object.assign(new GameEngine({ cards }), legacy)
  const player = resumed.getPlayer('P1')
  resumed.resolveRoom('n_1_0', [player])
  assert.deepEqual(resumed.searchItemsFor('P1'), [existing])
  resumed.resolveRoom('n_2_0', [player])
  assert.equal(resumed.items.filter(item => item.nodeId === 'n_2_0').length, 0)
})

test('新局普通房间抽到零件后不重抽，旧局未访问房间仍按原数量生成', () => {
  const { game } = createGame()
  game.roomStock.seed = 4 // 新规则下 n_1_0 抽到 0 件。
  const old = game.snapshot()
  delete old.roomStock.randomCount
  game.resolveRoom('n_1_0', [game.getPlayer('P1')])
  assert.equal(game.items.filter(item => item.nodeId === 'n_1_0').length, 0)
  assert.deepEqual(game.roomStock.visited, ['n_1_0'])
  const reopened = Object.assign(new GameEngine({ cards }), game.snapshot())
  reopened.resolveRoom('n_1_0', [reopened.getPlayer('P1')])
  assert.deepEqual(reopened.roomStock.visited, ['n_1_0'])
  assert.equal(reopened.items.filter(item => item.nodeId === 'n_1_0').length, 0)
  const oldGame = Object.assign(new GameEngine({ cards }), old)
  oldGame.resolveRoom('n_1_0', [oldGame.getPlayer('P1')])
  oldGame.resolveRoom('n_2_2', [oldGame.getPlayer('P1')])
  assert.equal(oldGame.items.filter(item => item.nodeId === 'n_1_0').length, 4)
  assert.equal(oldGame.items.filter(item => item.nodeId === 'n_2_2').length, 10)
})

test('警报圈伤害使生命归零时立即战败', () => {
  const { game } = createGame()
  game.players[0].hp = 5
  game.turn = 10
  game.beginTurn()
  assert.equal(game.players[0].status, 'DEFEATED')
  assert.equal(game.players[0].hp, 0)
})

test('战斗后武器不再消耗耐久或因耐久销毁', () => {
  const { game } = createGame(11)
  game.players[0].position = { x: 1, y: 1 }
  game.players[1].position = { x: 1, y: 1 }
  game.players[2].position = { x: 4, y: 0 }
  game.players.forEach(player => game.submitMove(player.id, player.position))
  const weaponIds = game.players.slice(0, 2).map(player => player.equippedWeaponId)
  game.resolveMoves()
  weaponIds.forEach(instanceId => {
    const weapon = game.items.find(item => item.instanceId === instanceId)
    assert.equal(Object.hasOwn(weapon, 'durability'), false)
    assert.notEqual(weapon.state, 'DESTROYED')
  })
})

test('到达唯一撤离点后消耗一回合完成撤离', () => {
  const { game } = createGame()
  const player = game.getPlayer('P1')
  player.position = { x: 4, y: 4 }
  game.phase = 'ROUND_RESULT'
  assert.equal(game.requestExtraction('P1').ok, true)
  game.finishTurn()
  assert.equal(player.status, 'EXTRACTED')
  assert.equal(game.phase, 'GAME_OVER')
  assert.equal(game.settlementFor('P1').success, true)
})

test('第10回合警报圈伤害先于撤离完成结算', () => {
  const { game } = createGame()
  const player = game.getPlayer('P1')
  player.position = { x: 4, y: 4 }
  player.hp = 5
  game.turn = 9
  game.phase = 'ROUND_RESULT'
  game.requestExtraction('P1')
  game.finishTurn()
  assert.equal(player.hp, 0)
  assert.equal(player.status, 'DEFEATED')
  assert.equal(game.settlementFor('P1').success, false)
})

test('第12回合后存活玩家可继续行动，毒圈伤害持续', () => {
  const { game } = createGame()
  game.turn = 12
  game.phase = 'ROUND_RESULT'
  assert.deepEqual(game.finishTurn(), { ok: true, gameOver: false })
  assert.equal(game.turn, 13)
  assert.equal(game.phase, 'MOVE_SELECTION')
  assert.equal(game.getPlayer('P1').status, 'ACTIVE')
  assert.equal(game.getPlayer('P1').hp, 25)
})

test('第12回合发起的撤离在下一回合存活时完成', () => {
  const { game } = createGame()
  const player = game.getPlayer('P1')
  player.position = { x: 4, y: 4 }
  game.turn = 12
  game.phase = 'ROUND_RESULT'
  assert.equal(game.requestExtraction('P1').completesAtTurn, 13)
  game.finishTurn()
  assert.equal(player.hp, 25)
  assert.equal(game.settlementFor('P1').status, 'EXTRACTED')
  assert.equal(game.settlementFor('P1').turn, 13)
})
