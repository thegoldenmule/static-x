export class Ctx {
  readonly name = 'ctx';

  /**
   * A `this` parameter occupies a slot in the declaration's parameter
   * list and none in the argument list, so value-parameter index 0 is
   * declaration index 1 here.
   */
  run(this: Ctx, message: string): string {
    return [this.name, 'boot', message].join(' ');
  }
}

export function runAll(ctx: Ctx): string[] {
  return [ctx.run('one'), ctx.run('two')];
}
