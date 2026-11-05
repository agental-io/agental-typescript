/** Every error this SDK throws is one of these. */
export class AgentalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API refused the request and said why. Decide what to do from `code`, such as
 * `sandbox_not_running` or `name_taken`. `message` says why in words.
 */
export class ApiError extends AgentalError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * On a create refused with capacity_exceeded: the other regions that have room for its
     * size now, to send it again to with a new key. Empty when none has, and undefined on
     * any other error.
     */
    readonly regionsWithRoom?: string[],
    burst?: { feeMicros?: number; retryAfterSeconds?: number | null },
  ) {
    super(message);
    if (burst?.feeMicros !== undefined) {
      this.feeMicros = burst.feeMicros;
    }
    if (burst?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = burst.retryAfterSeconds;
    }
  }

  /**
   * On a start refused with 429 for its burst (see `BurstRefusalCode`): the burst fee it
   * would have cost, in millionths of a US dollar. Undefined on any other error.
   */
  readonly feeMicros?: number;

  /**
   * On a start refused with 429 for its burst: seconds until the same start would cost no
   * burst fee. Null where waiting would not help: on running_limit_reached, or for a start
   * larger than the plan's whole free burst. Undefined on any other error.
   */
  readonly retryAfterSeconds?: number | null;
}

/**
 * Why a create, fork or start was refused with the status 429. running_limit_reached: the
 * account already runs as many sandboxes as its plan's runningUnits allows. burst_fee_too_high:
 * the start would cost more in burst fees than maxBurstFeeMicros allows. burst_budget_reached:
 * the fee would take this month's burst fees past the account's budget.
 */
export type BurstRefusalCode = "running_limit_reached" | "burst_fee_too_high" | "burst_budget_reached";

/**
 * Something in front of the API answered, not the API: a 502, a 504, a 52x, or any error
 * with no code in it. The API was not reached or did not answer in time, so the request
 * may still be running. Read the sandbox before sending anything but a create again.
 */
export class ProxyError extends AgentalError {
  constructor(readonly status: number) {
    super(
      status >= 500
        ? `HTTP ${status} from a proxy in front of the API, not from the API. The request may still be running.`
        : `HTTP ${status} with no error of the API's in it. Check that baseUrl is where the API answers.`,
    );
  }
}

/** The API could not be reached at all. Whether the request arrived is not known. */
export class ConnectionError extends AgentalError {}

/** What was waited for did not happen in the time allowed. It may still happen. */
export class TimeoutError extends AgentalError {}
