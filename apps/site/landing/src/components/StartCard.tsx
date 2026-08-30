"use client";

import Link from "next/link";
import { FaArrowRight, FaWandMagicSparkles } from "react-icons/fa6";

export interface StartCardUi {
  title: string;
  body: string;
  cta: string;
}

/**
 * Invitation to /start, shown at the foot of the blog index and every post.
 * A reader who liked the writing should never have to hunt for the setup guides.
 */
export default function StartCard({ ui }: { ui: StartCardUi }) {
  return (
    <Link
      href="/start"
      className="group flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5 rounded-2xl bg-white border border-neutral-200 hover:border-emerald-300 hover:shadow-md transition-all p-6"
    >
      <div className="w-11 h-11 shrink-0 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
        <FaWandMagicSparkles className="w-4.5 h-4.5 text-emerald-600" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-neutral-900 leading-snug">
          {ui.title}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">
          {ui.body}
        </p>
      </div>
      <span className="shrink-0 inline-flex items-center gap-2 self-start sm:self-auto px-4 py-2 rounded-full bg-emerald-600 group-hover:bg-emerald-700 text-white text-xs font-semibold transition-colors">
        {ui.cta}
        <FaArrowRight className="w-3 h-3 rtl:rotate-180" />
      </span>
    </Link>
  );
}
