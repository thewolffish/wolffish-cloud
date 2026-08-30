import LandingOverlay from "@/components/LandingOverlay";

const RELEASE_BASE = "https://releases.wolffi.sh";

function parseYaml(text: string) {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const fileUrl = text.match(/^\s+-\s+url:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { version, fileUrl };
}

function linuxFile(text: string, ext: string) {
  const url = text
    .match(new RegExp(`^\\s+-\\s+url:\\s*(\\S+\\.${ext})\\s*$`, "m"))?.[1]
    ?.trim();
  return url
    ? { url: `${RELEASE_BASE}/${url}`, filename: url.split("/").pop() ?? "" }
    : undefined;
}

async function fetchRelease() {
  try {
    const [mac, win, linux] = await Promise.all([
      fetch(`${RELEASE_BASE}/latest-mac.yml`, { cache: "no-store" }).then((r) => r.text()),
      fetch(`${RELEASE_BASE}/latest.yml`, { cache: "no-store" }).then((r) => r.text()),
      fetch(`${RELEASE_BASE}/latest-linux.yml`, { cache: "no-store" }).then((r) => r.text()),
    ]);
    const macInfo = parseYaml(mac);
    const winInfo = parseYaml(win);
    const linuxInfo = parseYaml(linux);
    const version = macInfo.version || winInfo.version || linuxInfo.version;

    const macDmg =
      mac.match(/^\s+-\s+url:\s*(.+\.dmg)$/m)?.[1]?.trim() ?? macInfo.fileUrl;

    return {
      version,
      files: {
        macos: {
          url: `${RELEASE_BASE}/${macDmg}`,
          filename: macDmg.split("/").pop() ?? "",
        },
        windows: {
          url: `${RELEASE_BASE}/${winInfo.fileUrl}`,
          filename: winInfo.fileUrl.split("/").pop() ?? "",
        },
        linux: {
          deb: linuxFile(linux, "deb"),
          rpm: linuxFile(linux, "rpm"),
          appimage: linuxFile(linux, "AppImage"),
        },
      },
    };
  } catch {
    return null;
  }
}

export default async function Home() {
  const release = await fetchRelease();

  // Structured data: the downloadable app itself.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Wolffish",
    operatingSystem: "macOS, Windows, Linux",
    applicationCategory: "UtilitiesApplication",
    description:
      "A personal AI agent that lives on your own computer. Chat with it from Telegram, WhatsApp, a terminal, or the Wolffish mobile app — it acts, automates, and remembers.",
    url: "https://wolffi.sh",
    downloadUrl: "https://wolffi.sh",
    softwareVersion: release?.version,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": "https://wolffi.sh/#organization" },
  };

  return (
    <main className="relative">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingOverlay release={release} />
    </main>
  );
}
