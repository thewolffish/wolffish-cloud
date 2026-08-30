import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { getLegalDoc } from "../../../lib/legal";
import LegalArticle from "@/components/LegalArticle";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const doc = getLegalDoc("privacy", locale);

  if (!doc) return {};

  const title = `${doc.title} — Wolffish`;
  return {
    title,
    description: doc.description,
    alternates: { canonical: "https://wolffi.sh/privacy" },
    openGraph: {
      title,
      description: doc.description,
      url: "https://wolffi.sh/privacy",
      siteName: "Wolffish",
      type: "article",
      images: [{ url: "https://cdn.wolffi.sh/generic/banner.jpg", width: 2540, height: 1520 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: doc.description,
      images: ["https://cdn.wolffi.sh/generic/banner.jpg"],
    },
  };
}

export default async function PrivacyPage() {
  const locale = await getLocale();
  const doc = getLegalDoc("privacy", locale);

  if (!doc) notFound();

  const lastUpdated = new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en-US", {
    dateStyle: "long",
  }).format(new Date(doc.date));

  return (
    <main className="relative">
      <LegalArticle doc={doc} lastUpdated={lastUpdated} />
    </main>
  );
}
