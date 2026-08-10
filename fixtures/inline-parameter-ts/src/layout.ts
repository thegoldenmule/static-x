export function connect(
  host: string,
  port: number,
  secure: boolean,
): string {
  return `${secure ? 'https' : 'http'}://${host}:${port}`;
}

export function connectHome(): string {
  return connect('localhost', 8080, true);
}

export function connectAway(): string {
  return connect(
    'example.com',
    9090,
    true,
  );
}

export function stamp(label: string, time: number): string {
  return `${label}@${time}`;
}

export function stampA(): string {
  return stamp('a', Date.now());
}

export function stampB(): string {
  return stamp('b', Date.now());
}
