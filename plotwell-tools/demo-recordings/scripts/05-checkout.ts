import { test } from '@playwright/test';
import { login } from '../utils/login';
import { takeScreenshot } from '../utils/screenshot';
import { saveVideo } from '../utils/video';

const SCENARIO = '02-checkout';
const TYPE_DELAY = 60;

const STRIPE_BLUR_CSS = `
  iframe[name*="stripe"], iframe[src*="stripe"],
  .stripe-element, [data-stripe],
  .__PrivateStripeElement {
    filter: blur(7px) !important;
  }
`;

test('Checkout flow demo', async ({ page }) => {
  // Step 1 — Log in
  await login(page);
  await takeScreenshot(page, SCENARIO, 'step-01-projects');

  // Step 2 — Navigate to pricing page
  await page.goto('http://localhost:5173/projects?view=plans');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
  await takeScreenshot(page, SCENARIO, 'step-02-pricing');

  // Step 3 — Click Pro/Upgrade button
  // The pricing page shows plan cards with CTA buttons
  const upgradeButton = page.locator('button:has-text("Upgrade"), button:has-text("Subscribe"), button:has-text("Get Pro"), button:has-text("Start")').first();
  await upgradeButton.waitFor({ timeout: 10_000 });
  await upgradeButton.click();

  // Step 4 — Wait for Stripe checkout to appear
  // Could be embedded (iframe) or hosted (redirect to checkout.stripe.com)
  await page.waitForTimeout(3_000);

  // Detect if we got redirected to Stripe hosted checkout
  const isHosted = page.url().includes('checkout.stripe.com');

  // Step 5 — Inject blur CSS
  await page.addStyleTag({ content: STRIPE_BLUR_CSS });

  if (isHosted) {
    // Stripe hosted checkout page
    await page.waitForSelector('#cardNumber, [name="cardNumber"]', { timeout: 20_000 });

    // Step 6 — Fill Stripe test card
    const cardFrame = page;
    await cardFrame.fill('#cardNumber, [name="cardNumber"]', '4242424242424242');
    await cardFrame.fill('#cardExpiry, [name="cardExpiry"]', '1229');
    await cardFrame.fill('#cardCvc, [name="cardCvc"]', '424');

    // Name field (if present)
    const nameField = cardFrame.locator('#billingName, [name="billingName"]');
    if (await nameField.isVisible()) {
      await nameField.fill('Demo User');
    }
  } else {
    // Embedded Stripe Elements — fields are inside iframes
    // Wait for any Stripe iframe to appear
    const stripeFrame = page
      .frameLocator('iframe[src*="stripe"], iframe[name*="__privateStripeFrame"]')
      .first();

    try {
      // Card number iframe
      const cardNumberFrame = page.frameLocator('iframe[title*="card number" i]').first();
      await cardNumberFrame.locator('input').first().waitFor({ timeout: 10_000 });
      await cardNumberFrame.locator('input').first().fill('4242424242424242');

      // Expiry iframe
      const expiryFrame = page.frameLocator('iframe[title*="expir" i]').first();
      await expiryFrame.locator('input').first().fill('1229');

      // CVC iframe
      const cvcFrame = page.frameLocator('iframe[title*="cvc" i], iframe[title*="security" i]').first();
      await cvcFrame.locator('input').first().fill('424');
    } catch {
      // If individual iframes aren't found, try a single combined field
      const combinedFrame = page.frameLocator('iframe[src*="stripe"]').first();
      await combinedFrame.locator('[name="cardnumber"]').fill('4242 4242 4242 4242');
      await combinedFrame.locator('[name="exp-date"]').fill('12 / 29');
      await combinedFrame.locator('[name="cvc"]').fill('424');
    }
  }

  // Step 7 — Screenshot the blurred checkout
  await takeScreenshot(page, SCENARIO, 'step-07-checkout-filled');

  // Step 8 — Hold for 2 seconds (do NOT submit)
  await page.waitForTimeout(2_000);

  // Step 9 — Final screenshot
  await takeScreenshot(page, SCENARIO, 'checkout-blurred');

  // Save video
  await saveVideo(page, SCENARIO);
});
