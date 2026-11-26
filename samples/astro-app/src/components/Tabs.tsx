import * as Tabs from '@radix-ui/react-tabs';
import { DemoDialog } from './Dialog';

export type DemoTabsProps = {
  tabs: {
    id: string;
    label: string;
    content: string;
    dialog?: { title: string; description: string };
  }[];
};

// /products imports DemoDialog directly. /docs
// imports DemoTabs which transitively imports DemoDialog. so the
// Dialog subgraph is reachable from both page chunks via different
// edges — the bundler should hoist Dialog (and React + Radix it pulls
// in) into a shared chunk rather than duplicating it per page.
export function DemoTabs({ tabs }: DemoTabsProps) {
  return (
    <Tabs.Root defaultValue={tabs[0]?.id}>
      <Tabs.List>
        {tabs.map((t) => (
          <Tabs.Trigger key={t.id} value={t.id}>
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.id} value={t.id}>
          {t.content}
          {t.dialog && <DemoDialog title={t.dialog.title} description={t.dialog.description} />}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
