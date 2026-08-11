function traced<T, A extends unknown[], R>(
  original: (this: T, ...args: A) => R,
  _context: ClassMethodDecoratorContext,
): (this: T, ...args: A) => R {
  return original;
}

export class Job {
  id = 0;

  /** What to call this job in a log line. */
  name(): string {
    return 'job';
  }
}

export class TimedJob extends Job {
  /** Runs the job, with the tracing decorator installed. */
  @traced
  run(): number {
    return this.id;
  }

  override name(): string {
    return 'timed';
  }
}
