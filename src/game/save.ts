import { SAVE_VERSION, initialState, type SaveState } from './state';

const KEY = 'latent-depths/save';

/**
 * Persistence is best-effort by design: private browsing and storage pressure
 * both make localStorage throw, and a save failure should never interrupt a
 * run in progress.
 */
export function load(): SaveState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return initialState();

    const parsed = JSON.parse(raw) as Partial<SaveState>;
    if (parsed.version !== SAVE_VERSION) {
      console.warn(`[save] discarding v${parsed.version} save (expected v${SAVE_VERSION})`);
      return initialState();
    }

    // Spread over defaults so a save written by an older build that lacked a
    // field still loads rather than producing undefined deep in the sim.
    return { ...initialState(), ...parsed, version: SAVE_VERSION };
  } catch (err) {
    console.warn('[save] could not read save', err);
    return initialState();
  }
}

export function save(state: SaveState): void {
  try {
    state.lastSeen = Date.now();
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[save] could not write save', err);
  }
}

export function wipe(): void {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn('[save] could not clear save', err);
  }
}
