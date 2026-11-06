const crypto = require('node:crypto')
const { GameEngine, positionKey, cards } = require('./runtime')
const { fault, accountIdFor, validateNickname, validateAvatar } = require('./wechat')
const starter = require('./starter.json')
const RESUME_MS = 10 * 60 * 1000
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const AREAS = ['LEFT_CABINET', 'MAIN_TABLE', 'RIGHT_TABLE']
const clone = value => JSON.parse(JSON.stringify(value))
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

function slots(items) {
  const counts = {}
  items.forEach(item => { counts[item.cardId] = (counts[item.cardId] || 0) + 1 })
  return Object.keys(counts).sort().flatMap(cardId => {
    const units = items.filter(item => item.cardId === cardId)
    const result = []
    for (let i = 0; i < units.length; i += 99) result.push({ ...units[i], quantity: Math.min(99, units.length - i), instanceIds: units.slice(i, i + 99).map(item => item.instanceId) })
    return result
  })
}
function must(result) { if (!result.ok) throw fault(result.reason, 409); return result }

class AccountService {
  constructor(options) {
    this.store = options.store
    this.identity = options.identity
    this.now = options.now || Date.now
    this.cards = options.cards || cards
    this.cardMap = Object.fromEntries(this.cards.map(card => [card.cardId, card]))
  }

  async mutate(accountId, callback) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = await this.store.get(accountId)
      if (!document) throw fault('UNAUTHENTICATED', 401)
      const result = await callback(document)
      const version = document.version
      document.version += 1
      if (await this.store.replace(document, version)) return result
    }
    throw fault('ACCOUNT_BUSY', 409)
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
    return this.mutate(accountId, document => {
      document.sessions = document.sessions.filter(session => session.expiresAt > this.now()).slice(-4)
      document.sessions.push({ hash: digest(token), expiresAt })
      document.lastLoginAt = this.now()
      this.advance(document, true)
      return { token, expiresAt, ...this.response(document) }
    })
  }

  authenticate(document, token) {
    if (!document.sessions.some(session => session.expiresAt > this.now() && session.hash === digest(token))) throw fault('UNAUTHENTICATED', 401)
  }

  async execute(token, action, input = {}) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(token)) throw fault('UNAUTHENTICATED', 401)
    const accountId = token.split('.')[0]
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
      this.advance(document, action === 'resume' || action === 'me')
      if (action === 'profile') {
        if (document.profileComplete && (document.nickname !== checkedProfile.nickname || document.avatarUrl !== checkedProfile.avatarUrl)) throw fault('PROFILE_ALREADY_CREATED', 409)
        Object.assign(document, checkedProfile, { profileComplete: true })
      } else if (action === 'acknowledge') {
        if (document.lastSettlement) document.lastSettlement.acknowledged = true
      } else if (action === 'start') this.start(document, input)
      else if (action === 'game') this.gameAction(document, input)
      else if (!['me', 'resume', 'heartbeat', 'suspend'].includes(action)) throw fault('NOT_FOUND', 404)
      if (document.activeGame) {
        document.activeGame.lastSeenAt = this.now()
        if (action === 'suspend') document.activeGame.suspendedAt = this.now()
      }
      return this.response(document)
    })
  }

  restore(game) {
    const engine = new GameEngine({ cards: this.cards, now: this.now, rng: () => {
      game.rngState = (Math.imul(game.rngState, 1664525) + 1013904223) >>> 0
      return game.rngState / 0x100000000
    } })
    if (game.state) Object.assign(engine, clone(game.state))
    return engine
  }

  start(document, input) {
    if (!document.profileComplete) throw fault('PROFILE_REQUIRED', 409)
    const requestId = this.requestId(input)
    const cardIds = input.cardIds
    if (!Array.isArray(cardIds) || cardIds.length > 4 || cardIds.some(id => typeof id !== 'string' || !this.cardMap[id] || !['WEAPON', 'ARMOR', 'SKILL'].includes(this.cardMap[id].category))) throw fault('LOADOUT_INVALID')
    const fingerprint = digest(JSON.stringify({ cardIds, mode: input.mode || 'STANDARD' }))
    const prior = document.startRequests.find(request => request.id === requestId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
      return
    }
    if (document.activeGame) throw fault('ACTIVE_GAME_EXISTS', 409)
    const counts = {}
    cardIds.forEach(id => { counts[id] = (counts[id] || 0) + 1 })
    Object.entries(counts).forEach(([id, count]) => { if ((document.quantities[id] || 0) < count) throw fault('NOT_OWNED', 409) })
    Object.entries(counts).forEach(([id, count]) => { document.quantities[id] -= count })
    if (!['STANDARD', 'SINGLE_TEST'].includes(input.mode || 'STANDARD')) throw fault('MODE_INVALID')
    const game = {
      gameId: crypto.randomUUID(), mode: input.mode || 'STANDARD', createdAt: this.now(), lastSeenAt: this.now(),
      rngState: crypto.randomBytes(4).readUInt32BE(), requests: {}, state: null, visit: null
    }
    const engine = this.restore(game)
    engine.localLoadoutCardIds = cardIds.slice()
    engine.start()
    engine.getPlayer('P1').name = document.nickname
    game.state = engine.snapshot()
    document.activeGame = game
    document.lastSettlement = null
    document.startRequests.push({ id: requestId, fingerprint, gameId: game.gameId })
    document.startRequests = document.startRequests.slice(-100)
    this.ledger(document, { type: 'DEPLOY', gameId: game.gameId, quantities: Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, -count])) })
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
      if (pause > 0) {
        for (const key of ['moveDeadlineAt', 'turnDeadlineAt']) if (Number.isFinite(game.state[key])) game.state[key] += pause
        if (game.visit) {
          game.visit.deadlineAt += pause
          if (game.visit.observation) game.visit.observation.startedAt += pause
        }
      }
      delete game.suspendedAt
      game.lastSeenAt = this.now()
    }
    const engine = this.restore(game)
    if (engine.phase === 'MOVE_SELECTION' && this.now() >= engine.moveDeadlineAt) this.move(engine, game, engine.getPlayer('P1').position)
    if (game.visit && this.now() >= game.visit.deadlineAt && engine.phase !== 'GAME_OVER') {
      must(engine.finishTurn())
      game.visit = null
    }
    game.state = engine.snapshot()
    if (engine.phase === 'GAME_OVER') this.settle(document, engine)
  }

  move(engine, game, target) {
    must(engine.submitMove('P1', target))
    engine.submitBotMoves()
    must(engine.resolveMoves())
    if (engine.getPlayer('P1').status !== 'ACTIVE') {
      engine.phase = 'GAME_OVER'
      return
    }
    engine.phase = 'SEARCH'
    engine.turnDeadlineAt = this.now() + 50000
    game.visit = { visitId: `${game.gameId}-${engine.turn}`, turn: engine.turn, roomNodeId: positionKey(engine.getPlayer('P1').position),
      startedAt: this.now(), deadlineAt: engine.turnDeadlineAt, status: 'ACTIVE', observation: null }
  }

  reveal(engine, visit) {
    const observation = visit && visit.observation
    if (!observation || !observation.active) return
    const allowed = engine.searchItemsFor('P1').filter(item => item.nodeId === visit.roomNodeId && item.areaId === observation.areaId)
    const count = Math.floor((Math.min(this.now(), visit.deadlineAt) - observation.startedAt) / 2000)
    const newlyVisible = observation.hiddenIds.slice(0, count)
    newlyVisible.forEach(id => {
      const item = allowed.find(unit => unit.instanceId === id)
      if (item && item.state === 'HIDDEN') { item.state = 'REVEALED'; item.revealedBy = 'P1' }
    })
    observation.visibleItemIds = allowed.filter(item => item.state === 'DROPPED' || item.revealedBy === 'P1').map(item => item.instanceId)
  }

  gameAction(document, input) {
    const game = document.activeGame
    if (!game) {
      if (document.lastSettlement && document.lastSettlement.gameId === input.gameId) return
      throw fault('NO_ACTIVE_GAME', 409)
    }
    if (game.gameId !== input.gameId) throw fault('GAME_MISMATCH', 409)
    const requestId = this.requestId(input)
    const fingerprint = digest(JSON.stringify({ action: input.action, turn: input.turn, target: input.target, areaId: input.areaId, instanceId: input.instanceId }))
    if (game.requests[requestId]) {
      if (game.requests[requestId] !== fingerprint) throw fault('REQUEST_ID_REUSED', 409)
      return
    }
    const engine = this.restore(game)
    if (input.turn !== engine.turn) throw fault('STALE_TURN', 409)
    this.reveal(engine, game.visit)
    const visit = game.visit
    if (input.action === 'move') this.move(engine, game, input.target || {})
    else if (input.action === 'abandon') { engine.getPlayer('P1').status = 'ABANDONED'; engine.phase = 'GAME_OVER' }
    else {
      if (!visit || engine.phase !== 'SEARCH') throw fault('INVALID_PHASE', 409)
      const observation = visit.observation
      if (input.action === 'observe') {
        if (!AREAS.includes(input.areaId)) throw fault('AREA_NOT_FOUND', 404)
        const items = engine.searchItemsFor('P1').filter(item => item.nodeId === visit.roomNodeId && item.areaId === input.areaId)
        visit.observation = { areaId: input.areaId, startedAt: this.now(), active: true,
          hiddenIds: items.filter(item => item.state === 'HIDDEN').map(item => item.instanceId),
          visibleItemIds: items.filter(item => item.state !== 'HIDDEN').map(item => item.instanceId) }
      } else if (input.action === 'pickup') {
        if (!observation || !observation.active || !observation.visibleItemIds.includes(input.instanceId)) throw fault('ITEM_NOT_VISIBLE', 409)
        must(engine.interactWithItem('P1', input.instanceId))
        observation.visibleItemIds = observation.visibleItemIds.filter(id => id !== input.instanceId)
      } else if (input.action === 'drop') {
        if (!observation || !observation.active) throw fault('NOT_OBSERVING', 409)
        const inArea = engine.items.filter(item => item.nodeId === visit.roomNodeId && item.areaId === observation.areaId)
        if (inArea.length >= 30) throw fault('AREA_FULL', 409)
        must(engine.dropItem('P1', input.instanceId, observation.areaId))
        const item = engine.items.find(unit => unit.instanceId === input.instanceId)
        engine.grantSearch('P1', [item])
        observation.visibleItemIds.push(input.instanceId)
      } else if (input.action === 'finish-observation') {
        if (observation) observation.active = false
      } else if (input.action === 'leave' || input.action === 'extract') {
        if (input.action === 'extract') must(engine.requestExtraction('P1'))
        must(engine.finishTurn())
        game.visit = null
      } else throw fault('INVALID_ACTION')
    }
    game.requests[requestId] = fingerprint
    if (Object.keys(game.requests).length > 200) delete game.requests[Object.keys(game.requests)[0]]
    game.state = engine.snapshot()
    if (engine.phase === 'GAME_OVER') this.settle(document, engine)
  }

  ledger(document, entry) {
    document.ledger.push({ ...entry, entryId: `${entry.gameId}-${entry.type}`, accountId: document.accountId, at: this.now() })
    document.ledger = document.ledger.slice(-100)
  }

  settle(document, engine, endedAt = this.now()) {
    const game = document.activeGame
    if (!game) return
    const result = engine.settlementFor('P1')
    const returned = {}
    if (result.success) engine.getPlayer('P1').inventory.forEach(id => {
      const item = engine.items.find(unit => unit.instanceId === id)
      if (!item || !this.cardMap[item.cardId]) throw fault('ASSET_STATE_INVALID', 500)
      returned[item.cardId] = (returned[item.cardId] || 0) + 1
    })
    Object.entries(returned).forEach(([id, quantity]) => { document.quantities[id] = (document.quantities[id] || 0) + quantity })
    const reasons = { DISCONNECTED: '中断超过 10 分钟，对局失败', ABANDONED: '已放弃对局' }
    document.lastSettlement = { ...result, reason: reasons[result.status] || result.reason, gameId: game.gameId, mode: game.mode, returned,
      endedAt, settledAt: this.now(), goldDelta: 0, state: this.publicState(engine), settlementId: game.gameId }
    this.ledger(document, { type: 'SETTLEMENT', gameId: game.gameId, mode: game.mode, status: result.status, turn: result.turn, endedAt, success: result.success, quantities: returned, goldDelta: 0 })
    document.activeGame = null
  }

  publicState(engine) {
    const state = engine.snapshot()
    delete state.nextItemSequence
    // Hidden room card types and future RNG state never leave the server.
    state.items = state.items.filter(item => item.ownerId === 'P1' || item.revealedBy === 'P1' || item.state === 'DROPPED')
    return state
  }

  response(document) {
    const game = document.activeGame
    let activeGame = null
    if (game) {
      const engine = this.restore(game)
      this.reveal(engine, game.visit)
      // Persist reveal progress alongside the account mutation.
      game.state = engine.snapshot()
      const inventory = engine.getPlayer('P1').inventory.map(id => engine.items.find(item => item.instanceId === id))
      let search = null
      if (game.visit) {
        const visit = clone(game.visit)
        if (visit.observation) delete visit.observation.hiddenIds
        const available = engine.searchItemsFor('P1').filter(item => item.nodeId === visit.roomNodeId)
        const areas = AREAS.map(areaId => {
          const units = available.filter(item => item.areaId === areaId)
          const visibleIds = visit.observation && visit.observation.active && visit.observation.areaId === areaId ? visit.observation.visibleItemIds : []
          return { areaId, itemCount: units.length, visibleItems: units.filter(item => visibleIds.includes(item.instanceId)) }
        })
        search = { visit, inventory: slots(inventory), room: { nodeId: visit.roomNodeId, canObserve: true, areas, unpickedCount: available.length,
          activeAreaId: visit.observation && visit.observation.active ? visit.observation.areaId : null,
          activeArea: visit.observation && visit.observation.active ? areas.find(area => area.areaId === visit.observation.areaId) : null } }
      }
      activeGame = { gameId: game.gameId, mode: game.mode, state: this.publicState(engine), search, resumeUntil: game.lastSeenAt + RESUME_MS }
    }
    return { profile: this.profile(document), activeGame, lastSettlement: document.lastSettlement, serverNow: this.now(), revision: document.version + 1 }
  }
}

module.exports = { AccountService, RESUME_MS, slots }
