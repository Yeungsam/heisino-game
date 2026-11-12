const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { assertActiveCardIds } = require('../client/js/core/retired-cards')
const { writeCatalog } = require('./sync-card-economy')

const sourceDirectory = process.argv[2]
if (!sourceDirectory) {
  console.error('Usage: node scripts/build-card-catalog.js <card-art-directory>')
  process.exit(2)
}

const root = path.resolve(__dirname, '..')
const artDirectory = '/assets/cards/v2'
const outputDirectory = path.join(root, 'server', 'public', artDirectory)
const backSource = path.join(sourceDirectory, 'image 32.png')
const backTarget = path.join(root, 'client', 'subpackages', 'search', 'assets', 'card-back.jpg')
const ocrPath = path.join(root, 'data', 'card-ocr.json')
const ocrCards = fs.existsSync(ocrPath) ? JSON.parse(fs.readFileSync(ocrPath, 'utf8')) : []
const ocrByFile = Object.fromEntries(ocrCards.map(card => [card.sourceFile, card]))

const skills = [
  ['sk_001', 'image 45.png', '对子加倍', '如对方摇到两个点数相同的骰子，最终伤害×2。', 'DOUBLE_DAMAGE_ON_MATCHING_DICE', 'RESOLUTION', {}],
  ['sk_004', 'image 47.png', '减骰', '使对方减少一枚骰子。', 'REMOVE_OPPONENT_DIE', 'BEFORE_ROLL', { count: 1 }],
  ['sk_005', 'image 48.png', '迷雾手牌', '使对方的手牌附上迷雾。', 'MASK_OPPONENT_HAND', 'BEFORE_ROLL', {}],
  ['sk_006', 'image 49.png', '命运轮盘', '摇到1–9时己方扣除等同点数的生命；摇到10–18时己方恢复等同点数的生命。', 'RISK_REWARD_HP', 'RESOLUTION', { lose_range: [1, 9], gain_range: [10, 18] }],
  ['sk_007', 'image 50.png', '压低点数', '使对方最终点数−5。', 'MODIFY_FINAL_SCORE', 'RESOLUTION', { target: 'OPPONENT', amount: -5 }],
  ['sk_008', 'image 52.png', '提高点数', '使己方最终点数+5。', 'MODIFY_FINAL_SCORE', 'RESOLUTION', { target: 'SELF', amount: 5 }],
  ['sk_009', 'image 51.png', '己方重摇', '使己方骰子重摇。', 'REROLL_DICE', 'DICE_ALLOCATION', { target: 'SELF' }],
  ['sk_010', 'image 46.png', '极值交换', '将对方最小点数骰子与对方最大点数骰子交换。', 'SWAP_DICE', 'DICE_ALLOCATION', { target: 'OPPONENT', selectors: ['MIN', 'MAX'] }]
]

const weapons = [
  ['wp_001', 'image 1.png', '黄金钢笔', 'RED', 1],
  ['wp_002', 'image 53.png', '左轮手枪', 'PURPLE', 0.9],
  ['wp_003', 'image 54.png', '打火机', 'PURPLE', 0.9],
  ['wp_004', 'image 56.png', '手提包', 'BLUE', 0.8],
  ['wp_005', 'image 55.png', '拳套', 'BLUE', 0.8],
  ['wp_006', 'image 57.png', '礼宾伞', 'GREEN', 0.6],
  ['wp_007', 'image 58.png', '旅行箱', 'GREEN', 0.6]
]

const armors = [
  ['ar_001', 'image 76.png', '急救腰包', 'RED'],
  ['ar_002', 'image 67.png', '安全帽', 'GREEN'],
  ['ar_003', 'image 78.png', '泡泡防护罩', 'RED'],
  ['ar_004', 'image 75.png', '堆叠抱枕', 'RED'],
  ['ar_005', 'image 68.png', '赌场圆盾', 'GREEN'],
  ['ar_006', 'image 74.png', '废筹码垫板', 'GREEN'],
  ['ar_007', 'image 73.png', '地毯披风', 'GREEN'],
  ['ar_008', 'image 71.png', '旧扑克护片', 'GREEN'],
  ['ar_009', 'image 69.png', '蒙面眼罩', 'GREEN'],
  ['ar_010', 'image 70.png', '纸杯头盔', 'GREEN'],
  ['ar_011', 'image 72.png', '纸箱护甲', 'GREEN'],
  ['ar_012', 'image 77.png', '雨伞护罩', 'RED']
]

const loot = [
  ['loot_001', 'image 79.png', '高级西装', 'RED'],
  ['loot_002', 'image 9.png', '纯金扑克', 'RED'],
  ['loot_003', 'image 10.png', '赌徒之眼', 'RED'],
  ['loot_004', 'image 11.png', '老虎机芯片', 'RED'],
  ['loot_005', 'image 12.png', '庄家房卡', 'RED'],
  ['loot_006', 'image 13.png', '劳力士手表', 'RED'],
  ['loot_007', 'image 15.png', '十万筹码', 'RED'],
  ['loot_009', 'image 16.png', '爱马仕包', 'RED'],
  ['loot_010', 'image 17.png', '黑色丝袜', 'GREEN'],
  ['loot_011', 'image 18.png', '荷官手套', 'GREEN'],
  ['loot_012', 'image 61.png', '眼镜', 'GREEN'],
  ['loot_013', 'image 66.png', '双肩包', 'GREEN'],
  ['loot_014', 'image 60.png', '皮带', 'GREEN'],
  ['loot_015', 'image 23.png', '赌徒扑克', 'GREEN'],
  ['loot_016', 'image 24.png', '花呗欠账单', 'GREEN'],
  ['loot_017', 'image 25.png', '指南针', 'GREEN'],
  ['loot_018', 'image 65.png', '灭火器', 'GREEN'],
  ['loot_019', 'image 27.png', '保安服', 'BLUE'],
  ['loot_020', 'image 28.png', '赌徒手指', 'BLUE'],
  ['loot_021', 'image 29.png', '未归还充电宝', 'BLUE'],
  ['loot_022', 'image 30.png', '急救包', 'PURPLE'],
  ['loot_023', 'image 31.png', '遗落钱包', 'PURPLE'],
  ['loot_024', 'image 59.png', '烟头', 'GREEN']
]

function baseCard({ id, file, kind, category, name, rarity, description }) {
  const sourcePath = path.join(sourceDirectory, file)
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing source asset: ${sourcePath}`)
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')
  const ocr = ocrByFile[file]
  return {
    card_id: id,
    kind,
    category,
    name,
    description,
    rarity,
    attack_multiplier: null,
    defense_multiplier: null,
    inventory: { slot_cost: 1, can_pickup: true, can_drop: true, can_steal: true },
    rules: { requires_equipped: false, usable_phases: ['NONE'], effects: [] },
    assets: {
      icon_key: `card_${id}`,
      card_art_key: `card_${id}`,
      card_art_path: `${artDirectory}/${id}.jpg`,
      source_file: file,
      sha256
    },
    data_status: 'ACTIVE',
    source: {
      document: 'Figma / heisino / 2026-11-12 新版卡面',
      notes: '新版卡面 OCR 供美术核对，游戏字段按卡库配置。',
      ocr_text: ocr ? ocr.lines.map(line => line.text) : []
    }
  }
}

const cards = []

weapons.forEach(([id, file, name, rarity, multiplier]) => {
  const card = baseCard({ id, file, kind: 'EQUIPMENT', category: 'WEAPON', name, rarity, description: `武器卡，攻击倍率${Math.round(multiplier * 100)}%。` })
  card.attack_multiplier = multiplier
  card.rules.requires_equipped = true
  cards.push(card)
})

armors.forEach(([id, file, name, rarity]) => {
  const card = baseCard({ id, file, kind: 'EQUIPMENT', category: 'ARMOR', name, rarity, description: '防具卡，防御倍率等待玩法数值确认。' })
  card.rules.requires_equipped = true
  card.data_status = 'DRAFT'
  cards.push(card)
})

const casinoShield = cards.find(card => card.card_id === 'ar_005')
cards.push({
  ...casinoShield,
  card_id: 'ar_013',
  name: '守卫圆盾',
  rarity: 'BLUE',
  source: { ...casinoShield.source, notes: '单人守卫掉落的蓝色防具，复用赌场圆盾卡面。' }
})

loot.forEach(([id, file, name, rarity]) => {
  cards.push(baseCard({ id, file, kind: 'LOOT', category: 'LOOT', name, rarity }))
})

skills.forEach(([id, file, name, description, effectType, phase, parameters]) => {
  const card = baseCard({ id, file, kind: 'SKILL', category: 'SKILL', name, rarity: 'PURPLE', description })
  card.rules = {
    requires_equipped: false,
    usable_phases: [phase],
    effects: [{ effect_id: `${id}_effect`, effect_type: effectType, duration: phase === 'RESOLUTION' ? 'SUB_ROUND' : 'BATTLE', parameters }]
  }
  card.data_status = 'DRAFT'
  cards.push(card)
})

assertActiveCardIds(cards.map(card => card.card_id))
if (!fs.existsSync(backSource)) throw new Error(`Missing card back: ${backSource}`)
fs.mkdirSync(outputDirectory, { recursive: true })
const publishedPaths = new Set()
for (const card of cards) {
  const artPath = card.assets.card_art_path
  if (publishedPaths.has(artPath)) continue
  const sourcePath = path.join(sourceDirectory, card.assets.source_file)
  const targetPath = path.join(outputDirectory, path.basename(artPath))
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '768', sourcePath, '--out', targetPath], { stdio: 'ignore' })
  publishedPaths.add(artPath)
}

execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '512', backSource, '--out', backTarget], { stdio: 'ignore' })

writeCatalog({ schema_version: '0.2.0', generated_at: new Date().toISOString(), cards })

console.log(`Generated ${cards.length} cards and ${publishedPaths.size} optimized server assets.`)
