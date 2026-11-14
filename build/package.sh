#!/bin/bash
# Builds the TRACKR installers into build/dist:
#   TRACKR-<v>-mac.zxp            signed extension for Mac (any ZXP installer)
#   TRACKR-<v>-mac.pkg            double-click Mac installer (per-user, no admin password)
#   TRACKR-<v>-windows.zxp        signed extension for Windows (any ZXP installer)
#   TRACKR-<v>-windows-setup.exe  double-click Windows installer
# Needs: vendor/zxpsign/ZXPSignCmd, vendor/ffmpeg-*/ffmpeg, makensis (brew install makensis).
set -euo pipefail

B="$(cd "$(dirname "$0")" && pwd)"
SRC="$B/../extension"
ID="com.studio.trackr"
# Details shown on the self-signed certificate. Edit before the first build if you want others.
CERT_COUNTRY="US"; CERT_STATE="NA"; CERT_ORG="TRACKR"; CERT_NAME="TRACKR"
TSA="http://time.certum.pl"   # the signing tool rejects DigiCert and Sectigo timestamps

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$SRC/CSXS/manifest.xml")"
SIGN="$B/vendor/zxpsign/ZXPSignCmd"
DIST="$B/dist"; STAGE="$B/stage"; SIGNED="$B/signed"
rm -rf "$STAGE" "$SIGNED" "$DIST"; mkdir -p "$STAGE" "$SIGNED" "$DIST" "$B/cert"

# One self-signed certificate, reused for every build so updates keep the same signer.
if [ ! -f "$B/cert/trackr.p12" ]; then
  openssl rand -hex 16 > "$B/cert/password.txt"
  "$SIGN" -selfSignedCert "$CERT_COUNTRY" "$CERT_STATE" "$CERT_ORG" "$CERT_NAME" "$(cat "$B/cert/password.txt")" "$B/cert/trackr.p12" -validityDays 3650
fi
PW="$(cat "$B/cert/password.txt")"

stage() { # stage <mac|windows> <ffmpeg folders...>
  local plat="$1"; shift
  local out="$STAGE/$plat/$ID"
  mkdir -p "$out/client"
  cp -R "$SRC/CSXS" "$SRC/host" "$out/"
  cp "$SRC/client/index.html" "$SRC/client/style.css" "$SRC/client/main.js" "$SRC/client/tracker.js" "$out/client/"
  for v in "$@"; do
    local arch="${v#ffmpeg-}"
    mkdir -p "$out/bin/$arch"
    if [ "$plat" = windows ]; then cp "$B/vendor/$v/ffmpeg" "$out/bin/$arch/ffmpeg.exe"
    else cp "$B/vendor/$v/ffmpeg" "$out/bin/$arch/ffmpeg"; chmod 755 "$out/bin/$arch/ffmpeg"; fi
  done
  cp "$B/THIRD-PARTY.txt" "$out/"
  find "$out" -name .DS_Store -delete
}

sign() { # sign <mac|windows>  -> zxp + an unpacked signed copy for the double-click installers
  local plat="$1" zxp="$DIST/TRACKR-$VERSION-$1.zxp"
  "$SIGN" -sign "$STAGE/$plat/$ID" "$zxp" "$B/cert/trackr.p12" "$PW" -tsa "$TSA" \
    || { echo "timestamp server unavailable, signing without it"; "$SIGN" -sign "$STAGE/$plat/$ID" "$zxp" "$B/cert/trackr.p12" "$PW"; }
  "$SIGN" -verify "$zxp"
  mkdir -p "$SIGNED/$plat/$ID"
  unzip -q "$zxp" -d "$SIGNED/$plat/$ID"
  find "$SIGNED/$plat/$ID/bin" -type f -name ffmpeg -exec chmod 755 {} + 2>/dev/null || true
}

stage mac ffmpeg-darwin-arm64 ffmpeg-darwin-x64
stage windows ffmpeg-win32-x64
sign mac
sign windows

# ---- Mac .pkg: installs into the current user's Library, so no admin password is needed.
pkgbuild --quiet --root "$SIGNED/mac" --identifier "$ID.pkg" --version "$VERSION" \
  --install-location "/Library/Application Support/Adobe/CEP/extensions" "$STAGE/component.pkg"
cat > "$STAGE/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
  <title>TRACKR $VERSION</title>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" title="TRACKR"><pkg-ref id="$ID.pkg"/></choice>
  <pkg-ref id="$ID.pkg" version="$VERSION">component.pkg</pkg-ref>
</installer-gui-script>
EOF
productbuild --quiet --distribution "$STAGE/distribution.xml" --package-path "$STAGE" "$DIST/TRACKR-$VERSION-mac.pkg"

# ---- Windows .exe
LC_ALL=en_US.UTF-8 makensis -V2 -DVERSION="$VERSION" -DSRCDIR="$SIGNED/windows/$ID" -DOUTFILE="$DIST/TRACKR-$VERSION-windows-setup.exe" "$B/windows-installer.nsi"

cp "$B/INSTALL.txt" "$DIST/"
rm -rf "$STAGE"
echo; ls -lh "$DIST"
