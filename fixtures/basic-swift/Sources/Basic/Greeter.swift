// The stale-refs cases. Every reference below is either deliberately
// resolvable or deliberately not, and the test asserts which.

/// Builds a greeting.
///
/// - Parameter userName: no parameter is called this, so it is stale.
/// - Parameter excited: this one is real.
public func greet(name: String, excited: Bool) -> String {
    return excited ? "Hello, \(name)!" : "Hello, \(name)."
}

/// Formats a salutation for a recipient.
///
/// Swift declares both an argument label and an internal name, and a
/// doc comment naming either is correct. Both tags below must resolve.
///
/// - Parameter for: the argument label a caller writes.
/// - Parameter recipient: the internal name the body uses.
public func salute(for recipient: String) -> String {
    return "Dear \(recipient)"
}

/// Uses ``LegacyGreeter`` under the hood, which no longer exists.
/// Also mentions `formatSalutation`, which was renamed to `salute`.
/// But `greet` and ``Greeter/salute(for:)`` both still resolve, as does
/// `String` and `JSONDecoder` from the SDK.
public struct Greeter {
    public func run() -> String {
        return greet(name: "world", excited: true)
    }
}
