import { type Page } from '@playwright/test';

const APP_URL = 'http://localhost:5173';

/**
 * Log into the plotwell app with demo credentials.
 * If not already on the login page, navigates there first.
 */
export async function login(page: Page): Promise<void> {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;

  if (!email || !password) {
    throw new Error('DEMO_EMAIL and DEMO_PASSWORD must be set in demo/.env');
  }

  // Navigate to login page only if not already there
  if (!page.url().includes('/login')) {
    await page.goto(`${APP_URL}/login`);
  }

  // Wait for login form to appear
  await page.waitForSelector('#login-email', { timeout: 15_000 });

  // Fill credentials (no screenshot of this step)
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);

  // Submit
  await page.click('button[type="submit"]');

  // Wait for redirect to projects page
  await page.waitForURL('**/projects**', { timeout: 20_000 });
}
