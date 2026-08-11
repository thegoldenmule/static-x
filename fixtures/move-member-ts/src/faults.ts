export class ParseFault extends Error {
  static isFault(error: unknown): error is ParseFault {
    return error instanceof ParseFault;
  }
}

export class TimeoutFault extends Error {}

export class QuotaFault extends Error {}
