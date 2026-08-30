import type { MetadataRoute } from "next";
import { getBlogPosts } from "../../lib/blog";

const SITE_URL = "https://wolffi.sh";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getBlogPosts("en");
  const newestPost = posts[0]?.date;

  return [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/start`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/blog`,
      lastModified: newestPost ? new Date(newestPost) : undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...posts.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: new Date(post.date),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly" as const, priority: 0.2 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly" as const, priority: 0.2 },
  ];
}
