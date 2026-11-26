import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

export type DemoDialogProps = {
  title: string;
  description: string;
};

// self-contained: provider + consumer in the same React tree. same React + radix
// graph is also imported by Tabs.tsx, so on the server side both pages
// must end up sharing one React instance — otherwise Radix's internal
// useContext returns nothing and the components throw.
export function DemoDialog({ title, description }: DemoDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>Open dialog</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close>Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
