export function connect(
  host: string,
  port: number,
): string {
  return ['https', host, port].join(':');
}

export function connectHome(): string {
  return connect('localhost', 8080);
}

export function connectAway(): string {
  return connect(
    'example.com',
    9090,
  );
}
