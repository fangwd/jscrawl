// Who may call jscrawl's API: whoever holds the service token (JSCRAWL_API_TOKEN),
// sent as a bearer - spidermake, which signs people in, and the agent's tool calls.

import { createHash, timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';

export function isService(req: IncomingMessage, apiToken: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return !!bearer && sameSecret(bearer, apiToken);
}

/** Compares in constant time, whatever the lengths. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
