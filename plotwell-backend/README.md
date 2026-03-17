# plotwell Backend

A comprehensive Express.js + TypeScript backend API for the screenplay and production planning application. This backend provides RESTful endpoints with JWT authentication, AI integration, real-time collaboration, and production planning tools.

## 🏗️ Architecture Overview

The backend is built with a modular architecture supporting:

- **Express.js + TypeScript** for type-safe API development
- **Supabase PostgreSQL** with Row Level Security (RLS) for database management
- **JWT Authentication** using Supabase Auth
- **Replicate API** for AI-powered content generation (GPT-OSS-120B) and image generation (Flux 1.1 Pro)
- **Y.js WebSocket Server** for real-time collaboration
- **Comprehensive Rate Limiting** and usage tracking
- **Production Planning Tools** with budget and schedule management

### Service Documentation

Each major service area has its own detailed documentation. **Read the relevant doc before making changes.**

| Doc | Description |
|-----|-------------|
| [`SERVER_ARCHITECTURE.md`](./SERVER_ARCHITECTURE.md) | Server setup, middleware chain, authentication, rate limiting, deployment |
| [`BILLING_SYSTEM.md`](./BILLING_SYSTEM.md) | Subscription lifecycle, Stripe integration, addons, webhook design |
| [`AI_SERVICE.md`](./AI_SERVICE.md) | Model routing, token management, context optimization, image generation |
| [`SCRIPT_SERVICE.md`](./SCRIPT_SERVICE.md) | TipTap editor, scene parsing, import/export, versioning, Script Doctor |
| [`COLLABORATION_SERVICE.md`](./COLLABORATION_SERVICE.md) | WebSocket/Y.js real-time editing, presence, comments, roles |
| [`PRODUCTION_SERVICE.md`](./PRODUCTION_SERVICE.md) | Scene breakdown, cast/crew, scheduling, call sheets, exports |
| [`CORE_SERVICES.md`](./CORE_SERVICES.md) | Projects, characters, locations, storyboards, documents, episodes, beats, storage |

> When updating a service, update the corresponding `.md` doc to keep it in sync.

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account and project
- OpenAI API key
- Replicate API token

### Installation

```bash
# Clone the repository
cd plotwell-backend

# Install dependencies
npm install
```

### Running Locally

**For local development (both frontend and backend on your machine):**

```bash
# Use the .env.local configuration
npm run dev:local
```

The server will start on `http://localhost:3001`

**For testing with cloud configurations:**

```bash
# Test with development cloud config (Render dev)
npm run dev:dev

# Test with production cloud config (Render prod)
npm run dev:prod
```

### Environment Files

The backend supports multiple environment configurations:

- **`.env.local`** - Local development (points to `localhost:5173` for CORS)
- **`.env.development`** - Render dev deployment configuration
- **`.env.production`** - Render production deployment configuration

**Note:** `.env.local` is gitignored and used only for local development.

## 📁 Project Structure

```
plotwell-backend/
├── src/
│   ├── config/                 # Configuration files
│   │   ├── pricingPlans.ts    # Subscription plans configuration
│   │   ├── currencies.ts     # Currency definitions and exchange rates
│   │   └── database.ts       # Supabase client initialization
│   ├── controllers/           # Request handlers
│   │   └── charactersController.ts
│   ├── middleware/            # Express middleware (10 files)
│   │   ├── auth.ts           # JWT authentication (requireAuth, extractUserId)
│   │   ├── pricingMiddleware.ts # Subscription limits & feature gating
│   │   ├── archiveMiddleware.ts # Read-only archived projects
│   │   ├── aiUsageMiddleware.ts # AI usage tracking & quota enforcement
│   │   ├── errorSanitizer.ts   # Strip internal details from error responses in production
│   │   ├── inputValidation.ts  # Request body/param validation
│   │   ├── ipAllowlist.ts      # IP-based access control
│   │   ├── productionPrerequisitesMiddleware.ts # Validate script exists & scenes initialized
│   │   ├── requestClassificationMiddleware.ts   # AI request complexity classification
│   │   └── requestDeduplication.ts # Prevent duplicate concurrent requests
│   ├── prompts/              # AI prompt templates (11 files)
│   │   ├── index.ts          # Prompt registry
│   │   ├── types.ts          # Prompt type definitions
│   │   ├── shared.ts         # Shared prompt utilities
│   │   ├── beats.ts          # Beat sheet generation prompts
│   │   ├── characters.ts     # Character extraction prompts
│   │   ├── chat.ts           # Brainstorming chat prompts
│   │   ├── documents.ts      # Document generation prompts
│   │   ├── locations.ts      # Location extraction prompts
│   │   ├── production.ts     # Production analysis prompts
│   │   ├── scenes.ts         # Scene generation prompts
│   │   └── storyboards.ts    # Storyboard generation prompts
│   ├── routes/               # API route definitions (27 files + 2 directories)
│   │   ├── ai/              # AI generation endpoints (8 files)
│   │   │   ├── index.ts     # AI router aggregator
│   │   │   ├── beats.ts     # Beat sheet AI generation
│   │   │   ├── characters.ts # Character AI extraction
│   │   │   ├── chat.ts      # Conversational AI brainstorming
│   │   │   ├── documents.ts # Document AI generation
│   │   │   ├── locations.ts # Location AI extraction
│   │   │   ├── scenes.ts   # Scene AI generation
│   │   │   └── storyboards.ts # Storyboard AI generation
│   │   ├── production/      # Production planning endpoints (8 files)
│   │   │   ├── index.ts     # Production router aggregator
│   │   │   ├── analysis.ts  # AI script analysis & budget
│   │   │   ├── cast.ts      # Cast management
│   │   │   ├── crew.ts      # Crew assignments
│   │   │   ├── exports.ts   # Production data exports
│   │   │   ├── helpers.ts   # Shared production helpers
│   │   │   ├── scenes.ts    # Production scene management & sync
│   │   │   └── schedule.ts  # Shooting schedule management
│   │   ├── projects.ts       # Project CRUD & management
│   │   ├── scripts.ts        # Script management & export
│   │   ├── characters.ts     # Character profiles
│   │   ├── characterImages.ts # Character image upload & generation
│   │   ├── characterElements.ts # Character wardrobe/props/makeup elements
│   │   ├── locations.ts      # Location management
│   │   ├── locationImages.ts # Location image gallery management
│   │   ├── documents.ts      # Document CRUD & versioning
│   │   ├── import.ts         # Script import (FDX, Fountain)
│   │   ├── seasons.ts        # TV series season management
│   │   ├── episodes.ts       # TV series episode management
│   │   ├── beats.ts          # Beat sheet management
│   │   ├── structureTemplates.ts # Story structure templates
│   │   ├── storyboard.ts     # Storyboard panel management
│   │   ├── conversations.ts  # Chat/conversation system
│   │   ├── collaboration.ts  # Real-time collaboration & invitations
│   │   ├── comments.ts       # Comments & reactions system
│   │   ├── scriptDoctorV2.ts # AI script analysis (v2)
│   │   ├── pricing.ts        # Public pricing endpoints
│   │   ├── usage.ts          # Usage analytics
│   │   ├── user.ts           # User profile management
│   │   ├── billing.ts        # Stripe webhooks (raw body)
│   │   ├── unifiedBilling.ts # Unified billing operations
│   │   ├── aiCredits.ts      # AI credit purchases & balance
│   │   └── publicShare.ts    # Public project sharing (read-only links)
│   ├── services/            # Business logic (37 files)
│   │   ├── aiTokenService.ts        # AI token management & context building
│   │   ├── aiModelRouter.ts         # AI model selection & routing logic
│   │   ├── aiRoutingLogger.ts       # AI routing decision logging
│   │   ├── aiUsageTracker.ts        # Usage tracking & quota enforcement
│   │   ├── imageService.ts          # Image generation (Replicate)
│   │   ├── imageModelRouter.ts      # Image model selection
│   │   ├── beatExportService.ts     # Beat sheet export (PDF/text)
│   │   ├── callSheetService.ts      # Call sheet generation
│   │   ├── castService.ts           # Cast management business logic
│   │   ├── characterElementsService.ts # Character wardrobe/props/makeup
│   │   ├── characterImagesService.ts # Character image management
│   │   ├── charactersService.ts     # Character business logic
│   │   ├── chatToolDefinitions.ts   # AI chat tool/function definitions
│   │   ├── collaborationServer.ts   # Y.js WebSocket server
│   │   ├── contextOptimizer.ts      # AI context size optimization
│   │   ├── emailService.ts          # Transactional email sending
│   │   ├── locationImageService.ts  # Location single image management
│   │   ├── locationImagesService.ts # Location image gallery (CRUD, primary, reorder)
│   │   ├── operationLockService.ts  # Distributed operation locking
│   │   ├── pricingService.ts        # Pricing calculation logic
│   │   ├── productionAnalysisService.ts # AI script analysis for production
│   │   ├── productionExportService.ts   # Production data export (PDF/CSV)
│   │   ├── productionSyncServiceSimple.ts # Script-to-production sync engine
│   │   ├── requestClassifier.ts     # AI request complexity classifier
│   │   ├── sceneBreakdownExportService.ts # Scene breakdown export
│   │   ├── sceneIdentityService.ts  # Stable scene identification & matching
│   │   ├── sceneInsertionService.ts # Scene insertion into scripts
│   │   ├── scheduleService.ts       # Shooting schedule business logic
│   │   ├── scriptDoctorPrompts.ts   # Script Doctor AI prompt templates
│   │   ├── scriptDoctorService.ts   # Script Doctor analysis engine
│   │   ├── scriptExportService.ts   # Script export (PDF/Fountain/FDX)
│   │   ├── scriptParsingService.ts  # TipTap JSON to scene parsing
│   │   ├── scriptTimingService.ts   # Script timing estimation
│   │   ├── storageService.ts        # Supabase Storage utilities (signed URLs, uploads)
│   │   ├── stripeService.ts         # Stripe payment processing
│   │   ├── stripeWebhookService.ts  # Stripe webhook event handling
│   │   ├── subscriptionManagementService.ts # Subscription state management
│   │   └── unifiedBillingService.ts # Unified billing operations
│   ├── types/               # TypeScript type definitions
│   │   ├── express/index.d.ts # Express request augmentation
│   │   └── production.ts     # Production planning types
│   ├── utils/               # Helper utilities (4 files)
│   │   ├── aiHelpers.ts     # AI response parsing & formatting
│   │   ├── replicateHelper.ts # Replicate API wrapper
│   │   ├── sceneExtractor.ts # Scene extraction from script content
│   │   └── timeUtils.ts     # Time/date utilities
│   └── server.ts            # Main server entry point
├── email-templates/         # Custom email HTML templates (7 files)
├── migrations/              # Database migrations
├── database_complete_schema.sql # Complete database setup
├── render.yaml              # Render deployment configuration
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 Environment Configuration

Create a `.env` file in the backend directory:

```bash
# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# AI Services
OPENAI_API_KEY=your_openai_api_key
REPLICATE_API_TOKEN=your_replicate_token

# Authentication
JWT_SECRET=your_jwt_secret

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_test_key_here
STRIPE_PUBLISHABLE_KEY=pk_test_your_test_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here

# Server Configuration
PORT=3001
NODE_ENV=development

# CORS Configuration
FRONTEND_URL=http://localhost:5173
```

## 📧 Email Configuration

### FastMail SMTP Setup

The backend supports transactional emails through Supabase with FastMail SMTP.

**Generate FastMail App Password:**
1. Log in to FastMail at https://www.fastmail.com
2. Go to Settings > Privacy & Security > App Passwords
3. Create new app password named "Plotwell Supabase SMTP"
4. Copy the generated password

**Configure Supabase Custom SMTP:**
1. Go to Supabase Dashboard > Project Settings > Authentication > SMTP Settings
2. Enable Custom SMTP
3. Enter configuration:
   ```
   SMTP Host: smtp.fastmail.com
   SMTP Port: 587
   SMTP Username: your-email@yourdomain.com
   SMTP Password: [app password from step 1]
   Sender Email: noreply@yourdomain.com
   Sender Name: Plotwell
   Enable TLS: Yes
   ```

**Custom email templates** are available in the `email-templates/` directory:
- Confirm Signup
- Reset Password
- Magic Link
- Invite User
- Change Email Address
- Reauthentication

### DNS Records for Email Deliverability

For optimal email deliverability, configure these DNS records:

**SPF Record:**
```
Type: TXT
Host: @
Value: v=spf1 include:spf.messagingengine.com ?all
```

**DKIM Records** (get from FastMail Settings > Domains):
```
Type: CNAME
Host: fm1._domainkey
Value: fm1.yourdomain.com.dkim.fmhosted.com

Type: CNAME
Host: fm2._domainkey
Value: fm2.yourdomain.com.dkim.fmhosted.com

Type: CNAME
Host: fm3._domainkey
Value: fm3.yourdomain.com.dkim.fmhosted.com
```

**DMARC Record:**
```
Type: TXT
Host: _dmarc
Value: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com
```

**Verification:**
- DNS changes may take 24-48 hours to propagate
- Test deliverability at https://www.mail-tester.com/
- Check DNS propagation at https://dnschecker.org/

## 🗄️ Database Setup

The backend uses a comprehensive PostgreSQL database with the following key systems:

### Core Tables
- `users` - User profiles and preferences
- `projects` - Main project entities with collaboration settings
- `project_documents` - Multi-type documents (treatments, synopses, etc.)
- `scripts` - Screenplay content with TipTap JSON
- `characters` - Character profiles and details
- `character_images` - Character image gallery
- `character_elements` - Character wardrobe, props, makeup
- `locations` - Filming locations and details
- `location_images` - Location image gallery (max 3 per location)
- `storyboards` - Visual storyboard containers
- `storyboard_panels` - Individual storyboard panels (CRITICAL for API)
- `seasons` - TV series seasons
- `episodes` - TV series episodes
- `beats` - Story beat sheets
- `public_project_shares` - Public sharing tokens

### Production Tables
- `production_scene_data` - Scene production data (linked to script)
- `production_cast` - Cast members with character links
- `production_cast_scenes` - Cast-to-scene assignments
- `production_crew_assignments` - Crew member assignments
- `scene_change_log` - Production sync audit trail

### Subscription System
- `user_subscriptions` - User subscription plans and billing (CRITICAL)
- `user_quotas` - Usage tracking and limits (CRITICAL)
- `billing_events` - Subscription event logging (CRITICAL)

### Advanced Features
- **Version Control System** - Script and document versioning
- **Real-time Collaboration** - Y.js document synchronization
- **Production Planning** - Budget, schedule, and scene management
- **AI Usage Tracking** - Comprehensive billing and analytics
- **Team Management** - Multi-user collaboration with roles
- **Monthly Billing System** - Pay-per-active-project billing model

### Database Setup Commands

```bash
# Apply complete schema (recommended for new installations)
node apply_schema.js

# Or apply individual migrations
node apply-migration.js
```

The complete database schema is available in `database_complete_schema.sql` - a single file that creates all 31 tables, functions, triggers, and policies needed for the entire backend.

**CRITICAL DEPENDENCIES**: The backend requires these subscription tables to function:
- `user_subscriptions` - Backend services will fail without this table
- `user_quotas` - Backend services will fail without this table  
- `billing_events` - Backend services will fail without this table
- `monthly_project_billing` - Monthly billing system will fail without this table
- `storyboard_panels` - Storyboard API will fail without this table

**PROJECT TYPES**: The schema supports these project_type values (matching frontend):
- `'film'` - Traditional films/movies (DEFAULT - primary frontend option)
- `'movie'` - Alternative for films (backend compatibility) 
- `'series'` - TV series/shows
- `'short'` - Short films
- `'commercial'` - Commercial videos
- `'music_video'` - Music videos  
- `'documentary'` - Documentary films
- `'reel'` - Social media reels (primary frontend option)
- `'theatre'` - Theatre productions (coming soon)
- `'course'` - Educational content (coming soon)
- `'fiction'` - Fiction writing (coming soon)

**PROJECT CREATION**: Fixed constraint violation by setting multiple defaults:
- Database schema: `project_type` defaults to `'film'` 
- Frontend state: `projectType` state defaults to `"film"`
- Backend route: Fallback to `'film'` if project_type is undefined

**CHARACTER SYSTEM**: The enhanced character table includes:
- **Classification Fields**: `character_type`, `primary_role`, `importance_level`, `status`
- **Story Development**: `story_arc`, `motivations`, `fears`, `goals` 
- **Image Support**: Requires `character-images` storage bucket in Supabase

**LOCATION SYSTEM**: The enhanced locations table includes:
- **Classification Fields**: `location_type`, `story_importance` 
- **Visual & Atmospheric Details**: `atmosphere`, `visual_notes`
- **Frontend Integration**: Supports 3-tab interface (Basic, Details, Story)

**STORAGE REQUIREMENTS**: The backend requires these Supabase Storage buckets:
- `character-images` - For character profile images and AI-generated images
- `project-assets` - For storyboard images and other project assets

## ⚡ Database Optimization Guidelines

### Preventing N+1 Query Problems

**N+1 is the #1 performance killer.** It happens when you fetch N items, then make N additional queries for related data.

#### ❌ BAD: N+1 Pattern
```typescript
// Makes 1 + N queries!
const { data: characters } = await supabase
  .from('characters')
  .select('*')
  .eq('project_id', projectId);

for (const char of characters) {
  const { data: images } = await supabase
    .from('character_images')
    .select('*')
    .eq('character_id', char.id);
  char.images = images;
}
```

#### ✅ GOOD: Single Query with JOINs
```typescript
// Single query using Supabase embedded selects
const { data: characters } = await supabase
  .from('characters')
  .select(`
    *,
    character_images(id, image_url, is_primary),
    character_elements(id)
  `)
  .eq('project_id', projectId);
```

### Batch Counting Pattern

When counting related items for a list, fetch all counts in one query:

```typescript
// ❌ BAD: N queries for N scenes
for (const scene of scenes) {
  const { count } = await supabase
    .from('storyboard_panels')
    .select('id', { count: 'exact', head: true })
    .eq('scene_id', scene.id);
}

// ✅ GOOD: 1 query + in-memory aggregation
const { data: allPanels } = await supabase
  .from('storyboard_panels')
  .select('scene_id')
  .eq('project_id', projectId);

const panelCountMap: Record<string, number> = {};
for (const panel of allPanels || []) {
  panelCountMap[panel.scene_id] = (panelCountMap[panel.scene_id] || 0) + 1;
}
```

### Selective Field Fetching

Skip large JSONB fields when not needed:

```typescript
// ❌ BAD: Fetches huge 'content' field just to check existence
const { data } = await supabase.from('scripts').select('*');

// ✅ GOOD: Fetch only metadata
const { data } = await supabase
  .from('scripts')
  .select('id, title, created_at');

// ✅ BETTER: API parameter for conditional inclusion
const selectFields = req.query.include_content !== 'false'
  ? 'id, title, content, created_at'
  : 'id, title, created_at';
```

### Required Indexes

All foreign keys MUST have indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_scripts_project_id ON scripts(project_id);
CREATE INDEX IF NOT EXISTS idx_characters_project_id ON characters(project_id);
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_scene_id ON storyboard_panels(scene_id);
CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_type, content_id);
```

### Performance Benchmarks

| Metric | Target | Red Flag |
|--------|--------|----------|
| Single query | < 5ms | > 10ms |
| Page load queries | < 20 | > 50 |
| Any query with 100+ calls | 0 | N+1 problem! |
| Cache hit rate | > 99% | < 95% |

### Pre-Ship Checklist

Before deploying any database-touching code:

- [ ] No `await` inside `.map()` or `for` loops
- [ ] Related data fetched via embedded selects (JOINs)
- [ ] Large fields (JSONB) excluded when not needed
- [ ] Ownership checks included in UPDATE/DELETE
- [ ] Indexes exist for WHERE clause columns
- [ ] Tested with realistic data volume

**See CLAUDE.md section "Supabase & Database Optimization" for complete patterns.**

---

## 🛡️ Authentication & Security

### JWT Authentication
All API endpoints (except public ones) are protected by JWT authentication middleware:

```typescript
// Routes require this header:
Authorization: Bearer <supabase_jwt_token>
```

### Security Middleware Stack
The server applies these security layers in order:
1. **`helmet()`** - Security headers (CSP, HSTS, etc.)
2. **`errorSanitizer`** - Strips internal error details in production
3. **CORS** - Origin validation based on environment
4. **`ipAllowlistMiddleware`** - Optional IP-based access control
5. **`requireAuth`** - JWT token validation (per-route)
6. **`inputValidation`** - Request body/param sanitization (per-route)
7. **Rate limiters** - Per-endpoint rate limiting (see Rate Limiting section)

### Row Level Security (RLS)
- All database access is secured with RLS policies
- Users can only access their own data
- Collaboration access controlled by project permissions
- Service role access for backend operations

### IP Allowlist (Optional)
Restrict API access to specific IP addresses using the `ALLOWED_IPS` environment variable:

**Enable IP restrictions:**
```bash
# Single IP
ALLOWED_IPS=123.45.67.89

# Multiple IPs (comma-separated)
ALLOWED_IPS=123.45.67.89,98.76.54.32,111.222.333.444
```

**Disable IP restrictions (default):**
```bash
# Leave empty or unset
ALLOWED_IPS=
```

**Features:**
- When `ALLOWED_IPS` is empty/unset: All IP addresses allowed (default)
- When `ALLOWED_IPS` is set: Only listed IPs can access the API
- Blocked requests return `403 Forbidden` with error message
- Works with proxies (Vercel, Render) via `x-forwarded-for` header
- Logs all allowed/blocked access attempts

**Use cases:**
- Development environment access control
- Staging environment testing
- Temporary access restriction
- Additional security layer for sensitive deployments

**Find your IP:** https://www.whatismyip.com/

**Note:** Most home networks have dynamic IPs that change periodically. For production use, consider proper authentication instead of IP-based restrictions.

See `IP_ALLOWLIST_README.md` for detailed configuration and troubleshooting.

### Rate Limiting
Multiple rate limiters are applied to different endpoint groups (all per-user, per-minute):

| Limiter | Max Req/Min | Applied To |
|---------|-------------|------------|
| `aiLimiter` | 5 | `/api/ai/*` - AI generation endpoints |
| `scriptDoctorLimiter` | 15 | `/api/script-doctor/v2/*` - Script analysis |
| `billingLimiter` | 10 | `/api/billing/*` - Billing operations |
| `aiCreditsLimiter` | 5 | `/api/ai-credits/*` - Credit purchases |
| `crudLimiter` | 60 (writes only) | Projects, characters, locations, documents, etc. |
| `uploadLimiter` | 10 | Storyboard uploads, character images |
| `userLimiter` | 30 | `/api/user/*` - User profile operations |

- Uses user ID as the limiting key (falls back to IP)
- Returns 429 status when limits exceeded

## 🤖 AI Integration

### OpenAI API (GPT-5 Mini)
**CRITICAL: Always use `gpt-5-mini` model**

```typescript
// Correct configuration
{
  model: 'gpt-5-mini',  // Always use this
  max_completion_tokens: 64000, // Increased limit (was 32000)
  // Note: temperature parameter is NOT supported
}
```

**Token Allocation for Document Generation:**
- **Dynamic calculation** based on project duration (10 minutes = 1 page)
- **Per-page allocation**: 5,000 tokens (includes TipTap JSON overhead ~2x)
- **Token cap**: 64,000 tokens maximum (increased from 32,000)
- **Paragraph requirements**: Dynamic based on duration (120-min film = 120 paragraphs minimum)

**Examples:**
- 15-min short film: 2 pages × 5000 tokens = 10,000 tokens (20 paragraphs)
- 90-min feature: 9 pages × 5000 tokens = 45,000 tokens (90 paragraphs)
- 120-min feature: 12 pages × 5000 tokens = 60,000 tokens (120 paragraphs)

### AI Endpoints
- `/api/ai/generate-document` - Document generation by type
- `/api/ai/generate-script` - Screenplay generation
- `/api/ai/generate-scene` - Individual scene generation with optional continuity
- `/api/ai/generate-characters` - Character profile creation
- `/api/ai/generate-locations` - Location suggestions
- `/api/ai/chat` - Conversational AI with context
- `/api/ai/generate-storyboard` - Storyboard creation
- `/api/ai/generate-beats` - Beat sheet generation

#### Scene Generation Endpoint
```typescript
POST /api/ai/generate-scene
{
  project_id: string,           // Required: Project UUID
  scene_description: string,    // Required: Scene description
  script_id?: string,           // Optional: Script UUID
  scene_context?: string,       // Optional: Additional context
  characters?: Array,           // Optional: Character list
  style_preferences?: string,   // Optional: Style guidelines
  scene_number?: number,        // Optional: Scene number
  documents?: Array,            // Optional: Project documents
  locations?: Array,            // Optional: Project locations
  conversation_context?: string,// Optional: Brainstorming context
  previous_scene?: object       // Optional: Previous scene for continuity
}
```

**Previous Scene Parameter:**
- The `previous_scene` parameter accepts TipTap JSON content from the previous scene
- When provided, the AI will maintain narrative continuity from the previous scene
- Helps ensure consistent character states, locations, and plot momentum
- Useful for sequential scene generation in longer scripts

### Image Generation (Replicate API)
- Uses **Flux 1.1 Pro** model by default
- Character image generation
- Storyboard visualization
- Cost tracking and usage monitoring

## 📊 API Reference

### Base URL
- Development: `http://localhost:3001/api`
- All requests proxied from frontend at `/api/*`

### Core Endpoints

#### Projects (`/api/projects`)
```typescript
GET    /api/projects                    # Get user projects
POST   /api/projects                    # Create new project
GET    /api/projects/:id                # Get specific project
PUT    /api/projects/:id                # Update project
DELETE /api/projects/:id                # Delete project (soft)
PUT    /api/projects/:id/archive        # Archive project
PUT    /api/projects/:id/restore        # Restore from trash
```

#### Scripts (`/api/scripts`)
```typescript
GET    /api/scripts?project_id=<uuid>   # Get project scripts
POST   /api/scripts                     # Create new script
GET    /api/scripts/:id                 # Get specific script
PUT    /api/scripts/:id                 # Update script content
DELETE /api/scripts/:id                 # Delete script
```

#### Characters (`/api/characters`)
```typescript
GET    /api/characters?project_id=<uuid> # Get project characters
POST   /api/characters                   # Create new character
PUT    /api/characters/:id               # Update character
DELETE /api/characters/:id               # Delete character
POST   /api/characters/:id/generate-image # Generate character image
```

#### Character Images (`/api/characters/:characterId/images`)
```typescript
GET    /api/characters/:characterId/images           # Get all images for character
POST   /api/characters/:characterId/images           # Upload character image
PUT    /api/characters/:characterId/images/:imageId  # Update image metadata
DELETE /api/characters/:characterId/images/:imageId  # Delete character image
```

#### Character Elements (`/api/characters/:characterId/elements`)
```typescript
GET    /api/characters/:characterId/elements           # Get wardrobe/props/makeup elements
POST   /api/characters/:characterId/elements           # Create element
PUT    /api/characters/:characterId/elements/:elementId # Update element
DELETE /api/characters/:characterId/elements/:elementId # Delete element
```

#### Seasons & Episodes (TV Series)
```typescript
# Seasons (/api/projects/:projectId/seasons)
GET    /api/projects/:projectId/seasons    # Get project seasons
POST   /api/projects/:projectId/seasons    # Create season
PUT    /api/seasons/:id                    # Update season
DELETE /api/seasons/:id                    # Delete season

# Episodes (/api/seasons/:seasonId/episodes)
GET    /api/seasons/:seasonId/episodes     # Get season episodes
POST   /api/seasons/:seasonId/episodes     # Create episode
PUT    /api/episodes/:id                   # Update episode
DELETE /api/episodes/:id                   # Delete episode
```

#### Beats (`/api/projects/:projectId/beats`)
```typescript
GET    /api/projects/:projectId/beats      # Get project beat sheet
POST   /api/projects/:projectId/beats      # Create/update beats
DELETE /api/projects/:projectId/beats/:id  # Delete beat
```

#### Structure Templates (`/api/structure-templates`)
```typescript
GET    /api/structure-templates            # Get available story structure templates
```

#### Script Import (`/api/import`)
```typescript
POST   /api/import/fdx                     # Import Final Draft (.fdx) file
POST   /api/import/fountain                # Import Fountain (.fountain) file
```

#### Public Share (`/api/share`)
```typescript
POST   /api/share/create                   # Create public share link
GET    /api/share/:token                   # View shared project (public, no auth)
DELETE /api/share/:shareId                 # Revoke share link
```

#### Documents (`/api/documents`)
```typescript
GET    /api/documents?project_id=<uuid>  # Get project documents
POST   /api/documents                    # Create new document
GET    /api/documents/:id                # Get specific document
PUT    /api/documents/:id                # Update document
DELETE /api/documents/:id                # Delete document
GET    /api/documents/:id/versions       # Get document versions
POST   /api/documents/:id/versions       # Create document version
```

#### Production Planning (`/api/production`)

The production router is modular with sub-routers in `src/routes/production/`:

**Scene Management** (`production/scenes.ts`):
```typescript
GET    /api/production/scenes/:projectId              # Get merged script + production data
PATCH  /api/production/scenes/:sceneId                # Update scene production data
POST   /api/production/scenes/:sceneId/lock           # Lock scene for production
POST   /api/production/scenes/:sceneId/unlock         # Unlock scene
GET    /api/production/sync-status/:projectId         # Check sync status (dry run)
POST   /api/production/sync/:projectId                # Trigger manual sync
POST   /api/production/resolve-changes/:projectId     # Apply user sync decisions
```

**Cast Management** (`production/cast.ts`):
```typescript
POST   /api/production/cast                           # Create cast member
GET    /api/production/cast/:projectId                # Get all cast members
GET    /api/production/cast/:projectId/:castId        # Get cast member by ID
PUT    /api/production/cast/:castId                   # Update cast member
DELETE /api/production/cast/:castId                   # Delete cast member
POST   /api/production/cast/:castId/scenes            # Assign cast to scenes
DELETE /api/production/cast/:castId/scenes/:sceneId   # Remove cast from scene
GET    /api/production/scene/:sceneId/cast            # Get cast for scene
POST   /api/production/cast/:projectId/bulk-from-characters  # Create from characters DB
PUT    /api/production/cast/:castId/scenes/:sceneId/call-time # Update call time
```

**Crew Management** (`production/crew.ts`):
```typescript
POST   /api/production/crew                           # Create crew member
GET    /api/production/crew/:projectId                # Get all crew members
PUT    /api/production/crew/:crewId                   # Update crew member
DELETE /api/production/crew/:crewId                   # Delete crew member
```

**Schedule Management** (`production/schedule.ts`):
```typescript
GET    /api/production/schedule/:projectId            # Get complete schedule
PUT    /api/production/schedule/scene/:sceneId        # Assign scene to date
PUT    /api/production/schedule/:projectId/reorder    # Reorder scenes
POST   /api/production/schedule/:projectId/optimize   # AI schedule optimization
GET    /api/production/schedule/:projectId/daily/:shootDate  # Daily breakdown
DELETE /api/production/schedule/:projectId            # Clear schedule
```

**Call Sheet Generation** (via `production/schedule.ts`):
```typescript
GET    /api/production/call-sheet/:projectId/:shootDate      # Generate call sheet
GET    /api/production/call-sheet/:projectId/:shootDate/text # Call sheet as text
GET    /api/production/call-sheet/:projectId/days            # Get shooting days
```

**Analysis & Budget** (`production/analysis.ts`):
```typescript
POST   /api/production/analyze-script    # AI script analysis
GET    /api/production/analysis/:project_id # Get analysis
POST   /api/production/budget            # Create/update budget
GET    /api/production/budget/:project_id # Get budget details
POST   /api/production/fill-with-ai      # AI-enhance existing scenes
```

**Exports** (`production/exports.ts`):
```typescript
GET    /api/production/export/:projectId/breakdown    # Export scene breakdown (PDF/CSV)
GET    /api/production/export/:projectId/schedule     # Export shooting schedule
GET    /api/production/export/:projectId/call-sheet/:date # Export call sheet
```

#### Script Doctor V2 (`/api/script-doctor/v2`) 🚦 **Rate Limited**
```typescript
POST   /api/script-doctor/v2/analyze                      # Full AI script analysis
POST   /api/script-doctor/v2/analyze-scene                # AI scene/selection analysis
GET    /api/script-doctor/v2/analysis/:projectId/:scriptId # Get latest cached analysis
GET    /api/script-doctor/v2/analyses/:projectId/:scriptId # Get all analyses (history)
DELETE /api/script-doctor/v2/analysis/:analysisId         # Delete specific analysis
```

**Script Doctor Features:**
- **AI Script Analysis** - Comprehensive evaluation (plot, characters, dialogue, theme, marketability)
- **Scene Analysis** - Focused analysis of specific scenes or selections
- **Multilingual** - Supports English, Spanish, French
- **Scoring** - 1-100 scale with actionable feedback
- **Caching** - Content-hash based to prevent redundant API calls
- **Analysis History** - Stores all analyses with timestamps

#### Comments System (`/api/comments`) 💎 **Paid Plan Only** ⭐ **NEW**
```typescript
GET    /api/comments/:contentType/:contentId           # Get all comments for content
GET    /api/comments/:contentType/:contentId/stats     # Get comment statistics
POST   /api/comments/                                   # Create new comment
PUT    /api/comments/:commentId                         # Update comment text or status
DELETE /api/comments/:commentId                         # Soft delete comment
POST   /api/comments/:commentId/reactions              # Add/remove reaction
POST   /api/comments/:commentId/read                   # Mark comment as read
```

**Comments System Features:**
- **Google Docs-style commenting** - Hierarchical 2-level structure (root + replies)
- **Content Types** - Supports both `script` and `document` comments
- **Text Selection** - Attach comments to specific text ranges
- **Reaction System** - Emoji reactions with counts and user tracking
- **Read Status** - Unread comment tracking per user
- **Soft Delete** - Comments marked deleted instead of hard removal
- **Plan Requirement** - FREE plan blocked, PAID plan has full access

#### AI Services (`/api/ai`) 🚦 **Rate Limited**
All AI endpoints are rate-limited to 5 requests per minute per user.

#### Usage Analytics (`/api/usage`)
```typescript
GET    /api/usage/stats                 # User usage statistics
GET    /api/usage/monthly-summary/:user_id # Monthly summary
GET    /api/usage/export               # Export usage data
```

> **Full billing documentation**: See [`BILLING_SYSTEM.md`](./BILLING_SYSTEM.md) for complete architecture, subscription lifecycle flows, webhook design, proration logic, and API reference.

#### Unified Billing System (`/api/billing`)
```typescript
POST   /api/billing/preview                    # Preview any billing change with cost breakdown
POST   /api/billing/change                     # Execute billing changes (plans, addons, cancellation)
GET    /api/billing/debug-status              # Get current subscription state (debugging)
GET    /api/billing/subscription-status        # Get current subscription information
POST   /api/billing/create-checkout-session    # Create Stripe embedded checkout session
POST   /api/billing/create-portal-session      # Create Stripe customer portal session
POST   /api/billing/cancel-subscription        # Cancel subscription (immediate or at period end)
POST   /api/billing/downgrade-subscription     # Downgrade to free (= cancellation in new model)
POST   /api/billing/reactivate-subscription    # Reactivate a cancelled subscription
POST   /api/billing/fix-subscription           # Manually fix subscription status (debugging)
POST   /api/billing/verify-payment             # Verify embedded checkout payment completion
GET    /api/billing/plans                      # Get available pricing plans
```

**Unified Billing Features:**
- **Single API endpoint** - All billing operations through unified interface
- **Real-time previews** - Exact cost calculations with Stripe proration before execution
- **Atomic operations** - All billing changes are transactional and reversible
- **Flexible addon support** - Additional projects and collaborators at €4/month each (+ VAT)
- **Stripe integration** - Direct Stripe API for payments, subscriptions, and webhooks
- **Idempotency protection** - 60-second window prevents duplicate charges
- **Customer deduplication** - Prevents duplicate Stripe customers during resubscription
- **Security** - Only updates plan_id when subscription is active/trialing

### Request/Response Format

#### Success Response
```json
{
  "data": { ... },
  "message": "Success message"
}
```

#### Error Response
```json
{
  "error": "Error description",
  "details": { ... },
  "code": "ERROR_CODE"
}
```

#### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden (rate limited/quota exceeded)
- `404` - Not Found
- `429` - Too Many Requests
- `500` - Internal Server Error

## 🔄 Real-time Collaboration

The backend includes a Y.js WebSocket server for real-time collaborative editing:

### Collaboration Features
- **Real-time document editing** with conflict resolution
- **User presence tracking** with cursor positions
- **Document state synchronization** across all clients
- **Collaboration permissions** based on project roles

### WebSocket Server
```typescript
// Collaboration server runs alongside Express
const collaborationServer = new CollaborationServer(server);
```

### Document Types
- Scripts (TipTap JSON)
- Project documents (treatments, hooks, synopses, etc.)
- Character profiles
- Location details

## 📄 Documents System

### Document Types
The backend supports multiple document types for comprehensive project management:

- **Treatment** - Detailed narrative description with plot, characters, and themes
- **Hook** - Compelling one-liner for social media content
- **Synopsis** - Brief summary of main plot points and characters
- **Logline** - One-sentence story essence capture
- **Pitch Deck** - Presentation document for investors/producers
- **Character Breakdown** - Detailed character descriptions and motivations
- **Custom** - User-defined document types for specific needs

### Document Features
```typescript
// Document system capabilities
- Rich text editing with TipTap JSON content
- Automatic version control with change tracking
- AI-powered content generation by type
- Document type validation and constraints
- Project-based organization and permissions
- Full-text search and filtering
```

### Document Database Schema
```sql
-- Core document storage
project_documents (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  document_type VARCHAR(50) NOT NULL,
  title TEXT,
  content JSONB DEFAULT '{"type": "doc", "content": []}',
  is_ai_generated BOOLEAN DEFAULT FALSE,
  created_at, updated_at TIMESTAMPTZ
);

-- Version control for documents
project_document_versions (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES project_documents(id),
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  change_summary TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ
);
```

## 🔄 Background Tasks

The server runs periodic background tasks on startup:

| Task | Interval | Description |
|------|----------|-------------|
| Operation lock cleanup | Every 5 minutes | Purges expired distributed locks (`operationLockService`) |
| Soft-delete purge | Every 24 hours | Hard-deletes projects soft-deleted >90 days ago |

## 📈 Production Planning - World-Class Architecture

### Overview
The production planner uses a **world-class linked data model** that eliminates manual imports and keeps production automatically synchronized with script changes.

### Core Philosophy
```
OLD: Script → Manual Import → Scene Cards (duplicated data) ❌
NEW: Script (Source of Truth) ←→ Production Data (Enrichment Layer) ✅
```

### Key Features
- ✅ **No Manual Imports** - Production reads script directly
- ✅ **Auto-Sync** - Safe changes applied automatically
- ✅ **Smart Conflict Detection** - Risky changes flagged for review
- ✅ **Never Lose Work** - Production data preserved across script changes
- ✅ **Scene Locking** - Protect scenes in active production
- ✅ **Full Audit Trail** - Every change logged in `scene_change_log`
- ✅ **Intelligent Matching** - Handles renumbering, reordering across script revisions

### Architecture Components

#### **Services**
- `sceneIdentityService.ts` - Stable scene identification and matching
- `productionSyncServiceSimple.ts` - Intelligent sync engine with conflict resolution
- `scriptParsingService.ts` - Enhanced with scene caching
- `productionAnalysisService.ts` - AI-powered budget and schedule analysis
- `castService.ts` - Cast management business logic
- `scheduleService.ts` - Shooting schedule management
- `callSheetService.ts` - Call sheet generation
- `productionExportService.ts` - Production data export (PDF/CSV)
- `sceneBreakdownExportService.ts` - Scene breakdown export

#### **Middleware**
- `productionPrerequisitesMiddleware.ts` - Validates script exists and scenes are initialized

#### **Database Tables**
```sql
-- NEW: Production scene data (linked model)
production_scene_data (
  id, project_id, user_id,
  script_id, scene_number, scene_id, -- Links to script
  complexity, estimated_shoot_days, budget_estimate, -- Production data
  shots, production_notes, status,
  locked_at, locked_by, -- Locking mechanism
  script_content_hash, sync_status, last_synced_at -- Sync tracking
)

-- NEW: Audit trail
scene_change_log (
  id, project_id, scene_id,
  change_type, fields_changed,
  auto_synced, user_reviewed
)

-- Enhanced scripts table
scripts (
  scenes JSONB, -- Cached parsed scenes
  scene_version_hash -- Change detection
)

-- Enhanced projects table
projects (
  active_script_id, -- Current script for production
  last_scene_sync_at, scene_sync_status -- Sync tracking
)
```

### API Endpoints

#### **Main Production Endpoint**
```typescript
GET /api/production/scenes/:projectId
// Returns merged view: script data + production data
// Auto-initializes on first access
```

#### **Sync Endpoints**
```typescript
GET  /api/production/sync-status/:projectId    // Check sync status (dry run)
POST /api/production/sync/:projectId           // Trigger manual sync
POST /api/production/resolve-changes/:projectId // Apply user decisions
POST /api/production/scenes/:sceneId/lock      // Lock scene
POST /api/production/scenes/:sceneId/unlock    // Unlock scene
```

#### **Analysis & Budget Endpoints**
```typescript
POST /api/production/analyze-script           // AI script analysis
POST /api/production/fill-with-ai            // Enhance existing scenes
POST /api/production/budget                  // Budget management
```

### Sync Workflow

#### **Auto-Sync (Safe Changes)**
Automatically applied without user intervention:
- Scene renumbering
- Minor heading updates (typos, formatting)
- Character additions
- Action description changes

#### **Requires Review (Risky Changes)**
User must approve via modal:
- Location changes (affects schedule/budget)
- Time of day changes (affects crew/lighting)
- Character removals (affects budget)
- Scene deletions with production data

#### **Locked Scenes (Never Auto-Sync)**
Protected from automatic updates:
- Status: `locked`, `shooting`, or `completed`
- Must be manually unlocked to sync
- Script changes flagged but not applied

### User Workflow
```
1. Writer creates/edits script
2. User opens Production Planner
3. If first time:
   → Auto-initializes production scenes linked to script
4. If script changed:
   → Auto-syncs safe changes
   → Shows notification banner for review-needed changes
   → User reviews and applies selected changes
5. [Optional] "Fill with AI" enhances existing scenes
6. Lock scenes when ready for production
```

### Change Detection
```typescript
// Scene identity via content hashing
generateSceneId(scene) // Stable across revisions
generateSceneContentHash(scene) // Detects changes
matchScenes(scriptScenes, productionScenes) // Intelligent matching

// Matching strategies
1. Exact scene_id match (content fingerprint)
2. Fuzzy heading/location match (Levenshtein distance)
3. Scene number proximity
4. Mark unmatched as new/deleted
```

### Production Management Features
- **Scene Data** - Complexity, shoot days, budget, notes (production-only)
- **Script Data** - Heading, location, characters, dialogue (from script)
- **Budget Tracking** - Line-item budget management in cents
- **Schedule Management** - Shooting schedule with crew requirements
- **Location Management** - Location database with costs and availability
- **Cast Management** - Actor information and availability
- **Location-based Costs** - Production country/region/city multipliers

### Helper Functions
```sql
calculate_scene_content_hash() -- Generate content hash
generate_scene_id_from_content() -- Generate stable scene ID
get_unsynced_scenes_count() -- Count scenes needing sync
log_scene_changes() -- Automatic change logging trigger
```

### Performance Optimizations
- Scene caching in `scripts.scenes` JSONB column
- Hash-based scene matching (O(n) complexity)
- Efficient incremental sync (only changed scenes)
- Bulk operations in single transactions

### Migration from Old System
The new system includes:
- Backward compatibility view `scene_cards` for gradual migration
- Migration script in `migrations/production_planner_world_class.sql`
- Automatic data migration from old `scene_cards` table
- Zero downtime migration path

### Production Planner Implementation Status

**Phase 1: Database Foundation** ✅ **COMPLETE**
- Enhanced database schema with cast, crew, and scene management
- New table: `production_cast_scenes` - Junction table for cast-to-scene linking
- Enhanced tables: `production_cast`, `production_crew_assignments`, `production_scene_data`
- Database views: `v_production_cast_full`, `v_production_crew_full`, `v_daily_call_sheet`
- Helper functions: `get_scene_cast()`, `get_scene_crew()`
- Migration file: `migrations/production_planner_minimal.sql`

**Key Features Enabled:**
- ✅ Proper cast linking via stable `scene_id` (survives script edits)
- ✅ Character integration (links to characters DB)
- ✅ Call time tracking per cast member/scene
- ✅ Crew management with scene assignments
- ✅ Schedule data (shoot_date, call_time, duration)
- ✅ Call sheet generation from aggregated views
- ✅ Supabase RLS policies for security
- ✅ Zero data loss across script revisions

**Database Schema Key Tables:**
```sql
-- Cast to scene assignments
production_cast_scenes (
  id, cast_id, scene_id,
  call_time, wrap_time,
  has_dialogue, is_background, notes
)

-- Cast members with character links
production_cast (
  id, project_id, user_id,
  character_id,  -- Links to characters DB
  character_name, actor_name,
  actor_contact, category,
  rate_per_day, availability_dates
)

-- Enhanced scene data
production_scene_data (
  id, project_id, scene_id,
  shoot_date, shoot_day, shoot_order,
  call_time, estimated_duration_hours,
  status, sync_status, locked_at
)
```

**Running the Migration:**
```bash
# Option 1: Supabase SQL Editor (Recommended)
# Copy contents of plotwell-backend/migrations/production_planner_minimal.sql
# Paste in Supabase Dashboard → SQL Editor → Run

# Option 2: psql Command Line
cd plotwell-backend
psql -U your_username -d your_database_name -f migrations/production_planner_minimal.sql
```

**Verify Migration Success:**
```sql
-- Check new table exists
SELECT * FROM production_cast_scenes LIMIT 1;

-- Check views exist
SELECT * FROM v_production_cast_full LIMIT 1;
SELECT * FROM v_production_crew_full LIMIT 1;
SELECT * FROM v_daily_call_sheet LIMIT 1;
```

## 📊 Usage Tracking & Analytics

### AI Usage Monitoring
The backend tracks all AI API usage for billing and analytics:

```typescript
// Tracked metrics
- Token usage (prompt + completion)
- API call counts by operation type
- Cost tracking (OpenAI + Replicate)
- Monthly usage summaries
- Per-project usage attribution
```

### Usage Tables
- `ai_usage_events` - Individual API calls
- `image_usage_events` - Image generation tracking
- `monthly_ai_usage_summary` - Aggregated monthly data
- `ai_cost_rates` - API pricing configuration

### Analytics Endpoints
- Real-time usage statistics
- Monthly usage reports
- Cost breakdowns by service
- Export functionality (CSV/JSON)

### Unified Billing Service

**Modern billing architecture**: Single service handling all billing operations with Stripe integration.

#### Core Features
- **Preview and Execute Pattern** - All changes previewed before execution
- **Atomic Operations** - Billing changes are transactional with rollback capability
- **Real-time Cost Calculation** - Exact Stripe proration for plan changes
- **Flexible Addon Support** - Additional projects and collaborators at €4/month each (+ VAT)
- **Comprehensive Error Handling** - Detailed error responses for all failure scenarios
- **Idempotency Protection** - 60-second window prevents duplicate charges from double-clicks
- **Customer Deduplication** - Prevents duplicate Stripe customers during resubscription
- **Rate Limiting** - Preview: 10/min, Changes: 5/min

#### Service Architecture (SIMPLIFIED MODEL)
```typescript
interface BillingChangeRequest {
  type: 'new' | 'cancel' | 'addon_change'; // SIMPLIFIED: No upgrade/downgrade
  target_plan?: string; // Only 'paid' plan available
  billing_cycle?: 'monthly' | 'yearly';
  addons?: {
    additional_projects?: number; // 0-100 range
    additional_collaborators?: number; // 0-100 range
  };
  immediate_cancellation?: boolean;
}
```

#### Key Operations
- **Preview Changes** - `previewBillingChange()` with exact cost calculations
- **Execute Changes** - `executeBillingChange()` with Stripe API integration
- **State Management** - Synchronization between Stripe and local database
- **Addon Management** - Dynamic addon subscription item management
- **Subscription Cleanup** - `cancelDuplicateSubscriptions()` handles multiple active subscriptions
- **Checkout Session Cleanup** - `expireIncompleteCheckoutSessions()` prevents "multiple embedded checkout" errors

### Stripe Webhook Service

**Handles 11+ Stripe webhook event types for subscription lifecycle management**

#### Webhook Events Processed

| Event Type | Handler | Database Updates |
|------------|---------|------------------|
| `customer.created` | `handleCustomerCreated` | Updates `users.stripe_customer_id` |
| `customer.subscription.created` | `handleCustomerSubscriptionCreated` | Updates `users` + `user_subscriptions` |
| `customer.subscription.updated` | `handleCustomerSubscriptionUpdated` | Updates plan + addon quantities |
| `customer.subscription.deleted` | `handleCustomerSubscriptionDeleted` | Downgrades to free, preserves customer_id |
| `invoice.payment_succeeded` | `handleInvoicePaymentSucceeded` | Logs successful payment |
| `invoice.payment_failed` | `handleInvoicePaymentFailed` | Updates status to `past_due` |
| `checkout.session.completed` | `handleCheckoutSessionCompleted` | Creates subscription OR processes addon purchase |
| `invoiceitem.created` | `handleInvoiceItemCreated` | Logs proration items |
| `charge.dispute.created` | `handleChargeDisputeCreated` | Logs dispute |
| `refund.created` | `handleRefundCreated` | Logs refund processing |

#### Security Features
- **Webhook signature verification** - Validates all incoming webhook requests
- **Plan update protection** - Only updates `plan_id` when subscription is `active` or `trialing`
- **Customer preservation** - Preserves `stripe_customer_id` on cancellation for seamless resubscription
- **Addon extraction** - Automatically extracts and updates addon quantities from subscription items
- **Timestamp fallback** - Multiple strategies to handle missing period dates from Stripe

#### Testing Webhooks Locally

**Local Development (using Stripe CLI):**
```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe  # macOS
# or download from https://stripe.com/docs/stripe-cli

# Login to Stripe
stripe login

# Forward webhooks to local backend (CRITICAL: Use correct path)
stripe listen --forward-to localhost:3001/api/stripe/webhook

# Test specific webhook events
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

**Complete Local Testing Flow:**
```bash
# Terminal 1: Start backend server
cd backend
npm run dev

# Terminal 2: Start Stripe webhook forwarding
stripe listen --forward-to localhost:3001/api/stripe/webhook

# Terminal 3: Test webhook events
stripe trigger customer.subscription.created
```

**Using ngrok for External Access:**
```bash
# Start ngrok tunnel
ngrok http 3001

# Use the ngrok URL in Stripe Dashboard webhook settings
# Example: https://abc123.ngrok.io/api/stripe/webhook

# Update STRIPE_WEBHOOK_SECRET in .env with the webhook signing secret from Stripe Dashboard
```

**Production Webhook Setup:**
1. Configure webhook endpoint in Stripe Dashboard: `https://your-domain.com/api/stripe/webhook`
2. Select events to send (all subscription and payment events)
3. Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET` environment variable
4. Monitor webhook delivery in Stripe Dashboard logs

## 🔐 Subscription & Pricing

### Pricing Plans (SIMPLIFIED MODEL)
Configured in `src/config/pricingPlans.ts`:

**FREE Plan:**
- Projects: 1
- Documents: 2
- AI Generations: 20/month
- Collaborators: 1
- AI Credits: ❌ No (cannot purchase)
- Comments: ❌ No
- Version Control: ❌ No

**PAID Plan (€9/month or €90/year, + VAT):**
- **Base includes:**
  - Projects: 3 (base)
  - Collaborators: 2 (base)
  - AI Generations: ♾️ Unlimited
  - AI Credits: Can purchase (one-time, never expire)
  - Documents: ♾️ Unlimited
  - Comments: ✅ Yes
  - Version Control: ✅ Yes
  - Storyboards: ✅ Yes
  - Production Planning: ✅ Yes

**Addon Pricing (Paid Plan Only):**
- Additional Projects: **€4/month each** (+ VAT, unlimited)
- Additional Collaborators: **€4/month each** (+ VAT, unlimited)

### AI Credits System (NEW)
AI credits are **one-time purchases** that never expire:

- **Purchase**: 100 AI credits for €5 (paid subscribers only)
- **Image Generation**: 10 credits per image
- **Video Generation**: 50 credits per video (future)
- **Never Expire**: Credits persist across billing cycles
- **Not Subscription-Based**: Credits are NOT renewed monthly

**API Endpoints** (`/api/ai-credits`):
```typescript
GET  /api/ai-credits/balance       # Get current balance
POST /api/ai-credits/purchase      # Create Stripe checkout (one-time payment)
GET  /api/ai-credits/transactions  # Transaction history
GET  /api/ai-credits/config        # Public configuration
```

### Feature Gating
The `pricingMiddleware.ts` enforces subscription limits:
- Project creation limits
- AI generation quotas
- AI credit balance checks
- Team collaboration features

### Usage Quotas
Real-time quota checking and enforcement:
- Monthly AI generation limits
- AI credit balance verification
- Project count restrictions
- Team member limits

## 🧪 Development

### Available Scripts

```bash
# Local Development
npm run dev:local    # Start with .env.local (localhost)
npm run dev:dev      # Start with .env.development (Render dev)
npm run dev:prod     # Start with .env.production (Render prod)

# Production
npm run build        # Build TypeScript to JavaScript
npm start           # Start production server

# Database
npm run setup:db    # Apply complete database schema
npm run migrate     # Apply pending migrations

# Utilities
npm run test        # Run tests (if configured)
npm run lint        # ESLint code checking
```

### Development Server
The development server runs on port `3001` with:
- Hot reload via `ts-node`
- CORS enabled for frontend integration
- Request/response logging
- Error handling and validation

### Testing Strategy
- **Manual testing recommended** - User handles testing after implementation
- **API testing** via Postman or similar tools
- **Frontend integration testing** with React app
- **Database testing** with direct SQL queries

### Code Quality
- **TypeScript strict mode** for type safety
- **ESLint configuration** for code consistency
- **Error handling patterns** throughout the codebase
- **Input validation** on all endpoints

## 🔄 Version Control Integration

The backend includes a comprehensive version control system:

### Version Control Features
- **Automatic versioning** for all content changes
- **Manual checkpoints** for important milestones
- **Version restoration** with backup creation
- **Multi-tier retention policy** to prevent data loss

### Version Control Tables
- `script_versions` - Script version history
- `project_document_versions` - Document version history
- Version numbering and change tracking
- User attribution and timestamps

## 🌐 CORS & Frontend Integration

### CORS Configuration
```typescript
// Configured for frontend integration
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
};
```

### Frontend Proxy Setup
The frontend development server proxies API requests:
```json
// Frontend vite.config.ts
proxy: {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true
  }
}
```

## 🚀 Deployment

### URL Configuration

| Environment | Backend URL | Frontend URLs (CORS) |
|-------------|-------------|---------------------|
| **Local** | `localhost:3001` | `localhost:5173`, `localhost:5174` |
| **Dev** | `plotwell-backend-dev.onrender.com` | `plotwell-dev.vercel.app`, `plotwell-dev-landing.vercel.app` |
| **Prod** | `plotwell-backend.onrender.com` | `app.plotwell.co`, `plotwell.co` |

### Render Deployment (Manual Setup)

This guide shows how to deploy the backend to Render using the **free tier** without requiring payment information.

**Prerequisites:**
- Render account (free)
- GitHub repository connected to Render
- Environment variables ready

**Step 1: Create Web Service**
1. Go to Render Dashboard: https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your repository
4. Configure:
   - **Name**: `plotwell-backend-dev` (or `-prod`)
   - **Region**: Choose closest to your users
   - **Branch**: `dev` (or `master` for production)
   - **Root Directory**: `plotwell-backend` (if monorepo)
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (for development)

**Step 2: Configure Environment Variables**

Add these in Render Dashboard → Environment section:

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_JWT_SECRET=your_jwt_secret

# AI Services
OPENAI_API_KEY=your_openai_api_key
REPLICATE_API_TOKEN=your_replicate_token

# Server Configuration
NODE_ENV=development
PORT=3001

# Frontend URLs (Vercel deployment - comma-separated for CORS)
# Dev: includes both webapp and landing
FRONTEND_URL=https://plotwell-dev.vercel.app,https://plotwell-dev-landing.vercel.app,http://localhost:5173,http://localhost:5174

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_test_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_test_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_PAID_MONTHLY_PRICE_ID=price_id
STRIPE_PAID_YEARLY_PRICE_ID=price_id
STRIPE_ADDON_PROJECT_PRICE_ID=price_id
STRIPE_ADDON_COLLABORATOR_PRICE_ID=price_id

# Optional: IP Allowlist (restrict access to specific IPs)
ALLOWED_IPS=  # Leave empty for public access
```

**Step 3: Deploy**
1. Click "Create Web Service"
2. Wait for build to complete (5-10 minutes on free tier)
3. Copy your deployment URL: `https://plotwell-backend-dev.onrender.com`

**Step 4: Configure Frontend**

Update your frontend `.env` to point to Render backend:
```bash
VITE_API_URL=https://plotwell-backend-dev.onrender.com/api
```

**Free Tier Limitations:**
- Services sleep after 15 minutes of inactivity
- First request after sleep takes 30-60 seconds (cold start)
- 750 hours/month free (one service running 24/7)

**Keep Service Awake (Optional):**
Use a free cron service like cron-job.org to ping your backend every 10 minutes:
- URL: `https://plotwell-backend-dev.onrender.com/api/pricing`
- Schedule: Every 10 minutes

**Testing Deployment:**
```bash
# Check backend health
curl https://plotwell-backend-dev.onrender.com/api/pricing

# Should return pricing data
```

**Automatic Deploys:**
Render automatically deploys when you push to your configured branch.

**Monitoring:**
- View logs in Render Dashboard → Logs tab
- Monitor cold starts and response times
- Check webhook delivery in Stripe Dashboard

### Environment Variables for Production
```bash
NODE_ENV=production
PORT=3001
SUPABASE_URL=your_production_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_production_service_role_key
OPENAI_API_KEY=your_openai_api_key
REPLICATE_API_TOKEN=your_replicate_token
JWT_SECRET=your_strong_jwt_secret
# Production: app.plotwell.co (webapp) + plotwell.co (landing)
FRONTEND_URL=https://app.plotwell.co,https://plotwell.co
```

### Production Considerations
- **Environment-specific configurations**
- **Proper error logging and monitoring**
- **Database connection pooling**
- **Rate limiting configuration**
- **CORS origin restrictions**
- **SSL/TLS termination**
- **Load balancing for WebSocket connections**
- **Upgrade to Starter plan ($7/month)** for 24/7 uptime without cold starts

### Scaling Considerations
- **Database read replicas** for heavy read operations
- **Redis for session management** and rate limiting
- **Horizontal scaling** of API servers
- **CDN for static assets** and image generation results
- **Monitoring and alerting** for API performance

## 🔧 Troubleshooting

### Common Issues

#### Database Connection Issues
```bash
# Check Supabase credentials
node -e "console.log(process.env.SUPABASE_URL)"

# Test database connection
npm run test:db
```

#### AI API Issues
```bash
# Verify OpenAI API key
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models

# Check GPT-5 Mini availability
# Ensure you're using 'gpt-5-mini' model name
```

#### Rate Limiting Issues
```bash
# Check rate limit settings in middleware
# Verify user ID extraction from JWT
# Monitor rate limit redis keys if using Redis
```

### Logging
The backend includes comprehensive logging:
- API request/response logging
- Error tracking and stack traces
- AI API usage logging
- Database query logging (in development)

### Monitoring
Recommended monitoring setup:
- **API endpoint response times**
- **Database connection pool usage**
- **AI API usage and costs**
- **WebSocket connection counts**
- **Memory and CPU usage**

## 📚 Additional Resources

- [API Documentation](../BACKEND_API_DOCUMENTATION.md) - Complete API reference
- [Database Schema](./database_complete_schema.sql) - Complete database setup
- [Frontend Integration](../web-app/README.md) - Frontend setup guide
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment instructions

## 🤝 Contributing

### Development Workflow
1. Create feature branch from `main`
2. Implement changes with proper TypeScript typing
3. Update API documentation if needed
4. Test manually with frontend integration
5. Create pull request with detailed description

### Code Style
- Use TypeScript strict mode
- Follow existing naming conventions
- Add proper error handling
- Include JSDoc comments for complex functions
- Maintain consistent API response formats

---

**Backend Version**: 2.0.0
**Node.js**: 18+
**Database**: PostgreSQL (via Supabase)
**Primary AI Models**: GPT-OSS-120B (via Replicate), Flux 1.1 Pro (images)