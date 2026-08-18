// The all-resolves control: every tool must report exactly nothing in
// this file. If something starts firing here, the finding is the bug.

import Foundation

let defaultConfig = "basic"

/// Loads the configuration this package was built with.
public func loadConfig() -> String {
    return defaultConfig
}

/// Decodes a value using `JSONDecoder`.
public func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    return try JSONDecoder().decode(type, from: data)
}
