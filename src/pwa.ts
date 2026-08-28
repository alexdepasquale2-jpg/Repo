import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the service worker and surfaces updates as a prompt rather than
 * applying them silently: swapping assets under a running round would drop the
 * player's in-progress guesses.
 */
export function setupPWA(toast: HTMLElement, reloadButton: HTMLElement): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      toast.hidden = false;
    },
    onRegisterError(err) {
      // Not fatal — the game runs fine unregistered, it just will not work offline.
      console.warn('[pwa] service worker registration failed', err);
    },
  });

  reloadButton.addEventListener('click', () => {
    toast.hidden = true;
    void updateSW(true);
  });
}
