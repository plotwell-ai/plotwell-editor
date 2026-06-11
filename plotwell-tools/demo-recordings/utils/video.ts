import { type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = path.resolve(__dirname, '../output/videos');

/**
 * After a test finishes, move the recorded video to the output folder
 * with a clean name: `{scenario}-{date}.webm`
 */
export async function saveVideo(page: Page, scenario: string): Promise<void> {
  const video = page.video();
  if (!video) return;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const dest = path.join(OUTPUT_DIR, `${scenario}-${date}.webm`);

  await page.close(); // finalize the video
  const src = await video.path();
  if (src) {
    fs.copyFileSync(src, dest);
  }
}
