/**
 * Main Production Router - Aggregates all production-related routes
 *
 * This file combines all modular production route handlers into a single router.
 * The routes have been organized by functionality for better maintainability.
 */

import { Router } from 'express';

// Import all sub-routers
import analysisRouter from './analysis';
import scenesRouter from './scenes';
import castRouter from './cast';
import crewRouter from './crew';
import scheduleRouter from './schedule';
import exportsRouter from './exports';

const router = Router();

// Mount all sub-routers
// Order matters: more specific routes (exports) should come before generic ones
// Export routes must be mounted first because they have paths like
// /call-sheet/:projectId/:shootDate/export/csv that would otherwise be caught
// by schedule's /call-sheet/:projectId/:shootDate route
router.use('/', exportsRouter);     // CSV/HTML export endpoints
router.use('/', analysisRouter);    // AI analysis routes (analyze-script, optimize-budget, etc.)
router.use('/', scenesRouter);      // Scene CRUD, budget items, imports, sync, locations
router.use('/', castRouter);        // Cast CRUD, scene assignments, day assignments
router.use('/', crewRouter);        // Crew CRUD, day assignments
router.use('/', scheduleRouter);    // Schedule CRUD, day-settings, call-sheet endpoints

export default router;
