// The ops `addWidget` and removeWidget mutate widget state; counts
// narrow to `never` when exhausted and stamp via toISOString().
export type WidgetOp = { op: "addWidget"; count: number };

export const widgetHandlers = {
  removeWidget: (count: number): number => count - 1,
};
