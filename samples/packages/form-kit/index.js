import { createElement } from 'react';
import { FormProvider, useForm } from 'react-hook-form';

// the provider half of a form: consumers call `useFormContext()` from their own
// `react-hook-form` import, so both sides must resolve to one copy of it.
export function Form({ defaultValues, children }) {
  const form = useForm({ defaultValues });

  return createElement(FormProvider, form, children);
}

// a specifier bonsai cannot analyze statically, which keeps this package external
export const loadFieldPlugin = (name) => import(name);
