// A script file (no imports or exports): declares an ambient global
// that cli.ts calls, invisibly to the import graph.
function fixtureGlobal(): number {
  return 7;
}
