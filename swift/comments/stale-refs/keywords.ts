/**
 * Keywords are not symbols, so no index will ever contain them, and a
 * comment naming `guard` or `associatedtype` in backticks is naming
 * something real.
 */
export const SWIFT_KEYWORDS: ReadonlySet<string> = new Set([
  // Declarations
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import',
  'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'precedencegroup',
  'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var',
  'actor', 'macro', 'package', 'borrowing', 'consuming', 'nonisolated', 'distributed',
  // Statements
  'break', 'case', 'catch', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough',
  'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw', 'switch', 'where', 'while',
  // Expressions and types
  'Any', 'as', 'await', 'catch', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throw',
  'throws', 'true', 'try', 'each', 'consume', 'copy', 'discard', 'some', 'any',
  // Patterns and modifiers
  'associativity', 'convenience', 'didSet', 'dynamic', 'final', 'get', 'indirect',
  'infix', 'lazy', 'left', 'mutating', 'none', 'nonmutating', 'optional', 'override',
  'postfix', 'precedence', 'prefix', 'required', 'right', 'set', 'unowned', 'weak',
  'willSet', 'async', 'isolated', 'sending',
  // Primitive-ish types a comment names constantly
  'Int', 'Double', 'Float', 'Bool', 'String', 'Character', 'Void', 'Never', 'Optional',
  'Array', 'Dictionary', 'Set', 'Result', 'Error',
]);

/**
 * Words that look like code but are prose. Applied only to the bare
 * pass, where a capitalised product name is the common false positive.
 */
export const SWIFT_PROSE_STOPLIST: ReadonlySet<string> = new Set([
  'Swift', 'SwiftUI', 'SwiftPM', 'Xcode', 'DocC', 'macOS', 'iOS', 'iPadOS', 'watchOS',
  'tvOS', 'visionOS', 'UIKit', 'AppKit', 'CoreData', 'XCTest', 'Codable', 'JSON', 'HTTP',
  'HTTPS', 'URL', 'URI', 'API', 'APIs', 'UUID', 'TypeScript', 'JavaScript', 'GitHub',
  'GraphQL', 'WebSocket', 'OAuth', 'PostgreSQL', 'MongoDB', 'CocoaPods', 'Objective',
]);
