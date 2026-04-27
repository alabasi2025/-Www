import { APP_INITIALIZER, ApplicationConfig, inject, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideSignalFormsConfig } from '@angular/forms/signals';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideClientHydration, withIncrementalHydration } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { routes } from './app.routes';
import { AuthService } from './services/auth.service';

function initAuth(): () => Promise<void> {
  const auth = inject(AuthService);
  const platformId = inject(PLATFORM_ID);
  return () => isPlatformBrowser(platformId) ? auth.init() : Promise.resolve();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    ...provideSignalFormsConfig({}),
    provideRouter(routes, withComponentInputBinding()),
    provideClientHydration(withIncrementalHydration()),
    provideHttpClient(withFetch()),
    { provide: APP_INITIALIZER, useFactory: initAuth, multi: true },
    provideAnimationsAsync(),
    providePrimeNG({
      theme: { preset: Aura, options: { darkModeSelector: '.dark', cssLayer: { name: 'primeng', order: 'tailwind-base, primeng, tailwind-utilities' } } },
      ripple: true,
    }),
  ],
};
