#!/usr/bin/env bash
# setup-audio.sh — Install and verify audio dependencies for browser mode
# Requires macOS with Homebrew

set -euo pipefail

echo "=== Discord Voice Bot — Audio Setup ==="
echo ""

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script is for macOS only."
  echo "Browser mode requires BlackHole virtual audio device (macOS)."
  exit 1
fi

# Check Homebrew
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

echo "1. Installing BlackHole 2ch (virtual audio device)..."
if brew list blackhole-2ch &>/dev/null; then
  echo "   ✓ BlackHole 2ch already installed"
else
  brew install blackhole-2ch
  echo "   ✓ BlackHole 2ch installed"
fi

echo ""
echo "2. Installing sox (audio playback to virtual device)..."
if command -v sox &>/dev/null; then
  echo "   ✓ sox already installed ($(sox --version 2>&1 | head -1))"
else
  brew install sox
  echo "   ✓ sox installed"
fi

echo ""
echo "3. Installing ffmpeg (audio format conversion)..."
if command -v ffmpeg &>/dev/null; then
  echo "   ✓ ffmpeg already installed"
else
  brew install ffmpeg
  echo "   ✓ ffmpeg installed"
fi

echo ""
echo "4. Verifying BlackHole device..."
if sox -n -t coreaudio "BlackHole 2ch" trim 0 0.1 2>/dev/null; then
  echo "   ✓ BlackHole 2ch device accessible"
else
  echo "   ⚠ Could not access BlackHole 2ch device."
  echo "   You may need to restart your Mac after installation."
  echo "   Check System Settings → Sound → Input to verify the device exists."
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Set MODE=browser in your .env file"
echo "  2. Set DISCORD_EMAIL and DISCORD_PASSWORD"
echo "  3. Set BLACKHOLE_DEVICE=BlackHole 2ch"
echo "  4. Run: npm run dev"
echo ""
echo "The first run will open a Chrome window for Discord login."
echo "Session data is persisted in ./browser-profile/ so you only login once."
