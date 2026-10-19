// Audio is intentionally muted for the MVP. Systems may emit stable event names now,
// so the audio team can attach assets later without changing game rules.
class AudioEvents {
  constructor() {
    this.muted = true
    this.listeners = []
  }

  emit(name, payload) {
    if (this.muted) return
    this.listeners.forEach(listener => listener(name, payload))
  }

  subscribe(listener) {
    this.listeners.push(listener)
  }
}

module.exports = new AudioEvents()
