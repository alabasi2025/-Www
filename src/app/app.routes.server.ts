import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  { path: 'app/screens/:namee', renderMode: RenderMode.Server },
  { path: 'app',                renderMode: RenderMode.Server },
  { path: '**',                 renderMode: RenderMode.Prerender },
];
