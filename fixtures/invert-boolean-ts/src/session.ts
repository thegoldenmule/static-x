export let isVisible = false;

export function open(): void {
  isVisible = true;
}

export function close(): void {
  isVisible = false;
}

export function label(): string {
  return isVisible ? 'shown' : 'hidden';
}

export function heading(): string {
  if (!isVisible) {
    return 'collapsed';
  }
  return 'expanded';
}

export function tag(): string {
  return isVisible.toString();
}

export function sync(a: boolean, b: boolean): void {
  isVisible = a && b;
}

export function mirror(): typeof isVisible {
  return isVisible;
}
