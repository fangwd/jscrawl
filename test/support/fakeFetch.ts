// A fetcher over a fixed set of bodies, so the sitemap and coverage tests never
// reach the network: a url missing from the map is a 404.

export const fetching = (files: Record<string, string>) => async (url: string): Promise<string> => {
  const body = files[url];
  if (body === undefined) throw new Error(`404 ${url}`);
  return body;
};

/** A sitemap listing these paths on `origin`. */
export const sitemapXml = (origin: string, paths: string[]) =>
  `<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
