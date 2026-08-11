import { Dog } from './shapes.js';

function track(_target: object, _key: string): void {}

export class Registry {
  @track
  headliner: Dog = new Dog('spot', 2, 'beagle');

  name(): string {
    return this.headliner.name;
  }
}
