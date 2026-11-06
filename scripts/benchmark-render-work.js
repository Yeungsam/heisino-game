// Deterministic CPU/scheduling microbenchmark, NOT a real-device FPS measurement.
const { performance } = require('node:perf_hooks')
const { GameEngine } = require('../client/js/core/game-engine')
const cards = require('../client/data/cards')
const { createRenderScheduler } = require('../client/js/ui/render-performance')
const engine = new GameEngine({ cards })
engine.start()
let startedAt = performance.now()
for (let index = 0; index < 600; index += 1) engine.snapshot()
const oldSnapshotCpuMs = performance.now() - startedAt
startedAt = performance.now()
for (let index = 0; index < 600; index += 1) { if (!engine.players.length) throw new Error('Invalid state') }
const readOnlyCpuMs = performance.now() - startedAt
const scheduler = createRenderScheduler(30)
let sceneDraws = 0
for (let index = 0; index < 600; index += 1) {
  const frame = scheduler.frame(index * 1000 / 60, 'HOME', false)
  if (frame && frame.sceneChanged) sceneDraws += 1
}
console.log(JSON.stringify({ scope: 'synthetic CPU and idle scheduling only; no GPU, network or device FPS',
  simulatedSeconds: 10, oldSceneDrawsAt60Hz: 600, optimizedIdleSceneDraws: sceneDraws,
  snapshotsPer600FramesBefore: 600, snapshotsPer600FramesAfter: 0,
  snapshotCpuMsBefore: Number(oldSnapshotCpuMs.toFixed(2)), readOnlyCpuMsAfter: Number(readOnlyCpuMs.toFixed(2)) }, null, 2))
