/**
 * An AppImage does not run from where it lives.
 *
 * The runtime mounts the image at a fresh `/tmp/.mount_WolffiXXXXXX` for the
 * lifetime of the process and unmounts it on exit, so `app.getPath('exe')` and
 * `process.resourcesPath` both point INSIDE a directory that is gone the moment
 * the app closes — and that has a different name next time. Anything this app
 * writes for later therefore recorded a path that could never work again — the
 * XDG autostart entry is written once and read by a session manager much
 * later, which is exactly the worst case for a path that expires; the app
 * itself never noticed, because within a single run the mount is real.
 *
 * The runtime exports `APPIMAGE` holding the path of the .AppImage FILE, which
 * is the stable handle to the same app. Upstream's electron-updater depends on it
 * to find the file it replaces on update, so it is as load-bearing as it looks.
 *
 * Everything here is a no-op off the AppImage path: a .deb, .rpm, .dmg or NSIS
 * install unpacks to a real directory and needs none of it.
 */
/** The .AppImage this process was launched from, or null when it wasn't. */
export function appImagePath(): string | null {
  const value = process.env.APPIMAGE
  return value && value.length > 0 ? value : null
}

/**
 * The path to this app that will still resolve tomorrow. Pass anything about
 * to be written into an autostart entry.
 */
export function stableExecPath(execPath: string): string {
  return appImagePath() ?? execPath
}

/**
 * The environment a launcher needs to start this app the way it is running now.
 *
 * On a box with no `/dev/fuse` — a container started without the device — an
 * AppImage cannot mount and only runs by unpacking itself, which the runtime
 * does when `APPIMAGE_EXTRACT_AND_RUN` is set. The installer works that out
 * once and bakes it into the launcher it writes, but the entry written HERE
 * would launch the same file with a bare exec and simply fail on those
 * machines. Rather than repeat the installer's guess with our own copy of the
 * logic, copy the answer: this process is proof of a launch that worked.
 *
 * Returned as a bare NAME=VALUE, which a .desktop entry takes as an argument
 * to `env`.
 *
 * Null for every other kind of install, and for an AppImage that mounted
 * normally — self-extraction costs hundreds of megabytes per run and is never
 * something to opt into on a hunch.
 */
export function appImageLaunchEnv(): string | null {
  if (!appImagePath()) return null
  const extract = process.env.APPIMAGE_EXTRACT_AND_RUN
  return extract && extract.length > 0 ? 'APPIMAGE_EXTRACT_AND_RUN=1' : null
}
