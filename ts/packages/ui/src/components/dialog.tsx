'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';
import { buttonVariants } from './button';

type ButtonStyleProps = VariantProps<typeof buttonVariants>;

/** 開閉の状態を持つ根。`open` / `onOpenChange` で外から制御できる。 */
function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** 開く操作。見た目は Button と同じ variant / size を受ける。 */
function DialogTrigger({
  className,
  variant = "default",
  size = "default",
  ...props
}: DialogPrimitive.Trigger.Props & ButtonStyleProps) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/** Dialog の描画先。Portal により親の overflow や stacking context に切られない。 */
function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/** modal の背面。印刷物には含めない。 */
function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        'fixed inset-0 z-50 bg-foreground/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 print:hidden',
        className,
      )}
      {...props}
    />
  );
}

/** 右側 Drawer の面。位置・寸法・印刷時の扱いは呼び出し側が指定する。 */
function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed inset-y-0 right-0 z-50 h-[100dvh] w-[min(100vw,34rem)] overflow-x-hidden overflow-y-auto bg-background p-6 text-sm text-foreground shadow-raised transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full print:static print:h-auto print:w-auto print:translate-x-0 print:overflow-visible print:bg-transparent print:p-0 print:shadow-none',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

/** 閉じる操作。Trigger への focus restore は Base UI に委譲する。 */
function DialogClose({
  className,
  variant = "outline",
  size = "default",
  ...props
}: DialogPrimitive.Close.Props & ButtonStyleProps) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/** dialog のアクセシブル名。 */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-base leading-snug font-semibold text-pretty', className)}
      {...props}
    />
  );
}

/** dialog の説明（必要なら呼び出し側から aria-describedby で参照する）。 */
function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground text-pretty', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
