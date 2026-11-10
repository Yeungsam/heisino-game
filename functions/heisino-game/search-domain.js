const fs = require('node:fs')
const path = require('node:path')
const core = fs.existsSync(path.join(__dirname, '../../client/js/core/room-loot.js')) ? '../../client/js/core' : './runtime'
const { hashSeed } = require(`${core}/rng`)
const { roomLootAreas, stockRoomLoot } = require(`${core}/room-loot`)
const { isRetiredCard, removeRetiredItems, removeRetiredObservationItems } = require(`${core}/retired-cards`)

const SEARCH_DURATION_MS = 50000
const REVEAL_INTERVAL_MS = 2000
const MAX_VISIBLE_ITEMS = 30
const ROOM_AREA_CAPACITY = 30
const BACKPACK_SLOTS = 10
const BOARD_SIZE = 5
const VAULT_NODE_ID = 'n_2_2'
const EXTRACTION_NODE_ID = 'n_4_4'
const SEARCH_SCHEMA_VERSION = 2
const ROOM_AREA_IDS = Object.freeze(['LEFT_CABINET', 'MAIN_TABLE', 'RIGHT_TABLE'])
const LOADOUT_CATEGORIES = new Set(['WEAPON', 'ARMOR', 'SKILL'])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nodeId(x, y) {
  return `n_${x}_${y}`
}

function createRoom(roomNodeId) {
  return {
    nodeId: roomNodeId,
    itemIds: [],
    areas: Object.fromEntries(ROOM_AREA_IDS.map(areaId => [areaId, { areaId, itemIds: [] }]))
  }
}

function deterministicAreaId(gameId, roomNodeId, instanceId) {
  return ROOM_AREA_IDS[hashSeed(`${gameId}:${roomNodeId}:${instanceId}`) % ROOM_AREA_IDS.length]
}

function ensureSchemaV2(game) {
  game.requestResults = game.requestResults || {}
  game.visits = game.visits || {}
  game.rooms = game.rooms || {}
  game.items = game.items || []
  const retiredItems = removeRetiredItems(game)

  Object.keys(game.rooms).forEach(roomNodeId => {
    const room = game.rooms[roomNodeId]
    room.nodeId = room.nodeId || roomNodeId
    room.itemIds = Array.isArray(room.itemIds) ? room.itemIds.filter(id => !retiredItems.has(id)) : []
    room.areas = room.areas || {}
    ROOM_AREA_IDS.forEach(areaId => {
      room.areas[areaId] = room.areas[areaId] || { areaId, itemIds: [] }
      room.areas[areaId].areaId = areaId
      room.areas[areaId].itemIds = []
    })
  })

  game.items.forEach(item => {
    item.exposedBy = Array.isArray(item.exposedBy) ? item.exposedBy : []
    if (!item.nodeId || !game.rooms[item.nodeId]) {
      item.areaId = null
      return
    }
    const room = game.rooms[item.nodeId]
    if (!room.itemIds.includes(item.instanceId)) room.itemIds.push(item.instanceId)
    if (!ROOM_AREA_IDS.includes(item.areaId)) item.areaId = deterministicAreaId(game.gameId, item.nodeId, item.instanceId)
    if (!room.areas[item.areaId].itemIds.includes(item.instanceId)) room.areas[item.areaId].itemIds.push(item.instanceId)
  })
  Object.values(game.visits).forEach(visit => {
    removeRetiredObservationItems(visit, retiredItems)
    const observation = visit && visit.observation
    if (!observation || ROOM_AREA_IDS.includes(observation.areaId)) return
    observation.areaId = null
    observation.active = false
    observation.visibleItemIds = []
    observation.newlyExposedItemIds = []
    observation.initialVisibleCount = 0
  })
  game.schemaVersion = SEARCH_SCHEMA_VERSION
  return game
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
    this.loadoutCardIds = new Set(this.cards.filter(isLoadoutCard).map(cardIdOf).filter(id => !isRetiredCard(id)))
    this.store = options.store || new MemorySearchStore()
    this.now = options.now || (() => Date.now())
    if (!this.cards.some(isLootCard)) throw error('LOOT_CATALOG_EMPTY', 500)
  }

  addItem(game, cardId, roomNodeId, areaId, state, ownerId = null) {
    const item = {
      instanceId: `${game.gameId}-item-${game.itemSequence++}`, cardId, state,
      nodeId: roomNodeId, areaId, ownerId, exposedBy: [], createdAt: this.now()
    }
    game.items.push(item)
    if (roomNodeId) {
      const room = game.rooms[roomNodeId]
      room.itemIds.push(item.instanceId)
      room.areas[areaId].itemIds.push(item.instanceId)
    }
    return item.instanceId
  }

  async createGame(input) {
    const gameId = String(input.gameId || '').trim()
    const playerId = String(input.playerId || '').trim()
    if (!gameId || !playerId) throw error('INVALID_GAME_IDENTITY')
    const existing = await this.store.get(gameId)
    if (existing) return this.mutate(gameId, null, game => this.gameSnapshot(game, playerId), { allowNoWrite: true })

    const lootSeed = hashSeed(input.seed || gameId)
    const rooms = {}
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const roomNodeId = nodeId(x, y)
        rooms[roomNodeId] = createRoom(roomNodeId)
        rooms[roomNodeId].lootAreas = roomLootAreas(roomNodeId, lootSeed, ROOM_AREA_IDS)
      }
    }

    const loadoutCardIds = Array.isArray(input.loadoutCardIds) ? input.loadoutCardIds : []
    const game = {
      gameId,
      schemaVersion: SEARCH_SCHEMA_VERSION,
      version: 1,
      createdAt: this.now(),
      itemSequence: 1,
      lootSeed,
      items: [],
      rooms,
      players: {},
      visits: {},
      requestResults: {}
    }
    const inventory = loadoutCardIds.filter(cardId => this.loadoutCardIds.has(cardId)).slice(0, BACKPACK_SLOTS)
      .map(cardId => this.addItem(game, cardId, null, null, 'IN_INVENTORY', playerId))
    game.players[playerId] = { playerId, inventory }
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
      // Older games already contain their room items. Only an unconsumed plan can create new items.
      if (room.lootAreas) {
        stockRoomLoot(room.nodeId, game.lootSeed, room.lootAreas, (cardId, areaId) => {
          this.addItem(game, cardId, room.nodeId, areaId, 'HIDDEN')
        })
        delete room.lootAreas
      }
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
      const areaId = String(input.areaId || '')
      if (!ROOM_AREA_IDS.includes(areaId)) throw error('AREA_NOT_FOUND', 404)
      const areaItems = this.areaItems(game, visit.roomNodeId, areaId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
      const visibleItemIds = areaItems
        .filter(item => item.exposedBy.includes(input.playerId))
        .slice(0, MAX_VISIBLE_ITEMS)
        .map(item => item.instanceId)
      visit.observation = {
        areaId,
        startedAt: this.now(),
        initialVisibleCount: visibleItemIds.length,
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
      const item = game.items.find(candidate => candidate.instanceId === input.instanceId)
      if (!item || item.nodeId !== visit.roomNodeId || item.areaId !== visit.observation.areaId || !['EXPOSED', 'DROPPED'].includes(item.state)) throw error('ITEM_UNAVAILABLE', 409)
      if (player.inventory.length >= BACKPACK_SLOTS) throw error('BACKPACK_FULL')
      item.state = 'IN_INVENTORY'
      item.nodeId = null
      item.areaId = null
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
      const areaId = visit.observation.areaId
      if (this.areaItems(game, visit.roomNodeId, areaId).filter(candidate => candidate.state !== 'IN_INVENTORY' && candidate.state !== 'DESTROYED').length >= ROOM_AREA_CAPACITY) throw error('AREA_FULL', 409)
      const item = game.items.find(candidate => candidate.instanceId === input.instanceId)
      if (!item || item.ownerId !== input.playerId || !player.inventory.includes(item.instanceId)) throw error('ITEM_NOT_OWNED')
      player.inventory = player.inventory.filter(id => id !== item.instanceId)
      item.state = 'DROPPED'
      item.ownerId = null
      item.nodeId = visit.roomNodeId
      item.areaId = areaId
      if (!item.exposedBy.includes(input.playerId)) item.exposedBy.push(input.playerId)
      if (!game.rooms[visit.roomNodeId].itemIds.includes(item.instanceId)) game.rooms[visit.roomNodeId].itemIds.push(item.instanceId)
      if (!game.rooms[visit.roomNodeId].areas[areaId].itemIds.includes(item.instanceId)) game.rooms[visit.roomNodeId].areas[areaId].itemIds.push(item.instanceId)
      if (!visit.observation.visibleItemIds.includes(item.instanceId)) visit.observation.visibleItemIds.push(item.instanceId)
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
      const before = JSON.stringify(game)
      ensureSchemaV2(game)
      const cached = requestId && game.requestResults[requestId]
      if (cached && ![...(cached.inventory || []), ...(cached.room?.visibleItems || [])].some(item => isRetiredCard(item.cardId))) return clone(cached)
      const expectedVersion = game.version
      // A legacy response may contain retired items. Refresh the view without replaying the action.
      const result = cached
        ? this.visitSnapshot(game, this.requireVisit(game, cached.visit.visitId, cached.visit.playerId), this.requirePlayer(game, cached.visit.playerId))
        : operation(game)
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
    const areaId = observation.areaId
    const areaItems = this.areaItems(game, visit.roomNodeId, areaId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
    const targetCount = Math.min(MAX_VISIBLE_ITEMS, areaItems.length, (observation.initialVisibleCount || 0) + Math.max(0, elapsedIntervals))
    while (observation.visibleItemIds.length < targetCount) {
      const hidden = areaItems.find(item => !item.exposedBy.includes(visit.playerId) && !observation.visibleItemIds.includes(item.instanceId))
      if (!hidden) break
      if (hidden.state === 'HIDDEN') hidden.state = 'EXPOSED'
      if (!hidden.exposedBy.includes(visit.playerId)) hidden.exposedBy.push(visit.playerId)
      observation.visibleItemIds.push(hidden.instanceId)
      observation.newlyExposedItemIds.push(hidden.instanceId)
    }
  }

  roomItems(game, roomNodeId) {
    const room = game.rooms[roomNodeId]
    return room.itemIds.map(id => game.items.find(item => item.instanceId === id)).filter(item => item && item.nodeId === roomNodeId)
  }

  areaItems(game, roomNodeId, areaId) {
    const room = game.rooms[roomNodeId]
    const area = room && room.areas && room.areas[areaId]
    if (!area) return []
    return area.itemIds.map(id => game.items.find(item => item.instanceId === id)).filter(item => item && item.nodeId === roomNodeId && item.areaId === areaId)
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
      areaId: item.areaId,
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
      schemaVersion: game.schemaVersion,
      rooms: Object.values(game.rooms).map(room => ({
        nodeId: room.nodeId,
        itemCount: room.lootAreas?.length ?? this.roomItems(game, room.nodeId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED').length,
        areas: ROOM_AREA_IDS.map(areaId => ({
          areaId,
          itemCount: room.lootAreas?.filter(plannedArea => plannedArea === areaId).length
            ?? this.areaItems(game, room.nodeId, areaId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED').length
        }))
      }))
    }
  }

  visitSnapshot(game, visit, player) {
    const roomItems = this.roomItems(game, visit.roomNodeId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
    const visibleIds = visit.observation && visit.observation.active ? visit.observation.visibleItemIds : []
    const activeAreaId = visit.observation && visit.observation.active ? visit.observation.areaId : null
    const activeAreaItems = activeAreaId ? this.areaItems(game, visit.roomNodeId, activeAreaId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED') : []
    return {
      gameId: game.gameId,
      version: game.version,
      visit: clone(visit),
      room: {
        nodeId: visit.roomNodeId,
        unpickedCount: roomItems.length,
        unsearchedCount: roomItems.filter(item => !item.exposedBy.includes(visit.playerId)).length,
        canObserve: visit.status === 'ACTIVE',
        activeAreaId,
        areas: ROOM_AREA_IDS.map(areaId => {
          const items = this.areaItems(game, visit.roomNodeId, areaId).filter(item => item.state !== 'IN_INVENTORY' && item.state !== 'DESTROYED')
          return {
            areaId,
            itemCount: items.length,
            unsearchedCount: items.filter(item => !item.exposedBy.includes(visit.playerId)).length
          }
        }),
        activeArea: activeAreaId ? {
          areaId: activeAreaId,
          capacity: ROOM_AREA_CAPACITY,
          itemCount: activeAreaItems.length,
          unsearchedCount: activeAreaItems.filter(item => !item.exposedBy.includes(visit.playerId)).length,
          visibleItems: visibleIds.map(id => this.itemView(game.items.find(item => item.instanceId === id))).filter(Boolean)
        } : null,
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
  ROOM_AREA_CAPACITY,
  ROOM_AREA_IDS,
  SEARCH_SCHEMA_VERSION,
  BACKPACK_SLOTS,
  BOARD_SIZE,
  VAULT_NODE_ID,
  EXTRACTION_NODE_ID,
  MemorySearchStore,
  SearchGameService
}
