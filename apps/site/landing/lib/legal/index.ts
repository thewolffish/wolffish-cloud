import fs from "fs";
import path from "path";

export interface LegalDoc {
  slug: string;
  title: string;
  description: string;
  date: string;
  content: string;
}

const LEGAL_DIR = path.join(process.cwd(), "lib", "legal");

function parseFrontmatter(raw: string): {
  meta: Omit<LegalDoc, "slug" | "content">;
  content: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: { title: "", description: "", date: "" }, content: raw };

  const block = match[1];
  const content = match[2];

  const get = (key: string) =>
    block.match(new RegExp(`^${key}:\\s*['"]?(.+?)['"]?\\s*$`, "m"))?.[1] ?? "";

  return {
    meta: { title: get("title"), description: get("description"), date: get("date") },
    content,
  };
}

export function getLegalDoc(slug: string, locale: string): LegalDoc | null {
  const file = path.join(LEGAL_DIR, slug, `${locale}.md`);
  if (!fs.existsSync(file)) return null;
  const { meta, content } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
  if (!meta.title) return null;
  return { slug, ...meta, content };
}
