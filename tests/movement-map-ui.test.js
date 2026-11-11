const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SOURCE_SIZE,
  ROOM_MASK_ALPHA,
  PIN_TRANSITION_MS,
  LANDMARK_ROOMS,
  createMovementLayout,
  landmarkIconRect,
  roomRect,
  roomHighlightStyle,
  roomInfoAt,
  roomTypeAt,
  roomTypeForNode,
  pinTransitionOpacity,
  movementTrackFrame
} = require('../client/js/ui/movement-map')

test('5×5房间边界对齐大厅底图，在宽屏上一起等比缩放和居中', () => {
  const columns = [240, 395, 562, 730, 902, 1066]
  const rows = [106, 217, 326, 442, 550, 661]

  for (const [width, height, scale, offsetX] of [[1280, 722, 1, 0], [800, 361, 0.5, 80]]) {
    const layout = createMovementLayout(width, height)
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        assert.deepEqual(roomRect(layout, x, y), {
          x: offsetX + columns[x] * scale,
          y: rows[y] * scale,
          width: (columns[x + 1] - columns[x]) * scale,
          height: (rows[y + 1] - rows[y]) * scale
        })
      }
    }
  }
})

test('不可移动房间使用50%黑色蒙层', () => {
  assert.equal(ROOM_MASK_ALPHA, 0.5)
})

test('当前房间亮度高于目标与其他可移动房间', () => {
  const current = roomHighlightStyle('CURRENT')
  const selected = roomHighlightStyle('SELECTED')
  const reachable = roomHighlightStyle('REACHABLE')

  assert.ok(current.fillAlpha > selected.fillAlpha)
  assert.ok(selected.fillAlpha > reachable.fillAlpha)
  assert.ok(current.glow > selected.glow)
  assert.ok(selected.glow > reachable.glow)
  assert.ok(current.lineWidth > selected.lineWidth)
  assert.ok(selected.lineWidth > reachable.lineWidth)
})

test('地图图针先在当前房间渐隐，再在目标房间渐现', () => {
  assert.deepEqual(pinTransitionOpacity(0), { from: 1, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS / 4), { from: 0.5, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS / 2), { from: 0, to: 0, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS * 0.75), { from: 0, to: 0.5, done: false })
  assert.deepEqual(pinTransitionOpacity(PIN_TRANSITION_MS), { from: 0, to: 1, done: true })
})

test('多人轨迹同时插值，同一终点的标记错开，原地停留不位移', () => {
  const layout = createMovementLayout(812, 375)
  const tracks = [{ from: { x: 0, y: 1 }, to: { x: 1, y: 1 } },
    { from: { x: 1, y: 0 }, to: { x: 1, y: 1 } }, { from: { x: 1, y: 1 }, to: { x: 1, y: 1 } }]
  const start = movementTrackFrame(layout, tracks, 0)
  const middle = movementTrackFrame(layout, tracks, 0.5)
  const finish = movementTrackFrame(layout, tracks, 1)
  for (let i = 0; i < tracks.length; i++) {
    assert.equal(middle[i].x, (start[i].x + finish[i].x) / 2)
    assert.equal(middle[i].y, (start[i].y + finish[i].y) / 2)
  }
  assert.equal(start[2].x, finish[2].x)
  assert.equal(start[2].y, finish[2].y)
  assert.equal(new Set(finish.map(track => track.x)).size, 3)
})

test('房间网格不会侵入顶部HUD或右侧房间图例', () => {
  const layout = createMovementLayout(1280, 722)

  assert.ok(layout.grid.y >= layout.vault.y + layout.vault.height)
  assert.ok(layout.grid.x + layout.grid.width <= layout.legend.x)
})

test('特殊房间类型与规则坐标保持一致', () => {
  assert.equal(roomTypeAt(2, 2), '中央金库')
  assert.equal(roomTypeAt(4, 4), '撤离点')
  for (const [x, y] of [[0, 0], [4, 0], [0, 4]]) assert.equal(roomTypeAt(x, y), '出生点')
})

test('逐格匹配飞书房间地图，选点目标与进房标题共用房间名称', () => {
  const expected = [
    ['出生点', '会客厅', '监控室', '仓库', '出生点'],
    ['会客厅', '医疗室', '会客厅', '监控室', '医疗室'],
    ['监控室', '会客厅', '中央金库', '仓库', '会客厅'],
    ['医疗室', '监控室', '仓库', '医疗室', '监控室'],
    ['出生点', '仓库', '医疗室', '会客厅', '撤离点']
  ]
  expected.forEach((row, y) => row.forEach((name, x) => {
    assert.equal(roomInfoAt(x, y).name, name)
    assert.equal(roomTypeAt(x, y), name)
    assert.equal(roomTypeForNode(`n_${x}_${y}`), name)
  }))
  assert.equal(roomTypeForNode('invalid'), '未知房间')
  assert.equal(roomTypeForNode('n_5_0'), '未知房间')
})

test('中央金库宝箱与撤离出口图标位于对应房间内部', () => {
  const layout = createMovementLayout(SOURCE_SIZE.width, SOURCE_SIZE.height)
  const vaultRoom = roomRect(layout, LANDMARK_ROOMS.VAULT.x, LANDMARK_ROOMS.VAULT.y)
  const exitRoom = roomRect(layout, LANDMARK_ROOMS.EXIT.x, LANDMARK_ROOMS.EXIT.y)
  const vaultIcon = landmarkIconRect(layout, LANDMARK_ROOMS.VAULT.x, LANDMARK_ROOMS.VAULT.y)
  const exitIcon = landmarkIconRect(layout, LANDMARK_ROOMS.EXIT.x, LANDMARK_ROOMS.EXIT.y)

  ;[[vaultRoom, vaultIcon], [exitRoom, exitIcon]].forEach(([room, icon]) => {
    assert.ok(icon.x >= room.x)
    assert.ok(icon.y >= room.y)
    assert.ok(icon.x + icon.width <= room.x + room.width)
    assert.ok(icon.y + icon.height <= room.y + room.height)
  })
})
