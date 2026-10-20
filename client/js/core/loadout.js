const C = require('./constants')

class LoadoutSession {
  constructor(options) {
    this.cards = options.cards
    this.ownedCardIds = this.cards.map(card => card.cardId)
    this.selectedCardIds = []
    this.limit = options.limit || C.LOADOUT_CARD_LIMIT
  }

  add(cardId) {
    if (!this.ownedCardIds.includes(cardId)) return { ok: false, reason: 'NOT_OWNED' }
    if (this.selectedCardIds.includes(cardId)) return { ok: false, reason: 'ALREADY_SELECTED' }
    if (this.selectedCardIds.length >= this.limit) return { ok: false, reason: 'LOADOUT_FULL' }
    this.selectedCardIds.push(cardId)
    return { ok: true, selectedCardIds: this.selectedCardIds.slice() }
  }

  remove(cardId) {
    if (!this.selectedCardIds.includes(cardId)) return { ok: false, reason: 'NOT_SELECTED' }
    this.selectedCardIds = this.selectedCardIds.filter(id => id !== cardId)
    return { ok: true, selectedCardIds: this.selectedCardIds.slice() }
  }

  warehouseCardIds() {
    return this.ownedCardIds.filter(cardId => !this.selectedCardIds.includes(cardId))
  }

  snapshot() {
    return {
      ownedCardIds: this.ownedCardIds.slice(),
      selectedCardIds: this.selectedCardIds.slice(),
      warehouseCardIds: this.warehouseCardIds(),
      limit: this.limit,
      backpackSlots: C.BACKPACK_SLOTS
    }
  }
}

module.exports = { LoadoutSession }
