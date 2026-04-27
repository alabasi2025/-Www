import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import {
  LEGACY_SYSTEM_LABELS,
  LEGACY_SYSTEM_SUMMARIES,
  type LegacySystemSummary,
} from '../../shared/legacy-ui/registry/legacy-system.registry';

interface ScreenNode {
  noa: number;
  typea: number;
  namea: string;
  namee: string;
  namef: string;
  rtba: number;
  level: number;
  launchable: boolean;
  children: ScreenNode[];
}

interface VisibleNode {
  node: ScreenNode;
  depth: number;
  hasChildren: boolean;
}

const LEGACY_WINDOW_SCREEN_CODES = new Set<string>([
  // All screens now open fullscreen (no MDI sidebar mode)
]);

interface ApiSystemSummary {
  tsys: number;
  totalRows: number;
  screenRows: number;
}

@Component({
  selector: 'app-main',
  imports: [CommonModule, FormsModule, RouterOutlet],
  templateUrl: './main.component.html',
  styleUrl: './main.component.scss',
})
export class MainComponent implements OnInit {
  auth = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);

  readonly tsys = signal(1);
  readonly search = signal('');
  readonly loading = signal(false);
  readonly roots = signal<ScreenNode[]>([]);
  readonly expanded = signal<Set<number>>(new Set());
  readonly currentUrl = signal('');
  readonly systems = signal<LegacySystemSummary[]>(LEGACY_SYSTEM_SUMMARIES);
  readonly menuTotal = signal(0);
  readonly menuScreens = signal(0);

  readonly today = new Date();

  readonly toolbarIcons = [
    'pi-search',
    'pi-key',
    'pi-wrench',
    'pi-cog',
    'pi-sync',
    'pi-print',
    'pi-file-export',
  ];

  readonly visibleNodes = computed<VisibleNode[]>(() => {
    const q = this.normalize(this.search());
    const out: VisibleNode[] = [];
    if (!q) {
      this.flattenByExpansion(this.roots(), 0, out);
      return out;
    }
    this.flattenBySearch(this.roots(), 0, q, out);
    return out;
  });

  ngOnInit(): void {
    this.currentUrl.set(this.router.url);
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        this.currentUrl.set(e.urlAfterRedirects);
        this.resetLegacyMdiScroll(e.urlAfterRedirects);
      }
    });
    void this.loadSystems();
    void this.loadScreens(1);
  }

  private normalize(value: string): string {
    return (value || '').trim().toLowerCase();
  }

  private flattenByExpansion(nodes: ScreenNode[], depth: number, out: VisibleNode[]): void {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      out.push({ node, depth, hasChildren });
      if (hasChildren && this.expanded().has(node.noa)) {
        this.flattenByExpansion(node.children, depth + 1, out);
      }
    }
  }

  private flattenBySearch(nodes: ScreenNode[], depth: number, q: string, out: VisibleNode[]): boolean {
    let matchedAny = false;
    for (const node of nodes) {
      const selfMatch = this.normalize(node.namea).includes(q) || this.normalize(node.namee).includes(q);
      const beforeChildrenLen = out.length;
      const childMatch = this.flattenBySearch(node.children, depth + 1, q, out);
      const hasChildren = node.children.length > 0;

      if (selfMatch || childMatch) {
        out.splice(beforeChildrenLen, 0, { node, depth, hasChildren });
        matchedAny = true;
      } else {
        out.splice(beforeChildrenLen, out.length - beforeChildrenLen);
      }
    }
    return matchedAny;
  }

  async loadScreens(tsys: number): Promise<void> {
    this.tsys.set(tsys);
    this.loading.set(true);
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; tree?: ScreenNode[]; total?: number; rows?: ScreenNode[] }>(`/api/screens?tsys=${tsys}`),
      );
      const tree = r.ok ? (r.tree ?? []) : [];
      this.roots.set(tree);
      const rows = r.rows ?? [];
      this.menuTotal.set(Number(r.total ?? rows.length ?? 0));
      this.menuScreens.set(rows.filter((row) => !!row.namee || !!row.namef).length);
      // Match Oracle TRMENU first-load behavior: show only top-level folders collapsed.
      this.expanded.set(new Set<number>());
    } catch {
      this.roots.set([]);
      this.menuTotal.set(0);
      this.menuScreens.set(0);
    }
    this.loading.set(false);
  }

  async loadSystems(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; systems?: ApiSystemSummary[] }>('/api/systems'),
      );
      if (!r.ok || !r.systems?.length) return;
      this.systems.set(r.systems
        .filter((system) => system.tsys > 0)
        .map((system) => ({
          tsys: system.tsys,
          label: LEGACY_SYSTEM_LABELS[system.tsys] ?? `النظام الفرعي رقم ${system.tsys}`,
          totalRows: Number(system.totalRows ?? 0),
          screenRows: Number(system.screenRows ?? 0),
        })));
    } catch {
      this.systems.set(LEGACY_SYSTEM_SUMMARIES);
    }
  }

  currentSystem(): LegacySystemSummary {
    return this.systems().find((system) => system.tsys === this.tsys())
      ?? LEGACY_SYSTEM_SUMMARIES[0]!;
  }

  hasChildren(node: ScreenNode): boolean {
    return node.children.length > 0;
  }

  isExpanded(node: ScreenNode): boolean {
    return this.expanded().has(node.noa);
  }

  toggleNode(node: ScreenNode): void {
    if (!this.hasChildren(node)) return;
    const s = new Set(this.expanded());
    if (s.has(node.noa)) s.delete(node.noa);
    else s.add(node.noa);
    this.expanded.set(s);
  }

  onNodeClick(node: ScreenNode): void {
    const target = (node.namee || '').trim().toUpperCase();
    if (target && target !== 'TRMENU') {
      void this.router.navigate(['/app/screens', target]);
      return;
    }
    if (this.hasChildren(node)) {
      this.toggleNode(node);
    }
  }

  isScreenView(): boolean {
    return this.router.url.toLowerCase().includes('/app/screens/');
  }

  isLegacyMdiScreen(): boolean {
    const code = this.currentScreenCode();
    return !!code && LEGACY_WINDOW_SCREEN_CODES.has(code);
  }

  private resetLegacyMdiScroll(url: string): void {
    if (!this.currentScreenCode(url)) return;
    if (typeof window === 'undefined') return;
    const resetScroll = () => {
      window.scrollTo({ left: 0, top: 0 });
      document.documentElement.scrollTo({ left: 0, top: 0 });
      document.body.scrollTo({ left: 0, top: 0 });
      document.scrollingElement?.scrollTo({ left: 0, top: 0 });
      document.querySelector<HTMLElement>('.workspace.legacy-mdi-mode')?.scrollTo({ left: 0, top: 0 });
    };
    [0, 80, 240, 500, 900, 1400, 2000].forEach((delay) => {
      window.setTimeout(resetScroll, delay);
    });
  }

  private currentScreenCode(url = this.router.url): string | null {
    const match = url.toUpperCase().match(/\/APP\/SCREENS\/([^/?#]+)/);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]).trim();
  }

  isActive(node: ScreenNode): boolean {
    return !!node.namee && this.currentUrl().toUpperCase().includes(`/SCREENS/${node.namee.toUpperCase()}`);
  }

  getNodeIcon(node: ScreenNode, hasChildren: boolean): string {
    if (hasChildren) return this.isExpanded(node) ? 'pi pi-folder-open' : 'pi pi-folder';
    if (node.launchable) return 'pi pi-file';
    return 'pi pi-circle';
  }

  get todayDate(): string {
    const y = this.today.getFullYear();
    const m = String(this.today.getMonth() + 1).padStart(2, '0');
    const d = String(this.today.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }

  get dayNameAr(): string {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    return days[this.today.getDay()] || '';
  }

  get currentYear(): string {
    const y = this.auth.user()?.year;
    if (y && /^\d{4}$/.test(String(y))) return String(y);
    return String(this.today.getFullYear());
  }

  get userName(): string {
    return this.auth.user()?.name || 'مسؤول نظام';
  }

  get machineName(): string {
    return this.auth.user()?.machine || 'WEB-CLIENT';
  }

  get companyName(): string {
    const schema = (this.auth.user()?.schema || '').toUpperCase();
    const unit = (this.auth.user()?.unit || '').toUpperCase();
    if (schema.includes('DATAALA') || unit === 'A') return 'محطة معبر';
    return this.auth.user()?.schema || 'شركة';
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
