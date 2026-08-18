// MARK: - Section one
// A MARK is Xcode's jump-bar structure, not prose. It splits the block
// it sits in, exactly as an eslint-disable does in the TypeScript pack,
// and it is never itself reported.

// This run and the run below it are separated by the MARK between
// them. Without the split they would merge into one block long enough
// to trip comments/long, which would be a finding invented by the
// grouping rather than found in the source. That is the case this
// file exists to pin, and it needs enough lines to be over the limit
// on its own if the split ever stops working correctly here.

// MARK: - Section two

// swiftlint:disable force_cast
// swift-format-ignore
// TODO: none of the four lines above are prose
// FIXME: and none of them may be reported

func marked() -> Int { 1 }
