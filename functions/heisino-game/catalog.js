const equipment = [
  ...Array.from({ length: 7 }, (_, index) => ({ cardId: `wp_${String(index + 1).padStart(3, '0')}`, kind: 'EQUIPMENT', category: 'WEAPON' })),
  ...Array.from({ length: 13 }, (_, index) => ({ cardId: `ar_${String(index + 1).padStart(3, '0')}`, kind: 'EQUIPMENT', category: 'ARMOR' }))
]

const loot = Array.from({ length: 23 }, (_, index) => ({
  cardId: `loot_${String(index + 1).padStart(3, '0')}`,
  kind: 'LOOT',
  category: 'LOOT'
}))

const skills = Array.from({ length: 10 }, (_, index) => ({
  cardId: `sk_${String(index + 1).padStart(3, '0')}`,
  kind: 'SKILL',
  category: 'SKILL'
}))

module.exports = [...equipment, ...loot, ...skills]
