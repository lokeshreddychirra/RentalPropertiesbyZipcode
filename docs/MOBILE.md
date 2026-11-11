# Mobile: web, installable app, iOS and Android

PropertyYield runs from one codebase on four surfaces:

| Surface | What it is | Where the code lives |
| --- | --- | --- |
| Web | The Next.js site | `frontend/` |
| Mobile web | The same site on a phone: bottom tab bar, safe areas for notches | `frontend/` |
| Installed web app (PWA) | "Add to Home Screen" or "Install app": full screen with its own icon and an offline page | `frontend/src/app/manifest.ts`, `frontend/public/sw.js` |
| iOS and Android apps | Native Capacitor apps for the App Store and Google Play | `mobile/` |

## How the native apps work

The iOS and Android apps are [Capacitor](https://capacitorjs.com) shells. They load the live site
(`https://propertyyield.onrender.com` by default) inside a native web view. That means:

- **Every web deploy reaches the apps right away.** You only rebuild and resubmit the apps when native settings change: the icon, splash screen, plugins or app ID.
- **Sign-in just works.** The page comes from the same domain as the API, so the session cookie stays first party.
- **Native touches.** The apps add a splash screen, a status bar that matches the light or dark theme, the Android back button (it closes an open drawer first, then goes back), and a native offline screen when the server can't be reached.

`frontend/src/components/layout/app-runtime.tsx` adds the native touches. The native shell injects
`window.Capacitor`, so the web bundle doesn't need any Capacitor packages.

## Install on a phone without the stores (PWA)

- **iPhone or iPad (Safari):** open the site, tap **Share**, then tap **Add to Home Screen**.
- **Android (Chrome):** open the site, open the **⋮** menu, then tap **Install app** (or **Add to Home screen**).

## Get the app builds

The **Mobile apps** GitHub Actions workflow (`.github/workflows/mobile.yml`) runs whenever `mobile/`
changes. You can also start it by hand: open **Actions**, choose **Mobile apps**, then click **Run workflow**.
Each run uploads:

- `propertyyield-android-debug-apk`: an APK you can install on any Android phone. Download it, open it on the phone and allow "install unknown apps".
- `propertyyield-ios-simulator-app`: a build for the iOS Simulator. To put the app on a real iPhone, you have to sign it in Xcode (see below).
- `propertyyield-android-release-aab`: a signed bundle for Google Play. You only get this one once you've added the signing secrets.

## Work on the apps locally

You need Node 22. For Android, you also need Android Studio (it includes the SDK and JDK 21). For iOS, you need a Mac with Xcode.

```bash
cd mobile
npm install
npx cap sync          # copies config and plugins into android/ and ios/
npx cap open android  # opens Android Studio; press Run
npx cap open ios      # opens Xcode; pick a simulator or your phone and press Run
```

To point the apps at another deployment (staging or a local server on your network), set `APP_URL` when you sync:

```bash
APP_URL=https://staging.example.com npx cap sync
```

To change the icon or splash screen, edit the SVGs in `mobile/assets/`, export them to the PNGs beside them, then run:

```bash
npx @capacitor/assets generate --iconBackgroundColor '#6366f1' --splashBackgroundColor '#0b0e17'
```

## Publish to Google Play

1. Create a Google Play developer account (one-time $25 fee).
2. Create an upload key, and keep it safe. If you lose it, you have to go through a key reset with Google.
   ```bash
   keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   base64 -w0 upload.jks   # paste this output into the ANDROID_KEYSTORE_BASE64 secret
   ```
3. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add these four secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
4. Run the **Mobile apps** workflow, then download `propertyyield-android-release-aab`.
5. In Play Console, create the app, upload the `.aab` to the **Internal testing** track, and fill in the store listing, the Data safety form and a privacy policy URL.
6. Before each new upload, raise `versionCode` (and `versionName`) in `mobile/android/app/build.gradle`.

## Publish to the Apple App Store

1. Join the Apple Developer Program ($99 a year). You need a Mac with Xcode.
2. Run `cd mobile && npm install && npx cap sync ios && npx cap open ios`.
3. In Xcode, select the **App** target and open **Signing & Capabilities**. Choose your Team, and keep or change the bundle ID `com.propertyyield.app`.
4. Choose **Product → Archive**, then click **Distribute App** and choose **App Store Connect**. Test the build with TestFlight first, then submit it for review.
5. Before each new upload, raise the **Version** and **Build** numbers on the target's **General** tab.

### App Review checklist

Apple and Google both check these, so it's worth dealing with them before you submit:

- **Account deletion:** both stores require apps that let people create an account to also let them delete it from inside the app.
- **Paid plans:** Apple doesn't allow digital subscriptions sold through Stripe inside an iOS app. The exception is the US storefront, which may link out to an external purchase page. The safe options are to hide the upgrade buttons in the iOS app, or to add Apple in-app purchase.
- **More than a website:** Apple's guideline 4.2 rejects apps that only wrap a website. The tab bar, offline screen and native theming help. Push notifications for saved-search alerts would make the case stronger.
- **Privacy:** you need a privacy policy URL, plus the App Privacy answers in App Store Connect (Apple) and the Data safety form in Play Console (Google).

## Change the app ID

The app ID is `com.propertyyield.app`. It's permanent once the app is published in a store, so if you want a different one (for example, your own domain reversed), change it before the first upload:

- `appId` in `mobile/capacitor.config.ts`
- `applicationId` and `namespace` in `mobile/android/app/build.gradle`
- The package folder under `mobile/android/app/src/main/java/`
- The bundle identifier in Xcode
