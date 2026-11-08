const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const sourceDirectory = process.argv[2]
if (!sourceDirectory) {
  console.error('Usage: node scripts/build-card-catalog.js <card-art-directory>')
  process.exit(2)
}

const root = path.resolve(__dirname, '..')
const outputDirectory = path.join(root, 'server', 'public', 'assets', 'cards')
const cloudFunctionDirectory = path.join(root, 'functions', 'heisino-cards')
const ocrPath = path.join(root, 'data', 'card-ocr.json')
const ocrCards = fs.existsSync(ocrPath) ? JSON.parse(fs.readFileSync(ocrPath, 'utf8')) : []
const ocrByFile = Object.fromEntries(ocrCards.map(card => [card.sourceFile, card]))

const skills = [
  ['sk_001', '3.1 (1).png', '对子加倍', '如对方摇到两个点数相同的骰子，最终伤害×2。', 'DOUBLE_DAMAGE_ON_MATCHING_DICE', 'RESOLUTION', {}],
  ['sk_002', '3.1 (2).png', '四个六', '增加一枚骰子；如摇到4个6点则直接获胜。', 'ADD_DIE', 'BEFORE_ROLL', { count: 1, instant_win_faces: [6, 6, 6, 6] }],
  ['sk_003', '3.1 (3).png', '额外骰子', '增加一枚骰子。', 'ADD_DIE', 'BEFORE_ROLL', { count: 1 }],
  ['sk_004', '3.1 (4).png', '减骰', '使对方减少一枚骰子。', 'REMOVE_OPPONENT_DIE', 'BEFORE_ROLL', { count: 1 }],
  ['sk_005', '3.1 (5).png', '迷雾手牌', '使对方的手牌附上迷雾。', 'MASK_OPPONENT_HAND', 'BEFORE_ROLL', {}],
  ['sk_006', '3.1 (6).png', '命运轮盘', '摇到1–9时己方扣除等同点数的生命；摇到10–18时己方恢复等同点数的生命。', 'RISK_REWARD_HP', 'RESOLUTION', { lose_range: [1, 9], gain_range: [10, 18] }],
  ['sk_007', '3.1 (7).png', '压低点数', '使对方最终点数−5。', 'MODIFY_FINAL_SCORE', 'RESOLUTION', { target: 'OPPONENT', amount: -5 }],
  ['sk_008', '3.1 (8).png', '提高点数', '使己方最终点数+5。', 'MODIFY_FINAL_SCORE', 'RESOLUTION', { target: 'SELF', amount: 5 }],
  ['sk_009', '3.1 (9).png', '己方重摇', '使己方骰子重摇。', 'REROLL_DICE', 'DICE_ALLOCATION', { target: 'SELF' }],
  ['sk_010', '3.1.png', '极值交换', '将对方最小点数骰子与对方最大点数骰子交换。', 'SWAP_DICE', 'DICE_ALLOCATION', { target: 'OPPONENT', selectors: ['MIN', 'MAX'] }]
]

const weapons = [
  ['wp_001', '3.12 (7).png', '黄金钢笔', 'RED', 1],
  ['wp_002', '3.12 (6).png', '左轮手枪', 'PURPLE', 0.9],
  ['wp_003', '3.12 (5).png', '打火机', 'PURPLE', 0.9],
  ['wp_004', 'export_副本.png', '手提包', 'BLUE', 0.8],
  ['wp_005', 'export (1).png', '拳套', 'BLUE', 0.8],
  ['wp_006', 'export (2).png', '礼宾伞', 'GREEN', 0.6],
  ['wp_007', 'export (3).png', '旅行箱', 'GREEN', 0.6]
]

const armors = [
  ['ar_001', '3.12 (3).png', '急救腰包', 'RED'],
  ['ar_002', '3.12 (4).png', '安全帽', 'GREEN'],
  ['ar_003', 'export (4).png', '泡泡防护罩', 'RED'],
  ['ar_004', 'export (5).png', '堆叠抱枕', 'RED'],
  ['ar_005', 'export (7).png', '赌场圆盾', 'GREEN'],
  ['ar_006', 'export (8).png', '废筹码垫板', 'GREEN'],
  ['ar_007', 'export (9).png', '地毯披风', 'GREEN'],
  ['ar_008', 'export (10).png', '旧扑克护片', 'GREEN'],
  ['ar_009', 'export (11).png', '蒙面眼罩', 'GREEN'],
  ['ar_010', 'export (12).png', '纸杯头盔', 'GREEN'],
  ['ar_011', 'export (13).png', '纸箱护甲', 'GREEN'],
  ['ar_012', 'export (14).png', '雨伞护罩', 'RED']
]

const loot = [
  ['loot_001', '3.12 (2).png', '高级西装', 'RED', 25000],
  ['loot_002', 'export (15).png', '纯金扑克', 'RED', 20000],
  ['loot_003', 'export (16).png', '赌徒之眼', 'RED', 50000],
  ['loot_004', 'export (17).png', '老虎机芯片', 'RED', 50000],
  ['loot_005', 'export (18).png', '庄家房卡', 'RED', 60000],
  ['loot_006', 'export (19).png', '劳力士手表', 'RED', 90000],
  ['loot_007', 'export (20).png', '十万筹码', 'RED', 100000],
  ['loot_008', 'export (21).png', '丢失银行卡', 'RED', 100000],
  ['loot_009', 'export (22).png', '爱马仕包', 'RED', 200000],
  ['loot_010', 'export (23).png', '黑色丝袜', 'GREEN', 10],
  ['loot_011', 'export (24).png', '荷官手套', 'GREEN', 300],
  ['loot_012', 'export (25).png', '眼镜', 'GREEN', 2000],
  ['loot_013', 'export (26).png', '双肩包', 'GREEN', 2500],
  ['loot_014', 'export (27).png', '皮带', 'GREEN', 3000],
  ['loot_015', 'export (28).png', '赌徒扑克', 'GREEN', 3000],
  ['loot_016', 'export (29).png', '花呗欠账单', 'GREEN', 5000],
  ['loot_017', 'export (30).png', '指南针', 'GREEN', 5000],
  ['loot_018', 'export (31).png', '灭火器', 'GREEN', 7000],
  ['loot_019', 'export (32).png', '保安服', 'BLUE', 10000],
  ['loot_020', 'export (33).png', '赌徒手指', 'BLUE', 10000],
  ['loot_021', 'export (34).png', '未归还充电宝', 'BLUE', 10000],
  ['loot_022', 'export (35).png', '急救包', 'PURPLE', 15000],
  ['loot_023', 'export (36).png', '遗落钱包', 'PURPLE', 20000]
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
    economy: { currency: 'GOLD', value_source: 'NONE', purchase_price: null, fixed_value: null },
    inventory: { slot_cost: 1, can_pickup: true, can_drop: true, can_steal: true },
    rules: { requires_equipped: false, usable_phases: ['NONE'], effects: [] },
    assets: {
      icon_key: `card_${id}`,
      card_art_key: `card_${id}`,
      card_art_path: `/assets/cards/${id}.jpg`,
      source_file: file,
      sha256
    },
    data_status: 'ACTIVE',
    source: {
      document: '卡牌！美术设计文件夹',
      notes: '卡名与数值由卡面 OCR 后人工校正。',
      ocr_text: ocr ? ocr.lines.map(line => line.text) : []
    }
  }
}

const cards = []

weapons.forEach(([id, file, name, rarity, multiplier]) => {
  const card = baseCard({ id, file, kind: 'EQUIPMENT', category: 'WEAPON', name, rarity, description: `武器卡，攻击倍率${Math.round(multiplier * 100)}%。` })
  card.attack_multiplier = multiplier
  card.economy.value_source = 'PURCHASE_PRICE'
  card.rules.requires_equipped = true
  cards.push(card)
})

armors.forEach(([id, file, name, rarity]) => {
  const card = baseCard({ id, file, kind: 'EQUIPMENT', category: 'ARMOR', name, rarity, description: '防具卡，防御倍率等待玩法数值确认。' })
  card.economy.value_source = 'PURCHASE_PRICE'
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

loot.forEach(([id, file, name, rarity, value]) => {
  const card = baseCard({ id, file, kind: 'LOOT', category: 'LOOT', name, rarity, description: `物资卡，撤离结算价值${value} Gold。` })
  card.economy = { currency: 'GOLD', value_source: 'FIXED_LOOT_VALUE', purchase_price: null, fixed_value: value }
  cards.push(card)
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

const catalog = { schema_version: '0.2.0', generated_at: new Date().toISOString(), cards }
fs.writeFileSync(path.join(root, 'data', 'cards.json'), `${JSON.stringify(catalog, null, 2)}\n`)
fs.mkdirSync(cloudFunctionDirectory, { recursive: true })
fs.writeFileSync(path.join(cloudFunctionDirectory, 'cards.json'), `${JSON.stringify(catalog, null, 2)}\n`)

const projection = cards.map(card => ({
  cardId: card.card_id,
  name: card.name,
  description: card.description,
  kind: card.kind,
  category: card.category,
  rarity: card.rarity,
  attackMultiplier: card.attack_multiplier,
  defenseMultiplier: card.defense_multiplier,
  value: card.economy.fixed_value ?? card.economy.purchase_price,
  assetPath: card.assets.card_art_path,
  dataStatus: card.data_status
}))
const clientModule = `// Generated by scripts/build-card-catalog.js from data/cards.json.\nmodule.exports = ${JSON.stringify(projection, null, 2)}\n`
fs.writeFileSync(path.join(root, 'client', 'data', 'cards.js'), clientModule)

console.log(`Generated ${cards.length} cards and ${publishedPaths.size} optimized server assets.`)
