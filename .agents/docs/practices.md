# Practices And Pitfalls

## Frontend

- Use `navigate()` for internal navigation.
- Use `useProjectNavigation` for dashboard navigation.
- Import with `@/` alias.
- Use `cn()` for conditional class merging.
- Type props, hook returns, and shared data structures.
- Use i18n keys for user-facing text.
- Keep landing and app video showcase data in sync when adding videos.

## Backend

- Apply the full middleware chain for protected routes.
- Include ownership checks in updates and deletes.
- Use the Supabase client, not a PostgreSQL pool.
- Track AI usage after successful generation.
- Return consistent error formats.
- Check collaboration access where resources can be shared.
- Protect archived projects with the appropriate middleware.

## Database

- Projects use `name`, not `title`, for the project name.
- Use soft delete for projects.
- Use `TIMESTAMPTZ` for datetime fields.
- Store money as integer cents.
- Include ownership in mutation filters.
- Avoid N+1 queries.
- Avoid overfetching large JSONB fields.

## Common Pitfalls

- `window.location.href` for internal routes.
- Reading or writing `projects.title` when the project name is needed.
- Hard-deleting projects.
- Missing `.eq("user_id", userId)` or equivalent access checks on mutations.
- Reading `req.userId` without `extractUserId`.
- Forgetting `trackOpenAIUsageInRoute`.
- Relative import chains like `../../` where `@/` should be used.
- Hardcoded user-facing text.
