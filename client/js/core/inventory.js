const STACK_LIMIT = 99

// A stack is a presentation of distinct units; ownership stays on each instance.
function stackItems(items, limit = STACK_LIMIT) {
  const groups = new Map()
  items.forEach(item => {
    if (!groups.has(item.cardId)) groups.set(item.cardId, [])
    groups.get(item.cardId).push(item)
  })
  const slots = []
  groups.forEach((units, cardId) => {
    for (let index = 0; index < units.length; index += limit) {
      const batch = units.slice(index, index + limit)
      slots.push({ ...batch[0], cardId, quantity: batch.length, instanceIds: batch.map(item => item.instanceId) })
    }
  })
  return slots
}

function quantitySlots(quantities) {
  return Object.keys(quantities).sort().flatMap(cardId => {
    const slots = []
    for (let remaining = quantities[cardId], index = 0; remaining > 0; remaining -= STACK_LIMIT, index += 1) {
      slots.push({ cardId, quantity: Math.min(STACK_LIMIT, remaining), stackIndex: index })
    }
    return slots
  })
}

function canAddItem(items, cardId, capacity = 10) {
  return stackItems(items.concat({ cardId, instanceId: '__candidate' })).length <= capacity
}

module.exports = { STACK_LIMIT, stackItems, quantitySlots, canAddItem }
