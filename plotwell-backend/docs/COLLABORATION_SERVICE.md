# plotwell Collaboration Service

**Last Updated**: April 5, 2026

---

## Overview

plotwell's collaboration system combines **WebSocket + Y.js CRDT** for real-time co-editing with **REST endpoints** for team management, invitations, comments, and public sharing. Collaboration and comments features require a **paid plan** (checked via `pricingService.hasPaidPlan()`). Viewers are free slots; editors/admins count as paid collaborator slots. Public share links allow read-only access without authentication.

---

## Architecture

### Key Files

| Layer | File | Purpose |
|-------|------|---------|
| **WebSocket** | `services/collaborationServer.ts` | Y.js sync, presence, room management |
| **REST Routes** | `routes/collaboration.ts` | Team management, invitations, sessions |
| **Comments** | `routes/comments.ts` | Threaded comments, reactions |
| **Public Share** | `routes/publicShare.ts` | Shareable read-only links (token-based, no auth) |
| **Email** | `services/emailService.ts` | Invitation emails |
| **Auth** | `middleware/auth.ts` | JWT validation for REST |
| **Pricing** | `middleware/pricingMiddleware.ts` | Plan checks for collaboration access |

### Database Tables

| Table | Purpose |
|-------|---------|
| `project_collaborators` | Collaborator records (user, project, role, permissions) |
| `collaboration_invitations` | Pending invitations (32-byte token, 7-day expiry) |
| `collaboration_documents` | Y.js document state (`yjs_state` binary + `yjs_vector_clock` JSON) |
| `user_presence` | Active user presence per project |
| `collaboration_activity` | Activity log (joins, edits, comments) |
| `comments` | Comment threads (content_type, content_id, parent_comment_id) |
| `comment_reactions` | Emoji reactions on comments |
| `comment_read_status` | Per-user read tracking (comment_id, user_id, read_at) |
| `public_project_shares` | Shareable read-only links (token, shared_sections, password_hash, expires_at, view_count) |

---

## Real-Time Editing

### Y.js Protocol

WebSocket path: `/collaboration`

```
Client                    Server
  |-- Connect (JWT) ------->|
  |                          |-- Verify JWT (10s timeout)
  |                          |-- Check project access
  |<-- Auth success ---------|
  |                          |
  |-- Sync Step 1 --------->|  (client state vector)
  |<-- Sync Step 2 ---------|  (server diff + server state vector)
  |-- Sync Step 2 reply --->|  (client diff)
  |                          |
  |<== Updates (bidirectional) ==>|
```

### Document Persistence

- Y.js state stored as binary in `collaboration_documents.yjs_state`
- Vector clock stored as JSON for conflict detection
- **Save debounce**: 2 seconds after last update
- On disconnect, pending state is flushed immediately

### Connection Parameters

| Parameter | Value |
|-----------|-------|
| Auth timeout | 10 seconds |
| Heartbeat interval | 30 seconds |
| Rate limit | 120 messages per 10 seconds per connection |

---

## User Presence

- Tracked via Y.js awareness protocol and `user_presence` table
- Includes cursor position, selected text range, user name, and avatar
- **Activity window**: 5 minutes -- users inactive beyond this are considered offline
- Presence updated via `PUT /projects/:projectId/presence`
- Active users per document via `GET /projects/:projectId/sessions/:docType/:docId/users`

---

## Room Management

### Join/Leave Flow

1. Client connects to WebSocket with JWT + project ID + document info
2. Server authenticates, checks project access, joins client to Y.js room
3. Server broadcasts updated user list to all room participants
4. On disconnect: state flushed, user removed from room, broadcast updated list

### Heartbeat

- Server sends ping every 30 seconds
- Client must respond with pong
- Missing pong triggers disconnect and cleanup

### Cleanup

- Stale presence records (>5 min inactive) cleaned on room activity
- Empty rooms are garbage-collected after last client leaves
- Background cleanup runs every 5 minutes to remove empty rooms and prevent memory leaks

---

## Comments System

### Structure

- **Threaded 2-level** (Google Docs style): top-level comments + replies
- `parent_comment_id` links replies to parent comment (max 1 level deep, auto-flattened to root)
- Content types: `script`, `document`, `slide`
- Anchored to content via `content_type` + `content_id`
- For slides, `content_id` format is `"documentId:slideId"`

### Status

| Status | Meaning |
|--------|---------|
| `open` | Active discussion |
| `resolved` | Issue addressed |
| `dismissed` | Intentionally closed without action |

### Reactions

- Toggle-based: adding an existing reaction removes it
- Stored in `comment_reactions` (user_id + comment_id + emoji)

### Deletion

- **Soft delete**: `is_deleted = TRUE`, content preserved in DB
- Deleted comments hidden from UI but remain for audit
- Delete allowed by comment author or project owner

---

## Role-Based Access

### Roles (ascending privilege)

| Role | Description |
|------|-------------|
| `viewer` | Read-only access (free slot) |
| `editor` | Can edit content (paid slot) |
| `admin` | Can manage team + settings (paid slot) |
| `owner` | Full control, cannot be removed (project creator) |

### Permission Matrix

| Permission | Viewer | Editor | Admin | Owner |
|-----------|--------|--------|-------|-------|
| `can_edit_content` | No | Yes | Yes | Yes |
| `can_manage_characters` | No | Yes | Yes | Yes |
| `can_manage_locations` | No | Yes | Yes | Yes |
| `can_view_production` | No | No | Yes | Yes |
| `can_invite_others` | No | No | Yes | Yes |
| `can_manage_project` | No | No | No | Yes |

Permissions are stored per-collaborator in `project_collaborators.permissions` (JSONB) and can be customized beyond the role defaults.

---

## Invitation Workflow

```
Owner/Admin                 Backend                        Invitee
  |                           |                              |
  |-- POST .../invite ------->|                              |
  |   { email, role }        |-- Generate 32-byte token      |
  |                           |-- Store in collaboration_     |
  |                           |   invitations (7-day expiry)  |
  |                           |-- Send invitation email ----->|
  |<-- { invitation_id } ----|                              |
  |                           |                              |
  |                           |   GET /invitations/:token/   |
  |                           |<-- details ------------------|
  |                           |-- Return project + inviter   |
  |                           |   info (no auth required)    |
  |                           |                              |
  |                           |   POST /invitations/:token/  |
  |                           |<-- accept (auth required) ---|
  |                           |-- Add to project_            |
  |                           |   collaborators              |
  |                           |-- Mark invitation accepted   |
  |                           |                              |
```

**Key rules:**
1. Token is 32 bytes, cryptographically random
2. Invitations expire after 7 days
3. Viewing invitation details does NOT require auth (so email link works)
4. Accepting/declining DOES require auth (user must be logged in)
5. Duplicate invitations to same email for same project are rejected
6. Owner can revoke pending invitations via DELETE

---

## WebSocket Authentication

1. Client opens WebSocket to `/collaboration`
2. Client sends auth message with JWT within **10 seconds** (or connection is dropped)
3. Server validates JWT via Supabase, extracts user ID
4. Server checks `project_collaborators` or project ownership for access
5. Permission level determines what operations the client can perform (view-only vs edit)

---

## API Endpoints

### Collaboration Routes (`/api/collaboration`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/projects/:projectId/collaborators` | Yes + Pro | List project collaborators |
| POST | `/projects/:projectId/collaborators/invite` | Yes + Pro | Send invitation |
| GET | `/projects/:projectId/invitations` | Yes + Pro | List pending invitations |
| DELETE | `/projects/:projectId/invitations/:invitationId` | Yes + Pro | Revoke invitation |
| PUT | `/projects/:projectId/collaborators/:collaboratorId` | Yes + Pro | Update role/permissions |
| DELETE | `/projects/:projectId/collaborators/:collaboratorId` | Yes + Pro | Remove collaborator |
| POST | `/projects/:projectId/leave` | Yes | Leave project (self) |
| GET | `/user/pending-invitations` | Yes | List user's pending invitations |
| GET | `/invitations/:token/details` | No | View invitation details |
| POST | `/invitations/:token/accept` | Yes | Accept invitation |
| POST | `/invitations/:token/decline` | Yes | Decline invitation |
| POST | `/projects/:projectId/sessions` | Yes + Pro | Start collaboration session |
| GET | `/projects/:projectId/sessions/:docType/:docId/users` | Yes + Pro | Active users in session |
| PUT | `/projects/:projectId/presence` | Yes + Pro | Update presence |
| GET | `/projects/:projectId/activity` | Yes + Pro | Activity log |

### Comments Routes (`/api/comments`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:contentType/:contentId` | Yes + Paid | Get comments for content |
| GET | `/:contentType/:contentId/stats` | Yes + Paid | Comment count/stats (uses `get_comment_stats` RPC) |
| POST | `/` | Yes + Paid | Create comment or reply |
| PUT | `/:commentId` | Yes + Paid | Edit text (author only) or change status (author, editor, admin, owner) |
| DELETE | `/:commentId` | Yes + Paid | Soft delete comment (author or project owner) |
| POST | `/:commentId/reactions` | Yes + Paid | Toggle reaction |
| POST | `/:commentId/read` | Yes + Paid | Mark as read (upserts `comment_read_status`) |

### Public Share Routes (`/api/share`)

Public sharing allows project owners to create read-only shareable links. The public GET endpoint requires no authentication (token-based access). Management endpoints require auth + project ownership.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:token` | No (rate limited) | Fetch shared project data by token |
| POST | `/` | Yes (owner) | Create a new share link |
| GET | `/project/:projectId` | Yes (owner) | List all share links for a project |
| PATCH | `/:shareId` | Yes (owner) | Update share link (toggle active, change sections, set expiry) |
| DELETE | `/:shareId` | Yes (owner) | Permanently delete a share link (hard delete) |

**Share link features:**
- **Token**: 32 bytes (64 hex chars), cryptographically random
- **Shared sections**: configurable subset of `script`, `characters`, `locations`, `storyboard`
- **Password protection**: optional SHA-256 hashed password (sent via query param or `x-share-password` header)
- **Expiration**: optional `expires_at` timestamp
- **View tracking**: `view_count` and `last_viewed_at` updated on each public access
- **Rate limiting**: 30 requests/minute (IP-based for public, user-based for management)

---

## Common Gotchas

1. **Viewers are free, editors/admins are paid.** The collaborator limit from the subscription only counts editor and admin slots. Viewers don't consume paid slots.

2. **Invitation details endpoint is public.** `GET /invitations/:token/details` has no auth -- this is intentional so email links work before login. The token itself is the secret.

3. **Permissions can diverge from role defaults.** An admin can customize a collaborator's permissions beyond what the role template provides. Always check the `permissions` JSONB, not just the role string.

4. **WebSocket auth has a hard 10-second timeout.** If the client doesn't send a valid JWT within 10 seconds of connecting, the connection is dropped. This catches zombie connections.

5. **Y.js state is binary, not JSON.** The `collaboration_documents.yjs_state` column stores Y.js encoded state as binary. Don't try to read or manipulate it directly -- use Y.js library methods.

6. **Comments are soft-deleted.** `DELETE` on a comment sets `is_deleted = TRUE`. The record stays in the DB. Queries must filter `is_deleted = FALSE`.

7. **Save debounce is 2 seconds.** Document changes are batched and saved 2 seconds after the last edit. A hard save is triggered on disconnect. If the server crashes between the last edit and the save, up to 2 seconds of work can be lost.

8. **Rate limit is per-connection, not per-user.** A user with multiple tabs open gets 120 messages/10s per tab, not total.

9. **Public share links are hard-deleted.** Unlike comments (soft delete), `DELETE /api/share/:shareId` permanently removes the share record. The token becomes invalid immediately.

10. **Public share token is the secret.** The `GET /api/share/:token` endpoint has no auth. Anyone with the 64-char hex token can access the shared sections. Password protection is optional and adds a second layer.

11. **Comments require a paid plan, not specifically "Pro".** Access is checked via `pricingService.hasPaidPlan()`, which returns true for any paid subscription tier.
