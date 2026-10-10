'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

function Overlay() {
  return (
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay data-[state=open]:animate-fade-in" />
  );
}

interface DialogContentProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Centered dialog, 12 px radius (spec section 8). */
export function DialogContent({ title, description, children, footer, className }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-dialog border border-line bg-surface p-5 shadow-2xl data-[state=open]:animate-fade-in',
          className,
        )}
      >
        <DialogPrimitive.Title className="text-title font-semibold">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1.5 text-body text-muted">
            {description}
          </DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
        {children ? <div className="mt-4">{children}</div> : null}
        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

interface SheetContentProps {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}

/** Right-hand drawer, 420 px (spec section 8). */
export function SheetContent({ title, children, footer }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,100vw)] flex-col border-l border-line bg-surface shadow-2xl data-[state=open]:animate-fade-in"
        aria-describedby={undefined}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <DialogPrimitive.Title className="text-title font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
