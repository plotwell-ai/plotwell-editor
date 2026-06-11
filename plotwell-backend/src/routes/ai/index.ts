/**
 * Main AI Router - Aggregates all AI-related routes
 *
 * This file combines all modular AI route handlers into a single router.
 * The routes have been organized by functionality for better maintainability.
 */

import { Router } from 'express';
import { validateAIInput } from '../../middleware/inputValidation';

// Import all sub-routers
import scenesRouter from './scenes';
import charactersRouter from './characters';
import locationsRouter from './locations';
import storyboardsRouter from './storyboards';
import documentsRouter from './documents';
import chatRouter from './chat';
import beatsRouter from './beats';
import agentRouter from './agent';

const router = Router();

// Validate AI input field lengths on all POST/PUT requests
router.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    return validateAIInput(req, res, next);
  }
  next();
});

// Mount all sub-routers
router.use('/', scenesRouter);       // Scene generation, discussion, CRUD, insertion
router.use('/', charactersRouter);   // Character extraction and image generation
router.use('/', locationsRouter);    // Location extraction from scripts/brainstorming
router.use('/', storyboardsRouter);  // Storyboard generation and image creation
// Panel video generation (image-to-video, MEGA beta) is mounted separately in
// server.ts with its own videoLimiter, ahead of this generic AI router.
router.use('/', documentsRouter);    // Document generation (treatments, synopses, etc.)
router.use('/', chatRouter);         // Chat/brainstorming interactions
router.use('/', beatsRouter);        // Beat sheet AI features (suggestions, analysis, expansion)
router.use('/agent', agentRouter);   // Agent Writer (autonomous screenplay generation)

export default router;
