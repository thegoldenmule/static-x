type Constructor<T> = new (...args: any[]) => T;

export class Widget {
  paint(): string {
    return 'widget';
  }
}

export function withLogging<T extends Constructor<object>>(Base: T) {
  return class extends Base {
    log(message: string): string {
      return message;
    }
  };
}

export class Panel extends Widget {
  /** Panels announce themselves. */
  announce(): string {
    return 'panel';
  }
}

/** The mixin base is a call, so the checker resolves no class symbol for it. */
export class Overlay extends withLogging(Widget) {
  announce(): string {
    return 'overlay';
  }
}
