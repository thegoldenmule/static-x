export interface Widget {
  id: string;
}

export function makeWidget(id: string): Widget {
  return { id };
}
