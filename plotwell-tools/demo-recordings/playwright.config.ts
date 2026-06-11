import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const AUTH_FILE = path.resolve(__dirname, 'output/auth.json');
const hasAuth = fs.existsSync(AUTH_FILE);

export default defineConfig({
  testDir: './scripts',
  testMatch: '**/*.ts',
  timeout: 300_000, // 5 min — agent generation can be slow
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,

  use: {
    headless: false,
    slowMo: 80,
    viewport: { width: 1280, height: 800 },
    // Reuse saved auth session if available — skip login on every run
    storageState: hasAuth ? AUTH_FILE : undefined,
    video: {
      mode: 'on',
      size: { width: 1280, height: 800 },
    },
    screenshot: 'off',
    trace: 'off',
    actionTimeout: 15_000,
  },

  outputDir: './output/test-results',
});
