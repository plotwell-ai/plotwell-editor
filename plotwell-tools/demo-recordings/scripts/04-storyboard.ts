import { test } from '@playwright/test';
import { login } from '../utils/login';
import { takeScreenshot } from '../utils/screenshot';
import { saveVideo } from '../utils/video';

const SCENARIO = '04-storyboard';
const TYPE_DELAY = 60;

test('Storyboard generation and image demo', async ({ page }) => {
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
  await page.waitForTimeout(4_000); // hold on script view

  // Dismiss onboarding tour if it appears
  const tourBtn = page.locator('.driver-popover-next-btn, .driver-popover-done-btn').first();
  while (await tourBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tourBtn.click();
    await page.waitForTimeout(300);
  }

  // Navigate to Storyboard section
  const currentUrl = page.url();
  const projectId = currentUrl.split('/dashboard/')[1]?.split('?')[0];
  await page.goto(`http://localhost:5173/dashboard/${projectId}?section=storyboard`);

  // Wait for storyboard to load (SceneSelector appears)
  await page.waitForTimeout(2_000);
  await page.waitForLoadState('networkidle');
  await takeScreenshot(page, SCENARIO, 'step-01-storyboard-loaded');

  // Click the center SceneSelector button to open the scene grid popover
  // The button shows current scene number (or "Click to select a scene...")
  const sceneSelectorCenter = page.locator('button:has-text("Click to select a scene")').first();
  const alreadySelected = page.locator('button').filter({ has: page.locator('span.font-bold.text-white') }).first();

  // Try the "select a scene" prompt first, fallback to clicking the scene info area
  if (await sceneSelectorCenter.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await sceneSelectorCenter.click();
  } else {
    // Click the center info button (has Film icon + scene number badge)
    await alreadySelected.click();
  }

  await page.waitForTimeout(500);

  // Click Scene 1 chip in the grid popover (shows just "1")
  const scene1Chip = page.locator('div.flex.flex-wrap button').filter({ hasText: /^1$/ }).first();
  await scene1Chip.waitFor({ timeout: 5_000 });
  await scene1Chip.click();
  await page.waitForTimeout(800);
  await takeScreenshot(page, SCENARIO, 'step-02-scene1-selected');

  // Click "Fill with AI" button
  const fillWithAI = page.locator('button:has-text("Fill with AI")').first();
  await fillWithAI.waitFor({ timeout: 10_000 });
  await fillWithAI.click();
  await page.waitForTimeout(500);

  // FillWithAIModal opens — use default panel count, click Generate
  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
  await takeScreenshot(page, SCENARIO, 'step-03-fill-with-ai-modal');

  const generateBtn = page.locator('[role="dialog"] button:has-text("Generate")').last();
  await generateBtn.waitFor({ timeout: 5_000 });
  await generateBtn.click();

  // Wait for panels to be generated
  for (let i = 0; i < 60; i++) {
    const panelCount = await page.locator('div[role="button"].group, [data-panel-card]').count();
    if (panelCount > 0) break;
    // Also check for panel cards without the group class
    const anyPanel = await page.locator('button:has-text("Edit")').count();
    if (anyPanel > 0) break;
    await page.waitForTimeout(2_000);
  }
  await page.waitForTimeout(1_000);
  await takeScreenshot(page, SCENARIO, 'step-04-panels-generated');

  // Open the first panel's 3-dots menu, then click Edit
  // The MoreVertical button is opacity-0 until hover — hover the card first
  const firstPanelCard = page.locator('div.group').filter({ has: page.locator('button[class*="rounded-lg"]') }).first();
  await firstPanelCard.hover();
  await page.waitForTimeout(500);

  // Force-click the MoreVertical dots button (bypasses opacity-0)
  const dotsBtn = firstPanelCard.locator('button').filter({ has: page.locator('svg') }).last();
  await dotsBtn.click({ force: true });
  await page.waitForTimeout(400);

  // Click "Edit" in the dropdown
  const editItem = page.locator('[role="menuitem"]:has-text("Edit")');
  await editItem.waitFor({ timeout: 5_000 });
  await editItem.click();
  await page.waitForTimeout(800);
  await takeScreenshot(page, SCENARIO, 'step-05-panel-edit-modal');

  // Expand Characters section and link WILL
  const charactersSection = page.locator('button:has-text("Characters")').first();
  await charactersSection.waitFor({ timeout: 5_000 });
  await charactersSection.click();
  await page.waitForTimeout(400);

  // Click WILL's character button
  const willBtn = page.locator('button').filter({ hasText: /\bWILL\b/i }).first();
  await willBtn.waitFor({ timeout: 5_000 });
  await willBtn.click();
  await page.waitForTimeout(300);
  await takeScreenshot(page, SCENARIO, 'step-06-will-linked');

  // Expand Location section and link bedroom
  const locationSection = page.locator('button:has-text("Location")').first();
  await locationSection.waitFor({ timeout: 5_000 });
  await locationSection.click();
  await page.waitForTimeout(400);

  // Click bedroom location button
  const bedroomBtn = page.locator('button').filter({ hasText: /bedroom/i }).first();
  await bedroomBtn.waitFor({ timeout: 5_000 });
  await bedroomBtn.click();
  await page.waitForTimeout(300);
  await takeScreenshot(page, SCENARIO, 'step-07-bedroom-linked');

  // Save the panel (click the Save/Update button in the SidePanel footer)
  const saveBtn = page.locator('button:has-text("Save"), button:has-text("Update")').last();
  await saveBtn.waitFor({ timeout: 5_000 });
  await saveBtn.click();
  await page.waitForTimeout(800);

  // Open the first panel's 3-dots menu again, then click "Generate Image"
  await firstPanelCard.hover();
  await page.waitForTimeout(500);
  await dotsBtn.click({ force: true });
  await page.waitForTimeout(400);

  const genImageMenuItem = page.locator('[role="menuitem"]:has-text("Generate Image")');
  await genImageMenuItem.waitFor({ timeout: 5_000 });
  await genImageMenuItem.click();
  await page.waitForTimeout(800);

  // ImageGenerationModal opens — click "Generate Image" button
  await takeScreenshot(page, SCENARIO, 'step-08-image-gen-modal');
  const genImageSubmit = page.locator('button:has-text("Generate Image")').last();
  await genImageSubmit.waitFor({ timeout: 5_000 });
  await genImageSubmit.click();

  // Wait for image generation to complete
  await page.waitForTimeout(3_000);
  await takeScreenshot(page, SCENARIO, 'step-09-generating');

  for (let i = 0; i < 60; i++) {
    const isGenerating = await page.locator('button:has-text("Generating")').isVisible().catch(() => false);
    if (!isGenerating) break;
    await page.waitForTimeout(2_000);
  }

  await page.waitForTimeout(25_000); // hold on the generated image
  await takeScreenshot(page, SCENARIO, 'step-10-image-generated');

  // Close modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Final screenshot of storyboard with image
  await takeScreenshot(page, SCENARIO, 'storyboard-complete');

  await saveVideo(page, SCENARIO);
});
