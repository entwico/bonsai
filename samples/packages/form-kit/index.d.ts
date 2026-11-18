import type { ReactNode } from 'react';

export function Form(props: { defaultValues: Record<string, unknown>; children: ReactNode }): ReactNode;
export function loadFieldPlugin(name: string): Promise<unknown>;
