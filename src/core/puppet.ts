import type { Browser, Page } from 'puppeteer';

interface FetchResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

class WebClient {
  private browser: Browser;
  private page: Page;

  private constructor(browser: Browser, page: Page) {
    this.browser = browser;
    this.page = page;
  }

  /** A browser, through `proxy` (a yareq proxy url) when given. */
  public static async create(proxy?: string): Promise<WebClient> {
    const { default: puppeteer } = await import('puppeteer');
    const { args, credentials } = browserProxy(proxy);
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...args],
    });
    const page = await browser.newPage();
    if (credentials) await page.authenticate(credentials);
    return new WebClient(browser, page);
  }

  /** Loads `url`; `timeout` (ms) bounds the navigation, puppeteer's 30 s by default. */
  public async fetch(url: string, timeout?: number): Promise<FetchResponse> {
    const response = await this.page.goto(url, {
      waitUntil: 'networkidle2',
      ...(timeout ? { timeout } : {}),
    });

    if (!response) {
      throw new Error('Failed to fetch the URL: ' + url);
    }

    const body = await this.page.content();
    const headers = response.headers();
    const status = response.status();

    return { url: response.url(), status, headers, body };
  }

  public async close() {
    await this.browser.close();
  }
}

/**
 * Chrome's flag for a yareq proxy url, and the credentials a page answers the
 * proxy's challenge with: Chrome ignores credentials in the flag. Chrome
 * resolves host names through a SOCKS5 proxy itself, so `socks5h` is plain
 * `socks5` to it.
 */
export function browserProxy(proxy?: string): {
  args: string[];
  credentials: { username: string; password: string } | null;
} {
  if (!proxy) return { args: [], credentials: null };
  const url = new URL(proxy.replace(/^socks5h:/, 'socks5:'));
  const credentials =
    url.username || url.password
      ? {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        }
      : null;
  return { args: [`--proxy-server=${url.protocol}//${url.host}`], credentials };
}

export default WebClient;
