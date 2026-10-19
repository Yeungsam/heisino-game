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
