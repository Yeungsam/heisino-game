const C = require('./constants')

const LOADOUT_CATEGORIES = new Set(['WEAPON', 'ARMOR', 'SKILL'])

class LoadoutSession {
  constructor(options) {
    this.cards = options.cards
    this.quantities = { ...(options.quantities || {}) }
    this.ownedCardIds = this.cards.filter(card => this.quantities[card.cardId] > 0).map(card => card.cardId)
    this.loadoutCardIds = new Set(this.cards
      .filter(card => LOADOUT_CATEGORIES.has(String(card.category || '').toUpperCase()))
      .map(card => card.cardId))
    this.selectedCardIds = []
    this.limit = options.limit || C.LOADOUT_CARD_LIMIT
    this.equipmentLimit = options.equipmentLimit
  }

  add(cardId) {
    if (!this.ownedCardIds.includes(cardId)) return { ok: false, reason: 'NOT_OWNED' }
    if (!this.loadoutCardIds.has(cardId)) return { ok: false, reason: 'LOADOUT_CATEGORY_NOT_ALLOWED' }
    if (this.equipmentLimit) {
      const category = this.cards.find(card => card.cardId === cardId)?.category
      if (['WEAPON', 'ARMOR'].includes(category) && this.selectedCardIds.some(id => this.cards.find(card => card.cardId === id)?.category === category)) {
        return { ok: false, reason: `${category}_LIMIT` }
      }
    }
    if (this.selectedCardIds.filter(id => id === cardId).length >= this.quantities[cardId]) return { ok: false, reason: 'NOT_OWNED' }
    if (this.selectedCardIds.length >= this.limit) return { ok: false, reason: 'LOADOUT_FULL' }
    this.selectedCardIds.push(cardId)
    return { ok: true, selectedCardIds: this.selectedCardIds.slice() }
  }

  remove(cardId) {
    if (!this.selectedCardIds.includes(cardId)) return { ok: false, reason: 'NOT_SELECTED' }
    this.selectedCardIds.splice(this.selectedCardIds.indexOf(cardId), 1)
    return { ok: true, selectedCardIds: this.selectedCardIds.slice() }
  }

  warehouseCardIds() {
    return this.ownedCardIds.filter(cardId => this.loadoutCardIds.has(cardId) && this.quantities[cardId] > this.selectedCardIds.filter(id => id === cardId).length)
  }

  snapshot() {
    return {
      ownedCardIds: this.ownedCardIds.slice(),
      quantities: { ...this.quantities },
      selectedCardIds: this.selectedCardIds.slice(),
      warehouseCardIds: this.warehouseCardIds(),
      limit: this.limit,
      backpackSlots: C.BACKPACK_SLOTS
    }
  }
}

module.exports = { LOADOUT_CATEGORIES, LoadoutSession }
