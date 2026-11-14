// robots.txt semantics for two things: a crawler's own allow/disallow path
// rules, and the rules a site's robots.txt sets for every crawler.

import robotsParser from 'robots-parser';

/** Whether a crawler's own path rules let it queue and fetch `url`. */
export type PathRules = (url: string) => boolean;

export const allowAll: PathRules = () => true;

/** The rules as a robots.txt group for every agent, matched against any url's path. */
export function pathRules(allow: string[], disallow: string[]): PathRules {
  if (!allow.length && !disallow.length) return allowAll;
  const text = [
    'User-agent: *',
    ...allow.map((path) => `Allow: ${path}`),
    ...disallow.map((path) => `Disallow: ${path}`),
  ].join('\n');
  // robots-parser answers only for urls on the robots.txt's own origin
  const byOrigin = new Map<string, ReturnType<typeof robotsParser>>();
  return (url) => {
    const { origin } = new URL(url);
    let robots = byOrigin.get(origin);
    if (!robots) byOrigin.set(origin, (robots = robotsParser(`${origin}/robots.txt`, text)));
    return robots.isAllowed(url) !== false;
  };
}

/** What a site's robots.txt asks of `userAgent`: the seconds between requests, and the urls it may fetch. */
export function siteRobots(
  robotsUrl: string,
  robotsTxt: string,
  userAgent: string,
): { delay: number; allows: PathRules } {
  const robots = robotsParser(robotsUrl, robotsTxt);
  return {
    delay: robots.getCrawlDelay(userAgent) ?? 0,
    allows: (url) => robots.isAllowed(url, userAgent) !== false,
  };
}
