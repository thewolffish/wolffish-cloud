"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

export default function NotFound() {
  const t = useTranslations("notFound");
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
    <main className="relative z-10 flex min-h-screen flex-col">
      {/* Top bar: home (back) + language toggle */}
      <div className="fixed top-5 inset-x-0 z-20 flex items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors"
        >
          <svg
            className="w-3 h-3 rtl:rotate-180"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
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

      {/* Center column */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {/* Missing-page icon — a warning triangle */}
        <div className="flex items-center justify-center w-20 h-20 rounded-2xl backdrop-blur-md bg-amber-400/5 border border-amber-400/15">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-amber-400 drop-shadow-[0_0_24px_rgba(251,191,36,0.45)]"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13.5" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        {/* 404 */}
        <div
          className="mt-8 text-7xl md:text-8xl font-bold tracking-tight text-white"
          style={{
            textShadow:
              "0 0 80px rgba(40,80,180,0.35), 0 2px 30px rgba(0,0,0,0.5)",
          }}
        >
          404
        </div>

        <h1 className="mt-4 text-xl md:text-2xl font-semibold text-white">
          {t("title")}
        </h1>

        <p className="mt-3 text-sm md:text-base text-white/50 max-w-md leading-relaxed">
          {t("description")}
        </p>
      </div>
    </main>
  );
}
