const crypto = require('node:crypto')
const { GameEngine, positionKey, cards, constants: C, RETIRED_CARD_IDS, isRetiredCard, removeRetiredItems, removeRetiredObservationItems } = require('./runtime')
const { fault, accountIdFor, validateNickname, validateAvatar } = require('./wechat')
const { Multiplayer } = require('./multiplayer')
const Battle = require('./combat-round')
const starter = require('./starter.json')
const RESUME_MS = 10 * 60 * 1000
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const AREAS = ['LEFT_CABINET', 'MAIN_TABLE', 'RIGHT_TABLE']
const clone = value => JSON.parse(JSON.stringify(value))
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const SPAWNS = Object.freeze([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 0 }])
const SHARED_GAME = Symbol('shared-game')

function automaticWinner(left, right, rng, forceLeft) {
  const leftWins = forceLeft || rng() < 0.5
  return { winnerId: leftWins ? left.id : right.id, loserId: leftWins ? right.id : left.id,
    leftHp: leftWins ? left.hp : 0, rightHp: leftWins ? 0 : right.hp, rounds: [] }
}

function must(result) { if (!result.ok) throw fault(result.reason, 409); return result }

class AccountService {
  constructor(options) {
    this.store = options.store
    this.identity = options.identity
    this.now = options.now || Date.now
    this.cards = (options.cards || cards).filter(card => !isRetiredCard(card.cardId))
    this.cardMap = Object.fromEntries(this.cards.map(card => [card.cardId, card]))
    this.blueBotEquipment = ['WEAPON', 'ARMOR'].map(category => this.cards.find(card => card.rarity === 'BLUE' && card.category === category)?.cardId).filter(Boolean)
    this.multiplayer = new Multiplayer(this)
  }

  async mutate(accountId, callback) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = await this.store.get(accountId)
      if (!document) throw fault('UNAUTHENTICATED', 401)
      this.removeRetiredQuantities(document)
      const result = await callback(document)
      const version = document.version
      document.version += 1
      if (await this.store.replace(document, version)) return result
    }
    throw fault('ACCOUNT_BUSY', 409)
  }

  removeRetiredQuantities(document) {
    let changed = false
    for (const id of RETIRED_CARD_IDS) {
      if (!Object.hasOwn(document.quantities, id)) continue
      delete document.quantities[id]
      changed = true
    }
    return changed
  }

  profile(document) {
    return { accountId: document.accountId, nickname: document.nickname, avatarUrl: document.avatarUrl,
      profileComplete: document.profileComplete, gold: document.gold, quantities: clone(document.quantities), starterVersion: document.starterVersion }
  }

  async login(code) {
    const identity = await this.identity.exchange(code)
    const accountId = accountIdFor(identity.appId, identity.openid)
    await this.store.create({
      accountId, openid: identity.openid, appId: identity.appId, version: 1,
      nickname: '', avatarUrl: '', profileComplete: false, gold: starter.gold,
      quantities: clone(starter.cards), starterVersion: starter.version,
      createdAt: this.now(), sessions: [], activeGame: null, lastSettlement: null,
      ledger: [{ entryId: `${accountId}-STARTER-${starter.version}`, accountId, type: 'STARTER', at: this.now(), quantities: clone(starter.cards), goldDelta: starter.gold }], startRequests: []
    })
    const secret = crypto.randomBytes(32).toString('base64url')
    const token = `${accountId}.${secret}`
    const expiresAt = this.now() + SESSION_MS
    const response = await this.mutate(accountId, document => {
      document.sessions = document.sessions.filter(session => session.expiresAt > this.now()).slice(-4)
      document.sessions.push({ hash: digest(token), expiresAt })
      document.lastLoginAt = this.now()
      if (document.activeGame?.mode === 'MULTIPLAYER' || document.lobbyRoomId) return null
      this.advance(document, true)
      return this.response(document)
    })
    const state = response || await this.execute(token, 'resume')
    return { token, expiresAt, ...state }
  }

  authenticate(document, token) {
    if (!document.sessions.some(session => session.expiresAt > this.now() && session.hash === digest(token))) throw fault('UNAUTHENTICATED', 401)
  }

  async execute(token, action, input = {}) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(token)) throw fault('UNAUTHENTICATED', 401)
    const accountId = token.split('.')[0]
    if (action === 'lobby') return this.multiplayer.lobby(accountId, token, input)
    // Moderation is done before the transaction, but still requires a valid session.
    let checkedProfile = null
    if (action === 'profile') {
      const current = await this.store.get(accountId)
      if (!current) throw fault('UNAUTHENTICATED', 401)
      this.authenticate(current, token)
      const nickname = validateNickname(input.nickname)
      const avatarUrl = validateAvatar(input.avatarUrl)
      await this.identity.moderate(nickname, current.openid)
      checkedProfile = { nickname, avatarUrl }
    }
    return this.mutate(accountId, document => {
      this.authenticate(document, token)
      if (document.activeGame?.mode === 'MULTIPLAYER' || (document.lobbyRoomId && ['resume', 'me', 'start'].includes(action))) throw SHARED_GAME
      this.advance(document, action === 'resume' || action === 'me')
      if (action === 'profile') {
        if (document.profileComplete && (document.nickname !== checkedProfile.nickname || document.avatarUrl !== checkedProfile.avatarUrl)) throw fault('PROFILE_ALREADY_CREATED', 409)
        Object.assign(document, checkedProfile, { profileComplete: true })
      } else if (action === 'acknowledge') {
        this.acknowledge(document, input.settlementId)
      } else if (action === 'start') this.start(document, input)
      else if (action === 'game') this.gameAction(document, input)
      else if (!['me', 'resume', 'heartbeat', 'suspend'].includes(action)) throw fault('NOT_FOUND', 404)
      if (document.activeGame) {
        document.activeGame.lastSeenAt = this.now()
        if (action === 'suspend') document.activeGame.suspendedAt = this.now()
      }
      return this.response(document)
    }).catch(error => {
      if (error === SHARED_GAME) return this.multiplayer.sync(accountId, token, action, input)
      throw error
    })
  }

  acknowledge(document, settlementId) {
    const settlement = document.lastSettlement
    if (!settlement || settlement.acknowledged) return false
    const legacyRequest = settlementId === undefined && !['MULTIPLAYER', 'SINGLE'].includes(settlement.mode)
    if (!legacyRequest && settlementId !== (settlement.settlementId || settlement.gameId)) return false
    settlement.acknowledged = true
    return true
  }

  restore(game) {
    const engine = new GameEngine({ cards: this.cards, now: this.now,
      localPlayerId: game.mode === 'MULTIPLAYER' ? null : 'P1',
      equipmentLimit: game.combatVersion === Battle.VERSION,
      deferCombat: game.combatVersion === Battle.VERSION ? encounter => { game.encounter = encounter } : undefined,
      battleResolver: ['SINGLE', 'MULTIPLAYER'].includes(game.mode) ? (left, right, rng) => automaticWinner(left, right, rng, game.mode === 'SINGLE') : undefined,
      rng: () => {
        game.rngState = (Math.imul(game.rngState, 1664525) + 1013904223) >>> 0
        return game.rngState / 0x100000000
      } })
    if (game.state) {
      Object.assign(engine, clone(game.state))
      const removed = removeRetiredItems(engine)
      removeRetiredObservationItems(game.visit, removed)
      for (const visit of Object.values(game.visits || {})) removeRetiredObservationItems(visit, removed)
    }
    return engine
  }

  start(document, input) {
    if (!document.profileComplete) throw fault('PROFILE_REQUIRED', 409)
    const requestId = this.requestId(input)
    const cardIds = input.cardIds
    const combatVersion = input.mode === 'SINGLE' && input.combatVersion === Battle.VERSION ? Battle.VERSION : undefined
    const fingerprint = digest(JSON.stringify({ cardIds, mode: input.mode || 'STANDARD', combatVersion }))
    const prior = document.startRequests.find(request => request.id === requestId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
      return
    }
    const counts = this.loadoutCounts(cardIds, combatVersion)
    if (document.activeGame) throw fault('ACTIVE_GAME_EXISTS', 409)
    if (document.lobbyRoomId) throw fault('ALREADY_IN_ROOM', 409)
    if (!['STANDARD', 'SINGLE_TEST', 'SINGLE'].includes(input.mode || 'STANDARD')) throw fault('MODE_INVALID')
    const game = {
      gameId: crypto.randomUUID(), mode: input.mode || 'STANDARD', createdAt: this.now(), lastSeenAt: this.now(),
      rngState: crypto.randomBytes(4).readUInt32BE(), requests: {}, state: null, visit: null
    }
    if (combatVersion) Object.assign(game, { combatVersion, visits: {} })
    const engine = this.restore(game)
    engine.localLoadoutCardIds = cardIds.slice()
    if (game.mode === 'SINGLE') {
      game.botCheckedRooms = []
      engine.start([{ id: 'P1', name: document.nickname, ...SPAWNS[0], cardIds }])
    } else engine.start()
    engine.getPlayer('P1').name = document.nickname
    game.state = engine.snapshot()
    this.deploy(document, game, counts)
    document.startRequests.push({ id: requestId, fingerprint, gameId: game.gameId })
    document.startRequests = document.startRequests.slice(-100)
  }

  loadoutCounts(cardIds, combatVersion) {
    if (!Array.isArray(cardIds) || cardIds.length > C.LOADOUT_CARD_LIMIT || cardIds.some(id => typeof id !== 'string' || !this.cardMap[id] || !['WEAPON', 'ARMOR', 'SKILL'].includes(this.cardMap[id].category))) throw fault('LOADOUT_INVALID')
    const counts = {}
    if (combatVersion === Battle.VERSION) {
      for (const category of ['WEAPON', 'ARMOR']) {
        if (cardIds.filter(id => this.cardMap[id].category === category).length > 1) throw fault(`${category}_LIMIT`, 409)
      }
    }
    cardIds.forEach(id => { counts[id] = (counts[id] || 0) + 1 })
    return counts
  }

  assertOwned(document, counts) {
    Object.entries(counts).forEach(([id, count]) => { if ((document.quantities[id] || 0) < count) throw fault('NOT_OWNED', 409) })
  }

  deploy(document, game, counts) {
    this.assertOwned(document, counts)
    Object.entries(counts).forEach(([id, count]) => { document.quantities[id] -= count })
    document.activeGame = game
    document.lastSettlement = null
    this.ledger(document, { type: 'DEPLOY', gameId: game.gameId, mode: game.mode, quantities: Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, -count])) })
  }

  requestId(input) {
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(input.requestId)) throw fault('REQUEST_ID_REQUIRED')
    return input.requestId
  }

  advance(document, resume = false) {
    const game = document.activeGame
    if (!game) return
    const gap = this.now() - game.lastSeenAt
    if (gap >= RESUME_MS) {
      const engine = this.restore(game)
      engine.getPlayer('P1').status = 'DISCONNECTED'
      engine.phase = 'GAME_OVER'
      game.state = engine.snapshot()
      this.settle(document, engine, game.lastSeenAt + RESUME_MS)
      return
    }
    if (resume || gap > 30000 || game.suspendedAt !== undefined) {
      const pause = game.suspendedAt !== undefined ? this.now() - game.suspendedAt : gap > 30000 ? gap : 0
      if (pause > 0 && !game.combat) {
        for (const key of ['moveDeadlineAt', 'turnDeadlineAt']) if (Number.isFinite(game.state[key])) game.state[key] += pause
        if (game.visit) {
          game.visit.deadlineAt += pause
          if (game.visit.observation) game.visit.observation.startedAt += pause
        }
        if (game.combatVersion === Battle.VERSION) {
          for (const visit of Object.values(game.visits)) {
            visit.deadlineAt += pause
            if (visit.observation) visit.observation.startedAt += pause
          }
        }
      }
      delete game.suspendedAt
      game.lastSeenAt = this.now()
    }
    const engine = this.restore(game)
    if (engine.phase === 'MOVE_SELECTION' && this.now() >= engine.moveDeadlineAt) this.move(engine, game, engine.getPlayer('P1').position)
    if (game.combatVersion === Battle.VERSION && engine.phase === 'SEARCH') this.advanceSoloActions(game, engine)
    if (game.visit && this.now() >= game.visit.deadlineAt && engine.phase !== 'GAME_OVER') {
      must(engine.finishTurn())
      game.visit = null
    }
    game.state = engine.snapshot()
    if (engine.phase === 'GAME_OVER') this.settle(document, engine)
  }

  move(engine, game, target) {
    if (game.mode === 'SINGLE') engine.players = engine.players.filter(player => !player.isBot)
    must(engine.submitMove('P1', target))
    engine.submitBotMoves()
    must(engine.resolveMoves())
    if (engine.getPlayer('P1').status !== 'ACTIVE') {
      engine.phase = 'GAME_OVER'
      return
    }
    if (game.mode === 'SINGLE') this.singleEncounter(engine, game)
    if (game.combatVersion === Battle.VERSION) {
      this.startActions(game, engine, this.now())
      return
    }
    engine.phase = 'SEARCH'
    engine.turnDeadlineAt = this.now() + C.SEARCH_DURATION_MS
    game.visit = this.createVisit(game, engine, 'P1')
  }

  createVisit(game, engine, playerId, startedAt = this.now(), deadlineAt = engine.turnDeadlineAt, kind = 'ROOM') {
    return { visitId: `${game.gameId}-${engine.turn}${kind === 'LOOT' ? '-loot' : ''}`, turn: engine.turn, roomNodeId: positionKey(engine.getPlayer(playerId).position),
      startedAt, deadlineAt, status: 'ACTIVE', observation: null, ...(kind === 'LOOT' ? { kind } : {}) }
  }

  startActions(game, engine, at) {
    engine.phase = 'SEARCH'
    engine.turnDeadlineAt = at + C.SEARCH_DURATION_MS
    game.actionStartsAt = at
    game.combat = game.encounter ? Battle.createCombat(engine, game.encounter, at) : null
    delete game.encounter
    game.visits = Object.fromEntries(engine.activePlayers()
      .filter(player => !game.combat?.playerIds.includes(player.id))
      .map(player => [player.id, this.createVisit(game, engine, player.id, at)]))
  }

  finishVisit(visit, at) {
    visit.status = 'COMPLETE'
    visit.finishedAt = at
    visit.observation = null
  }

  advanceActions(game, engine, now) {
    const combat = game.combat
    if (combat && combat.stage !== 'COMPLETE') {
      Battle.advanceCombat(combat, engine, now)
      if (combat.stage === 'COMPLETE') {
        for (const id of combat.lootPlayers) {
          const at = combat.completedAt
          game.visits[id] = this.createVisit(game, engine, id, at, at + Battle.LOOT_MS, 'LOOT')
        }
        if (combat.lootPlayers.length) engine.turnDeadlineAt = Math.max(engine.turnDeadlineAt, combat.completedAt + Battle.LOOT_MS)
      }
    }
    const visits = Object.values(game.visits)
    for (const visit of visits) {
      if (visit.status === 'ACTIVE' && visit.deadlineAt <= now) this.finishVisit(visit, visit.deadlineAt)
    }
    if (now < game.actionStartsAt || combat && combat.stage !== 'COMPLETE' || visits.some(visit => visit.status === 'ACTIVE')) return null
    return Math.max(game.actionStartsAt, combat?.completedAt ?? 0, ...visits.map(visit => visit.finishedAt))
  }

  activeVisit(game, playerId) {
    const visit = game.visits?.[playerId]
    return visit?.status === 'ACTIVE' ? visit : null
  }

  resetActions(game) {
    game.combat = null
    game.visits = {}
    game.actionStartsAt = null
  }

  advanceSoloActions(game, engine) {
    const at = this.advanceActions(game, engine, this.now())
    if (at === null) return
    this.resetActions(game)
    if (engine.getPlayer('P1').status !== 'ACTIVE') {
      engine.phase = 'GAME_OVER'
      return
    }
    engine.now = () => at
    must(engine.finishTurn())
  }

  singleEncounter(engine, game) {
    const player = engine.getPlayer('P1')
    const roomId = positionKey(player.position)
    if (roomId === C.EXTRACTION_NODE_ID || SPAWNS.some(spawn => positionKey(spawn) === roomId)) return
    if (!game.combatVersion) {
      if (game.botCheckedRooms.includes(roomId)) return
      game.botCheckedRooms.push(roomId)
    }
    if (engine.rng() >= 0.3) return
    const bot = engine.createPlayer('P2', '赌场守卫', player.position.x, player.position.y, this.blueBotEquipment)
    bot.isBot = true
    engine.players.push(bot)
    if (game.combatVersion === Battle.VERSION) {
      game.encounter = { nodeId: roomId, playerIds: [player.id, bot.id], itemIds: engine.searchAccess[player.id] || [] }
      engine.searchAccess[player.id] = []
      return
    }
    bot.diceMode = 'ATTACK'
    engine.runBattle(player, bot, roomId)
    engine.grantSearch(player.id, engine.droppedItemsAt(roomId))
  }

  reveal(engine, visit, playerId = 'P1') {
    const observation = visit && visit.observation
    if (!observation || !observation.active) return
    const allowed = engine.searchItemsFor(playerId).filter(item => item.nodeId === visit.roomNodeId && item.areaId === observation.areaId)
    const count = Math.max(0, Math.floor((Math.min(this.now(), visit.deadlineAt) - observation.startedAt) / C.SEARCH_REVEAL_INTERVAL_MS))
    const newlyVisible = observation.hiddenIds.slice(0, count)
    newlyVisible.forEach(id => {
      const item = allowed.find(unit => unit.instanceId === id)
      if (item && item.state === 'HIDDEN') { item.state = 'REVEALED'; item.revealedBy = playerId }
    })
    observation.visibleItemIds = allowed.filter(item => ['REVEALED', 'DROPPED'].includes(item.state)).map(item => item.instanceId)
  }

  gameAction(document, input) {
    const game = document.activeGame
    if (!game) {
      if (document.lastSettlement && document.lastSettlement.gameId === input.gameId) return
      throw fault('NO_ACTIVE_GAME', 409)
    }
    if (game.gameId !== input.gameId) throw fault('GAME_MISMATCH', 409)
    const requestId = this.requestId(input)
    const fingerprint = digest(JSON.stringify({ action: input.action, turn: input.turn, target: input.target, areaId: input.areaId, instanceId: input.instanceId,
      combat: Battle.ACTIONS.has(input.action) ? Battle.combatFingerprint(input) : undefined }))
    if (game.requests[requestId]) {
      if (game.requests[requestId] !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
      return
    }
    const engine = this.restore(game)
    if (input.action !== 'abandon' && input.turn !== engine.turn) throw fault('STALE_TURN', 409)
    const visit = game.combatVersion === Battle.VERSION ? this.activeVisit(game, 'P1') : game.visit
    this.reveal(engine, visit)
    if (input.action === 'move') this.move(engine, game, input.target || {})
    else if (input.action === 'abandon') {
      Battle.forfeit(game.combat, engine, 'P1', this.now())
      engine.getPlayer('P1').status = 'ABANDONED'
      engine.phase = 'GAME_OVER'
    } else if (Battle.ACTIONS.has(input.action)) Battle.combatAction(game.combat, engine, 'P1', input, this.now())
    else {
      if (!visit || engine.phase !== 'SEARCH') throw fault('INVALID_PHASE', 409)
      if (input.action === 'leave' || input.action === 'extract') {
        if (input.action === 'extract') must(engine.requestExtraction('P1'))
        if (game.combatVersion === Battle.VERSION) this.finishVisit(visit, this.now())
        else {
          must(engine.finishTurn())
          game.visit = null
        }
      } else this.searchAction(engine, visit, 'P1', input)
    }
    game.requests[requestId] = fingerprint
    if (Object.keys(game.requests).length > 200) delete game.requests[Object.keys(game.requests)[0]]
    if (game.combatVersion === Battle.VERSION && engine.phase === 'SEARCH') this.advanceSoloActions(game, engine)
    game.state = engine.snapshot()
    if (engine.phase === 'GAME_OVER') this.settle(document, engine)
  }

  searchAction(engine, visit, playerId, input) {
    const observation = visit.observation
    if (input.action === 'observe') {
      if (!AREAS.includes(input.areaId)) throw fault('AREA_NOT_FOUND', 404)
      const items = engine.searchItemsFor(playerId).filter(item => item.nodeId === visit.roomNodeId && item.areaId === input.areaId)
      visit.observation = { areaId: input.areaId, startedAt: this.now(), active: true,
        hiddenIds: visit.kind === 'LOOT' ? [] : items.filter(item => item.state === 'HIDDEN').map(item => item.instanceId),
        visibleItemIds: [] }
      if (visit.kind === 'LOOT') for (const item of items) {
        if (item.state === 'HIDDEN') { item.state = 'REVEALED'; item.revealedBy = playerId }
      }
      visit.observation.visibleItemIds = items.filter(item => item.state !== 'HIDDEN').map(item => item.instanceId)
    } else if (input.action === 'pickup') {
      if (!observation || !observation.active || !observation.visibleItemIds.includes(input.instanceId)) throw fault('ITEM_NOT_VISIBLE', 409)
      must(engine.interactWithItem(playerId, input.instanceId))
      observation.visibleItemIds = observation.visibleItemIds.filter(id => id !== input.instanceId)
    } else if (input.action === 'drop') {
      if (!observation || !observation.active) throw fault('NOT_OBSERVING', 409)
      const inArea = engine.items.filter(item => item.nodeId === visit.roomNodeId && item.areaId === observation.areaId)
      if (inArea.length >= C.SEARCH_AREA_CAPACITY) throw fault('AREA_FULL', 409)
      must(engine.dropItem(playerId, input.instanceId, observation.areaId))
      const item = engine.items.find(unit => unit.instanceId === input.instanceId)
      engine.grantSearch(playerId, [item])
      observation.visibleItemIds.push(input.instanceId)
    } else if (input.action === 'finish-observation') {
      if (observation) observation.active = false
    } else throw fault('INVALID_ACTION')
  }

  ledger(document, entry) {
    const entryId = entry.mode === 'MULTIPLAYER' ? digest(`${entry.gameId}:${entry.type}:${document.accountId}`) : `${entry.gameId}-${entry.type}`
    document.ledger.push({ ...entry, entryId, accountId: document.accountId, at: this.now() })
    document.ledger = document.ledger.slice(-100)
  }

  settle(document, engine, endedAt = this.now(), playerId = 'P1', state = this.publicState(engine)) {
    const game = document.activeGame
    if (!game) return
    this.removeRetiredQuantities(document)
    const result = engine.settlementFor(playerId)
    const returned = {}
    if (result.success) engine.getPlayer(playerId).inventory.forEach(id => {
      const item = engine.items.find(unit => unit.instanceId === id)
      if (!item || !this.cardMap[item.cardId]) throw fault('ASSET_STATE_INVALID', 500)
      returned[item.cardId] = (returned[item.cardId] || 0) + 1
    })
    Object.entries(returned).forEach(([id, quantity]) => { document.quantities[id] = (document.quantities[id] || 0) + quantity })
    const reasons = { DISCONNECTED: '中断超过 10 分钟，对局失败', ABANDONED: '已放弃对局' }
    document.lastSettlement = { ...result, playerId: 'P1', reason: reasons[result.status] || result.reason, gameId: game.gameId, mode: game.mode, returned,
      endedAt, settledAt: this.now(), goldDelta: 0, state, settlementId: game.gameId }
    this.ledger(document, { type: 'SETTLEMENT', gameId: game.gameId, mode: game.mode, status: result.status, turn: result.turn, endedAt, success: result.success, quantities: returned, goldDelta: 0 })
    document.activeGame = null
  }

  publicState(engine) {
    const state = engine.snapshot()
    delete state.nextItemSequence
    delete state.roomStock
    // Hidden room card types and future RNG state never leave the server.
    state.items = state.items.filter(item => item.ownerId === 'P1' || item.revealedBy === 'P1' || item.state === 'DROPPED')
    return state
  }

  searchView(engine, sourceVisit, playerId) {
    if (!sourceVisit) return null
    const visit = clone(sourceVisit)
    if (visit.observation) delete visit.observation.hiddenIds
    const available = engine.searchItemsFor(playerId).filter(item => item.nodeId === visit.roomNodeId)
    const visibleArea = visit.observation && visit.observation.active ? visit.observation : null
    const areas = AREAS.map(areaId => {
      const units = available.filter(item => item.areaId === areaId)
      const visibleIds = visibleArea && visibleArea.areaId === areaId ? visibleArea.visibleItemIds : []
      return { areaId, itemCount: units.length, visibleItems: units.filter(item => visibleIds.includes(item.instanceId)) }
    })
    const inventory = engine.getPlayer(playerId).inventory.map(instanceId => ({
      ...engine.items.find(item => item.instanceId === instanceId), quantity: 1, instanceIds: [instanceId]
    }))
    return { visit, inventory, room: { nodeId: visit.roomNodeId, canObserve: true, areas, unpickedCount: available.length,
      activeAreaId: visibleArea ? visibleArea.areaId : null, activeArea: visibleArea ? areas.find(area => area.areaId === visibleArea.areaId) : null } }
  }

  accountResponse(document, activeGame = null, lobbyRoom = null, revision = document.version + 1) {
    return { profile: this.profile(document), activeGame, lobbyRoom, lastSettlement: document.lastSettlement, serverNow: this.now(), revision }
  }

  response(document, revision) {
    const game = document.activeGame
    let activeGame = null
    if (game) {
      const engine = this.restore(game)
      const visit = game.combatVersion === Battle.VERSION ? this.activeVisit(game, 'P1') : game.visit
      this.reveal(engine, visit)
      // Persist reveal progress alongside the account mutation.
      game.state = engine.snapshot()
      const search = this.searchView(engine, visit, 'P1')
      activeGame = { gameId: game.gameId, mode: game.mode, state: this.publicState(engine), search, resumeUntil: game.lastSeenAt + RESUME_MS,
        ...(game.combatVersion ? { combatVersion: game.combatVersion, combat: Battle.combatView(game.combat, engine, 'P1') } : {}) }
    }
    return this.accountResponse(document, activeGame, null, revision)
  }
}

module.exports = { AccountService, RESUME_MS }
