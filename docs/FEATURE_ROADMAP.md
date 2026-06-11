# plotwell - Feature Roadmap

**Last Updated**: March 27, 2026 | **Status**: Production, expanding feature set

---

## 1. Executive Summary

plotwell ships with a strong foundation: professional screenplay editing, AI-powered writing assistance, production planning tools, real-time collaboration, and TV series support. This roadmap outlines the features that will deepen each of those verticals and open new ones -- organized by user impact and strategic value.

**Current state**: Full screenwriting suite with dark mode, writing statistics, AI scene/character/storyboard generation, production breakdown + scheduling + stripboard + shot lists + production dashboard, collaboration with comments, billing with Stripe.

**Target state**: The all-in-one platform where a screenplay goes from idea to shooting schedule without leaving the app.

**Strategic focus**: Productivity and production tools. Competitors are chasing AI video models and video editors. plotwell wins by being the best tool to actually *get your project made* -- not generate flashy demos.

---

## 2. What's Shipped Today

A quick inventory of what's live, so the roadmap builds on reality.

| Area | Features |
|------|----------|
| **Script Editor** | 12 screenplay elements, auto-save, version history, scene numbering, production marking, FDX/Fountain import, PDF/Fountain/FDX export, inline AI autocomplete, writing statistics, reading mode |
| **AI Writing** | Scene generation, brainstorming chat, Script Doctor V2 (multi-category analysis), character/location extraction, document generation (treatment, synopsis, logline, pitch deck), beat sheet suggestions |
| **AI Images** | Character portraits, location photos, storyboard panels (FLUX 2, Gemini, Imagen 4 via multi-model router) |
| **Story Development** | Beat sheets, outline view, concept documents, character profiles + elements, location database |
| **Storyboard** | Panel editor, drag-and-drop reorder, AI bulk fill, shot type + camera metadata |
| **Production** | Scene breakdown (with props/wardrobe/vehicles per scene), cast/crew management, day-by-day scheduling, stripboard, shot list builder, call sheet generation + export (CSV/HTML), budget tracking, production dashboard, filming locations (permits, photo gallery) |
| **Collaboration** | Real-time Y.js editing, presence/cursors, threaded comments + reactions, role-based access (owner/admin/editor/viewer), email invitations, team member management |
| **TV Series** | Seasons, episodes, episode-aware navigation across all views |
| **Billing** | Free tier (1 project, 40 AI tasks), Pro at EUR 9/mo (4 projects, unlimited AI, production tools), project + collaborator add-ons, one-time AI credit packs |
| **Project Types** | Film, Series, Short, Commercial, Music Video, Documentary, Reel |
| **UX** | Dark mode, in-app guided tour, keyboard shortcuts panel |
| **Sharing** | Public sharing links (read-only, password-protected, section-selectable, with analytics) |
| **Export** | Script PDF/Fountain/FDX, call sheet CSV/HTML, presentation PDF, budget PDF |
| **i18n** | English, Spanish |

---

## 3. Feature Roadmap

### Phase 1: Activation & Sharing (Q2 2026) -- NEARLY COMPLETE

**Goal**: Make the first 5 minutes magical and create a viral loop for organic growth.

**Shipped**: Dark mode, Writing statistics, Public sharing links, In-app guided tour, Presentation PDF export.

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F5 | **Welcome email sequence** | Onboarding | 3-email drip after signup (welcome, quick-start tips, upgrade nudge). Email service exists but no drip sequence yet. | 8h |

**Phase total**: ~8h remaining

---

### Phase 2: Mobile & Deeper Writing (Q2-Q3 2026)

**Goal**: Go where your users are (their phones) and make plotwell the best place to *write*, not just format.

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F11 | **Progressive Web App (PWA)** | Platform | Install-to-homescreen, push notifications, offline-capable shell, native-feeling editor on mobile | 40h |
| F12 | **Revision tracking & colored pages** | Editor | Industry-standard revision drafts with color-coded pages (white, blue, pink, yellow, green, goldenrod) | 20h |
| F13 | **Index cards view** | Story | Visual scene cards on a corkboard, drag to reorder, color-code by storyline -- works great as a touch-first mobile view | 16h |
| F14 | **Dialogue polish mode** | AI | AI-powered dialogue refinement -- tighten, add subtext, match character voice | 12h |
| F15 | **Character voice consistency** | AI | Analyze all dialogue for a character, flag inconsistencies, suggest corrections | 12h |
| F16 | **Outline-to-script generation** | AI | Generate a full first draft from a completed beat sheet / outline. Beat-aware generation exists in AI chat; needs a dedicated one-click pipeline. | 16h |
| F17 | **Side-by-side comparison** | Editor | Compare two script versions or revision drafts in a split view (desktop) / swipe between versions (mobile) | 12h |
| F18 | **Screenplay analysis report** | AI | Full-script AI analysis: structure, pacing, theme, Bechdel test, dialogue quality -- exportable PDF. Script Doctor V2 covers scene-level analysis; this is the project-wide report. | 16h |
| F19 | **DOCX export for documents** | Export | Export treatments, synopses, breakdowns to Word. Backend stub exists but outputs plain text; needs real OOXML. | 6h |
| F21 | **Custom formatting presets** | Editor | Save and load custom element styles (font, margins, spacing) per project | 8h |

**Phase total**: ~158h

---

### Phase 3: Production Powerhouse (Q3-Q4 2026) -- PARTIALLY SHIPPED

**Goal**: Close the gap with StudioBinder so users never need a second tool.

**Shipped**: Shot list builder (F22), Stripboard (F23), Production dashboard (F31). Props/wardrobe/vehicles tracked per-scene in breakdown (F25 partial). Filming locations with permits + photos (F30 partial).

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F24 | **Day-out-of-days (DOOD) report** | Production | Standalone DOOD export showing each cast member's work/hold/travel days. Currently folded into breakdown export; needs its own dedicated report. | 12h |
| F25b | **Standalone inventory tracking** | Production | Extend per-scene props/wardrobe/vehicles to a project-wide inventory view with cross-scene usage matrix | 12h |
| F26 | **Budget templates** | Budget | Pre-built budget templates by project type (short film, feature, commercial, music video) | 8h |
| F27b | **Budget Excel export** | Budget | Add Excel/CSV export alongside existing PDF. Department subtotals and top sheet. | 6h |
| F28 | **Continuity notes** | Production | Per-scene continuity tracking: wardrobe, props, hair/makeup, time of day, weather | 12h |
| F29 | **Calendar integration** | Production | Sync shoot schedule to Google Calendar / iCal | 8h |
| F30b | **Location scouting: GPS + maps** | Locations | Add GPS coordinates, map view, and scouting workflow to existing filming locations | 8h |

**Phase total**: ~66h remaining (was 128h -- 62h shipped)

---

### Phase 4: Collaboration & Team (Q4 2026)

**Goal**: Make plotwell work for teams, not just solo writers.

Team member management and invitations already ship. This phase adds deeper collaboration features.

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F32 | **Granular permissions** | Collaboration | Per-section access control (e.g., editor can edit script but only view budget) | 16h |
| F33 | **Change log / activity feed** | Collaboration | Chronological feed of all project changes with user attribution. Team ActivityView exists; needs richer data. | 12h |
| F34 | **Notification center** | UX | In-app notification panel for collaboration events (comments, invitations, edits, @mentions) | 16h |
| F35 | **@mention notifications** | Collaboration | Notify users via email + in-app when mentioned in comments | 8h |
| F36 | **Approval workflows** | Collaboration | Lock scenes/documents behind approval gates (draft -> review -> approved -> locked). Schema fields exist; needs routes + UI. | 16h |
| F37b | **Full team workspace** | Collaboration | Organization-level workspace with shared projects and centralized billing. Basic team/invite infrastructure exists; needs workspace UI. | 20h |
| F38 | **Commenting on storyboard panels** | Collaboration | Extend the threaded comment system to storyboard panels and production views | 8h |
| F39 | **Character relationship map** | Characters | Visual graph of character relationships (allies, rivals, family) with AI auto-detection | 16h |
| F40 | **Offline mode** | Editor | Local-first editing with sync on reconnect (service worker + IndexedDB cache) | 32h |
| F41 | **Conflict resolution UI** | Collaboration | When Y.js conflicts occur, show a merge dialog instead of silently resolving | 12h |

**Phase total**: ~156h

---

### Phase 5: AI Next Level (Q1 2027)

**Goal**: AI that understands your entire project, not just the current scene.

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F42 | **Project-wide AI memory** | AI | Persistent AI context across all conversations -- remembers decisions, tone, style notes | 16h |
| F43 | **AI rewrite suggestions** | AI | Highlight any text, get 3 alternative rewrites with different tones (darker, funnier, more subtle) | 12h |
| F44 | **AI-powered casting suggestions** | AI | Given character profiles, suggest actor types or real actors who fit the role (for reference boards) | 8h |
| F45 | **Tone & genre analysis** | AI | Analyze the full script and map tone shifts across scenes -- visualize emotional arc | 12h |
| F46 | **AI storyboard style transfer** | AI | Generate all storyboard panels in a consistent visual style (noir, animation, documentary, etc.) | 12h |
| F47 | **AI video generation** | AI | Generate short preview clips from storyboard panels or scene descriptions (5-10s per panel). **Deprioritized** -- competitors are burning cash here; we focus on productivity. | 20h |
| F48 | **Smart scene suggestions** | AI | Based on outline gaps, suggest missing scenes (e.g., "your midpoint has no reversal") | 12h |
| F49 | **AI translation** | AI + i18n | Translate the screenplay itself (not UI) to another language while preserving formatting | 16h |
| F50 | **AI logline/tagline generator** | AI | Generate multiple logline and tagline options from the full project context | 4h |
| F51 | **Research assistant** | AI | AI that answers questions about the script's world, timeline, or internal logic | 12h |

**Phase total**: ~124h

---

### Phase 6: New Verticals & Growth (Q2 2027+)

**Goal**: Expand the addressable market beyond screenwriters.

| # | Feature | Area | Description | Effort |
|---|---------|------|-------------|--------|
| F52 | **Theatre project type** | New vertical | Stage play formatting, act/scene structure, stage directions, theatre-specific production tools | 24h |
| F53 | **Podcast script support** | New vertical | Podcast/audio drama formatting with speaker labels, SFX cues, music cues | 12h |
| F54 | **Referral program** | Growth | Give 1 month Pro free for each referral that converts to paid | 12h |
| F55 | **plotwell for Education** | Growth | Discounted plan for students/teachers, classroom features (teacher view, assignment templates) | 20h |
| F56 | **Plugin / extension system** | Platform | Allow third-party integrations (e.g., connect to casting databases, music libraries, SFX libraries) | 40h |
| F57 | **API access for Pro users** | Platform | Public REST API so power users can build automations and integrations | 24h |
| F58 | **Additional languages** | i18n | French, German, Portuguese, Italian, Korean, Japanese, Mandarin | 8h/lang |
| F59 | **Screenplay contests integration** | Growth | Submit directly to screenplay contests from plotwell (partner integrations) | 16h |
| F60 | **Course / educational content** | New vertical | Lesson structure, course outline tools, educational script formatting | 16h |

**Phase total**: ~220h+

---

## 4. Feature Priority Matrix

```
                     HIGH USER IMPACT
                          |
          +---------------+---------------+
          |  DO NOW       |  PLAN NEXT    |
          |               |               |
          |  F5           |  F12,F13      |
          |  F24,F25b     |  F16,F18      |
          |  F19          |  F37b         |
          |               |               |
   LOW ---+---------------+---------------+--- HIGH
  EFFORT  |               |               |  EFFORT
          |  BATCH        |  DEFER        |
          |               |               |
          |  F26,F27b     |  F52-F53      |
          |  F30b,F50     |  F55,F56,F57  |
          |               |  F40,F60      |
          |               |               |
          +---------------+---------------+
                          |
                     LOW USER IMPACT
```

---

## 5. Features by User Journey

### Writer (solo, free tier -- on their phone)

```
Sign up -> Onboarding (shipped) -> Pick template -> Write script
  -> Use AI brainstorming -> Script Doctor (shipped)
  -> Writing stats (shipped) -> Export PDF -> Share link (shipped)

Upgrade triggers:
  -> Hit 40 AI task limit -> Upgrade to Pro
  -> Want storyboard -> Upgrade to Pro
  -> Want second project -> Upgrade to Pro
```

**Next features to build**: F5 (welcome emails to reduce churn), F11 (PWA for mobile writers), F13 (index cards)

### Writer (Pro, solo)

```
Create project -> Import existing script
  -> AI brainstorming -> Beat sheet -> Outline -> Script
  -> Script Doctor analysis -> Revisions (F12) -> Side-by-side compare (F17)
  -> Index cards (F13) -> Character profiles -> Storyboard -> Documents -> Export all
```

**Next features to build**: F12, F13, F14, F16, F17, F18, F42

### Producer / Production Team

```
Import locked script -> Scene breakdown -> Cast/crew assignment
  -> Shot lists (shipped) -> Stripboard scheduling (shipped)
  -> Call sheets -> Budget -> Production dashboard (shipped)
  -> DOOD report (F24) -> Inventory tracking (F25b)
  -> Calendar sync (F29)
```

**Next features to build**: F24, F25b, F26, F27b, F28, F29

### Team / Writers' Room

```
Create team (shipped) -> Invite writers (shipped)
  -> Real-time co-writing (shipped) -> Comments (shipped)
  -> @mentions (F35) -> Approval workflow (F36)
  -> Activity feed (F33) -> Full workspace (F37b)
```

**Next features to build**: F32, F33, F34, F35, F36, F37b

---

## 6. Competitive Feature Gap Analysis

Features competitors have that plotwell doesn't (yet):

| Feature | Final Draft | Celtx | StudioBinder | WriterSolo | plotwell Status |
|---------|:-----------:|:-----:|:------------:|:----------:|----------------|
| Dark mode | Yes | Yes | Yes | Yes | **Shipped** |
| Script statistics | Yes | -- | -- | Yes | **Shipped** |
| Public sharing links | -- | Yes | Yes | -- | **Shipped** |
| Shot lists | -- | Yes | Yes | -- | **Shipped** |
| Stripboard | -- | Yes | Yes | -- | **Shipped** |
| Production dashboard | -- | -- | Yes | -- | **Shipped** |
| Mobile app / PWA | -- | Yes | -- | -- | **Phase 2 (F11)** |
| Revision tracking / colored pages | Yes | Yes | -- | -- | **Phase 2 (F12)** |
| Index cards / corkboard | Yes | Yes | -- | -- | **Phase 2 (F13)** |
| Day-out-of-days | -- | -- | Yes | -- | **Phase 3 (F24)** |
| Offline mode | Yes | -- | -- | -- | **Phase 4 (F40)** |

**plotwell already leads on**: AI writing assistance, AI images, real-time collaboration, integrated production + writing, pricing, dark mode, writing statistics, shot lists + stripboard in a single tool.

---

## 7. Revenue Impact Estimates

| Feature | Expected Impact | Mechanism |
|---------|----------------|-----------|
| ~~Dark mode~~ | ~~Shipped~~ | ~~Table stakes for young creators~~ |
| ~~Writing statistics~~ | ~~Shipped~~ | ~~Engagement and retention~~ |
| ~~Public sharing~~ | ~~Shipped~~ | ~~Every shared script is a plotwell ad~~ |
| ~~Shot lists + Stripboard~~ | ~~Shipped~~ | ~~Opens production buyer persona~~ |
| ~~Production dashboard~~ | ~~Shipped~~ | ~~At-a-glance value that justifies Pro~~ |
| F5 (Welcome emails) | Reduce Day-7 churn | Drip sequence activates new users |
| F24 (DOOD report) | Retain production users | Industry-standard report that StudioBinder charges for |
| F12 (Revision tracking) | Retain Pro writers | Table-stakes for professional writers |
| F37b (Team workspace) | Higher ARPU, enterprise path | Teams pay per-seat, sticky |

---

## 8. Timeline Overview

| Phase | Timeline | Theme | Status |
|-------|----------|-------|--------|
| Phase 1 | Q2 2026 | Activation & Sharing | ~95% complete (F5 remaining) |
| Phase 2 | Q2-Q3 2026 | Mobile & Deeper Writing | Not started |
| Phase 3 | Q3-Q4 2026 | Production Powerhouse | ~50% shipped (F22, F23, F31 done) |
| Phase 4 | Q4 2026 | Collaboration & Team | Foundation shipped (teams, invites) |
| Phase 5 | Q1 2027 | AI Next Level | Not started |
| Phase 6 | Q2 2027+ | New Verticals & Growth | Not started |

**Phase 1 nearly complete** -- one feature remaining (welcome emails).

**Phase 3 is ahead of schedule** -- shot lists, stripboard, and production dashboard shipped early. Remaining items are incremental improvements (DOOD report, inventory view, budget templates, calendar sync).

**Phase 2 is the current priority** -- with Phase 3 core features shipped, writing depth features (revision tracking, index cards, PWA) become the highest-impact next step for the writer persona.

**Phase 4 foundation exists** -- team management and invitations work. The gap is organization-level workspaces, granular permissions, and notification infrastructure.

**Phase 5 AI is deliberately deprioritized** -- AI video generation (F47) is deferred indefinitely. Focus AI investment on writing productivity (F42, F43, F48), not generation gimmicks.

---

## 9. Success Metrics per Phase

| Phase | Metric | Target |
|-------|--------|--------|
| Phase 1 | Day-1 activation (user creates first script) | 60% -> 75% of signups |
| Phase 2 | Weekly active writers | +30% vs. pre-phase |
| Phase 3 | Users reaching production views | 20% of Pro users |
| Phase 4 | Projects with 2+ collaborators | 15% of Pro projects |
| Phase 5 | AI tasks per active user per week | 10+ |
| Phase 6 | Non-film project types created | 10% of new projects |

---

*This is a living document. Re-prioritize quarterly based on user feedback, usage data, and competitive moves.*
