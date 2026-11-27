/**
 * The first-run guide's two actions.
 *
 * The guide is window-level state with one persisted fact (`onboardingDoneAt`).
 * Everything it actually *does* — writing the config file, opening a session,
 * sending the first message — goes through the paths the rest of the window
 * already uses, so there is no second way to do any of those things.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { persistPrefs } from '../prefs';

export function onboardingSlice(ctx: StoreContext): Pick<AppStore, 'setOnboardingStep' | 'finishOnboarding'> {
  const { set, get } = ctx;
  return {
    setOnboardingStep(step) {
      set({ onboarding: step });
    },

    finishOnboarding() {
      set({ onboarding: null, onboardingDoneAt: Date.now() });
      persistPrefs(get());
    },
  };
}
