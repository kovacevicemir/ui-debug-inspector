/**
 * The dashed highlight box + label shown while Ctrl+hovering.
 * Pure DOM, lives outside any framework root.
 */
export class HighlightOverlay {
  private box?: HTMLDivElement;
  private badge?: HTMLDivElement;
  private target: Element | null = null;

  show(element: Element, label: string): void {
    if (!this.box) {
      this.box = document.createElement('div');
      this.box.setAttribute('data-ui-debug-panel', '');
      this.box.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:1px dashed #22d3ee',
        'background:rgba(34,211,238,0.12)',
        'border-radius:3px',
        'transition:all 40ms linear',
        'display:none',
      ].join(';');
      this.badge = document.createElement('div');
      this.badge.setAttribute('data-ui-debug-badge', '');
      this.badge.style.cssText = [
        'position:absolute',
        'left:0',
        'top:-22px',
        'max-width:520px',
        'white-space:nowrap',
        'overflow:hidden',
        'text-overflow:ellipsis',
        'font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:#0b1220',
        'background:#22d3ee',
        'padding:0 6px',
        'border-radius:3px',
      ].join(';');
      this.box.appendChild(this.badge);
      document.body.appendChild(this.box);
    }
    if (this.badge) this.badge.textContent = label;
    this.target = element;
    this.box.style.display = 'block';
    this.reposition();
  }

  reposition(): void {
    if (!this.box || this.box.style.display === 'none') return;
    const element = this.target;
    if (!element || !element.isConnected) {
      this.hide();
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(this.box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  hide(): void {
    if (this.box) this.box.style.display = 'none';
    this.target = null;
  }

  destroy(): void {
    this.box?.remove();
    this.box = undefined;
    this.badge = undefined;
    this.target = null;
  }
}
