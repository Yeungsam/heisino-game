const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../client/js/core/constants')
const { MatchmakingSession } = require('../client/js/core/matchmaking')

test('匹配最多等待5分钟，超时销毁房间', () => {
  let now = 1000
  const match = new MatchmakingSession({ now: () => now })
  match.start({ id: 'P1', name: '玩家' })
  now += C.MATCH_MAX_WAIT_MS
  assert.equal(match.tick(), 'TIMED_OUT')
  assert.equal(match.roomDestroyed, true)
  assert.equal(match.participants.length, 0)
})

test('房间未空时取消单个玩家后继续等待', () => {
  const match = new MatchmakingSession({ now: () => 1000 })
  match.start({ id: 'P1', name: '玩家' })
  match.addParticipant({ id: 'P2', name: '玩家2' })
  match.cancel('P2')
  assert.equal(match.state, 'SEARCHING')
  assert.equal(match.roomDestroyed, false)
  assert.equal(match.participants.length, 1)
})

test('测试包可由单人入口立即补齐机器人并开始', () => {
  const match = new MatchmakingSession({ now: () => 1000 })
  match.start({ id: 'P1', name: '玩家' })
  assert.equal(match.startSingleTest(), true)
  assert.equal(match.state, 'READY')
  assert.equal(match.participants.length, 3)
  assert.equal(match.mode, 'SINGLE_TEST')
})
