export class Ctx {
  readonly name = 'ctx';

  /**
   * A `this` parameter occupies a slot in the declaration's parameter
   * list but none in the argument list, so `stage` is declaration index
   * 1 and argument index 0.
   */
  run(this: Ctx, stage: string, message: string): string {
    return `${this.name} ${stage} ${message}`;
  }
}

export function runAll(ctx: Ctx): string[] {
  return [ctx.run('boot', 'one'), ctx.run('boot', 'two')];
}
