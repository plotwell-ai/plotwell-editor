# plotwell Tools

Standalone tools, generators, fixtures, and shared media live here.

| Path | Purpose |
| --- | --- |
| `budget/` | Budget tool app |
| `scripts/` | Screenplay/scripts tool app |
| `storyboard/` | Storyboard tool app |
| `demo-recordings/` | Playwright demo recording automation |
| `generators/` | One-off asset/image generation scripts |
| `fixtures/screenplays/` | Sample screenplay files for demos and testing |
| `media/` | Shared generated media assets |

Run generator scripts from the repo root, for example:

```powershell
$env:REPLICATE_API_TOKEN="..."
node plotwell-tools/generators/generate-bg.mjs
```

Do not add new root-level `generate-*.mjs`, media folders, or script-only projects. Put them under this directory.
