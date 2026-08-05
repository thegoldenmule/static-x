// An `export =` module: the export= symbol is never audited, and the
// side-effect import in tasks.ts keeps the file alive.
function cjsThing(): number {
  return 5;
}

export = cjsThing;
