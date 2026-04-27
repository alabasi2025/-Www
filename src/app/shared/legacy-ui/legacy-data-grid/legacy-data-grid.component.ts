import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-legacy-data-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-data-grid.component.html',
  styleUrl: './legacy-data-grid.component.scss',
})
export class LegacyDataGridComponent {}
