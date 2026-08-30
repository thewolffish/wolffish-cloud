"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { FaArrowLeft } from "react-icons/fa6";
import type { LegalDoc } from "../../lib/legal";
import Markdown from "./Markdown";

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

export default function LegalArticle({
  doc,
  lastUpdated,
}: {
  doc: LegalDoc;
  lastUpdated: string;
}) {
  const t = useTranslations("legal");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const switchLocale = (next: string) => {
    setLocaleCookie(next);
    startTransition(() => router.refresh());
  };

  return (
    <div className="relative z-10 min-h-screen flex flex-col">
      {/* Top bar: home (back) + language toggle */}
      <div className="fixed top-5 inset-x-0 z-20 flex items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors"
        >
          <FaArrowLeft className="w-3 h-3 rtl:rotate-180" />
          <span className="font-medium">{t("home")}</span>
        </Link>
        <button
          onClick={() => switchLocale(locale === "en" ? "ar" : "en")}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all backdrop-blur-sm cursor-pointer"
        >
          {locale === "en" ? "عربي" : "EN"}
        </button>
      </div>

      {/* Document */}
      <div className="flex-1 flex flex-col items-center px-6 pt-24 pb-16">
        <article className="w-full max-w-2xl">
          <h1 className="text-3xl md:text-4xl font-bold text-white">{doc.title}</h1>
          <p className="mt-2 mb-8 text-sm text-white/40">
            {t("lastUpdated")}: {lastUpdated}
          </p>
          <Markdown content={doc.content} />
        </article>
      </div>
    </div>
  );
}
