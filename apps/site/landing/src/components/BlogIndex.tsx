"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  FaArrowLeft,
  FaBook,
  FaCalendar,
  FaDiscord,
  FaGithub,
} from "react-icons/fa6";
import StartCard, { type StartCardUi } from "./StartCard";

export interface BlogCardData {
  slug: string;
  title: string;
  description: string;
  dateFormatted: string;
  /** Localized "3 days ago"-style relative date. */
  dateRelative: string;
  categories: { key: string; label: string }[];
  image?: string;
}

export interface BlogIndexUi {
  home: string;
  title: string;
  lead: string;
  all: string;
  docs: string;
  github: string;
  discord: string;
  start: StartCardUi;
}

export interface BlogIndexData {
  ui: BlogIndexUi;
  posts: BlogCardData[];
  /** Categories that actually occur in posts, in canonical order. */
  categories: { key: string; label: string; count: number }[];
}

const DOCS_URL = "https://docs.wolffi.sh";
const GITHUB_URL = "https://github.com/thewolffish/wolffish-app";
const DISCORD_URL = "https://discord.gg/zWJpD3SgTt";

function setLocaleCookie(locale: string) {
  document.cookie = `locale=${locale};path=/;max-age=31536000`;
}

function CategoryChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 text-[10.5px] font-medium text-emerald-700">
      {label}
    </span>
  );
}

export default function BlogIndex({
  data,
  locale,
}: {
  data: BlogIndexData;
  locale: string;
}) {
  const { ui, posts, categories } = data;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [active, setActive] = useState<string>("all");

  const switchLocale = (next: string) => {
    setLocaleCookie(next);
    startTransition(() => router.refresh());
  };

  const filtered =
    active === "all"
      ? posts
      : posts.filter((post) => post.categories.some((c) => c.key === active));

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
      <section className="w-full max-w-6xl mx-auto px-6 pt-8 md:pt-12 text-center">
        <Image
          src="/icon_transparent.png"
          alt="Wolffish logo"
          width={96}
          height={96}
          className="w-12 h-12 md:w-14 md:h-14 mx-auto"
          priority
        />
        <h1 className="mt-4 text-3xl md:text-4xl font-bold text-neutral-900 tracking-tight">
          {ui.title}
        </h1>
        <p className="mt-3 max-w-2xl mx-auto text-sm md:text-base text-neutral-600 leading-relaxed">
          {ui.lead}
        </p>

        {/* Category filter */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => setActive("all")}
            className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
              active === "all"
                ? "bg-emerald-600 border-emerald-600 text-white"
                : "bg-white border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            }`}
          >
            {ui.all}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActive(cat.key)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                active === cat.key
                  ? "bg-emerald-600 border-emerald-600 text-white"
                  : "bg-white border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
              }`}
            >
              {cat.label}
              <span
                className={`ms-1.5 text-[10px] ${
                  active === cat.key ? "text-emerald-100" : "text-neutral-400"
                }`}
              >
                {cat.count}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Posts */}
      <section className="w-full max-w-6xl mx-auto px-6 pt-10 pb-8 flex-1">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((post) => (
            <Link
              key={post.slug}
              href={`/blog/${post.slug}`}
              className="group flex flex-col rounded-2xl bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md transition-all overflow-hidden"
            >
              {post.image && (
                <div className="relative aspect-[2/1] bg-neutral-100 border-b border-neutral-100">
                  <Image
                    src={post.image}
                    alt={post.title}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    className="object-cover"
                  />
                </div>
              )}
              <div className="flex flex-col flex-1 p-5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {post.categories.map((cat) => (
                    <CategoryChip key={cat.key} label={cat.label} />
                  ))}
                </div>
                <h2 className="mt-2.5 text-[15px] font-semibold text-neutral-900 leading-snug group-hover:text-emerald-700 transition-colors line-clamp-2">
                  {post.title}
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-500 line-clamp-3">
                  {post.description}
                </p>
                <div className="mt-auto pt-3 flex items-center justify-between gap-3 text-[11px] text-neutral-400">
                  <span className="flex items-center gap-1.5">
                    <FaCalendar className="w-3 h-3" />
                    {post.dateFormatted}
                  </span>
                  <span className="text-neutral-400/80">{post.dateRelative}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Start here */}
      <section className="w-full max-w-6xl mx-auto px-6 pb-4">
        <StartCard ui={ui.start} />
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
    </div>
  );
}
