import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolve } from 'node:path';
import { logger } from './logger.js';

export interface BrowserManagerConfig {
  profileDir: string;
  blackholeDevice: string;
  headless: boolean;
}

/**
 * Manages the Puppeteer browser lifecycle with persistent profile
 * and BlackHole virtual audio device configuration
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: BrowserManagerConfig;

  constructor(config: BrowserManagerConfig) {
    this.config = config;
  }

  /**
   * Launch a Chromium browser with stealth settings and audio configuration
   */
  async launch(): Promise<Page> {
    const profilePath = resolve(this.config.profileDir);

    logger.info(`Launching browser with profile: ${profilePath}`);

    // Try to use puppeteer-extra with stealth plugin for anti-detection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let launcher: any = puppeteer;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const pExtra: any = await import('puppeteer-extra');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const stealthPlugin: any = await import('puppeteer-extra-plugin-stealth');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      pExtra.default.use(stealthPlugin.default());
      launcher = pExtra.default;
      logger.info('Stealth plugin loaded');
    } catch {
      logger.warn('puppeteer-extra-plugin-stealth not available, using plain puppeteer');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.browser = await launcher.launch({
      headless: this.config.headless,
      userDataDir: profilePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        // Audio: use fake device for media stream (BlackHole configured at OS level)
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // Allow autoplay for Discord audio
        '--autoplay-policy=no-user-gesture-required',
        // Disable notifications popup
        '--disable-notifications',
        // Performance
        '--disable-dev-shm-usage',
        // Window size
        '--window-size=1280,900',
      ],
      defaultViewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
    }) as Browser;

    // Use the first page or create one
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());

    // Override navigator.webdriver to avoid detection
    await this.page.evaluateOnNewDocument(
      'Object.defineProperty(navigator, "webdriver", { get: () => false })'
    );

    // Grant microphone and camera permissions for Discord
    const context = this.browser.defaultBrowserContext();
    await context.overridePermissions('https://discord.com', [
      'microphone',
      'camera',
      'notifications',
    ]);

    logger.info('Browser launched successfully');
    return this.page;
  }

  /**
   * Get the active page
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Get the browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Check if browser is running
   */
  isRunning(): boolean {
    return this.browser !== null && this.browser.connected;
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      logger.info('Closing browser...');
      await this.browser.close();
      this.browser = null;
      this.page = null;
      logger.info('Browser closed');
    }
  }

  /**
   * Take a screenshot for debugging
   */
  async screenshot(filename: string): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: filename, fullPage: true });
      logger.debug(`Screenshot saved: ${filename}`);
    }
  }
}
