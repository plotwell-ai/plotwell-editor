import {
  getCurrentTime,
  getCurrentDate,
  isSimulationMode,
  getDaysUntil,
  addOneMonth,
  calculateBillingPeriodEnd,
  addTimeToNow,
} from '../../utils/timeUtils';

describe('timeUtils', () => {
  beforeEach(() => {
    delete process.env.SIMULATED_DATE;
    process.env.NODE_ENV = 'development';
  });

  afterAll(() => {
    delete process.env.SIMULATED_DATE;
  });

  describe('getCurrentTime', () => {
    it('returns approximately the real current time when no simulation is set', () => {
      const before = Date.now();
      const result = getCurrentTime();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('returns simulated time in development mode', () => {
      process.env.SIMULATED_DATE = '2024-06-15T12:00:00Z';
      const expected = new Date('2024-06-15T12:00:00Z').getTime();
      expect(getCurrentTime()).toBe(expected);
    });

    it('ignores invalid simulated date and falls back to real time', () => {
      process.env.SIMULATED_DATE = 'not-a-date';
      const before = Date.now();
      const result = getCurrentTime();
      expect(result).toBeGreaterThanOrEqual(before);
    });

    it('ignores SIMULATED_DATE in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.SIMULATED_DATE = '2020-01-01T00:00:00Z';
      const before = Date.now();
      const result = getCurrentTime();
      expect(result).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getCurrentDate', () => {
    it('returns a Date object', () => {
      expect(getCurrentDate()).toBeInstanceOf(Date);
    });

    it('returns the simulated date in development mode', () => {
      process.env.SIMULATED_DATE = '2024-06-15T12:00:00Z';
      const result = getCurrentDate();
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(5); // June = 5
      expect(result.getDate()).toBe(15);
    });
  });

  describe('isSimulationMode', () => {
    it('returns false when no SIMULATED_DATE is set', () => {
      expect(isSimulationMode()).toBe(false);
    });

    it('returns true with a valid simulated date in development', () => {
      process.env.SIMULATED_DATE = '2024-06-15T12:00:00Z';
      expect(isSimulationMode()).toBe(true);
    });

    it('returns false with an invalid simulated date', () => {
      process.env.SIMULATED_DATE = 'invalid-date';
      expect(isSimulationMode()).toBe(false);
    });

    it('returns false in production even with a valid simulated date', () => {
      process.env.NODE_ENV = 'production';
      process.env.SIMULATED_DATE = '2024-06-15T12:00:00Z';
      expect(isSimulationMode()).toBe(false);
    });
  });

  describe('getDaysUntil', () => {
    it('returns positive days for a future date', () => {
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days from now
      const days = getDaysUntil(future);
      expect(days).toBeGreaterThanOrEqual(4);
      expect(days).toBeLessThanOrEqual(6);
    });

    it('returns negative days for a past date', () => {
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
      const days = getDaysUntil(past);
      expect(days).toBeLessThanOrEqual(-2);
    });

    it('uses simulated date for calculation', () => {
      process.env.SIMULATED_DATE = '2024-01-01T00:00:00Z';
      const target = new Date('2024-01-11T00:00:00Z');
      expect(getDaysUntil(target)).toBe(10);
    });
  });

  describe('addOneMonth', () => {
    it('advances a date by one month', () => {
      const jan15 = new Date('2024-01-15');
      const result = addOneMonth(jan15);
      expect(result.getMonth()).toBe(1); // February
      expect(result.getDate()).toBe(15);
    });

    it('handles December -> January rollover', () => {
      const dec15 = new Date('2024-12-15');
      const result = addOneMonth(dec15);
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(0); // January
    });

    it('clamps month-end dates (Jan 31 -> last day of Feb)', () => {
      const jan31 = new Date('2024-01-31');
      const result = addOneMonth(jan31);
      // Feb 2024 has 29 days (leap year)
      expect(result.getMonth()).toBe(1); // February
      expect(result.getDate()).toBe(29);
    });

    it('does not mutate the original date', () => {
      const original = new Date('2024-03-15');
      const originalTime = original.getTime();
      addOneMonth(original);
      expect(original.getTime()).toBe(originalTime);
    });
  });

  describe('calculateBillingPeriodEnd', () => {
    it('returns a date one month after the start', () => {
      const start = new Date('2024-03-01');
      const end = calculateBillingPeriodEnd(start);
      expect(end.getMonth()).toBe(3); // April
      expect(end.getDate()).toBe(1);
      expect(end.getFullYear()).toBe(2024);
    });
  });

  describe('addTimeToNow', () => {
    it('adds milliseconds to the current time', () => {
      process.env.SIMULATED_DATE = '2024-01-01T00:00:00Z';
      const oneHour = 60 * 60 * 1000;
      const base = new Date('2024-01-01T00:00:00Z').getTime();
      const result = addTimeToNow(oneHour);
      expect(result.getTime()).toBe(base + oneHour);
    });
  });
});
