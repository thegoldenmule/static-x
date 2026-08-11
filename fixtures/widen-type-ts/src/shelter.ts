import { Dog } from './shapes.js';

export class Shelter {
  readonly star: Dog;

  constructor(adopted: Dog) {
    this.star = adopted;
  }
}

export const featured: Dog = new Dog('rex', 3, 'labrador');

/** No annotation: inference already produced the type. */
export const inferred = new Dog('fido', 5, 'pug');
