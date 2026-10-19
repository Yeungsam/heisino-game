const C = require('./constants')

class MatchmakingSession {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.reset()
  }

  reset() {
    this.state = 'IDLE'
    this.roomId = null
    this.startedAt = null
    this.participants = []
    this.roomDestroyed = false
    this.mode = 'STANDARD'
  }

  start(localPlayer) {
    this.reset()
    this.state = 'SEARCHING'
    this.roomId = `local_${this.now()}`
    this.startedAt = this.now()
    this.participants = [localPlayer]
    return this.snapshot()
  }

  addParticipant(player) {
    if (this.state !== 'SEARCHING') return false
    if (this.participants.some(candidate => candidate.id === player.id)) return false
    if (this.participants.length >= C.PLAYER_LIMIT) return false
    this.participants.push(player)
    if (this.participants.length === C.PLAYER_LIMIT) this.state = 'READY'
    return true
  }

  startSingleTest() {
    if (this.state !== 'SEARCHING') return false
    this.mode = 'SINGLE_TEST'
    this.addParticipant({ id: 'P2', name: '黑桃客', isBot: true })
    this.addParticipant({ id: 'P3', name: '红心客', isBot: true })
    return this.state === 'READY'
  }

  cancel(playerId) {
    if (!['SEARCHING', 'READY'].includes(this.state)) return false
    this.participants = this.participants.filter(player => player.id !== playerId)
    if (this.participants.length === 0) {
      this.state = 'CANCELLED'
      this.roomDestroyed = true
      this.roomId = null
    } else {
      this.state = 'SEARCHING'
    }
    return true
  }

  tick(timestamp = this.now()) {
    if (this.state !== 'SEARCHING') return this.state
    if (timestamp - this.startedAt >= C.MATCH_MAX_WAIT_MS) {
      this.state = 'TIMED_OUT'
      this.participants = []
      this.roomDestroyed = true
      this.roomId = null
    }
    return this.state
  }

  remainingMs(timestamp = this.now()) {
    if (this.startedAt === null) return C.MATCH_MAX_WAIT_MS
    return Math.max(0, C.MATCH_MAX_WAIT_MS - (timestamp - this.startedAt))
  }

  snapshot() {
    return {
      state: this.state,
      roomId: this.roomId,
      startedAt: this.startedAt,
      participants: this.participants.map(player => ({ ...player })),
      roomDestroyed: this.roomDestroyed,
      mode: this.mode
    }
  }
}

module.exports = { MatchmakingSession }
