const C = require('./constants')

function rollDice(rng) {
  return [1, 2, 3].map(() => Math.floor(rng() * 6) + 1)
}

function autoAllocate(dice) {
  const sorted = dice.slice().sort((left, right) => right - left)
  return { attackDice: sorted.slice(0, 2), defenseDice: sorted.slice(2) }
}

function resolveExchange(left, right, rng) {
  const leftRoll = rollDice(rng)
  const rightRoll = rollDice(rng)
  const leftAllocation = autoAllocate(leftRoll)
  const rightAllocation = autoAllocate(rightRoll)
  const leftAttack = leftAllocation.attackDice.reduce((sum, value) => sum + value, 0) * left.attackMultiplier
  const rightAttack = rightAllocation.attackDice.reduce((sum, value) => sum + value, 0) * right.attackMultiplier
  const leftDefense = leftAllocation.defenseDice[0] * left.defenseMultiplier
  const rightDefense = rightAllocation.defenseDice[0] * right.defenseMultiplier
  const damageToRight = Math.max(0, Math.round(leftAttack - rightDefense))
  const damageToLeft = Math.max(0, Math.round(rightAttack - leftDefense))

  return {
    leftRoll,
    rightRoll,
    leftAllocation,
    rightAllocation,
    damageToLeft,
    damageToRight
  }
}

function resolveBattle(leftPlayer, rightPlayer, rng) {
  const left = {
    id: leftPlayer.id,
    hp: leftPlayer.hp,
    attackMultiplier: leftPlayer.attackMultiplier || C.BASE_ATTACK_MULTIPLIER,
    defenseMultiplier: leftPlayer.defenseMultiplier || C.BASE_DEFENSE_MULTIPLIER
  }
  const right = {
    id: rightPlayer.id,
    hp: rightPlayer.hp,
    attackMultiplier: rightPlayer.attackMultiplier || C.BASE_ATTACK_MULTIPLIER,
    defenseMultiplier: rightPlayer.defenseMultiplier || C.BASE_DEFENSE_MULTIPLIER
  }
  let damageByLeft = 0
  let damageByRight = 0
  const rounds = []

  for (let round = 1; round <= C.BATTLE_SUB_ROUNDS; round += 1) {
    const exchange = resolveExchange(left, right, rng)
    left.hp = Math.max(0, left.hp - exchange.damageToLeft)
    right.hp = Math.max(0, right.hp - exchange.damageToRight)
    damageByLeft += exchange.damageToRight
    damageByRight += exchange.damageToLeft
    rounds.push({ round, ...exchange, leftHp: left.hp, rightHp: right.hp })
    if (left.hp === 0 || right.hp === 0) break
  }

  let winnerId = null
  let loserId = null
  if (left.hp === 0 && right.hp > 0) {
    winnerId = right.id
    loserId = left.id
  } else if (right.hp === 0 && left.hp > 0) {
    winnerId = left.id
    loserId = right.id
  } else if (damageByLeft !== damageByRight) {
    winnerId = damageByLeft > damageByRight ? left.id : right.id
    loserId = winnerId === left.id ? right.id : left.id
  } else if (left.hp !== right.hp) {
    winnerId = left.hp > right.hp ? left.id : right.id
    loserId = winnerId === left.id ? right.id : left.id
  }

  return {
    winnerId,
    loserId,
    isExactDraw: winnerId === null,
    leftHp: left.hp,
    rightHp: right.hp,
    damageByLeft,
    damageByRight,
    rounds
  }
}

module.exports = { rollDice, autoAllocate, resolveExchange, resolveBattle }
