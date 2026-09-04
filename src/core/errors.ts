export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
}

export class IntegrityError extends Error {
  override readonly name = "IntegrityError";
}

export class RetryableToolError extends Error {
  override readonly name = "RetryableToolError";
}

export class PolicyDeniedError extends Error {
  override readonly name = "PolicyDeniedError";
}

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
}
