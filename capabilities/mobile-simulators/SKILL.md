---
name: mobile-simulators
description: Run and verify iOS apps in the Simulator and Android apps in an emulator or device — build, install, launch, screenshot, read logs, tap/type on Android (use computer-use to tap the iOS Simulator window).
triggers:
  - simulator
  - ios simulator
  - xcrun
  - simctl
  - xcodebuild
  - xcode
  - iphone
  - ipad
  - swift app
  - swiftui
  - flutter run
  - react native
  - expo
  - emulator
  - android emulator
  - adb
  - apk
  - android app
  - run my app
  - test on iphone
  - test on android
  - screenshot the app
  - mobile app
tools:
  - name: sim_devices
    readOnly: true
    description: 'List iOS Simulator devices (name, udid, runtime, state — booted first) and Android devices/emulators reachable through adb. Call this first to pick a target; pass the udid or name to the other sim_* tools, or omit the device to use the booted one.'
    parameters: {}
  - name: sim_boot
    description: 'Boot an iOS Simulator device (by udid or exact name, e.g. "iPhone 17 Pro") and bring the Simulator app to the front. No-op if already booted. Takes 10-40 s the first time.'
    parameters:
      device:
        type: string
        required: false
        description: udid or device name from sim_devices; omitted = the first available iPhone
  - name: sim_build
    description: 'Build an Xcode project or workspace for the iOS Simulator with xcodebuild and return the built .app path (ready for sim_install). Long: minutes on a first build. Output keeps the tail of the build log so errors are visible; a failed build returns the compiler errors.'
    parameters:
      scheme:
        type: string
        description: The Xcode scheme to build
      project:
        type: string
        required: false
        description: Path to the .xcodeproj (or omit and pass workspace)
      workspace:
        type: string
        required: false
        description: Path to the .xcworkspace (takes precedence over project)
      device:
        type: string
        required: false
        description: Simulator device name for the destination (default "iPhone 17")
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
  - name: sim_install
    description: Install a built .app bundle onto the booted (or named) iOS Simulator.
    parameters:
      app:
        type: string
        description: Path to the .app bundle (from sim_build or DerivedData)
      device:
        type: string
        required: false
        description: udid or name; default the booted device
  - name: sim_launch
    description: 'Launch an installed app on the iOS Simulator by bundle identifier (terminates a running instance first). Returns the pid. Follow with sim_screenshot to see it and sim_log to read its output.'
    parameters:
      bundle_id:
        type: string
        description: e.g. com.example.MyApp (from the app's Info.plist)
      device:
        type: string
        required: false
        description: udid or name; default the booted device
  - name: sim_terminate
    description: Terminate a running app on the iOS Simulator by bundle identifier.
    parameters:
      bundle_id:
        type: string
        description: e.g. com.example.MyApp
      device:
        type: string
        required: false
        description: udid or name; default the booted device
  - name: sim_open_url
    description: Open a URL or deep link (myapp://…) on the iOS Simulator.
    parameters:
      url:
        type: string
        description: The URL to open
      device:
        type: string
        required: false
        description: udid or name; default the booted device
  - name: sim_screenshot
    readOnly: true
    description: 'Screenshot the iOS Simulator screen — the pixels come back in the result (needs a vision-capable model) and the PNG is saved under the workspace files/screenshots/. This is how you SEE the app to verify a change. To tap or type on iOS, use computer-use on the Simulator window (computer_screenshot + computer_mouse_click / computer_keyboard_type) — simctl has no input injection.'
    parameters:
      device:
        type: string
        required: false
        description: udid or name; default the booted device
      max_dimension:
        type: integer
        required: false
        description: Long edge of the returned view in pixels (default 1024)
  - name: sim_log
    readOnly: true
    description: 'Recent log lines from the iOS Simulator for one process (the app''s name or bundle id) — crashes, print/NSLog/os_log output. Default the last 30 seconds; tail-biased.'
    parameters:
      process:
        type: string
        description: Process name (the app binary name) or bundle identifier
      seconds:
        type: number
        required: false
        description: How far back to look (default 30)
      device:
        type: string
        required: false
        description: udid or name; default the booted device
  - name: adb_install
    description: Install an APK on the connected Android device or running emulator (adb install -r).
    parameters:
      apk:
        type: string
        description: Path to the .apk
      serial:
        type: string
        required: false
        description: Device serial from sim_devices when more than one is connected
  - name: adb_launch
    description: 'Launch an Android app by package name (its main launcher activity), force-stopping a running instance first. Follow with adb_screenshot.'
    parameters:
      package:
        type: string
        description: e.g. com.example.myapp
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
  - name: adb_screenshot
    readOnly: true
    description: 'Screenshot the Android device/emulator — pixels returned in the result (vision model) and the PNG saved under files/screenshots/. Coordinates for adb_tap are in the ORIGINAL screen pixels the result reports.'
    parameters:
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
      max_dimension:
        type: integer
        required: false
        description: Long edge of the returned view in pixels (default 1024)
  - name: adb_tap
    description: Tap the Android screen at (x, y) in screen pixels.
    parameters:
      x:
        type: integer
        description: X in screen pixels
      y:
        type: integer
        description: Y in screen pixels
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
  - name: adb_text
    description: Type text into the focused Android field (adb shell input text).
    parameters:
      text:
        type: string
        description: The text to type
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
  - name: adb_key
    description: 'Press an Android key: BACK, HOME, ENTER, TAB, MENU, APP_SWITCH, DEL, or any KEYCODE_* name.'
    parameters:
      key:
        type: string
        description: Key name, e.g. BACK
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
  - name: adb_log
    readOnly: true
    description: 'Recent Android log lines (logcat, tail-biased), optionally filtered to one package/tag substring. Crashes and exceptions show here.'
    parameters:
      filter:
        type: string
        required: false
        description: Substring to keep (package name, tag, "AndroidRuntime")
      lines:
        type: number
        required: false
        description: How many recent lines to scan (default 400)
      serial:
        type: string
        required: false
        description: Device serial when more than one is connected
requires: []
confirm_patterns: []
---

# Mobile simulators

The run-and-look loop for mobile apps, so a code change can be verified the way a
developer verifies it: build, install, launch, screenshot, read the log, poke the UI.

## iOS (Simulator)

1. `sim_devices` → pick a device; `sim_boot` if none is booted.
2. `sim_build` with the scheme (and project or workspace) → the `.app` path. A failing
   build returns the compiler errors — fix them and rebuild.
3. `sim_install` the `.app`, `sim_launch` the bundle id (read it from the app's
   Info.plist or the Xcode target settings).
4. `sim_screenshot` to see the result; `sim_log` (the app's process name) for
   crashes and print output.
5. To tap, scroll or type on iOS, drive the Simulator window with computer-use:
   `computer_screenshot`, `computer_mouse_click`, `computer_keyboard_type`. simctl
   has no input injection. `sim_open_url` handles deep links.

Frameworks: Flutter (`flutter run -d <udid>` in background, then `sim_screenshot`),
React Native / Expo (`npx expo run:ios`, `npx react-native run-ios --simulator`),
all through `shell_exec background=true` with the log path for progress.

## Android (emulator or device)

1. `sim_devices` lists adb devices; start an emulator with
   `shell_exec` (`emulator -avd <name>` in background) if none is running.
2. Build with the project's own toolchain (`./gradlew assembleDebug`, `flutter build
   apk`, `npx react-native run-android`), `adb_install` the APK, `adb_launch` the
   package.
3. `adb_screenshot` → `adb_tap` / `adb_text` / `adb_key` to exercise the UI;
   `adb_log` with the package name or `AndroidRuntime` for crashes.

## Rules

- Verify with your eyes: after a UI change, screenshot before claiming it works.
- Screenshots land under the workspace `files/screenshots/`; deliver the telling one
  with `send_file` when the user should see it.
- Never leave an emulator you started running when the task is done unless the
  user asked for it: `shell_stop` the background job.
