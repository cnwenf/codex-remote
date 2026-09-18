struct DesktopRecoveryPolicy {
  private var observedPID: Int32?
  private var unavailableSince: Double?
  private var attemptedPID: Int32?

  mutating func observe(processIdentifier: Int32?, bridgeAvailable: Bool, now: Double) -> Bool {
    guard let pid = processIdentifier, !bridgeAvailable else {
      observedPID = processIdentifier
      unavailableSince = nil
      return false
    }
    if observedPID != pid || unavailableSince == nil {
      observedPID = pid
      unavailableSince = now
    }
    guard attemptedPID != pid, now - unavailableSince! >= 20 else { return false }
    attemptedPID = pid
    return true
  }
}
