/**
 * Migration script: Convert all script content from TipTap format to ProseMirror format.
 *
 * Usage:
 *   npx ts-node src/scripts/migrateTiptapToProsemirror.ts [--dry-run]
 *
 * Tables migrated:
 *   - scripts.content
 *   - script_versions.content
 *   - ai_generated_scenes.content
 */

import { createClient } from "@supabase/supabase-js";
import { detectFormat, convertTiptapToProsemirror } from "../utils/formatDetection";
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const DRY_RUN = process.argv.includes("--dry-run");
const PAGE_SIZE = 100;

interface MigrationStats {
  total: number;
  converted: number;
  alreadyProsemirror: number;
  empty: number;
  errors: number;
}

async function migrateTable(
  table: string,
  contentField: string = "content"
): Promise<MigrationStats> {
  const stats: MigrationStats = { total: 0, converted: 0, alreadyProsemirror: 0, empty: 0, errors: 0 };
  let offset = 0;
  let hasMore = true;

  if (DEBUG_AI) console.log(`\n📦 Migrating ${table}.${contentField}...`);

  while (hasMore) {
    const { data: rows, error } = await (supabase as any)
      .from(table)
      .select(`id, ${contentField}`)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error(`❌ Error querying ${table}:`, error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of rows) {
      stats.total++;
      const content = row[contentField];

      if (!content || typeof content !== "object") {
        stats.empty++;
        continue;
      }

      const format = detectFormat(content);

      if (format === "prosemirror") {
        stats.alreadyProsemirror++;
        continue;
      }

      if (format === "tiptap") {
        try {
          const converted = convertTiptapToProsemirror(content);

          if (!DRY_RUN) {
            const { error: updateError } = await (supabase as any)
              .from(table)
              .update({ [contentField]: converted })
              .eq("id", row.id);

            if (updateError) {
              console.error(`❌ Error updating ${table} id=${row.id}:`, updateError.message);
              stats.errors++;
              continue;
            }
          }

          stats.converted++;
        } catch (err) {
          console.error(`❌ Error converting ${table} id=${row.id}:`, err);
          stats.errors++;
        }
      } else {
        // Unknown format - skip
        stats.empty++;
      }
    }

    offset += PAGE_SIZE;
    if (rows.length < PAGE_SIZE) hasMore = false;

    // Progress update every page
    if (stats.total % (PAGE_SIZE * 5) === 0) {
      if (DEBUG_AI) console.log(`  ... processed ${stats.total} rows`);
    }
  }

  return stats;
}

function printStats(table: string, stats: MigrationStats) {
  if (DEBUG_AI) console.log(`\n📊 ${table} results:`);
  if (DEBUG_AI) console.log(`  Total rows:     ${stats.total}`);
  if (DEBUG_AI) console.log(`  Converted:      ${stats.converted}`);
  if (DEBUG_AI) console.log(`  Already PM:     ${stats.alreadyProsemirror}`);
  if (DEBUG_AI) console.log(`  Empty/unknown:  ${stats.empty}`);
  if (DEBUG_AI) console.log(`  Errors:         ${stats.errors}`);
}

async function main() {
  if (DEBUG_AI) console.log("🚀 TipTap -> ProseMirror Migration");
  if (DEBUG_AI) console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  if (DEBUG_AI) console.log("---");

  const scriptsStats = await migrateTable("scripts");
  printStats("scripts", scriptsStats);

  const versionsStats = await migrateTable("script_versions");
  printStats("script_versions", versionsStats);

  const scenesStats = await migrateTable("ai_generated_scenes");
  printStats("ai_generated_scenes", scenesStats);

  const totalConverted = scriptsStats.converted + versionsStats.converted + scenesStats.converted;
  const totalErrors = scriptsStats.errors + versionsStats.errors + scenesStats.errors;

  if (DEBUG_AI) console.log("\n---");
  if (DEBUG_AI) console.log(`✅ Migration complete. ${totalConverted} rows converted, ${totalErrors} errors.`);
  if (DRY_RUN) {
    if (DEBUG_AI) console.log("⚠️  This was a dry run. No data was modified.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
