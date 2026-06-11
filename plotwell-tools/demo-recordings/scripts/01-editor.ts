import { test } from '@playwright/test';
import { login } from '../utils/login';
import { takeScreenshot } from '../utils/screenshot';
import { saveVideo } from '../utils/video';

const SCENARIO = '01-editor';
const LANDING_URL = 'http://localhost:5174';
const TYPE_DELAY = 60;

test('Editor happy path demo', async ({ page }) => {
  // Step 1 — Landing page
  await page.goto(LANDING_URL);
  await page.waitForLoadState('networkidle');
  await takeScreenshot(page, SCENARIO, 'step-01-landing');

  // Step 2 — Click main CTA ("Start free trial") → redirects to /signup
  await page.click('text=Start free trial');
  await page.waitForURL('**/signup**', { timeout: 15_000 });

  // Step 3–5 — Navigate to login and authenticate (no screenshot)
  // NOTE: Demo account must have an active paid plan to skip onboarding gate
  await login(page);

  // Dismiss cookie banner if present
  const cookieAccept = page.locator('button:has-text("Accept")');
  if (await cookieAccept.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await cookieAccept.click();
    await page.waitForTimeout(500);
  }

  // Step 6 — Create a new project
  await page.waitForSelector('#tour-new-project', { timeout: 30_000 });
  await takeScreenshot(page, SCENARIO, 'step-06-projects');
  await page.click('#tour-new-project');

  // Fill project modal — clear field first, then type with realistic pacing
  const nameInput = page.locator('input[maxlength="80"]');
  await nameInput.waitFor({ timeout: 5_000 });
  await nameInput.fill('');
  await nameInput.type('Big Fish', { delay: TYPE_DELAY });
  // Click the Create button inside the SidePanel modal
  await page.locator('button:has-text("Create")').last().click();

  // Wait for navigation to the dashboard editor
  await page.waitForURL('**/dashboard/**', { timeout: 20_000 });

  // Step 7 — Wait for ProseMirror editor to load
  await page.waitForSelector('.plotwell-editor-wrap .ProseMirror', { timeout: 20_000 });
  await page.waitForTimeout(1_000);

  // Complete the onboarding tour (6 steps)
  // driver.js puts both next and done buttons in the popover footer
  for (let step = 1; step <= 6; step++) {
    // Wait for any tour action button (Next or Get Started!)
    const btn = page.locator('.driver-popover-next-btn, .driver-popover-done-btn').first();
    await btn.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(600); // pause so the viewer can read each step
    if (step === 1) await takeScreenshot(page, SCENARIO, 'step-07-tour-start');
    await btn.click();
  }

  await page.waitForTimeout(800);
  await takeScreenshot(page, SCENARIO, 'step-08-editor-ready');

  // Step 8 — Switch to Agent mode and generate the first scene
  // Click on "Agent" tab in the AI chat panel
  const agentTab = page.locator('button:has-text("Agent")').first();
  await agentTab.waitFor({ timeout: 10_000 });
  await agentTab.click();
  await page.waitForTimeout(500);
  await takeScreenshot(page, SCENARIO, 'step-09-agent-mode');

  // Type instruction for Big Fish opening scene
  const agentInput = page.locator('textarea[placeholder*="What should I write"]');
  await agentInput.waitFor({ timeout: 5_000 });
  await agentInput.click();
  await agentInput.type(
    'Write the opening scene of Big Fish. Will Bloom narrates how his father Edward always told tall tales. Open in a bedroom at night with Will reflecting on his father\'s stories.',
    { delay: TYPE_DELAY }
  );
  await page.waitForTimeout(500);
  await takeScreenshot(page, SCENARIO, 'step-10-agent-instruction');

  // Submit — press Enter (textarea submits on Enter without Shift)
  await page.keyboard.press('Enter');

  // Wait for plan to be generated — "Write Screenplay" button appears in plan_review
  const approveBtn = page.locator('button:has-text("Write Screenplay")');
  await approveBtn.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_000);

  // Auto-insert is ON by default — verify and screenshot the plan
  await takeScreenshot(page, SCENARIO, 'step-11-agent-plan');

  // Approve the plan
  await approveBtn.click();

  // Wait for scene generation to complete — editor gets content via auto-insert
  // Poll every 2s for up to 2 minutes until editor has generated content
  for (let i = 0; i < 60; i++) {
    const text = await page.locator('.plotwell-editor-wrap .ProseMirror').textContent();
    if (text && text.trim().length > 50) break;
    await page.waitForTimeout(2_000);
  }

  await page.waitForTimeout(2_000);
  await takeScreenshot(page, SCENARIO, 'step-12-scene-generated');

  // Step 9 — Hold on the editor so the viewer can read the generated scene
  await page.waitForTimeout(4_000);

  // Step 10 — Final screenshot of the editor with AI-generated content
  await takeScreenshot(page, SCENARIO, 'editor-in-use');

  // Save video
  await saveVideo(page, SCENARIO);
});
