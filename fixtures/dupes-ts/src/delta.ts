// A named-arrow exact pair: names come from the enclosing variable
// declarations, which the collector must infer without parent pointers
// (program-parsed files leave node.parent unset until binding).
export const mergeStages = (limits: number[]): number[] => {
  const merged: number[] = [];
  let index = 0;
  while (index < limits.length) {
    const limit = limits[index] ?? 0;
    merged.push(limit > 0 ? limit : -limit);
    index += 1;
  }
  return merged;
};

export const mergeSteps = (limits: number[]): number[] => {
  const merged: number[] = [];
  let index = 0;
  while (index < limits.length) {
    const limit = limits[index] ?? 0;
    merged.push(limit > 0 ? limit : -limit);
    index += 1;
  }
  return merged;
};

// Large but unique: a group with a single member never produces findings.
export function soloStage(codes: number[]): string {
  switch (codes.length) {
    case 0:
      return 'empty';
    case 1:
      return 'single';
    default: {
      let label = '';
      for (const code of codes) {
        label += String(code);
      }
      return label;
    }
  }
}
