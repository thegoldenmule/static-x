import { boarded } from './boarding.js';
import { Dog } from './shapes.js';

/** Reads only `.name`, so `Named` is the widest annotation that fits. */
export function label(pet: Dog): string {
  return pet.name;
}

/** Reads `.name` and calls `speak()`: only `Animal` has both. */
export function announce(speaker: Dog): string {
  return `${speaker.name} says ${speaker.speak()}`;
}

/** Reads `.breed` and calls `fetch()` — a pair only `Dog` itself carries. */
export function pedigree(champion: Dog): string {
  return `${champion.breed} ${champion.fetch()}`;
}

/** Reads `.age` and `.breed`, which only the `Vitals` alias has together. */
export function papers(entrant: Dog): string {
  return `${entrant.breed} at ${String(entrant.age)}`;
}

/** Reads `.name` and `.age` — a pair no declared type carries. */
export function audit(subject: Dog): string {
  return `${subject.name}:${String(subject.age)}`;
}

/** Reads `.name`, then hands the value on to something that wants an `Animal`. */
export function invoice(guest: Dog): string {
  return `${guest.name}: ${boarded(guest)}`;
}

/** Reads no member at all — every candidate is decided by the typecheck alone. */
export function forward(passenger: Dog): string {
  return boarded(passenger);
}

/** A second parameter named `subject`, so symbol addressing is ambiguous. */
export function tag(subject: Dog): string {
  return subject.breed;
}
