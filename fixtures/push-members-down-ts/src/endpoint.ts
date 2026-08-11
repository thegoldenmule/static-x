export class Endpoint {
  ping(): string {
    return 'pong';
  }
}

/** Nothing extends this, so nothing can receive a member pushed off it. */
export class Beacon {
  pulse(): string {
    return 'pulse';
  }
}
