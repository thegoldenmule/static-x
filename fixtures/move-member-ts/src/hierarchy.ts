export class Report {
  static title(): string {
    return 'report';
  }
}

export class MonthlyReport extends Report {
  static title(): string {
    return 'monthly report';
  }
}
