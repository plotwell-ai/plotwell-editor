import { type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = path.resolve(__dirname, '../output/screenshots');

/**
 * Take a named screenshot, saved as `{scenario}-{label}.png`.
 */
export async function takeScreenshot(
  page: Page,
  scenario: string,
  label: string
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `${scenario}-${label}.png`;
  await page.screenshot({ path: path.join(OUTPUT_DIR, filename), fullPage: false });
}
