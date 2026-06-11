# Database Guide

plotwell uses Supabase PostgreSQL. The full schema is in `plotwell-backend/database_complete_schema.sql`.

## Critical Project Name Rule

Projects use `name` for the project name. `title` is the screenplay cover-page title.

```sql
-- Correct
SELECT name FROM projects WHERE id = ?;

-- Wrong for project names
SELECT title FROM projects WHERE id = ?;
```

## Core Tables

- `users` - auth profile, Stripe IDs, GDPR consent.
- `projects` - `name`, `title`, `project_type`, `status`, `deleted`.
- `scripts` - `project_id`, `episode_id`, `content`, cached `scenes`.
- `seasons` and `episodes` - TV series hierarchy.
- `characters` and `locations` - project entities with `name`.
- `location_images` - max 3 images per location, image type enum, storage paths.
- `script_doctor_dismissed_issues` - per-user issue dismissals.

## Naming Conventions

| Table | Field | Purpose |
| --- | --- | --- |
| `projects` | `name` | Project identifier |
| `projects` | `title` | Screenplay title for cover page |
| `scripts` | `title` | Script title |
| `episodes` | `title` | Episode title |
| `characters` | `name` | Character name |
| `locations` | `name` | Location name |

Rule: projects use `name`, content items use `title`, entities use `name`.

## Mutation Patterns

Timestamps are expected on tables through `created_at` and `updated_at`.

Soft delete projects:

```sql
UPDATE projects SET deleted = TRUE WHERE id = ?;
SELECT * FROM projects WHERE deleted = FALSE;
```

Do not hard delete user projects in normal product flows.

One-to-many relationships generally use `ON DELETE CASCADE`.

## Supabase Query Rules

- Avoid N+1 queries. Use embedded selects like `.select("*, related_table(fields)")`.
- Batch counts and aggregate in memory instead of counting inside loops.
- Select only needed fields; avoid large JSONB columns such as `scripts.content` and `scripts.scenes` unless needed.
- Backend uses the service role key, so application code must enforce ownership/collaboration checks.
- Index FK columns and common `WHERE` columns.
