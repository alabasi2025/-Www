import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-legacy-form-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-form-grid.component.html',
  styleUrl: './legacy-form-grid.component.scss',
})
export class LegacyFormGridComponent {
  readonly columns = input<number>(2);
}
