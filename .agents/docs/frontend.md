# Frontend Guide

Frontend code lives in `plotwell-app/`.

## Navigation

Always use React Router navigation for internal routes.

```typescript
import { useNavigate } from "react-router-dom";

const navigate = useNavigate();
navigate("/projects");
navigate(`/dashboard/${projectId}?section=script`);
```

Do not use `window.location.href` for internal routes because it causes a full reload and loses app state. External URLs such as Stripe checkout are the exception.

## Dashboard Navigation

Use `useProjectNavigation` for dashboard navigation.

```typescript
import { useProjectNavigation } from "@/hooks/useProjectNavigation";

const {
  navigateToSection,
  currentSection,
  currentEpisodeId,
  setEpisode,
  clearEpisode,
} = useProjectNavigation(projectId);

navigateToSection("script", { episodeId: "ep-123" });
```

Episode-aware sections preserve `episode_id`: script, storyboard, scenes breakdown, budget, characters, locations, cast and crew, and production.

## URL Shape

```text
/dashboard/:projectId?section=SECTION&episode_id=EPISODE&id=ITEM_ID&source=SOURCE
/projects?view=VIEW&filter=FILTER
```

Project page views include `usage`, `billing`, `plans`, `addons`, `trash`, and `settings`.

## Component Organization

Important frontend folders under `plotwell-app/src/`:

- `pages/` - route components such as `Dashboard`, `Projects`, auth pages, billing return, and public share.
- `components/ai/` - AI chat, scene generation, and related AI UI.
- `components/views/` - main product views.
- `components/layout/` - `IconRail`, `TopBar`, `SubNav`, `MobileNav`, and `MainCanvas`.
- `components/billing/` - pricing, usage, profile, billing UI.
- `components/modals/` - modal dialogs.
- `components/scriptDoctor/` - script doctor issue UI.
- `components/storyboard/` - storyboard panels and generation flows.
- `components/characters/`, `components/locations/`, `components/budget/`, `components/beats/`, `components/series/`, `components/team/`.
- `components/ui/` - base shadcn/ui components plus app primitives like `ViewContainer`, `ViewHeader`, `DataTable`, `SearchInput`, `EmptyState`, `ConfirmationModal`, `ViewerModeBanner`, `PrerequisiteGuard`, and `SidePanel`.
- `hooks/` - custom hooks.
- `contexts/` - React contexts.
- `lib/editor/` - `plotwell-editor` integration and collaboration.
- `lib/tiptap/` - TipTap document editor config only.
- `lib/parsers/` - FDX and Fountain parsers.
- `types/` - shared TypeScript types.
- `i18n/locales/` - English and Spanish locale JSON files.

## Key Hooks

- `useAddonManagement` - addon subscription management.
- `useBilling` - billing and subscription operations.
- `useBudget` - budget tracking and analytics.
- `useBeats` - beat sheet management.
- `useCollaboration` - real-time collaboration.
- `useComments` - comments.
- `useDocumentsAPI` - document CRUD.
- `useEpisodeMapping` - TV-series character/location matrix queries.
- `useStoryboard` - storyboard CRUD and AI generation state.
- `useViewerMode` - read-only viewer mode.
- `useAlert` - toast notifications.

## State Management

Use React Context plus hooks:

- `AuthContext` - auth and sessions.
- `SubscriptionContext` - subscription data, polling backend.
- `AIStateContext` - AI operation state, persisted to localStorage.
- `AlertContext` - toast notifications.
- `ScriptDoctorContext` - Script Doctor state.
- `CollaborationContext` - collaboration state.

Do not add a global state library unless the architecture changes intentionally.

## Imports

Use the `@/` alias.

```typescript
import { Button } from "@/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import ProjectCard from "@/components/ProjectCard";
```

## TypeScript

- Define interfaces for props and data structures.
- Prefer explicit return types for hooks and public helpers.
- Avoid `any`; use it only when the boundary genuinely cannot be typed better.

## i18n

All user-facing text must use `useTranslation()`.

```typescript
const { t } = useTranslation();
t("section.key", "Fallback");
```

Use dot notation and group keys by feature. Add keys to both locale files:

- `plotwell-app/src/i18n/locales/en.json`
- `plotwell-app/src/i18n/locales/es.json`

For the landing site, update:

- `plotwell-landing/public/locales/en/translation.json`
- `plotwell-landing/public/locales/es/translation.json`

Do not add inline translations to `plotwell-landing/src/lib/i18n.ts`.
