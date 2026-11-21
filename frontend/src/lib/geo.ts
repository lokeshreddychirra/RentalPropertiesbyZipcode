/** The browser's current location, with plain-language errors. */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export class LocationError extends Error {
  constructor(
    message: string,
    readonly denied = false,
  ) {
    super(message);
  }
}

export function canLocate(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/** Asks the browser for the user's location (the browser shows its permission prompt the first time). */
export function currentPosition(timeoutMs = 10_000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!canLocate()) {
      reject(new LocationError("This browser cannot share your location. Type a ZIP code or city instead."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new LocationError("Location access is turned off for this site. Allow it in your browser, or type a ZIP code or city.", true));
        } else {
          reject(new LocationError("Your location could not be found right now. Type a ZIP code or city instead."));
        }
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 10 * 60_000 },
    );
  });
}

/** Whether the user has already allowed location access (so asking will not show a prompt). */
export async function locationAllowed(): Promise<boolean | null> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    if (!status) return null;
    return status.state === "granted" ? true : status.state === "denied" ? false : null;
  } catch {
    return null;
  }
}
