// The resolution tiers, one case each.

import Foundation

public enum WidgetOp: String {
    case addWidget
    case removeWidget
}

/// Resolves through the string-literal tier: `pipelineStage` is never
/// declared, but it exists as a stored key below.
/// Resolves through the enum tier: `addWidget`.
/// Resolves through the SDK index: `ISO8601DateFormatter` and `sorted`.
/// Resolves through the keyword tier: `guard`.
/// Resolves as a real file in this project: `Math.swift`.
/// Does not resolve, and is the file case: `LegacyUtils.swift`.
/// Does not resolve, and is the symbol case: ``WidgetRegistry``.
/// Must not be read as a file at all, because it is outside the
/// project: `~/.config/basic.json`.
public struct Literals {
    public let keys = ["pipelineStage": 1]

    public func stamp() -> String {
        guard let first = keys.keys.sorted().first else { return "" }
        return ISO8601DateFormatter().string(from: Date()) + first
    }
}
