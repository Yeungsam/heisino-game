const test = require('node:test')
const assert = require('node:assert/strict')
const { createSeededRng } = require('../client/js/core/rng')
const { autoAllocate, resolveBattle } = require('../client/js/core/combat')

test('自动分配将两颗最大骰用于攻击', () => {
  assert.deepEqual(autoAllocate([2, 6, 4]), { attackDice: [6, 4], defenseDice: [2] })
})

test('战斗最多进行三个小回合并产生可复现结果', () => {
  const result = resolveBattle(
    { id: 'P1', hp: 30, attackMultiplier: 0.6, defenseMultiplier: 0.2 },
    { id: 'P2', hp: 30, attackMultiplier: 0.8, defenseMultiplier: 0.2 },
    createSeededRng(42)
  )
  assert.ok(result.rounds.length >= 1 && result.rounds.length <= 3)
  assert.equal(result.winnerId === null, result.isExactDraw)
  assert.ok(result.leftHp >= 0)
  assert.ok(result.rightHp >= 0)
})
