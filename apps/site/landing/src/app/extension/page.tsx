"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

export default function ExtensionPage() {
  const t = useTranslations("extension");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const switchLocale = (next: string) => {
    setLocaleCookie(next);
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center">
      <div className="fixed top-5 inset-x-0 z-20 flex items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors"
        >
          <svg className="w-3 h-3 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span className="font-medium">{t("home")}</span>
        </Link>
        <button
          onClick={() => switchLocale(locale === "en" ? "ar" : "en")}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all backdrop-blur-sm cursor-pointer"
        >
          {locale === "en" ? "عربي" : "EN"}
        </button>
      </div>
      <div className="flex flex-col items-center gap-4 text-center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" stroke="#22c55e" strokeWidth="2" />
          <path d="M7 12.5l3 3 7-7" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 className="text-xl font-semibold text-white">{t("title")}</h1>
        <p className="text-sm text-[#8b95a7]">{t("description")}</p>
      </div>
    </div>
  );
}
