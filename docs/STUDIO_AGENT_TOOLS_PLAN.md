# Studio Agent Tools Plan

## Goal

Make Studio agents match the main UI capabilities while keeping destructive or high-risk actions behind explicit user approval.

## Permission Model

### Autonomous

The agent may run these without asking again when the user request is clear:

- Read project context, documents, characters, locations, seasons, episodes, scripts, scene outlines, and scene content.
- Create requested story entities: documents, characters, locations, episodes, seasons, beats.
- Update blank or clearly targeted episodes with title, synopsis, runtime, or status.
- Update a currently open document when the user asks to revise, improve, rewrite, or expand it.
- Insert a new scene when the user explicitly asks to write or add a scene.
- Update non-destructive metadata such as a season title, episode title, synopsis, or status when the target is unambiguous.

### Approval Required

The agent must ask before:

- Deleting anything: seasons, episodes, documents, characters, locations, beats, scenes, production assets.
- Rewriting or replacing substantial existing content unless the user explicitly named the target and requested replacement.
- Renumbering seasons or episodes when that changes existing order.
- Merging or deduplicating entities when one record will be deleted or overwritten.
- Updating multiple non-empty episodes/documents/scenes in one turn unless the user explicitly requested a batch rewrite.

### Must Clarify

The agent must ask a focused question when:

- The target entity is ambiguous.
- The project is a series and the user asks for episode-level beats without an episode target.
- The user asks for "episodes" but the season is unclear and more than one season exists.
- The requested change conflicts with existing non-empty content.

## Implementation Checklist

### Series Structure

- [x] Add `create_episode` and `update_episode` tools that update existing blank episodes instead of creating duplicate beats.
- [x] Add `get_series_structure` tool for seasons + episodes context.
- [x] Add `create_or_update_season` tool.
- [x] Add `delete_episode` with approval.
- [x] Add `delete_season` with approval.
- [x] Emit/handle season and episode update events consistently in the UI.

### Project Type Conversion

- [x] Detect film/series intent mismatch before running creative tools.
- [x] Ask for conversion instead of creating fallback entities when a film project receives a series request.
- [x] Add `change_project_type` with approval.
- [x] Convert film to series by creating Season 1, Episode 1, and linking/creating an episode script.
- [x] Convert simple series back to film without deleting seasons/episodes.
- [x] Emit/handle project type update events in the UI.

### Beats

- [x] Add episode-aware beat saving (`episode_id` or season/episode target).
- [x] Add `update_beat`.
- [x] Add `delete_beat` with approval.
- [x] Harden prompts so whole episodes are never saved as beats.

### Documents

- [x] Existing Develop tools can create and update documents.
- [x] Add `get_documents` to Develop.
- [x] Add `delete_document` with approval.
- [x] Add duplicate-safe document creation/update by type and title.

### Characters And Locations

- [x] Existing Develop tools can create locations.
- [x] Existing Develop tools can update/delete locations.
- [x] Existing Write tools can create characters and locations.
- [x] Add `get_characters` and `get_locations` to Develop.
- [x] Add `update_character` to Develop.
- [x] Add `delete_character` with approval.

### Script And Scenes

- [x] Existing Write tools can read script outline and scene content.
- [x] Existing Write tools can write, rewrite, and delete scenes.
- [x] Refine approval rules so low-risk explicit scene insertion can be autonomous, while delete/rewrite stays protected.
- [x] Verify all scene operations respect selected `episodeId`.

### Approval Infrastructure

- [x] Write phase has tool approval flow.
- [x] Extract shared approval helpers for Develop/Write/Produce.
- [x] Add approval flow to Develop destructive tools.
- [x] Add approval persistence rules for session/always where appropriate.

### Verification

- [x] Backend build passes.
- [x] Frontend build passes.
- [x] Add targeted tests for series upsert and approval-gated deletes.

## Notes

- The immediate bug was caused by missing episode/season tools in Develop. The agent saved episode premises as project-level beats because beats were the closest available write tool.
- The preferred behavior for series is: read existing series structure, update blank episodes by number, create only missing episodes, and reserve beats for structure inside a film or specific episode.
