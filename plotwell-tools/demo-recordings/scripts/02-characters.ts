import { test } from '@playwright/test';
import { login } from '../utils/login';
import { takeScreenshot } from '../utils/screenshot';
import { saveVideo } from '../utils/video';

const SCENARIO = '02-characters';

test('Characters extraction and image generation demo', async ({ page }) => {
  // Log in
  await login(page);

  // Dismiss cookie banner if present
  const cookieAccept = page.locator('button:has-text("Accept")');
  if (await cookieAccept.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await cookieAccept.click();
    await page.waitForTimeout(500);
  }

  // Click into the Big Fish project
  await page.waitForLoadState('networkidle');
  const projectCard = page.locator('text=Big Fish').first();
  await projectCard.waitFor({ timeout: 15_000 });
  await projectCard.click();
  await page.waitForURL('**/dashboard/**', { timeout: 15_000 });
  await page.waitForTimeout(4_000); // hold on script view so viewer can see it

  // Dismiss onboarding tour if it appears (click through all steps)
  const tourBtn = page.locator('.driver-popover-next-btn, .driver-popover-done-btn').first();
  while (await tourBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tourBtn.click();
    await page.waitForTimeout(300);
  }

  // Navigate to Characters section by appending ?section=characters to the current dashboard URL
  const currentUrl = page.url();
  const projectId = currentUrl.split('/dashboard/')[1]?.split('?')[0];
  await page.goto(`http://localhost:5173/dashboard/${projectId}?section=characters`);

  // Wait for Characters view to render (Extract with AI button appears)
  // Two buttons match (sm + default size variants) — pick the visible one
  const extractBtn = page.locator('button.text-amber-600[aria-haspopup="menu"]').first();
  await extractBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  await takeScreenshot(page, SCENARIO, 'step-01-characters-empty');

  // Click "Extract with AI" dropdown
  await extractBtn.click();
  await page.waitForTimeout(300);

  // Click "From Script" in dropdown
  const fromScript = page.locator('[role="menuitem"]:has-text("From Script")');
  await fromScript.waitFor({ timeout: 5_000 });
  await fromScript.click();
  await takeScreenshot(page, SCENARIO, 'step-02-extracting');

  // Wait for characters to appear — poll until character cards render
  for (let i = 0; i < 60; i++) {
    const count = await page.locator('h3.font-semibold.text-gray-900').count();
    if (count > 0) break;
    await page.waitForTimeout(2_000);
  }
  await page.waitForTimeout(800);
  await takeScreenshot(page, SCENARIO, 'step-03-characters-extracted');

  // Find the character card to target — prefer WILL, fall back to first
  // Cards are div[role="button"] with class "group"
  const allCards = page.locator('div[role="button"].group');
  await allCards.first().waitFor({ timeout: 10_000 });

  // Try to find WILL's card
  const edwardCardEl = allCards.filter({ hasText: /EDWARD/i }).first();
  const targetCardEl = (await edwardCardEl.count() > 0) ? edwardCardEl : allCards.first();

  // Hover the card to trigger CSS group-hover, revealing the opacity-0 menu button
  await targetCardEl.hover();
  await page.waitForTimeout(500); // let CSS opacity transition complete

  // The More options button is now visible — click it
  const moreBtn = targetCardEl.locator('button[aria-label="More options"]');
  await moreBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await moreBtn.click();
  await page.waitForTimeout(400);

  // Click "Generate Character Image" in the dropdown
  const genImageItem = page.locator('[role="menuitem"]:has-text("Generate Character Image")');
  await genImageItem.waitFor({ timeout: 5_000 });
  await genImageItem.click();
  await page.waitForTimeout(800);

  // Image generation SidePanel — Auto mode is default
  await takeScreenshot(page, SCENARIO, 'step-04-image-gen-modal');

  // Click Generate
  const generateBtn = page.locator('button:has-text("Generate")').last();
  await generateBtn.waitFor({ timeout: 5_000 });
  await generateBtn.click();

  // Wait for generation to start
  await page.waitForTimeout(3_000);
  await takeScreenshot(page, SCENARIO, 'step-05-generating');

  // Poll until "Generating..." button disappears (generation complete)
  for (let i = 0; i < 60; i++) {
    const isGenerating = await page.locator('button:has-text("Generating")').isVisible().catch(() => false);
    if (!isGenerating) break;
    await page.waitForTimeout(2_000);
  }

  await page.waitForTimeout(25_000); // hold on the generated image so it's visible in the recording
  await takeScreenshot(page, SCENARIO, 'step-06-image-generated');

  // Close the SidePanel
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Final screenshot
  await takeScreenshot(page, SCENARIO, 'characters-complete');

  await saveVideo(page, SCENARIO);
});
