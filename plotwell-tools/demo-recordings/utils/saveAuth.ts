/**
 * Run this once to save your login session:
 *   npx ts-node utils/saveAuth.ts
 * OR use the npm script:
 *   npm run auth:save
 *
 * Saves cookies + localStorage to output/auth.json
 * All demo scripts then reuse it automatically — no login needed.
 */
import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const APP_URL = 'http://localhost:5173';
const AUTH_FILE = path.resolve(__dirname, '../output/auth.json');

(async () => {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;

  if (!email || !password) {
    console.error('Set DEMO_EMAIL and DEMO_PASSWORD in demo/.env first.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  console.log('Logging in...');
  await page.goto(`${APP_URL}/login`);
  await page.waitForSelector('#login-email');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/projects**', { timeout: 20_000 });

  // Save the auth state (cookies + localStorage)
  await context.storageState({ path: AUTH_FILE });
  console.log(`Auth saved to ${AUTH_FILE}`);

  await browser.close();
})();
