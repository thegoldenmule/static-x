export class Report {
  title(): string {
    return 'report';
  }
}

export class MonthlyReport extends Report {
  title(): string {
    return 'monthly';
  }
}
