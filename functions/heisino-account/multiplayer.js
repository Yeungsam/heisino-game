const crypto = require('node:crypto')
const { constants: C } = require('./runtime')
const { fault } = require('./wechat')

const WAIT_MS = 10 * 60 * 1000
const SPAWNS = [{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 0 }]
const LOBBY_ACTIONS = ['list', 'create', 'join', 'leave', 'start']
const SYNC_ACTIONS = ['me', 'resume', 'heartbeat', 'suspend', 'game', 'acknowledge', 'start']
const fingerprintOf = fields => crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')

function requireSuccess(result) {
  if (!result.ok) throw fault(result.reason, 409)
}

function summary(room) {
  return { roomId: room.roomId, name: room.name, status: room.status, playerCount: room.playerCount,
    capacity: C.PLAYER_LIMIT, createdAt: room.createdAt, expiresAt: room.expiresAt }
}

function roomView(room, accountId) {
  if (!room || room.status !== 'WAITING') return null
  return { ...summary(room), isHost: room.members[0].accountId === accountId,
    members: room.members.map((member, index) => ({ nickname: member.nickname, isHost: index === 0, isSelf: member.accountId === accountId })) }
}

function publicState(engine, playerId, visit) {
  const state = engine.snapshot()
  const alias = id => id === playerId ? 'P1' : id === 'P1' ? playerId : id
  const visible = visit?.observation?.active ? new Set(visit.observation.visibleItemIds) : new Set()
  delete state.nextItemSequence
  state.searchAccess = { P1: [] }
  state.players = state.players.map(player => player.id === playerId ? { ...player, id: 'P1' } : {
    id: alias(player.id), name: player.name, hp: player.hp, maxHp: player.maxHp, status: player.status,
    ...(engine.phase === 'MOVE_SELECTION' ? {} : { position: player.position, previousPosition: player.previousPosition }), inventory: [],
    equippedWeaponId: null, extractionRequestedTurn: null
  })
  state.items = state.items.filter(item => item.ownerId === playerId || visible.has(item.instanceId))
    .map(item => ({ ...item, ownerId: alias(item.ownerId), revealedBy: item.revealedBy === playerId ? 'P1' : null }))
  state.encounters = state.encounters.filter(event => event.type === 'BATTLE' && event.playerIds.includes(playerId))
    .map(event => ({ ...event, playerIds: event.playerIds.map(alias), winnerId: alias(event.winnerId), loserId: alias(event.loserId) }))
  return state
}

class Multiplayer {
  constructor(account) {
    this.account = account
    this.store = account.store
    this.now = account.now
  }

  async caller(tx, accountId, token) {
    const document = await tx.account(accountId)
    if (!document) throw fault('UNAUTHENTICATED', 401)
    this.account.authenticate(document, token)
    return document
  }

  saveAccount(tx, document) {
    document.version += 1
    tx.saveAccount(document)
  }

  response(document, activeGame = null, lobbyRoom = null) {
    return this.account.accountResponse(document, activeGame, lobbyRoom, document.version)
  }

  close(room) {
    room.status = 'CLOSED'
    room.listUntil = 0
  }

  async waitingRoom(tx, document, now) {
    if (!document.lobbyRoomId) return null
    const room = await tx.room(document.lobbyRoomId)
    if (room?.status === 'WAITING' && room.expiresAt > now && room.members.some(member => member.accountId === document.accountId)) return room
    if (room?.status === 'WAITING' && room.expiresAt <= now) {
      this.close(room)
      tx.saveRoom(room)
    }
    document.lobbyRoomId = null
    this.saveAccount(tx, document)
    return null
  }

  async lobby(accountId, token, input) {
    const op = input.op || 'list'
    if (!LOBBY_ACTIONS.includes(op)) throw fault('INVALID_ACTION')
    const requestId = op === 'list' ? null : this.account.requestId(input)
    const fingerprint = fingerprintOf([op, input.roomId, input.cardIds])
    let appId
    const response = await this.store.transactRoom(async tx => {
      const document = await this.caller(tx, accountId, token)
      appId = document.appId
      if (!document.profileComplete) throw fault('PROFILE_REQUIRED', 409)
      if (document.activeGame?.mode === 'MULTIPLAYER') {
        if (op === 'list' || document.lobbyRequests?.[requestId] === fingerprint) return this.playing(tx, document, 'resume', {})
        throw fault('ACTIVE_GAME_EXISTS', 409)
      }
      if (document.activeGame) throw fault('ACTIVE_GAME_EXISTS', 409)
      const now = this.now()
      let room = await this.waitingRoom(tx, document, now)
      if (op === 'list') return this.response(document, null, roomView(room, accountId))
      const prior = document.lobbyRequests && Object.hasOwn(document.lobbyRequests, requestId) ? document.lobbyRequests[requestId] : null
      if (prior) {
        if (prior !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
        return this.response(document, null, roomView(room, accountId))
      }
      if (op === 'create' || op === 'join') {
        if (room) throw fault('ALREADY_IN_ROOM', 409)
        this.account.assertOwned(document, this.account.loadoutCounts(input.cardIds))
        if (op === 'create') {
          const roomId = crypto.randomUUID()
          await tx.room(roomId)
          room = { roomId, appId: document.appId, name: `${document.nickname}的房间`, status: 'WAITING',
            createdAt: now, expiresAt: now + WAIT_MS, listUntil: now + WAIT_MS, members: [] }
        } else {
          if (typeof input.roomId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.roomId)) throw fault('ROOM_NOT_FOUND', 409)
          room = await tx.room(input.roomId)
          if (!room || room.appId !== document.appId || room.status === 'CLOSED' || room.expiresAt <= now && room.status === 'WAITING') throw fault('ROOM_NOT_FOUND', 409)
          if (room.status !== 'WAITING') throw fault('ROOM_IN_GAME', 409)
          if (room.members.length >= C.PLAYER_LIMIT) throw fault('ROOM_FULL', 409)
        }
        room.members.push({ accountId, nickname: document.nickname, cardIds: input.cardIds.slice() })
        room.playerCount = room.members.length
        document.lobbyRoomId = room.roomId
        tx.saveRoom(room)
      } else {
        if (!room || input.roomId !== room.roomId) throw fault('ROOM_NOT_FOUND', 409)
        if (op === 'leave') {
          room.members = room.members.filter(member => member.accountId !== accountId)
          room.playerCount = room.members.length
          if (!room.playerCount) this.close(room)
          else room.name = `${room.members[0].nickname}的房间`
          tx.saveRoom(room)
          document.lobbyRoomId = null
          room = null
        } else {
          if (room.members[0].accountId !== accountId) throw fault('HOST_REQUIRED', 409)
          if (room.members.length < 2) throw fault('NOT_ENOUGH_PLAYERS', 409)
          await this.start(tx, room, document, now)
        }
      }
      const requests = { ...document.lobbyRequests, [requestId]: fingerprint }
      document.lobbyRequests = Object.fromEntries(Object.entries(requests).slice(-50))
      this.saveAccount(tx, document)
      return document.activeGame ? this.gameResponse(document, room) : this.response(document, null, roomView(room, accountId))
    })
    if (op === 'list' && !response.activeGame) {
      const rooms = await this.store.listRooms(appId, this.now())
      response.rooms = rooms.map(summary).sort((a, b) => b.playerCount - a.playerCount || a.createdAt - b.createdAt || a.roomId.localeCompare(b.roomId))
    }
    return response
  }

  async start(tx, room, host, now) {
    const game = {
      gameId: room.roomId, mode: 'MULTIPLAYER', rngState: crypto.randomBytes(4).readUInt32BE(), state: null,
      moveSelections: {}, done: [], visits: {}, requests: {}, seen: {}
    }
    const engine = this.account.restore(game)
    for (let index = 0; index < room.members.length; index += 1) {
      const member = room.members[index]
      const document = member.accountId === host.accountId ? host : await tx.account(member.accountId)
      if (!document || document.activeGame || document.lobbyRoomId !== room.roomId) throw fault('ROOM_CHANGED', 409)
      member.playerId = `P${index + 1}`
      game.seen[member.playerId] = now
      this.account.deploy(document, { gameId: game.gameId, mode: game.mode, playerId: member.playerId }, this.account.loadoutCounts(member.cardIds))
      document.lobbyRoomId = null
      if (document !== host) this.saveAccount(tx, document)
    }
    engine.now = () => now
    engine.start(room.members.map((member, index) => ({ id: member.playerId, name: member.nickname, ...SPAWNS[index], cardIds: member.cardIds })))
    game.state = engine.snapshot()
    room.game = game
    room.status = 'PLAYING'
    room.listUntil = now + C.MAX_TURNS * (C.MOVE_SELECTION_MS + C.SEARCH_DURATION_MS)
    tx.saveRoom(room)
  }

  async sync(accountId, token, action, input) {
    if (!SYNC_ACTIONS.includes(action)) throw fault('NOT_FOUND', 404)
    return this.store.transactRoom(async tx => {
      const document = await this.caller(tx, accountId, token)
      if (document.activeGame?.mode === 'MULTIPLAYER') return this.playing(tx, document, action, input)
      if (action === 'start' && document.activeGame) throw fault('ACTIVE_GAME_EXISTS', 409)
      if (action === 'game' && document.lastSettlement?.gameId !== input.gameId) throw fault('NO_ACTIVE_GAME', 409)
      const room = await this.waitingRoom(tx, document, this.now())
      if (action === 'start') {
        this.account.start(document, input)
        this.saveAccount(tx, document)
      }
      if (action === 'acknowledge' && document.lastSettlement) {
        document.lastSettlement.acknowledged = true
        this.saveAccount(tx, document)
      }
      return document.activeGame ? this.account.response(document, document.version) : this.response(document, null, roomView(room, accountId))
    })
  }

  async playing(tx, document, action, input) {
    const { gameId, playerId } = document.activeGame
    if (action === 'start') throw fault('ACTIVE_GAME_EXISTS', 409)
    if (action === 'game' && input.gameId !== gameId) throw fault('GAME_MISMATCH', 409)
    const room = await tx.room(gameId)
    if (!room?.game) throw fault('NO_ACTIVE_GAME', 409)
    const game = room.game
    const engine = this.account.restore(game)
    engine.moveSelections = game.moveSelections
    const now = this.now()
    this.advance(game, engine, now)
    if (engine.getPlayer(playerId).status === 'ACTIVE') {
      game.seen[playerId] = now
      if (action === 'game') this.act(game, engine, playerId, input, now)
      this.account.reveal(engine, game.visits[playerId], playerId)
      this.advance(game, engine, now)
    }
    game.moveSelections = engine.moveSelections
    game.state = engine.snapshot()
    for (const member of room.members) {
      const player = engine.getPlayer(member.playerId)
      if (player.status === 'ACTIVE') continue
      const owner = member.accountId === document.accountId ? document : await tx.account(member.accountId)
      if (!owner || owner.activeGame?.gameId !== gameId) continue
      this.account.settle(owner, engine, game.ended?.[member.playerId] ?? now, member.playerId, publicState(engine, member.playerId, null))
      this.saveAccount(tx, owner)
    }
    room.playerCount = engine.activePlayers().length
    if (!room.playerCount) this.close(room)
    tx.saveRoom(room)
    return this.gameResponse(document, room, engine)
  }

  endPlayer(game, engine, player, status, at) {
    player.status = status
    game.ended = { ...game.ended, [player.id]: at }
    delete game.visits[player.id]
    delete engine.moveSelections[player.id]
  }

  advance(game, engine, now) {
    while (engine.phase !== 'GAME_OVER') {
      const players = engine.activePlayers()
      if (!players.length) { engine.phase = 'GAME_OVER'; return }
      const moving = engine.phase === 'MOVE_SELECTION'
      const complete = players.every(player => moving ? engine.moveSelections[player.id] : game.done.includes(player.id))
      const deadline = moving ? engine.moveDeadlineAt : engine.turnDeadlineAt
      const phaseAt = complete ? Math.min(now, deadline) : deadline
      const disconnectedAt = Math.min(...players.map(player => game.seen[player.id] + WAIT_MS))
      if (disconnectedAt <= now && disconnectedAt <= phaseAt) {
        for (const player of players) {
          if (game.seen[player.id] + WAIT_MS <= disconnectedAt) this.endPlayer(game, engine, player, 'DISCONNECTED', disconnectedAt)
        }
        continue
      }
      if (phaseAt > now) return
      engine.now = () => phaseAt
      if (moving) {
        requireSuccess(engine.resolveMoves())
        engine.phase = 'SEARCH'
        engine.turnDeadlineAt = phaseAt + C.SEARCH_DURATION_MS
        game.visits = Object.fromEntries(engine.activePlayers().map(player => [
          player.id, { ...this.account.createVisit(game, engine, player.id), startedAt: phaseAt }
        ]))
        for (const player of players) if (player.status !== 'ACTIVE') this.endPlayer(game, engine, player, player.status, phaseAt)
      } else {
        requireSuccess(engine.finishTurn())
        game.done = []
        game.visits = {}
        for (const player of players) if (player.status !== 'ACTIVE') this.endPlayer(game, engine, player, player.status, phaseAt)
      }
    }
  }

  act(game, engine, playerId, input, now) {
    const requestId = this.account.requestId(input)
    const fingerprint = fingerprintOf([input.action, input.turn, input.target, input.areaId, input.instanceId])
    const requests = game.requests[playerId] || {}
    if (Object.hasOwn(requests, requestId)) {
      if (requests[requestId] !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
      return
    }
    if (input.action === 'abandon') this.endPlayer(game, engine, engine.getPlayer(playerId), 'ABANDONED', now)
    else {
      if (input.turn !== engine.turn) throw fault('STALE_TURN', 409)
      if (input.action === 'move') {
        if (engine.moveSelections[playerId]) throw fault('MOVE_ALREADY_SUBMITTED', 409)
        requireSuccess(engine.submitMove(playerId, input.target || {}))
      } else {
        const visit = game.visits[playerId]
        if (engine.phase !== 'SEARCH' || !visit || game.done.includes(playerId)) throw fault('INVALID_PHASE', 409)
        if (input.action === 'leave' || input.action === 'extract') {
          if (input.action === 'extract') requireSuccess(engine.requestExtraction(playerId))
          game.done.push(playerId)
          delete game.visits[playerId]
        } else {
          this.account.reveal(engine, visit, playerId)
          this.account.searchAction(engine, visit, playerId, input)
        }
      }
    }
    game.requests[playerId] = Object.fromEntries(Object.entries({ ...requests, [requestId]: fingerprint }).slice(-200))
  }

  gameResponse(document, room, engine) {
    if (!document.activeGame) return this.response(document)
    const { playerId, gameId, mode } = document.activeGame
    const game = room.game
    const state = engine || this.account.restore(game)
    const visit = game.visits[playerId]
    const waiting = state.phase === 'MOVE_SELECTION' && game.moveSelections[playerId] ? 'MOVES' :
      state.phase === 'SEARCH' && game.done.includes(playerId) ? 'ROUND' : null
    return this.response(document, { gameId, mode, state: publicState(state, playerId, visit),
      search: this.account.searchView(state, visit, playerId), waiting, resumeUntil: game.seen[playerId] + WAIT_MS })
  }
}

module.exports = { Multiplayer }
