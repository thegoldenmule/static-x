export class Feed {
  hydrate(): string {
    return 'hydrated';
  }
}

export class PlainFeed extends Feed {
  read(): string {
    return this.hydrate();
  }
}
