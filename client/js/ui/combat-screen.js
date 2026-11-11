const ART = Object.freeze({
  deck: [4, 216, 956, 227],
  attack: [154, 287, 242, 67],
  defense: [154, 353, 242, 66],
  tray: [400, 287, 294, 135],
  actions: [700, 286, 236.5, 131],
  'red-panel': [62, 65, 212, 203.5],
  'blue-panel': [671, 60, 218, 199.5],
  'red-avatar': [80, 91, 68, 78],
  'blue-avatar': [784, 89, 88, 80],
  'round-plate': [139, 9, 185, 62],
  'round-icon': [174, 25, 34, 31],
  'room-plate': [358, 8, 244, 62],
  'room-icon': [391, 24, 34, 33],
  'time-plate': [624, 8, 185, 62],
  'time-icon': [647, 26, 26, 26],
  'time-track': [675, 33, 76, 13.5],
  'time-fill': [677, 35, 71, 9.5],
  'dice-stack': [496, 326, 99, 84]
})
const ASSETS = Object.keys(ART).concat(Array.from({ length: 6 }, (_, i) => `die-${i + 1}`))
const ZONE_RECTS = { ATTACK: [155, 287, 240, 66], DEFENSE: [155, 353, 240, 66], TRAY: [401, 288, 291, 132] }
const DROP_RECT = [260, 62, 436, 130]
const CONTACT = 0.36
const clamp01 = value => Math.min(1, Math.max(0, value))

function createCombatLayout(width, height) {
  const scale = Math.min(width / 956, height / 440)
  const x = (width - 956 * scale) / 2
  const y = (height - 440 * scale) / 2
  return {
    scale,
    rect: ([left, top, w, h]) => ({ x: x + left * scale, y: y + top * scale, width: w * scale, height: h * scale }),
    zones: ZONE_RECTS,
    drop: DROP_RECT
  }
}

function drawCombatScreen({ context, width, height, battle, now, roomName, assets, panel, text, drawCard,
  avatar, cardById, selectedDie, skillsOpen, drag, busy }) {
  const layout = createCombatLayout(width, height)
  const { rect, scale } = layout
  const hits = []
  const addHit = (id, bounds, data, previewCardId) => hits.push({ id, rect: rect(bounds), data, previewCardId })
  const image = (key, bounds = ART[key]) => {
    const source = assets[key]
    if (!source) return false
    const r = rect(bounds)
    context.drawImage(source, r.x, r.y, r.width, r.height)
    return true
  }
  const box = (bounds, options) => {
    const r = rect(bounds)
    panel(r.x, r.y, r.width, r.height, options)
  }
  const label = (value, x, y, size, options = {}) => {
    const p = rect([x, y, 0, 0])
    text(value, p.x, p.y, Math.max(8, size * scale), options.color || '#fff0c9',
      options.align || 'center', options.weight || 'bold', options.width && options.width * scale)
  }
  const fill = (bounds, color) => {
    const r = rect(bounds)
    context.fillStyle = color
    context.fillRect(r.x, r.y, r.width, r.height)
  }
  const die = (value, bounds) => {
    if (image(`die-${value}`, bounds)) return
    box(bounds, { fill: '#f9e0a8', stroke: '#c47b3d', radius: 5 })
    label(value, bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2, 25, { color: '#8e1921' })
  }
  const remaining = Math.max(0, battle.deadlineAt - now)
  const impacting = battle.stage === 'IMPACT'
  const resolving = impacting || battle.stage === 'RESULT'
  const impactDuration = impacting ? Math.max(1, battle.deadlineAt - (battle.impactStartedAt ?? (battle.deadlineAt - 2000))) : 0
  const impactTime = impacting ? clamp01(1 - remaining / impactDuration) : 0
  const rush = impacting ? (impactTime <= CONTACT
    ? (impactTime / CONTACT) ** 2
    : (1 - clamp01((impactTime - CONTACT) / 0.38)) ** 2) : 0
  const playing = battle.stage === 'PLAY' && remaining > 0
  const editable = playing && !battle.self.ready && !busy
  const sides = [{ data: battle.self, prefix: 'red', x: 74, fillFrom: 149, nameX: 174, offset: 215 },
    { data: battle.opponent, prefix: 'blue', x: 706, fillFrom: 692, nameX: 784, offset: -204 }]
  const fallbackPanel = { fill: 'rgba(73,24,28,.93)', stroke: '#e0b66b', radius: 9 }
  if (!resolving) {
    if (!image('deck')) box([20, 280, 922, 144], fallbackPanel)
    for (const key of ['attack', 'defense', 'tray', 'actions']) if (!image(key)) box(ART[key], fallbackPanel)
  }
  for (const key of ['round-plate', 'room-plate', 'time-plate']) {
    if (!image(key)) box(ART[key], fallbackPanel)
  }
  for (const key of ['round-icon', 'room-icon', 'time-icon', 'time-track']) image(key)
  label(`第 ${battle.turn} 回合`, 243, 39, 15, { width: 91 })
  label(roomName, 501, 39, 15, { width: 142 })
  const progress = clamp01(remaining / (battle.stage === 'PLAY' ? 15000 : impacting ? impactDuration : 2000))
  if (progress > 0) {
    const r = rect([677, 35, 71 * progress, 9.5])
    context.save()
    context.beginPath()
    context.rect(r.x, r.y, r.width, r.height)
    context.clip()
    if (!image('time-fill')) fill([677, 35, 71, 9.5], '#ffd169')
    context.restore()
  }
  label(`${Math.ceil(remaining / 1000)}s`, 772, 39, 13)

  for (const { data, prefix, x, fillFrom, nameX, offset } of sides) {
    context.save()
    if (rush) context.translate(offset * scale * rush, 0)
    if (!image(`${prefix}-panel`)) box([x, 86, 176, 142], fallbackPanel)
    if (prefix === 'red' && avatar) {
      const r = rect([92, 103, 50, 49])
      context.drawImage(avatar, r.x, r.y, r.width, r.height)
    } else image(`${prefix}-avatar`)
    const lossProgress = impacting ? clamp01((impactTime - CONTACT) / 0.23) : 1
    const hp = data.hp + (data.impact?.loss || 0) * (1 - lossProgress)
    const fraction = Math.max(0, Math.min(1, hp / data.maxHp))
    const empty = 98 * (1 - fraction)
    if (empty > 0) fill([prefix === 'red' ? fillFrom + 98 - empty : fillFrom, 109, empty, 13], '#231621')
    label(`HP ${Math.ceil(hp)}/${data.maxHp}`, prefix === 'red' ? 191 : 742, 145, 12)
    label(data.name, nameX, 243, 14, { width: 145 })
    const gearX = prefix === 'red' ? [96, 151] : [763, 818]
    for (const [i, id] of [data.weaponId, data.armorId].entries()) {
      if (!id) continue
      drawCard(cardById(id), rect([gearX[i], 167, 32, 38]), { inset: 1, radius: 4 })
      addHit('card_preview', [gearX[i] + offset * rush, 167, 32, 38], `${prefix}-${i}`, id)
    }
    context.restore()
  }
  label(`小回合 ${battle.subRound}/3`, 478, impacting ? 84 : 104, 19)
  if (battle.outcome) {
    const outcome = { WIN: '战斗胜利', LOSS: '战斗失败', DRAW: '平局', DOUBLE_KO: '双方同时倒下' }
    box([345, 138, 266, 62], { ...fallbackPanel, fill: 'rgba(32,19,28,.96)' })
    label(outcome[battle.outcome], 478, 168, 30)
  } else if (impacting && impactTime >= CONTACT) {
    const sinceHit = (impactTime - CONTACT) / (1 - CONTACT)
    const flash = 1 - clamp01(sinceHit * 3.5)
    if (flash > 0) {
      const { x, y } = rect([478, 160, 0, 0])
      const radius = (40 + 30 * (1 - flash)) * scale
      const light = context.createRadialGradient(x, y, 0, x, y, radius)
      light.addColorStop(0, `rgba(255,237,172,${0.85 * flash})`)
      light.addColorStop(1, 'rgba(255,171,83,0)')
      context.fillStyle = light
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
    }
    for (const { data, nameX, offset } of sides) {
      const loss = data.impact?.loss
      if (loss !== undefined) label(loss ? `−${loss} HP` : '无伤害', nameX + offset * rush, 79 - 14 * sinceHit, 19,
        { color: loss ? '#ff8b78' : '#a4e1fb' })
    }
  } else if (playing && battle.self.ready) label('等待对方就绪', 478, 171, 18)

  if (resolving) {
    if (battle.self.impact && battle.opponent.impact) {
      for (const [i, { data }] of sides.entries()) {
        const x = i === 0 ? 144 : 491
        const accent = i === 0 ? '#ffad90' : '#a4e1fb'
        box([x, 305, 322, 101], { fill: 'rgba(32,19,28,.96)', stroke: accent, radius: 10 })
        label(i === 0 ? '你' : data.name, x + 161, 328, 17, { color: accent, width: 288 })
        label(`攻击 ${data.impact.attack}`, x + 84, 371, 22, { width: 136 })
        label(`防御 ${data.impact.defense}`, x + 238, 371, 22, { width: 136 })
      }
    }
    return { hits, zones: {}, drop: null }
  }

  const canRoll = editable && !battle.self.dice.length
  const canReady = editable && battle.self.dice.length === 3 && battle.self.dice.every(value => value.zone !== 'TRAY')
  for (const [id, value, y, active] of [['combat_roll', '掷骰子', 298, canRoll], ['combat_ready', '准备就绪', 358, canReady]]) {
    const r = [715, y, 202, 47]
    if (!active) box(r, { fill: 'rgba(29,27,37,.74)', stroke: '#8c7c65', radius: 9 })
    label(value, 835, y + 23, 22, { color: active ? '#4b1c0a' : '#dbd0bf', width: 116 })
    if (active) addHit(id, r)
  }
  const inventory = battle.self.skills
  box([28, 288, 122, 130], { fill: '#50170f', stroke: '#af713d', radius: 7 })
  if (inventory.length) {
    const { cardId, instanceId } = inventory[0]
    const bounds = [55, 292, 68, 100]
    drawCard(cardById(cardId), rect(bounds), { inset: 1, radius: 5 })
    addHit('card_preview', bounds, instanceId, cardId)
    box([34, 394, 110, 24], fallbackPanel)
    label(`技能卡 ×${inventory.length}`, 89, 407, 13)
    addHit('combat_skills', [34, 394, 110, 24])
  } else label('技能卡槽', 89, 353, 14, { color: '#cca581' })

  const spot = { ATTACK: [223, 299, 43, 51], DEFENSE: [223, 365, 43, 51], TRAY: [428, 329, 64, 84] }
  for (const zone of Object.keys(spot)) {
    const [x, y, size, step] = spot[zone]
    if (editable) addHit('combat_zone', ZONE_RECTS[zone], zone)
    const sum = battle.self.dice.filter(value => value.zone === zone).reduce((n, value) => n + value.value, 0)
    if (zone === 'TRAY') label('骰子托盘', 480, 302, 14)
    else {
      const name = zone === 'ATTACK' ? '攻击' : '防御'
      const percent = zone === 'ATTACK' ? battle.self.attackPercent : battle.self.defensePercent
      label(`${name} ${Math.floor(sum * percent / 100)}`, 183, y + 36, 12, { width: 64 })
      for (let i = 0; i < 3; i++) box([x + i * step, y, size, size], { fill: '#512018', stroke: '#a97345', radius: 4 })
    }
    let column = 0
    battle.self.dice.forEach((value, i) => {
      if (value.zone !== zone) return
      const bounds = [x + column++ * step, y, size, size]
      if (selectedDie === i) box(bounds, { fill: '#ffe68a', stroke: '#fff0a0', radius: 5, lineWidth: 3 })
      if (drag?.kind !== 'die' || drag.index !== i) die(value.value, bounds)
      if (editable) addHit('combat_die', bounds, i)
    })
  }
  if (!battle.self.dice.length) image('dice-stack')

  if (skillsOpen && inventory.length) {
    hits.length = 0
    fill([0, 0, 956, 440], 'rgba(18,9,18,.67)')
    box(DROP_RECT, { fill: drag?.kind === 'skill' ? 'rgba(139,78,38,.59)' : 'rgba(72,26,32,.35)',
      stroke: drag?.kind === 'skill' ? '#fff1a8' : '#d6a767', radius: 10 })
    label('拖到这里使用技能卡', 478, 117, 20)
    label('本期技能不产生效果', 478, 149, 14)
    box([24, 211, 908, 217], fallbackPanel)
    const cardWidth = Math.min(87, 820 / inventory.length - 10)
    const gap = 10
    const first = (956 - inventory.length * (cardWidth + gap) + gap) / 2
    for (const [i, item] of inventory.entries()) {
      const bounds = [first + i * (cardWidth + gap), 234, cardWidth, cardWidth * 1.41]
      if (drag?.kind !== 'skill' || drag.instanceId !== item.instanceId) drawCard(cardById(item.cardId), rect(bounds))
      addHit('combat_skill', bounds, item, item.cardId)
    }
    label('关闭', 889, 226, 15)
    addHit('combat_skills_close', [851, 211, 72, 23])
  }
  if (drag?.kind === 'die' && battle.self.dice[drag.index]) {
    const size = 43 * scale
    const source = assets[`die-${battle.self.dice[drag.index].value}`]
    if (source) context.drawImage(source, drag.point.x - size / 2, drag.point.y - size / 2, size, size)
    else text(battle.self.dice[drag.index].value, drag.point.x, drag.point.y, 23, '#fff0c9', 'center', 'bold')
  } else if (drag?.kind === 'skill') {
    const size = 82 * scale
    drawCard(cardById(drag.cardId), { x: drag.point.x - size / 2, y: drag.point.y - size * .7, width: size, height: size * 1.41 },
      { stroke: '#fff1a8' })
  }
  return { hits, zones: Object.fromEntries(Object.entries(ZONE_RECTS).map(([name, bounds]) => [name, rect(bounds)])), drop: rect(DROP_RECT) }
}

module.exports = { ASSETS, createCombatLayout, drawCombatScreen }
