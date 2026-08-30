import type { Metadata, Viewport } from "next";
import { getLocale, getMessages } from "next-intl/server";
import { notFound } from "next/navigation";
import StartView, {
  type StartCaseData,
  type StartData,
  type StartHero,
  type StartStep,
  type StartUi,
} from "@/components/StartView";
import { START_CASES, type StartChannel } from "../../../lib/start";

const DOCS_BASE = "https://docs.wolffi.sh";

interface StartCaseMessages {
  title: string;
  desc: string;
  time: string;
  cost: string;
  intro: string;
  steps?: StartStep[];
  outro?: string;
}

interface StartMessages {
  meta?: { title: string; description: string };
  ui: StartUi & { channels?: Partial<Record<StartChannel, string>> };
  hero: StartHero;
  shared?: Record<string, StartStep>;
  cases?: Record<string, StartCaseMessages>;
}

async function getStartMessages(): Promise<StartMessages | undefined> {
  const messages = await getMessages();
  return (messages as Record<string, unknown>).start as
    | StartMessages
    | undefined;
}

// The /start page is light, unlike the rest of the site.
export const viewport: Viewport = {
  themeColor: "#f7f8fa",
};

export async function generateMetadata(): Promise<Metadata> {
  const start = await getStartMessages();
  const locale = await getLocale();
  if (!start?.meta) return {};

  // The case count appears in titles via {count} so future additions
  // update the copy automatically.
  const count = String(START_CASES.length);
  const title = start.meta.title.replaceAll("{count}", count);
  const description = start.meta.description.replaceAll("{count}", count);
  return {
    title,
    description,
    alternates: { canonical: "https://wolffi.sh/start" },
    openGraph: {
      title,
      description,
      url: "https://wolffi.sh/start",
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

export default async function StartPage() {
  const locale = await getLocale();
  const start = await getStartMessages();
  if (!start) notFound();

  const shared = start.shared ?? {};
  const channels = start.ui.channels ?? {};
  // Arabic docs live under the same slugs with an /ar prefix.
  const docsPrefix = locale === "ar" ? "/ar" : "";

  const cases: StartCaseData[] = START_CASES.flatMap((cfg) => {
    const m = start.cases?.[cfg.id];
    if (!m) return [];

    const steps: StartStep[] = [
      ...cfg.pre.map((key) => shared[key]).filter(Boolean),
      ...(m.steps ?? []),
      ...cfg.post.map((key) => shared[key]).filter(Boolean),
    ];

    return [
      {
        id: cfg.id,
        icon: cfg.icon,
        title: m.title,
        desc: m.desc,
        time: m.time,
        cost: m.cost,
        channel: channels[cfg.channel],
        intro: m.intro,
        steps,
        outro: m.outro,
        docs: `${DOCS_BASE}${docsPrefix}${cfg.docs}`,
      },
    ];
  });

  const data: StartData = { ui: start.ui, hero: start.hero, cases };

  return (
    <main className="relative">
      <StartView data={data} locale={locale} />
    </main>
  );
}
