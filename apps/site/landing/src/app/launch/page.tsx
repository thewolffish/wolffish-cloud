import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import LaunchView from "@/components/LaunchView";

const RELEASE_BASE = "https://releases.wolffi.sh";

// Mirrors the version lookup in the home page — only the version is needed here.
async function fetchVersion(): Promise<string | null> {
  try {
    const files = await Promise.all(
      ["latest-mac.yml", "latest.yml", "latest-linux.yml"].map((f) =>
        fetch(`${RELEASE_BASE}/${f}`, { cache: "no-store" }).then((r) => r.text())
      )
    );
    for (const text of files) {
      const v = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
      if (v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const title = locale === "ar" ? "انطلق وولف فيش" : "Wolffish is live";
  const description =
    locale === "ar"
      ? "وولف فيش — وكيل الذكاء الاصطناعي الشخصي المحلي — متوفّر الآن لأنظمة ماك وويندوز ولينكس."
      : "Wolffish — your local-first personal AI agent — is now available for macOS, Windows, and Linux.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: "https://wolffi.sh/launch",
      siteName: "Wolffish",
      type: "website",
      images: [
        { url: "https://cdn.wolffi.sh/generic/banner.jpg", width: 2540, height: 1520 },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["https://cdn.wolffi.sh/generic/banner.jpg"],
    },
  };
}

export default async function LaunchPage() {
  const version = await fetchVersion();

  return (
    <main className="relative">
      <LaunchView version={version} />
    </main>
  );
}
