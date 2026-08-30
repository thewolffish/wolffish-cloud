"use client";

import Image from "next/image";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useState, useSyncExternalStore, useTransition } from "react";
import {
  FaAndroid,
  FaApple,
  FaArrowRight,
  FaBook,
  FaCheck,
  FaCopy,
  FaDiscord,
  FaEnvelope,
  FaFileContract,
  FaGithub,
  FaLinux,
  FaNewspaper,
  FaShieldHalved,
  FaTerminal,
  FaWandMagicSparkles,
  FaWhatsapp,
  FaWindows,
  FaXTwitter,
  FaYoutube,
} from "react-icons/fa6";
import VideoLinks from "@/components/VideoLinks";

interface ReleaseFile {
  url: string;
  filename: string;
}

interface ReleaseInfo {
  version: string;
  files: {
    macos: ReleaseFile;
    windows: ReleaseFile;
    linux: { deb?: ReleaseFile; rpm?: ReleaseFile; appimage?: ReleaseFile };
  };
}

function getClientOS(): string | null {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
  return null;
}
const noopSubscribe = () => () => {};
const serverOS = () => null;

const LINUX_TAGS = [
  { key: "deb", label: ".deb" },
  { key: "rpm", label: ".rpm" },
  { key: "appimage", label: ".AppImage" },
] as const;

// WhatsApp footer link is omitted for now; flip to true to bring it back.
const SHOW_WHATSAPP = false;

const stripExt = (filename: string) =>
  filename.replace(/\.(AppImage|deb|rpm)$/, "");

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

export default function LandingOverlay({ release }: { release: ReleaseInfo | null }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const userOS = useSyncExternalStore(noopSubscribe, getClientOS, serverOS);

  const switchLocale = (locale: string) => {
    setLocaleCookie(locale);
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="relative z-10 min-h-screen flex flex-col pointer-events-none">
      {/* Language toggle — top right */}
      <div className="fixed top-5 inset-e-6 pointer-events-auto z-20">
        <button
          onClick={() => switchLocale(locale === "en" ? "ar" : "en")}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all backdrop-blur-sm cursor-pointer"
        >
          {locale === "en" ? "عربي" : "EN"}
        </button>
      </div>

      {/* ── Center column ── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16 md:py-0">
        {/* Title + Version */}
        <div className="flex items-center gap-2.5 md:gap-4">
          <Image
            src="/icon_transparent.png"
            alt="Wolffish logo"
            width={96}
            height={96}
            className="w-12 h-12 md:w-16 md:h-16 drop-shadow-[0_0_40px_rgba(40,80,180,0.4)]"
            priority
          />
          <h1
            className="text-4xl md:text-7xl font-bold text-white tracking-tight"
            style={{
              textShadow:
                "0 0 80px rgba(40,80,180,0.3), 0 2px 30px rgba(0,0,0,0.5)",
            }}
          >
            {t("hero.name")}
          </h1>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/4 border border-white/6 self-center">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-white/60 font-medium">
              {release ? `v${release.version}` : t("hero.version")}
            </span>
          </div>
        </div>

        <p className="mt-4 text-sm md:text-lg text-white/80 font-light tracking-wide">
          {t("hero.tagline")}
        </p>

        <p className="mt-2 text-xs md:text-[13px] text-white/50 max-w-xl text-center leading-relaxed">
          {t("hero.subtitle")}
        </p>

        {/* Cinematic reveal & demo walkthrough */}
        <VideoLinks className="mt-5 pointer-events-auto" />

        {/* Features */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-5xl">
          {(["local", "brain", "extensible"] as const).map((key) => (
            <div
              key={key}
              className="backdrop-blur-md bg-white/5 border border-white/8 rounded-2xl px-5 py-4 text-center"
            >
              <div className="text-[11px] font-semibold text-white/90 mb-1.5">
                {t(`features.${key}`)}
              </div>
              <div className="text-[11px] text-white/50 leading-relaxed">
                {t(`features.${key}Desc`)}
              </div>
            </div>
          ))}
        </div>

        {/* Install commands */}
        <InstallCommands />

        {/* Phone app — the stores, in the same shape as the commands above */}
        <StoreLinks />

        {/* Downloads — same max-w-5xl grid as features */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-5xl pointer-events-auto">
          {(
            [
              { os: "macos", Icon: FaApple },
              { os: "windows", Icon: FaWindows },
              { os: "linux", Icon: FaLinux },
            ] as const
          ).map(({ os, Icon }) => {
            const match = userOS === os;
            const dimmed = userOS !== null && !match;

            const badge = match && (
              <span className="absolute top-2.5 inset-e-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/30">
                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                <span className="text-[8px] text-emerald-300 font-medium">
                  {t("download.compatible")}
                </span>
              </span>
            );
            const label = (
              <div className="text-[10px] text-white/40 uppercase tracking-wider font-medium">
                {t(`download.${os}`)}
              </div>
            );

            // Linux ships three installers — the card itself isn't clickable;
            // each format is a small tag that downloads its specific installer.
            if (os === "linux") {
              const linuxFiles = release?.files.linux;
              const name = stripExt(
                (linuxFiles?.appimage ?? linuxFiles?.deb ?? linuxFiles?.rpm)
                  ?.filename ?? t("download.linuxFile")
              );
              return (
                <div
                  key={os}
                  className={`relative flex items-center gap-3 px-5 py-3.5 rounded-2xl backdrop-blur-md transition-all ${
                    dimmed
                      ? "bg-white/3 border border-white/5 opacity-50"
                      : "bg-white/6 border border-white/8"
                  }`}
                >
                  {badge}
                  <Icon
                    className={`w-5 h-5 ${dimmed ? "text-white/30" : "text-white/50"}`}
                  />
                  <div className="text-start min-w-0">
                    {label}
                    <div className="text-xs text-white font-medium mt-0.5">
                      {name}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {LINUX_TAGS.map(({ key, label }) => {
                        const file = release?.files.linux[key];
                        return file ? (
                          <a
                            key={key}
                            href={file.url}
                            dir="ltr"
                            className="px-2 py-0.5 rounded-md text-[10px] leading-none font-medium bg-white/8 border border-white/10 text-white/70 hover:bg-white/16 hover:text-white hover:border-white/20 transition-colors"
                          >
                            {label}
                          </a>
                        ) : null;
                      })}
                    </div>
                  </div>
                </div>
              );
            }

            const file = release?.files[os];
            return (
              <a
                key={os}
                href={file?.url ?? "#"}
                className={`group relative flex items-center gap-3 px-5 py-3.5 rounded-2xl backdrop-blur-md transition-all ${
                  dimmed
                    ? "bg-white/3 border border-white/5 opacity-50 hover:opacity-80 hover:bg-white/6"
                    : "bg-white/6 border border-white/8 hover:bg-white/12 hover:border-white/18"
                }`}
              >
                {badge}
                <Icon
                  className={`w-5 h-5 transition-colors ${dimmed ? "text-white/30" : "text-white/50 group-hover:text-white"}`}
                />
                <div className="text-start">
                  {label}
                  <div className="text-xs text-white font-medium mt-0.5">
                    {file?.filename ?? t(`download.${os}File`)}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </div>

      {/* Floating “get started” card — slim bar on phones, bottom-end widget
          from sm up (bottom-right in LTR, bottom-left in RTL). The footer keeps
          extra bottom padding below xl so its links stay clear of the card. */}
      <Link
        href="/start"
        className="group fixed bottom-4 inset-x-4 sm:inset-x-auto sm:bottom-5 sm:end-5 sm:max-w-[268px] z-30 pointer-events-auto flex items-center gap-3 rounded-2xl backdrop-blur-md bg-white/8 border border-white/12 hover:bg-white/14 hover:border-white/25 transition-all px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
      >
        <span className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-400/25 flex items-center justify-center shrink-0">
          <FaWandMagicSparkles className="w-4 h-4 text-emerald-300" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-white leading-snug">
            {t("startCta.title")}
          </span>
          <span className="block text-[11px] text-white/55 leading-snug mt-0.5">
            {t("startCta.desc")}
          </span>
        </span>
        <FaArrowRight className="w-3 h-3 text-white/40 group-hover:text-white transition-colors rtl:rotate-180 shrink-0" />
      </Link>

      {/* Footer */}
      <div className="pb-24 xl:pb-5 pt-4 flex justify-center">
        <div className="grid grid-cols-3 justify-items-center gap-x-5 gap-y-3 sm:flex sm:items-center sm:gap-6 text-xs text-white/40 pointer-events-auto">
          <a
            href="https://docs.wolffi.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaBook className="w-3.5 h-3.5" />
            {t("footer.docs")}
          </a>
          <Link
            href="/blog"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaNewspaper className="w-3.5 h-3.5" />
            {t("footer.blog")}
          </Link>
          <a
            href="https://github.com/thewolffish/wolffish-app"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaGithub className="w-3.5 h-3.5" />
            {t("footer.github")}
          </a>
          <a
            href="https://discord.gg/zWJpD3SgTt"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaDiscord className="w-3.5 h-3.5" />
            {t("footer.discord")}
          </a>
          <a
            href="https://x.com/younesbites"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaXTwitter className="w-3.5 h-3.5" />
            {t("footer.x")}
          </a>
          <a
            href="https://www.youtube.com/@younesbites"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaYoutube className="w-3.5 h-3.5" />
            {t("footer.youtube")}
          </a>
          {/* WhatsApp omitted for now — kept here so it can be re-enabled. */}
          {SHOW_WHATSAPP && (
            <a
              href="https://wa.me/966538654514"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
            >
              <FaWhatsapp className="w-3.5 h-3.5" />
              {t("footer.whatsapp")}
            </a>
          )}
          <a
            href="mailto:younes@wolffi.sh"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaEnvelope className="w-3.5 h-3.5" />
            {t("footer.email")}
          </a>
          <Link
            href="/terms"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaFileContract className="w-3.5 h-3.5" />
            {t("footer.terms")}
          </Link>
          <Link
            href="/privacy"
            className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
          >
            <FaShieldHalved className="w-3.5 h-3.5" />
            {t("footer.privacy")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={copy}
      className="shrink-0 p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <FaCheck className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <FaCopy className="w-3.5 h-3.5 text-white/40 hover:text-white/70" />
      )}
    </button>
  );
}

// The companion phone app. Same card shape as the install commands, so the
// link is there to read and copy rather than hidden behind a badge.
const STORES = [
  {
    key: "appStore" as const,
    url: "https://apps.apple.com/us/app/wolffish/id6792797989",
    Icon: FaApple,
  },
  {
    key: "googlePlay" as const,
    url: "https://play.google.com/store/apps/details?id=sh.wolffi.mobile",
    Icon: FaAndroid,
  },
];

function StoreLinks() {
  const t = useTranslations();

  return (
    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-5xl pointer-events-auto">
      {STORES.map(({ key, url, Icon }) => (
        <div
          key={key}
          dir="ltr"
          className="flex items-center gap-3 rounded-2xl backdrop-blur-md bg-white/4 border border-white/8 px-4 py-3 font-mono"
        >
          <Icon className="w-3.5 h-3.5 text-white/30 shrink-0" />
          <div className="min-w-0 flex-1">
            {/* Shell-style comment marking which store the link opens */}
            <div className="text-[10px] text-emerald-400/60 mb-0.5">
              # {t(`mobile.${key}`)}
            </div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-white/80 block truncate hover:text-white transition-colors"
            >
              {url}
            </a>
          </div>
          <CopyButton text={url} />
        </div>
      ))}
    </div>
  );
}

function InstallCommands() {
  const t = useTranslations();

  const commands = [
    {
      labelKey: "install.shell" as const,
      command: "curl -fsSL https://releases.wolffi.sh/install.sh | sh",
      Icon: FaTerminal,
    },
    {
      labelKey: "install.powershell" as const,
      command: "irm https://releases.wolffi.sh/install.ps1 | iex",
      Icon: FaWindows,
    },
  ];

  return (
    <div
      dir="ltr"
      className="mt-6 w-full max-w-5xl pointer-events-auto rounded-2xl backdrop-blur-md bg-white/4 border border-white/8 px-4 py-3 font-mono divide-y divide-white/8"
    >
      {commands.map(({ labelKey, command, Icon }) => (
        <div key={labelKey} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
          <Icon className="w-3.5 h-3.5 text-white/30 shrink-0" />
          <div className="min-w-0 flex-1">
            {/* Shell-style comment marking which OS each command is for */}
            <div className="text-[10px] text-emerald-400/60 mb-0.5">
              # {t(labelKey, {
                macos: t("download.macos"),
                windows: t("download.windows"),
                linux: t("download.linux"),
              })}
            </div>
            <code className="text-[11px] text-white/80 block truncate">
              {command}
            </code>
          </div>
          <CopyButton text={command} />
        </div>
      ))}
    </div>
  );
}
