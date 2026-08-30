import type { ExpoConfig } from 'expo/config'

export const APP_NAME = 'Wolffish'
export const APP_SCHEME = 'wolffish'
const EXPO_PROJECT_ID = '684beeaa-cdb0-48d4-aab0-bf7c0aae92a0'
const EXPO_PROJECT_SLUG = 'wolffish-mobile'
const EXPO_PROJECT_OWNER = 'younes-alturkey'
const PACKAGE_IDENTIFIER = 'sh.wolffi.mobile'
// Deferred: capture of https://wolffi.sh links as native deep links. Off on
// purpose — the site is an install landing page, so web links must open the
// browser, not the app. To re-enable, uncomment this constant plus the
// associatedDomains / intentFilters blocks below, and restore the
// /.well-known files in wolffish-landing (recipe in its next.config.ts).
// Native change → new fingerprint runtime → ships only in a store binary.
// Known blockers: apex wolffi.sh 307s to www at the Vercel domain level
// (Apple/Google refuse redirected association files — set the domain to
// No Redirect first), and assetlinks.json needs signing-cert SHA-256s that
// exist only after the first Play upload (Play Console → App signing).
// const DEEP_LINK_HOSTS = ['wolffi.sh', 'www.wolffi.sh']
// Bumped by scripts/provision.js — keep the exact format of these lines.
export const APP_VERSION = '1.0.48'
export const CODE_VERSION = 36
export const UPDATE_DATE = '2026-08-30T00:00:00.000Z'
// Sampled from the top edge of assets/images/splash.png so the storyboard
// background is indistinguishable from the artwork.
const SPLASH_BACKGROUND = '#0d1b2d'

const config: ExpoConfig = {
  name: APP_NAME,
  slug: EXPO_PROJECT_SLUG,
  owner: EXPO_PROJECT_OWNER,
  scheme: APP_SCHEME,
  version: APP_VERSION,
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    // Deferred universal links (Team ID A32F47KP86) — uncomment together
    // with DEEP_LINK_HOSTS above:
    // associatedDomains: DEEP_LINK_HOSTS.map((host) => `applinks:${host}`),
    bundleIdentifier: PACKAGE_IDENTIFIER,
    buildNumber: CODE_VERSION.toString(),
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false
    }
  },
  android: {
    // Deferred app links — uncomment together with DEEP_LINK_HOSTS above
    // (autoVerify fails until assetlinks.json carries real fingerprints):
    // intentFilters: [
    //   {
    //     action: 'VIEW',
    //     autoVerify: true,
    //     data: DEEP_LINK_HOSTS.map((host) => ({ scheme: 'https', host })),
    //     category: ['BROWSABLE', 'DEFAULT']
    //   }
    // ],
    package: PACKAGE_IDENTIFIER,
    versionCode: CODE_VERSION,
    // FCM registration — the whole reason Android push works at all.
    //
    // Expo push reaches Android through Firebase Cloud Messaging, and the app
    // can only obtain an FCM token if Firebase is initialized in the binary.
    // That initialization is entirely gated on THIS key: @expo/config-plugins'
    // GoogleServices mod returns early when it is unset, so without it prebuild
    // neither copies google-services.json into android/app/ nor applies the
    // com.google.gms.google-services Gradle plugin. The build still succeeds —
    // which is what made this silent. At runtime getExpoPushTokenAsync() then
    // throws, acquireExpoPushToken() swallows it and returns null, the phone
    // registers a null token, and the relay answers every notify with "no push
    // token — not delivered". Notifications appeared to work only because the
    // in-band tunnel path was covering for them whenever the app was open.
    //
    // The file is committed on purpose: EAS Build uploads the git tree, so an
    // untracked google-services.json is simply absent on the builder and the
    // build fails at the copy step. It carries no secret — the Android API key
    // in it is public by design, scoped to this package name, and Google ships
    // it inside every APK. The private half (the FCM V1 service account key
    // Expo's push service sends with) lives in EAS credentials, never here.
    //
    // NATIVE CHANGE: forks the fingerprint runtime version. Ships in a store
    // build (npm run provision), never over the air.
    googleServicesFile: './google-services.json',
    adaptiveIcon: {
      // adaptive-icon.png is icon-trans.png shrunk into the adaptive-icon
      // safe zone (artwork ~58% of the 1024 canvas, transparent padding) —
      // launchers mask away the outer third of the canvas, so full-bleed
      // artwork like icon-trans.png renders zoomed and clipped. Regenerate
      // from icon-trans.png if the artwork changes.
      foregroundImage: './assets/images/adaptive-icon.png',
      // Solid navy behind the fish — deliberately SPLASH_BACKGROUND, so the
      // launcher icon and the splash read as one surface.
      backgroundColor: SPLASH_BACKGROUND
    },
    predictiveBackGestureEnabled: false
  },
  web: {
    output: 'static',
    favicon: './assets/images/favicon.png'
  },
  extra: {
    eas: {
      projectId: EXPO_PROJECT_ID
    }
  },
  // OTA updates (EAS Update). Never blocks launch (fallbackToCacheTimeout 0):
  // an update downloads in the background and applies on the next cold start,
  // and useOtaUpdates adds the launch check, foreground checks and the restart
  // toast. Publishing is scripts/ota.js. The fingerprint runtime version gates
  // which binaries an update can reach — see fingerprint.config.js for what is
  // deliberately excluded from the hash (version bumps must not fork the
  // runtime).
  //
  // checkAutomatically ON_ERROR_RECOVERY is what makes Settings → Updates a
  // real switch rather than a label. The default (ON_LOAD) checks and
  // downloads inside the native launch sequence, before any JS runs, so no
  // user preference can reach it — turning updates "off" would have gone on
  // updating the app. Now the only routine checks are the ones JS makes, and
  // those are gated on appStore.otaEnabled. ON_ERROR_RECOVERY rather than
  // NEVER keeps expo-updates' anti-brick path: a build that crashes on launch
  // can still pull a fix.
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: `https://u.expo.dev/${EXPO_PROJECT_ID}`,
    fallbackToCacheTimeout: 0,
    checkAutomatically: 'ON_ERROR_RECOVERY'
  },
  plugins: [
    'expo-router',
    'expo-localization',
    // Pairing keys and the tunnel's pairing secret live in the OS keystore
    // (Keychain on iOS, Keystore-encrypted SharedPreferences on Android) —
    // never in AsyncStorage, which is plain text on disk.
    'expo-secure-store',
    [
      // Scanning the desktop's pairing QR is the only camera use; there is no
      // photo capture, no library access, and no recording.
      'expo-camera',
      {
        cameraPermission:
          'Wolffish uses the camera only to scan the pairing code shown by the desktop app.',
        recordAudioAndroid: false
      }
    ],
    // Delivered/attached videos play inline in the chat feed (MediaBlocks
    // VideoBlock). The config plugin is what wires up the native player;
    // background playback and PiP stay off — chat video is foreground only.
    ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: true }],
    [
      // R8 + resource shrinking on Android release builds: smaller AAB, and
      // Gradle embeds the deobfuscation map in the bundle so Play Console
      // decodes crash traces itself (and stops warning about a missing one).
      // Release buildType only — expo run:android debug builds are untouched.
      // Risk profile: a future native dep lacking consumer Proguard rules can
      // crash in release only; the fix is a keep rule in extraProguardRules
      // here, which (like this plugin) is a store-build change, not an OTA.
      'expo-build-properties',
      {
        android: {
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true
        }
      }
    ],
    [
      // SDK 57 dropped the top-level `splash` key growth-app uses; this
      // plugin config with the legacy full-screen mode reproduces the same
      // result: splash.png scaled to fit on the brand background.
      'expo-splash-screen',
      {
        // These top-level values only reach iOS in practice: the Android
        // block below overrides every one of them.
        backgroundColor: SPLASH_BACKGROUND,
        image: './assets/images/splash.png',
        // cover: the full-bleed artwork fills every screen aspect with no
        // letterbox bars, so the background color never actually shows.
        resizeMode: 'cover',
        enableFullScreenImage_legacy: true,
        android: {
          // Android 12+ has no full-screen splash: the OS shows a centered
          // icon on a solid color, and a full-bleed image handed to it gets
          // squeezed into that icon slot (the "small square" bug). So Android
          // gets the platform look instead: fish logo on the brand dark.
          image: './assets/images/icon-trans.png',
          imageWidth: 180,
          resizeMode: 'contain',
          backgroundColor: SPLASH_BACKGROUND
        }
      }
    ],
    [
      // Voice notes: the composer's record button captures audio via
      // expo-audio. iOS requires a usage string; the plugin also adds
      // RECORD_AUDIO on Android. Native change → new fingerprint runtime →
      // ships only in a store binary.
      'expo-audio',
      {
        microphonePermission: 'Allow Wolffish to record voice notes you send to your agent.'
      }
    ],
    [
      // Attaching photos and videos: the composer's plus button opens the
      // system library picker (PHPicker / the Android photo picker), which
      // runs out of process and returns only what the user chose.
      //
      // ONLY photosPermission is set. This plugin also takes cameraPermission
      // and microphonePermission, and passing `false` for either does not mean
      // "don't ask" — it BLOCKS android.permission.CAMERA / RECORD_AUDIO in the
      // merged manifest, which would break the pairing scanner (expo-camera)
      // and voice notes (expo-audio). Left unset, both keep the usage strings
      // those plugins already wrote: config-plugins only fills a permission
      // description that is still empty.
      //
      // expo-document-picker (the Files half of the picker) has a config
      // plugin too, but it is a no-op unless ios.usesIcloudStorage is on, so
      // it is deliberately not listed — autolinking picks up the module.
      //
      // Native change → new fingerprint runtime → ships only in a store binary.
      'expo-image-picker',
      {
        photosPermission: 'Allow Wolffish to attach photos and videos to your messages.'
      }
    ],
    [
      'expo-font',
      {
        fonts: [
          './assets/fonts/IBMPlexSansArabic-Regular.ttf',
          './assets/fonts/IBMPlexSansArabic-Medium.ttf',
          './assets/fonts/IBMPlexSansArabic-SemiBold.ttf',
          './assets/fonts/IBMPlexSansArabic-Bold.ttf'
        ]
      }
    ],
    [
      // Model-initiated push notifications (the desktop agent's notify_phone
      // tool, relayed via Expo push when the tunnel is down). The icon is the
      // Android status-bar small icon: the transparent fish mark, rendered by
      // the OS as a silhouette in the accent color below. No custom sounds —
      // the platform default is the right amount of noise. NATIVE MODULE:
      // adding/changing this ships only in a new EAS store build, never OTA
      // (the fingerprint runtime version forks on it by design).
      'expo-notifications',
      {
        icon: './assets/images/icon-trans.png',
        color: SPLASH_BACKGROUND,
        defaultChannel: 'agent-runs',
        sounds: []
      }
    ],
    // Silences the two cosmetic Xcode warnings the stock template leaves in
    // every iOS build (duplicate -lc++ on the link line, and two Pods script
    // phases that declare no outputs). Build-time only — nothing it touches
    // reaches the running app. Last in the list because it edits what the
    // plugins above have already written.
    './plugins/withQuietIosBuild'
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true
  }
}

export default config
