// One of a site's images fetched as its crawler fetches: with the crawler's
// headers, through the proxy the site's crawler names. For whoever takes the
// catalogue elsewhere and must not reach the site any other way.

import { Database } from 'sqlex';
import { request } from 'yareq';

import { REQUEST_HEADERS } from './base-crawler';
import { proxies, proxySpec, refusedStatus, viaProxy } from './proxy';
import { sha1 } from './utils';

/** Largest image passed on, in bytes. */
export const MAX_IMAGE_BYTES = 30_000_000;

export interface SiteImage {
  statusCode: number;
  contentType: string;
  body: Buffer;
}

const IMAGE_HEADERS: [string, string][] = [
  ...REQUEST_HEADERS.filter(([name]) => name.toLowerCase() !== 'accept'),
  ['Accept', 'image/webp,image/png,image/jpeg,image/*;q=0.8'],
];

/**
 * The image at `url` as the site - by name or id - serves it; null when jscrawl holds no
 * such image url of the site. The url may be written as a feed writes it, a comma as %2C.
 */
export async function fetchSiteImage(
  db: Pick<Database, 'query'>,
  site: string,
  url: string,
  signal?: AbortSignal,
): Promise<SiteImage | null> {
  const hashes = [...new Set([url, url.replace(/%2C/gi, ',')])].map(sha1);
  const [row] = await db.query<
    { url: string; proxy_type: string | null; proxy_country: string | null }[]
  >(
    `select u.url, c.proxy_type, c.proxy_country
       from url u join site s on s.id = u.site_id left join crawler c on c.id = s.crawler_id
      where u.hash in (?) and u.type = 'image' and (s.name = ? or cast(s.id as text) = ?)`,
    hashes,
    site,
    site,
  );
  if (!row) return null;
  const spec = proxySpec({
    proxyType: row.proxy_type,
    proxyCountry: row.proxy_country,
  });
  const proxy = spec && (await proxies().get(spec));
  const send = (route?: string) =>
    request(row.url, {
      headers: IMAGE_HEADERS,
      redirect: 'follow',
      timeout: 30_000,
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
      responseType: 'buffer',
      ...(route ? { proxy: route } : {}),
    });
  const response = proxy
    ? await viaProxy(proxy, 2, () => send(proxy.url), refusedStatus)
    : await send();
  return {
    statusCode: response.statusCode,
    contentType: response.contentType,
    body: response.body as Buffer,
  };
}
