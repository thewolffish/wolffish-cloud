import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { Analytics } from "@vercel/analytics/next";
import OceanSceneClient from "@/components/OceanSceneClient";
import "./globals.css";

const ibmPlexSansArabic = localFont({
  src: [
    {
      path: "../../public/fonts/IBMPlexSansArabic-Light.ttf",
      weight: "300",
      style: "normal",
    },
    {
      path: "../../public/fonts/IBMPlexSansArabic-Regular.ttf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../public/fonts/IBMPlexSansArabic-Medium.ttf",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../public/fonts/IBMPlexSansArabic-SemiBold.ttf",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../public/fonts/IBMPlexSansArabic-Bold.ttf",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
  fallback: ["system-ui", "-apple-system", "sans-serif"],
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();

  const title =
    locale === "ar"
      ? "وولف فيش: وكيل الذكاء الاصطناعي الشخصي للجميع"
      : "Wolffish: The Personal AI Agent For Everyone";
  const description =
    locale === "ar"
      ? "وكيل ذكي يعمل على جهازك مباشرة. يفكّر، يُنفّذ، ويتفاعل مع ملفاتك وأدواتك. بلا سحابة. بلا حدود."
      : "A desktop agent with full access to your machine. Automate, create, and execute — entirely local. No cloud required.";

  return {
    title,
    description,
    icons: {
      icon: "https://cdn.wolffi.sh/generic/icon.png",
      apple: "https://cdn.wolffi.sh/generic/icon.png",
    },
    openGraph: {
      title,
      description,
      url: "https://wolffi.sh",
      siteName: "Wolffish",
      images: [
        {
          url: "https://cdn.wolffi.sh/generic/banner.jpg",
          width: 2540,
          height: 1520,
          alt: "Wolffish",
        },
      ],
      locale: locale === "ar" ? "ar_SA" : "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["https://cdn.wolffi.sh/generic/banner.jpg"],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#040a18",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  // The /start and /blog namespaces are consumed server-side by their routes
  // only — keep them out of the client messages shipped with every page.
  const clientMessages = Object.fromEntries(
    Object.entries(messages).filter(([key]) => key !== "start" && key !== "blog")
  ) as typeof messages;

  // Site-wide structured data for search engines and AI crawlers.
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://wolffi.sh/#organization",
        name: "Wolffish",
        url: "https://wolffi.sh",
        logo: "https://cdn.wolffi.sh/generic/icon.png",
        sameAs: [
          "https://github.com/thewolffish/wolffish-app",
          "https://discord.gg/zWJpD3SgTt",
          "https://x.com/younesbites",
          "https://www.youtube.com/@younesbites",
          "https://apps.apple.com/us/app/wolffish/id6792797989",
          "https://play.google.com/store/apps/details?id=sh.wolffi.mobile",
        ],
      },
      {
        "@type": "WebSite",
        "@id": "https://wolffi.sh/#website",
        name: "Wolffish",
        url: "https://wolffi.sh",
        publisher: { "@id": "https://wolffi.sh/#organization" },
        inLanguage: ["en", "ar"],
      },
    ],
  };

  return (
    <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} className={ibmPlexSansArabic.className}>
      <body className="bg-[#040a18]">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <NextIntlClientProvider messages={clientMessages}>
          <OceanSceneClient />
          {children}
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
