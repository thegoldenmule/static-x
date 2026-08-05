// The ops `addWidget` and removeWidget mutate widget state; counts
// narrow to `never` when exhausted and stamp via toISOString().
// Arithmetic lives in math.ts; the retired helpers were in
// legacy-utils.ts before the extraction. Construction mirrors
// makeOptions in the sibling package.
export type WidgetOp = { op: "addWidget"; count: number };

export const widgetHandlers = {
  removeWidget: (count: number): number => count - 1,
};
