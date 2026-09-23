# Releasing

Installers are built by the **Release** workflow whenever a `v*` tag is
pushed. It produces macOS (`.dmg` and `.zip`, Apple silicon and Intel),
Windows (`.exe`) and Linux (`.AppImage`, `.deb`) builds and attaches them to
the GitHub release for the tag, creating the release if it does not exist.

```bash
npm version 0.6.0 --no-git-tag-version   # bump, commit, then:
git tag -a v0.6.0 -m "v0.6.0" && git push origin main --follow-tags
```

## macOS signing and notarization

Unsigned builds are refused by Gatekeeper on first launch. Signing and
notarization are handled by electron-builder (`hardenedRuntime`, the
entitlements in `build/entitlements.mac.plist`, and `notarize: true` in
`package.json`) and need these repository secrets:

| Secret | What it is |
|---|---|
| `MAC_CERT_P12_BASE64` | A **Developer ID Application** certificate with its private key, exported from Keychain Access as a `.p12`, then `base64 -i cert.p12 \| pbcopy`. |
| `MAC_CERT_PASSWORD` | The password chosen when exporting the `.p12`. |
| `APPLE_API_KEY_P8` | Contents of an App Store Connect API key (`AuthKey_XXXX.p8`) with the *Developer* role. |
| `APPLE_API_KEY_ID` | The key's ID (the `XXXX` in the file name). |
| `APPLE_API_ISSUER` | The issuer ID shown on the App Store Connect *Keys* page. |

An Apple ID with an app-specific password works instead of the API key:
set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The API
key is preferred because it does not depend on a personal account.

Getting the certificate, once, in an Apple Developer Program account
(Portside Labs LLC, US$99 a year):

1. Keychain Access → Certificate Assistant → *Request a Certificate From a
   Certificate Authority*, saved to disk.
2. developer.apple.com → Certificates → **+** → *Developer ID Application*,
   upload the request, download the `.cer` and double-click it.
3. In Keychain Access select the certificate together with its private key,
   *Export 2 items…* as `.p12` with a password. That file, base64 encoded, is
   `MAC_CERT_P12_BASE64`.

To sign locally, import the `.p12` into the login keychain (double-click it)
and run `npm run dist`; electron-builder finds the identity itself. Set the
`APPLE_*` variables in the shell to notarize locally. Without a certificate
in the keychain the build still succeeds and simply skips signing.

Check a finished build with:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Sagittarion.app"
spctl --assess --type execute --verbose=2 "release/mac-arm64/Sagittarion.app"
```

Windows and Linux builds are not signed.
