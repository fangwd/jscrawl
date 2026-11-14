import { readFile } from 'fs/promises';

import { request, Response, RequestOptions } from 'yareq';

import WebClient from './puppet';

export { Response };
export type { RequestOptions };

/** Read a raw fixture or a yareq snapshot (including gzip bodies). */
export async function readPage(
  file: string,
  pageUrl = 'https://example.invalid/page',
): Promise<Response> {
  const body = await readFile(file);
  const newline = body.indexOf(0x0a);
  let stored: any;
  if (newline >= 0) {
    try {
      stored = JSON.parse(body.subarray(0, newline).toString('utf8'));
    } catch {
      /* raw page */
    }
  }
  if (
    stored &&
    typeof stored.requestUrl === 'string' &&
    typeof stored.statusCode === 'number' &&
    typeof stored.fetchStart === 'string' &&
    stored.headers
  ) {
    return Response.load(file);
  }
  const now = new Date();
  return new Response({
    url: pageUrl,
    requestUrl: pageUrl,
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    httpVersion: '1.1',
    body,
    fetchStart: now,
    fetchEnd: now,
  });
}

export interface HttpClient {
  get(url: string, options: RequestOptions): Promise<Response>;
  close(): Promise<void>;
}

export class DefaultHttpClient implements HttpClient {
  get(url: string, options: RequestOptions): Promise<Response> {
    return request(url, { ...options, responseType: 'buffer' });
  }
  close() {
    return Promise.resolve();
  }
}

export class PuppetClient implements HttpClient {
  client: WebClient | null;
  constructor() {
    this.client = null;
  }

  /** The browser is launched on the first request, through that request's proxy. */
  async get(url: string, options: RequestOptions): Promise<Response> {
    if (!this.client) {
      this.client = await WebClient.create(options.proxy?.toString());
    }
    const fetchStart = new Date();
    const rawResponse = await this.client.fetch(url, options.timeout);
    return new Response({
      url: rawResponse.url,
      requestUrl: url,
      statusCode: rawResponse.status,
      headers: rawResponse.headers,
      httpVersion: '1.1',
      body: Buffer.from(rawResponse.body, 'utf-8'),
      fetchStart,
      fetchEnd: new Date(),
    });
  }
  /** Closes the browser; the next request launches a new one. */
  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }
}
