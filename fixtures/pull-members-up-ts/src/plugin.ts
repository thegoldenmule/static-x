import { VendorBase } from './vendor.js';

export class Plugin extends VendorBase {
  /** Human-readable label for the plugin. */
  label(): string {
    return `plugin ${this.tag()}`;
  }
}
