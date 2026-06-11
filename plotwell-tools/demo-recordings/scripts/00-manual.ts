import { test } from '@playwright/test';
import { saveVideo } from '../utils/video';

/**
 * Manual recording mode — browser opens and you drive it yourself.
 *
 * Configure via env vars (or demo/.env):
 *   RECORD_URL     Starting URL  (default: http://localhost:5173)
 *   RECORD_NAME    Output filename prefix  (default: manual)
 *   RECORD_TIMEOUT Max recording time in minutes  (default: 10)
 */

const START_URL  = process.env.RECORD_URL     ?? 'http://localhost:5173';
const NAME       = process.env.RECORD_NAME    ?? 'manual';
const TIMEOUT_MS = Number(process.env.RECORD_TIMEOUT ?? 10) * 60 * 1_000;

test(`Manual recording — ${NAME}`, async ({ page }) => {
  await page.goto(START_URL);

  console.log('\n──────────────────────────────────────────');
  console.log(`  Recording started: ${NAME}`);
  console.log(`  URL: ${START_URL}`);
  console.log(`  Max duration: ${TIMEOUT_MS / 60_000} min`);
  console.log('  Close the browser window to stop early.');
  console.log('──────────────────────────────────────────\n');

  // Wait until window is closed by user OR timeout is reached
  await Promise.race([
    page.waitForEvent('close', { timeout: 0 }).catch(() => {}),
    page.waitForTimeout(TIMEOUT_MS),
  ]);

  console.log('\n  Saving video...');
  await saveVideo(page, NAME);
  console.log('  Done.\n');
});
