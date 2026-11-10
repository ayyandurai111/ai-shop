/** Safe-to-show errors: the message may be returned to the user or the AI. */
export class UserError extends Error {}
export class PayPalError extends UserError {}
