import type { Page } from 'puppeteer';
import { logger } from './logger.js';

const DISCORD_BASE = 'https://discord.com';
const LOGIN_URL = `${DISCORD_BASE}/login`;
const DM_URL = (userId: string) => `${DISCORD_BASE}/channels/@me/${userId}`;

// Selectors — Discord's UI uses data-testid and aria labels
const SELECTORS = {
  // Login page
  emailInput: 'input[name="email"]',
  passwordInput: 'input[name="password"]',
  loginButton: 'button[type="submit"]',

  // Logged-in indicators
  userArea: '[class*="panels_"] [class*="container_"]',
  guildList: '[class*="guilds_"]',

  // DM voice call
  voiceCallButton: '[aria-label="Start Voice Call"], [aria-label="Sprachanruf starten"]',
  hangUpButton: '[aria-label="Disconnect"], [aria-label="Trennen"]',

  // Incoming call
  incomingCallContainer: '[class*="ringing"]',
  answerButton: '[aria-label="Accept"], [aria-label="Join Call"], [aria-label="Annehmen"]',

  // Call connected indicator
  voiceConnected: '[class*="rtcConnectionStatus_"]',

  // Chat area (to verify DM navigation)
  chatContent: '[class*="chatContent_"]',
};

export type IncomingCallCallback = () => void | Promise<void>;

/**
 * Discord Web automation — login, navigate DMs, manage voice calls
 */
export class DiscordWeb {
  private page: Page;
  private incomingCallObserver: ReturnType<typeof setInterval> | null = null;
  private onIncomingCallCallback: IncomingCallCallback | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Login with email and password
   */
  async login(email: string, password: string): Promise<boolean> {
    logger.info('Navigating to Discord login...');
    await this.page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check if already logged in (session persisted)
    if (await this.isLoggedIn()) {
      logger.info('Already logged in (session persisted)');
      return true;
    }

    logger.info('Filling login credentials...');

    // Wait for login form
    await this.page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });

    // Clear and type email
    await this.page.click(SELECTORS.emailInput, { clickCount: 3 });
    await this.page.type(SELECTORS.emailInput, email, { delay: 50 });

    // Clear and type password
    await this.page.click(SELECTORS.passwordInput, { clickCount: 3 });
    await this.page.type(SELECTORS.passwordInput, password, { delay: 50 });

    // Click login
    await this.page.click(SELECTORS.loginButton);

    // Wait for login to complete (guild list appears)
    try {
      await this.page.waitForSelector(SELECTORS.guildList, { timeout: 30000 });
      logger.info('Login successful');
      return true;
    } catch {
      logger.error('Login failed — guild list did not appear. Check credentials or captcha.');
      return false;
    }
  }

  /**
   * Check if the user is currently logged in
   */
  async isLoggedIn(): Promise<boolean> {
    try {
      // Check for guild sidebar — reliable indicator of logged-in state
      const guildList = await this.page.$(SELECTORS.guildList);
      return guildList !== null;
    } catch {
      return false;
    }
  }

  /**
   * Navigate to a DM channel with a specific user
   */
  async navigateToDM(userId: string): Promise<boolean> {
    const url = DM_URL(userId);
    logger.info(`Navigating to DM with user ${userId}...`);

    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for chat content to load
    try {
      await this.page.waitForSelector(SELECTORS.chatContent, { timeout: 10000 });
      logger.info('DM channel loaded');
      return true;
    } catch {
      logger.error('Failed to load DM channel');
      return false;
    }
  }

  /**
   * Start a voice call in the current DM
   */
  async startCall(): Promise<boolean> {
    logger.info('Starting voice call...');

    try {
      await this.page.waitForSelector(SELECTORS.voiceCallButton, { timeout: 5000 });
      await this.page.click(SELECTORS.voiceCallButton);

      // Wait a moment for the call to connect
      await this.delay(3000);

      logger.info('Voice call initiated');
      return true;
    } catch {
      logger.error('Failed to start voice call — button not found');
      return false;
    }
  }

  /**
   * Answer an incoming call
   */
  async answerCall(): Promise<boolean> {
    logger.info('Attempting to answer incoming call...');

    try {
      await this.page.waitForSelector(SELECTORS.answerButton, { timeout: 10000 });
      await this.page.click(SELECTORS.answerButton);

      await this.delay(2000);

      logger.info('Call answered');
      return true;
    } catch {
      logger.error('No incoming call to answer');
      return false;
    }
  }

  /**
   * Hang up the current call
   */
  async hangUp(): Promise<boolean> {
    logger.info('Hanging up...');

    try {
      // Try the disconnect button
      const hangUpBtn = await this.page.$(SELECTORS.hangUpButton);
      if (hangUpBtn) {
        await hangUpBtn.click();
        logger.info('Call ended');
        return true;
      }

      // Fallback: press the disconnect keyboard shortcut or look for alternative buttons
      logger.warn('Hang up button not found, trying alternative methods...');
      return false;
    } catch {
      logger.error('Failed to hang up');
      return false;
    }
  }

  /**
   * Check if currently in a voice call
   */
  async isInCall(): Promise<boolean> {
    try {
      const indicator = await this.page.$(SELECTORS.voiceConnected);
      return indicator !== null;
    } catch {
      return false;
    }
  }

  /**
   * Register a callback for incoming calls and start polling
   */
  onIncomingCall(callback: IncomingCallCallback): void {
    this.onIncomingCallCallback = callback;

    if (this.incomingCallObserver) {
      clearInterval(this.incomingCallObserver);
    }

    // Poll for incoming call UI every 2 seconds
    this.incomingCallObserver = setInterval(() => {
      void this.checkForIncomingCall();
    }, 2000);

    logger.info('Incoming call observer started');
  }

  /**
   * Stop watching for incoming calls
   */
  stopIncomingCallWatch(): void {
    if (this.incomingCallObserver) {
      clearInterval(this.incomingCallObserver);
      this.incomingCallObserver = null;
    }
    this.onIncomingCallCallback = null;
    logger.debug('Incoming call observer stopped');
  }

  /**
   * Get the current page URL
   */
  getCurrentUrl(): string {
    return this.page.url();
  }

  private async checkForIncomingCall(): Promise<void> {
    try {
      const ringing = await this.page.$(SELECTORS.incomingCallContainer);
      if (ringing && this.onIncomingCallCallback) {
        logger.info('Incoming call detected!');
        // Stop polling once we detect a call to avoid duplicate triggers
        this.stopIncomingCallWatch();
        await this.onIncomingCallCallback();
      }
    } catch {
      // Page might be navigating, ignore transient errors
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
