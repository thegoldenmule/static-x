import { Panel, Ticket, type PanelState } from './panel.js';

export function stock(ticket: Ticket): string {
  return ticket.isEmpty() ? 'none' : 'some';
}

export function render(panel: Panel): string {
  if (panel.expanded) {
    return 'body';
  }
  return '';
}

export function collapse(panel: Panel): void {
  panel.expanded = false;
}

export function flagText(panel: Panel): string {
  return (!panel.expanded).toString();
}

export function caption(state: PanelState): string {
  return state.docked ? 'docked' : 'floating';
}

export function undock(): PanelState {
  return { docked: false };
}
