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
  game.submitMove('P1', { x: 0, y: 0 })
  game.submitMove('P2', { x: 0, y: 4 })
  game.submitMove('P3', { x: 4, y: 0 })
  game.resolveMoves()
  const item = game.searchItemsFor('P1').find(candidate => candidate.state === 'HIDDEN')
  assert.ok(item)
  assert.equal(game.interactWithItem('P1', item.instanceId).action, 'REVEALED')
  assert.equal(game.interactWithItem('P1', item.instanceId).action, 'PICKED_UP')
  assert.ok(game.getPlayer('P1').inventory.includes(item.instanceId))
})

test('背包满时拒绝拾取且物品留在房间', () => {
  const { game } = createGame()
  game.submitMove('P1', { x: 0, y: 0 })
  game.submitMove('P2', { x: 0, y: 4 })
  game.submitMove('P3', { x: 4, y: 0 })
  game.resolveMoves()
  const player = game.getPlayer('P1')
  while (player.inventory.length < C.BACKPACK_SLOTS) {
    const filler = game.createItem('loot_001', null, 'IN_INVENTORY', 'P1')
    player.inventory.push(filler.instanceId)
  }
  const target = game.searchItemsFor('P1').find(candidate => candidate.state === 'HIDDEN')
  game.interactWithItem('P1', target.instanceId)
  const result = game.interactWithItem('P1', target.instanceId)
  assert.equal(result.reason, 'BACKPACK_FULL')
  assert.equal(game.items.find(item => item.instanceId === target.instanceId).state, 'REVEALED')
})

test('第10回合开始时立即扣除10点生命', () => {
  const { game } = createGame()
  game.turn = 10
  game.beginTurn()
  game.players.forEach(player => assert.equal(player.hp, 20))
})

test('三人同节点时随机两人战斗，另一人搜索，原房间物资只分配一次', () => {
  const { game } = createGame(99)
  game.players.forEach(player => {
    player.position = { x: 2, y: 2 }
    player.previousPosition = { x: 2, y: 2 }
    game.submitMove(player.id, { x: 2, y: 2 })
  })
  const originalItemIds = game.items.filter(item => item.nodeId === 'n_2_2' && item.state === 'HIDDEN').map(item => item.instanceId).sort()
  game.resolveMoves()
  const split = game.encounters.find(encounter => encounter.type === 'THREE_PLAYER_SPLIT')
  assert.ok(split)
  assert.equal(split.fighterIds.length, 2)
  assert.ok(!split.fighterIds.includes(split.searcherId))
  assert.deepEqual(split.battleItemIds.concat(split.searchItemIds).sort(), originalItemIds)
})

test('警报圈伤害使生命归零时立即战败', () => {
  const { game } = createGame()
  game.players[0].hp = 10
  game.turn = 10
  game.beginTurn()
  assert.equal(game.players[0].status, 'DEFEATED')
  assert.equal(game.players[0].hp, 0)
})

test('完成一轮战斗后武器耐久减少且不会低于零', () => {
  const { game } = createGame(11)
  game.players[0].position = { x: 1, y: 1 }
  game.players[1].position = { x: 1, y: 1 }
  game.players[2].position = { x: 4, y: 0 }
  game.players.forEach(player => game.submitMove(player.id, player.position))
  const weaponIds = game.players.slice(0, 2).map(player => player.equippedWeaponId)
  game.resolveMoves()
  weaponIds.forEach(instanceId => {
    const weapon = game.items.find(item => item.instanceId === instanceId)
    assert.ok(weapon.durability >= 0 && weapon.durability <= 1)
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
  player.hp = 10
  game.turn = 9
  game.phase = 'ROUND_RESULT'
  game.requestExtraction('P1')
  game.finishTurn()
  assert.equal(player.hp, 0)
  assert.equal(player.status, 'DEFEATED')
  assert.equal(game.settlementFor('P1').success, false)
})

test('第12回合结束仍未撤离时结算失败', () => {
  const { game } = createGame()
  game.turn = 12
  game.phase = 'ROUND_RESULT'
  game.finishTurn()
  assert.equal(game.getPlayer('P1').status, 'TIMED_OUT')
  assert.equal(game.settlementFor('P1').success, false)
})
