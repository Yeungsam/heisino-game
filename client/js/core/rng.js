function createSeededRng(seed) {
  let state = seed >>> 0
  return function random() {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive)
}

function shuffled(items, rng) {
  const result = items.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, index + 1)
    const current = result[index]
    result[index] = result[swapIndex]
    result[swapIndex] = current
  }
  return result
}

module.exports = { createSeededRng, randomInt, shuffled }
