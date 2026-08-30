"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type { IconType } from "react-icons";
import {
  FaApple,
  FaArrowLeft,
  FaArrowUpRightFromSquare,
  FaBell,
  FaBook,
  FaBoxArchive,
  FaCalendarCheck,
  FaChartLine,
  FaCheck,
  FaCircleCheck,
  FaCircleInfo,
  FaClock,
  FaCoins,
  FaComments,
  FaCopy,
  FaDiscord,
  FaDumbbell,
  FaEnvelopeOpenText,
  FaFaceLaughSquint,
  FaFilePdf,
  FaGithub,
  FaGooglePlay,
  FaHashtag,
  FaListCheck,
  FaMagnifyingGlass,
  FaMobileScreen,
  FaMugHot,
  FaNewspaper,
  FaPaperPlane,
  FaPenNib,
  FaPlane,
  FaPlug,
  FaServer,
  FaShieldHalved,
  FaTag,
  FaTerminal,
  FaUsers,
  FaUtensils,
  FaWandMagicSparkles,
  FaXmark,
} from "react-icons/fa6";

/* ---------- data shapes (assembled server-side in app/start/page.tsx) ---------- */

export interface StartCommand {
  note?: string;
  code: string;
}

export interface StartStep {
  title: string;
  body?: string;
  cmd?: StartCommand[];
  prompt?: string[];
  links?: { label: string; url: string }[];
  stores?: boolean;
  note?: string;
}

export interface StartCaseData {
  id: string;
  icon: string;
  title: string;
  desc: string;
  time: string;
  cost: string;
  channel?: string;
  intro: string;
  steps: StartStep[];
  outro?: string;
  docs: string;
}

export interface StartUi {
  home: string;
  hint: string;
  timeLabel: string;
  costLabel: string;
  close: string;
  sendThis: string;
  moreTitle: string;
  moreBody: string;
  docs: string;
  github: string;
  discord: string;
  blog: string;
  stepsLabel: string;
}

export interface StartFeature {
  icon: string;
  title: string;
  desc: string;
}

export interface StartHero {
  title: string;
  lead: string;
  features: StartFeature[];
}

export interface StartData {
  ui: StartUi;
  hero: StartHero;
  cases: StartCaseData[];
}

/* ---------- constants ---------- */

const APP_STORE_URL = "https://apps.apple.com/us/app/wolffish/id6792797989";
const GOOGLE_PLAY_URL =
  "https://play.google.com/store/apps/details?id=sh.wolffi.mobile";
const DOCS_URL = "https://docs.wolffi.sh";
const GITHUB_URL = "https://github.com/thewolffish/wolffish-app";
const DISCORD_URL = "https://discord.gg/zWJpD3SgTt";

const ICONS: Record<string, IconType> = {
  archive: FaBoxArchive,
  bell: FaBell,
  calendar: FaCalendarCheck,
  chart: FaChartLine,
  coins: FaCoins,
  comments: FaComments,
  dumbbell: FaDumbbell,
  envelope: FaEnvelopeOpenText,
  hashtag: FaHashtag,
  laugh: FaFaceLaughSquint,
  list: FaListCheck,
  meal: FaUtensils,
  mobile: FaMobileScreen,
  mug: FaMugHot,
  newspaper: FaNewspaper,
  pdf: FaFilePdf,
  plane: FaPlane,
  plug: FaPlug,
  search: FaMagnifyingGlass,
  server: FaServer,
  shield: FaShieldHalved,
  tag: FaTag,
  terminal: FaTerminal,
  users: FaUsers,
};

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

/* ---------- small pieces ---------- */

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
      className="shrink-0 p-2 rounded-lg hover:bg-neutral-500/15 transition-colors cursor-pointer"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <FaCheck className="w-3.5 h-3.5 text-emerald-500" />
      ) : (
        <FaCopy className="w-3.5 h-3.5 text-neutral-400 hover:text-neutral-600" />
      )}
    </button>
  );
}

function Chip({
  icon: Icon,
  children,
}: {
  icon?: IconType;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-100 border border-neutral-200 text-[11px] font-medium text-neutral-600">
      {Icon && <Icon className="w-3 h-3 text-neutral-400" />}
      {children}
    </span>
  );
}

function LinkChips({ links }: { links: { label: string; url: string }[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.map((link) => (
        <a
          key={link.url + link.label}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-neutral-200 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 transition-colors"
        >
          <FaArrowUpRightFromSquare className="w-2.5 h-2.5 text-neutral-400" />
          {link.label}
        </a>
      ))}
    </div>
  );
}

function StoreButtons() {
  return (
    <div className="mt-3 flex flex-col sm:flex-row gap-2.5">
      {[
        { name: "App Store", url: APP_STORE_URL, Icon: FaApple },
        { name: "Google Play", url: GOOGLE_PLAY_URL, Icon: FaGooglePlay },
      ].map(({ name, url, Icon }) => (
        <a
          key={name}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center gap-3 rounded-xl bg-white border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 px-4 py-3 transition-colors"
        >
          <Icon className="w-4.5 h-4.5 text-neutral-700" />
          <span className="text-sm font-medium text-neutral-900">{name}</span>
          <FaArrowUpRightFromSquare className="w-2.5 h-2.5 text-neutral-300 ms-auto" />
        </a>
      ))}
    </div>
  );
}

function CommandBlock({ cmd }: { cmd: StartCommand }) {
  return (
    <div
      dir="ltr"
      className="mt-3 rounded-xl bg-neutral-900 px-3.5 py-2.5 font-mono flex items-center gap-3 text-left"
    >
      <div className="min-w-0 flex-1">
        {cmd.note && (
          <div className="text-[10px] text-emerald-400 mb-1"># {cmd.note}</div>
        )}
        <code className="text-xs leading-relaxed text-neutral-100 block whitespace-pre-wrap break-all">
          {cmd.code}
        </code>
      </div>
      <CopyButton text={cmd.code} />
    </div>
  );
}

function PromptBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 mb-1.5">
        <FaPaperPlane className="w-2.5 h-2.5" />
        {label}
      </div>
      <div className="flex items-start gap-2">
        <p className="flex-1 text-[13px] leading-relaxed text-neutral-800 whitespace-pre-wrap">
          {text}
        </p>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

/* ---------- the page ---------- */

export default function StartView({
  data,
  locale,
}: {
  data: StartData;
  locale: string;
}) {
  const { ui, hero, cases } = data;
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = cases.find((c) => c.id === activeId) ?? null;

  const switchLocale = (next: string) => {
    setLocaleCookie(next);
    startTransition(() => router.refresh());
  };

  const openCase = useCallback((id: string) => {
    setActiveId(id);
    setOpen(true);
    history.replaceState(null, "", `#${id}`);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search
    );
  }, []);

  // Deep link: /start#case-id opens that guide (on load and on hash edits).
  useEffect(() => {
    const openFromHash = () => {
      const id = window.location.hash.slice(1);
      if (id && cases.some((c) => c.id === id)) {
        setActiveId(id);
        setOpen(true);
      }
    };
    const initial = setTimeout(openFromHash, 0);
    window.addEventListener("hashchange", openFromHash);
    return () => {
      clearTimeout(initial);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, [cases]);

  // While the sheet is open: lock page scroll, close on Escape, focus panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  return (
    <div className="relative z-10 min-h-screen flex flex-col bg-[#f7f8fa] text-neutral-900">
      {/* Top bar */}
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
        >
          <FaArrowLeft className="w-3 h-3 rtl:rotate-180" />
          <span className="font-medium">{ui.home}</span>
        </Link>
        <button
          onClick={() => switchLocale(locale === "en" ? "ar" : "en")}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white border border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 transition-all cursor-pointer"
        >
          {locale === "en" ? "عربي" : "EN"}
        </button>
      </header>

      {/* Intro */}
      <section className="w-full max-w-6xl mx-auto px-6 pt-8 md:pt-14 text-center">
        <Image
          src="/icon_transparent.png"
          alt="Wolffish logo"
          width={96}
          height={96}
          className="w-14 h-14 md:w-16 md:h-16 mx-auto"
          priority
        />
        <h1 className="mt-5 text-3xl md:text-5xl font-bold text-neutral-900 tracking-tight">
          {hero.title}
        </h1>
        <p className="mt-4 max-w-3xl mx-auto text-sm md:text-base text-neutral-600 leading-relaxed">
          {hero.lead}
        </p>
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          {hero.features.map((feature) => {
            const Icon = ICONS[feature.icon] ?? FaWandMagicSparkles;
            return (
              <div
                key={feature.title}
                className="rounded-2xl bg-white border border-neutral-200 p-5 flex flex-col items-center text-center"
              >
                <div className="w-9 h-9 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="mt-2.5 text-[13px] md:text-sm font-semibold text-neutral-900 leading-snug">
                  {feature.title}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  {feature.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Cards */}
      <section className="w-full max-w-6xl mx-auto px-6 pt-10 md:pt-14 pb-8 flex-1">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-neutral-400 mb-4">
          {ui.hint}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cases.map((c) => {
            const Icon = ICONS[c.icon] ?? FaWandMagicSparkles;
            return (
              <button
                key={c.id}
                onClick={() => openCase(c.id)}
                className="group text-start rounded-2xl bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md transition-all p-5 flex flex-col gap-3 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="text-[15px] font-semibold text-neutral-900 leading-snug">
                  {c.title}
                </div>
                <p className="text-[13px] leading-relaxed text-neutral-500">
                  {c.desc}
                </p>
                <div className="mt-auto pt-1 flex flex-wrap gap-1.5">
                  <Chip icon={FaClock}>{c.time}</Chip>
                  {c.channel && <Chip>{c.channel}</Chip>}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full max-w-6xl mx-auto px-6 pb-10 pt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs text-neutral-400">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-neutral-700 transition-colors"
        >
          <FaBook className="w-3.5 h-3.5" />
          {ui.docs}
        </a>
        <Link
          href="/blog"
          className="flex items-center gap-1.5 hover:text-neutral-700 transition-colors"
        >
          <FaPenNib className="w-3.5 h-3.5" />
          {ui.blog}
        </Link>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-neutral-700 transition-colors"
        >
          <FaGithub className="w-3.5 h-3.5" />
          {ui.github}
        </a>
        <a
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-neutral-700 transition-colors"
        >
          <FaDiscord className="w-3.5 h-3.5" />
          {ui.discord}
        </a>
      </footer>

      {/* Guide sheet */}
      <div
        aria-hidden={!open}
        className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      >
        {/* Backdrop */}
        <div
          onClick={close}
          className={`absolute inset-0 bg-neutral-900/25 backdrop-blur-sm transition-opacity duration-300 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* Panel */}
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={active?.title}
          className={`absolute inset-y-0 end-0 w-full sm:max-w-2xl lg:max-w-3xl bg-white sm:border-s border-neutral-200 shadow-2xl overflow-y-auto outline-none ease-out ${
            open
              ? "translate-x-0 visible transition-transform duration-300"
              : // Delayed visibility keeps the slide-out animation but stops the
                // off-screen panel from sweeping across on locale/direction flips.
                "translate-x-full rtl:-translate-x-full invisible transition-[transform,visibility] duration-300 delay-[0s,300ms]"
          }`}
        >
          {active && (
            <div className="px-6 sm:px-10 py-6 pb-14">
              {/* Sheet header */}
              <div className="flex items-start justify-between gap-4">
                <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0">
                  {(() => {
                    const Icon = ICONS[active.icon] ?? FaWandMagicSparkles;
                    return <Icon className="w-5 h-5 text-emerald-600" />;
                  })()}
                </div>
                <button
                  onClick={close}
                  aria-label={ui.close}
                  className="shrink-0 p-2 rounded-lg text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition-colors cursor-pointer"
                >
                  <FaXmark className="w-4 h-4" />
                </button>
              </div>

              <h2 className="mt-4 text-xl md:text-2xl font-bold text-neutral-900 leading-snug">
                {active.title}
              </h2>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip icon={FaClock}>
                  {ui.timeLabel} {active.time}
                </Chip>
                <Chip icon={FaCoins}>
                  {ui.costLabel} {active.cost}
                </Chip>
                {active.channel && <Chip>{active.channel}</Chip>}
              </div>

              <p className="mt-4 text-sm leading-relaxed text-neutral-600">
                {active.intro}
              </p>

              {/* Steps */}
              <p className="mt-8 text-xs font-medium uppercase tracking-widest text-neutral-400">
                {ui.stepsLabel}
              </p>
              <ol className="mt-4 space-y-8">
                {active.steps.map((step, i) => (
                  <li key={i} className="flex gap-4">
                    <div className="shrink-0 w-7 h-7 rounded-full bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center">
                      {i + 1}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="text-[15px] font-semibold text-neutral-900 leading-snug">
                        {step.title}
                      </div>
                      {step.body && (
                        <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
                          {step.body}
                        </p>
                      )}
                      {step.cmd?.map((cmd, j) => (
                        <CommandBlock key={j} cmd={cmd} />
                      ))}
                      {step.prompt?.map((p, j) => (
                        <PromptBlock key={j} text={p} label={ui.sendThis} />
                      ))}
                      {step.links && step.links.length > 0 && (
                        <LinkChips links={step.links} />
                      )}
                      {step.stores && <StoreButtons />}
                      {step.note && (
                        <div className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-neutral-500">
                          <FaCircleInfo className="w-3.5 h-3.5 mt-0.5 shrink-0 text-neutral-300" />
                          <span>{step.note}</span>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              {/* Done */}
              {active.outro && (
                <div className="mt-9 flex items-start gap-2.5 rounded-2xl bg-emerald-50 border border-emerald-200 p-4">
                  <FaCircleCheck className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  <p className="text-[13.5px] leading-relaxed text-emerald-900">
                    {active.outro}
                  </p>
                </div>
              )}

              {/* More help */}
              <div className="mt-6 rounded-2xl bg-neutral-50 border border-neutral-200 p-4">
                <div className="text-sm font-semibold text-neutral-900">
                  {ui.moreTitle}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">
                  {ui.moreBody}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={active.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-neutral-200 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 transition-colors"
                  >
                    <FaBook className="w-3 h-3 text-neutral-400" />
                    {ui.docs}
                  </a>
                  <a
                    href={DISCORD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-neutral-200 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 transition-colors"
                  >
                    <FaDiscord className="w-3 h-3 text-neutral-400" />
                    {ui.discord}
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
