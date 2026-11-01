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

  public static async create(): Promise<WebClient> {
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE,
      headless: true,
      args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ],
    });
    const page = await browser.newPage();
    return new WebClient(browser, page);
  }

  public async fetch(url: string): Promise<FetchResponse> {
    const response = await this.page.goto(url, { waitUntil: 'networkidle2' });

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

export default WebClient;
