/** A veterinary clinic, with one of every member this tool refuses. */
export class Clinic {
  static readonly OPENING = '09:00';

  #chart: string[] = [];

  visits = 0;

  constructor(public readonly vetName: string) {}

  record(note: string): void {
    this.#chart.push(note);
    this.visits += 1;
  }

  opensAt(): string {
    return Clinic.OPENING;
  }
}
