// The ops `addWidget` and removeWidget mutate widget state.
export type WidgetOp = { op: "addWidget"; count: number };

export const widgetHandlers = {
  removeWidget: (count: number): number => count - 1,
};
