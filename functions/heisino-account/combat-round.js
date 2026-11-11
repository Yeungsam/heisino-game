const { fault } = require('./wechat')
const { randomInt, shuffled, constants: C } = require('./runtime')

const VERSION = 1
const PLAY_MS = 15000
const IMPACT_MS = 2000
const RESULT_MS = 2000
const LOOT_MS = 20000
const UNEQUIPPED_MULTIPLIER = 0.4
const ACTIONS = new Set(['combat-roll', 'combat-place', 'combat-ready', 'combat-skill'])
const ZONES = new Set(['ATTACK', 'DEFENSE', 'TRAY'])
// Defense percentages on the card faces. Guard shield shares the casino shield face.
const DEFENSE_PERCENT = Object.freeze({
  ar_001: 100, ar_002: 80, ar_003: 90, ar_004: 100, ar_005: 80, ar_006: 60, ar_007: 60,
  ar_008: 80, ar_009: 80, ar_010: 60, ar_011: 60, ar_012: 90, ar_013: 80
})
// Room Materials table, 2026-11-11. Separate from the extraction economy.
const TRADE_VALUE = Object.freeze({
  wp_001: 50000, wp_002: 10000, wp_003: 10000, wp_004: 5000, wp_005: 5000, wp_006: 800, wp_007: 800,
  ar_001: 50000, ar_002: 5000, ar_003: 10000, ar_004: 50000, ar_005: 5000, ar_006: 800, ar_007: 800,
  ar_008: 5000, ar_009: 5000, ar_010: 800, ar_011: 800, ar_012: 10000,
  loot_001: 25000, loot_002: 30000, loot_003: 50000, loot_004: 50000, loot_005: 60000,
  loot_006: 90000, loot_007: 100000, loot_008: 100000, loot_009: 200000, loot_010: 10, loot_011: 300,
  loot_012: 2000, loot_013: 2500, loot_014: 3000, loot_015: 3000, loot_016: 5000, loot_017: 5000,
  loot_018: 7000, loot_019: 10000, loot_020: 10000, loot_021: 10000, loot_022: 15000, loot_023: 20000
})

function inventory(engine, player) {
  return player.inventory.map(id => engine.items.find(item => item.instanceId === id)).filter(Boolean)
}

function equipment(engine, player) {
  const cards = inventory(engine, player).map(item => engine.cardById[item.cardId]).filter(Boolean)
  const weapon = cards.find(card => card.category === 'WEAPON')
  const armor = cards.find(card => card.category === 'ARMOR')
  return {
    weaponId: weapon?.cardId ?? null, armorId: armor?.cardId ?? null,
    attackPercent: Math.round((weapon?.attackMultiplier ?? UNEQUIPPED_MULTIPLIER) * 100),
    defensePercent: DEFENSE_PERCENT[armor?.cardId] ?? Math.round((armor?.defenseMultiplier ?? UNEQUIPPED_MULTIPLIER) * 100)
  }
}

function roll(side, engine, count = 3) {
  side.dice = Array.from({ length: count }, () => ({ value: randomInt(engine.rng, 6) + 1, zone: 'TRAY' }))
}

function beginRound(combat, engine, at) {
  combat.stage = 'PLAY'
  combat.deadlineAt = at + PLAY_MS
  combat.impact = null
  combat.impactStartedAt = null
  for (const id of combat.playerIds) {
    const player = engine.getPlayer(id)
    const side = combat.sides[id]
    Object.assign(side, equipment(engine, player), { dice: [], readyAt: null, skillCardId: null, placementRevision: 0 })
    if (player.isBot) {
      roll(side, engine, 2)
      const attack = randomInt(engine.rng, side.dice.length)
      side.dice.forEach((die, i) => { die.zone = i === attack ? 'ATTACK' : 'DEFENSE' })
      side.readyAt = at
    }
  }
}

function createCombat(engine, encounter, at) {
  return {
    ...encounter, turn: engine.turn, startedAt: at, stage: 'PENDING', deadlineAt: at, round: 1,
    sides: Object.fromEntries(encounter.playerIds.map(id => [id, { damage: 0, ...equipment(engine, engine.getPlayer(id)) }]))
  }
}

function resolveImpact(combat, engine, at) {
  const scores = combat.playerIds.map(id => {
    const side = combat.sides[id]
    const isGuard = engine.getPlayer(id).isBot
    const points = (zone, percent) => {
      const sum = side.dice.filter(die => die.zone === zone).reduce((total, die) => total + die.value, 0)
      const scaled = sum * percent / 100
      // A guard's assigned die must still count when its equipment scales it below one.
      return isGuard && scaled > 0 && scaled < 1 ? 1 : Math.floor(scaled)
    }
    return {
      id, attack: points('ATTACK', side.attackPercent),
      defense: points('DEFENSE', side.defensePercent)
    }
  })
  combat.impact = Object.fromEntries(scores.map((score, i) => {
    const player = engine.getPlayer(score.id)
    const loss = Math.min(player.hp, Math.max(0, scores[1 - i].attack - score.defense))
    player.hp -= loss
    combat.sides[scores[1 - i].id].damage += loss
    return [score.id, { attack: score.attack, defense: score.defense, loss }]
  }))
  combat.stage = 'IMPACT'
  combat.impactStartedAt = at
  combat.deadlineAt = at + IMPACT_MS
}

function resultFor(combat, engine) {
  const [left, right] = combat.playerIds.map(id => engine.getPlayer(id))
  const bothDown = left.hp === 0 && right.hp === 0
  const difference = bothDown ? 0 : left.hp - right.hp || combat.sides[left.id].damage - combat.sides[right.id].damage
  return {
    winnerId: difference > 0 ? left.id : difference < 0 ? right.id : null,
    loserId: difference > 0 ? right.id : difference < 0 ? left.id : null,
    bothDown
  }
}

function discard(engine, player, items) {
  const ids = new Set(items.map(item => item.instanceId))
  player.inventory = player.inventory.filter(id => !ids.has(id))
  if (ids.has(player.equippedWeaponId)) player.equippedWeaponId = null
  for (const item of items) Object.assign(item, { state: 'DESTROYED', ownerId: null, nodeId: null, areaId: null })
}

function award(combat, engine) {
  const { winnerId, loserId, bothDown, forfeitedId } = combat.result
  const players = combat.playerIds.map(id => engine.getPlayer(id))
  const winner = engine.getPlayer(winnerId)
  const loser = engine.getPlayer(loserId)
  const roomItems = combat.itemIds.map(id => engine.items.find(item => item.instanceId === id))
    .filter(item => item?.nodeId === combat.nodeId)
  const drops = []
  if (winner && loser) {
    const held = inventory(engine, loser)
    // Array.sort is stable, so equal values follow the order in the backpack.
    const seized = held.slice().sort((a, b) => (TRADE_VALUE[b.cardId] ?? 0) - (TRADE_VALUE[a.cardId] ?? 0)).slice(0, 2)
    if (winner.isBot) discard(engine, loser, seized)
    else {
      for (const item of seized) {
        engine.dropItem(loser.id, item.instanceId)
        item.revealedBy = null
        drops.push(item)
      }
      engine.grantSearch(winner.id, roomItems.concat(drops))
    }
  } else if (!bothDown) {
    const humans = players.filter(player => !player.isBot)
    if (humans.length === 1) engine.grantSearch(humans[0].id, roomItems)
    else {
      const split = shuffled(roomItems, engine.rng)
      const extra = split.length % 2 && randomInt(engine.rng, 2)
      const count = Math.floor(split.length / 2) + extra
      engine.grantSearch(humans[0].id, split.slice(0, count))
      engine.grantSearch(humans[1].id, split.slice(count))
    }
  }
  for (const player of players) {
    if (player.hp === 0 || player.id === forfeitedId || player.isBot) {
      discard(engine, player, inventory(engine, player))
      if (player.status === 'ACTIVE') player.status = player.id === forfeitedId ? 'ABANDONED' : player.isBot && player.hp > 0 ? 'DEPARTED' : 'DEFEATED'
    }
  }
  return players.filter(player => player.status === 'ACTIVE' && engine.searchItemsFor(player.id).some(item => item.nodeId === combat.nodeId)).map(player => player.id)
}

function advanceCombat(combat, engine, now) {
  while (combat.stage !== 'COMPLETE') {
    if (combat.stage === 'PLAY' && combat.playerIds.every(id => combat.sides[id].readyAt !== null)) {
      const readyAt = Math.max(...combat.playerIds.map(id => combat.sides[id].readyAt))
      if (readyAt > now) return
      resolveImpact(combat, engine, Math.min(readyAt, combat.deadlineAt))
      continue
    }
    const at = combat.deadlineAt
    if (at > now) return
    if (combat.stage === 'PENDING') beginRound(combat, engine, at)
    else if (combat.stage === 'PLAY') resolveImpact(combat, engine, at)
    else if (combat.stage === 'IMPACT') {
      if (combat.result || combat.round === C.BATTLE_SUB_ROUNDS || combat.playerIds.some(id => engine.getPlayer(id).hp === 0)) {
        combat.result ??= resultFor(combat, engine)
        combat.stage = 'RESULT'
        combat.deadlineAt = at + RESULT_MS
      } else {
        combat.round += 1
        beginRound(combat, engine, at)
      }
    } else {
      if (!combat.awarded) combat.lootPlayers = award(combat, engine)
      combat.stage = 'COMPLETE'
      combat.completedAt = at
    }
  }
}

function forfeit(combat, engine, id, at) {
  if (!combat || combat.stage === 'COMPLETE' || !combat.playerIds.includes(id)) return false
  if (engine.getPlayer(id).hp === 0) throw fault('COMBAT_ENDED', 409)
  if (combat.result || (combat.stage === 'IMPACT' && combat.playerIds.some(playerId => engine.getPlayer(playerId).hp === 0))) return false
  const opponent = combat.playerIds.find(other => other !== id)
  combat.result = engine.getPlayer(opponent).hp > 0
    ? { winnerId: opponent, loserId: id, bothDown: false, forfeitedId: id }
    : { winnerId: null, loserId: null, bothDown: true, forfeitedId: id }
  if (combat.stage !== 'IMPACT') {
    combat.stage = 'RESULT'
    combat.deadlineAt = Math.max(at, combat.startedAt) + RESULT_MS
  }
  // Resolve immediately so an abandoning account can settle even if it never polls again.
  combat.lootPlayers = award(combat, engine)
  combat.awarded = true
  return true
}

function expireParticipants(combat, engine, expiredIds, at) {
  if (!combat || combat.stage === 'COMPLETE') return
  const expired = combat.playerIds.filter(id => expiredIds.includes(id))
  if (!expired.length) return
  if (combat.playerIds.every(id => engine.getPlayer(id).status !== 'ACTIVE')) {
    combat.stage = 'COMPLETE'
    combat.completedAt = at
    combat.lootPlayers = []
    return
  }
  // A hit resolved before the disconnect deadline still stands. A player
  // whose session has expired must never take part in a subsequent hit.
  if (engine.getPlayer(expired[0]).hp > 0) forfeit(combat, engine, expired[0], at)
}

function combatAction(combat, engine, id, input, now) {
  if (!combat || !combat.playerIds.includes(id) || combat.stage !== 'PLAY' || now >= combat.deadlineAt) throw fault('COMBAT_CLOSED', 409)
  if (input.subRound !== combat.round) throw fault('STALE_SUB_ROUND', 409)
  const side = combat.sides[id]
  if (side.readyAt !== null) throw fault('COMBAT_ALREADY_READY', 409)
  if (input.action === 'combat-roll') {
    if (side.dice.length) throw fault('DICE_ALREADY_ROLLED', 409)
    roll(side, engine)
  } else if (input.action === 'combat-place') {
    if (input.zones !== undefined) {
      const { zones, placementRevision } = input
      if (side.dice.length !== 3 || !Array.isArray(zones) || zones.length !== 3 || zones.some(zone => !ZONES.has(zone)) ||
          !Number.isSafeInteger(placementRevision) || placementRevision <= 0) throw fault('DICE_PLACEMENT_INVALID')
      if (placementRevision > (side.placementRevision ?? 0)) {
        side.dice.forEach((die, index) => { die.zone = zones[index] })
        side.placementRevision = placementRevision
      }
    } else {
      if (!Number.isInteger(input.dieIndex) || !side.dice[input.dieIndex] || !ZONES.has(input.zone)) throw fault('DICE_PLACEMENT_INVALID')
      side.dice[input.dieIndex].zone = input.zone
    }
  } else if (input.action === 'combat-ready') {
    if (side.dice.length !== 3) throw fault('DICE_UNPLACED', 409)
    if (input.zones !== undefined) {
      if (!Array.isArray(input.zones) || input.zones.length !== side.dice.length ||
          input.zones.some(zone => zone !== 'ATTACK' && zone !== 'DEFENSE')) throw fault('DICE_PLACEMENT_INVALID')
      side.dice.forEach((die, index) => { die.zone = input.zones[index] })
    } else if (side.dice.some(die => die.zone === 'TRAY')) throw fault('DICE_UNPLACED', 409)
    side.readyAt = now
  } else {
    if (side.skillCardId) throw fault('SKILL_ALREADY_USED', 409)
    const player = engine.getPlayer(id)
    const item = inventory(engine, player).find(candidate => candidate.instanceId === input.instanceId)
    if (!item || engine.cardById[item.cardId]?.category !== 'SKILL') throw fault('SKILL_NOT_OWNED', 409)
    side.skillCardId = item.cardId
    discard(engine, player, [item])
  }
}

function combatView(combat, engine, id) {
  if (!combat || combat.stage === 'COMPLETE' || !combat.playerIds.includes(id)) return null
  const opponentId = combat.playerIds.find(other => other !== id)
  const self = engine.getPlayer(id)
  const opponent = engine.getPlayer(opponentId)
  const info = player => {
    const side = combat.sides[player.id]
    return {
      name: player.name, hp: player.hp, maxHp: player.maxHp, isBot: Boolean(player.isBot),
      weaponId: side.weaponId, armorId: side.armorId, ready: side.readyAt !== null && side.readyAt !== undefined,
      impact: combat.impact?.[player.id] ?? null
    }
  }
  const side = combat.sides[id]
  return {
    nodeId: combat.nodeId, turn: combat.turn, subRound: combat.round, stage: combat.stage, deadlineAt: combat.deadlineAt,
    ...(combat.stage === 'IMPACT' ? { impactStartedAt: combat.impactStartedAt ?? combat.deadlineAt - 1000 } : {}),
    self: { ...info(self), dice: side.dice || [], placementRevision: side.placementRevision ?? 0, attackPercent: side.attackPercent, defensePercent: side.defensePercent,
      skillUsed: Boolean(side.skillCardId), skills: inventory(engine, self).filter(item => engine.cardById[item.cardId]?.category === 'SKILL')
        .map(item => ({ instanceId: item.instanceId, cardId: item.cardId })) },
    opponent: { ...info(opponent), dice: combat.impact ? combat.sides[opponentId].dice : [] },
    outcome: combat.stage === 'RESULT' && combat.result ? combat.result.bothDown ? 'DOUBLE_KO' : !combat.result.winnerId ? 'DRAW' : combat.result.winnerId === id ? 'WIN' : 'LOSS' : null
  }
}

function combatFingerprint(input) {
  const fields = [input.subRound, input.dieIndex, input.zone]
  if (input.action === 'combat-ready' && input.zones !== undefined) fields.push(input.zones)
  if (input.action === 'combat-place' && input.zones !== undefined) fields.push(input.zones, input.placementRevision)
  return fields
}

module.exports = { VERSION, LOOT_MS, ACTIONS, createCombat, advanceCombat, combatAction, combatView, forfeit, expireParticipants, combatFingerprint }
