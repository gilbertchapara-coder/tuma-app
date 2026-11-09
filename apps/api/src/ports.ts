/** Sends one-time passwords. Production wires an SMS provider; tests use a fake. Never log the code. */
export interface OtpProvider {
  send(phone: string, code: string): Promise<void>;
}

/** Delivers the parcel's delivery code to the recipient's phone. Never log the code. */
export interface CodeNotifier {
  sendDeliveryCode(phone: string, code: string): Promise<void>;
}
