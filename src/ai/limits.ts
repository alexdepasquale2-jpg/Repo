/**
 * Device and network limits the pipeline layer has to live inside.
 *
 * A phone will happily let you allocate your way into an out-of-memory kill,
 * and will happily spend 145 MB of someone's data plan without asking. Both
 * are decisions the game should make deliberately.
 */

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
  type?: string;
}

const connection = (): NetworkInformation | undefined =>
  (navigator as Navigator & { connection?: NetworkInformation }).connection;

/** Reported RAM in GB, where the browser will say. Chrome caps this at 8. */
export const deviceMemoryGB = (): number | null =>
  (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;

/**
 * How much model weight we allow resident at once.
 *
 * Sized well under actual RAM: the browser, the page and ORT's own ~21 MB
 * runtime all want their share, and a tab that is merely large gets killed
 * silently in the background on Android.
 */
export function memoryBudgetMB(): number {
  const gb = deviceMemoryGB();
  if (gb === null) return 200; // unknown: assume mid-range
  if (gb <= 1) return 40;
  if (gb <= 2) return 90;
  if (gb <= 4) return 200;
  return 400;
}

export interface NetworkState {
  /** User has explicitly asked for reduced data use. */
  saveData: boolean;
  /** '4g', '3g', '2g', 'slow-2g', or null when unknown. */
  effectiveType: string | null;
  /** Offline right now. */
  offline: boolean;
  /**
   * Worth confirming before a large download: either Save-Data is on, or the
   * connection is slow enough that a 145 MB pull is a bad surprise.
   */
  costly: boolean;
}

export function networkState(): NetworkState {
  const c = connection();
  const saveData = c?.saveData === true;
  const effectiveType = c?.effectiveType ?? null;
  const slow = effectiveType !== null && effectiveType !== '4g';

  return {
    saveData,
    effectiveType,
    offline: navigator.onLine === false,
    costly: saveData || slow,
  };
}

/** Size threshold above which a download gets an explicit confirmation. */
export const LARGE_DOWNLOAD_MB = 50;
