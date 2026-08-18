// The range-source torture case. Every construct here is one a
// hand-written lexer would have had to get right; sourcekit-lsp's
// semantic tokens get them all, and this file is what proves it.

let plain = "// not a comment"
let block = "/* also not a comment */"

let multiline = """
    // not a comment
    /* nor this */
    """

let raw = #"raw // still not a comment"#
let rawer = ##"the sequence "# does not end this"##
let notInterpolated = #"\(this is literal text)"#
let interpolatedRaw = #"\#(plain)"#

let interpolated = "value: \(plain /* a real comment, inside interpolation */)"
let nested = "outer \("inner \(plain)")"
let escaped = "a \" // not a comment"

/// A doc comment naming a path: `/api/wiki/*`
/// The slash-star above is inside a code span, and inside a comment.
func division(_ a: Int, _ b: Int) -> Int {
    return a / b // a trailing comment, which never merges upward
}

/* an unterminated-looking sequence: */ let after = 1
