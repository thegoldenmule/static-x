// An anonymous exact pair: no declared or inferred name exists, so the
// findings' ignore key falls back to the file-qualified
// 'src/epsilon.ts:(anonymous)' form.
export const summers = [
  (values: number[]): number => {
    let total = 0;
    let peak = 0;
    for (const value of values) {
      total += value;
      if (value > peak) {
        peak = value;
      }
    }
    return total * peak;
  },
  (values: number[]): number => {
    let total = 0;
    let peak = 0;
    for (const value of values) {
      total += value;
      if (value > peak) {
        peak = value;
      }
    }
    return total * peak;
  },
];
