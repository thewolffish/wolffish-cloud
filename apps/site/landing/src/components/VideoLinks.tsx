"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { FaCirclePlay } from "react-icons/fa6";

// Each video link opens its own YouTube embed. The cinematic launch, the
// cinematic reveal, and the demo walkthrough are distinct videos.
const YT_EMBEDS = {
  launch: "https://www.youtube.com/embed/XZdBttn-99E?autoplay=1&rel=0",
  cinematic: "https://www.youtube.com/embed/TKdTWd6BXR8?autoplay=1&rel=0",
  demo: "https://www.youtube.com/embed/oog1q7T8H-s?autoplay=1&rel=0",
} as const;

type VideoKey = keyof typeof YT_EMBEDS;

// Renders the "Cinematic reveal" / "Demo walkthrough" links and the modal that
// plays the selected video. Shared by the home page and the launch page.
// `className` styles the trigger row (e.g. spacing, pointer-events).
export default function VideoLinks({ className = "" }: { className?: string }) {
  const t = useTranslations("launch");

  // Holds the key of the video being shown, or null when the dialog is closed.
  const [video, setVideo] = useState<VideoKey | null>(null);

  const closeVideo = useCallback(() => setVideo(null), []);

  useEffect(() => {
    if (!video) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeVideo();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [video, closeVideo]);

  return (
    <>
      {/* Video links */}
      <div className={`flex flex-wrap items-center justify-center gap-3 ${className}`}>
        {(["launch", "cinematic", "demo"] as const).map((key, i) => (
          <div key={key} className="flex items-center gap-3">
            {i > 0 && <span className="w-px h-3.5 bg-white/15" />}
            <button
              onClick={() => setVideo(key)}
              className="group flex items-center gap-1.5 text-xs text-white/70 hover:text-white transition-colors cursor-pointer"
            >
              <FaCirclePlay className="w-3.5 h-3.5 text-white/50 group-hover:text-emerald-400 transition-colors" />
              {t(key)}
            </button>
          </div>
        ))}
      </div>

      {/* Video dialog */}
      {video && (
        <div
          onClick={closeVideo}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-6 pointer-events-auto"
          role="dialog"
          aria-modal="true"
          aria-label={t(video)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative"
            style={{
              width: "min(80vw, calc(80vh * 16 / 9))",
              aspectRatio: "16 / 9",
            }}
          >
            <iframe
              src={YT_EMBEDS[video]}
              title={t(video)}
              className="w-full h-full rounded-2xl border border-white/10 shadow-2xl"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        </div>
      )}
    </>
  );
}
