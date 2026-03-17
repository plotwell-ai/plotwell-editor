/**
 * Time utilities for handling simulated time in development/testing
 *
 * SIMULATED_DATE Environment Variable (Development Only):
 *
 * Supported formats:
 * - ISO 8601: "2024-09-24T18:11:00Z" (recommended)
 * - ISO with timezone: "2024-09-24T18:11:00+02:00"
 * - Date string: "2024-09-24"
 * - JavaScript Date string: "September 24, 2024"
 *
 * Examples:
 * export SIMULATED_DATE="2024-09-24T18:11:00Z"
 * SIMULATED_DATE="2024-09-24T18:11:00Z" npm run dev
 *
 * Production behavior:
 * - SIMULATED_DATE is ignored in production (NODE_ENV=production)
 * - Always uses real Date.now() in production for security
 */

/**
 * Check if we're in development mode
 */
function isDevelopmentMode(): boolean {
  // Allow simulation if NODE_ENV is not explicitly set to production
  return process.env.NODE_ENV !== 'production';
}

/**
 * Get the current time, respecting simulated date only in development mode
 * @returns Current timestamp in milliseconds
 */
export function getCurrentTime(): number {
  // Only use simulated date in development mode
  if (isDevelopmentMode()) {
    const simulatedDate = process.env.SIMULATED_DATE;
    if (simulatedDate) {
      const simTime = new Date(simulatedDate).getTime();
      if (!isNaN(simTime)) {
        return simTime;
      }
    }
  }
  return Date.now();
}

/**
 * Get the current date, respecting simulated date only in development mode
 * @returns Current Date object
 */
export function getCurrentDate(): Date {
  return new Date(getCurrentTime());
}

/**
 * Check if we're running in simulation mode
 * @returns true if in development and SIMULATED_DATE is set and valid
 */
export function isSimulationMode(): boolean {
  if (!isDevelopmentMode()) return false;

  const simulatedDate = process.env.SIMULATED_DATE;
  if (!simulatedDate) return false;

  const simTime = new Date(simulatedDate).getTime();
  return !isNaN(simTime);
}

/**
 * Add time to current date (simulation-aware)
 * @param milliseconds Milliseconds to add
 * @returns New date with added time
 */
export function addTimeToNow(milliseconds: number): Date {
  return new Date(getCurrentTime() + milliseconds);
}

/**
 * Calculate days remaining between current time and target date
 * @param targetDate Target date
 * @returns Number of days remaining (can be negative if target is in past)
 */
export function getDaysUntil(targetDate: Date): number {
  const now = getCurrentTime();
  return Math.ceil((targetDate.getTime() - now) / (1000 * 60 * 60 * 24));
}

/**
 * Add one month to a date, handling variable month lengths properly
 * @param date Starting date
 * @returns New date one month later
 */
export function addOneMonth(date: Date): Date {
  const newDate = new Date(date);
  const currentMonth = newDate.getMonth();
  const currentYear = newDate.getFullYear();

  // Add one month
  newDate.setMonth(currentMonth + 1);

  // Handle year rollover (December -> January)
  if (newDate.getMonth() !== (currentMonth + 1) % 12) {
    // This happens when the day doesn't exist in the target month
    // (e.g., Jan 31 -> Feb 31 becomes Mar 3)
    // Set to the last day of the target month instead
    newDate.setDate(0); // Sets to last day of previous month
  }

  return newDate;
}

/**
 * Calculate the actual billing period end date by adding one month
 * @param startDate Billing period start date
 * @returns Billing period end date (one month later)
 */
export function calculateBillingPeriodEnd(startDate: Date): Date {
  return addOneMonth(startDate);
}