const C = require('./constants')
const { randomInt, shuffled } = require('./rng')
const { resolveBattle } = require('./combat')

function nodeId(x, y) {
  return `n_${x}_${y}`
}

function positionKey(position) {
  return nodeId(position.x, position.y)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class GameEngine {
  constructor(options) {
    this.cards = options.cards
    this.cardById = Object.fromEntries(this.cards.map(card => [card.cardId, card]))
    this.rng = options.rng || Math.random
    this.now = options.now || (() => Date.now())
    this.localPlayerId = options.localPlayerId || 'P1'
    this.turn = 1
    this.phase = 'BOOT'
    this.players = []
    this.items = []
    this.moveSelections = {}
    this.searchAccess = {}
    this.encounters = []
    this.log = []
    this.nextItemSequence = 1
  }

  start() {
    this.players = [
      this.createPlayer('P1', '玩家', 0, 0, 'wp_006'),
      this.createPlayer('P2', '黑桃客', 0, 4, 'wp_005'),
      this.createPlayer('P3', '红心客', 4, 0, 'wp_002')
    ]
    this.seedRooms()
    this.beginTurn()
    return this.snapshot()
  }

  createPlayer(id, name, x, y, weaponCardId) {
    const weapon = this.createItem(weaponCardId, nodeId(x, y), 'EQUIPPED', id)
    return {
      id,
      name,
      hp: C.MAX_HP,
      maxHp: C.MAX_HP,
      status: 'ACTIVE',
      position: { x, y },
      previousPosition: { x, y },
      inventory: [weapon.instanceId],
      equippedWeaponId: weapon.instanceId,
      extractionRequestedTurn: null
    }
  }

  createItem(cardId, roomNodeId, state = 'HIDDEN', ownerId = null) {
    const item = {
      instanceId: `item_${this.nextItemSequence++}`,
      cardId,
      state,
      nodeId: ownerId ? null : roomNodeId,
      ownerId,
      durability: this.cardById[cardId].maxDurability || 0,
      revealedBy: null,
      createdTurn: this.turn
    }
    this.items.push(item)
    return item
  }

  seedRooms() {
    const lootIds = this.cards.filter(card => card.kind === 'LOOT').map(card => card.cardId)
    for (let y = 0; y < C.BOARD_SIZE; y += 1) {
      for (let x = 0; x < C.BOARD_SIZE; x += 1) {
        if (nodeId(x, y) === C.EXTRACTION_NODE_ID) continue
        const count = x === 2 && y === 2 ? 3 : 1
        for (let index = 0; index < count; index += 1) {
          this.createItem(lootIds[(x + y + index) % lootIds.length], nodeId(x, y))
        }
      }
    }
  }

  beginTurn() {
    this.moveSelections = {}
    this.searchAccess = {}
    this.encounters = []
    if (this.turn >= C.ALERT_START_TURN) this.applyAlertDamage()
    this.completeExtractions()
    const localPlayer = this.getPlayer(this.localPlayerId)
    if (localPlayer && localPlayer.status !== 'ACTIVE') {
      this.phase = 'GAME_OVER'
      return
    }
    if (this.activePlayers().length <= 1) {
      this.phase = 'GAME_OVER'
      this.addLog('场上仅剩一名玩家，对局结束。')
      return
    }
    this.phase = 'MOVE_SELECTION'
    const startedAt = this.now()
    this.turnStartedAt = startedAt
    this.moveDeadlineAt = startedAt + C.MOVE_SELECTION_MS
    this.turnDeadlineAt = startedAt + C.TURN_DURATION_MS
    this.addLog(`第 ${this.turn} 回合：请选择相邻节点或原地停留。`)
  }

  applyAlertDamage() {
    this.activePlayers().forEach(player => {
      player.hp = Math.max(0, player.hp - C.ALERT_DAMAGE)
      this.addLog(`${player.name}受到警报圈伤害 -${C.ALERT_DAMAGE} HP。`)
      if (player.hp <= 0) {
        player.status = 'DEFEATED'
        this.dropAllItems(player)
        this.addLog(`${player.name}因警报圈伤害战败。`)
      }
    })
  }

  completeExtractions() {
    this.activePlayers().forEach(player => {
      if (player.extractionRequestedTurn !== null && this.turn > player.extractionRequestedTurn) {
        player.status = 'EXTRACTED'
        this.addLog(`${player.name}已从白鸽撤离点安全离场。`)
      }
    })
  }

  activePlayers() {
    return this.players.filter(player => player.status === 'ACTIVE')
  }

  getPlayer(playerId) {
    return this.players.find(player => player.id === playerId)
  }

  legalMoves(playerId) {
    const player = this.getPlayer(playerId)
    if (!player || player.status !== 'ACTIVE') return []
    const candidates = [
      { x: player.position.x, y: player.position.y },
      { x: player.position.x + 1, y: player.position.y },
      { x: player.position.x - 1, y: player.position.y },
      { x: player.position.x, y: player.position.y + 1 },
      { x: player.position.x, y: player.position.y - 1 }
    ]
    return candidates.filter(position => (
      position.x >= 0 && position.y >= 0 &&
      position.x < C.BOARD_SIZE && position.y < C.BOARD_SIZE &&
      !(position.x === 2 && position.y === 2 && this.turn < C.VAULT_OPEN_TURN)
    ))
  }

  submitMove(playerId, target) {
    if (this.phase !== 'MOVE_SELECTION') return { ok: false, reason: 'INVALID_PHASE' }
    if (target.x === 2 && target.y === 2 && this.turn < C.VAULT_OPEN_TURN) {
      return { ok: false, reason: 'NODE_LOCKED' }
    }
    const legal = this.legalMoves(playerId).some(position => position.x === target.x && position.y === target.y)
    if (!legal) return { ok: false, reason: 'NOT_ADJACENT' }
    this.moveSelections[playerId] = { x: target.x, y: target.y }
    return { ok: true, allSubmitted: Object.keys(this.moveSelections).length === this.activePlayers().length }
  }

  submitBotMoves() {
    this.activePlayers().filter(player => player.id !== this.localPlayerId).forEach(player => {
      if (this.moveSelections[player.id]) return
      const moves = this.legalMoves(player.id)
      this.submitMove(player.id, moves[randomInt(this.rng, moves.length)])
    })
  }

  resolveMoves() {
    if (this.phase !== 'MOVE_SELECTION') return { ok: false, reason: 'INVALID_PHASE' }
    this.activePlayers().forEach(player => {
      if (!this.moveSelections[player.id]) this.moveSelections[player.id] = clone(player.position)
      player.previousPosition = clone(player.position)
      player.position = clone(this.moveSelections[player.id])
    })
    this.phase = 'RESOLVING'

    const groups = {}
    this.activePlayers().forEach(player => {
      const key = positionKey(player.position)
      if (!groups[key]) groups[key] = []
      groups[key].push(player)
    })

    Object.keys(groups).forEach(roomNodeId => this.resolveRoom(roomNodeId, groups[roomNodeId]))
    this.phase = (this.searchAccess[this.localPlayerId] || []).length > 0 ? 'SEARCH' : 'ROUND_RESULT'
    return { ok: true, encounters: clone(this.encounters) }
  }

  resolveRoom(roomNodeId, players) {
    const roomItems = this.items.filter(item => item.nodeId === roomNodeId && ['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state))
    if (players.length === 1) {
      this.grantSearch(players[0].id, roomItems)
      this.encounters.push({ type: 'SEARCH', nodeId: roomNodeId, playerIds: [players[0].id], itemIds: roomItems.map(item => item.instanceId) })
      return
    }

    if (players.length === 2) {
      const battle = this.runBattle(players[0], players[1], roomNodeId)
      if (battle.winnerId) this.grantSearch(battle.winnerId, roomItems.concat(this.droppedItemsAt(roomNodeId)))
      return
    }

    const shuffledPlayers = shuffled(players, this.rng)
    const fighters = shuffledPlayers.slice(0, 2)
    const searcher = shuffledPlayers[2]
    const randomizedItems = shuffled(roomItems, this.rng)
    const extraToBattle = randomizedItems.length % 2 === 1 && this.rng() >= 0.5
    const battleCount = Math.floor(randomizedItems.length / 2) + (extraToBattle ? 1 : 0)
    const battleItems = randomizedItems.slice(0, battleCount)
    const searchItems = randomizedItems.slice(battleCount)
    this.grantSearch(searcher.id, searchItems)
    const battle = this.runBattle(fighters[0], fighters[1], roomNodeId)
    if (battle.winnerId) this.grantSearch(battle.winnerId, battleItems.concat(this.droppedItemsAt(roomNodeId)))
    this.encounters.push({
      type: 'THREE_PLAYER_SPLIT',
      nodeId: roomNodeId,
      fighterIds: fighters.map(player => player.id),
      searcherId: searcher.id,
      battleItemIds: battleItems.map(item => item.instanceId),
      searchItemIds: searchItems.map(item => item.instanceId)
    })
  }

  runBattle(left, right, roomNodeId) {
    const leftStats = this.combatStats(left)
    const rightStats = this.combatStats(right)
    const result = resolveBattle(leftStats, rightStats, this.rng)
    left.hp = result.leftHp
    right.hp = result.rightHp
    this.consumeWeaponDurability(left)
    this.consumeWeaponDurability(right)
    if (result.loserId) {
      const loser = this.getPlayer(result.loserId)
      loser.status = 'DEFEATED'
      this.dropAllItems(loser, roomNodeId)
      this.addLog(`${this.getPlayer(result.winnerId).name}战胜了${loser.name}。`)
    } else {
      this.addLog(`${left.name}与${right.name}完全平局，本轮均未被淘汰。`)
    }
    const encounter = { type: 'BATTLE', nodeId: roomNodeId, playerIds: [left.id, right.id], ...result }
    this.encounters.push(encounter)
    return result
  }

  combatStats(player) {
    const weaponItem = this.items.find(item => item.instanceId === player.equippedWeaponId && item.state === 'EQUIPPED')
    const weaponCard = weaponItem ? this.cardById[weaponItem.cardId] : null
    return {
      id: player.id,
      hp: player.hp,
      attackMultiplier: weaponCard ? weaponCard.attackMultiplier : C.BASE_ATTACK_MULTIPLIER,
      defenseMultiplier: C.BASE_DEFENSE_MULTIPLIER
    }
  }

  consumeWeaponDurability(player) {
    const weapon = this.items.find(item => item.instanceId === player.equippedWeaponId)
    if (!weapon) return
    weapon.durability = Math.max(0, weapon.durability - 1)
    if (weapon.durability === 0) {
      weapon.state = 'DESTROYED'
      player.inventory = player.inventory.filter(id => id !== weapon.instanceId)
      player.equippedWeaponId = null
      this.addLog(`${player.name}的武器耐久耗尽。`)
    }
  }

  grantSearch(playerId, items) {
    if (!this.searchAccess[playerId]) this.searchAccess[playerId] = []
    items.forEach(item => {
      if (!this.searchAccess[playerId].includes(item.instanceId)) this.searchAccess[playerId].push(item.instanceId)
    })
  }

  droppedItemsAt(roomNodeId) {
    return this.items.filter(item => item.nodeId === roomNodeId && item.state === 'DROPPED')
  }

  searchItemsFor(playerId) {
    const allowed = this.searchAccess[playerId] || []
    return allowed.map(id => this.items.find(item => item.instanceId === id)).filter(Boolean)
  }

  interactWithItem(playerId, instanceId) {
    if (this.phase !== 'SEARCH') return { ok: false, reason: 'INVALID_PHASE' }
    if (!(this.searchAccess[playerId] || []).includes(instanceId)) return { ok: false, reason: 'NO_ACCESS' }
    const player = this.getPlayer(playerId)
    const item = this.items.find(candidate => candidate.instanceId === instanceId)
    if (!item || !['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state)) return { ok: false, reason: 'INVALID_ITEM' }
    if (item.state === 'HIDDEN') {
      item.state = 'REVEALED'
      item.revealedBy = playerId
      return { ok: true, action: 'REVEALED', item: clone(item) }
    }
    if (player.inventory.length >= C.BACKPACK_SLOTS) return { ok: false, reason: 'BACKPACK_FULL' }
    item.state = 'IN_INVENTORY'
    item.ownerId = playerId
    item.nodeId = null
    player.inventory.push(item.instanceId)
    return { ok: true, action: 'PICKED_UP', item: clone(item) }
  }

  dropItem(playerId, instanceId) {
    const player = this.getPlayer(playerId)
    if (!player || !player.inventory.includes(instanceId)) return { ok: false, reason: 'NOT_OWNED' }
    const item = this.items.find(candidate => candidate.instanceId === instanceId)
    if (!item) return { ok: false, reason: 'INVALID_ITEM' }
    player.inventory = player.inventory.filter(id => id !== instanceId)
    if (player.equippedWeaponId === instanceId) player.equippedWeaponId = null
    item.state = 'DROPPED'
    item.ownerId = null
    item.nodeId = positionKey(player.position)
    return { ok: true }
  }

  dropAllItems(player, roomNodeId = positionKey(player.position)) {
    player.inventory.slice().forEach(instanceId => {
      const item = this.items.find(candidate => candidate.instanceId === instanceId)
      if (!item || item.state === 'DESTROYED') return
      item.state = 'DROPPED'
      item.ownerId = null
      item.nodeId = roomNodeId
    })
    player.inventory = []
    player.equippedWeaponId = null
  }

  finishTurn() {
    if (!['SEARCH', 'ROUND_RESULT'].includes(this.phase)) return { ok: false, reason: 'INVALID_PHASE' }
    if (this.turn >= C.MAX_TURNS) {
      this.activePlayers().forEach(player => {
        player.status = 'TIMED_OUT'
      })
      this.phase = 'GAME_OVER'
      this.addLog('第 12 回合结束，未完成撤离的玩家判定失败。')
      return { ok: true, gameOver: true }
    }
    this.turn += 1
    this.beginTurn()
    return { ok: true, gameOver: this.phase === 'GAME_OVER' }
  }

  requestExtraction(playerId) {
    if (!['SEARCH', 'ROUND_RESULT'].includes(this.phase)) return { ok: false, reason: 'INVALID_PHASE' }
    const player = this.getPlayer(playerId)
    if (!player || player.status !== 'ACTIVE') return { ok: false, reason: 'NOT_ACTIVE' }
    if (positionKey(player.position) !== C.EXTRACTION_NODE_ID) return { ok: false, reason: 'NOT_AT_EXTRACTION' }
    if (player.extractionRequestedTurn !== null) return { ok: false, reason: 'ALREADY_REQUESTED' }
    player.extractionRequestedTurn = this.turn
    this.addLog(`${player.name}已呼叫白鸽接应，需消耗 1 回合完成撤离。`)
    return { ok: true, completesAtTurn: this.turn + 1 }
  }

  settlementFor(playerId) {
    const player = this.getPlayer(playerId)
    if (!player) return null
    const reasonByStatus = {
      EXTRACTED: '成功撤离',
      DEFEATED: '战斗或警报圈战败',
      TIMED_OUT: '第 12 回合结束前未撤离',
      ACTIVE: '对局提前结束'
    }
    return {
      playerId,
      success: player.status === 'EXTRACTED',
      status: player.status,
      reason: reasonByStatus[player.status] || player.status,
      turn: this.turn,
      hp: player.hp,
      itemCount: player.inventory.length,
      lootValue: this.inventoryValue(playerId),
      itemIds: player.inventory.slice()
    }
  }

  tick(timestamp = this.now()) {
    if (this.phase === 'MOVE_SELECTION' && timestamp >= this.moveDeadlineAt) {
      this.submitBotMoves()
      return this.resolveMoves()
    }
    if (['SEARCH', 'ROUND_RESULT'].includes(this.phase) && timestamp >= this.turnDeadlineAt) {
      return this.finishTurn()
    }
    return null
  }

  inventoryValue(playerId) {
    const player = this.getPlayer(playerId)
    return player.inventory.reduce((total, instanceId) => {
      const item = this.items.find(candidate => candidate.instanceId === instanceId)
      const card = item && this.cardById[item.cardId]
      return total + ((card && card.value) || 0)
    }, 0)
  }

  addLog(message) {
    this.log.unshift(message)
    this.log = this.log.slice(0, 8)
  }

  snapshot() {
    return clone({
      turn: this.turn,
      phase: this.phase,
      players: this.players,
      items: this.items,
      encounters: this.encounters,
      searchAccess: this.searchAccess,
      log: this.log,
      moveDeadlineAt: this.moveDeadlineAt,
      turnDeadlineAt: this.turnDeadlineAt
    })
  }
}

module.exports = { GameEngine, nodeId, positionKey }
