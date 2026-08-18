/**
 * What the language-neutral comment rules need to see. A pack supplies
 * the comment stream — TypeScript from parser trivia, Swift from its
 * language server — and nothing downstream can tell which produced it.
 */
export interface CommentRange {
  pos: number;
  end: number;
  /** `//`-style: terminated by the newline rather than a closing marker. */
  line: boolean;
  /** A documentation comment: JSDoc `/**`, Swift `///`. */
  doc: boolean;
}

export interface CommentBlock {
  pos: number;
  end: number;
  startLine: number;
  endLine: number;
  /** line-block: one or more whole-line `//` comments; block: everything else. */
  kind: 'line-block' | 'block';
  doc: boolean;
}

/** One file's comments, and the text they were found in. */
export interface CommentFile {
  /** Absolute path; goes straight into Finding.file. */
  file: string;
  text: string;
  lineStarts: readonly number[];
  ranges: readonly CommentRange[];
  /**
   * First offset holding code rather than comment or whitespace. Only a
   * block above it can be a license header.
   */
  firstCodeOffset: number;
}
