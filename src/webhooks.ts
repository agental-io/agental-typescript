/**
 * Whether a webhook came from agental. Pass the request's body exactly as it arrived,
 * before any JSON parsing, the value of its X-Agental-Signature header, and the webhook's
 * signing secret.
 */
export async function verifyWebhook(body: string | Uint8Array, signature: string | null | undefined, secret: string): Promise<boolean> {
  const sent = /^sha256=([0-9a-f]{64})$/.exec(signature?.trim() ?? "")?.[1];
  if (!sent) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(sent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  // verify compares in constant time, which a comparison of two strings does not.
  return await crypto.subtle.verify("HMAC", key, bytes, typeof body === "string" ? encoder.encode(body) : new Uint8Array(body));
}
