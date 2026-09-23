---
pubDatetime: 2026-09-23T13:00:00Z
title: Using a Sonos Speaker as the Voice Output of an ESP32-S3-Box-3
tags:
  - home-assistant
  - esphome
  - sonos
description: Keep the ESP32-S3-Box-3 as the ears of a Home Assistant voice assistant, and let a Sonos speaker do the talking.
---

I recently started using an **ESP32-S3-Box-3** as a voice satellite for Home Assistant.

It is a convenient voice input device: microphone, wake-word detection, a speaker and a small touchscreen. But I already have Sonos speakers around the house, and they sound far better than the tiny speaker built into the Box.

So I wanted a different split of responsibilities:

> **ESP32-S3-Box-3** = microphone + wake word + voice input  
> **Home Assistant** = conversation / TTS processing  
> **Sonos** = voice output

```text
   ┌─────────────────────┐
   │   ESP32-S3-Box-3    │
   │  Mic · Wake word    │
   └──────────┬──────────┘
              │ voice
              ▼
   ┌─────────────────────┐
   │   Home Assistant    │
   │  Conversation · TTS │
   └──────────┬──────────┘
              │ TTS audio
              ▼
   ┌─────────────────────┐
   │        Sonos        │
   │   Voice playback    │
   └─────────────────────┘
```

It turns out this isn't just a matter of swapping the ESPHome speaker for another one.

## The problem

A normal ESPHome voice assistant pipeline ends on the device itself:

```text
Wake word → STT → Home Assistant → Response → TTS → ESP32 speaker
```

I wanted the last hop to be Sonos instead:

```text
Wake word → STT → Home Assistant → Response → TTS → Sonos
```

The ESP32 keeps listening and detecting the wake word, but it no longer plays the answer. The hook that makes this possible is the **`on_tts_end`** trigger of the ESPHome `voice_assistant` component.

## The flow

```text
Home Assistant generates TTS
          ↓
ESPHome receives the TTS URL
          ↓
on_tts_end fires
          ↓
ESPHome calls a Home Assistant script with that URL
          ↓
The script tells Sonos to play it as an announcement
```

The ESP32 remains part of the pipeline, but the TTS lifecycle event becomes a bridge to Sonos.

## The ESPHome side

`on_tts_end` receives the URL of the generated audio as `x`. We log it, then hand it to a Home Assistant script:

```yaml
voice_assistant:
  on_tts_end:
    - logger.log:
        format: "TTS END URL: %s"
        args: ['x.c_str()']

    - homeassistant.action:
        action: script.play_tts_on_living_room_sonos
        data_template:
          url: "{{ tts_url }}"
        variables:
          tts_url: !lambda 'return x;'
```

A few details worth noting:

- The `variables` block evaluates the lambda on the device, so `tts_url` is the actual URL string sent to Home Assistant.
- `data_template` then renders that variable into the `url` field of the script call.
- The log line is not required, but it is very handy: the URL it prints is exactly what Sonos will be asked to fetch.

## The Home Assistant side

The script takes the URL as a field and asks Sonos to play it:

```yaml
alias: Play TTS on Living Room Sonos
fields:
  url:
    name: TTS URL
    required: true
    selector:
      text: null
sequence:
  - action: media_player.play_media
    target:
      entity_id: media_player.living_room_living_room_sonos
    data:
      announce: true
      media:
        media_content_id: '{{ url }}'
        media_content_type: music
        metadata: {}
mode: queued
```

Two choices here matter.

### `announce: true`

Sonos has an announcement mode, which is exactly what a voice assistant wants. Instead of hijacking the speaker, it ducks or pauses the current playback, speaks, and then restores it:

```text
Music playing → voice response (announcement) → music resumes
```

This makes the setup behave like a real smart speaker rather than a device that suddenly takes over your Sonos.

### `mode: queued`

If you ask two things in quick succession, a second run of the script shouldn't be dropped or cut the first announcement off. `queued` makes the calls wait their turn.

## The surprising part: MP3 vs FLAC

This was the most interesting thing I hit while debugging.

The Home Assistant TTS proxy can hand out URLs ending in `.flac`, and the ESPHome log will happily show something like:

```text
TTS END URL: http://homeassistant:8123/api/tts_proxy/....flac
```

That looks perfectly reasonable, but in my setup **MP3 worked with Sonos announcements while FLAC did not**. Sonos accepted the request, yet nothing was played.

So if Sonos seems to receive the URL but stays silent, check the audio format of that URL first.

### Forcing MP3 in the ESPHome config

The format is decided on the ESPHome side. The Box's YAML defines a `speaker_media_player`, and its announcement pipeline defaults to FLAC. Extend it and switch the format to MP3:

```yaml
media_player:
  - id: !extend speaker_media_player
    announcement_pipeline:
      format: MP3
```

After this, the URL in `TTS END URL: ...` ends in `.mp3`, and Sonos plays it as an announcement.

## Debugging one layer at a time

Debugging the whole chain at once is painful. I found it much easier to verify each layer on its own:

1. **ESP32 voice pipeline**: wake word → recording → STT → Home Assistant → response works normally.
2. **TTS**: the ESPHome logs show the expected events, ending with `TTS END URL: ...`.
3. **Sonos alone**: run the script from Developer Tools → Actions with a known MP3 URL. If that doesn't play, there is no point looking at the ESP32 yet.
4. **The bridge**: only now connect `on_tts_end`.

That way a failure clearly belongs to one of ESPHome, Home Assistant, TTS, or Sonos.

## Takeaway

It is tempting to think of an ESP32 voice assistant as one device doing everything: microphone, AI and speaker. Home Assistant lets you pull those apart:

```text
ESP32          = ears
Home Assistant = brain
Sonos          = mouth
```

That is especially nice if you already have good speakers in the house.

## What's next

- The official firmware doesn't make use of the touchscreen, while several third-party firmwares do. I'd like to try one.
