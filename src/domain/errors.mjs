export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new DomainError(code, message, details);
}
