/**
 * Comments that configure tooling or mark structure rather than
 * document code. A directive is dropped and splits whatever block it
 * sits in.
 *
 * `// MARK:` earns its place on a count: 540 occurrences in one 204-file
 * project. It is Xcode's jump-bar structure, not prose, so letting it
 * merge would both inflate block lengths and feed a navigation label to
 * the tell scorer. TODO/FIXME/HACK/XXX are here for the same category
 * reason — Xcode renders them identically and they are notes to self —
 * though their population is small enough (13, 4 and 1 across three
 * corpora) that the choice barely moves a number.
 *
 * `// swift-tools-version:` is line 1 of every package manifest and is
 * load-bearing to SwiftPM.
 */
export const SWIFT_DIRECTIVE =
  /^\/\/\/?\s*(?:MARK:|TODO:|FIXME:|HACK:|XXX:|swiftlint:|swift-format-ignore|swiftformat:|sourcery:|periphery:|swift-tools-version)/;

/** License headers are conventionally long; matched only above the first code. */
export const SWIFT_LICENSE = /\b(?:copyright|licen[cs]e|spdx)\b|\(c\)/i;

/** Strip Swift comment markers, leaving the prose. */
export function swiftContentOf(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/{2,3}|\*)\s?/, ''))
    .join('\n')
    .trim();
}
