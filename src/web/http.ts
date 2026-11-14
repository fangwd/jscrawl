// The few helpers the core's route handlers share.

import { IncomingMessage, ServerResponse } from 'http';

export function sendJson(res: ServerResponse, status: number, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(text);
}

export async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

/** A path segment as a row id, or null. */
export const digits = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
