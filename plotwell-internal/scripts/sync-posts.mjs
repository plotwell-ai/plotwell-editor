#!/usr/bin/env node
/**
 * Reads blog post frontmatter from plotwell-landing/content/blog/
 * and updates the EXISTING_POSTS array in shared/content/index.ts.
 *
 * Usage: node scripts/sync-posts.mjs
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, "../../plotwell-landing/src/blog/content");
const CONTENT_FILE = join(__dirname, "../shared/content/index.ts");

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    // Remove quotes
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    // Parse arrays
    if (val.startsWith("[")) {
      try { val = JSON.parse(val); } catch { /* keep as string */ }
    }
    fm[key] = val;
  }
  return fm;
}

async function main() {
  const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith(".md"));
  const posts = [];

  for (const file of files) {
    const content = await readFile(join(BLOG_DIR, file), "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm || !fm.slug) continue;

    posts.push({
      slug: fm.slug,
      title: fm.title || "",
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      lang: fm.lang || "en",
      date: fm.date || "",
      description: fm.description || "",
    });
  }

  // Sort by date desc
  posts.sort((a, b) => b.date.localeCompare(a.date));

  // Read current content file
  let ts = await readFile(CONTENT_FILE, "utf-8");

  // Replace the EXISTING_POSTS array
  const postsStr = posts
    .map(
      (p) =>
        `  { slug: ${JSON.stringify(p.slug)}, title: ${JSON.stringify(p.title)}, tags: ${JSON.stringify(p.tags)}, lang: ${JSON.stringify(p.lang)}, date: ${JSON.stringify(p.date)}, description: ${JSON.stringify(p.description)} }`
    )
    .join(",\n");

  const newArray = `const EXISTING_POSTS: ExistingPost[] = [\n${postsStr},\n];`;
  ts = ts.replace(
    /const EXISTING_POSTS: ExistingPost\[\] = \[[\s\S]*?\];/,
    newArray
  );

  await writeFile(CONTENT_FILE, ts, "utf-8");
  console.log(`Synced ${posts.length} posts (${posts.filter((p) => p.lang === "en").length} EN, ${posts.filter((p) => p.lang === "es").length} ES)`);
}

main().catch(console.error);
