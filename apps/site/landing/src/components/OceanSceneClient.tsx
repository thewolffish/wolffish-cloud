"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const OceanScene = dynamic(() => import("@/components/OceanScene"), {
  ssr: false,
});

// Routes that render a plain page without the 3D ocean background.
const PLAIN_ROUTES = ["/start", "/blog"];

export default function OceanSceneClient() {
  const pathname = usePathname();
  if (pathname && PLAIN_ROUTES.some((route) => pathname.startsWith(route))) {
    return null;
  }
  return <OceanScene />;
}
