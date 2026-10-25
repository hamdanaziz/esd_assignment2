// shared/errors.js
// Domain errors. The HTTP service and the gRPC service each translate these
// into their own status vocabulary (see the mapping table in docs/A2-REPORT.md),
// so the business rules never need to know which protocol called them.

class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = this.constructor.name;
    this.code = code; // stable machine-readable code, e.g. VALIDATION_ERROR
    this.details = details; // optional [{ field, issue }]
  }
}

class ValidationError extends DomainError {
  constructor(message, details) {
    super('VALIDATION_ERROR', message, details);
  }
}

class NotFoundError extends DomainError {
  constructor(message = 'order not found') {
    super('NOT_FOUND', message);
  }
}

// Valid request, but the order is in a state that does not allow it.
class ConflictError extends DomainError {
  constructor(message) {
    super('CONFLICT', message);
  }
}

// Same Idempotency-Key re-used with a different request body.
class IdempotencyKeyReuseError extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key was already used with a different request body'
    );
  }
}

module.exports = {
  DomainError,
  ValidationError,
  NotFoundError,
  ConflictError,
  IdempotencyKeyReuseError,
};
