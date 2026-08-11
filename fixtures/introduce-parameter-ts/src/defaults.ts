export function greet(name: string): string {
  return ['Hello', name].join(', ');
}

export function greetAda(): string {
  return greet('Ada');
}
