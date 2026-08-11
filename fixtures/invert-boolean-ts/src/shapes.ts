export interface Togglable {
  active: boolean;
}

export class Switch implements Togglable {
  active = false;

  flip(): void {
    this.active = !this.active;
  }
}
