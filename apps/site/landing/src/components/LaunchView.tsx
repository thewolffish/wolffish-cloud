"use client";

import Image from "next/image";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { FaApple, FaCheck, FaLinux, FaWindows } from "react-icons/fa6";
import VideoLinks from "@/components/VideoLinks";

const POINTS = [
  "local",
  "act",
  "brain",
  "markdown",
  "extensible",
  "nocloud",
] as const;

const PLATFORMS = [
  { key: "macos", Icon: FaApple },
  { key: "windows", Icon: FaWindows },
  { key: "linux", Icon: FaLinux },
] as const;

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

export default function LaunchView({ version }: { version: string | null }) {
  const t = useTranslations("launch");
  const td = useTranslations("download");
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
    <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
      {/* Language toggle — top end */}
      <div className="fixed top-5 inset-e-6 z-20">
        <button
          onClick={() => switchLocale(locale === "en" ? "ar" : "en")}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all backdrop-blur-sm cursor-pointer"
        >
          {locale === "en" ? "عربي" : "EN"}
        </button>
      </div>

      {/* Badge */}
      <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white/5 border border-white/10">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs text-white/70 font-medium">{t("badge")}</span>
        {version && (
          <>
            <span className="w-px h-3 bg-white/15" />
            <span dir="ltr" className="text-xs text-white/45 font-medium">
              v{version}
            </span>
          </>
        )}
      </div>

      {/* Logo */}
      <Image
        src="/icon_transparent.png"
        alt="Wolffish logo"
        width={96}
        height={96}
        className="mt-6 w-12 h-12 md:w-16 md:h-16 drop-shadow-[0_0_40px_rgba(40,80,180,0.4)]"
        priority
      />

      {/* Title */}
      <h1
        className="mt-4 text-4xl md:text-6xl font-bold text-white tracking-tight"
        style={{
          textShadow: "0 0 80px rgba(40,80,180,0.3), 0 2px 30px rgba(0,0,0,0.5)",
        }}
      >
        {t("title")}
      </h1>

      {/* Subtitle */}
      <p className="mt-4 max-w-xl text-sm md:text-base text-white/60 font-light leading-relaxed">
        {t("subtitle")}
      </p>

      {/* Video links */}
      <VideoLinks className="mt-5" />

      {/* Supported platforms */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
        {PLATFORMS.map(({ key, Icon }) => (
          <div
            key={key}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/8"
          >
            <Icon className="w-4 h-4 text-white/55" />
            <span className="text-[13px] text-white/70 font-medium">{td(key)}</span>
          </div>
        ))}
      </div>

      {/* Why Wolffish — 6 points: items left-aligned, block centered */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 w-fit mx-auto text-start">
        {POINTS.map((key) => (
          <div key={key} className="flex items-center gap-3">
            <FaCheck className="w-3 h-3 text-emerald-400 shrink-0" />
            <span className="text-sm text-white/75">{t(`points.${key}`)}</span>
          </div>
        ))}
      </div>

      {/* CTA */}
      <Link
        href="/"
        className="mt-10 group inline-flex items-center gap-2.5 px-6 py-3 rounded-full bg-white text-[#040a18] font-semibold text-sm hover:bg-white/90 transition-all shadow-[0_0_40px_rgba(255,255,255,0.15)]"
      >
        {t("cta")}
        <span
          dir="ltr"
          className="px-2.5 py-1 rounded-full bg-[#040a18]/8 border border-[#040a18]/10 font-mono text-xs font-semibold group-hover:bg-[#040a18]/12 transition-colors"
        >
          wolffi.sh
        </span>
      </Link>
    </div>
  );
}
