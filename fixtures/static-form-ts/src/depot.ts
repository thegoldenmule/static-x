import { Vault } from './vault.js';

export function depot(vault: Vault, note: string): string {
  return Vault.seal(vault, note);
}
