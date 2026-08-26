struct GatewayHealthPolicy {
  private(set) var consecutiveFailures = 0
  let failureThreshold: Int

  init(failureThreshold: Int = 3) {
    self.failureThreshold = max(1, failureThreshold)
  }

  mutating func observe(healthy: Bool) -> Bool {
    if healthy {
      consecutiveFailures = 0
      return false
    }
    consecutiveFailures += 1
    guard consecutiveFailures >= failureThreshold else { return false }
    consecutiveFailures = 0
    return true
  }
}
