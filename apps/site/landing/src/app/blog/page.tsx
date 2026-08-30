import type { Metadata, Viewport } from "next";
import { getLocale, getMessages } from "next-intl/server";
import BlogIndex, {
  type BlogCardData,
  type BlogIndexData,
  type BlogIndexUi,
} from "@/components/BlogIndex";
import { BLOG_CATEGORIES, getBlogPosts, relativeDate } from "../../../lib/blog";

const SITE_URL = "https://wolffi.sh";

// Used only if the locale messages are missing the blog block entirely.
const START_CARD_FALLBACK = {
  title: "Get started in minutes",
  body: "Every guide on the start page is a complete recipe — from installing Wolffish to your first real result.",
  cta: "Start here",
};

interface BlogMessages {
  meta: { title: string; description: string };
  ui: BlogIndexUi & { categories: Record<string, string> };
}

async function getBlogMessages(): Promise<BlogMessages | undefined> {
  const messages = await getMessages();
  return (messages as Record<string, unknown>).blog as BlogMessages | undefined;
}

export const viewport: Viewport = {
  themeColor: "#f7f8fa",
};

export async function generateMetadata(): Promise<Metadata> {
  const blog = await getBlogMessages();
  const locale = await getLocale();
  if (!blog?.meta) return {};

  const { title, description } = blog.meta;
  return {
    title,
    description,
    alternates: {
      canonical: `${SITE_URL}/blog`,
      types: { "application/rss+xml": `${SITE_URL}/blog/feed.xml` },
    },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/blog`,
      siteName: "Wolffish",
      type: "website",
      images: [
        {
          url: "https://cdn.wolffi.sh/generic/banner.jpg",
          width: 2540,
          height: 1520,
          alt: "Wolffish",
        },
      ],
      locale: locale === "ar" ? "ar_SA" : "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["https://cdn.wolffi.sh/generic/banner.jpg"],
    },
  };
}

export default async function BlogPage() {
  const locale = await getLocale();
  const blog = await getBlogMessages();
  const labels = blog?.ui.categories ?? {};

  const dateFormat = new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en-US", {
    dateStyle: "long",
  });

  const allPosts = getBlogPosts(locale);
  const posts: BlogCardData[] = allPosts.map((post) => ({
    slug: post.slug,
    title: post.title,
    description: post.description,
    dateFormatted: dateFormat.format(new Date(post.date)),
    dateRelative: relativeDate(post.date, locale),
    categories: post.categories.map((key) => ({ key, label: labels[key] ?? key })),
    image: post.image,
  }));

  // Only offer filters for categories that actually occur, in canonical order.
  const categories = BLOG_CATEGORIES.map((key) => ({
    key,
    label: labels[key] ?? key,
    count: allPosts.filter((post) => post.categories.includes(key)).length,
  })).filter((cat) => cat.count > 0);

  const data: BlogIndexData = {
    ui: blog?.ui ?? {
      home: "Home",
      title: "Blog",
      lead: "",
      all: "All",
      docs: "Docs",
      github: "GitHub",
      discord: "Discord",
      start: START_CARD_FALLBACK,
    },
    posts,
    categories,
  };

  // Structured data: the blog as an ItemList of posts.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: blog?.meta.title ?? "Wolffish Blog",
    description: blog?.meta.description ?? "",
    url: `${SITE_URL}/blog`,
    inLanguage: locale === "ar" ? "ar" : "en",
    publisher: {
      "@type": "Organization",
      name: "Wolffish",
      url: SITE_URL,
      logo: "https://cdn.wolffi.sh/generic/icon.png",
    },
    blogPost: posts.slice(0, 20).map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      url: `${SITE_URL}/blog/${post.slug}`,
    })),
  };

  return (
    <main className="relative">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <BlogIndex data={data} locale={locale} />
    </main>
  );
}
