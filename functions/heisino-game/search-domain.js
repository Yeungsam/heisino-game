const SEARCH_DURATION_MS = 50000
const REVEAL_INTERVAL_MS = 2000
const MAX_VISIBLE_ITEMS = 2
const BACKPACK_SLOTS = 10
const BOARD_SIZE = 5
const VAULT_NODE_ID = 'n_2_2'
const EXTRACTION_NODE_ID = 'n_4_4'
const LOADOUT_CATEGORIES = new Set(['WEAPON', 'ARMOR', 'SKILL'])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nodeId(x, y) {
  return `n_${x}_${y}`
}

function hashSeed(value) {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function cardIdOf(card) {
  return card.card_id || card.cardId
}

function isLootCard(card) {
  return (card.kind || '').toUpperCase() === 'LOOT' || (card.category || '').toUpperCase() === 'LOOT'
}

function isLoadoutCard(card) {
  return LOADOUT_CATEGORIES.has(String(card.category || '').toUpperCase())
}

function error(code, statusCode = 400) {
  const result = new Error(code)
  result.code = code
  result.statusCode = statusCode
  return result
}

class MemorySearchStore {
  constructor() {
    this.games = new Map()
  }

  async get(gameId) {
    return this.games.has(gameId) ? clone(this.games.get(gameId)) : null
  }

  async create(game) {
    if (this.games.has(game.gameId)) return false
    this.games.set(game.gameId, clone(game))
    return true
  }

  async replace(game, expectedVersion) {
    const current = this.games.get(game.gameId)
    if (!current || current.version !== expectedVersion) return false
    this.games.set(game.gameId, clone(game))
    return true
  }
}

class SearchGameService {
  constructor(options) {
    this.cards = options.cards || []
    this.lootCardIds = this.cards.filter(isLootCard).map(cardIdOf)
    this.loadoutCardIds = new Set(this.cards.filter(isLoadoutCard).map(cardIdOf))
    this.store = options.store || new MemorySearchStore()
    this.now = options.now || (() => Date.now())
    if (this.lootCardIds.length === 0) throw error('LOOT_CATALOG_EMPTY', 500)
  }

  async createGame(input) {
    const gameId = String(input.gameId || '').trim()
    const playerId = String(input.playerId || '').trim()
    if (!gameId || !playerId) throw error('INVALID_GAME_IDENTITY')
    const existing = await this.store.get(gameId)
    if (existing) return this.gameSnapshot(existing, playerId)

    const random = seededRandom(hashSeed(input.seed || gameId))
    let itemSequence = 1
    const items = []
    const rooms = {}
    const addItem = (cardId, roomNodeId, state = 'HIDDEN', ownerId = null) => {
      const item = {
        instanceId: `${gameId}-item-${itemSequence++}`,
        cardId,
        state,
        nodeId: ownerId ? null : roomNodeId,
        ownerId,
        exposedBy: [],
        createdAt: this.now()
      }
      items.push(item)
      if (roomNodeId) rooms[roomNodeId].itemIds.push(item.instanceId)
      return item
    }

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const roomNodeId = nodeId(x, y)
        rooms[roomNodeId] = { nodeId: roomNodeId, itemIds: [] }
        const count = roomNodeId === EXTRACTION_NODE_ID ? 0 : roomNodeId === VAULT_NODE_ID ? 10 : 4
        for (let index = 0; index < count; index += 1) {
          const cardId = this.lootCardIds[Math.floor(random() * this.lootCardIds.length)]
          addItem(cardId, roomNodeId)
        }
      }
    }

    const loadoutCardIds = Array.isArray(input.loadoutCardIds) ? input.loadoutCardIds : []
    const inventory = loadoutCardIds.filter(cardId => this.loadoutCardIds.has(cardId)).slice(0, BACKPACK_SLOTS)
      .map(cardId => addItem(cardId, null, 'IN_INVENTORY', playerId).instanceId)
    const game = {
      gameId,
      version: 1,
      createdAt: this.now(),
      itemSequence,
      items,
      rooms,
      players: { [playerId]: { playerId, inventory } },
      visits: {},
      requestResults: {}
    }
    const created = await this.store.create(game)
    return this.gameSnapshot(created ? game : await this.store.get(gameId), playerId)
  }

  async startVisit(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const room = game.rooms[input.roomNodeId]
      if (!room) throw error('ROOM_NOT_FOUND', 404)
      const existing = Object.values(game.visits).find(visit => visit.playerId === input.playerId && visit.turn === input.turn && visit.status === 'ACTIVE')
      if (existing) return this.visitSnapshot(game, existing, player)
      const startedAt = this.now()
      const visitId = `${game.gameId}-visit-${Object.keys(game.visits).length + 1}`
      const visit = {
        visitId,
        playerId: input.playerId,
        roomNodeId: input.roomNodeId,
        turn: Number(input.turn) || 1,
        status: 'ACTIVE',
        startedAt,
        deadlineAt: startedAt + SEARCH_DURATION_MS,
        observation: null,
        finishReason: null
      }
      game.visits[visitId] = visit
      return this.visitSnapshot(game, visit, player)
    })
  }

  async getVisit(input) {
    return this.mutate(input.gameId, null, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireVisit(game, input.visitId, input.playerId)
      this.advanceVisit(game, visit)
      return this.visitSnapshot(game, visit, player)
    }, { allowNoWrite: true })
  }

  async observe(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireActiveVisit(game, input.visitId, input.playerId)
      const roomItems = this.roomItems(game, visit.roomNodeId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
      if (roomItems.length === 0) throw error('ROOM_EMPTY')
      const visibleItemIds = roomItems
        .filter(item => item.exposedBy.includes(input.playerId))
        .slice(0, MAX_VISIBLE_ITEMS)
        .map(item => item.instanceId)
      visit.observation = {
        startedAt: this.now(),
        visibleItemIds,
        newlyExposedItemIds: [],
        active: true
      }
      return this.visitSnapshot(game, visit, player)
    })
  }

  async pickup(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireActiveVisit(game, input.visitId, input.playerId)
      this.advanceVisit(game, visit)
      if (!visit.observation || !visit.observation.active || !visit.observation.visibleItemIds.includes(input.instanceId)) throw error('ITEM_NOT_VISIBLE')
      if (player.inventory.length >= BACKPACK_SLOTS) throw error('BACKPACK_FULL')
      const item = game.items.find(candidate => candidate.instanceId === input.instanceId)
      if (!item || item.nodeId !== visit.roomNodeId || !['EXPOSED', 'DROPPED'].includes(item.state)) throw error('ITEM_UNAVAILABLE', 409)
      item.state = 'IN_INVENTORY'
      item.nodeId = null
      item.ownerId = input.playerId
      player.inventory.push(item.instanceId)
      visit.observation.visibleItemIds = visit.observation.visibleItemIds.filter(id => id !== item.instanceId)
      return this.visitSnapshot(game, visit, player)
    })
  }

  async drop(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireActiveVisit(game, input.visitId, input.playerId)
      if (!visit.observation || !visit.observation.active) throw error('OBSERVATION_NOT_ACTIVE', 409)
      const item = game.items.find(candidate => candidate.instanceId === input.instanceId)
      if (!item || item.ownerId !== input.playerId || !player.inventory.includes(item.instanceId)) throw error('ITEM_NOT_OWNED')
      player.inventory = player.inventory.filter(id => id !== item.instanceId)
      item.state = 'DROPPED'
      item.ownerId = null
      item.nodeId = visit.roomNodeId
      if (!item.exposedBy.includes(input.playerId)) item.exposedBy.push(input.playerId)
      if (!game.rooms[visit.roomNodeId].itemIds.includes(item.instanceId)) game.rooms[visit.roomNodeId].itemIds.push(item.instanceId)
      return this.visitSnapshot(game, visit, player)
    })
  }

  async finishObservation(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireActiveVisit(game, input.visitId, input.playerId)
      if (visit.observation) visit.observation.active = false
      return this.visitSnapshot(game, visit, player)
    })
  }

  async leave(input) {
    return this.mutate(input.gameId, input.requestId, game => {
      const player = this.requirePlayer(game, input.playerId)
      const visit = this.requireVisit(game, input.visitId, input.playerId)
      this.advanceVisit(game, visit)
      if (visit.status === 'ACTIVE') {
        visit.status = 'LEFT'
        visit.finishReason = 'PLAYER_LEFT'
        visit.finishedAt = this.now()
      }
      if (visit.observation) visit.observation.active = false
      return this.visitSnapshot(game, visit, player)
    })
  }

  async mutate(gameId, requestId, operation, options = {}) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const game = await this.store.get(gameId)
      if (!game) throw error('GAME_NOT_FOUND', 404)
      if (requestId && game.requestResults[requestId]) return clone(game.requestResults[requestId])
      const expectedVersion = game.version
      const before = JSON.stringify(game)
      const result = operation(game)
      if (options.allowNoWrite && before === JSON.stringify(game)) return clone(result)
      game.version += 1
      if (result && typeof result === 'object' && Object.hasOwn(result, 'version')) result.version = game.version
      if (requestId) {
        game.requestResults[requestId] = clone(result)
        const keys = Object.keys(game.requestResults)
        keys.slice(0, Math.max(0, keys.length - 100)).forEach(key => delete game.requestResults[key])
      }
      if (await this.store.replace(game, expectedVersion)) return clone(result)
    }
    throw error('VERSION_CONFLICT', 409)
  }

  advanceVisit(game, visit) {
    const now = this.now()
    if (visit.status === 'ACTIVE' && now >= visit.deadlineAt) {
      visit.status = 'TIMED_OUT'
      visit.finishReason = 'TIMEOUT'
      visit.finishedAt = now
      if (visit.observation) visit.observation.active = false
      return
    }
    const observation = visit.observation
    if (!observation || !observation.active) return
    const elapsedIntervals = Math.floor((now - observation.startedAt) / REVEAL_INTERVAL_MS)
    const targetCount = Math.min(MAX_VISIBLE_ITEMS, Math.max(0, elapsedIntervals))
    while (observation.visibleItemIds.length < targetCount) {
      const hidden = this.roomItems(game, visit.roomNodeId).find(item => item.state === 'HIDDEN')
      if (!hidden) break
      hidden.state = 'EXPOSED'
      if (!hidden.exposedBy.includes(visit.playerId)) hidden.exposedBy.push(visit.playerId)
      observation.visibleItemIds.push(hidden.instanceId)
      observation.newlyExposedItemIds.push(hidden.instanceId)
    }
  }

  roomItems(game, roomNodeId) {
    const room = game.rooms[roomNodeId]
    return room.itemIds.map(id => game.items.find(item => item.instanceId === id)).filter(Boolean)
  }

  requirePlayer(game, playerId) {
    const player = game.players[playerId]
    if (!player) throw error('PLAYER_NOT_FOUND', 404)
    return player
  }

  requireVisit(game, visitId, playerId) {
    const visit = game.visits[visitId]
    if (!visit || visit.playerId !== playerId) throw error('VISIT_NOT_FOUND', 404)
    return visit
  }

  requireActiveVisit(game, visitId, playerId) {
    const visit = this.requireVisit(game, visitId, playerId)
    this.advanceVisit(game, visit)
    if (visit.status !== 'ACTIVE') throw error(visit.status === 'TIMED_OUT' ? 'SEARCH_TIMEOUT' : 'VISIT_CLOSED', 409)
    return visit
  }

  itemView(item) {
    return {
      instanceId: item.instanceId,
      cardId: item.cardId,
      state: item.state,
      nodeId: item.nodeId,
      ownerId: item.ownerId
    }
  }

  gameSnapshot(game, playerId) {
    const player = this.requirePlayer(game, playerId)
    return {
      gameId: game.gameId,
      version: game.version,
      player: {
        playerId,
        inventory: player.inventory.map(id => this.itemView(game.items.find(item => item.instanceId === id)))
      },
      rooms: Object.values(game.rooms).map(room => ({ nodeId: room.nodeId, itemCount: this.roomItems(game, room.nodeId).filter(item => item.state !== 'IN_INVENTORY').length }))
    }
  }

  visitSnapshot(game, visit, player) {
    const roomItems = this.roomItems(game, visit.roomNodeId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
    const visibleIds = visit.observation && visit.observation.active ? visit.observation.visibleItemIds : []
    return {
      gameId: game.gameId,
      version: game.version,
      visit: clone(visit),
      room: {
        nodeId: visit.roomNodeId,
        unpickedCount: roomItems.length,
        unsearchedCount: roomItems.filter(item => !item.exposedBy.includes(visit.playerId)).length,
        canObserve: visit.status === 'ACTIVE' && roomItems.length > 0,
        visibleItems: visibleIds.map(id => this.itemView(game.items.find(item => item.instanceId === id))).filter(Boolean)
      },
      inventory: player.inventory.map(id => this.itemView(game.items.find(item => item.instanceId === id))).filter(Boolean),
      serverTime: this.now()
    }
  }
}

module.exports = {
  SEARCH_DURATION_MS,
  REVEAL_INTERVAL_MS,
  MAX_VISIBLE_ITEMS,
  BACKPACK_SLOTS,
  BOARD_SIZE,
  VAULT_NODE_ID,
  EXTRACTION_NODE_ID,
  MemorySearchStore,
  SearchGameService,
  hashSeed,
  seededRandom
}
