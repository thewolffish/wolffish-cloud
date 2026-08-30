import fs from "fs";
import path from "path";

// Category buckets — generic groupings, not per-topic tags. Card chips and the
// filter row derive their labels from messages `blog.ui.categories.<key>`.
export const BLOG_CATEGORIES = [
  "news",
  "product",
  "guides",
  "market",
  "community",
] as const;
export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

// Every post carries an author; when the frontmatter doesn't say otherwise,
// it's Younes. The avatar renders as the circular byline image.
export const DEFAULT_AUTHOR = "Younes Alturkey";
export const DEFAULT_AUTHOR_IMAGE = "https://cdn.wolffi.sh/generic/younes.jpeg";

export interface BlogPostMeta {
  slug: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD) from frontmatter. */
  date: string;
  categories: BlogCategory[];
  /** SEO keywords from frontmatter — meta keywords + structured data. */
  keywords: string[];
  author: string;
  authorImage: string;
  /** Social/OG image (1200×630) — also the card and article hero. */
  image?: string;
}

export interface BlogPost extends BlogPostMeta {
  content: string;
}

const BLOG_DIR = path.join(process.cwd(), "content", "blog");
const DEFAULT_LOCALE = "en";

function parseFrontmatter(raw: string): {
  fields: Record<string, string>;
  content: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { fields: {}, content: raw };

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)\s*$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
  }
  return { fields, content: match[2] };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseCategories(value: string | undefined): BlogCategory[] {
  return parseList(value)
    .map((c) => c.toLowerCase())
    .filter((c): c is BlogCategory =>
      (BLOG_CATEGORIES as readonly string[]).includes(c)
    );
}

function readPost(slug: string, locale: string): BlogPost | null {
  const file = path.join(BLOG_DIR, locale, `${slug}.md`);
  if (!fs.existsSync(file)) return null;

  const { fields, content } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
  if (!fields.title || !fields.date) return null;

  return {
    slug,
    title: fields.title,
    description: fields.description ?? "",
    date: fields.date,
    categories: parseCategories(fields.categories),
    keywords: parseList(fields.keywords),
    author: fields.author || DEFAULT_AUTHOR,
    authorImage: fields.authorImage || DEFAULT_AUTHOR_IMAGE,
    image: fields.image || undefined,
    content,
  };
}

/** Union of slugs across locales, so a post missing one translation still lists. */
export function getBlogSlugs(): string[] {
  const slugs = new Set<string>();
  for (const locale of ["en", "ar"]) {
    const dir = path.join(BLOG_DIR, locale);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".md")) slugs.add(file.replace(/\.md$/, ""));
    }
  }
  return [...slugs];
}

/** Post in the requested locale, falling back to English when untranslated. */
export function getBlogPost(slug: string, locale: string): BlogPost | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return readPost(slug, locale) ?? readPost(slug, DEFAULT_LOCALE);
}

/** Whole days from today to the given date (negative = in the past). */
export function daysFromToday(date: string): number {
  return Math.round((new Date(date).getTime() - Date.now()) / 86_400_000);
}

/** "3 days ago" / "last month" — computed at request time, in the page locale. */
export function relativeDate(date: string, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale === "ar" ? "ar" : "en-US", {
    numeric: "auto",
  });
  const days = daysFromToday(date);
  const abs = Math.abs(days);
  if (abs < 7) return format.format(days, "day");
  if (abs < 30) return format.format(Math.round(days / 7), "week");
  if (abs < 365) return format.format(Math.round(days / 30), "month");
  return format.format(Math.round(days / 365), "year");
}

/** All posts for a locale, newest first. */
export function getBlogPosts(locale: string): BlogPost[] {
  return getBlogSlugs()
    .map((slug) => getBlogPost(slug, locale))
    .filter((post): post is BlogPost => post !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
}
