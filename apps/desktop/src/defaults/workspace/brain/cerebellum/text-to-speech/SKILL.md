---
name: text-to-speech
description: Generate voice memos from text using a fully local neural TTS engine (Kokoro). Convert any text to spoken audio, respond with voice memos, or create voice summaries — entirely on-device, no cloud.
triggers:
  - voice
  - speak
  - say
  - audio
  - read aloud
  - voice memo
  - tts
  - text to speech
  - say this
  - read this
  - talk
  - narrate
  - spoken
  - pronounce
  - recite
  - announce
  - dictate
  - speech
  - sound
  - mp3
  - audio file
  - voice message
  - voice note
  - podcast
  - audiobook
  - read out loud
  - tell me
  - convert to audio
  - generate audio
  - generate voice
  - synthesize
  - text to audio
  - make it speak
  - play this
  - listen to this
  - listen to text
  - vocal
  - voiceover
  - voice actor
  - narrator
  - announcer
  - ai voice
  - natural voice
  - human voice
  - male voice
  - female voice
  - accent
  - pitch
  - speed
  - rate
  - recording
  - audio output
  - sound file
  - save as audio
  - export audio
  - respond with voice
  - say it out loud
  - speak this text
  - read it to me
tools:
  - name: voice_generate
    description: Convert text to a voice memo (MP3). Returns the file path of the generated audio. The voice memo appears as an attachment alongside the text response.
    parameters:
      text:
        type: string
        description: The text to convert to speech
      voice:
        type: string
        required: false
        description: "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice (Settings → Text-to-Speech). American voices start af_ (female) / am_ (male); British voices bf_ / bm_."
      speed:
        type: string
        required: false
        description: "Speech rate multiplier between 0.5 and 1.5 (default 1.0). Omit to use the user's configured default."
  - name: voice_respond
    description: Reply to the user as a spoken voice memo — the default close for a <voice_note> prompt. The audio carries the reply — never restate its text as a regular message; a brief label like "Voice memo" is the only prose it needs. Files and other deliverables still go out normally BEFORE it.
    parameters:
      text:
        type: string
        description: The full response text to speak
      voice:
        type: string
        required: false
        description: "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice."
      speed:
        type: string
        required: false
        description: "Speech rate multiplier between 0.5 and 1.5 (default 1.0). Omit to use the user's configured default."
  - name: voice_list
    description: List all voice memo files in the workspace voice directory with their timestamps and sizes.
    parameters: {}
danger_patterns: []
confirm_patterns: []
requires:
  - python
  - ffmpeg
---

# Voice

## Interface

- Tools: `voice_generate`, `voice_respond`, `voice_list`
- Engine: **Kokoro** — a local 82M-parameter neural TTS model. Runs entirely
  on-device (CPU) via a managed Python runtime; no cloud, no API key, no account.
- Output: MP3 files stored in the workspace voice directory.

The first voice memo provisions the engine (a hermetic Python runtime, the
kokoro-onnx package, and the ~310 MB model) — this is a one-time download. Every
voice memo after that is fully offline.

## When to use each tool

- **The user's message is tagged `<voice_note>` (they spoke instead of typing)** → follow the `<voice_prompts>` block when your prompt carries one — it is present exactly when the Voice replies switch (Preferences page, default ON) is on, and it makes the rule explicit: the turn MUST end with exactly one `voice_respond` speaking the answer — a conversational answer is the memo and nothing else; a working turn delivers files/tables/code exactly as a typed turn would, then closes with the memo. Only an explicit ask in the user's own message ("reply in text") overrides it. No `<voice_prompts>` block in your prompt means the switch is off — reply as normal text.
- **"convert this to a voice memo"**, **"read this aloud"**, **"say this"** → `voice_generate` with the specified text. The voice memo attaches below your text response.
- **"respond in voice"**, **"reply with audio"**, **"voice memo only"** → `voice_respond` with your full response. Do NOT also send the text as a regular message — the voice IS the response. Write only a brief label like "Voice memo" as your text output.
- **"summarize the last response as a voice memo"** → Condense your most recent response into spoken form and use `voice_respond`.
- **"from now on reply with voice memos"** → Use `voice_respond` for all subsequent responses until told otherwise.
- **"list my voice memos"** → `voice_list`.

## Available voices

English only. American (`af_`/`am_`) and British (`bf_`/`bm_`) accents.

| Voice | Language | Gender |
|---|---|---|
| af_bella (default) | English (US) | Female |
| af_heart | English (US) | Female |
| af_nicole | English (US) | Female |
| af_sarah | English (US) | Female |
| am_adam | English (US) | Male |
| am_michael | English (US) | Male |
| am_onyx | English (US) | Male |
| bf_emma | English (UK) | Female |
| bf_isabella | English (UK) | Female |
| bm_george | English (UK) | Male |
| bm_lewis | English (UK) | Male |

The user picks a default in Settings → Text-to-Speech; the full list is shown
there. Leave `voice` unset unless the user explicitly names one.

## Speed

A multiplier from `0.5` (slow) to `1.5` (fast); `1.0` is normal. Omit to use the
user's configured default.

## Rules

- Always pass text that reads naturally when spoken. Strip markdown formatting,
  code blocks, and special characters before sending to TTS.
- **Leave `voice` unset by default.** The user picks their voice in Settings and
  it's applied automatically. Only pass `voice` when the user explicitly names one.
- For long texts the engine handles them in one pass. No chunking needed.
- Voice files are stored in the workspace and persist across sessions.
